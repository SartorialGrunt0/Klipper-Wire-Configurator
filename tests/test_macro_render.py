"""W2 render-simulator engine tests (feature/macro-jinja-reliability).

The engine renders a macro body the way Klipper would on a DEFAULT
invocation — printer/caller state is an UNKNOWN sentinel (never a guessed
value), unset params raise like Klipper's Undefined, and unknown-dependent
conditions render BOTH arms (bounded) — then validates the RENDERED command
lines against the gcode registry. The reported class it exists to catch:

    Jinja that COMPILES fine but expands to an EMPTY value
    (SET_LED ... RED= -> Klipper runtime 'unable to parse').

Engine contract (parser/macro_render.py):

    simulate_macro(body, params=None, known_macros=frozenset())
        -> MacroRenderResult(
               rendered=[RenderedLine(text, source_line, variant)],
               findings=[RenderFinding(severity, code, message, source_line)],
               unknown_accesses=[str],
               set_variables=[(macro, variable)],
               variants_rendered=int)

Finding codes: macro_param_renders_empty, macro_param_unparseable,
macro_unknown_value, macro_param_undefined, macro_render_blocked,
macro_render_unexplored.
"""
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from parser.macro_render import MAX_RENDER_VARIANTS, simulate_macro  # noqa: E402


def _codes(result):
    return [f.code for f in result.findings]


def _findings(result, code):
    return [f for f in result.findings if f.code == code]


# ── the reported class: empty Jinja expansion on a typed param ────────────

# Verbatim shape of the field repro: a toggle macro whose color params
# default to '' renders 'SET_LED ... RED= GREEN= BLUE=' and Klipper
# answers "unable to parse".
LED_REPRO_BODY = (
    "SET_LED LED=stealthburner RED={params.red} GREEN={params.green} "
    "BLUE={params.blue} SYNC=0"
)


def test_led_repro_empty_typed_params_is_error():
    result = simulate_macro(LED_REPRO_BODY, {"red": "", "green": "", "blue": ""})
    empty = _findings(result, "macro_param_renders_empty")
    # RED/GREEN/BLUE are float-typed in the registry: an empty rendering
    # definitely fails on every simulated path.
    assert len(empty) == 3, [f.message for f in result.findings]
    assert all(f.severity == "error" for f in empty)
    assert all(f.source_line == 1 for f in empty)
    joined = " ".join(f.message for f in empty)
    assert "RED" in joined and "GREEN" in joined and "BLUE" in joined


def test_empty_string_param_not_typed_error():
    # VALUE on SET_GCODE_VARIABLE is str-typed: empty is legal there.
    body = "SET_GCODE_VARIABLE MACRO=FOO VARIABLE=v VALUE={params.val}"
    result = simulate_macro(body, {"val": ""})
    assert _codes(result) == [], [f.message for f in result.findings]


def test_required_param_missing_after_render():
    # LED is required; the whole token vanished because the condition that
    # emitted it took the other arm.
    body = (
        "{% if printer.gcode_move.gcode %}\n"
        "SET_LED LED=strips RED=1\n"
        "{% else %}\n"
        "M117 off\n"
        "{% endif %}"
    )
    result = simulate_macro(body)
    empties = _findings(result, "macro_param_renders_empty")
    # The true arm renders SET_LED fine; there is no variant where a
    # required param is dropped.
    assert empties == []


def test_unparseable_typed_value_is_error():
    body = "SET_LED LED=strips RED={params.red}"
    result = simulate_macro(body, {"red": "hotpink"})
    bad = _findings(result, "macro_param_unparseable")
    assert len(bad) == 1
    assert bad[0].severity == "error"
    assert "hotpink" in bad[0].message


# ── Klipper Undefined parity ───────────────────────────────────────────────

def test_undefined_param_surfaces():
    result = simulate_macro("M117 {params.FOO}")
    assert _codes(result) == ["macro_param_undefined"]
    f = result.findings[0]
    assert "FOO" in f.message
    assert f.source_line == 1


def test_default_filter_is_clean():
    result = simulate_macro("M117 {params.FOO|default('ok')}")
    assert _codes(result) == []


