"""W4R engine truth (plan 2026-11-14, pivot 4R): Klipper-parity template semantics.

Klipper's gcode_macro env is a PLAIN ``jinja2.Environment('{%','%}','{','}')``
(gcode_macro.py:83) — the DEFAULT Undefined class: bare ``{params.X}`` renders
``''`` (the shape check then catches the empty field via the registry — Klipper's
real "unable to parse" failure), while ``|float`` / ``|int`` / arithmetic on an
unset name abort. ``params`` is a plain dict, so jinja's own error string reads
``'dict object' has no attribute 'X'``. ``create_template_context()``
(gcode_macro.py:106-112) provides the four action functions on EVERY invocation.

These tests pin the simulator to the shipped engine, replacing the
StrictUndefined-overlay approximation whose dev-server audit (2026-11-14)
false-flagged valid real-world configs (missing action context, forced-true
exploration of statically-resolvable param-presence guards).
"""
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from parser.macro_render import SIM_FINDING_CODES, simulate_macro  # noqa: E402

M106_BODY = """
    {% if params.P is defined %}
        {% if params.P|int == 2 %}
            {% if params.S is defined %}
                {% if params.S|int == 255 %}
                    {% set realspeed = 1 %}
                {% else %}
                    {% if params.S|int == 0 %}
                        {% set realspeed = 0 %}
                    {% else %}
                        {% set realspeed = params.S|float/255 %}
                    {% endif %}
                {% endif %}
            {% else %}
                {% set realspeed = 1 %}
            {% endif %}

            SET_FAN_SPEED FAN=Aux_Fan SPEED={realspeed}
        {% endif %}
    {% else %}
        {% if params.S is defined %}
          G106 S{params.S}
        {% else %}
          G106 S255
        {% endif %}
    {% endif %}
"""

RESUME_GUARD_BODY = """
    {% if 'VELOCITY' in params|upper %}
      {% set get_params = ('VELOCITY=' + params.VELOCITY)  %}
    {%else %}
      {% set get_params = "" %}
    {% endif %}
    RESUME_BASE {get_params}
"""

HOMED_COND_BODY = """
{% if printer.toolhead.homed_axes == 'xyz' %}
G28
{% else %}
NOOP
{% endif %}
"""


# ── context parity: create_template_context() ──────────────────────────────

def test_klipper_action_functions_render_clean():
    """All four functions gcode_macro.py:106-112 injects must be callable in
    the sim. Their absence false-flagged every stock PAUSE/RESUME/KAMP/obico
    macro in the 2026-11-14 audit."""
    body = ('    {action_respond_info("hello")}\n'
            '    {action_raise_error("nope")}\n'
            '    {action_emergency_stop("stop")}\n'
            '    {action_call_remote_method("m")}\n'
            '    M117 ok\n')
    result = simulate_macro(body)
    assert [f.code for f in result.findings
            if f.severity in ("error", "warning")] == []
    assert any(r.text == "M117 ok" for r in result.rendered)


def test_action_functions_do_not_leak_values():
    """Klipper's action_* return '' — the line they sit on renders as the
    surrounding text only, never the function name."""
    result = simulate_macro('X1 {action_respond_info("m")} X2\n')
    texts = [r.text for r in result.rendered]
    assert texts == ["X1  X2"] or texts == ["X1 X2"]


def test_caller_data_is_not_klipper_context_and_behaves_like_undefined():
    """caller_data is NOT in gcode_macro's context (display templates only).
    Klipper truth (jinja 3.1.6 probe 2026-11-14, matches
    reference/klipper/klippy/extras/gcode_macro.py cmd()): a BARE
    truth-test resolves Undefined → deterministically False; an
    ATTRIBUTE CHAIN through it raises UndefinedError — the macro aborts,
    exactly like real Klipper. Neither expands arms."""
    bare = simulate_macro("{% if caller_data %}\nRETRACT\n{% else %}\nPLAIN\n"
                          "{% endif %}\n")
    assert [r.text for r in bare.rendered] == ["PLAIN"]
    assert bare.variants_rendered == 1
    assert [f for f in bare.findings
            if f.severity in ("error", "warning")] == []
    chained = simulate_macro("{% if caller_data.retracted %}\nRETRACT\n"
                             "{% else %}\nPLAIN\n{% endif %}\n")
    assert chained.rendered == []
    assert chained.variants_rendered == 1
    assert [f.code for f in chained.findings] == ["macro_param_undefined"]


