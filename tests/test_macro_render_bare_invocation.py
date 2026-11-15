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


# ── aliased param reads (dev-server dogfood 2026-11-14, Hotkey.cfg class) ──
#
# The per-line param-dependence check saw only DIRECT params.X reads on
# the rendered line. The Hotkey.cfg family hides the read behind
# `{% set led = params.LED|string %}` (and behind a for-loop over a
# stringified param), so the Undefined-coerced EMPTY landed on a
# different source line and was misclassified as a STATIC error. The
# fix resolves the line's template expressions THROUGH the alias chains
# to the underlying param before deciding.

def test_set_alias_empty_value_is_param_dependent():
    body = ("    {% set led = params.LED|string %}\n"
            "    SET_LED LED={led} RED=1 GREEN=0 BLUE=0\n")
    r = simulate_macro(body, declared_defaults={})
    assert not [f for f in r.findings if f.severity == "error"], \
        [f.message for f in r.findings if f.severity == "error"]
    assert any(f.code == "macro_param_undefined" and "LED" in f.message
               for f in r.findings)


def test_for_loop_alias_index_is_param_dependent():
    body = ("    {% set idx = (params.IDX|string).split(',') %}\n"
            "    {% for i in idx %}\n"
            "    SET_LED LED=x INDEX={i} RED=0 GREEN=0 BLUE=0\n"
            "    {% endfor %}\n")
    r = simulate_macro(body, declared_defaults={})
    assert not [f for f in r.findings if f.severity == "error"], \
        [f.message for f in r.findings if f.severity == "error"]
    assert any(f.code == "macro_param_undefined" for f in r.findings)


def test_declared_empty_default_through_alias_stays_error():
    # the STATIC class must survive aliasing too: params_RED declared
    # EMPTY rides every invocation regardless of how the body aliases it
    body = ("    {% set r = params.RED %}\n"
            "    SET_LED LED=strip RED={r} GREEN=0 BLUE=0\n")
    r = simulate_macro(body, declared_defaults={"red": ""})
    errs = [f for f in r.findings
            if f.severity == "error" and f.code == "macro_param_renders_empty"]
    assert len(errs) == 1, [f.message for f in r.findings]


def test_invocation_through_alias_still_verdicts():
    # an explicit invocation that OMITS LED genuinely fails — with
    # invocation_given the alias class keeps full severity
    body = ("    {% set led = params.LED|string %}\n"
            "    SET_LED LED={led} RED=1 GREEN=0 BLUE=0\n")
    r = simulate_macro(body, params={}, declared_defaults={})
    assert any(f.severity == "error"
               and f.code == "macro_param_renders_empty"
               for f in r.findings), [f.message for f in r.findings]


def test_defaulted_alias_never_adds_dependency():
    # params.TRANSMIT|default(1) is decided without any invocation — the
    # alias must not param-dependency-shield defects on its lines
    body = ("    {% set t = params.TRANSMIT|default(1) %}\n"
            "    SET_LED LED=x TRANSMIT={t} RED=1 GREEN=0 BLUE=0\n")
    r = simulate_macro(body, declared_defaults={})
    assert r.findings == [], [f.message for f in r.findings]


# ── round-2 D1: suppression is PER FINDING, never per line ────────────────

def test_literal_empty_survives_param_dependent_line():
    # 'RED=' is a literal defect — true under EVERY invocation — even
    # though the same line reads an undeclared param.
    body = "    SET_LED LED={params.LED} RED= GREEN=0 BLUE=0\n"
    r = simulate_macro(body, declared_defaults={})
    errs = [f for f in r.findings
            if f.severity == "error" and f.code == "macro_param_renders_empty"]
    assert len(errs) == 1 and "RED" in errs[0].message, \
        [f.message for f in r.findings]
    assert any(f.code == "macro_param_undefined" for f in r.findings)


def test_declared_empty_default_survives_other_param_dependency():
    # params_RED declared empty = static ERROR; GREEN reads an undeclared
    # param on the same line = param-dependent. Both verdicts coexist.
    body = "    SET_LED LED=x RED={params.RED} GREEN={params.OTHER}\n"
    r = simulate_macro(body, declared_defaults={"red": ""})
    errs = [f for f in r.findings
            if f.severity == "error" and f.code == "macro_param_renders_empty"]
    assert len(errs) == 1 and "RED" in errs[0].message, \
        [f.message for f in r.findings]


def test_alias_form_keeps_static_defect_next_to_dependency():
    body = ("    {% set r = params.RED %}\n"
            "    {% set o = params.OTHER %}\n"
            "    SET_LED LED=x RED={r} GREEN={o} BLUE=0\n")
    r = simulate_macro(body, declared_defaults={"red": ""})
    errs = [f for f in r.findings
            if f.severity == "error" and f.code == "macro_param_renders_empty"]
    assert len(errs) == 1 and "RED" in errs[0].message, \
        [f.message for f in r.findings]


