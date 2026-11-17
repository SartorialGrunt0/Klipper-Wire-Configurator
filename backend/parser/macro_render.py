"""W2 render simulator: render a macro body the way Klipper would on an
invocation, then validate the RENDERED commands (feature
macro-jinja-reliability; W4R pivot 2026-11-14: scenario-driven).

The honest definition of "simulate":

  * Jinja that COMPILES can still EXPAND to garbage — the field repro is a
    toggle macro whose ``SET_LED ... RED={params.red}`` renders
    ``RED=`` (empty) and Klipper answers "unable to parse" at runtime.
    Compile-time checks (validator + validate_macro) can never see this.
  * So we render, deterministically, on KNOWN SHAPE ONLY: ``printer`` is
    an UNKNOWN sentinel (any access yields UNKNOWN; stringifies as
    ``<unknown>``, floats as NaN — never a guessed value); a scenario's
    ``printer_state`` overlays dotted paths so declared values render as
    REAL values and everything else keeps widening (4R.3). ``params`` is
    a PLAIN dict — Klipper's exact shape — layered over the section's
    ``params_*`` defaults / scenario params.
  * Klipper-parity UNDEFINED (W4R, measured against the bundled source):
    gcode_macro.py:83 builds a plain ``jinja2.Environment`` — the DEFAULT
    Undefined class: bare ``{params.X}`` renders ``''`` (the registry
    shape check then flags the empty field — Klipper's real failure
    mode), while ``|float``/``|int``/arithmetic on an unset name ABORT
    (``macro_param_undefined``) exactly as real Klipper does. The old
    StrictUndefined overlay was an invented "KlipperUndefined" parity
    (no such class exists) whose dev-server audit 2026-11-14 false-
    flagged valid real-world macros. jinja's own message over the plain
    dict reads ``'dict object' has no attribute 'X'`` — Klipper's string.
  * Template context mirrors gcode_macro.py: ``cmd()`` seeds
    ``dict(self.variables)`` (the macro's own ``variable_*``, literal-
    evaluated at config load), then ``create_template_context()``
    (:106-112) contributes ``printer`` plus the four action functions
    (rendered as returning ``''`` — runtime side effects are not
    simulated), then command-line ``params``/``rawparams``. There is NO
    ``caller_data`` (display templates only): a template referencing it
    follows plain-Undefined semantics (false conditions, empty renders).
  * PARAM-PRESENCE CONDITIONS ARE DETERMINISTIC (4R.1):
    ``params.X is defined`` (dot/bracket, is/is-not) and
    ``'X' in params`` (incl. the ``|upper`` idiom) resolve statically
    against the simulated invocation's declared params — the arms they
    gate are exactly the arms Klipper runs; no arm expansion, no phantom
    renders (the audit's FP class). Coverage of a defined-arm is a
    SCENARIO (caller declares the param), not a forced-true arm.
  * Unknown-dependent ``{% if %}``/``{% elif %}`` conditions (undeclared
    printer paths, params keys with no declared value, the bare params
    object) render BOTH arms, capped at ``MAX_RENDER_VARIANTS``; over-cap
    paths surface as ``macro_render_unexplored`` info — never dropped.
  * Rendered lines are checked against the gcode registry (schema v2):
    required params present AND non-empty (``macro_param_renders_empty``),
    typed params parseable (``macro_param_unparseable``), UNKNOWN/NaN
    values = ``macro_unknown_value`` info (never an error — we never
    claim to know runtime values), plus the G1-extrusion-without-feedrate
    advisory applied POST-render under its OWN code
    (``macro_rendered_g1_no_feedrate``) so sim origin stays filterable
    from the static scan's ``g1_extrude_no_feedrate``.
  * Other macros are recognized via the caller-supplied project set and
    never recursed (v1 limit). ``SET_GCODE_VARIABLE`` targets are tracked
    as (MACRO, VARIABLE) string pairs, not simulated state.

Consumption contract (4R.2, plan 2026-11-14): human-facing validation
never shows ``SIM_FINDING_CODES`` findings; the AI write-path delta gate
honors them ONLY at error severity; full findings exist only as tool
output (validate_macro facade / simulate_macro scenarios) with the
scenario's declared assumptions attached.

The engine shares Klipper's jinja environment with the save gate
(``validator._MACRO_JINJA_ENV`` — imported lazily inside the entry point
so validator can import this module top-level for the validation pass
without a circular import) and the same comment stripping
(``_strip_inline_comments``).

Finding severities: errors ONLY on every-simulated-path deterministic
breakage of the rendered shape (empty required/typed param, unparseable
typed value); unknown-state dependencies and simulation blind spots are
info; a render that dies on Klipper's Undefined (unset param used where
real Klipper aborts) is a warning — a scenario that passes the param
shows whether the invocation is legal.
"""
from __future__ import annotations

import ast
import json
import logging
import re
import shlex
from dataclasses import dataclass, field, replace
from functools import lru_cache

import jinja2
from jinja2 import UndefinedError

logger = logging.getLogger(__name__)

# Cap on total branch renderings per macro (plan 2.1). Exotic branch
# counts degrade to macro_render_unexplored info instead of blowing up.
MAX_RENDER_VARIANTS = 16

# Markers identifying a rendered value as unknown-state (never a real
# coordinate): the UNKNOWN sentinel's string form and the NaN/inf it
# floats to (which propagate through arithmetic and |round without
# fabricating a value).
_UNKNOWN_MARKERS = ("<unknown>",)

# inf/nan are STANDALONE sentinel values (float(UNKNOWN) is NaN and
# arithmetic propagates it). They used to be matched as SUBSTRINGS, so a
# rendered literal like `TYPE=info` was read as an unknown value and
# downgraded from a defect to an info note (D7, found by the r12 retest:
# RESPOND TYPE=info is a run-time error but the sim called it unknown
# state). Match the sentinel spelling, never the word.
_UNKNOWN_NUMERIC_RE = re.compile(r"^[+-]?(?:inf(?:inity)?|nan)$", re.IGNORECASE)

# Every finding code this engine emits (single source for the 4R.2
# consumption split via is_sim_advisory below). The post-render G1
# advisory deliberately does NOT reuse the static scan's
# g1_extrude_no_feedrate — sim origin must stay filterable.
SIM_FINDING_CODES = frozenset({
    "macro_param_undefined",
    "macro_param_renders_empty",
    "macro_param_unparseable",
    "macro_unknown_value",
    "macro_render_blocked",
    "macro_render_unexplored",
    "macro_rendered_g1_no_feedrate",
    "macro_jinja_syntax",
    "macro_mux_target_unknown",
    "macro_param_enum_invalid",
    # PR #43 warning: the engine emits these too — missing from the set,
    # a future warning/info arm would leak past the human boundary as an
    # ordinary advisory channel member. Both are error-severity today,
    # so this is zero-behavior hardening (consumption-split completeness).
    "macro_param_missing_choice",
    "macro_param_out_of_bounds",
})


def is_sim_advisory(code: str, severity: str) -> bool:
    """Boundary predicate for the 2026-11-14 pivot (decisions D1/D2):
    simulation-origin findings at warning/info severity exist ONLY as
    results of an explicit simulation (validate_macro / simulate_macro
    tool surfaces). They never reach human-facing validation responses
    (/import, /parse, /validate, /validate-project → save gate UI) and
    never reach the model as delta-gate advisories. Sim ERRORS pass
    everywhere — a broken rendered command shape is a true defect of
    the text at hand, not a hypothetical-invocation story."""
    return code in SIM_FINDING_CODES and severity != "error"


@dataclass(frozen=True)
class RenderedLine:
    text: str                # the rendered command line (stripped)
    source_line: int | None  # 1-indexed line within the macro body (best effort)
    variant: int             # 0-based simulation path index


@dataclass(frozen=True)
class RenderFinding:
    severity: str            # 'error' | 'warning' | 'info'
    code: str
    message: str
    source_line: int | None = None
    variant: int | None = None


_RENDER_LINE_CAP = 5000  # bounded work: stop verifying past this many lines


@dataclass(frozen=True)
class MacroRenderResult:
    rendered: list[RenderedLine] = field(default_factory=list)
    findings: list[RenderFinding] = field(default_factory=list)
    unknown_accesses: list[str] = field(default_factory=list)
    set_variables: list[tuple[str, str]] = field(default_factory=list)
    variants_rendered: int = 0


class _RenderBlocked(Exception):
    """Control flow the simulator does not model (iterating or
    truth-testing unknown state outside a forced branch). Info."""


class _Unknown:
    """Printer-state sentinel. Accesses widen, never guess: attributes,
    items and calls are UNKNOWN; str() is '<unknown>'; float() is NaN
    (propagates through arithmetic/filters without fabricating a
    coordinate). Truthiness and iteration RAISE — those are control-flow
    decisions the simulation cannot take inside a render (unknown
    conditions are forced at the SOURCE level, both arms, instead)."""

    __slots__ = ()

    def __getattr__(self, name): return self
    def __getitem__(self, key): return self
    def __call__(self, *args, **kwargs): return self
    def __str__(self): return "<unknown>"
    def __repr__(self): return "<unknown>"
    def __iter__(self):
        raise _RenderBlocked("iteration over unknown printer state")
    def __bool__(self):
        raise _RenderBlocked("truth test of unknown printer state")
    def __float__(self): return float("nan")

    def __int__(self):
        # UNKNOWN must stay invisible-but-plausible where the template
        # coerces to int (|int, range()). 0 would make
        # 'range(printer.x|int)' render ZERO times — silently dropping
        # branch coverage the simulation exists to provide; 1 executes
        # the body exactly once. The fabricated digit never gains
        # severity: it is only reachable where real values exist.
        return 1

    def __round__(self, n=None): return self
    def __trunc__(self): return self
    def __abs__(self): return self

    def _widen(self, *args): return self
    __add__ = __radd__ = _widen
    __sub__ = __rsub__ = _widen
    __mul__ = __rmul__ = _widen
    __truediv__ = __rtruediv__ = _widen
    __floordiv__ = __rfloordiv__ = _widen
    __mod__ = __rmod__ = _widen
    __pow__ = __rpow__ = _widen
    __neg__ = _widen
    __pos__ = _widen
    __eq__ = __ne__ = _widen
    __lt__ = __le__ = __gt__ = __ge__ = _widen

    def __hash__(self): return hash("<unknown>")


UNKNOWN = _Unknown()


