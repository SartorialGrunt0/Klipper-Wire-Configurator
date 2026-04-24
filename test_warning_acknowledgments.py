import os
import sys
import tempfile

sys.path.insert(0, 'backend')

from parser.config_parser import parse_config
from parser.validator import validate_config
from services.warning_acknowledgments import acknowledge_warning_for_section


def _validate(text: str):
    return validate_config(parse_config(text, 'printer.cfg'))


def test_autotune_tmc_is_valid_plugin_section():
    result = _validate('[autotune_tmc extruder]\nmotor: siboor-14sth20-1004a\n')
    assert not result.has_warnings
    assert not result.has_errors


def test_display_i2c_params_are_valid():
    result = _validate('[display]\nlcd_type: ssd1306\ni2c_mcu: host_mcu\ni2c_bus: i2c.1\n')
    assert not result.has_warnings
    assert not result.has_errors


def test_display_glyph_is_valid():
    result = _validate('[display_glyph feedrate]\ndata:\n  ................\n  ................\n')
    assert not result.has_warnings
    assert not result.has_errors


def test_display_analog_buttons_can_share_pin():
    result = _validate(
        '[display]\n'
        'lcd_type: hd44780\n'
        'rs_pin: gpio1\n'
        'e_pin: gpio2\n'
        'd4_pin: gpio3\n'
        'd5_pin: gpio4\n'
        'd6_pin: gpio5\n'
        'd7_pin: gpio6\n'
        'up_pin: gpio7\n'
        'analog_range_up_pin: 9000, 13000\n'
        'down_pin: gpio7\n'
        'analog_range_down_pin: 800, 1300\n'
        'click_pin: gpio7\n'
        'analog_range_click_pin: 2000, 2500\n'
        'back_pin: gpio7\n'
        'analog_range_back_pin: 4500, 5000\n'
    )
    assert not result.has_warnings
    assert not result.has_errors


def test_bltouch_lift_speed_is_valid():
    result = _validate('[bltouch]\nsensor_pin: ^P1.27\ncontrol_pin: P1.23\nlift_speed: 7\n')
    assert not result.has_warnings
    assert not result.has_errors


def test_tmc2130_diag1_pin_and_driver_sgt_are_valid():
    result = _validate(
        '[stepper_x]\n'
        'step_pin: gpio11\n'
        'dir_pin: !gpio10\n'
        'microsteps: 16\n'
        'rotation_distance: 40\n'
        'endstop_pin: ^gpio4\n'
        'position_endstop: 0\n'
        'position_max: 235\n\n'
        '[tmc2130 stepper_x]\n'
        'cs_pin: gpio9\n'
        'diag1_pin: ^!gpio3\n'
        'driver_SGT: -64\n'
        'run_current: 0.580\n'
    )
    assert not result.has_warnings
    assert not result.has_errors


def test_mcp4018_software_i2c_and_wiper_are_valid():
    result = _validate(
        '[mcp4018 my_digipot]\n'
        'i2c_software_scl_pin: gpio1\n'
        'i2c_software_sda_pin: gpio2\n'
        'wiper: 0.5\n'
    )
    assert not result.has_warnings
    assert not result.has_errors


def test_heater_fan_tachometer_pin_is_valid():
    result = _validate('[heater_fan hotend_fan]\npin: gpio5\ntachometer_pin: gpio16\n')
    assert not result.has_warnings
    assert not result.has_errors


def test_adc_temperature_series_params_are_valid():
    result = _validate(
        '[adc_temperature my_sensor]\n'
        'temperature1: 25\n'
        'voltage1: 0.500\n'
        'temperature2: 100\n'
        'voltage2: 1.200\n'
    )
    assert not result.has_warnings
    assert not result.has_errors


def test_temperature_sensor_adc_params_are_valid():
    result = _validate(
        '[temperature_sensor chamber]\n'
        'sensor_type: PT1000\n'
        'sensor_pin: gpio9\n'
        'adc_voltage: 5.0\n'
        'voltage_offset: 0\n'
    )
    assert not result.has_warnings
    assert not result.has_errors