def test_mixed_line_reaches_the_human_save_gate():
    # End-to-end: the static half must survive validate_config AND the
    # human-facing boundary (D1 was invisible there before the fix).
    cfg = ("[gcode_macro MIX]\n"
           "gcode:\n"
           "    SET_LED LED={params.LED} RED= GREEN=0 BLUE=0\n")
    res = validate_config(parse_config(cfg))
    human = res.human_to_dict()
    errs = [e for e in (human.get("errors") or [])
            if e.get("code") == "macro_param_renders_empty"]
    assert errs and "RED" in errs[0]["message"], human


# ── {rawparams}: unknown ARITY is param-dependency, not absence ────────────
# Klipper's own eddy samples pass parameters through with `{rawparams}`.
# Without an invocation the splat is undecidable exactly like an undeclared
# `{params.X}` read: absence from the template is not absence at run time.
# Treating the empty render as a bare call fabricated a save-gate ERROR
# ("missing required parameter CHIP") on Klipper's shipped sample configs.

def test_rawparams_splat_does_not_fabricate_missing_required():
    result = simulate_macro("PROBE_EDDY_CURRENT_CALIBRATE {rawparams}")
    assert ("error", "macro_param_renders_empty") not in _codes(result), \
        [f.message for f in result.findings]
    infos = [f for f in result.findings
             if f.severity == "info" and f.code == "macro_param_undefined"]
    assert len(infos) == 1 and "rawparams" in infos[0].message, \
        [f.message for f in result.findings]


def test_rawparams_splat_with_invocation_is_fully_verified():
    # A declared invocation decides the splat — the check must come back.
    ok = simulate_macro("PROBE_EDDY_CURRENT_CALIBRATE {rawparams}",
                        {"CHIP": "btt_eddy"})
    assert _texts(ok) == ["PROBE_EDDY_CURRENT_CALIBRATE CHIP=btt_eddy"]
    assert ("error", "macro_param_renders_empty") not in _codes(ok)

    # A genuinely BARE call (explicit {}) really does fail in Klipper.
    bare = simulate_macro("PROBE_EDDY_CURRENT_CALIBRATE {rawparams}", {})
    assert ("error", "macro_param_renders_empty") in _codes(bare), \
        [f.message for f in bare.findings]


def test_locally_assigned_rawparams_is_not_treated_as_unknown():
    # `{% set rawparams = ... %}` shadows the caller's splat: the render is
    # decided, so the required-param verdict stands (and here it passes).
    body = ('    {% set rawparams = "CHIP=btt_eddy" %}\n'
            '    PROBE_EDDY_CURRENT_CALIBRATE {rawparams}\n')
    result = simulate_macro(body)
    assert _texts(result) == ["PROBE_EDDY_CURRENT_CALIBRATE CHIP=btt_eddy"], \
        _texts(result)
    assert ("error", "macro_param_renders_empty") not in _codes(result), \
        [f.message for f in result.findings]


def test_literal_defect_on_a_splat_line_still_reports():
    # Suppression is per FINDING: a literal illegal value sharing the line
    # with the splat is still decidable and must not be swallowed.
    result = simulate_macro("RESPOND {rawparams} TYPE=info")
    assert ("error", "macro_param_enum_invalid") in _codes(result), \
        [f.message for f in result.findings]


def test_rawparams_value_with_spaces_does_not_fabricate_a_malformed_line():
    # A quoted invocation value must round-trip through the splat: an
    # unquoted `MSG=hello world` would split and read as a bare argument.
    result = simulate_macro("RESPOND {rawparams}",
                            {"MSG": "hello world"})
    assert _texts(result) == ['RESPOND MSG="hello world"'], _texts(result)
    assert ("error", "macro_param_unparseable") not in _codes(result), \
        [f.message for f in result.findings]


def test_rawparams_false_error_is_gone_from_the_shipped_eddy_sample():
    # End-to-end on Klipper's own config: the human save gate must stay quiet.
    sample = (Path(__file__).resolve().parents[1] / "reference" / "config"
              / "Probe" / "sample-bigtreetech-eddy.cfg")
    if not sample.exists():
        import pytest
        pytest.skip("Klipper reference checkout not present")
    res = validate_config(parse_config(sample.read_text()))
    human = res.human_to_dict()
    errs = [e for e in (human.get("errors") or [])
            if "missing required parameter CHIP" in str(e.get("message"))]
    assert not errs, errs