class _StateNode:
    """Scenario printer-state overlay (4R.3): a declared dotted path
    answers with the REAL value (full jinja semantics — comparisons and
    filters evaluate natively); anything not covered by the scenario
    widens to UNKNOWN, exactly like the default sentinel. A container
    node is a marker, not a modeled status dict: truthy (Klipper: a
    present status object is truthy), stringifies as '<unknown>' (the
    full status repr is not modeled), iteration RAISES (a partial
    iteration of declared-keys-only would render a lie), arithmetic
    widens."""

    __slots__ = ("node",)

    def __init__(self, node: dict):
        self.node = node

    def _child(self, key):
        try:
            value = self.node[key]
        except (KeyError, IndexError, TypeError):
            return UNKNOWN
        if isinstance(value, dict):
            return _StateNode(value)
        return value

    def __getattr__(self, name): return self._child(name)
    def __getitem__(self, key): return self._child(key)
    def __call__(self, *args, **kwargs): return UNKNOWN
    def __str__(self): return "<unknown>"
    def __repr__(self): return "<unknown>"
    def __bool__(self): return True
    def __iter__(self):
        raise _RenderBlocked("iteration over a declared state container")
    def __float__(self): return float("nan")
    def __int__(self): return 1  # coverage parity with _Unknown

    def _widen(self, *args): return UNKNOWN
    __add__ = __radd__ = _widen
    __sub__ = __rsub__ = _widen
    __mul__ = __rmul__ = _widen
    __truediv__ = __rtruediv__ = _widen
    __floordiv__ = __rfloordiv__ = _widen
    __mod__ = __rmod__ = _widen
    __pow__ = __rpow__ = _widen

    def __hash__(self): return hash("<unknown>")


# Status paths Klipper exposes as gcode.Coord (pinned checkout):
#   toolhead.position (toolhead.py:512); gcode_move.position /
#   gcode_position / homing_origin (gcode_move.py:110-112);
#   motion_report.live_position (motion_report.py:261).
_COORD_STATE_PATHS = frozenset({
    "toolhead.position",
    "gcode_move.position",
    "gcode_move.gcode_position",
    "gcode_move.homing_origin",
    "motion_report.live_position",
})


class _Coord(tuple):
    """Mirror of Klipper's gcode.Coord (klippy/gcode.py:12-21): tuple
    subclass; values shorter than 4 pad with 0; x/y/z/e are positional
    properties. Normalizes declared position state so {pos.x} renders
    exactly what real Klipper would render."""
    __slots__ = ()

    def __new__(cls, t):
        t = tuple(t)
        if len(t) < 4:
            t = t + (0,) * (4 - len(t))
        return tuple.__new__(cls, t)

    @property
    def x(self): return self[0]

    @property
    def y(self): return self[1]

    @property
    def z(self): return self[2]

    @property
    def e(self): return self[3]


def _nest_state(printer_state: dict) -> "_StateNode":
    """Fold dotted-path scenario keys into a lookup tree
    ({'toolhead.homed_axes': 'xyz'} → toolhead → homed_axes)."""
    root: dict = {}
    for path, value in printer_state.items():
        parts = [_state_path_key(path)] if "." not in str(path) else [
            p.strip().lower() for p in str(path).split(".") if p.strip()]
        node = root
        for part in parts[:-1]:
            nxt = node.get(part)
            if not isinstance(nxt, dict):
                nxt = {}
                node[part] = nxt
            node = nxt
        if parts:
            if ".".join(parts) in _COORD_STATE_PATHS and \
                    isinstance(value, (list, tuple)) and \
                    not isinstance(value, _Coord):
                # Klipper serves these status paths as gcode.Coord — a
                # tuple subclass with x/y/z/e properties (gcode.py:12-21).
                # A declared Moonraker-shaped list must answer attribute
                # access the same way, or the simulator manufactures a
                # defect for {pos.x} that real Klipper does not have
                # (MACRO-14 r3, 2026-11-15).
                value = _Coord(value)
            node[parts[-1]] = value
    return _StateNode(root)


def _state_path_key(path: object) -> str:
    return ".".join(p.strip().lower() for p in str(path).split(".")
                    if p.strip())


# ── unknown-dependence classification ──────────────────────────────────────

# 'printer' is the ONLY context root that holds state: Klipper's
# gcode_macro context (gcode_macro.py create_template_context + cmd) has
# no caller_data — a template referencing it follows plain-Undefined
# semantics deterministically, exactly like real Klipper (W4R).
_PRINTER_REF_RE = re.compile(
    r"(?<![\w.])printer\b((?:\s*\.\s*[A-Za-z_]\w*)*)(\s*\[)?")
_PARAMS_REF_RE = re.compile(
    r"(?<![\w.])params(?:\s*\.\s*([A-Za-z_]\w*)|\[\s*['\"]([^'\"]+)['\"]\s*\]"
    r"|(?!\s*[.\[]))"
)

# Statically decidable param-presence grammars (whole-condition forms).
# These depend ONLY on which params the simulated invocation declares —
# forcing their TRUE arm without declaring the param is what produced the
# phantom renders the 2026-11-14 audit flagged on valid configs.
_PARAM_IS_DEFINED_RE = re.compile(
    r"^params\s*(?:\.\s*([A-Za-z_]\w*)"
    r"|\[\s*['\"]([A-Za-z_][\w ]*)['\"]\s*\])\s+(is not|is)\s+defined$",
    re.DOTALL)
_PARAMS_MEMBERSHIP_RE = re.compile(
    r"^['\"]([A-Za-z_][\w ]*)['\"]\s+in\s+params(?:\s*\|\s*upper\s*)?$",
    re.DOTALL)
# A read of one named param: params.X / params . X / params['X'] /
# params["X"] (name captured raw; presence decisions lowercase).
_PARAM_READ_RE = re.compile(
    r"params\s*(?:\.\s*([A-Za-z_]\w*)"
    r"|\[\s*['\"]([A-Za-z_][\w ]*)['\"]\s*\])")


def _presence_of(name: str, defined_params: frozenset[str],
                 authoritative: bool) -> bool | None:
    """True/False when Klipper's answer is decidable, None when not.

    ``defined_params`` holds UPPERCASE key names (Klipper's params dict is
    uppercase-keyed and lookups are case-sensitive, review round-2 D2).
    A spelling with any lowercase character can therefore never match any
    invocation — that is decidable even with no invocation declared.
    With an authoritative invocation an absent uppercase name is simply
    absent; without one, any caller may still pass it (None: explore both
    arms, downgrade the value-reading arm to param-dependent info)."""
    if name in defined_params:
        return True
    if name != name.upper():
        return False
    if not authoritative:
        return None
    return False


def _static_param_presence(cond: str,
                           defined_params: frozenset[str],
                           authoritative: bool = True) -> bool | None:
    """Resolve a decidable param-presence condition, or None when the
    condition is not of that shape. `params.X is defined` (dot/bracket,
    is/is-not) and `'X' in params` (with the `|upper` membership idiom)
    answer exactly what Klipper answers for the invocation at hand.

    ``authoritative=False`` (no invocation declared): a name OUTSIDE the
    declared set is not decidable — any caller may pass it — so the
    guard stays unresolved and both arms get explored; the arm reading
    the value is then downgraded to param-dependent info by the caller
    (3.1: absence of an invocation is not evidence of absence).
    Declared names resolve exactly: ``params_*`` defaults ride EVERY
    Klipper invocation."""
    c = cond.strip()
    m = _PARAM_IS_DEFINED_RE.match(c)
    if m:
        # Klipper's params dict is UPPERCASE-keyed and Jinja dict
        # attribute/key lookup is case-SENSITIVE: `params.x` is undefined
        # even when X was passed (review round-2 D2). Compare exactly.
        name = (m.group(1) or m.group(2))
        present = _presence_of(name, defined_params, authoritative)
        if present is None:
            return None
        return present if m.group(3) == "is" else not present
    m = _PARAMS_MEMBERSHIP_RE.match(c)
    if m:
        # `'x' in params` is a case-sensitive key test; the real-world
        # `'x' in params|upper` idiom uppercases the dict's string form,
        # so there a lowercase spelling DOES match an uppercase key.
        name = m.group(1)
        if "|upper" in c.replace(" ", ""):
            name = name.upper()
        present = _presence_of(name, defined_params, authoritative)
        if present is None:
            return None
        return present
    return None


def _cond_is_unknown(cond: str, defined_params: frozenset[str],
                     declared_state: frozenset[str] = frozenset()) -> bool:
    """Whether an if/elif condition depends on state the simulation does
    not know: printer paths not covered by the scenario's printer_state,
    a params key with no declared value, or the bare params object
    (membership/iteration beyond the decidable grammars, which are
    already spliced out by _splice_static_param_guards)."""
    # The membership idiom answered only when the name is declared (or
    # the invocation is authoritative — splicing runs first, so a
    # surviving match here over an UNdeclared name means the caller may
    # still pass it: unknown, both arms. Keeps `'X' in params` and
    # `'X' in params|upper` behaving identically (3.1).
    mm = _PARAMS_MEMBERSHIP_RE.match(cond.strip())
    if mm:
        name = mm.group(1)
        if "|upper" in cond.replace(" ", ""):
            name = name.upper()
        return _presence_of(name, defined_params, False) is None
    for m in _PRINTER_REF_RE.finditer(cond):
        if m.group(2):
            # Bracket access anywhere in the chain: conservative, the
            # key is not statically known.
            return True
        path = re.sub(r"\s*\.\s*", ".", m.group(1) or "").lstrip(".").lower()
        if path == "":
            if not declared_state:
                return True
            continue
        if not any(d == path or d.startswith(path + ".")
                   or path.startswith(d + ".") for d in declared_state):
            return True
    for m in _PARAMS_REF_RE.finditer(cond):
        dotted, indexed = m.group(1), m.group(2)
        if dotted is not None:
            if _presence_of(dotted, defined_params, False) is None:
                return True
        elif indexed is not None:
            if _presence_of(indexed, defined_params, False) is None:
                return True
        else:
            return True
    return False


# ── branch-variant enumeration (source splices, line-count preserving) ─────

_STMT_RE = re.compile(r"\{%-?.*?%\}", re.DOTALL)
_STMT_KW_RE = re.compile(r"\{%-?\s*(\w+)")


def _iter_stmts(src: str):
    """Yield (keyword, condition, match) for every control-flow statement.
    The condition strip removes BOTH the 'if/elif' prefix and the '%}'
    (with its optional whitespace-control dash) — the old tail pattern
    never matched '%}', which silently starved the static grammars of
    every real condition (probe-verified 2026-11-14)."""
    for m in _STMT_RE.finditer(src):
        kw_m = _STMT_KW_RE.match(m.group(0))
        if not kw_m:
            continue
        cond = re.sub(r"^\{%-?\s*(?:if|elif)\s+", "", m.group(0))
        cond = re.sub(r"-?%\}\s*$", "", cond).strip()
        yield kw_m.group(1), cond, m


def _cond_literal(cond: str) -> bool | None:
    """Whether a condition is a splice-emitted literal (1/0)."""
    c = cond.strip()
    if c == "1":
        return True
    if c == "0":
        return False
    return None


