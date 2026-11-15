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
    assert "console message: party on" in out


def test_expected_effect_maps_fan_generic_speed_to_percent():
    text = ("[gcode_macro F]\n"
            "gcode:\n"
            "  SET_FAN_SPEED FAN=Aux_Fan SPEED=0.5\n")
    out = _call(macro_text=text)
    assert "fan 'Aux_Fan' commanded to 50%" in out


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
