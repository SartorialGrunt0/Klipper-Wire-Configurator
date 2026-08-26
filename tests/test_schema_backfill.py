"""
Schema param-coverage backfill (Phase 3 tasks 3j / 3k / 3l).

These are schema-DATA assertions: each named section must model the params
Klipper actually reads for it (ground truth from ~/klipper/klippy/extras).
Missing params surface today only as suppressible "Unknown parameter" warnings,
so real configs that set them validate clean only by luck.

All assertions are presence-based (not full-list) so they stay robust to
reordering, and every section is checked for duplicate param names (a backfill
bug that would silently double-define a param).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from parser.config_schema import SECTION_DEFS  # noqa: E402


def _params(sec_type: str) -> set:
    sd = SECTION_DEFS.get(sec_type)
    assert sd is not None, f"section type '{sec_type}' is not in SECTION_DEFS"
    return {p.name for p in sd.params}


def _assert_no_dups(sec_type: str):
    sd = SECTION_DEFS.get(sec_type)
    if sd is None:
        return
    names = [p.name for p in sd.params]
    dupes = {n for n in names if names.count(n) > 1}
    assert not dupes, f"[{sec_type}] duplicate param names: {sorted(dupes)}"


def _present(sec_type: str, *names):
    have = _params(sec_type)
    missing = [n for n in names if n not in have]
    assert not missing, (
        f"[{sec_type}] missing expected params {missing}; "
        f"has {sorted(have)}"
    )


# ── 3j: temperature_probe backfill ─────────────────────────────────────────
def test_temperature_probe_probe_params():
    # temperature_probe.py reads these directly
    _present(
        "temperature_probe",
        "gcode_id", "speed", "resting_z",
        "calibration_position", "calibration_bed_temp",
        "calibration_extruder_temp", "extruder_heating_z",
        "max_validation_temp", "calibration_temp",
        "drift_calibration", "drift_calibration_min_temp",
    )
    _assert_no_dups("temperature_probe")


def test_temperature_probe_bus_family():
    # temperature_probe may use SPI sensors (MAXxxxxx) or I2C sensors (BME280, etc)
    _present(
        "temperature_probe",
        "spi_bus", "spi_speed", "spi_software_sclk_pin",
        "spi_software_mosi_pin", "spi_software_miso_pin",
        "i2c_mcu", "i2c_address", "i2c_speed", "i2c_bus",
        "i2c_software_scl_pin", "i2c_software_sda_pin",
    )
    _assert_no_dups("temperature_probe")


# ── 3j: I2C bus family on the I2C bus sections ─────────────────────────────
def test_i2c_sections_have_full_bus_family():
    for sec in ["mcp4018", "mcp4451", "mcp4728", "pca9533", "pca9632"]:
        _present(
            sec,
            "i2c_mcu", "i2c_address", "i2c_speed", "i2c_bus",
            "i2c_software_scl_pin", "i2c_software_sda_pin",
        )
        _assert_no_dups(sec)


# ── 3j: SPI bus family on the SPI bus sections ─────────────────────────────
def test_spi_sections_have_full_bus_family():
    # ad5206 is SPI-only (MCU_SPI_from_config)
    _present(
        "ad5206",
        "cs_pin", "spi_speed", "spi_bus",
        "spi_software_sclk_pin", "spi_software_mosi_pin", "spi_software_miso_pin",
    )
    _assert_no_dups("ad5206")
    # angle is SPI (as5047d/tle5012b/a1333) and already carried the family
    _present(
        "angle",
        "cs_pin", "spi_speed", "spi_bus",
        "spi_software_sclk_pin", "spi_software_mosi_pin", "spi_software_miso_pin",
    )
    _assert_no_dups("angle")


def test_load_cell_supports_ads1220_spi():
    # load_cell sensor_type ADS1220 is driven over SPI (ads1220.py)
    _present("load_cell", "spi_bus", "cs_pin", "spi_speed")
    _assert_no_dups("load_cell")


# ── 3k: probe-inherited params ─────────────────────────────────────────────
def test_smart_effector_probe_inherited_params():
    # smart_effector wraps ProbeEndstopWrapper + ProbeOffsetsHelper +
    # ProbeParameterHelper, so it reads the standard probe params.
    _present(
        "smart_effector",
        "lift_speed", "sample_retract_dist", "samples_result",
        "samples_tolerance", "samples_tolerance_retries",
        "deactivate_on_each_sample", "activate_gcode", "deactivate_gcode",
    )
    _assert_no_dups("smart_effector")


def test_probe_eddy_current_probe_inherited_params():
    # probe_eddy_current wraps EddyParameterHelper(=ProbeParameterHelper) +
    # EddyProbeOffsets. It is an ANALOG probe (no endstop pin, no
    # deactivate_on_each_sample / activate / deactivate gcode), so it inherits
    # only the sampling params plus its own tap-calibration params.
    _present(
        "probe_eddy_current",
        "lift_speed", "sample_retract_dist", "samples_result",
        "samples_tolerance", "samples_tolerance_retries", "samples",
        "tap_threshold", "tap_z_offset",
    )
    _assert_no_dups("probe_eddy_current")


# ── 3l: previously-missing doc-listed sections ─────────────────────────────
def test_display_template_and_data_registered():
    for sec in ["display_template", "display_data"]:
        assert sec in SECTION_DEFS, f"{sec} not in SECTION_DEFS"
        _assert_no_dups(sec)
    # display_template carries a Jinja body in 'text' (+ param_* wildcards)
    _present("display_template", "text")
    _assert_no_dups("display_template")
    # display_data items carry position (row,col) + a 'text' template
    _present("display_data", "position", "text")
    _assert_no_dups("display_data")


def test_static_pwm_clock_registered():
    assert "static_pwm_clock" in SECTION_DEFS
    _present("static_pwm_clock", "pin", "frequency")
    _assert_no_dups("static_pwm_clock")
    sd = SECTION_DEFS["static_pwm_clock"]
    pin = next(p for p in sd.params if p.name == "pin")
    assert pin.required, "static_pwm_clock.pin must be required"


def test_load_cell_probe_registered():
    # load_cell_probe is an ANALOG probe (trigger_analog, no endstop pin). It
    # wraps LoadCellParameterHelper(=ProbeParameterHelper) + ProbeOffsetsHelper
    # + LoadCellProbeConfigHelper (trigger_force / force_safety_limit).
    assert "load_cell_probe" in SECTION_DEFS
    _present("load_cell_probe", "sensor_type", "z_offset", "speed", "samples",
             "trigger_force", "force_safety_limit", "lift_speed")
    _assert_no_dups("load_cell_probe")
    sd = SECTION_DEFS["load_cell_probe"]
    st = next(p for p in sd.params if p.name == "sensor_type")
    assert st.required, "load_cell_probe.sensor_type must be required"
    assert "pin" not in _params("load_cell_probe"), "analog probe has no endstop pin"


def test_filament_width_sensors_registered():
    assert "hall_filament_width_sensor" in SECTION_DEFS
    _present("hall_filament_width_sensor", "adc1", "adc2",
             "default_nominal_filament_diameter", "measurement_delay",
             "max_difference")
    _assert_no_dups("hall_filament_width_sensor")

    assert "tsl1401cl_filament_width_sensor" in SECTION_DEFS
    _present("tsl1401cl_filament_width_sensor", "pin",
             "default_nominal_filament_diameter", "measurement_delay",
             "max_difference")
    _assert_no_dups("tsl1401cl_filament_width_sensor")


# ── 3l: tmc2660 driver_* wildcard (parity with the other TMC SPI drivers) ──
def test_tmc2660_driver_wildcard():
    _present("tmc2660", "driver_*")
    _assert_no_dups("tmc2660")


# ── global guard: no section defines a param twice ─────────────────────────
def test_no_duplicate_params_anywhere():
    bad = {}
    for sec_type, sd in SECTION_DEFS.items():
        names = [p.name for p in sd.params]
        dupes = {n for n in names if names.count(n) > 1}
        if dupes:
            bad[sec_type] = sorted(dupes)
    assert not bad, f"sections with duplicate param names: {bad}"