def _first_unknown_stmt(src: str, defined: frozenset[str],
                        declared_state: frozenset[str] = frozenset()
                        ) -> re.Match | None:
    """First if/elif whose condition is unknown AND whose arm can
    actually execute — arms excluded by already-literal conditions
    (`{% if 0 %}` bodies, elif/else arms behind a taken arm) are dead
    shape Klipper skips: expanding them invented variants (and
    macro_render_unexplored infos) with zero coverage value."""
    stack: list[dict] = []
    for kw, cond, m in _iter_stmts(src):
        if kw == "if":
            lit = _cond_literal(cond)
            dead = any(f["dead"] for f in stack) or lit is False
            stack.append({"dead": dead, "true_taken": lit is True})
            if not dead and lit is None and _cond_is_unknown(
                    cond, defined, declared_state):
                return m
            continue
        if kw == "elif" and stack:
            f = stack[-1]
            arm_dead = f["dead"] or f["true_taken"]
            f["dead"] = arm_dead
            lit = _cond_literal(cond)
            if not arm_dead and lit is None and _cond_is_unknown(
                    cond, defined, declared_state):
                return m
            f["true_taken"] = f["true_taken"] or (lit is True)
            continue
        if kw == "else" and stack:
            f = stack[-1]
            f["dead"] = f["dead"] or f["true_taken"]
            continue
        if kw == "endif":
            if stack:
                stack.pop()
            continue
    return None


def _splice_static_param_guards(src: str,
                                defined_params: frozenset[str],
                                authoritative: bool = True) -> str:
    """Replace decidable param-presence conditions with literals BEFORE
    variant expansion (line-count preserving). Once collapsed, only
    genuinely unknown conditions drive both-arm expansion, and reads the
    guard excludes can never render on an arm Klipper would not run
    (the 2026-11-14 audit's FP class)."""
    out = src
    for _kw, cond, m in reversed(list(_iter_stmts(src))):
        if _kw not in ("if", "elif"):
            continue
        verdict = _static_param_presence(cond, defined_params,
                                         authoritative)
        if verdict is not None:
            out = _splice(out, m, "1" if verdict else "0")
    return out


def _splice(src: str, stmt: re.Match, forced: str) -> str:
    """Replace one condition EXPRESSION with a literal 1/0, keeping the
    if/elif keyword (a bare `{% 1 %}` is a syntax error), and padding
    newlines so the source keeps its exact line count — provenance
    matching and template exception linenos stay valid against the
    original body."""
    removed = stmt.group(0)
    kw = _STMT_KW_RE.match(removed).group(1)
    replacement = "{% " + kw + " " + forced + " %}" + "\n" * removed.count("\n")
    return src[: stmt.start()] + replacement + src[stmt.end():]


def _expand_variants(src: str, defined: frozenset[str],
                     cap: int,
                     declared_state: frozenset[str] = frozenset()
                     ) -> tuple[list[str], int]:
    """Deterministic bounded DFS over unknown decisions, TRUE arm first.
    Returns (variants, held) where 'held' counts variants abandoned
    because the cap was reached with decisions still unforced."""
    variants = [src]
    while True:
        idx = next(
            (i for i, v in enumerate(variants)
             if _first_unknown_stmt(v, defined, declared_state) is not None),
            None,
        )
        if idx is None:
            return variants, 0
        if len(variants) + 1 > cap:
            held = sum(1 for v in variants
                       if _first_unknown_stmt(v, defined,
                                              declared_state) is not None)
            return variants, held
        stmt = _first_unknown_stmt(variants[idx], defined, declared_state)
        variants[idx:idx + 1] = [
            _splice(variants[idx], stmt, "1"),
            _splice(variants[idx], stmt, "0"),
        ]


# ── per-variant rendering ──────────────────────────────────────────────────

def _noop_action(*args, **kwargs):
    """Template stand-in for Klipper's action_* context functions
    (gcode_macro.py:106-112): they return '' and their RUNTIME side
    effects (respond / raise / shutdown / webhook) are never simulated."""
    return ""


def _render_context(params: dict[str, str],
                    variables: dict[str, str] | None = None,
                    printer_state: dict | None = None,
                    rawparams: str = "") -> dict:
    # Klipper's cmd(): kwparams = dict(self.variables), then
    # create_template_context() update, then params/rawparams from the
    # command line (klippy/extras/gcode_macro.py). Variables are
    # top-level template names, lowercased at config parse (configfile.py
    # 'option = option.lower()'); the standard context keys win over
    # same-named variables exactly as that update order implies.
    ctx: dict = {k.lower(): _variable_value(v)
                 for k, v in (variables or {}).items()}
    # create_template_context(): printer + the four action functions.
    # NO caller_data (display templates only — plain Undefined here is
    # real Klipper semantics). params is a PLAIN dict — Klipper builds
    # one per invocation — so jinja's own undefined hint reads
    # 'dict object', Klipper's wording.
    ctx.update({
        "printer": (_nest_state(printer_state) if printer_state
                    else UNKNOWN),
        "action_emergency_stop": _noop_action,
        "action_respond_info": _noop_action,
        "action_raise_error": _noop_action,
        "action_call_remote_method": _noop_action,
        # Klipper's params dict keys are UPPERCASE: gcode.py tokenizes the
        # uppercased command line (gcode.py:210) and normalizes extended
        # params with {k.upper(): v} (gcode.py:274). Templates write
        # params.S / params.VELOCITY; a lowercase template reference MISSES
        # in real Klipper too — exactness, not tolerance.
        "params": {k.upper(): v for k, v in params.items()},
        # rawparams is the caller's UNPARSED parameter text (gcode.py keeps
        # the remainder of the line for the template context). A declared
        # invocation's params ARE that text in NAME=value form, so a
        # forwarding macro (`G28 {rawparams}`) renders as the call it
        # really makes instead of as a bare one. Declared params_* defaults
        # are deliberately NOT in here: Klipper's rawparams carries only
        # what the caller typed. With no invocation the string stays empty
        # and the caller treats the splat as undecided (never as absent).
        "rawparams": rawparams,
    })
    return ctx


def _variable_value(raw: str):
    """Klipper evaluates variable_* option values as Python literals at
    config load (gcode_macro.py: ast.literal_eval + json round-trip);
    'variable_x: 0' is INT 0 (falsy), '\"blue\"' is the string blue.
    An invalid literal is a config error Klipper raises at load; the
    validator's option checks own that class, so the simulation falls
    back to the raw string rather than inventing a second error."""
    try:
        return ast.literal_eval(raw)
    except (ValueError, SyntaxError):
        return raw


_UNDEFINED_ATTR_RES = (
    re.compile(r"has no attribute '([^']+)'"),
    re.compile(r"'([^']+)' is undefined"),
    re.compile(r"mapping object.*?\[u?'([^']+)'"),
)


def _undefined_line(message: str, src: str) -> int | None:
    """UndefinedError carries no lineno through jinja's native runtime
    (probe-verified). Recover the best body line by finding the first
    source line referencing the missing name named in the message."""
    name = None
    for rx in _UNDEFINED_ATTR_RES:
        m = rx.search(message or "")
        if m:
            name = m.group(1)
            break
    if not name:
        return None
    for i, line in enumerate(src.split("\n")):
        # Allow a leading dot: the missing name is usually an attribute
        # access (params.FOO), where the char before the name is '.'.
        if re.search(rf"(?<!\w){re.escape(name)}(?!\w)", line):
            return i + 1
    return None


def _missing_param_reads(src_text: str,
                         declared_lower: frozenset[str]) -> set[str]:
    """Raw names of UNGUARDED params reads (no ``|default`` in the
    filter chain following the read) whose value is not declared.
    Heuristic chain-scan: text from the read to the next '}'; a
    multi-line read is not followed (rare). Bare ``params`` object
    access ('X' in params is spliced earlier; ``params|length``) is not
    attributed here."""
    missing: set[str] = set()
    for m in _PARAM_READ_RE.finditer(src_text):
        name = m.group(1) or m.group(2)
        rest = src_text[m.end():]
        end = rest.find("}")
        chain = rest if end < 0 else rest[:end]
        if re.search(r"\|\s*default\b", chain):
            continue
        if name.lower() not in declared_lower:
            missing.add(name)
    return missing


_ALIAS_SET_RE = re.compile(r"\{%-?\s*set\s+(\w+)\s*=(.*?)-?%\}", re.DOTALL)
_ALIAS_FOR_RE = re.compile(r"\{%-?\s*for\s+(\w+)\s+in\s+(.*?)-?%\}",
                           re.DOTALL)
_LINE_EXPR_RE = re.compile(r"\{\{?\s*([A-Za-z_]\w*)\s*\}?\}")


def _param_alias_map(src_text: str) -> dict[str, str]:
    """Template name -> raw param name for reads hidden behind Jinja
    aliases (the Hotkey.cfg FP class, dev-server dogfood 2026-11-14):
    ``{% set led = params.LED|string %}`` and ``{% for i in idx %}``
    over a stringified param. Filter chains are NOT judged here — the
    body-wide missing set already exempts ``|default`` reads, and the
    intersection is taken against it. Chains (set→set, for→set) resolve
    through bounded fixpoint passes; conditional or complex values stay
    unresolved (no shield — conservative direction for ERRORs is only
    ever advisory loss, never fabricated verdicts)."""
    raw: dict[str, str] = {}
    for _ in range(4):
        changed = False
        for m in _ALIAS_SET_RE.finditer(src_text):
            name, expr = m.group(1), m.group(2)
            if name in raw:
                continue
            pm = _PARAM_READ_RE.search(expr)
            head = expr.split("|")[0].strip()
            if pm:
                raw[name] = pm.group(1) or pm.group(2)
                changed = True
            elif head in raw and head != name:
                raw[name] = raw[head]
                changed = True
        for m in _ALIAS_FOR_RE.finditer(src_text):
            var, it = m.group(1), m.group(2)
            if var in raw:
                continue
            pm = _PARAM_READ_RE.search(it)
            its = it.strip().strip("'\"")
            if pm:
                raw[var] = pm.group(1) or pm.group(2)
                changed = True
            elif its in raw and its != var:
                raw[var] = raw[its]
                changed = True
        if not changed:
            break
    return raw


_FINDING_PARAM_RE = re.compile(
    r"(?:Parameter (\w+) renders EMPTY"
    r"|Parameter (\w+)=.*does not parse"
    r"|missing required parameter (\w+))")

# A caller-parameter SPLAT in a template — `{rawparams}`. Klipper expressions
# are single-brace, so this also skips `{% if rawparams %}` (no match) while
# catching `{ rawparams }` and `{rawparams.split()}`.
_RAWPARAMS_SPLAT_RE = re.compile(r"\{\s*rawparams\b")
# A body that ASSIGNS rawparams has decided it locally: the caller's splat is
# shadowed, so the rendered text is the truth and checks must keep running.
_RAWPARAMS_ASSIGN_RE = re.compile(r"\{%-?\s*set\s+rawparams\b")


def _expr_depends_on_missing(expr: str, alias_map: dict[str, str],
                             param_dependent: frozenset[str]) -> bool:
    """True when a template expression reads a param whose value is
    undecided without an invocation (directly or through an alias)."""
    for m in _PARAM_READ_RE.finditer(expr):
        if (m.group(1) or m.group(2)) in param_dependent:
            return True
    for m in _LINE_EXPR_RE.finditer(expr):
        nm = alias_map.get(m.group(1))
        if nm and nm in param_dependent:
            return True
    return False


