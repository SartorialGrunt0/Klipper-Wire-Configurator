import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config
from parser.validator import validate_config, validate_project_configs
from services.warning_acknowledgments import acknowledge_warning_for_section


def _validate(text: str):
    return validate_config(parse_config(text, 'printer.cfg'))


def _validate_project(files: dict[str, str]):
    return validate_project_configs({
        filename: parse_config(text, filename)
        for filename, text in files.items()
    })


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


def test_heater_fan_hardware_pwm_and_enable_pin_are_valid():
    result = _validate(
        '[heater_fan hotend_fan]\n'
        'pin: gpio5\n'
        'hardware_pwm: True\n'
        'enable_pin: gpio6\n'
    )
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


def test_temperature_sensor_common_thermistor_params_are_valid():
    result = _validate(
        '[temperature_sensor chamber]\n'
        'sensor_type: EPCOS 100K B57560G104F\n'
        'sensor_pin: gpio9\n'
        'pullup_resistor: 4700\n'
        'inline_resistor: 220\n'
    )
    assert not result.has_warnings
    assert not result.has_errors


def test_temperature_sensor_common_spi_params_are_valid():
    result = _validate(
        '[temperature_sensor chamber]\n'
        'sensor_type: MAX31855\n'
        'sensor_pin: gpio9\n'
        'spi_bus: spi2b\n'
    )
    assert not result.has_warnings
    assert not result.has_errors


def test_mcu_baud_is_invalid_with_canbus_uuid():
    result = _validate(
        '[mcu EBBCan]\n'
        'canbus_uuid: abc123\n'
        'baud: 250000\n'
    )

    assert any(
        error.param == 'baud'
        and "Cannot specify 'baud' when 'canbus_uuid' is set" in error.message
        for error in result.errors
    )


def test_temperature_host_sensor_type_must_be_unique():
    result = _validate(
        '[temperature_sensor host_cpu]\n'
        'sensor_type: temperature_host\n\n'
        '[temperature_sensor host_soc]\n'
        'sensor_type: temperature_host\n'
    )

    assert any(
        error.param == 'sensor_type'
        and "Only one [temperature_sensor] may use 'temperature_host'" in error.message
        for error in result.errors
    )


def test_temperature_mcu_sensor_type_must_be_unique_per_mcu():
    result = _validate(
        '[temperature_sensor main_mcu_1]\n'
        'sensor_type: temperature_mcu\n\n'
        '[temperature_sensor main_mcu_2]\n'
        'sensor_type: temperature_mcu\n'
    )

    assert any(
        error.param == 'sensor_type'
        and "Only one [temperature_sensor] may use 'temperature_mcu' for MCU 'mcu'" in error.message
        for error in result.errors
    )


def test_temperature_mcu_sensor_type_allows_distinct_target_mcus():
    result = _validate(
        '[mcu]\n'
        'serial: /dev/ttyACM0\n\n'
        '[mcu toolhead]\n'
        'canbus_uuid: abc123\n\n'
        '[temperature_sensor main_mcu]\n'
        'sensor_type: temperature_mcu\n\n'
        '[temperature_sensor toolhead_mcu]\n'
        'sensor_type: temperature_mcu\n'
        'sensor_mcu: toolhead\n'
    )

    assert not any(
        "Only one [temperature_sensor] may use 'temperature_mcu'" in error.message
        for error in result.errors
    )


def test_temperature_host_sensor_type_must_be_unique_across_active_project_files():
    results = _validate_project({
        'printer.cfg': (
            '[include extras.cfg]\n\n'
            '[temperature_sensor host_cpu]\n'
            'sensor_type: temperature_host\n'
        ),
        'extras.cfg': (
            '[temperature_sensor host_soc]\n'
            'sensor_type: temperature_host\n'
        ),
    })

    assert any(
        error.param == 'sensor_type'
        and "Only one [temperature_sensor] may use 'temperature_host'" in error.message
        for error in results['printer.cfg'].errors
    )
    assert any(
        error.param == 'sensor_type'
        and "Only one [temperature_sensor] may use 'temperature_host'" in error.message
        for error in results['extras.cfg'].errors
    )


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


