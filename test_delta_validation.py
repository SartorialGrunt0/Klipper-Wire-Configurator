import sys

sys.path.insert(0, 'backend')

from parser.config_parser import parse_config
from parser.validator import validate_config


def _validate(text: str):
    return validate_config(parse_config(text, 'printer.cfg'))


def test_delta_round_bed_mesh_config_matches_reference():
    result = _validate(
        '''
[printer]
kinematics: delta
max_velocity: 150
max_accel: 1200
max_z_velocity: 100
minimum_z_position: -10.0
delta_radius: 63.00

[probe]
pin: ^PB7

[bed_mesh]
speed: 50
horizontal_move_z: 5
mesh_radius: 50
round_probe_count: 5
fade_start: 1.0
fade_end: 0.0

[display_status]
'''
    )

    assert not result.has_errors
    assert not result.has_warnings


def test_delta_printer_requires_delta_radius():
    result = _validate(
        '''
[printer]
kinematics: delta
max_velocity: 150
max_accel: 1200
'''
    )

    assert any(error.param == 'delta_radius' for error in result.errors)


def test_rectangular_bed_mesh_still_requires_mesh_min_and_mesh_max():
    result = _validate(
        '''
[probe]
pin: ^PB7

[bed_mesh]
speed: 50
horizontal_move_z: 5
'''
    )

    missing = {(error.section, error.param) for error in result.errors}
    assert ('bed_mesh', 'mesh_min') in missing
    assert ('bed_mesh', 'mesh_max') in missing


def test_general_required_params_still_fail():
    result = _validate(
        '''
[bltouch]
sensor_pin: ^P1.27
'''
    )

    assert any(error.param == 'control_pin' for error in result.errors)


def test_shared_tmc_uart_bus_does_not_warn():
    result = _validate(
        '''
[stepper_x]
step_pin: gpio11
dir_pin: !gpio10
microsteps: 16
rotation_distance: 40
endstop_pin: ^gpio4
position_endstop: 0
position_max: 235

[tmc2209 stepper_x]
uart_pin: gpio9
tx_pin: gpio8
uart_address: 0
run_current: 0.580

[stepper_y]
step_pin: gpio6
dir_pin: !gpio5
microsteps: 16
rotation_distance: 40
endstop_pin: ^gpio3
position_endstop: 0
position_max: 235

[tmc2209 stepper_y]
uart_pin: gpio9
tx_pin: gpio8
uart_address: 2
run_current: 0.580
'''
    )

    assert not any('gpio9' in error.message or 'gpio8' in error.message for error in result.errors)


def test_shared_stepper_enable_pin_does_not_warn():
    result = _validate(
        '''
[stepper_a]
step_pin: gpio11
dir_pin: !gpio10
enable_pin: !PB10
microsteps: 16
rotation_distance: 40

[stepper_b]
step_pin: gpio6
dir_pin: !gpio5
enable_pin: !PB10
microsteps: 16
rotation_distance: 40

[stepper_c]
step_pin: gpio19
dir_pin: gpio28
enable_pin: !PB10
microsteps: 16
rotation_distance: 40
'''
    )

    assert not any('PB10' in error.message and 'enable_pin' in error.message for error in result.errors)


def test_bed_mesh_dependency_accepts_probe_family_sections():
    result = _validate(
        '''
[smart_effector]
pin: ^P1.27

[bed_mesh]
mesh_radius: 50
'''
    )

    assert not any('requires [probe]' in error.message for error in result.errors)


def test_lpc_pin_formats_do_not_warn():
    result = _validate(
        '''
[stepper_x]
step_pin: P1.4
dir_pin: !P1.8
enable_pin: !P1.0
microsteps: 16
rotation_distance: 40
endstop_pin: ^P1.29
position_endstop: 0
position_max: 235

[tmc2209 stepper_x]
uart_pin: P1.1
run_current: 0.580

[bltouch]
sensor_pin: ^P1.27
control_pin: P1.23
'''
    )

    assert not any(error.message.startswith("Pin format '") for error in result.errors)