def _finding_is_param_dependent(finding: RenderFinding, src_line: str,
                                alias_map: dict[str, str],
                                param_dependent: frozenset[str],
                                splat_unknown: bool = False) -> bool:
    """Attribute ONE finding to the param-dependent read that produced it.

    Round-2 review D1: suppressing the whole LINE dropped statically
    decidable defects that share the line with a param-dependent read
    ('SET_LED LED={params.LED} RED=' lost the literal RED=). Attribution
    is per finding: locate that parameter's token in the SOURCE line —
    a literal value (including a literal empty) is static and stays; a
    template expression stays only when it resolves to a DECIDED param.
    A token absent from the source (whole command built by Jinja) is
    attributed to the line's missing reads (the long-standing accepted
    shape)."""
    m = _FINDING_PARAM_RE.search(finding.message)
    if not m:
        return False
    pname = next(g for g in m.groups() if g)
    tok = re.search(rf"(?i)\b{re.escape(pname)}\s*=\s*(\S*)", src_line)
    if tok is not None:
        val = tok.group(1)
        if "{" in val:
            return _expr_depends_on_missing(val, alias_map, param_dependent)
        return False
    if splat_unknown:
        # The line forwards the caller's parameters wholesale. A param that
        # is absent from the TEMPLATE TEXT may still arrive through the
        # splat, so "missing" is undecidable — not observed. Same law as an
        # undeclared `{params.X}` read (3.1): no invocation, no verdict.
        return True
    return _expr_depends_on_missing(src_line, alias_map, param_dependent)


def _render_one(env: jinja2.Environment, src: str, params: dict[str, str],
                variant: int,
                variables: dict[str, str] | None = None,
                printer_state: dict | None = None,
                param_dependent: frozenset[str] = frozenset(),
                rawparams: str = ""
                ) -> tuple[list[str], RenderFinding | None]:
    try:
        out = env.from_string(src).render(
            _render_context(params, variables, printer_state, rawparams))
    except jinja2.TemplateSyntaxError as exc:
        # The body does not compile under Klipper's delimiters
        # (jinja2.Environment('{%', '%}', '{', '}'): expressions are
        # SINGLE-brace {expr}; {{ expr }} is a syntax error). Returning
        # [] with no finding made the tool mute — "nothing rendered,
        # Findings: none" — and the r7/r8/r9 SIMTOOL-02 legs burned up
        # to 12 probe calls chasing it. The static Jinja check also
        # reports this class; a repeated finding on the tool surface is
        # the honest trade for never being silent.
        hint = ""
        if "{{" in src:
            hint = (" Klipper's template environment uses SINGLE braces "
                    "for expressions — write {value}, not {{ value }} "
                    "(only {% ... %} blocks take double braces).")
        return [], RenderFinding(
            "error", "macro_jinja_syntax",
            f"Body does not compile as a Klipper template: {exc.message} "
            f"(line {exc.lineno}).{hint} Nothing was rendered.",
            source_line=exc.lineno,
            variant=variant,
        )
    except UndefinedError as exc:
        lineno = getattr(exc, "lineno", None) or _undefined_line(
            getattr(exc, "message", ""), src)
        # 3.1: an abort through an undeclared param happens ONLY on
        # invocations that omit it — with no invocation declared that is
        # param-dependent, not a verdict. Invented (non-params) names
        # abort on EVERY invocation and keep full severity.
        msg = str(getattr(exc, "message", "") or "")
        if param_dependent and any(
                re.search(rf"(?<!\w){re.escape(n)}(?!\w)", msg)
                for n in param_dependent):
            return [], RenderFinding(
                "info", "macro_param_undefined",
                f"Rendering aborts with Klipper's Undefined error: {exc} "
                "— aborts only on invocations without a declared value; "
                "pass params to simulate_macro for a full verdict.",
                source_line=lineno,
                variant=variant,
            )
        return [], RenderFinding(
            "warning", "macro_param_undefined",
            f"Rendering aborts with Klipper's Undefined error: {exc.message} — "
            "this invocation fails; the caller must pass the value or the "
            "macro needs a |default(...).",
            source_line=lineno,
            variant=variant,
        )
    except (_RenderBlocked, jinja2.TemplateRuntimeError) as exc:
        return [], RenderFinding(
            "info", "macro_render_blocked",
            f"Simulation cannot follow this control flow ({exc}); this path "
            "was not validated by the render simulator.",
            variant=variant,
        )
    except (TypeError, ValueError, ArithmeticError, RecursionError,
            MemoryError) as exc:
        # Review L1/S2: ZeroDivisionError (`{100 / total}` with
        # variable_total: 0 — a VALID macro), overflow, runaway
        # allocation/recursion must never escape into validate_config —
        # one pathological macro cannot break validation of every other
        # section. Swallowed best-effort BUT logged (diagnosable).
        logger.warning("macro render simulation blocked (%s): %s",
                       type(exc).__name__, exc, exc_info=True)
        return [], RenderFinding(
            "info", "macro_render_blocked",
            f"Rendering raised {type(exc).__name__}: {exc}; this path was "
            "not validated by the render simulator.",
            variant=variant,
        )
    return [ln.strip() for ln in out.split("\n") if ln.strip()], None


# ── provenance: rendered line -> body source line ──────────────────────────

def _literal_prefix(line: str) -> str:
    """Literal (non-template) prefix of a source line — text up to the
    first '{' — which every rendering of that line starts with."""
    return line.split("{", 1)[0].strip()


def _match_source_line(text: str, src_lines: list[str], cursor: int) -> int | None:
    """Forward scan from the cursor first (keeps repeated literal lines in
    order), then full scan (loops re-render the same line; pure
    {{expr}} lines share no prefix), then token fallback."""
    for i in range(cursor, len(src_lines)):
        prefix = _literal_prefix(src_lines[i])
        if prefix and text.startswith(prefix):
            return i
    for i, sline in enumerate(src_lines):
        prefix = _literal_prefix(sline)
        if prefix and text.startswith(prefix):
            return i
    parts = text.split()
    token = parts[0] if parts else ""
    if token:
        for i, sline in enumerate(src_lines):
            if re.search(rf"(^|\s){re.escape(token)}(?=\s|$)", sline):
                return i
    return None


# ── post-render command validation (task 2.2) ──────────────────────────────

_PARAM_TOKEN_RE = re.compile(r"(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=(\S*)")
_G1_RE = re.compile(r"G1\b", re.IGNORECASE)
_G1_E_RE = re.compile(r"\bE\s*[0-9]", re.IGNORECASE)
_G1_F_RE = re.compile(r"\bF\s*[0-9]", re.IGNORECASE)


def _looks_unknown(value: str) -> bool:
    v = value.strip()
    return ("<unknown>" in v.lower()
            or bool(_UNKNOWN_NUMERIC_RE.match(v)))


def _is_traditional_gcode(token: str) -> bool:
    """Mirror gcode.py is_traditional_gcode (125-131): a letter (or
    letters) followed by digits — 'M106', 'G1', 'G04'. Traditional
    commands parse args by letter-split (no quotes); everything else
    gets shlex extended-params parsing at run time."""
    return (len(token) > 1 and token[0].isalpha() and token[0].isupper()
            and token[1:].isdigit())


# gcode.py:198 `args_r` verbatim (GCodeCommand.args_r): the only correct
# tokenizer for traditional letter-parameter commands.
_KLIPPER_ARGS_R = re.compile("([A-Z_]+|[A-Z*])")


