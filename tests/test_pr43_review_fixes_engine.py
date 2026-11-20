"""PR #43 review-round fixes, engine batch (F1/F2/F3/F4 + cache bound).

F1: the UNKNOWN sentinel ('<unknown>', NaN) must never be tokenized as a
    parameter value on traditional letter commands — a line that rendered
    any sentinel gets info macro_unknown_value, never a shape ERROR.
F2: int(UNKNOWN) no longer fabricates 1 — it raises, containing to an
    info macro_render_blocked, exactly like iteration/truth-test.
F3: loop budget replaces the bare-literal big-range regex: computed
    (10**9, set-bound) and nested ranges are contained before any
    materialization, never hanging validation.
F4 (static-decidability law, 4R D2): an error-severity sim finding is a
    blocking verdict only when it holds on EVERY simulated path; an error
    that fires on only a subset of variants lives under an unknown-state
    condition and downgrades to warning (stripped by is_sim_advisory).
"""
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from parser.macro_render import (  # noqa: E402
    is_sim_advisory, simulate_macro,
)


def _codes(result):
    return [f.code for f in result.findings]


def _findings(result, code):
    return [f for f in result.findings if f.code == code]


# ── F1: sentinel lines are info, never shape ERROR ─────────────────────────

def test_f1_letter_cmd_unknown_state_is_info_not_error():
    result = simulate_macro("M104 S{printer.extruder.target}")
    assert _codes(result) == ["macro_unknown_value"]
    assert result.findings[0].severity == "info"
    # unknown-state advisories are stripped at the human/delta boundary
    assert is_sim_advisory(result.findings[0].code, result.findings[0].severity)


def test_f1_letter_cmd_scaled_unknown_is_info():
    result = simulate_macro("M220 S{printer.gcode_move.speed_factor * 100}")
    assert "macro_param_unparseable" not in _codes(result)
    assert _findings(result, "macro_unknown_value")
    assert all(f.severity == "info" for f in _findings(result, "macro_unknown_value"))


def test_f1_g4_and_m106_unknown_states_are_info():
    for body in ("G4 P{printer.toolhead.max_velocity}",
                 "M106 S{printer.fan.speed * 255}"):
        result = simulate_macro(body)
        assert "macro_param_unparseable" not in _codes(result), body


def test_f1_absorbed_nan_stops_being_silent():
    # 'M104 Snan' (float(UNKNOWN)) used to absorb NAN into the letter run:
    # NO S param was seen and the check went silently missing. It must now
    # report the shape as unmeasured (info), not stay mute.
    result = simulate_macro("M104 S{printer.extruder.target|float}")
    assert "macro_param_unparseable" not in _codes(result)
    assert _findings(result, "macro_unknown_value"), _codes(result)


def test_f1_control_real_values_keep_real_verdicts():
    assert simulate_macro("M104 S200").findings == []
    bad = simulate_macro("M104 S=200")
    assert "macro_param_unparseable" in _codes(bad)
    # 'INFINITE' as free text on a message-style command is not a sentinel
    assert not any(f.severity == "error"
                   for f in simulate_macro("M117 INFINITE patience").findings)


# ── F2: int(UNKNOWN) raises (no fabricated digit) ──────────────────────────

def test_f2_int_of_unknown_state_no_fabricated_digit():
    result = simulate_macro("M104 S{printer.extruder.target|int}")
    assert not any(r.text == "M104 S1" for r in result.rendered)
    assert _findings(result, "macro_render_blocked")
    assert all(f.severity == "info" for f in _findings(result, "macro_render_blocked"))


def test_f2_int_in_message_no_fabricated_digit():
    result = simulate_macro("RESPOND MSG='t={printer.extruder.temperature|int}'")
    assert not any("t=1" in r.text for r in result.rendered)
    assert _findings(result, "macro_render_blocked")


