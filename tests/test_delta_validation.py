import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

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


def test_bed_screws_supports_additional_numbered_screws():
    result = _validate(
        '''
[bed_screws]
screw1: 0, 0
screw2: 100, 0
screw3: 100, 100
screw4: 0, 100
screw5: 50, 50
screw5_name: center
screw5_fine_adjust: 55, 55
'''
    )

    assert not result.has_errors
    assert not any(error.param == 'screw5' for error in result.errors)
    assert not any(error.param == 'screw5_name' for error in result.errors)
    assert not any(error.param == 'screw5_fine_adjust' for error in result.errors)


def test_bed_screws_requires_at_least_three_screws():
    result = _validate(
        '''
[bed_screws]
screw1: 0, 0
screw2: 100, 0
'''
    )

    assert any(error.message == 'bed_screws: Must have at least three screws' for error in result.errors)


def test_screws_tilt_adjust_supports_additional_numbered_screws():
    result = _validate(
        '''
[probe]
pin: gpio1

[screws_tilt_adjust]
screw1: 0, 0
screw2: 100, 0
screw3: 100, 100
screw4: 0, 100
screw5: 50, 50
screw5_name: center
'''
    )

    assert not result.has_errors
    assert not any(error.param == 'screw5' for error in result.errors)
    assert not any(error.param == 'screw5_name' for error in result.errors)


def test_screws_tilt_adjust_requires_at_least_three_screws():
    result = _validate(
        '''
[probe]
pin: gpio1

[screws_tilt_adjust]
screw1: 0, 0
screw2: 100, 0
'''
    )

    assert any(error.message == 'screws_tilt_adjust: Must have at least three screws' for error in result.errors)


def test_rotary_delta_lettered_steppers_accept_rotary_delta_parameters():
    result = _validate(
        '''
[printer]
kinematics: rotary_delta
max_velocity: 300
max_accel: 3000
shoulder_radius: 33.900
shoulder_height: 412.900

[stepper_a]
step_pin: PF0
dir_pin: PF1
microsteps: 16
gear_ratio: 107.000:16, 60:16
position_endstop: 252
upper_arm_length: 170.000
lower_arm_length: 320.000

[stepper_b]
step_pin: PF6
dir_pin: PF7
microsteps: 16
gear_ratio: 107.000:16, 60:16

[stepper_c]
step_pin: PL3
dir_pin: PL1
microsteps: 16
gear_ratio: 107.000:16, 60:16
'''
    )

    assert not result.has_errors
    assert not result.has_warnings


def test_winch_lettered_stepper_sections_are_recognized_beyond_stepper_c():
    result = _validate(
        '''
[printer]
kinematics: winch
max_velocity: 300
max_accel: 3000

[stepper_d]
step_pin: PC1
dir_pin: PC3
microsteps: 16
rotation_distance: 40
anchor_x: 0
anchor_y: 0
anchor_z: 3000
'''
    )

    assert not result.has_errors
    assert not result.has_warnings


def test_tmc2660_spi_bus_is_not_treated_as_a_gpio_pin():
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

[tmc2660 stepper_x]
cs_pin: gpio9
spi_bus: usart1
run_current: 0.580
sense_resistor: 0.110

[stepper_y]
step_pin: gpio6
dir_pin: !gpio5
microsteps: 16
rotation_distance: 40
endstop_pin: ^gpio3
position_endstop: 0
position_max: 235

[tmc2660 stepper_y]
cs_pin: gpio8
spi_bus: usart1
run_current: 0.580
sense_resistor: 0.110
'''
    )

    assert not any('usart1' in error.message for error in result.errors)