def _check_rendered_line(text: str, registry: dict, variant: int,
                         source_line: int | None = None,
                         sections: "frozenset[str] | None" = None
                         ) -> list[RenderFinding]:
    from services.gcode_registry import NON_COMMAND_TOKENS, _CMD_TOKEN_RE

    # Klipper executes every line comment-stripped (gcode.py:204-208:
    # strip, then cut at the FIRST ';' — whitespace or not, quotes or
    # not). Review L2: skipping this false-flagged Klipper's own shipped
    # 'M140 S{...}; keep temperature' as unparseable.
    text = text.strip()
    cpos = text.find(';')
    if cpos >= 0:
        text = text[:cpos]

    parts = text.split()
    if not parts:
        return []
    token = parts[0].upper()

    # SET_GCODE_VARIABLE is shape-checked like any command: Klipper
    # dispatches it as a MUX command on MACRO (gcode_macro.py:148 →
    # gcode.py _cmd_mux → gcmd.get(key) with no default), so a line
    # spelling ACTION=/MACRO-less dies with "Error on '...': missing
    # MACRO" before the body runs. The registry entry already carries
    # MACRO/VARIABLE/VALUE required + mux_key, so the generic checks
    # below handle presence; this block adds Klipper's literal rule for
    # VALUE (gcode_macro.py:180-185: ast.literal_eval + json.dumps).
    # (It used to return [] wholesale — "every param is str; tracked by
    # the caller" — which let `SET_GCODE_VARIABLE ACTION=TOGGLE_FAN ...`
    # pass both the sim and the write gate on every branch.)

    if _G1_RE.match(text):
        # Traditional motion commands have no registry entry; the
        # extrusion advisory runs POST-render so templated values cannot
        # hide it (plan 2.2).
        if _G1_E_RE.search(text) and not _G1_F_RE.search(text):
            return [RenderFinding(
                "warning", "macro_rendered_g1_no_feedrate",
                f"Extrusion move without feedrate: '{text[:80]}'. Add an F "
                "parameter to control extrusion speed.", variant=variant)]
        return []

    if not _CMD_TOKEN_RE.match(token) or token in NON_COMMAND_TOKENS:
        return []
    entry = registry.get("commands", {}).get(token)
    if entry is None:
        # Unknown token or user macro: the registry pass
        # (unknown_gcode_command) owns that verdict — post-render does
        # not duplicate it.
        return []

    findings: list[RenderFinding] = []
    # Klipper tokenizes parameters in TWO flavors (review L7):
    # traditional letter+digits commands parse letter+value chunks with
    # NO quote handling (gcode.py args_r split), while every other
    # command goes through _get_extended_params (gcode.py:266-276):
    # shlex posix, whitespace_split, commenters '#;', 'NAME=value' split
    # at the first '=', keys uppercased, unbalanced quotes -> 'Malformed
    # command' refusal at run time. Last occurrence wins, like the
    # params dict.
    present: dict[str, str] = {}
    malformed = False
    if _is_traditional_gcode(token):
        # Letter params only (gcode.py:201/210-218 args_r split): the
        # tokenizer never consumes '=', so 'S=220' is value '=220' and
        # the handler's float() raises "unable to parse =220" — proven
        # LIVE on the .164 printer: `M104 S=0` -> Error on 'M104 S=0':
        # unable to parse =0, while `M104 S0` -> ok. The '=' must stay
        # IN the value here so the type checks below fail it exactly
        # like Klipper does. (The extended branch is the only place
        # 'KEY=value' grammar exists.)
        # Klipper parses the WHOLE line with args_r (gcode.py:198-215:
        # split on '([A-Z_]+|[A-Z*])', pair letter-run -> following
        # chunk, .strip() only whitespace). Whitespace between letter
        # and value is legal: 'M106 S 100' runs with S='100'. A naive
        # per-whitespace-token split recorded S='' there and flagged a
        # save-gate error on a config Klipper executes (PR #43 review
        # A-01). '=' stays inside the value exactly like the old shape
        # ('M104 S=0' -> value '=0' -> float() fails, live on .164).
        uparts = _KLIPPER_ARGS_R.split(text.upper())
        for i in range(1, len(uparts) - 1, 2):
            present[uparts[i]] = uparts[i + 1].strip()
    else:
        lexer = shlex.shlex(text[len(token):], posix=True)
        lexer.whitespace_split = True
        lexer.commenters = "#;"
        try:
            for earg in lexer:
                key, sep, value = earg.partition("=")
                if not sep:
                    # klippy's earg.split('=', 1) unpack raises ValueError
                    # -> 'Malformed command': a bare arg is a refusal.
                    malformed = True
                    break
                present[key.upper()] = value
        except ValueError:
            malformed = True
    if malformed:
        return [RenderFinding(
            "error", "macro_param_unparseable",
            f"Malformed command '{text[:80]}' — Klipper refuses to parse "
            "it at run time (unbalanced quotes or a bare argument).",
            variant=variant, source_line=source_line)]
    seen_unknown = False
    for pname, pdef in sorted((entry.get("params") or {}).items()):
        pdef = pdef or {}
        value = present.get(pname.upper())
        if value is None:
            if pdef.get("required"):
                findings.append(RenderFinding(
                    "error", "macro_param_renders_empty",
                    f"Rendered command '{text[:80]}' is missing required "
                    f"parameter {pname} — Klipper refuses the line at run "
                    "time.", variant=variant))
            continue
        if _looks_unknown(value):
            if not seen_unknown:
                findings.append(RenderFinding(
                    "info", "macro_unknown_value",
                    f"A parameter of {token} renders as unknown printer "
                    f"state ({value}) — the command SHAPE was simulated, "
                    "the value was not.", variant=variant))
                seen_unknown = True
            continue
        if value == "":
            # An empty value only breaks Klipper where it must PARSE
            # (float/int — the field repro 'RED='), or where it names a
            # mux target (an empty mux name can never resolve: lookup of
            # '' fails). A plain string param accepts '' — Klipper's own
            # sample configs spell the unsync as `MOTION_QUEUE=`
            # (kinematics/extruder.py cmd_SYNC_EXTRUDER_MOTION: gcmd.get
            # returns '' and sync_to_extruder(None) is the documented
            # detach), so 'required and empty' alone is NOT an error.
            _numeric = pdef.get("type") in ("float", "int")
            _is_mux = (pname.upper()
                       == str(entry.get("mux_key") or "").upper())
            if _numeric or (_is_mux and pdef.get("required")):
                findings.append(RenderFinding(
                    "error", "macro_param_renders_empty",
                    f"Parameter {pname} renders EMPTY ('{pname}=') — "
                    f"{token} parses it as "
                    f"{pdef.get('type') or 'a required value'} and fails on "
                    "an empty string.", variant=variant))
            continue
        ptype = pdef.get("type")
        number: float | None = None
        try:
            if ptype == "float":
                number = float(value)
            elif ptype == "int":
                number = int(value)
        except ValueError:
            _hint = ""
            if value.startswith("="):
                _hint = (f" — letter-style commands like {token} take "
                         f"no '=' after the parameter letter: write "
                         f"{pname}{value[1:]} not {pname}={value[1:]} "
                         "(Klipper's own error: 'unable to parse "
                         f"{value}').")
            elif "=" in value:
                _hint = (f" — letter-style commands like {token} have no "
                         f"'KEY=value' grammar at all: Klipper read "
                         f"{pname} as '{value}' (the '=' is part of the "
                         "value). Spell it as a plain letter parameter "
                         "(e.g. G4 uses P<milliseconds>).")
            findings.append(RenderFinding(
                "error", "macro_param_unparseable",
                f"Parameter {pname}={value!r} does not parse as "
                f"{ptype} that {token} expects.{_hint}", variant=variant))
        if number is not None:
            findings.extend(_bound_findings(token, pname, value, number, pdef,
                                            variant, source_line))

    if token == "SET_GCODE_VARIABLE":
        # Klipper stores VALUE through ast.literal_eval + json.dumps
        # (gcode_macro.py:180-185), so an unquoted string (`VALUE=on`)
        # or a bare `VALUE=` is refused at run time. Registry type str
        # alone cannot express that; check it here. Rendered <unknown>
        # was already downgraded to info above.
        stored = present.get("VALUE")
        if stored is not None and not _looks_unknown(stored):
            try:
                json.dumps(ast.literal_eval(stored), separators=(",", ":"))
            except (SyntaxError, ValueError, TypeError):
                findings.append(RenderFinding(
                    "error", "macro_param_unparseable",
                    f"SET_GCODE_VARIABLE VALUE={stored!r} is not a Python "
                    "literal — Klipper parses VALUE with literal_eval and "
                    "fails the call at run time (quote strings with nested "
                    "quotes: VALUE=\"'on'\" — plain VALUE='on' has the "
                    "quotes stripped by the command tokenizer and fails "
                    "again).", variant=variant))
    findings.extend(_either_of_findings(token, present, variant, source_line))
    findings.extend(_enum_findings(token, present, variant, source_line))
    findings.extend(_mux_target_findings(token, entry, present, sections,
                                         variant, source_line))
    return findings


# ── mux targets: does the named hardware object exist? ────────────────────
#
# A mux command resolves its key against the printer objects Klipper
# REGISTERED from config (gcode.py:317-335 _cmd_mux): an unknown value is
# a run-time gcmd.error — `The value 'fan' is not valid for FAN. Did you
# mean 'Aux_Fan'?` — while the config itself loads and boots fine. That
# makes an unknown target a WARNING here (repo taxonomy: error = Klipper
# refuses to start or a config value is invalid), and it is sim-origin, so
# it never reaches the human save gate.
#
# The resolution is per FAMILY, not per key: SET_FAN_SPEED's FAN only
# enumerates [fan_generic NAME] — [fan] is the part-cooling fan driven by
# M106/M107 and is NOT addressable that way, which is exactly the trap the
# SIMTOOL-02 r9 leg b walk-through fell into.
#
# v1 covers the families whose mux VALUE is the section's own name — each
# entry below is the set of section types whose code calls
# register_mux_command, read out of reference/klipper/klippy:
#   FAN         fan_generic.py only (that is the whole point: [fan] is
#               NOT addressable)
#   PIN         output_pin.py, pwm_cycle_time.py, pwm_tool.py
#   LED         LEDHelper users: neopixel, dotstar, pca9533, pca9632,
#               [led] (led.py load_config_prefix)
#   HEATER      heaters.py setup_heater() — [extruder]/[extruderN],
#               [heater_bed], [heater_generic X]
#   SERVO       servo.py
#   BUTTON      gcode_button.py
#   ID          delayed_gcode.py
#   LOAD_CELL   load_cell.py
#   DIGIPOT     mcp4018.py
#   SENSOR      filament_switch_sensor.py (both switch and motion)
#   PROBE       temperature_probe.py
#   TEMPERATURE_FAN temperature_fan.py
# Deferred to v2, because the value is NOT the section suffix:
#   EXTRUDER    kinematics/extruder.py registers with key None when there
#               is a single extruder (key optional) and ACTIVATE_EXTRUDER
#               enumerates extruder1+ only — a naive suffix rule invents
#               "extruder1 already exists" warnings.
#   SENSOR (TEMPERATURE_WAIT) values are FULL section names (heaters.py
#               register_sensor: config.get_name()), so the target text is
#               'temperature_sensor chamber' — space and all.
#   STEPPER     MANUAL_STEPPER -> [manual_stepper X], FORCE_MOVE ->
#               stepper_x/z1, DUMP_TMC -> the tmc section: three spaces.
#   CHIP        adxl345 / angle / ldc1612 / probe_eddy_current, all
#               registered `"CHIP", config.get_name().split()[-1]` — the
#               trailing name is the value ([adxl345] -> 'adxl345',
#               [angle my_chip] -> 'my_chip').
_CHIP_FAMILIES = ("adxl345", "angle", "ldc1612", "probe_eddy_current")

_MUX_TARGET_FAMILIES: dict[str, tuple[str, ...]] = {
    "SET_FAN_SPEED": ("fan_generic",),
    "SET_LED": ("neopixel", "dotstar", "pca9533", "pca9632", "led"),
    "SET_LED_TEMPLATE": ("neopixel", "dotstar", "pca9533", "pca9632", "led"),
    "SET_PIN": ("output_pin", "pwm_cycle_time", "pwm_tool"),
    "SET_SERVO": ("servo",),
    "SET_HEATER_TEMPERATURE": ("extruder", "heater_bed", "heater_generic"),
    "SET_TEMPERATURE_FAN_TARGET": ("temperature_fan",),
    "TEMPERATURE_PROBE_CALIBRATE": ("temperature_probe",),
    "TEMPERATURE_PROBE_ENABLE": ("temperature_probe",),
    "QUERY_BUTTON": ("button",),
    "UPDATE_DELAYED_GCODE": ("delayed_gcode",),
    "LOAD_CELL_CALIBRATE": ("load_cell",),
    "LOAD_CELL_DIAGNOSTIC": ("load_cell",),
    "LOAD_CELL_READ": ("load_cell",),
    "LOAD_CELL_TARE": ("load_cell",),
    "SET_FILAMENT_SENSOR": ("filament_switch_sensor",
                            "filament_motion_sensor"),
    "QUERY_FILAMENT_SENSOR": ("filament_switch_sensor",
                              "filament_motion_sensor"),
    "SET_DIGIPOT": ("mcp4018",),
    # v2 (P4): the CHIP space.
    "ACCELEROMETER_MEASURE": _CHIP_FAMILIES,
    "ACCELEROMETER_QUERY": _CHIP_FAMILIES,
    "ACCELEROMETER_DEBUG_READ": _CHIP_FAMILIES,
    "ACCELEROMETER_DEBUG_WRITE": _CHIP_FAMILIES,
    "ANGLE_CALIBRATE": _CHIP_FAMILIES,
    "ANGLE_CHIP_CALIBRATE": _CHIP_FAMILIES,
    "ANGLE_DEBUG_READ": _CHIP_FAMILIES,
    "ANGLE_DEBUG_WRITE": _CHIP_FAMILIES,
    "LDC_CALIBRATE_DRIVE_CURRENT": _CHIP_FAMILIES,
    "PROBE_EDDY_CURRENT_CALIBRATE": _CHIP_FAMILIES,
    # MANUAL_STEPPER resolves against [manual_stepper NAME]; the OTHER
    # stepper-keyed commands resolve against rail names (see below).
    "MANUAL_STEPPER": ("manual_stepper",),
}

