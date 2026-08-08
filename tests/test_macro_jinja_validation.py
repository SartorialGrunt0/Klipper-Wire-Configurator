import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config
from parser.validator import validate_config


def _validate(text: str):
    return validate_config(parse_config(text, 'printer.cfg'))


def _macro_errors(result):
    return [
        (e.section, e.param, e.severity, e.line_number, e.message)
        for e in result.errors
        if e.param == 'gcode' and 'Jinja template error' in e.message
    ]


def test_balanced_macro_passes():
    result = _validate('''
[gcode_macro LEVEL_BED]
description: test
gcode:
    {% if printer.quad_gantry_level is defined %}
        G28
        BED_MESH_CALIBRATE ADAPTIVE=1
    {% endif %}
''')
    assert _macro_errors(result) == []


def test_klipper_single_brace_syntax_passes():
    # Klipper macros use {var} not {{var}} — must not false-positive.
    result = _validate('''
[gcode_macro REPORT_PROBE]
description: report probe offset
gcode:
    {% set p = printer.configfile.settings.probe %}
    M118 Probe offset: { p.x_offset }, { p.y_offset }
    G28
''')
    assert _macro_errors(result) == []


def test_missing_endif_is_error():
    # The exact failure Clifford hit: the model kept {% if %} but dropped
    # {% endif %} while rewriting a macro.
    result = _validate('''
[gcode_macro LEVEL_BED]
description: test
gcode:
    {% if printer.quad_gantry_level is defined %}
        G28
        BED_MESH_CALIBRATE ADAPTIVE=1
''')
    errors = _macro_errors(result)
    assert len(errors) == 1
    section, param, severity, line_number, message = errors[0]
    assert section == 'gcode_macro LEVEL_BED'
    assert param == 'gcode'
    assert severity == 'error'
    assert 'endif' in message
    # Points at a line inside the macro body (gcode: key is line 4).
    assert line_number >= 4


def test_unbalanced_for_endfor_is_error():
    result = _validate('''
[gcode_macro LOOP]
description: test
gcode:
    {% for i in range(3) %}
        M118 loop { i }
''')
    errors = _macro_errors(result)
    assert len(errors) == 1
    assert 'endfor' in errors[0][4]


def test_delayed_gcode_is_validated():
    result = _validate('''
[delayed_gcode HEAT_SOAK]
gcode:
    {% if printer.extruder.temperature < 250 %}
        M118 still heating
''')
    assert len(_macro_errors(result)) == 1


def test_commented_out_macro_skipped():
    result = _validate('''
#[gcode_macro LEVEL_BED]
#description: test
#gcode:
#    {% if x %}
#        G28
''')
    assert _macro_errors(result) == []


def test_no_gcode_param_skipped():
    result = _validate('''
[gcode_macro LEVEL_BED]
description: test only, no gcode
''')
    assert _macro_errors(result) == []


def test_comment_lines_inside_body_do_not_break_validation():
    # Full-line comments inside the body are literal text to Jinja and must
    # not be mistaken for template structure.
    result = _validate('''
[gcode_macro LEVEL_BED]
description: test
gcode:
    # Home first, then calibrate
    G28
    {% if printer.quad_gantry_level is defined %}
        BED_MESH_CALIBRATE ADAPTIVE=1
    {% endif %}
''')
    assert _macro_errors(result) == []


def test_inline_comment_inside_set_expression_passes():
    # Community macros put trailing # comments inside multi-line {% set %}
    # expressions (e.g. mainsail.cfg RESUME). Klipper strips inline #/;
    # comments from every config line before templating, so this is valid on
    # a real printer and must not false-positive here.
    result = _validate('''
[gcode_macro RESUME]
description: test
gcode:
    {% set runout_resume = True if client.runout_sensor|default("") == ""     # no runout
                  else True if not printer[client.runout_sensor].enabled  # sensor is disabled
                  else printer[client.runout_sensor].filament_detected %} # sensor status
    G28
''')
    assert _macro_errors(result) == []


def test_inline_semicolon_gcode_comment_passes():
    result = _validate('''
[gcode_macro LEVEL_BED]
description: test
gcode:
    G28 ; home all axes
    {% if x %}
        BED_MESH_CALIBRATE ADAPTIVE=1
    {% endif %}
''')
    assert _macro_errors(result) == []


def test_missing_endif_still_detected_with_comments():
    # The dropped {% endif %} must still be caught even when the body has
    # inline comments (comment stripping must not mask real errors).
    result = _validate('''
[gcode_macro LEVEL_BED]
description: test
gcode:
    G28 ; home all axes
    {% if printer.quad_gantry_level is defined %}
        BED_MESH_CALIBRATE ADAPTIVE=1
''')
    errors = _macro_errors(result)
    assert len(errors) == 1
    assert 'endif' in errors[0][4]


def test_semicolon_inside_jinja_expression_passes():
    # Klipper's own sample-macros.cfg M117 macro calls
    # rawparams.split(';', 1) — the semicolon is inside a jinja string and
    # configparser only treats ';' as a comment when preceded by whitespace.
    result = _validate('''
[gcode_macro M117]
rename_existing: M117.1
gcode:
  {% if rawparams %}
    {% set escaped_msg = rawparams.split(';', 1)[0].split('\\x23', 1)[0]|replace('"', '\\\\"') %}
    SET_DISPLAY_TEXT MSG="{escaped_msg}"
  {% else %}
    SET_DISPLAY_TEXT MSG="M117"
  {% endif %}
''')
    assert _macro_errors(result) == []
