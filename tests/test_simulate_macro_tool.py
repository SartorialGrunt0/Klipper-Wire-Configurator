"""W4R.3 — the simulate_macro model-callable tool.

Contract under test: declared-scenario simulation with provenance.
Scenario params/printer_state/variables drive the render; the result
echoes the declared assumptions, the rendered lines (body-numbered),
the full findings set (including the warnings that ambient validation
no longer shows — decision D3), and what stayed <unknown>. Working
state (staged edits) shadows disk for name resolution.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import mcp_server  # noqa: E402
from mcp_server import McpServer  # noqa: E402

_TOGGLE = (
    "[gcode_macro HEAT_AND_FAN]\n"
    "gcode:\n"
    "    M104 S{params.S}\n"
    "    M106 S{params.FAN}\n"
)

_BRANCH = (
    "[gcode_macro MAYBE_HOME]\n"
    "gcode:\n"
    "    {% if printer.toolhead.homed_axes == 'xyz' %}\n"
    "    M117 already homed\n"
    "    {% else %}\n"
    "    G28\n"
    "    {% endif %}\n"
)


def _call(**args):
    return McpServer()._handle_simulate_macro(args)


# ── registration ───────────────────────────────────────────────────────────

def test_tool_registered_in_spec_and_dispatch():
    names = {t["name"] for t in McpServer()._list_tools()}
    assert "simulate_macro" in names
    spec = next(t for t in McpServer()._list_tools()
                if t["name"] == "simulate_macro")
    # truth-in-advertising: the limits sentence is part of the contract
    assert "CALL macros are not recursed" in spec["description"]
    assert "motion" in spec["description"]


# ── declared scenarios drive the render ────────────────────────────────────

def test_bare_scenario_surfaces_the_warning_that_ambient_validation_hides():
    """The D3 core: the bare-call abort/empty-render class the human
    surfaces no longer show must be readable from the tool result."""
    out = _call(macro_text=_TOGGLE,
                scenarios=[{"name": "bare"}])
    assert "## bare" in out
    assert "Declared: params: {}" in out
    assert "M104 S" in out  # rendered key with EMPTY value
    assert "ERROR" in out   # registry caught the broken shape


def test_scenario_params_change_the_render():
    out = _call(macro_text=_TOGGLE,
                scenarios=[{"name": "s=215", "params": {"S": "215",
                                                        "FAN": "128"}}])
    assert "M104 S215" in out
    assert "M106 S128" in out
    assert "Findings: none" in out


def test_declared_printer_state_decides_the_branch():
    """4R.3 engine support through the tool: a declared dotted path
    collapses the branch to ONE rendered path; undeclared widens both."""
    out = _call(macro_text=_BRANCH,
                scenarios=[{"name": "homed",
                            "printer_state": {"toolhead.homed_axes": "xyz"}}])
    assert "M117 already homed" in out
    assert "G28" not in out.split("## homed")[1]
    out2 = _call(macro_text=_BRANCH, scenarios=[{"name": "undeclared"}])
    assert "1 path" not in out2  # both arms expand on unknown state
    assert "<unknown>" in out2  # provenance: never guessed


def test_variables_scenario_override_section_defaults():
    text = ("[gcode_macro VAR]\n"
            "variable_speed: 50\n"
            "gcode:\n"
            "    G1 F{speed}\n")
    out = _call(macro_text=text,
                scenarios=[{"name": "declared", "variables":
                            {"speed": "1200"}}])
    assert "G1 F1200" in out
    out_default = _call(macro_text=text)
    assert "G1 F50" in out_default


def test_scenario_variable_matches_declared_name_case_insensitively():
    """Klipper lowercases option names at config parse, so SPEED and
    speed are the same declared variable — not an undeclared name."""
    text = ("[gcode_macro VAR]\n"
            "variable_speed: 50\n"
            "gcode:\n"
            "    G1 F{speed}\n")
    out = _call(macro_text=text,
                scenarios=[{"name": "upper", "variables":
                            {"SPEED": "900"}}])
    assert "G1 F900" in out
    assert "WARNING" not in out


def test_undeclared_scenario_variable_is_refused_not_invented():
    """Klipper publishes only the section's own variable_* entries, with
    the prefix stripped (klippy/extras/gcode_macro.py), and
    SET_GCODE_VARIABLE rejects any other name. A scenario variable
    outside that set cannot exist at run time, so injecting it renders a
    fiction: the SIMTOOL-02 r7 leg "simulated" a dead toggle by
    declaring `variable_fan_on` when the macro declared `fan_on`, and
    the phantom made both branches look distinct. The name must be
    refused, warned about, and left undefined."""
    text = ("[gcode_macro TOGGLE]\n"
            "variable_fan_on: False\n"
            "gcode:\n"
            "    {% if variable_fan_on %}\n"
            "    M107\n"
            "    {% else %}\n"
            "    M106 S255\n"
            "    {% endif %}\n")
    out = _call(macro_text=text,
                scenarios=[{"name": "on", "variables":
                            {"variable_fan_on": "True"}}])
    assert "WARNING: scenario variable 'variable_fan_on'" in out
    assert "declared here: fan_on" in out
    # Klipper truth kept: the undeclared read stays falsy, so this one
    # scenario renders the single else-branch command and nothing else.
    assert "M107" not in out
    assert out.count("M106 S255") == 1


# ── provenance law: the result labels what it knows ────────────────────────

def test_result_echoes_assumptions_and_limits():
    out = _call(macro_text=_TOGGLE,
                scenarios=[{"name": "one", "params": {"S": "1"},
                            "printer_state": {"fan.speed": 0.5}}])
    assert "Declared: params: {'s': '1'}; printer_state: {'fan.speed': 0.5}" \
        in out
    assert "never present a rendered value as a printer fact" in out


def test_scenario_cap_enforced_with_notice():
    out = _call(macro_text=_TOGGLE,
                scenarios=[{"name": f"s{i}"} for i in range(10)])
    assert "truncated to the cap of 8" in out
    assert out.count("## s") == 8


def test_stringified_scenarios_array_is_recovered():
    """Tool channels stringify arrays; the handler must parse them back
    instead of refusing."""
    out = _call(macro_text=_TOGGLE,
                scenarios='[{"name": "json", "params": {"S": "9"}}]')
    assert "M104 S9" in out


def test_no_args_is_actionable_not_confusing():
    out = _call()
    assert "macro='NAME'" in out and "macro_text=" in out


def test_unknown_macro_name_offers_the_text_escape():
    out = _call(macro="NO_SUCH_MACRO_XYZ")
    assert "macro_text" in out


# ── sequence mode (runs): state threading ─────────────────────────────────

_TOGGLE_PERSISTENT = (
    "[gcode_macro TOGGLE_FAN]\n"
    "variable_fan_on: False\n"
    "gcode:\n"
    "  {% if fan_on %}\n"
    "    M107\n"
    "    SET_GCODE_VARIABLE MACRO=TOGGLE_FAN VARIABLE=fan_on VALUE=False\n"
    "  {% else %}\n"
    "    M106 S255\n"
    "    SET_GCODE_VARIABLE MACRO=TOGGLE_FAN VARIABLE=fan_on VALUE=True\n"
    "  {% endif %}\n"
)

_TOGGLE_DEAD = (
    "[gcode_macro TOGGLE_FAN]\n"
    "variable_fan_on: False\n"
    "gcode:\n"
    "  {% set fan_on = not fan_on %}\n"
    "  {% if fan_on %}\n"
    "    SET_FAN_SPEED FAN=fan SPEED=1\n"
    "  {% else %}\n"
    "    SET_FAN_SPEED FAN=fan SPEED=0\n"
    "  {% endif %}\n"
)


def test_runs_threads_state_through_set_gcode_variable():
    """The toggle question the tool could not answer before: call 1's
    own SET_GCODE_VARIABLE is the state call 2 starts from."""
    out = _call(macro_text=_TOGGLE_PERSISTENT, runs=2)
    assert "## call 1" in out and "## call 2" in out
    assert "→ state after call 1: fan_on := True" in out
    assert "variables: {'fan_on': 'True'}" in out      # call 2 inherits it
    assert "M107" in out                                 # fan actually turns off
    assert "Sequence: call 2 vs call 1 -> commands differ: YES" in out


def test_runs_exposes_a_toggle_that_never_persists():
    """The r7/r8 SIMTOOL-02 artifact: {% set %} is template-local, so no
    state changes and every call takes the same branch. Two independent
    scenarios made this look like a working toggle."""
    out = _call(macro_text=_TOGGLE_DEAD, runs=2)
    assert "→ state after call 1: unchanged" in out
    assert "commands differ: NO" in out
    assert "M107" not in out


def test_runs_alone_refuses_multiple_scenarios():
    out = _call(macro_text=_TOGGLE_PERSISTENT, runs=2,
                scenarios=[{"name": "a"}, {"name": "b"}])
    assert "CONSECUTIVE calls from ONE starting state" in out


def test_runs_is_capped_and_validated():
    out = _call(macro_text=_TOGGLE_PERSISTENT, runs=99)
    assert out.count("## call ") == 6
    bad = _call(macro_text=_TOGGLE_PERSISTENT, runs="lots")
    assert "runs must be an integer" in bad


def test_threading_ignores_foreign_and_undeclared_writes():
    text = ("[gcode_macro TOGGLE_FAN]\n"
            "variable_fan_on: False\n"
            "gcode:\n"
            "  SET_GCODE_VARIABLE MACRO=OTHER_MACRO VARIABLE=fan_on "
            "VALUE=True\n"
            "  SET_GCODE_VARIABLE MACRO=TOGGLE_FAN VARIABLE=nope "
            "VALUE=True\n"
            "  M106 S255\n")
    out = _call(macro_text=text, runs=2)
    # The foreign write is not ours to follow; the undeclared name is
    # rejected by Klipper and reported, never followed.
    assert "undeclared variable 'nope'" in out
    assert "→ state after call 1: unchanged" in out


def test_threading_refuses_non_literal_value():
    text = ("[gcode_macro TOGGLE_FAN]\n"
            "variable_fan_on: False\n"
            "gcode:\n"
            "  SET_GCODE_VARIABLE MACRO=TOGGLE_FAN VARIABLE=fan_on "
            "VALUE=on\n")
    out = _call(macro_text=text, runs=2)
    assert "is not a literal" in out
    assert "→ state after call 1: unchanged" in out


# ── expected effect (commanded, not observed) ─────────────────────────────

def test_expected_effect_reports_commanded_outcomes():
    text = ("[gcode_macro PARTY]\n"
            "gcode:\n"
            "  M106 S255\n"
            "  M104 S200\n"
            "  SET_LED LED=stealthburner RED=1 GREEN=0 BLUE=0.2\n"
            "  M117 party on\n")
    out = _call(macro_text=text)
    assert "Expected effect (commanded, not observed):" in out
    assert "part-cooling fan ([fan]) commanded to 100%" in out
    assert "hotend target 200C" in out
    assert "LED 'stealthburner' set to RED=1 GREEN=0 BLUE=0.2" in out
    assert "display message: party on" in out


def test_expected_effect_maps_fan_generic_speed_to_percent():
    text = ("[gcode_macro F]\n"
            "gcode:\n"
            "  SET_FAN_SPEED FAN=Aux_Fan SPEED=0.5\n")
    out = _call(macro_text=text)
    assert "fan 'Aux_Fan' commanded to 50%" in out


def test_limits_caveat_states_a_refused_line_aborts_the_macro():
    """Measured on the virtual printer 2026-11-15 (rig/REPORT.md, C1-C3):
    every refusal on the real printer — unhomed move, out-of-range target,
    cold extrude, '=' params — ABORTS the remaining macro body; later
    lines never run. The effect list implicitly assumes no line errors,
    so the limits text must say so."""
    out = _call(macro_text="[gcode_macro T]\ngcode:\n  M104 S200\n")
    assert "refused line" in out
    assert "ABORTS" in out


def test_expected_effect_distinguishes_set_from_set_and_wait():
    """Dogfood (2026-11-15): M104/M109 and M140/M190 produced IDENTICAL
    effect lines, and the model — seeing no distinction in the
    simulation — invented a manual M104+TEMPERATURE_WAIT wait, claiming
    M109 does not block inside macros. Klipper truth: cmd_M109 is
    cmd_M104 with wait=True (kinematics/extruder.py:277), blocking in
    macros too. The effect lines must show it."""
    text = ("[gcode_macro HEATUP]\n"
            "gcode:\n"
            "  M104 S220\n"
            "  M109 S220\n"
            "  M140 S60\n"
            "  M190 S60\n")
    out = _call(macro_text=text)
    assert "hotend target 220C — Set (does not wait" in out
    assert "hotend target 220C — Set and Wait" in out
    assert "bed target 60C — Set (does not wait" in out
    assert "bed target 60C — Set and Wait" in out
    # and the two hotend lines are NOT the same line
    hot = [ln for ln in out.splitlines() if "hotend target 220C" in ln]
    assert len(hot) == 2 and hot[0] != hot[1]


def test_m109_zero_target_is_set_only_not_a_wait():
    """heaters.py set_temperature waits only `if wait and temp` — M109
    S0 sets and returns like M104, and the effect line must not claim a
    block that Klipper will skip."""
    text = ("[gcode_macro COOLDOWN_OFF]\n"
            "gcode:\n"
            "  M109 S0\n")
    out = _call(macro_text=text)
    assert "Set (NO wait even though" in out
    assert "Set and Wait (the macro BLOCKS" not in out


def test_m109_unknown_target_reports_the_skip_condition():
    """S rendered from unknown state cannot decide the S=0 skip — say
    so instead of asserting a wait."""
    text = ("[gcode_macro HEATUNK]\n"
            "gcode:\n"
            "  M109 S{printer.extruder.target}\n")
    out = _call(macro_text=text)
    assert "Set and Wait, UNLESS the target resolves to 0" in out


def test_expected_effect_lists_pure_blocking_waits():
    """TEMPERATURE_WAIT / G4 / M400 previously produced NO effect line —
    a macro whose only logic was waiting looked inert."""
    text = ("[gcode_macro SETTLE]\n"
            "gcode:\n"
            "  TEMPERATURE_WAIT SENSOR=extruder MINIMUM=219 MAXIMUM=221\n"
            "  G4 P500\n"
            "  G4 P2500\n"
            "  M400\n")
    out = _call(macro_text=text)
    assert ("Wait (blocking) — sensor 'extruder' reaches MINIMUM=219, "
            "MAXIMUM=221") in out
    assert "dwell 500 ms" in out
    assert "dwell 2500 ms" in out
    assert "all queued moves complete" in out
    # ('G4 P1=2' style is NOT a legal wait — live-proven on .164:
    # G4 P1=0.01 -> "unable to parse 1=0.01". Covered in the reject test.)


# ── D4: a body that does not compile is never silent ───────────────────────

_DOUBLE_BRACE = (
    "[gcode_macro SHOW_STATE]\n"
    "variable_fan_on: False\n"
    "gcode:\n"
    '  RESPOND TYPE=echo TEXT="state: {{ fan_on }}"\n'
)


def test_double_brace_expression_from_prose_is_a_syntax_error_not_silence():
    """Klipper's env is jinja2.Environment('{%','%}','{','}'): expressions
    are SINGLE braces, so '{{ fan_on }}' does not compile. The engine used
    to swallow TemplateSyntaxError and return [] with no finding — the tool
    printed "nothing rendered / Findings: none" and r9 SIMTOOL-02 leg b
    burned 12 probe calls reverse-engineering it."""
    out = _call(macro_text=_DOUBLE_BRACE)
    assert "macro_jinja_syntax" not in out  # codes are internal
    assert "does not compile as a Klipper template" in out
    assert "SINGLE braces" in out
    assert "Nothing was rendered" in out
    # and the empty-render line must not claim the body compiled
    assert "did NOT compile" in out
    assert "Findings: none" not in out


def test_broken_body_is_an_error_so_the_write_gate_refuses_it():
    from parser.macro_render import simulate_macro  # noqa: PLC0415
    res = simulate_macro('RESPOND TYPE=echo TEXT="state: {{ fan_on }}"')
    assert [(f.severity, f.code) for f in res.findings] == [
        ("error", "macro_jinja_syntax")]
    assert res.rendered == []


def test_single_brace_expression_renders_the_declared_value():
    text = ("[gcode_macro SHOW_STATE]\n"
            "variable_fan_on: False\n"
            "gcode:\n"
            '  RESPOND TYPE=echo TEXT="state: {fan_on}"\n')
    out = _call(macro_text=text, variables={"fan_on": "False"})
    assert 'state: False' in out.replace("\\n", "\n") or "state: False" in out
    assert "does not compile" not in out


# ── single-invocation shorthand (one nesting level less) ──────────────────

_SHOUT = ("[gcode_macro SHOUT]\n"
          "gcode:\n"
          "  M117 hello {params.NAME}\n")


def test_top_level_params_are_the_one_implicit_scenario():
    out = _call(macro_text=_SHOUT, params={"NAME": "world"})
    assert "M117 hello world" in out
    # one call, one invocation: nothing about comparing scenarios
    assert "Rendered (" in out


def test_top_level_variables_are_the_one_implicit_scenario():
    text = ("[gcode_macro TOGGLE_FAN]\n"
            "variable_fan_on: False\n"
            "gcode:\n"
            "  {% if fan_on %}\n"
            "  M107\n"
            "  {% else %}\n"
            "  M106 S255\n"
            "  {% endif %}\n")
    out = _call(macro_text=text, variables={"fan_on": "True"})
    assert "M107" in out
    assert "M106" not in out.split("Rendered")[1][:200]


def test_shorthand_plus_scenarios_is_refused_with_a_reason():
    out = _call(macro_text=_SHOUT, params={"NAME": "x"},
                scenarios=[{"name": "s"}])
    assert "not both" in out


def test_shorthand_must_be_an_object():
    out = _call(macro_text=_SHOUT, params="NAME=world")
    assert "must be an object" in out


# ── D5: mux targets are resolved against the project's hardware ───────────

def test_unknown_fan_target_warns_with_klippers_near_miss():
    """SET_FAN_SPEED FAN= only enumerates [fan_generic NAME]: [fan] is the
    part-cooling fan driven by M106/M107, so FAN=fan dies at run time with
    "The value 'fan' is not valid for FAN. Did you mean 'Aux_Fan'?" — the
    exact artifact SIMTOOL-02 r9 leg b staged and passed."""
    from parser.macro_render import simulate_macro  # noqa: PLC0415
    res = simulate_macro("SET_FAN_SPEED FAN=fan SPEED=1.0",
                         sections=frozenset({"fan", "fan_generic aux_fan"}))
    codes = [(f.severity, f.code) for f in res.findings]
    assert codes == [("warning", "macro_mux_target_unknown")]
    msg = res.findings[0].message
    assert "The value 'fan' is not valid for FAN" in msg
    assert "Did you mean 'aux_fan'?" in msg
    # a shape-valid line is still rendered; the warning is the verdict
    assert [line.text for line in res.rendered] == ["SET_FAN_SPEED FAN=fan SPEED=1.0"]


def test_declared_fan_target_is_clean():
    from parser.macro_render import simulate_macro  # noqa: PLC0415
    res = simulate_macro("SET_FAN_SPEED FAN=Aux_Fan SPEED=1.0",
                         sections=frozenset({"fan", "fan_generic aux_fan"}))
    assert res.findings == []


def test_mux_check_is_silent_when_availability_is_undecidable():
    """No section inventory (unresolved include / no project) → no verdict.
    Absence of evidence is not evidence of absence (same law as the
    variable checks)."""
    from parser.macro_render import simulate_macro  # noqa: PLC0415
    res = simulate_macro("SET_FAN_SPEED FAN=fan SPEED=1.0")
    assert res.findings == []


def test_unknown_target_with_no_candidates_names_the_missing_family():
    from parser.macro_render import simulate_macro  # noqa: PLC0415
    res = simulate_macro("SET_LED LED=stealthburner RED=1",
                         sections=frozenset({"printer"}))
    assert res.findings[0].code == "macro_mux_target_unknown"
    msg = res.findings[0].message
    assert "[neopixel]" in msg and "[dotstar]" in msg
    assert "No [neopixel]" in msg


def test_led_and_pin_families_resolve_by_section_name():
    from parser.macro_render import simulate_macro  # noqa: PLC0415
    secs = frozenset({"neopixel stealthburner", "output_pin caselight"})
    assert simulate_macro("SET_LED LED=stealthburner RED=1",
                          sections=secs).findings == []
    assert simulate_macro("SET_PIN PIN=caselight VALUE=1",
                          sections=secs).findings == []
    assert simulate_macro("SET_PIN PIN=other VALUE=1",
                          sections=secs).findings[0].code == \
        "macro_mux_target_unknown"


def test_mux_warning_does_not_gate_the_write_path():
    """warning severity + sim-origin = tool surface only (the human save
    gate and the model's delta advisories never see it)."""
    from parser.macro_render import is_sim_advisory  # noqa: PLC0415
    assert is_sim_advisory("macro_mux_target_unknown", "warning")


def test_handler_resolves_targets_from_the_working_state():
    """End to end through the tool: a project that declares [fan] and
    [fan_generic Aux_Fan] makes FAN=fan a warning."""
    text = ("[gcode_macro FAN_TEST]\n"
            "gcode:\n"
            "  SET_FAN_SPEED FAN=fan SPEED=1.0\n")
    project = {
        "printer.cfg": ("[fan]\npin: PA8\n"
                        "[fan_generic Aux_Fan]\npin: PA9\n" + text),
    }
    mcp_server.set_chat_working_files(project)
    try:
        out = _call(macro_text=text)
    finally:
        mcp_server.set_chat_working_files(None)
    assert "is not valid for FAN" in out
    assert "Did you mean 'aux_fan'?" in out


def test_handler_stays_silent_when_an_include_is_missing():
    text = ("[gcode_macro FAN_TEST]\n"
            "gcode:\n"
            "  SET_FAN_SPEED FAN=fan SPEED=1.0\n")
    project = {"printer.cfg": "[include unknown_hardware.cfg]\n" + text}
    mcp_server.set_chat_working_files(project)
    try:
        out = _call(macro_text=text)
    finally:
        mcp_server.set_chat_working_files(None)
    assert "is not valid for FAN" not in out


# ── D6/D7: enum membership, and the sentinel that ate the word "info" ─────

def test_respond_type_info_is_an_error_not_unknown_state():
    """D7: 'inf' used to substring-match inside 'info', so this line was
    reported as "renders as unknown printer state (info)" — an info note
    about a call Klipper refuses outright (respond.py:44)."""
    from parser.macro_render import simulate_macro  # noqa: PLC0415
    res = simulate_macro('RESPOND TYPE=info MESSAGE="Aux fan on"')
    codes = [(f.severity, f.code) for f in res.findings]
    assert codes == [("error", "macro_param_enum_invalid")]
    assert "not a legal value" in res.findings[0].message
    assert "'echo'" in res.findings[0].message


def test_legal_respond_types_pass():
    from parser.macro_render import simulate_macro  # noqa: PLC0415
    for value in ("echo", "command", "error", "echo_no_space", "ECHO"):
        assert simulate_macro(f'RESPOND TYPE={value} MSG="hi"').findings == []


def test_dual_carriage_mode_is_enum_checked():
    from parser.macro_render import simulate_macro  # noqa: PLC0415
    ok = simulate_macro("SET_DUAL_CARRIAGE CARRIAGE=0 MODE=copy")
    assert ok.findings == []
    bad = simulate_macro("SET_DUAL_CARRIAGE CARRIAGE=0 MODE=full_control")
    assert [f.code for f in bad.findings] == ["macro_param_enum_invalid"]


def test_unknown_rendered_value_is_still_unknown_state():
    """The sentinel path must keep working: an undeclared printer-state
    read is undecidable, never an enum verdict."""
    from parser.macro_render import simulate_macro  # noqa: PLC0415
    res = simulate_macro("RESPOND TYPE={printer.resp_type}")
    assert [f.code for f in res.findings] == ["macro_unknown_value"]
    assert res.findings[0].severity == "info"


def test_looks_unknown_is_sentinel_exact():
    from parser.macro_render import _looks_unknown  # noqa: PLC0415
    assert _looks_unknown("<unknown>")
    assert _looks_unknown("nan")
    assert _looks_unknown("-inf")
    assert _looks_unknown("Infinity")
    # the D7 false positives: words that merely CONTAIN inf/nan
    assert not _looks_unknown("info")
    assert not _looks_unknown("infeed")
    assert not _looks_unknown("nanometer")


# ── working state shadows disk (W3 scope ruling) ───────────────────────────

def test_staged_content_shadows_the_macro_lookup():
    token = "M117 staged-marker"
    staged = {"printer.cfg": "[gcode_macro SHADOWED]\ngcode:\n    " + token}
    mcp_server.set_chat_working_files(staged)
    try:
        out = _call(macro="SHADOWED")
    finally:
        mcp_server.set_chat_working_files(None)
    assert token in out
    assert "working state" in out


def test_facade_and_default_sim_are_independent_surfaces():
    """validate_macro still does the DEFAULT-invocation simulation and
    simulate_macro does the declared ones; both read the same engine."""
    out = _call(macro_text=_TOGGLE)  # no scenarios -> default invocation
    assert "scenario-1" in out  # one default scenario, labeled


def test_expected_effect_rejects_equals_on_letter_commands():
    """'M109 S={temp}' renders 'M109 S=220' — a shape real Klipper
    refuses on every call (letter params never carry '='; live-proven
    on .164). The effect line must NOT print a happy Set-and-Wait for a
    line that never runs, and the finding must name the fix."""
    text = ("[gcode_macro HEAT_EQ]\n"
            "gcode:\n"
            "  {% set temp = params.T|default(220)|int %}\n"
            "  M109 S={temp}\n")
    out = _call(macro_text=text)
    assert "WILL BE REJECTED on the real printer" in out
    assert "write S220 not S=220" in out
    assert "Set and Wait (the macro BLOCKS" not in out
    assert "macro" not in out or "does not parse as float" in out \
        or "unable to parse" in out
    # the canonical spelling keeps the clean Set-and-Wait line
    ok = _call(macro_text=text.replace("S={temp}", "S{temp}"))
    assert "Set and Wait (the macro BLOCKS" in ok
    assert "WILL BE REJECTED" not in ok


def test_expected_effect_rejects_p1_equals_dwell():
    """'G4 P1=2' is the mid-value '=' shape: Klipper reads it as
    P='1=2' and raises 'unable to parse 1=2' (live-proven on .164).
    No dwell effect may be reported for it."""
    out = _call(macro_text=("[gcode_macro DWELL_EQ]\n"
                           "gcode:\n"
                           "  G4 P1=2\n"))
    assert "WILL BE REJECTED on the real printer" in out
    assert "unable to parse 1=2" in out
    assert "dwell" not in out.split("WILL BE REJECTED")[0].split("## scenario-1")[-1]