def test_adc_scaled_pins_are_valid():
    result = _validate('[adc_scaled duet]\nvref_pin: gpio1\nvssa_pin: gpio2\n')
    assert not result.has_warnings
    assert not result.has_errors


def test_manual_stepper_full_steps_per_rotation_is_valid():
    result = _validate(
        '[manual_stepper selector]\n'
        'step_pin: gpio11\n'
        'dir_pin: gpio10\n'
        'microsteps: 16\n'
        'full_steps_per_rotation: 200\n'
        'rotation_distance: 40\n'
    )
    assert not result.has_warnings
    assert not result.has_errors


def test_probe_eddy_current_i2c_params_are_valid():
    result = _validate(
        '[probe_eddy_current my_eddy_probe]\n'
        'sensor_type: ldc1612\n'
        'descend_z: 2.0\n'
        'i2c_mcu: host\n'
        'i2c_bus: i2c.1\n'
    )
    assert not result.has_warnings
    assert not result.has_errors


def test_tmc5160_chain_params_are_valid():
    result = _validate(
        '[stepper_x]\n'
        'step_pin: gpio11\n'
        'dir_pin: !gpio10\n'
        'microsteps: 16\n'
        'rotation_distance: 40\n'
        'endstop_pin: ^gpio4\n'
        'position_endstop: 0\n'
        'position_max: 235\n\n'
        '[tmc5160 stepper_x]\n'
        'cs_pin: gpio9\n'
        'run_current: 0.580\n'
        'chain_position: 1\n'
        'chain_length: 4\n'
    )
    assert not result.has_warnings
    assert not result.has_errors


def test_tmc2130_driver_register_override_is_valid():
    result = _validate(
        '[stepper_x]\n'
        'step_pin: gpio11\n'
        'dir_pin: !gpio10\n'
        'microsteps: 16\n'
        'rotation_distance: 40\n'
        'endstop_pin: ^gpio4\n'
        'position_endstop: 0\n'
        'position_max: 235\n\n'
        '[tmc2130 stepper_x]\n'
        'cs_pin: gpio9\n'
        'run_current: 0.580\n'
        'driver_PWM_AMPL: 128\n'
    )
    assert not result.has_warnings
    assert not result.has_errors


def test_lis2dw_software_spi_params_are_valid():
    result = _validate(
        '[lis2dw]\n'
        'cs_pin: gpio21\n'
        'spi_software_sclk_pin: gpio18\n'
        'spi_software_mosi_pin: gpio19\n'
        'spi_software_miso_pin: gpio20\n'
    )
    assert not result.has_warnings
    assert not result.has_errors


def test_mcp4451_wiper_values_are_valid():
    result = _validate('[mcp4451 digipot]\nwiper_0: 0.5\nwiper_1: 0.6\n')
    assert not result.has_warnings
    assert not result.has_errors


def test_temperature_probe_horizontal_move_z_is_valid():
    result = _validate(
        '[temperature_probe chamber_probe]\n'
        'sensor_type: PT1000\n'
        'sensor_pin: gpio9\n'
        'horizontal_move_z: 5\n'
    )
    assert not result.has_warnings
    assert not result.has_errors


def test_shaketune_is_valid_plugin_section():
    result = _validate('[shaketune]\nkeep_raw_data: True\nshow_macros_in_webui: True\n')
    assert not result.has_warnings
    assert not result.has_errors


def test_commented_placeholder_section_is_ignored():
    result = _validate('#[stepper_]\n#step_pin: gpio11\n#dir_pin: gpio10\n')
    assert not result.has_warnings
    assert not result.has_errors


def test_unknown_section_warning_can_be_acknowledged():
    with tempfile.TemporaryDirectory() as temp_dir:
        os.environ['KWC_LAYOUT_DIR'] = temp_dir
        try:
            config = parse_config('[custom_plugin demo]\nfoo: bar\n', 'printer.cfg')

            before = validate_config(config)
            assert before.has_warnings
            assert any(error.severity == 'warning' for error in before.errors)

            acknowledge_warning_for_section(config.sections[0])

            after = validate_config(config)
            assert not after.has_warnings
        finally:
            del os.environ['KWC_LAYOUT_DIR']