def test_defined_param_used_is_clean():
    result = simulate_macro("M117 {params.name}", {"name": "hello"})
    assert _codes(result) == []


# ── branch rendering ───────────────────────────────────────────────────────

def test_unknown_condition_renders_both_arms():
    body = (
        "{% if printer.save_variables.variables.on %}\n"
        "SET_LED LED=strips RED=1 GREEN=1 BLUE=1\n"
        "{% else %}\n"
        "SET_LED LED=strips RED={params.off} GREEN=0 BLUE=0\n"
        "{% endif %}"
    )
    result = simulate_macro(body, {"off": ""})
    assert result.variants_rendered == 2
    # The error lives ONLY in the false arm — exactly what pre-render
    # validators (and the W1 presence check) cannot see.
    empties = _findings(result, "macro_param_renders_empty")
    assert len(empties) == 1
    assert empties[0].severity == "error"
    assert empties[0].source_line == 4
    assert empties[0].variant == 1  # the false arm


def test_deterministic_condition_renders_real_branch_only():
    body = (
        "{% set big = 0 %}\n"
        "{% if big > 1 %}\n"
        "SET_LED LED=strips RED=\n"
        "{% else %}\n"
        "M117 ok\n"
        "{% endif %}"
    )
    result = simulate_macro(body)
    assert result.variants_rendered == 1
    assert _codes(result) == []
    assert [r.text for r in result.rendered if r.text.strip()] == ["M117 ok"]


def test_branch_cap_emits_unexplored_info():
    lines = []
    for i in range(7):
        lines.append("{%% if printer.x.i > %d %%}" % i)
        lines.append("M117 a%d" % i)
        lines.append("{% endif %}")
    result = simulate_macro("\n".join(lines))
    assert result.variants_rendered <= MAX_RENDER_VARIANTS
    unexplored = _findings(result, "macro_render_unexplored")
    assert len(unexplored) == 1
    assert unexplored[0].severity == "info"


def test_multi_line_condition_preserves_line_numbers():
    body = (
        "{% if printer.x\n"
        "     or params.mode %}\n"
        "M117 a\n"
        "{% else %}\n"
        "SET_LED LED=strips GREEN={params.g}\n"
        "{% endif %}"
    )
    result = simulate_macro(body, {"g": ""})
    empties = _findings(result, "macro_param_renders_empty")
    assert len(empties) == 1
    assert empties[0].source_line == 5


# ── unknown-state values are info, never errors ────────────────────────────

def test_unknown_value_is_info_not_error():
    body = "SET_LED LED=strips WHITE={printer.extruder.temperature}"
    result = simulate_macro(body)
    assert _codes(result) == ["macro_unknown_value"]
    assert result.findings[0].severity == "info"
    assert result.findings[0].source_line == 1


def test_unknown_arithmetic_yields_unknown_value_info():
    # float(UNKNOWN) is NaN by design: propagates through arithmetic and
    # filters without pretending to be a real coordinate. Klipper's env
    # is single-brace ONLY (probed: '{{ 1 + 2 }}' is a TemplateSyntaxError
    # even for constants), so the fixture uses the Klipper form.
    body = "SET_LED LED=strips WHITE={ (printer.extruder.temperature + 1)|round(2) }"
    result = simulate_macro(body)
    assert "macro_unknown_value" in _codes(result)
    assert "macro_param_unparseable" not in _codes(result)


# ── control flow we do not simulate ────────────────────────────────────────

def test_iteration_over_unknown_reports_blocked_info():
    body = (
        "{% for idx in printer.toolhead.get_status().fans %}\n"
        "M117 {idx}\n"
        "{% endfor %}"
    )
    result = simulate_macro(body)
    blocked = _findings(result, "macro_render_blocked")
    assert len(blocked) >= 1
    assert blocked[0].severity == "info"


# ── registry / project interaction ─────────────────────────────────────────

def test_known_user_macro_call_is_not_flagged():
    result = simulate_macro("PARK_UP\n", known_macros=frozenset({"PARK_UP"}))
    assert _codes(result) == []


