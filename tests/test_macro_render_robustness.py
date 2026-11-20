"""Review round-1 fixes, engine group (plan 2026-11-14_review-fixes-optionA G1).

Contract pinned here:

1. A rendered expression that RAISES at evaluation (division by zero,
   overflow, memory, recursion) must never escape simulate_macro or
   validate_config — one bad macro cannot break validation of every other
   section. Verdict: macro_render_blocked info + a log line.
   (Round-1 L1/S2: ZeroDivisionError escaped validate_config.)

2. Rendered lines are comment-stripped exactly like klippy executes them
   (gcode.py _process_commands: strip, cut at the FIRST ';'). Klipper's own
   shipped lulzbot sample (M140 S{...}; keep temperature) must NOT be
   flagged macro_param_unparseable.   (Round-1 L2.)

3. Extended (non-traditional) commands tokenize with shlex posix exactly
   like gcode.py _get_extended_params: quotes are stripped, so
   SET_LED LED="my led" is valid; unbalanced quotes are a REAL Malformed
   runtime failure (reported as an error, never a crash). Traditional
   letter-commands do NOT strip quotes (klippy has no shlex there):
   M106 S"100" fails float parsing in Klipper, so it fails here.
   (Round-1 L7.)

4. simulate_macro coerces invocation-mapping keys/values to str at the
   boundary — int keys and unhashable values (dict/list) must not raise
   AttributeError/TypeError out of the public entry.  (Round-1 L8.)
"""
import logging
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import pytest  # noqa: E402

from parser.config_parser import parse_config  # noqa: E402
from parser.macro_render import simulate_macro  # noqa: E402
from parser.validator import validate_config  # noqa: E402


def _codes(result):
    return [(f.severity, f.code) for f in result.findings]


# ── 1. exception containment ────────────────────────────────────────────────

def test_zero_division_becomes_blocked_info_not_crash():
    result = simulate_macro("M117 { 1 / 0 }")
    assert ("info", "macro_render_blocked") in _codes(result)


def test_overflow_error_contained():
    result = simulate_macro("M117 { 10.0 ** 10000 }")
    assert ("info", "macro_render_blocked") in _codes(result)


def test_memory_error_contained(monkeypatch):
    # Real 10**9 allocation would thrash the box for seconds; force the
    # failure mode deterministically at the seam instead.
    import jinja2

    def boom(*args, **kwargs):
        raise MemoryError("huge allocation")

    monkeypatch.setattr(jinja2.Environment, "from_string", boom)
    result = simulate_macro("M117 unique-memory-probe-9f31")
    assert ("info", "macro_render_blocked") in _codes(result)


def test_recursion_error_contained():
    deep = "{ " + "-" * 3000 + "1 }"
    result = simulate_macro(f"M117 {deep}")
    # Either it evaluates (jinja may constant-fold) or it is contained —
    # a raised RecursionError would fail this test by crashing it.
    assert result is not None


def test_validate_config_survives_zero_division_and_logs(caplog):
    cfg = (
        "[gcode_macro DOSE]\n"
        "variable_total: 0\n"
        "gcode:\n"
        "    RESPOND MSG={ 100 / total }\n"
    )
    with caplog.at_level(logging.WARNING):
        result = validate_config(parse_config(cfg))
    codes = [(e.severity, e.code) for e in result.errors]
    assert ("info", "macro_render_blocked") in codes
    # best-effort swallow must be diagnosable
    assert any("macro" in r.getMessage().lower() or
               "render" in r.getMessage().lower()
               for r in caplog.records), "blocked render must be logged"


def test_blocked_render_does_not_break_sibling_sections():
    cfg = (
        "[gcode_macro BAD]\n"
        "variable_total: 0\n"
        "gcode:\n"
        "    M117 { 100 / total }\n"
        "\n"
        "[gcode_macro GOOD]\n"
        "gcode:\n"
        "    SET_LED RED=\n"
    )
    result = validate_config(parse_config(cfg))
    codes = [(e.severity, e.code) for e in result.errors]
    assert ("info", "macro_render_blocked") in codes
    # the other section's real defect is still reported — the blocked
    # macro cannot poison the whole validation pass:
    assert ("error", "macro_param_renders_empty") in codes


# ── 2. ';' comment stripping (klippy parity) ───────────────────────────────

def test_semicolon_comment_never_reaches_param_parsing():
    result = simulate_macro("M140 S60; keep temp")
    assert not [f for f in result.findings
                if f.code == "macro_param_unparseable"]


def test_semicolon_no_space_form_clean():
    # lulzbot shipped form: S{t};keep temperature
    result = simulate_macro(
        "M140 S{params.TEMP};keep temperature", {"temp": "60"})
    assert not [f for f in result.findings
                if f.code in ("macro_param_unparseable",
                              "macro_param_renders_empty")]


def test_semicolon_pure_comment_line_clean():
    result = simulate_macro("; just a note")
    assert result.findings == []


def test_g1_advisory_survives_semicolon_strip():
    # 'G1 E5;go' must still warn (E w/o F), comment removal must not
    # silence the shape check.
    result = simulate_macro("G1 X10 E5;go")
    assert ("warning", "macro_rendered_g1_no_feedrate") in _codes(result)


# ── 3. shlex quotes on extended commands ───────────────────────────────────

def test_quoted_extended_value_parses_like_klipper():
    result = simulate_macro('SET_LED LED="my led" RED="0.5" GREEN=0 BLUE=0')
    assert not [f for f in result.findings
                if f.code == "macro_param_unparseable"]


def test_unbalanced_quote_is_error_not_crash():
    result = simulate_macro('SET_LED LED="my')
    errs = [f for f in result.findings if f.severity == "error"]
    assert errs, "unbalanced quotes = Klipper 'Malformed command' — error"


def test_traditional_command_keeps_quotes_literal():
    # klippy has no shlex for traditional commands: value '"100"' reaches
    # float() and fails at run time, so the engine must agree.
    result = simulate_macro('M106 S"100"')
    assert ("error", "macro_param_unparseable") in _codes(result)


# ── 4. boundary coercion ────────────────────────────────────────────────────

def test_nonstring_param_keys_and_values_never_raise():
    simulate_macro("M117 hi", {1: "x"})                      # int key
    simulate_macro("M117 hi", {"speed": {"x": 1}})           # dict value
    simulate_macro("M117 hi", {"nested": [1, 2]})            # list value
    result = simulate_macro("M106 S{params.speed}", {"speed": None})
    # None renders Klipper-visible as 'None' -> unparseable float, an
    # honest finding — but NEVER a crash.
    assert isinstance(result.findings, list)
