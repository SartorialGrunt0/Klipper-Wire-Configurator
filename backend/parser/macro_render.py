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
import re
from dataclasses import dataclass, field, replace
from functools import lru_cache

import jinja2
from jinja2 import UndefinedError

# Cap on total branch renderings per macro (plan 2.1). Exotic branch
# counts degrade to macro_render_unexplored info instead of blowing up.
MAX_RENDER_VARIANTS = 16

# Markers identifying a rendered value as unknown-state (never a real
# coordinate): the UNKNOWN sentinel's string form and the NaN/inf it
# floats to (which propagate through arithmetic and |round without
# fabricating a value).
_UNKNOWN_MARKERS = ("<unknown>", "nan", "inf")

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
    r"|\[\s*['\"]([A-Za-z_][\w ]*)['\"]\s*)\s+(is not|is)\s+defined$",
    re.DOTALL)
_PARAMS_MEMBERSHIP_RE = re.compile(
    r"^['\"]([A-Za-z_][\w ]*)['\"]\s+in\s+params(?:\s*\|\s*upper\s*)?$",
    re.DOTALL)


def _static_param_presence(cond: str,
                           defined_params: frozenset[str]) -> bool | None:
    """Resolve a decidable param-presence condition, or None when the
    condition is not of that shape. `params.X is defined` (dot/bracket,
    is/is-not) and `'X' in params` (with the `|upper` membership idiom)
    answer exactly what Klipper answers for the invocation at hand."""
    c = cond.strip()
    m = _PARAM_IS_DEFINED_RE.match(c)
    if m:
        name = (m.group(1) or m.group(2)).lower()
        present = name in defined_params
        return present if m.group(3) == "is" else not present
    m = _PARAMS_MEMBERSHIP_RE.match(c)
    if m:
        return m.group(1).lower() in defined_params
    return None


def _cond_is_unknown(cond: str, defined_params: frozenset[str],
                     declared_state: frozenset[str] = frozenset()) -> bool:
    """Whether an if/elif condition depends on state the simulation does
    not know: printer paths not covered by the scenario's printer_state,
    a params key with no declared value, or the bare params object
    (membership/iteration beyond the decidable grammars, which are
    already spliced out by _splice_static_param_guards)."""
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
            if dotted.lower() not in defined_params:
                return True
        elif indexed is not None:
            if indexed.lower() not in defined_params:
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
                                defined_params: frozenset[str]) -> str:
    """Replace decidable param-presence conditions with literals BEFORE
    variant expansion (line-count preserving). Once collapsed, only
    genuinely unknown conditions drive both-arm expansion, and reads the
    guard excludes can never render on an arm Klipper would not run
    (the 2026-11-14 audit's FP class)."""
    out = src
    for _kw, cond, m in reversed(list(_iter_stmts(src))):
        if _kw not in ("if", "elif"):
            continue
        verdict = _static_param_presence(cond, defined_params)
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
                    printer_state: dict | None = None) -> dict:
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
        "rawparams": "",
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


def _render_one(env: jinja2.Environment, src: str, params: dict[str, str],
                variant: int,
                variables: dict[str, str] | None = None,
                printer_state: dict | None = None
                ) -> tuple[list[str], RenderFinding | None]:
    try:
        out = env.from_string(src).render(
            _render_context(params, variables, printer_state))
    except jinja2.TemplateSyntaxError:
        # Broken template: _validate_macro_jinja already reports it with
        # the engine's own message and the right code. The simulation
        # adds nothing here and must not crash the validation pass.
        return [], None
    except UndefinedError as exc:
        lineno = getattr(exc, "lineno", None) or _undefined_line(
            getattr(exc, "message", ""), src)
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
    except (TypeError, ValueError) as exc:
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
    v = value.strip().lower()
    return any(m in v for m in _UNKNOWN_MARKERS)


def _check_rendered_line(text: str, registry: dict, variant: int,
                         source_line: int | None = None) -> list[RenderFinding]:
    from services.gcode_registry import NON_COMMAND_TOKENS, _CMD_TOKEN_RE

    parts = text.split()
    if not parts:
        return []
    token = parts[0].upper()

    if token == "SET_GCODE_VARIABLE":
        return []  # every param is str; tracked by the caller

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
    # Klipper's own tokenizing (gcode.py): every token after the command
    # is a parameter — 'NAME=value' takes everything before '=' as the
    # key; traditional single-char args ('S100', and the EMPTY-valued
    # 'S' a bare template substitution renders) take the first char as
    # key and the rest as value. Last occurrence wins, like the params
    # dict. The old NAME=value-only regex silently skipped every
    # traditional-rendered param (M106 S100, M104 S...).
    present: dict[str, str] = {}
    for tok in text.split()[1:]:
        if "=" in tok:
            key, _, value = tok.partition("=")
            if key:
                present[key.upper()] = value
        else:
            present[tok[0].upper()] = tok[1:]
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
            if pdef.get("required") or pdef.get("type") in ("float", "int"):
                findings.append(RenderFinding(
                    "error", "macro_param_renders_empty",
                    f"Parameter {pname} renders EMPTY ('{pname}=') — "
                    f"{token} parses it as "
                    f"{pdef.get('type') or 'a required value'} and fails on "
                    "an empty string.", variant=variant))
            continue
        ptype = pdef.get("type")
        try:
            if ptype == "float":
                float(value)
            elif ptype == "int":
                int(value)
        except ValueError:
            findings.append(RenderFinding(
                "error", "macro_param_unparseable",
                f"Parameter {pname}={value!r} does not parse as "
                f"{ptype} that {token} expects.", variant=variant))
    return findings


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

