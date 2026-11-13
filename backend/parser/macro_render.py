"""W2 render simulator: render a macro body the way Klipper would on a
default invocation, then validate the RENDERED commands (feature
macro-jinja-reliability).

The honest definition of "simulate" (plan 2026-11-12, W2):

  * Jinja that COMPILES can still EXPAND to garbage — the field repro is a
    toggle macro whose ``SET_LED ... RED={params.red}`` renders
    ``RED=`` (empty) and Klipper answers "unable to parse" at runtime.
    Compile-time checks (validator + validate_macro) can never see this.
  * So we render, deterministically, on KNOWN SHAPE ONLY: ``printer`` and
    ``caller_data`` are an UNKNOWN sentinel (any access yields UNKNOWN;
    stringifies as ``<unknown>``, floats as NaN — never a guessed value),
    ``params`` is the section's ``params_*`` defaults with Klipper's
    Undefined semantics (unset raises, ``|default(...)`` works).
  * Unknown-dependent ``{% if %}``/``{% elif %}`` conditions render BOTH
    arms (a condition referencing printer/caller state, or a params key
    with no default, is unknown-dependent; deterministic conditions
    render the real branch). Variant count is capped at
    ``MAX_RENDER_VARIANTS``; over-cap paths surface as
    ``macro_render_unexplored`` info — never silently dropped.
  * Rendered lines are checked against the gcode registry (schema v2):
    required params present AND non-empty (``macro_param_renders_empty``),
    typed params parseable (``macro_param_unparseable``), UNKNOWN/NaN
    values = ``macro_unknown_value`` info (never an error — we never
    claim to know runtime values), plus the G1-extrusion-without-feedrate
    advisory applied POST-render so templated values can't hide it.
  * Other macros are recognized via the caller-supplied project set and
    never recursed (v1 limit). ``SET_GCODE_VARIABLE`` targets are tracked
    as (MACRO, VARIABLE) string pairs, not simulated state.

The engine shares Klipper's jinja environment with the save gate
(``validator._MACRO_JINJA_ENV`` — imported lazily inside the entry point
so validator can import this module top-level for the validation pass
without a circular import) and the same comment stripping
(``_strip_inline_comments``).

Finding severities: errors ONLY on every-path deterministic breakage of
the rendered shape (empty required/typed param, unparseable typed value);
unknown-state dependencies and simulation blind spots are info; a render
that dies on Klipper's Undefined (unset param with no default) is a
warning — it aborts the DEFAULT invocation, but a caller passing the
param makes it legal.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from functools import lru_cache

import jinja2
from jinja2 import StrictUndefined, UndefinedError

# Cap on total branch renderings per macro (plan 2.1). Exotic branch
# counts degrade to macro_render_unexplored info instead of blowing up.
MAX_RENDER_VARIANTS = 16

# Markers identifying a rendered value as unknown-state (never a real
# coordinate): the UNKNOWN sentinel's string form and the NaN/inf it
# floats to (which propagate through arithmetic and |round without
# fabricating a value).
_UNKNOWN_MARKERS = ("<unknown>", "nan", "inf")


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


class _Params(dict):
    """Klipper-shaped params: keys lowercase (gcode.py lowercases command
    tokens before building params); an unset key raises through jinja's
    Undefined machinery, so ``|default(...)`` works and bare
    ``{params.FOO}`` aborts like Klipper's Undefined."""

    def __missing__(self, key):
        lowered = key.lower()
        if lowered in self:
            return self[lowered]
        raise KeyError(key)


# ── unknown-dependence classification ──────────────────────────────────────

_STATE_ROOT_RE = re.compile(r"(?<![\w.])(printer|caller_data)\b")
_PARAMS_REF_RE = re.compile(
    r"(?<![\w.])params(?:\s*\.\s*([A-Za-z_]\w*)|\[\s*['\"]([^'\"]+)['\"]\s*\]"
    r"|(?!\s*[.\[]))"
)


def _cond_is_unknown(cond: str, defined_params: frozenset[str]) -> bool:
    """Whether an if/elif condition depends on state the simulator does
    not know: printer/caller roots, a params key with no section default,
    or the bare params object (membership/iteration)."""
    if _STATE_ROOT_RE.search(cond):
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


def _first_unknown_stmt(src: str, defined: frozenset[str]) -> re.Match | None:
    for m in _STMT_RE.finditer(src):
        inner = m.group(0)
        kw_m = _STMT_KW_RE.match(inner)
        if not kw_m or kw_m.group(1) not in ("if", "elif"):
            continue
        cond = re.sub(r"^\{%-?\s*(?:if|elif)\s+", "", inner)
        cond = re.sub(r"-%?\}$", "", cond)
        if _cond_is_unknown(cond, defined):
            return m
    return None


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
                     cap: int) -> tuple[list[str], int]:
    """Deterministic bounded DFS over unknown decisions, TRUE arm first.
    Returns (variants, held) where 'held' counts variants abandoned
    because the cap was reached with decisions still unforced."""
    variants = [src]
    while True:
        idx = next(
            (i for i, v in enumerate(variants)
             if _first_unknown_stmt(v, defined) is not None),
            None,
        )
        if idx is None:
            return variants, 0
        if len(variants) + 1 > cap:
            held = sum(1 for v in variants
                       if _first_unknown_stmt(v, defined) is not None)
            return variants, held
        stmt = _first_unknown_stmt(variants[idx], defined)
        variants[idx:idx + 1] = [
            _splice(variants[idx], stmt, "1"),
            _splice(variants[idx], stmt, "0"),
        ]


