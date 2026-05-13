import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config, ConfigFile
from parser.config_writer import smart_export
from parser.validator import validate_config

def test_required_param_can_come_from_save_config():
    config = parse_config(
        '''
[printer]
kinematics: delta
max_velocity: 150
max_accel: 1200

#*# <---------------------- SAVE_CONFIG ---------------------->
#*# [printer]
#*# delta_radius = 63.254587
'''.lstrip(),
        'printer.cfg',
    )

    result = validate_config(config)

    assert not any(error.param == 'delta_radius' for error in result.errors)


def test_smart_export_preserves_save_config_tail_when_last_section_removed():
    original = '''
[printer]
kinematics: cartesian
max_velocity: 300
max_accel: 3000

[gcode_macro TEST]
gcode:
  M117 hello

#*# <---------------------- SAVE_CONFIG ---------------------->
#*# [printer]
#*# max_accel = 3500
'''.lstrip()

    parsed = parse_config(original, 'printer.cfg')
    rebuilt = ConfigFile(
        filename=parsed.filename,
        sections=[section for section in parsed.sections if section.full_header != 'gcode_macro TEST'],
        includes=parsed.includes,
        header_comments=parsed.header_comments,
        raw_text=parsed.raw_text,
    )

    exported = smart_export(rebuilt)

    assert '[gcode_macro TEST]' not in exported
    assert '#*# <---------------------- SAVE_CONFIG ---------------------->' in exported
    assert '#*# max_accel = 3500' in exported


def test_smart_export_keeps_commented_gcode_lines_when_following_section_removed():
    original = '''
[gcode_macro TEST]
gcode:
  M117 hello
#    {% if printer.idle_timeout.state == "Idle" %}
#    POWER_OFF_PRINTER
#    {% endif %}

[idle_timeout]
timeout: 30
'''.lstrip()

    parsed = parse_config(original, 'printer.cfg')

    macro_section = next(section for section in parsed.sections if section.full_header == 'gcode_macro TEST')
    idle_timeout = next(section for section in parsed.sections if section.full_header == 'idle_timeout')

    assert '#    POWER_OFF_PRINTER' in macro_section.params[0].value
    assert idle_timeout.header_comments == []

    rebuilt = ConfigFile(
        filename=parsed.filename,
        sections=[section for section in parsed.sections if section.full_header != 'idle_timeout'],
        includes=parsed.includes,
        header_comments=parsed.header_comments,
        raw_text=parsed.raw_text,
    )

    exported = smart_export(rebuilt)

    assert '[idle_timeout]' not in exported
    assert '#    {% if printer.idle_timeout.state == "Idle" %}' in exported
    assert '#    POWER_OFF_PRINTER' in exported
    assert '#    {% endif %}' in exported