def simulate_macro_uncached(body: str, params: dict[str, str] | None = None,
                            known_macros: frozenset[str] = frozenset(),
                            max_variants: int = MAX_RENDER_VARIANTS,
                            variables: dict[str, str] | None = None,
                            printer_state: dict | None = None
                            ) -> MacroRenderResult:
    from parser.validator import _MACRO_JINJA_ENV, _strip_inline_comments

    params = params or {}
    variables = variables or {}
    printer_state = printer_state or {}
    stripped = _strip_inline_comments(body)
    if not stripped.strip():
        return MacroRenderResult()
    if "{% raw" in stripped:
        # Raw blocks defeat the statement scanner; fail open for this
        # class only (rare in macro bodies).
        return MacroRenderResult()

    # 'name' is defined checks see the macro's own variables too
    # (they are context entries in Klipper), not just params.
    defined = frozenset(k.lower() for k in params) | frozenset(
        k.lower() for k in variables)
    # Scenario-declared dotted state paths: conditions whose printer
    # paths are covered evaluate NATIVELY (the value is known) — no arm
    # expansion for known shape.
    declared_state = frozenset(
        _state_path_key(k) for k in printer_state if _state_path_key(k))
    # Param-presence guards are deterministic for THIS invocation: splice
    # them to literals first so the guarded arms collapse exactly like
    # Klipper's branch selection (4R.1).
    stripped = _splice_static_param_guards(stripped, defined)
    variants, held = _expand_variants(stripped, defined, max_variants,
                                      declared_state)

    try:
        from services.gcode_registry import load_registry
        registry = load_registry()
    except (FileNotFoundError, ValueError):
        registry = {}  # missing/corrupt artifact: shape-free render only

    rendered: list[RenderedLine] = []
    findings: list[RenderFinding] = []
    for vi, variant_src in enumerate(variants):
        src_lines = variant_src.split("\n")
        lines, finding = _render_one(_MACRO_JINJA_ENV, variant_src, params,
                                     vi, variables, printer_state)
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
            for f in _check_rendered_line(text, registry, vi):
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
                     state_items: tuple[tuple[str, str], ...]
                     ) -> MacroRenderResult:
    # Scenario state values crossed the cache boundary as repr(): the
    # cache key must stay hashable while keeping value TYPE visible
    # (1 vs '1' must not share an entry).
    import json
    state = {}
    for path, raw in state_items:
        try:
            state[path] = json.loads(raw)
        except ValueError:
            state[path] = raw
    return simulate_macro_uncached(body, dict(params_items),
                                   frozenset(), max_variants,
                                   dict(variables_items), state)


def simulate_macro(body: str, params: dict[str, str] | None = None,
                   known_macros: frozenset[str] = frozenset(),
                   max_variants: int = MAX_RENDER_VARIANTS,
                   variables: dict[str, str] | None = None,
                   printer_state: dict | None = None
                   ) -> MacroRenderResult:
    """Simulate one macro body on an invocation.

    ``params`` are the invocation's parameters (the section's ``params_*``
    defaults on the harness path, scenario values on the tool path;
    lowercase keys recommended, lookups are case-insensitive like
    Klipper). ``variables`` are the section's own ``variable_*`` values
    (raw option strings; literal-evaluated like Klipper's config load) —
    top-level template names in every invocation, independent of params.
    ``printer_state`` (4R.3) overlays declared dotted paths
    (``{'toolhead.homed_axes': 'xyz'}``) onto the UNKNOWN sentinel: a
    declared value renders as a real value, everything else keeps
    widening. Results are cached by (body, params, variables,
    printer_state) — the simulation has no other project input in v1
    (macro calls are not recursed), so that quadruple IS the full cache
    key (cross-context isolation pinned by test). ``known_macros`` only
    documents that macro tokens are recognized (never flagged) — v1 does
    not use it to change behavior."""
    key_items = tuple(sorted((k.lower(), v) for k, v in (params or {}).items()))
    var_items = tuple(sorted((k.lower(), v) for k, v in
                             (variables or {}).items()))
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
    return _simulate_cached(body, key_items, max_variants, var_items,
                            tuple(state_serial))


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