# ── per-variant rendering ──────────────────────────────────────────────────

def _noop_respond(msg="", **kwargs): return ""


_STRICT_ENV: jinja2.Environment | None = None


def _strict_env() -> jinja2.Environment:
    """Klipper-parity STRICT env: derived from the validator's shared
    _MACRO_JINJA_ENV by overlay — delimiters and every other config are
    identical, only 'undefined' is overridden. Rationale: Klipper's
    KlipperUndefined aborts the render when a value is used
    ('Jinja2 error: ... is undefined'), while jinja's default Undefined
    renders silently as ''. The per-render render(undefined=...) kwarg
    does NOT exist (the kwarg would land in the context as a variable
    named 'undefined' — probe-verified), so the overlay is the only
    parity-correct way to get the abort."""
    global _STRICT_ENV
    if _STRICT_ENV is None:
        from parser.validator import _MACRO_JINJA_ENV
        _STRICT_ENV = _MACRO_JINJA_ENV.overlay(undefined=StrictUndefined)
    return _STRICT_ENV


def _render_context(params: dict[str, str]) -> dict:
    # Klipper's create_render_context: printer, params, caller_data,
    # rawparams, action_respond (klippy/extras/gcode_macro.py).
    return {
        "printer": UNKNOWN,
        "params": _Params({k.lower(): v for k, v in params.items()}),
        "caller_data": UNKNOWN,
        "rawparams": "",
        "action_respond": _noop_respond,
    }


def _macro_globals() -> dict:
    """Klipper's gcode_macro template globals (assign_template /
    printer / call). v1: 'call' widens to UNKNOWN rather than
    re-entering the engine (no recursion — documented limit)."""
    return {
        "assign_template": lambda *a, **k: "",
        "printer": UNKNOWN,
        "call": lambda *a, **k: UNKNOWN,
    }


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
                variant: int) -> tuple[list[str], RenderFinding | None]:
    try:
        out = env.from_string(src, globals=_macro_globals()).render(
            _render_context(params))
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
            "the DEFAULT invocation (no arguments) fails; callers must pass "
            "the parameter or the macro needs a |default(...).",
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
                "warning", "g1_extrude_no_feedrate",
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
    present = {m.group(1).upper(): m.group(2)
               for m in _PARAM_TOKEN_RE.finditer(text)}
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
                            max_variants: int = MAX_RENDER_VARIANTS
                            ) -> MacroRenderResult:
    from parser.validator import _MACRO_JINJA_ENV, _strip_inline_comments

    params = params or {}
    stripped = _strip_inline_comments(body)
    if not stripped.strip():
        return MacroRenderResult()
    if "{% raw" in stripped:
        # Raw blocks defeat the statement scanner; fail open for this
        # class only (rare in macro bodies).
        return MacroRenderResult()

    defined = frozenset(k.lower() for k in params)
    variants, held = _expand_variants(stripped, defined, max_variants)

    try:
        from services.gcode_registry import load_registry
        registry = load_registry()
    except (FileNotFoundError, ValueError):
        registry = {}  # missing/corrupt artifact: shape-free render only

    rendered: list[RenderedLine] = []
    findings: list[RenderFinding] = []
    for vi, variant_src in enumerate(variants):
        src_lines = variant_src.split("\n")
        lines, finding = _render_one(_strict_env(), variant_src, params, vi)
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
                     max_variants: int) -> MacroRenderResult:
    return simulate_macro_uncached(body, dict(params_items),
                                   frozenset(), max_variants)


def simulate_macro(body: str, params: dict[str, str] | None = None,
                   known_macros: frozenset[str] = frozenset(),
                   max_variants: int = MAX_RENDER_VARIANTS) -> MacroRenderResult:
    """Simulate one macro body on default invocation parameters.

    ``params`` are the section's ``params_*`` defaults (lowercase keys
    recommended; lookups are case-insensitive like Klipper). Results are
    cached by (body, params) — the simulation has no other project
    input in v1 (macro calls are not recursed), so body+params IS the
    full cache key. ``known_macros`` only documents that macro tokens
    are recognized (never flagged) — v1 does not use it to change
    behavior."""
    key_items = tuple(sorted((k.lower(), v) for k, v in (params or {}).items()))
    return _simulate_cached(body, key_items, max_variants)