def test_f2_declared_int_still_works():
    result = simulate_macro("M104 S{params.T|default(190)|int}")
    assert any(r.text == "M104 S190" for r in result.rendered)
    assert result.findings == []


# ── F3: loop budget contains computed and nested ranges ────────────────────

def test_f3_computed_huge_range_is_blocked_not_hanging():
    result = simulate_macro("{% for i in range(10**9) %}G1 X1\n{% endfor %}")
    assert _findings(result, "macro_render_blocked")
    assert not any(r.text.startswith("G1") for r in result.rendered)


def test_f3_set_bound_huge_range_is_blocked():
    body = "{% set n = 1000000 %}{% for i in range(n) %}M117 x\n{% endfor %}"
    result = simulate_macro(body)
    assert _findings(result, "macro_render_blocked")


def test_f3_nested_ranges_are_blocked():
    body = ("{% for i in range(300) %}{% for j in range(300) %}"
            "{% for k in range(300) %}M117 x\n{% endfor %}{% endfor %}"
            "{% endfor %}")
    result = simulate_macro(body)
    assert _findings(result, "macro_render_blocked")


def test_f3_literal_huge_range_still_blocked():
    result = simulate_macro("{% for i in range(1000000) %}M117 x\n{% endfor %}")
    assert _findings(result, "macro_render_blocked")


def test_f3_small_loops_unaffected():
    result = simulate_macro("{% for i in range(3) %}M117 x\n{% endfor %}")
    assert len(result.rendered) == 3
    assert result.findings == []


# ── F4: error severity ONLY on every simulated path ────────────────────────

def test_f4_unknown_gated_error_downgrades_to_warning():
    body = ('{% if printer.idle_timeout.state == "Printing" %}\n'
            "SET_LED LED=strips RED= GREEN=0 BLUE=0\n"
            "{% else %}\nM117\n{% endif %}")
    result = simulate_macro(body)
    empties = _findings(result, "macro_param_renders_empty")
    assert empties, "the defect must still be reported (tool surface)"
    assert all(f.severity == "warning" for f in empties)
    # boundary law: a warning sim finding never passes the human/delta filter
    for f in empties:
        assert is_sim_advisory(f.code, f.severity)


def test_f4_both_arms_broken_stays_error():
    body = ("{% if printer.x %}\nSET_LED LED=k RED=\n"
            "{% else %}\nSET_LED LED=k RED=\n{% endif %}")
    result = simulate_macro(body)
    empties = _findings(result, "macro_param_renders_empty")
    assert empties
    assert any(f.severity == "error" for f in empties)
    assert not all(is_sim_advisory(f.code, f.severity) for f in empties)


def test_f4_unconditional_error_outside_branch_stays_error():
    body = ('SET_LED LED=k RED=\n'
            '{% if printer.x %}\nM117 a\n{% else %}\nM117 b\n{% endif %}')
    result = simulate_macro(body)
    empties = _findings(result, "macro_param_renders_empty")
    assert empties and empties[0].severity == "error"


def test_f4_single_variant_untouched():
    # no unknown condition -> one path -> every-path trivially holds
    result = simulate_macro("SET_LED LED=k RED=")
    empties = _findings(result, "macro_param_renders_empty")
    assert empties and empties[0].severity == "error"


# ── cache bound: oversized renders are not retained ────────────────────────

def test_cache_skips_oversized_results():
    from parser import macro_render as mr
    tag = "cache-probe-9a7x"
    big_body = "{% for i in range(1500) %}M117 " + tag + "\n{% endfor %}"
    cache = getattr(mr, "_render_cache", None)
    assert cache is not None, "bounded manual cache expected"
    before = len(cache)
    simulate_macro(big_body)
    retained = any(
        any(isinstance(k, str) and tag in k for k in key)
        for key in cache)
    assert not retained, "results over the cache line bound must not be retained"
    simulate_macro("M117 " + tag + " small\n")
    assert len(cache) > before  # small result IS cached
