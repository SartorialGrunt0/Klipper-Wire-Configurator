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


def test_bltouch_lift_speed_is_valid():
    result = _validate('[bltouch]\nsensor_pin: ^P1.27\ncontrol_pin: P1.23\nlift_speed: 7\n')
    assert not result.has_warnings
    assert not result.has_errors


def test_shaketune_is_valid_plugin_section():
    result = _validate('[shaketune]\nkeep_raw_data: True\nshow_macros_in_webui: True\n')
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