# Mux families whose VALUE is the full section header, not its last token:
# heaters.py register_sensor uses config.get_name(), so the legal
# TEMPERATURE_WAIT SENSOR value is 'temperature_sensor chamber', space and
# all. Every module that calls pheaters.register_sensor is listed, or a
# legitimate target would be reported missing.
_MUX_FULL_NAME_FAMILIES: dict[str, tuple[str, ...]] = {
    "TEMPERATURE_WAIT": ("extruder", "heater_bed", "heater_generic",
                         "temperature_fan", "temperature_probe",
                         "temperature_sensor", "z_thermal_adjust"),
}

# Commands whose mux value is a STEPPER RAIL name: force_move and
# stepper_enable register per `mcu_stepper.get_name()` ('stepper_x',
# extruder rails 'extruder'/'extruder1'), tmc registers
# `config.get_name().split()[-1]` ('stepper_x' from [tmc2209 stepper_x]).
# The legal set is the rails the project declares, so it is derived from
# section headers rather than from a family list.
_MUX_STEPPER_RAIL_COMMANDS = frozenset({
    "DUMP_TMC", "INIT_TMC", "SET_TMC_CURRENT", "SET_TMC_FIELD",
    "FORCE_MOVE", "STEPPER_BUZZ", "SET_STEPPER_ENABLE",
})

# Section types that register themselves under a bare name (the value is
# the section name) and, for extruders, also under a numbered name.
_MUX_NUMBERED_FAMILIES = ("extruder",)


def _mux_target_names(sections: "frozenset[str] | None",
                      families: tuple[str, ...]) -> set[str]:
    """Every legal mux value for `families` given the project's section
    headers (lowercased, e.g. 'fan_generic aux_fan').

    Klipper registers a heater under the LAST token of its section name
    (heaters.py setup_heater: config.get_name().split()[-1]), so
    [heater_generic chamber] -> 'chamber' and bare [heater_bed] ->
    'heater_bed'. Numbered extruders ([extruder1]) register as
    'extruder1'.
    """
    names: set[str] = set()
    numbered = any(f in _MUX_NUMBERED_FAMILIES for f in families)
    for raw in sections or ():
        head, _, rest = str(raw).strip().lower().partition(" ")
        if head in families:
            names.add(rest.split()[-1] if rest else head)
        elif numbered and re.fullmatch(r"extruder\d*", head):
            names.add(head)
    return names


def _full_section_names(sections: "frozenset[str] | None",
                        families: tuple[str, ...]) -> set[str]:
    """Every legal value for a mux command whose target is a FULL section
    header (heaters.py register_sensor: config.get_name())."""
    names: set[str] = set()
    for raw in sections or ():
        header = str(raw).strip().lower()
        if header.partition(" ")[0] in families:
            names.add(header)
    return names


def _stepper_rail_names(sections: "frozenset[str] | None") -> set[str]:
    """Every stepper RAIL name the project declares.

    Klipper registers the stepper-keyed mux commands per rail: `stepper_x`
    and friends come from their own section header, extruders from
    [extruder]/[extruder1], and a manual stepper's rail from the token after
    `[manual_stepper NAME]`.
    """
    names: set[str] = set()
    for raw in sections or ():
        header = str(raw).strip().lower()
        head, _, rest = header.partition(" ")
        if re.fullmatch(r"stepper_[a-z0-9_]+", head):
            names.add(head)
        elif head == "extruder" or re.fullmatch(r"extruder\d+", head):
            names.add(head)
        elif head == "manual_stepper" and rest.strip():
            names.add(rest.split()[-1])
    return names


# ── enum params: legal values Klipper refuses anything else for ───────────
#
# Only params whose membership test RAISES gcmd.error belong here: those
# are run-time refusals of the rendered line, the same class as an
# unparseable float. A validate-and-respond_info check (BLTouch COMMAND,
# M204) is NOT one — Klipper prints a hint and carries on, so flagging it
# would invent a failure.
#
#   RESPOND TYPE         respond.py: respond_types + respond_types_no_space
#                        else raise "RESPOND TYPE 'x' is invalid. Must be
#                        one of 'echo', 'command', or 'error'"
#   SET_DUAL_CARRIAGE MODE  kinematics/idex_modes.py VALID_MODES else
#                        raise "Invalid mode=%s specified"
#
# Bounds (minval/maxval) are deliberately NOT validated here: 63 of them
# exist in klippy and most are config-dependent (`SET_PIN VALUE` maxval is
# the pin's own scale, `SET_LED INDEX` maxval is the chain length), so a
# static verdict would be a guess. Literal-only bounds are a separate,
# smaller follow-up.
_PARAM_ENUMS: dict[str, dict[str, frozenset[str]]] = {
    "RESPOND": {"TYPE": frozenset({"echo", "command", "error",
                                   "echo_no_space"})},
    "SET_DUAL_CARRIAGE": {"MODE": frozenset({"inactive", "primary",
                                             "copy", "mirror"})},
}

# ── either-of rules: the call is refused unless a SET of params is supplied ─
#
# Only shapes where Klipper RAISES belong here (same test as _PARAM_ENUMS):
#   SET_FAN_SPEED     fan_generic.py: `(speed is None) == (template is None)`
#                     raises, so BOTH missing and BOTH present are refused —
#                     exactly one ("xor").
#   TEMPERATURE_WAIT  heaters.py: raises only when MINIMUM and MAXIMUM are
#                     both absent — at least one ("or").
_PARAM_EITHER_OF: dict[str, tuple[tuple[str, ...], str]] = {
    "SET_FAN_SPEED": (("SPEED", "TEMPLATE"), "xor"),
    "TEMPERATURE_WAIT": (("MINIMUM", "MAXIMUM"), "or"),
}


def _either_of_findings(token: str, present: dict[str, str], variant: int,
                        source_line: int | None) -> list[RenderFinding]:
    """Reject a call whose supplied-parameter SET Klipper refuses."""
    rule = _PARAM_EITHER_OF.get(token)
    if not rule:
        return []
    names, mode = rule
    values = {name: present.get(name) for name in names}
    if any(v is not None and _looks_unknown(v) for v in values.values()):
        # A rendered-unknown value may or may not be supplied: undecidable.
        return []
    supplied = [name for name, v in values.items()
                if v is not None and str(v).strip() != ""]
    listed = " or ".join(names)
    if mode == "xor":
        if len(supplied) == 1:
            return []
        if supplied:
            wording = (f"accepts only ONE of {listed} — both "
                       f"{' and '.join(supplied)} were given")
        else:
            wording = f"needs exactly one of {listed} — neither was given"
    else:                                    # "or": at least one
        if supplied:
            return []
        wording = f"needs at least one of {listed} — neither was given"
    return [RenderFinding(
        "error", "macro_param_missing_choice",
        f"{token} {wording}. Klipper refuses the call at run time.",
        variant=variant, source_line=source_line)]


_RANGE_WORDING = {
    "minval": "must have minimum of",
    "maxval": "must have maximum of",
    "above": "must be above",
    "below": "must be below",
}


def _bound_findings(token: str, pname: str, raw: str, number: float,
                    pdef: dict, variant: int,
                    source_line: int | None) -> list[RenderFinding]:
    """Reject a literal value outside the range Klipper's own get() enforces.

    gcode.py `GCodeCommand.get()` raises when `value < minval` or
    `value > maxval` (inclusive limits), and when `value <= above` or
    `value >= below` (exclusive). Only LITERAL limits reach the artifact — a
    config-derived limit (`maxval=self.scale`, `above=min_temp`) is never
    recorded — so anything reported here is decidable from the template.
    Klipper raises at the first failing check, in this order.
    """
    for key in ("minval", "maxval", "above", "below"):
        limit = pdef.get(key)
        if not isinstance(limit, (int, float)) or isinstance(limit, bool):
            continue
        violated = {
            "minval": number < limit,
            "maxval": number > limit,
            "above": number <= limit,
            "below": number >= limit,
        }[key]
        if not violated:
            continue
        return [RenderFinding(
            "error", "macro_param_out_of_bounds",
            f"{token} {pname}={raw} is outside the range Klipper accepts — "
            f"the call errors at run time ({pname} {_RANGE_WORDING[key]} "
            f"{limit}).", variant=variant, source_line=source_line)]
    return []


def _enum_findings(token: str, present: dict[str, str], variant: int,
                   source_line: int | None) -> list[RenderFinding]:
    """Reject a param value Klipper's own membership test refuses."""
    spec = _PARAM_ENUMS.get(token)
    if not spec:
        return []
    out: list[RenderFinding] = []
    for pname, allowed in spec.items():
        value = present.get(pname)
        if value is None or not value.strip() or _looks_unknown(value):
            continue          # absent = required-check's job; unknown = undecidable
        if value.strip().lower() in allowed:
            continue
        listed = ", ".join("'%s'" % v for v in sorted(allowed))
        out.append(RenderFinding(
            "error", "macro_param_enum_invalid",
            f"{token} {pname}='{value}' is not a legal value — Klipper "
            f"refuses the call at run time. Allowed: {listed}.",
            variant=variant, source_line=source_line))
    return out


def _mux_target_findings(token: str, entry: dict, present: dict[str, str],
                         sections: "frozenset[str] | None", variant: int,
                         source_line: int | None) -> list[RenderFinding]:
    """Warn when a mux command names hardware the project does not define.

    `sections is None` means the loaded files cannot decide absence (an
    include we cannot read, no project at all): silence, never a guess —
    the same decidable-absence law the variable checks follow.
    """
    key = str(entry.get("mux_key") or "").upper()
    if not key or sections is None:
        return []
    value = present.get(key)
    if not value or _looks_unknown(value):
        return []          # empty is an ERROR above; unknown is undeclared
    families = _MUX_TARGET_FAMILIES.get(token)
    full = _MUX_FULL_NAME_FAMILIES.get(token)
    if full is not None:
        legal = _full_section_names(sections, full)
        label = "/".join(f"[{f}]" for f in full)
    elif token in _MUX_STEPPER_RAIL_COMMANDS:
        legal = _stepper_rail_names(sections)
        label = "stepper rail"
    elif families:
        legal = _mux_target_names(sections, families)
        label = "/".join(f"[{f}]" for f in families)
    else:
        return []
    if value.strip().lower() in legal:
        return []
    guess = ""
    matches = sorted(n for n in legal if value.strip().lower() in n)
    if matches:
        guess = " Did you mean '%s'?" % matches[0]
    elif legal:
        shown = sorted(legal)[:8]
        more = "" if len(legal) <= 8 else ", …"
        guess = " Options: %s%s." % (
            ", ".join("'%s'" % n for n in shown), more)
    else:
        guess = f" No {label} section exists in the loaded project."
    return [RenderFinding(
        "warning", "macro_mux_target_unknown",
        f"The value '{value}' is not valid for {key}.{guess} Klipper "
        f"resolves {key} against the {label} objects the config "
        "registers, so this call errors at run time (the config itself "
        "still boots).",
        variant=variant, source_line=source_line)]


