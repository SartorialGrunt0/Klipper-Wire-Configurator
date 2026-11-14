"""No-invocation semantics (plan G3 / review finding 3.1).

Without an invocation, "render the macro as Klipper would" has no fixed
answer: a `{params.X}` read renders empty ONLY on a bare invocation; a
caller may well pass X. Erroring on that (the old bare-invocation
default) fabricated the dev-server FP storm (Hotkey.cfg) and had to be
stripped from human surfaces as damage control.

New law, pinned here:
- No invocation info: reads with no declared value are PARAM-DEPENDENT —
  one info per name ('pass an invocation for a full verdict'), never an
  error/warning; guarded reads (|default) and guard-collapsed paths are
  checked fully; guards over undeclared names are NOT resolved to false
  (both arms explored, arm-true reads param-downgraded).
- Declared defaults (section params_*): present on EVERY Klipper
  invocation (they are the invocation defaults) — the empty-default
  field repro stays ERROR.
- Explicit invocation: full honesty for THAT invocation — a read the
  caller genuinely omits stays error/warning.
- Invented (non-params) undefined names abort in real Klipper on every
  invocation — they stay WARNING; the downgrade must not blind these.
"""
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from parser.config_parser import parse_config  # noqa: E402
from parser.macro_render import simulate_macro  # noqa: E402
from parser.validator import validate_config  # noqa: E402


def _codes(result):
    return [(f.severity, f.code) for f in result.findings]


def _texts(result):
    return [r.text for r in result.rendered]


# ── no invocation: param-dependent, never fabricated errors ────────────────

def test_unguarded_read_without_invocation_is_info_not_error():
    result = simulate_macro("M106 S{params.SPEED}")
    assert _texts(result) == ["M106 S"]  # preview of the bare shape
    assert ("error", "macro_param_renders_empty") not in _codes(result)
    assert ("warning", "macro_param_undefined") not in _codes(result)
    infos = [f for f in result.findings if f.severity == "info"
             and f.code == "macro_param_undefined"]
    assert len(infos) == 1
    assert "SPEED" in infos[0].message


def test_same_param_two_lines_reports_info_once():
    body = "M106 S{params.SPEED}\nM104 S{params.SPEED}"
    result = simulate_macro(body)
    assert len([f for f in result.findings
                if f.code == "macro_param_undefined"]) == 1


def test_numeric_filter_abort_downgraded_when_invocation_unknown():
    # {params.FOO|int} aborts ONLY on invocations without FOO; with the
    # Klipper wording preserved but param-dependent severity.
    result = simulate_macro("M117 {params.FOO|int}")
    undef = [f for f in result.findings
             if f.code == "macro_param_undefined"]
    assert len(undef) == 1
    assert undef[0].severity == "info"
    assert "FOO" in undef[0].message


def test_guarded_default_read_without_invocation_fully_clean():
    # |default(...) makes EVERY invocation succeed — nothing to caveat.
    body = ("SET_LED LED=bed RED={params.BRIGHTNESS|default(1)*0.5} "
            "GREEN=0 BLUE=0")
    result = simulate_macro(body)
    assert result.findings == []


def test_membership_guard_not_resolved_false_without_invocation():
    body = ("{% if 'X' in params %}\nM106 S{params.X}\n"
            "{% else %}\nM106 S128\n{% endif %}\n")
    result = simulate_macro(body)
    # both arms are possible invocations; the X-arm reads are
    # param-dependent (info), the else-arm renders fully checked
    assert "M106 S128" in _texts(result)
    assert not [f for f in result.findings
                if f.severity in ("error", "warning")]
    assert ("info", "macro_param_undefined") in _codes(result)


def test_param_independent_line_still_checked_without_invocation():
    # a param-FREE empty literal stays a real error on every path
    body = "M104 S\nM106 S{params.SPEED}"
    result = simulate_macro(body)
    assert ("error", "macro_param_renders_empty") in _codes(result)
    assert ("info", "macro_param_undefined") in _codes(result)


# ── invented names: every invocation aborts — stay WARNING ─────────────────

def test_invented_name_abort_stays_warning():
    result = simulate_macro("{% set v = not_a_klipper_name|int %}M117 {v}")
    undef = [f for f in result.findings
             if f.code == "macro_param_undefined"]
    assert len(undef) == 1
    assert undef[0].severity == "warning"


# ── explicit invocation: full honesty for that invocation ──────────────────

def test_explicit_invocation_missing_param_keeps_error():
    # caller declared the invocation (and X is NOT in it): Klipper's
    # float('') failure for THAT call is an honest error.
    result = simulate_macro("M106 S{params.X}", {"other": "1"})
    assert ("error", "macro_param_renders_empty") in _codes(result)


# ── declared defaults: always present, always checked fully ────────────────

def test_declared_default_flows_into_render():
    body = "M106 S{params.SPEED}"
    result = simulate_macro(body, declared_defaults={"speed": "200"})
    assert _texts(result) == ["M106 S200"]
    assert result.findings == []


def test_declared_default_empty_stays_error():
    body = "M106 S{params.SPEED}"
    result = simulate_macro(body, declared_defaults={"speed": ""})
    assert ("error", "macro_param_renders_empty") in _codes(result)


def test_invocation_overrides_declared_default():
    body = "M106 S{params.SPEED}"
    result = simulate_macro(body, {"speed": "20"},
                            declared_defaults={"speed": "200"})
    assert _texts(result) == ["M106 S20"]


def test_declared_default_resolves_membership_guard():
    body = ("{% if 'X' in params %}M106 S{params.X}{% else %}M106 S128"
            "{% endif %}")
    result = simulate_macro(body, declared_defaults={"x": "200"})
    assert _texts(result) == ["M106 S200"]
    assert result.findings == []


def test_validator_declares_defaults_not_invocation():
    # the validator path end-to-end: declared empty default -> ERROR
    # (field repro, Option A); undeclared read -> param-dependent info
    # only, no error/warning.
    cfg = (
        "[gcode_macro REPRO]\n"
        "params_RED:\n"
        "gcode:\n"
        "    SET_LED LED=strip RED={params.RED} GREEN=0 BLUE=0\n"
        "\n"
        "[gcode_macro OPEN]\n"
        "gcode:\n"
        "    M106 S{params.SPEED}\n"
    )
    res = validate_config(parse_config(cfg))
    sim = [e for e in res.errors if e.severity == "error" and e.code and
           e.code.startswith("macro_")]
    assert [e.code for e in sim] == ["macro_param_renders_empty"]
    assert [e.section for e in sim] == ["gcode_macro REPRO"]
    open_infos = [e for e in res.errors if e.section == "gcode_macro OPEN"
                  and e.severity == "info"
                  and e.code == "macro_param_undefined"]
    assert len(open_infos) == 1