def test_genuinely_undefined_names_still_flag_no_blindness():
    """The context fix must not blind the checker: an invented name used
    through a numeric filter aborts in REAL Klipper too (probe-verified) —
    it still flags."""
    result = simulate_macro('{% set v = not_a_klipper_name|int %}M117 {v}\n')
    assert any(f.code == "macro_param_undefined" for f in result.findings)


# ── default-Undefined parity: empty renders, not aborts, where Klipper is ──

def test_bare_unset_param_renders_empty_then_registry_flags_shape():
    """Klipper default Undefined: {params.RED} renders '' — the DEFINITE
    failure is the registry verdict on the empty typed field (the field-repro
    class), not a render abort."""
    result = simulate_macro('SET_LED LED=chamber RED={params.RED} GREEN=0 '
                            'BLUE=0\n')
    codes = [f.code for f in result.findings]
    assert "macro_param_undefined" not in codes
    assert "macro_param_renders_empty" in codes
    err = [f for f in result.findings
           if f.code == "macro_param_renders_empty"][0]
    assert err.severity == "error"


def test_abort_message_uses_klipper_dict_object_wording():
    """|float on an unset param aborts in real Klipper with jinja's own
    string over a plain dict — no engine-internal class names may leak."""
    result = simulate_macro('{% set s = params.S|float %}M104 S{s}\n')
    warn = [f for f in result.findings
            if f.code == "macro_param_undefined"]
    assert len(warn) == 1
    assert "dict object" in warn[0].message
    assert "has no attribute 'S'" in warn[0].message
    assert "macro_render" not in warn[0].message


# ── param-presence guards are DETERMINISTIC (no arm expansion) ─────────────

def test_is_defined_guard_default_invocation_is_clean():
    """aux_fan M106 shape: every params.X read is guarded by `is defined`.
    On the default invocation the guards are decidable (False) — the real
    engine renders exactly one path, no warnings. (Audit FP #6.)"""
    result = simulate_macro(M106_BODY)
    assert [f for f in result.findings
            if f.severity in ("error", "warning")] == []
    assert result.variants_rendered == 1
    assert [r.text for r in result.rendered] == ["G106 S255"]


def test_is_not_defined_grammar_is_also_static():
    result = simulate_macro(
        '{% if params.X is not defined %}\nG4 P10\n{% else %}\nG4 P20\n'
        '{% endif %}\n')
    assert result.variants_rendered == 1
    assert [r.text for r in result.rendered] == ["G4 P10"]


def test_in_params_membership_default_invocation_is_clean():
    """Stock Mainsail RESUME guard: `'VELOCITY' in params|upper` is decidable
    from declared params. No phantom params.VELOCITY render. (Audit FP #7.)"""
    result = simulate_macro(RESUME_GUARD_BODY)
    assert [f for f in result.findings
            if f.severity in ("error", "warning")] == []
    assert [r.text for r in result.rendered] == ["RESUME_BASE"]


def test_scenario_params_drive_the_guarded_arm():
    """The COVERAGE question moved to scenarios (4R.3 tool): with P/S
    declared, the true arms render and validate."""
    result = simulate_macro(M106_BODY, {"p": "2", "s": "255"})
    assert [f for f in result.findings
            if f.severity in ("error", "warning")] == []
    assert any(r.text.startswith("SET_FAN_SPEED") and "SPEED=1" in r.text
               for r in result.rendered)
    result_mid = simulate_macro(M106_BODY, {"p": "2", "s": "128"})
    assert any(r.text.startswith("SET_FAN_SPEED") for r in result_mid.rendered)


def test_membership_guard_true_via_scenario_params():
    result = simulate_macro(RESUME_GUARD_BODY, {"velocity": "15"})
    assert [f for f in result.findings
            if f.severity in ("error", "warning")] == []
    assert [r.text for r in result.rendered] == ["RESUME_BASE VELOCITY=15"]


# ── scenario printer-state (4R.3 engine support) ───────────────────────────

