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


# ── validator harness-pass wiring (task 2.3) ───────────────────────────────

from parser.config_parser import parse_config  # noqa: E402
from parser.validator import validate_config  # noqa: E402

LED_REPRO_CFG = """[gcode_macro TOGGLE_LEDS]
params_red:
params_green:
params_blue:
gcode:
    SET_LED LED=stealthburner RED={params.red} GREEN={params.green} BLUE={params.blue}
"""


def _sim_findings(result):
    return [e for e in result.errors if e.code.startswith("macro_")]


def test_validator_pass_flags_repro_at_absolute_line():
    res = validate_config(parse_config(LED_REPRO_CFG))
    errs = [e for e in res.errors if e.code == "macro_param_renders_empty"]
    assert len(errs) == 3, [e.message for e in res.errors]
    assert all(e.severity == "error" for e in errs)
    # 'gcode:' is line 5, the command renders from body line 1 -> line 6,
    # exactly where the editor must put the marker.
    assert all(e.line_number == 6 for e in errs), [e.line_number for e in errs]
    assert all(e.section == "gcode_macro TOGGLE_LEDS" for e in errs)


def test_validator_pass_vacuity_lever_is_registry_flag():
    # gcode_registry=False must silence the whole simulation pass — the
    # documented vacuity lock (disable the pass -> the test above goes
    # red, this one proves the lever position).
    res = validate_config(parse_config(LED_REPRO_CFG), gcode_registry=False)
    assert _sim_findings(res) == []


def test_validator_pass_clean_macro_silent():
    cfg = """[gcode_macro PARK]
gcode:
    {% set z = 10 %}
    G1 Z{z + 5} F600
"""
    res = validate_config(parse_config(cfg))
    assert _sim_findings(res) == [], [e.message for e in res.errors]


def test_validator_pass_both_arms_via_project_api():
    cfg = """[gcode_macro TOGGLE_FAN]
gcode:
    {% if printer.fan.speed > 0 %}
    M107
    {% else %}
    M106 S{params.level}
    {% endif %}
"""
    res = validate_config(parse_config(cfg))
    # params.level unset: the false-arm render aborts on Klipper's
    # Undefined — surfaced as the warning, at the referencing line.
    warns = [e for e in res.errors if e.code == "macro_param_undefined"]
    assert len(warns) == 1
    assert warns[0].severity == "warning"
    assert warns[0].line_number == 6


# ── MCP validate_macro façade (same engine, model-callable text) ───────────

def test_validate_macro_facade_reports_rendered_empty():
    import json as _json
    from mcp_server import McpServer
    macro = (
        "[gcode_macro TOGGLE_LEDS]\n"
        "params_red:\n"
        "params_green:\n"
        "params_blue:\n"
        "gcode:\n"
        "    SET_LED LED=stealthburner RED={params.red} "
        "GREEN={params.green} BLUE={params.blue}\n"
    )
    out = McpServer()._handle_validate_macro({"macro_text": macro})
    assert "renders EMPTY" in out
    assert "RED" in out


# ── The macro's own variable_* entries (dogfood false positive, 2026-11-13) ──
#
# Klipper ground truth (klippy/extras/gcode_macro.py):
#   self.variables[option[len('variable_'):]] = ast.literal_eval(...)   # load
#   kwparams = dict(self.variables)                                     # cmd()
#   kwparams.update(self.template.create_template_context())
#   kwparams['params'] = gcmd.get_command_parameters()
# So the macro's variables are top-level template names (lowercased at
# config parse, configfile.py 'option = option.lower()'), values are
# Python literals, and params stay SEPARATE (command line only).
# The simulator omitted variables entirely → the canonical
# variable-based toggle ({% if led_state %}) rendered as Undefined on a
# perfectly valid macro, and the model had to argue our own warning
# away. These tests pin the parity.

_TOGGLE_BODY = (
    "\n"
    "{% if led_state == 1 %}\n"
    "    SET_LED LED=chamber RED=0 GREEN=0 BLUE=0\n"
    "{% else %}\n"
    "    SET_LED LED=chamber RED=1 GREEN=1 BLUE=1\n"
    "{% endif %}\n"
    "SET_GCODE_VARIABLE MACRO=TOGGLE_LEDS VARIABLE=led_state "
    "VALUE={1 - led_state}\n"
)


def test_own_variables_injected_toggle_renders_clean():
    from parser.macro_render import simulate_macro
    res = simulate_macro(_TOGGLE_BODY, {}, variables={"led_state": "0"})
    assert res.findings == []
    # literal semantics: '0' evaluates to int 0 → the ELSE arm runs.
    text = "\n".join(line.text for line in res.rendered)
    assert "RED=1 GREEN=1 BLUE=1" in text
    assert "RED=0 GREEN=0 BLUE=0" not in text


def test_variables_do_not_leak_into_params():
    # Klipper keeps params separate: a variable named led_state does
    # NOT make params.led_state defined.
    from parser.macro_render import simulate_macro
    res = simulate_macro("SET_FAN_SPEED FAN=x SPEED={params.led_state}\n",
                         {}, variables={"led_state": "0"})
    assert any("led_state" in f.message for f in res.findings)


def test_variables_fix_does_not_blind_the_undefined_check():
    # Cry-wolf guard on the fix: one real variable must not mask a
    # genuinely undefined name.
    from parser.macro_render import simulate_macro
    res = simulate_macro("{% if totally_absent %}\nM106\n{% endif %}\n",
                         {}, variables={"led_state": "0"})
    assert any("totally_absent" in f.message for f in res.findings)