def test_manual_stepper_gear_ratio_is_valid():
    result = _validate(
        '[manual_stepper selector]\n'
        'step_pin: gpio11\n'
        'dir_pin: gpio10\n'
        'microsteps: 16\n'
        'rotation_distance: 40\n'
        'gear_ratio: 80:20\n'
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


def test_temperature_probe_common_sensor_params_are_valid():
    result = _validate(
        '[temperature_probe chamber_probe]\n'
        'sensor_type: EPCOS 100K B57560G104F\n'
        'sensor_pin: gpio9\n'
        'pullup_resistor: 4700\n'
        'inline_resistor: 220\n'
    )
    assert not result.has_warnings
    assert not result.has_errors


def test_shared_software_spi_pins_are_valid():
    result = _validate(
        '[stepper_x]\n'
        'step_pin: gpio11\n'
        'dir_pin: !gpio10\n'
        'microsteps: 16\n'
        'rotation_distance: 40\n'
        'endstop_pin: ^gpio4\n'
        'position_endstop: 0\n'
        'position_max: 235\n\n'
        '[stepper_y]\n'
        'step_pin: gpio12\n'
        'dir_pin: !gpio13\n'
        'microsteps: 16\n'
        'rotation_distance: 40\n'
        'endstop_pin: ^gpio14\n'
        'position_endstop: 0\n'
        'position_max: 235\n\n'
        '[tmc2130 stepper_x]\n'
        'cs_pin: gpio9\n'
        'run_current: 0.580\n'
        'spi_software_sclk_pin: gpio20\n'
        'spi_software_mosi_pin: gpio21\n'
        'spi_software_miso_pin: gpio22\n\n'
        '[tmc2130 stepper_y]\n'
        'cs_pin: gpio8\n'
        'run_current: 0.580\n'
        'spi_software_sclk_pin: gpio20\n'
        'spi_software_mosi_pin: gpio21\n'
        'spi_software_miso_pin: gpio22\n'
    )
    assert not result.has_warnings
    assert not result.has_errors


def test_shared_software_i2c_pins_are_valid():
    result = _validate(
        '[mcp4018 pot_x]\n'
        'i2c_software_scl_pin: gpio1\n'
        'i2c_software_sda_pin: gpio2\n'
        'wiper: 0.5\n\n'
        '[mcp4018 pot_y]\n'
        'i2c_software_scl_pin: gpio1\n'
        'i2c_software_sda_pin: gpio2\n'
        'wiper: 0.6\n'
    )
    assert not result.has_warnings
    assert not result.has_errors


def test_generic_cartesian_sections_are_valid():
    result = _validate(
        '[printer]\n'
        'kinematics: generic_cartesian\n'
        'max_velocity: 300\n'
        'max_accel: 3000\n\n'
        '[carriage carriage_x]\n'
        'axis: x\n'
        'endstop_pin: ^gpio5\n'
        'position_endstop: 0\n'
        'position_max: 300\n\n'
        '[carriage carriage_y]\n'
        'axis: y\n'
        'endstop_pin: ^gpio6\n'
        'position_endstop: 0\n'
        'position_max: 200\n\n'
        '[extra_carriage carriage_y1]\n'
        'primary_carriage: carriage_y\n'
        'endstop_pin: ^gpio7\n\n'
        '[dual_carriage carriage_u]\n'
        'primary_carriage: carriage_x\n'
        'endstop_pin: ^gpio8\n'
        'position_endstop: 300\n'
        'position_max: 300\n\n'
        '[stepper drive_x]\n'
        'carriages: carriage_x+carriage_y\n'
        'step_pin: gpio11\n'
        'dir_pin: gpio10\n'
        'microsteps: 16\n'
        'rotation_distance: 40\n'
    )
    assert not result.has_warnings
    assert not result.has_errors


def test_menu_section_is_valid():
    result = _validate(
        '[menu __main __control __toolspeed]\n'
        'type: input\n'
        'enable: {True}\n'
        'name: Tool speed\n'
        'input: {0.5}\n'
        'input_min: 0\n'
        'input_max: 1\n'
        'input_step: 0.01\n'
        'gcode:\n'
        '    SET_PIN PIN=tool VALUE={menu.input}\n'
    )
    assert not result.has_warnings
    assert not result.has_errors


def test_board_helper_sections_are_valid():
    result = _validate(
        '[sx1509 duex]\n'
        'i2c_address: 62\n\n'
        '[samd_sercom sercom_i2c]\n'
        'sercom: sercom1\n'
        'tx_pin: toolboard:PA16\n'
        'clk_pin: toolboard:PA17\n\n'
        '[replicape]\n'
        'revision: B3\n'
        'host_mcu: host\n'
        'stepper_x_microstep_mode: spread16\n'
        'stepper_x_current: 0.5\n'
    )
    assert not result.has_warnings
    assert not result.has_errors


def test_lis3dh_common_i2c_params_are_valid():
    result = _validate('[lis3dh]\ni2c_mcu: toolboard\ni2c_bus: sercom1\n')
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


def test_duplicate_exact_stepper_section_across_active_files_is_warning():
    results = _validate_project({
        'printer.cfg': (
            '[include stepper-a.cfg]\n'
            '[include stepper-b.cfg]\n'
        ),
        'stepper-a.cfg': (
            '[stepper_z]\n'
            'step_pin: gpio11\n'
            'dir_pin: gpio10\n'
            'microsteps: 16\n'
            'rotation_distance: 40\n'
        ),
        'stepper-b.cfg': (
            '[stepper_z]\n'
            'step_pin: gpio21\n'
            'dir_pin: gpio20\n'
            'microsteps: 16\n'
            'rotation_distance: 40\n'
        ),
    })

    assert any(error.severity == 'warning' and 'Section [stepper_z] is reused across active included config files.' in error.message for error in results['stepper-a.cfg'].errors)
    assert any(error.severity == 'warning' and 'Section [stepper_z] is reused across active included config files.' in error.message for error in results['stepper-b.cfg'].errors)
    assert not results['printer.cfg'].has_errors


def test_stepper_z_and_stepper_z1_across_files_are_valid():
    results = _validate_project({
        'printer.cfg': (
            '[include stepper-z.cfg]\n'
            '[include stepper-z1.cfg]\n'
        ),
        'stepper-z.cfg': (
            '[stepper_z]\n'
            'step_pin: gpio11\n'
            'dir_pin: gpio10\n'
            'microsteps: 16\n'
            'rotation_distance: 40\n'
        ),
        'stepper-z1.cfg': (
            '[stepper_z1]\n'
            'step_pin: gpio21\n'
            'dir_pin: gpio20\n'
            'microsteps: 16\n'
            'rotation_distance: 40\n'
        ),
    })

    assert not results['printer.cfg'].has_errors
    assert not results['stepper-z.cfg'].has_errors
    assert not results['stepper-z1.cfg'].has_errors


def test_duplicate_reused_section_in_orphan_file_is_ignored():
    results = _validate_project({
        'printer.cfg': '[include active-z.cfg]\n',
        'active-z.cfg': (
            '[stepper_z]\n'
            'step_pin: gpio11\n'
            'dir_pin: gpio10\n'
            'microsteps: 16\n'
            'rotation_distance: 40\n'
        ),
        'orphan-z.cfg': (
            '[stepper_z]\n'
            'step_pin: gpio21\n'
            'dir_pin: gpio20\n'
            'microsteps: 16\n'
            'rotation_distance: 40\n'
        ),
    })

    assert not results['printer.cfg'].has_errors
    assert not results['active-z.cfg'].has_warnings
    assert not results['orphan-z.cfg'].has_warnings