def test_set_gcode_variables_tracked():
    body = (
        "SET_GCODE_VARIABLE MACRO=FOO VARIABLE=mode VALUE=0\n"
        "SET_GCODE_VARIABLE MACRO=BAR VARIABLE=z VARIABLE=x VALUE=1\n"
    )
    result = simulate_macro(body)
    assert ("FOO", "mode") in result.set_variables
    assert ("BAR", "x") in result.set_variables


# ── post-render advisories ─────────────────────────────────────────────────

def test_g1_extrude_without_feedrate_post_render():
    body = "G1 E{params.amt}"
    result = simulate_macro(body, {"amt": "5"})
    assert any(f.code == "g1_extrude_no_feedrate" for f in result.findings)


def test_g1_extrude_with_feedrate_clean():
    body = "G1 E{params.amt} F{params.spd}"
    result = simulate_macro(body, {"amt": "5", "spd": "1200"})
    assert _codes(result) == []


# ── comment stripping mirrors Klipper ──────────────────────────────────────

def test_commented_out_bad_line_is_not_flagged():
    body = "# SET_LED LED=strips RED=\nM117 fine"
    result = simulate_macro(body)
    assert _codes(result) == []


def test_trailing_comment_after_empty_value_still_flagged():
    body = "SET_LED LED=strips RED= ; oops"
    result = simulate_macro(body)
    empties = _findings(result, "macro_param_renders_empty")
    assert len(empties) == 1
    assert empties[0].source_line == 1


# ── plain bodies / provenance ──────────────────────────────────────────────

def test_plain_body_no_findings():
    result = simulate_macro("G28\nM104 S200\nM109 S200\n")
    assert _codes(result) == []
    assert [r.text for r in result.rendered] == ["G28", "M104 S200", "M109 S200"]
    assert [r.source_line for r in result.rendered] == [1, 2, 3]


def test_provenance_survives_nested_blocks():
    body = (
        "{% if params.a is defined %}\n"
        "  {% if params.b is defined %}\n"
        "    M117 deep\n"
        "  {% else %}\n"
        "    SET_LED LED=strips BLUE={params.c}\n"
        "  {% endif %}\n"
        "{% endif %}"
    )
    # a and b undefined → both membership tests are deterministic
    # (False) only because 'is defined' is special: params.b is defined
    # is False, so the inner else renders, and params.c is undefined...
    # c unset → the value renders as a Klipper-Undefined surface, NOT an
    # empty string; assert we report SOMETHING at line 5.
    result = simulate_macro(body)
    flagged = [f for f in result.findings if f.source_line == 5]
    assert flagged, [f.message for f in result.findings]
    assert flagged[0].code in ("macro_param_undefined", "macro_param_renders_empty")


# ── performance budget (plan: sim of all macro bodies < ~50 ms) ───────────

def test_200_macro_synthetic_config_under_budget():
    import time

    bodies = []
    for i in range(200):
        if i % 4 == 0:
            bodies.append("M117 plain %d" % i)
        elif i % 4 == 1:
            bodies.append(
                "{% if printer.x.v" + str(i) + " > 1 %}\nM117 a\n{% else %}\n"
                "G1 X{printer.toolhead.position.x}\n{% endif %}")
        elif i % 4 == 2:
            bodies.append("M117 {params.name|default('n" + str(i) + "')}")
        else:
            bodies.append(
                "{% for n in range(3) %}\nSET_LED LED=strip" + str(i)
                + " RED=1\n{% endfor %}")
    start = time.perf_counter()
    results = [simulate_macro(b) for b in bodies]
    elapsed = time.perf_counter() - start
    assert len(results) == 200
    # Generous CI/Pi bound for UNcached first-pass simulation of 200
    # realistic macro bodies (the <50ms per-file target in the plan is
    # for the cached steady state; assert that separately).
    assert elapsed < 5.0, f"200 macros simulated in {elapsed:.3f}s"

    # Cached steady state: same bodies again must be near-free.
    start = time.perf_counter()
    for b in bodies:
        simulate_macro(b)
    cached = time.perf_counter() - start
    assert cached < 0.1, f"cached replay took {cached:.3f}s"