def test_variable_values_are_literals_with_raw_fallback():
    from parser.macro_render import simulate_macro
    res = simulate_macro('RESPOND TYPE=echo MSG="c={color}"\n', {},
                         variables={"color": '"blue"'})
    assert res.findings == []
    assert 'c=blue' in "\n".join(l.text for l in res.rendered)
    # Not a valid literal → raw string, never an engine crash.
    res = simulate_macro("M117 {weird}\n", {},
                         variables={"weird": "bare words: here"})
    assert res.findings == []
    assert "bare words: here" in "\n".join(l.text for l in res.rendered)


def test_variables_participate_in_the_result_cache_key():
    # Same body, different variable context → different verdicts; a
    # shared cache entry would leak one into the other.
    from parser.macro_render import simulate_macro
    body = "{% if led_state %}\nM106\n{% endif %}\n"
    assert simulate_macro(body, {}, variables={"led_state": "0"}).findings == []
    assert simulate_macro(body, {}).findings != []


def test_validator_path_variable_toggle_is_clean():
    # End-to-end (the dogfood's exact shape): project-parse validation
    # of a variable-based toggle must be silent, not warn.
    from parser.config_parser import parse_config
    from parser.validator import validate_config
    cfg = (
        "[gcode_macro TOGGLE_LEDS]\n"          # line 1
        "variable_led_state: 0\n"
        "gcode:\n"
        "    {% if led_state == 1 %}\n"
        "        SET_LED LED=chamber RED=0 GREEN=0 BLUE=0\n"
        "    {% else %}\n"
        "        SET_LED LED=chamber RED=1 GREEN=1 BLUE=1\n"
        "    {% endif %}\n"
    )
    res = validate_config(parse_config(cfg), gcode_registry=True)
    sim = [e for e in res.errors
           if e.code.startswith("macro_param_") or "render" in e.message.lower()]
    assert sim == [], sim


def test_facade_validate_macro_knows_own_variables():
    import json as _json
    from mcp_server import McpServer
    macro = (
        "[gcode_macro TOGGLE_LEDS]\n"
        "variable_led_state: 0\n"
        "gcode:\n"
        "    {% if led_state == 1 %}\n"
        "        SET_LED LED=chamber RED=0 GREEN=0 BLUE=0\n"
        "    {% else %}\n"
        "        SET_LED LED=chamber RED=1 GREEN=1 BLUE=1\n"
        "    {% endif %}\n"
    )
    out = McpServer()._handle_validate_macro({"macro_text": macro})
    low = out.lower()
    assert "undefined" not in low and "renders empty" not in low, out


# ── W3: runtime-error traceback (paste → Jinja source line) ────────────────

from parser.macro_render import (  # noqa: E402
    MacroTraceSource,
    extract_error_frames,
    trace_runtime_error,
)


def test_extract_frames_plain_quotes():
    text = ("Transitioning to shutdown:\n"
            "Error on 'SET_LED LED=chamber RED= GREEN= BLUE=': unable to parse\n"
            "Traceback (most recent call last): ...")
    assert extract_error_frames(text) == [
        "SET_LED LED=chamber RED= GREEN= BLUE="]


def test_extract_frames_strips_line_number_and_checksum():
    # Klipper quotes self._commandline verbatim (gcode.py get():76) —
    # serial lines can carry an N-prefix and *checksum.
    text = "Error on 'N123 G1 X100 F1200*42': unable to parse F"
    assert extract_error_frames(text) == ["G1 X100 F1200"]


def test_extract_frames_multiple_and_none():
    text = ("Error on 'A X=1': missing B\n"
            "later Error on 'C Y=2': bad\n")
    assert extract_error_frames(text) == ["A X=1", "C Y=2"]
    assert extract_error_frames("no error here") == []


def test_trace_matches_unknown_runtime_value_as_wildcard():
    # Simulation renders the save_variables path as <unknown>; the pasted
    # error carries the REAL runtime value. Unknown must match anything.
    src = MacroTraceSource(
        name="SET_LEDS",
        body="SET_LED LED=chamber "
             "RED={printer.save_variables.variables.led_r}\n",
        file="printer.cfg",
    )
    matches = trace_runtime_error(
        ["SET_LED LED=chamber RED=0.504 GREEN=0 BLUE=0"], [src])
    assert len(matches) == 1
    m = matches[0]
    assert m.macro == "SET_LEDS" and m.file == "printer.cfg"
    assert m.source_line == 1
    assert "save_variables" in m.source_text


def test_trace_matches_empty_render_exact():
    src = MacroTraceSource(
        name="BLINK",
        body='SET_LED LED=c RED={params.RED|default("")}\n',
        params={"red": ""},
        file="macros.cfg",
    )
    matches = trace_runtime_error(["SET_LED LED=c RED="], [src])
    assert len(matches) == 1 and matches[0].macro == "BLINK"


def test_trace_negative_different_param_value():
    src = MacroTraceSource(name="A", body="SET_LED LED=other RED=1\n")
    assert trace_runtime_error(["SET_LED LED=chamber RED=1"], [src]) == []


def test_trace_numeric_format_tolerance_and_verb_case():
    src = MacroTraceSource(name="MOVE", body="G1 X{10 * 5} F1500\n")
    matches = trace_runtime_error(["g1 X50.00 F1500"], [src])
    assert len(matches) == 1 and matches[0].macro == "MOVE"


def test_trace_ambiguity_reports_all_candidates_in_caller_order():
    a = MacroTraceSource(name="FIRST", body="SET_LED LED=c RED=\n",
                         file="a.cfg")
    b = MacroTraceSource(name="SECOND", body='SET_LED LED=c '
                         'RED={params.RED|default("")}\n',
                         params={"red": ""}, file="b.cfg")
    matches = trace_runtime_error(["SET_LED LED=c RED="], [a, b])
    assert [m.macro for m in matches] == ["FIRST", "SECOND"]
