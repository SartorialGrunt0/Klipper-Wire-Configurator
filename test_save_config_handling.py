import sys

sys.path.insert(0, 'backend')

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