def _scan_set_variables(rendered_texts: list[tuple[str, int]]) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for text, _ in rendered_texts:
        if not text.upper().startswith("SET_GCODE_VARIABLE"):
            continue
        found: dict[str, list[str]] = {}
        for m in _PARAM_TOKEN_RE.finditer(text):
            found.setdefault(m.group(1).upper(), []).append(m.group(2))
        macro = (found.get("MACRO") or [""])[0]
        for var in found.get("VARIABLE", []):
            pairs.append((macro, var))
    return pairs


# ── engine entry ───────────────────────────────────────────────────────────

def _coerce_str_map(mapping: dict | None) -> dict[str, str]:
    """str->str coercion with lowercase keys (Klipper invocation params
    are always text; lookups are case-insensitive)."""
    if not mapping:
        return {}
    return {str(k).lower(): (v if isinstance(v, str) else str(v))
            for k, v in mapping.items()}


def _rawparam_text(params: dict[str, str]) -> str:
    """Reconstruct the caller's parameter text for ``{rawparams}``.

    Klipper hands the template the raw remainder of the command line, so a
    declared invocation's params ARE that text in NAME=value form. Values
    that need it are quoted the way the shlex-based extended-param tokenizer
    expects, so a splat round-trips through the rendered-line parse instead
    of fabricating a 'Malformed command' (a value with a space would
    otherwise split into a bare argument).
    """
    parts: list[str] = []
    for key, value in params.items():
        text = str(value)
        if any(ch.isspace() for ch in text) or '"' in text:
            text = '"' + text.replace('"', '\\"') + '"'
        parts.append(f"{str(key).upper()}={text}")
    return " ".join(parts)


def simulate_macro_uncached(body: str, params: dict[str, str] | None = None,
                            known_macros: frozenset[str] = frozenset(),
                            max_variants: int = MAX_RENDER_VARIANTS,
                            variables: dict[str, str] | None = None,
                            printer_state: dict | None = None,
                            declared_defaults: dict[str, str] | None = None,
                            invocation_given: bool = True,
                            sections: "frozenset[str] | None" = None
                            ) -> MacroRenderResult:
    from parser.validator import (_MACRO_JINJA_ENV, _compile_macro_template,
                                  _strip_inline_comments)

    params = _coerce_str_map(params)
    variables = variables or {}
    printer_state = printer_state or {}
    declared_defaults = _coerce_str_map(declared_defaults)
    stripped = _strip_inline_comments(body)
    if not stripped.strip():
        return MacroRenderResult()

    # PR #43 A-03: the fail-open / refuse-early paths below return BEFORE
    # the render pipeline ever compiles the body. Klipper compiles the
    # whole body at load — so run the same compile check here first, or a
    # genuinely non-compiling body goes silent on the tool surface
    # ("Findings: none"), the exact mute class ec6059c killed.
    def _syntax_findings() -> list[RenderFinding]:
        compile_error = _compile_macro_template(stripped)
        if compile_error is None:
            return []
        message, lineno = compile_error
        return [RenderFinding(
            "error", "macro_jinja_syntax",
            f"Body does not compile as a Klipper template: {message} "
            f"(line {lineno}). Nothing was rendered.",
            source_line=lineno)]

    if "{% raw" in stripped:
        # Raw blocks defeat the statement scanner; fail open for this
        # class only (rare in macro bodies) — but never mute a syntax
        # error (A-03).
        return MacroRenderResult(findings=_syntax_findings())

    # Bounded work (round-2 D6): a body looping over a huge constant
    # range hangs the render (range(10**9) neither raises nor gets
    # contained — unlike range(...)|list, which trips the S2 guard).
    # Refuse up front with an info finding: validation must never stall.
    _big_range = re.search(r"\brange\s*\(\s*(\d[\d_]{5,})", stripped)
    if _big_range:
        return MacroRenderResult(findings=_syntax_findings() + [RenderFinding(
            "info", "macro_render_blocked",
            f"Template loops over range({_big_range.group(1)}) — too "
            "large to simulate; this body's rendered commands were not "
            "verified.")])

    # Param-presence guards consult PARAMS ONLY (review L6): Klipper's
    # params dict never contains the macro's variables. Bare `x is
    # defined` (where x IS a variable/template name) is not one of these
    # grammars — it resolves natively at render time, where variables
    # are in the context.
    #
    # 3.1 invocation model: declared_defaults (section params_*) ride
    # EVERY Klipper invocation (the params_X mechanism); an explicit
    # invocation overrides them per key and makes every guard
    # authoritative. Without an invocation, only declared names are
    # decidable — everything else stays param-dependent, never a
    # fabricated error (the Hotkey.cfg FP class).
    declared_lower = frozenset(k.lower() for k in declared_defaults)
    render_params = {**declared_defaults, **params}
    defined = (frozenset(k.upper() for k in render_params)
               if invocation_given
               else frozenset(k.upper() for k in declared_lower))
    # Scenario-declared dotted state paths: conditions whose printer
    # paths are covered evaluate NATIVELY (the value is known) — no arm
    # expansion for known shape.
    declared_state = frozenset(
        _state_path_key(k) for k in printer_state if _state_path_key(k))
    # Param-presence guards are deterministic for THIS invocation: splice
    # them to literals first so the guarded arms collapse exactly like
    # Klipper's branch selection (4R.1). Without an invocation only
    # declared names resolve; the rest expand both arms and the
    # value-reading arm downgrades to param-dependent info.
    stripped = _splice_static_param_guards(stripped, defined,
                                           invocation_given)
    # Names whose reads are param-dependent (no declared value, no
    # |default guard) — full-source set drives the UndefinedError
    # downgrade; per-line re-detection attributes the line findings.
    param_dependent = (frozenset() if invocation_given else
                       frozenset(_missing_param_reads(stripped,
                                                      declared_lower)))
    variants, held = _expand_variants(stripped, defined, max_variants,
                                      declared_state)

    # P0: `{rawparams}` forwards the caller's parameters, so a line using it
    # has unknown ARITY without an invocation — a param absent from the
    # template may still arrive through the splat (Klipper's own eddy samples
    # forward `{rawparams}` into PROBE_EDDY_CURRENT_CALIBRATE). Suppressing
    # "missing required" here is the same law 3.1 already applies to
    # `{params.X}`: undecidable is not absent. A body that assigns rawparams
    # itself has decided the text — those keep full checking.
    splat_undecided = (not invocation_given
                       and bool(_RAWPARAMS_SPLAT_RE.search(stripped))
                       and not _RAWPARAMS_ASSIGN_RE.search(stripped))
    # rawparams for a DECLARED invocation: the caller's own text (the
    # params_* defaults are not part of what the caller typed).
    raw_tail = _rawparam_text(params)

    try:
        from services.gcode_registry import load_registry
        registry = load_registry()
    except (FileNotFoundError, ValueError):
        registry = {}  # missing/corrupt artifact: shape-free render only

    rendered: list[RenderedLine] = []
    findings: list[RenderFinding] = []
    pd_reported: set[str] = set()
    for vi, variant_src in enumerate(variants):
        src_lines = variant_src.split("\n")
        alias_map = _param_alias_map(variant_src) if not invocation_given \
            else {}
        lines, finding = _render_one(_MACRO_JINJA_ENV, variant_src,
                                     render_params, vi, variables,
                                     printer_state, param_dependent,
                                     raw_tail)
        if finding is not None:
            findings.append(finding)
            continue
        cursor = 0
        for text in lines:
            match = _match_source_line(text, src_lines, cursor)
            src_line = (match + 1) if match is not None else None
            if match is not None:
                cursor = match + 1
            rendered.append(RenderedLine(text=text, source_line=src_line,
                                         variant=vi))
            # 3.1: a line whose SOURCE reads an undeclared, un-defaulted
            # param has no verdict without an invocation — report the
            # param dependency once per name, skip the shape checks that
            # would only measure the empty-Undefined rendering.
            # (Residual: an inline single-line if-body defeats line
            # attribution and falls back to full checks — rare shape.)
            line_src = src_lines[match] if match is not None else None
            if len(rendered) >= _RENDER_LINE_CAP:
                if not any(f.code == "macro_render_unexplored"
                           for f in findings):
                    findings.append(RenderFinding(
                        "info", "macro_render_unexplored",
                        f"Stopped after {_RENDER_LINE_CAP} rendered lines — "
                        "the body expands to an unusually large command "
                        "set; later lines were not verified."))
                break
            line_splat = False
            if not invocation_given and line_src is not None:
                line_splat = bool(splat_undecided
                                  and _RAWPARAMS_SPLAT_RE.search(line_src))
                missing = _missing_param_reads(line_src, declared_lower)
                # Reads hidden behind Jinja aliases (`{% set led =
                # params.LED|string %}`, a for-loop over a stringified
                # param) resolve through the alias map and intersect
                # with the body-wide missing set — the |default
                # exemption and declared check already live there.
                if alias_map:
                    for em in _LINE_EXPR_RE.finditer(line_src):
                        pname = alias_map.get(em.group(1))
                        if pname and pname in param_dependent:
                            missing.add(pname)
                if missing:
                    for nm in sorted(missing):
                        if nm.lower() in pd_reported:
                            continue
                        pd_reported.add(nm.lower())
                        findings.append(RenderFinding(
                            "info", "macro_param_undefined",
                            f"'{nm}' has no declared value and no "
                            "invocation was given: the verdict for this "
                            "line is param-dependent — pass params to "
                            "simulate_macro for a full verdict.",
                            variant=vi, source_line=src_line))
                if line_splat and "rawparams" not in pd_reported:
                    pd_reported.add("rawparams")
                    findings.append(RenderFinding(
                        "info", "macro_param_undefined",
                        "'rawparams' forwards the caller's parameters and "
                        "no invocation was given: params on this line are "
                        "param-dependent — pass params to simulate_macro "
                        "for a full verdict.",
                        variant=vi, source_line=src_line))
            for f in _check_rendered_line(text, registry, vi, sections=sections):
                # Round-2 D1: suppress per FINDING, never per line —
                # a literal defect sharing the line with a
                # param-dependent read stays a real verdict.
                if not invocation_given:
                    if (line_src is not None
                            and _finding_is_param_dependent(
                                f, line_src, alias_map, param_dependent,
                                splat_unknown=line_splat)):
                        continue
                    if (line_src is None
                            and (param_dependent or splat_undecided)):
                        # PR #43 A-02: attribution can fail on legal
                        # shapes (one-line '{% if ... %}SET_LED ...' with
                        # no space after '%}', a command assembled into a
                        # variable and emitted). With no invocation and a
                        # body that reads undeclared params somewhere, an
                        # UNATTRIBUTED line is undecidable — 'no
                        # invocation, no verdict' holds even when the
                        # source line cannot be named. (The old shape
                        # let exactly these fall through to full checks
                        # and block the save gate.)
                        continue
                findings.append(replace(f, source_line=f.source_line or src_line))

    # Dedup findings that repeat across variants when the breakage is
    # structural (same code + message + source line): keep the first
    # (lowest variant index) so a both-arms defect is reported once.
    seen: set[tuple] = set()
    deduped: list[RenderFinding] = []
    for f in findings:
        key = (f.code, f.message, f.source_line)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(f)
    findings = deduped

    if held:
        findings.append(RenderFinding(
            "info", "macro_render_unexplored",
            f"Branch rendering hit the {max_variants}-path cap with "
            f"{held} path(s) left un-simulated; those paths were not "
            "validated.", source_line=None, variant=None))

    return MacroRenderResult(
        rendered=rendered,
        findings=findings,
        unknown_accesses=[],
        set_variables=_scan_set_variables(
            [(r.text, r.source_line or 0) for r in rendered]),
        variants_rendered=len(variants),
    )