def test_scenario_state_condition_becomes_deterministic():
    result = simulate_macro(HOMED_COND_BODY,
                            printer_state={"toolhead.homed_axes": "xyz"})
    assert result.variants_rendered == 1
    assert [r.text for r in result.rendered] == ["G28"]
    assert result.findings == []


def test_undeclared_state_still_renders_both_arms():
    result = simulate_macro(HOMED_COND_BODY)
    texts = [r.text for r in result.rendered]
    assert "G28" in texts and "NOOP" in texts


def test_partial_state_other_conditions_stay_unknown():
    """Declaring one path must not claim knowledge of its siblings: the
    un-declared probe condition still expands both arms."""
    body = ("{% if printer.toolhead.homed_axes == 'xyz' %}\nA1\n{% else %}\n"
            "B1\n{% endif %}\n"
            "{% if printer.extruder.temperature > 170 %}\nA2\n{% else %}\n"
            "B2\n{% endif %}\n")
    result = simulate_macro(body, printer_state={
        "toolhead.homed_axes": "xyz"})
    texts = [r.text for r in result.rendered]
    assert "A1" in texts and "B1" not in texts
    assert "A2" in texts and "B2" in texts


def test_scenario_values_render_into_command_shape():
    result = simulate_macro(
        "G1 X{printer.toolhead.position[0]} F3000\n",
        printer_state={"toolhead.position": [12.5, 0, 0]})
    # The declared value renders as a REAL number — shape check must pass
    # (a literal 12.5 is a parseable X), unlike the <unknown> marker.
    assert any("X12.5" in r.text for r in result.rendered)
    assert not [f for f in result.findings
                if f.code == "macro_unknown_value"]


def test_printer_state_is_part_of_cache_key():
    """Cross-context isolation law: same body, different context — verdicts
    must not share a cached result."""
    a = simulate_macro(HOMED_COND_BODY,
                       printer_state={"toolhead.homed_axes": "xyz"})
    b = simulate_macro(HOMED_COND_BODY)
    c = simulate_macro(HOMED_COND_BODY,
                       printer_state={"toolhead.homed_axes": "xy"})
    assert [r.text for r in a.rendered] == ["G28"]
    assert len(b.rendered) == 2
    assert [r.text for r in c.rendered] == ["NOOP"]


# ── origin tagging for the consumption split (4R.2) ────────────────────────

def test_sim_finding_codes_constant_is_complete():
    assert {"macro_param_undefined", "macro_param_renders_empty",
            "macro_param_unparseable", "macro_unknown_value",
            "macro_render_blocked", "macro_render_unexplored"} \
        <= SIM_FINDING_CODES


def test_g1_post_render_advisory_carries_sim_origin_code():
    """The post-render G1 advisory shared its code with the STATIC scan, so
    consumers could not tell sim origin from static origin. It must not."""
    result = simulate_macro("G1 E10\n")
    codes = [f.code for f in result.findings]
    assert "macro_rendered_g1_no_feedrate" in codes
    assert "g1_extrude_no_feedrate" not in codes


def test_every_engine_emitted_code_is_sim_tagged():
    """Sweep: run a battery of finding-producing bodies and assert every
    emitted code is declared in SIM_FINDING_CODES (the static g1 scan runs
    outside the engine and is excluded by construction)."""
    bodies = [
        "SET_LED LED=x RED={params.RED} GREEN=0 BLUE=0\n",       # renders_empty
        '{% set s = params.S|float %}M104 S{s}\n',               # undefined
        "SET_LED LED=x RED=abc GREEN=0 BLUE=0\n",                # unparseable?
        "G1 E10\n",                                              # g1 advisory
        "{% for k in printer %}\nM117 x\n{% endfor %}\n",        # blocked
        "{% if printer.x %}\n" * 6 + "M117 deep\n"
        + "{% endif %}\n" * 6,                                   # unexplored
    ]
    for body in bodies:
        for f in simulate_macro(body).findings:
            assert f.code in SIM_FINDING_CODES, f
    # At least some of the battery must have produced findings, or this
    # sweep proves nothing (vacuity lever).
    total = sum(len(simulate_macro(b).findings) for b in bodies)
    assert total >= 3
