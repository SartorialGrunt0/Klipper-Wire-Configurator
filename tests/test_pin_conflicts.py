import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config
from parser.validator import validate_config


def _validate(text: str):
    return validate_config(parse_config(text, 'printer.cfg'))


def _pin_conflict_warnings(result):
    return [e for e in result.errors if 'is used by multiple' in e.message]


def test_pin_conflict_anchors_to_first_section():
    result = _validate(
        '''
[stepper_x]
step_pin: PB0
dir_pin: !PB1
enable_pin: !PB2
microsteps: 16
rotation_distance: 40
endstop_pin: ^PB3
position_endstop: 0
position_max: 235

[stepper_y]
step_pin: PB0
dir_pin: !PB4
enable_pin: !PB5
microsteps: 16
rotation_distance: 40
endstop_pin: ^PB6
position_endstop: 0
position_max: 235
'''
    )

    warns = _pin_conflict_warnings(result)
    assert warns, "expected a pin-conflict warning"
    warn = warns[0]
    # Anchored to a real section so the gutter + node dot can render it.
    assert warn.section != '', "pin-conflict warning must be anchored to a section"
    assert warn.line_number > 0, "pin-conflict warning must carry a real line number"
    # First user (stepper_x.step_pin) is the anchor.
    assert warn.section == 'stepper_x'
    assert warn.param == 'step_pin'
    # The message still lists every user, not just the anchor.
    assert '[stepper_x] step_pin' in warn.message
    assert '[stepper_y] step_pin' in warn.message


def test_pin_conflict_anchors_to_param_line_not_section_header():
    result = _validate(
        '''
[stepper_x]
dir_pin: !PB1
step_pin: PB0
microsteps: 16
rotation_distance: 40
endstop_pin: ^PB3
position_endstop: 0
position_max: 235
enable_pin: !PB2

[stepper_y]
dir_pin: !PB4
step_pin: PB0
microsteps: 16
rotation_distance: 40
endstop_pin: ^PB6
position_endstop: 0
position_max: 235
enable_pin: !PB5
'''
    )

    warns = _pin_conflict_warnings(result)
    assert warns, "expected a pin-conflict warning"
    warn = warns[0]
    # The warning should sit on the step_pin line (the pin user), not the header.
    header_line = next(
        i + 1 for i, line in enumerate(result_text().split('\n'))
        if line.strip() == '[stepper_x]'
    )
    assert warn.line_number != header_line, "should anchor to the pin param line, not the header"
    assert warn.param == 'step_pin'


def result_text():
    return (
        '[stepper_x]\n'
        'dir_pin: !PB1\n'
        'step_pin: PB0\n'
        'microsteps: 16\n'
        'rotation_distance: 40\n'
        'endstop_pin: ^PB3\n'
        'position_endstop: 0\n'
        'position_max: 235\n'
        'enable_pin: !PB2\n'
        '\n'
        '[stepper_y]\n'
        'dir_pin: !PB4\n'
        'step_pin: PB0\n'
        'microsteps: 16\n'
        'rotation_distance: 40\n'
        'endstop_pin: ^PB6\n'
        'position_endstop: 0\n'
        'position_max: 235\n'
        'enable_pin: !PB5\n'
    )