@lru_cache(maxsize=1024)
def _simulate_cached(body: str, params_items: tuple[tuple[str, str], ...],
                     max_variants: int,
                     variables_items: tuple[tuple[str, str], ...],
                     state_items: tuple[tuple[str, str], ...],
                     defaults_items: tuple[tuple[str, str], ...],
                     invocation_given: bool,
                     sections_items: tuple[str, ...] | None = None
                     ) -> MacroRenderResult:
    # Scenario state values crossed the cache boundary as repr(): the
    # cache key must stay hashable while keeping value TYPE visible
    # (1 vs '1' must not share an entry). invocation_given is part of
    # the key: an explicit empty invocation ({}) and NO invocation
    # (None) are different epistemic states (3.1). The project's section
    # headers join the key too (None vs () distinct): mux-target verdicts
    # depend on which hardware the loaded project declares, so two
    # projects must never share a cached result.
    import json
    state = {}
    for path, raw in state_items:
        try:
            state[path] = json.loads(raw)
        except ValueError:
            state[path] = raw
    sections = None if sections_items is None else frozenset(sections_items)
    return simulate_macro_uncached(body, dict(params_items),
                                   frozenset(), max_variants,
                                   dict(variables_items), state,
                                   declared_defaults=dict(defaults_items),
                                   invocation_given=invocation_given,
                                   sections=sections)


def simulate_macro(body: str, params: dict[str, str] | None = None,
                   known_macros: frozenset[str] = frozenset(),
                   max_variants: int = MAX_RENDER_VARIANTS,
                   variables: dict[str, str] | None = None,
                   printer_state: dict | None = None,
                   declared_defaults: dict[str, str] | None = None,
                   sections: "frozenset[str] | None" = None
                   ) -> MacroRenderResult:
    """Simulate one macro body on an invocation.

    ``params`` are the INVOCATION parameters — pass them (even `{}` for
    a bare invocation) to get a verdict for that exact call. With
    params=None no invocation is declared: reads without a declared
    value become param-dependent INFO, never fabricated errors/warnings
    (3.1 — absence of invocation info is not evidence of absence).
    ``declared_defaults`` are the section's ``params_*`` values: they
    ride EVERY Klipper invocation (the params_X default mechanism), are
    overridden per key by an explicit invocation, and their empty
    values stay a hard ERROR (the field-repro class).
    ``variables`` are the section's own ``variable_*`` values
    (raw option strings; literal-evaluated like Klipper's config load) —
    top-level template names in every invocation, independent of params.
    ``printer_state`` (4R.3) overlays declared dotted paths
    (``{'toolhead.homed_axes': 'xyz'}``) onto the UNKNOWN sentinel: a
    declared value renders as a real value, everything else keeps
    widening. Results are cached by (body, params, declared_defaults,
    invocation-given, variables, printer_state) — the simulation has no
    other project input in v1 (macro calls are not recursed), so that
    tuple IS the full cache key (cross-context isolation pinned by
    test). ``known_macros`` only documents that macro tokens are
    recognized (never flagged) — v1 does not use it to change
    behavior. ``sections`` are the loaded project's section headers
    (lowercased, e.g. 'fan_generic aux_fan'): pass them and mux commands
    are checked against the hardware the project actually declares;
    leave None when the loaded files cannot decide absence (unresolved
    include, no project) and no availability verdict is produced.
    """
    invocation_given = params is not None
    # Boundary coercion (review L8): callers range from config strings to
    # tool JSON. Coerce invocation maps to str->str (Klipper params are
    # always text) so int keys / None / nested containers can never raise
    # out of the public entry; a str(None)='None' value then produces an
    # honest unparseable finding instead of a crash.
    params = _coerce_str_map(params)
    variables = _coerce_str_map(variables)
    declared_defaults = _coerce_str_map(declared_defaults)
    key_items = tuple(sorted(params.items()))
    var_items = tuple(sorted(variables.items()))
    defaults_items = tuple(sorted(declared_defaults.items()))
    import json as _json
    state_serial = []
    for k, v in sorted((printer_state or {}).items(),
                       key=lambda kv: _state_path_key(kv[0])):
        path = _state_path_key(k)
        if not path:
            continue
        try:
            raw = _json.dumps(v)
        except (TypeError, ValueError):
            raw = repr(v)
        state_serial.append((path, raw))
    sections_items = None if sections is None else tuple(sorted(
        str(s).strip().lower() for s in sections if str(s).strip()))
    return _simulate_cached(body, key_items, max_variants, var_items,
                            tuple(state_serial), defaults_items,
                            invocation_given, sections_items)


# ── W3: runtime-error traceback (paste → Jinja source line) ────────────────
#
# A Klipper runtime error quotes the FULL rendered command line
# (klippy/gcode.py get(): "Error on '%s': ..." % self._commandline — all
# variants share the shape). The frame names no macro and no source line,
# so tracing it means: re-render candidate macros with the engine above
# and match the frame against rendered lines. The simulation only knows
# defaults, so any value it rendered UNKNOWN matches ANY runtime value in
# the frame; values it CAN render must agree (numeric-tolerant). Zero
# matches is a fine answer — this is a tracer, not an oracle.

_ERROR_ON_RE = re.compile(r"Error on '([^']*)'")
_FRAME_LINENO_RE = re.compile(r"^[Nn]\d+\s+")
_FRAME_CHECKSUM_RE = re.compile(r"\*\d+\s*$")
# Classic G-code letter params (Klipper's letter-parameter dispatch):
# X50 / F1500 / X-5 — a letter head and a numeric tail, no '='.
_LETTER_PARAM_RE = re.compile(r"^([A-Za-z]+)([-+.0-9].*)$")


def _normalize_frame(text: str) -> str:
    """Klipper quotes the raw serial line: an ``N123 `` prefix and a
    trailing ``*42`` checksum can ride along (gcode.py
    get_raw_command_parameters skips both). Normalize whitespace too —
    macro continuation lines arrive with arbitrary gaps."""
    t = text.strip()
    t = _FRAME_LINENO_RE.sub("", t)
    t = _FRAME_CHECKSUM_RE.sub("", t)
    return " ".join(t.split())


def extract_error_frames(text: str) -> list[str]:
    """Every ``Error on '<command line>'`` frame quoted in pasted text
    (tracebacks, console copies, klippy.log excerpts). Deterministic
    literal extraction — no prose guessing."""
    return [f for f in (_normalize_frame(m)
                        for m in _ERROR_ON_RE.findall(text)) if f]


@dataclass(frozen=True)
class MacroTraceSource:
    """One candidate macro to trace against. Callers order the list by
    confidence (staged macro first); matches come back in that order."""
    name: str
    body: str
    params: dict[str, str] | None = None
    variables: dict[str, str] | None = None
    file: str | None = None


@dataclass(frozen=True)
class TraceMatch:
    macro: str
    file: str | None
    source_line: int | None  # 1-indexed line within the macro BODY
    source_text: str         # that body line as written
    rendered: str            # the rendered line that matched the frame


def _frame_tokens(line: str) -> tuple[str, list[tuple[str, str]], list[str]]:
    """verb, [(KEY, value)], [bare tokens] — keys casefolded like
    Klipper's gcode dispatcher, values verbatim."""
    parts = line.split()
    if not parts:
        return "", [], []
    verb, rest = parts[0].casefold(), parts[1:]
    kvs, bare = [], []
    for tok in rest:
        key, sep, value = tok.partition("=")
        if sep and key:
            kvs.append((key.casefold(), value))
            continue
        m = _LETTER_PARAM_RE.match(tok)
        if m:
            kvs.append((m.group(1).casefold(), m.group(2)))
        else:
            bare.append(tok.casefold())
    return verb, kvs, bare


def _trace_values_match(rendered: str, runtime: str) -> bool:
    if _looks_unknown(rendered):
        return True  # sim can't know it; any runtime value is consistent
    if rendered.strip() == runtime.strip():
        return True
    try:
        return abs(float(rendered) - float(runtime)) < 1e-9
    except ValueError:
        return False


def _frame_matches_rendered(rendered_text: str, frame: str) -> bool:
    """True when ``frame`` is plausibly ``rendered_text`` after runtime
    values filled in: same verb, and every rendered parameter token has
    a distinct matching token in the frame. Frame-only extra tokens are
    fine (rendered variants cover one arm of the real invocation)."""
    r_verb, r_kvs, r_bare = _frame_tokens(rendered_text)
    f_verb, f_kvs, f_bare = _frame_tokens(frame)
    if r_verb != f_verb:
        return False
    for tok in r_bare:
        if tok in f_bare:
            f_bare.remove(tok)
        else:
            return False
    for key, value in r_kvs:
        hit = next((i for i, (k, v) in enumerate(f_kvs)
                    if k == key and _trace_values_match(value, v)), None)
        if hit is None:
            return False
        f_kvs.pop(hit)
    return True


def trace_runtime_error(frames: list[str],
                        sources: list[MacroTraceSource]) -> list[TraceMatch]:
    """Match pasted-error frames against every candidate macro's rendered
    invocations. All matches return, in caller order — several macros can
    render the same line, and which one was actually run is not knowable
    from the frame; the caller reports the ambiguity instead of guessing.
    """
    matches: list[TraceMatch] = []
    seen: set[tuple[str, int | None]] = set()
    if not frames:
        return matches
    for src in sources:
        result = simulate_macro(src.body, src.params,
                                variables=src.variables)
        body_lines = src.body.splitlines()
        for rline in result.rendered:
            for frame in frames:
                if not _frame_matches_rendered(rline.text, frame):
                    continue
                key = (src.name, rline.source_line)
                if key in seen:
                    break
                seen.add(key)
                lineno = rline.source_line
                text = (body_lines[lineno - 1].strip()
                        if lineno is not None and 0 < lineno <= len(body_lines)
                        else rline.text)
                matches.append(TraceMatch(macro=src.name, file=src.file,
                                          source_line=lineno,
                                          source_text=text,
                                          rendered=rline.text))
                break
    return matches
