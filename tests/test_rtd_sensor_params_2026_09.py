"""RTD/TC sensor-family params are valid on EVERY sensor_type section (2026-09-07).

Ground truth: heaters.py Heater.__init__ -> setup_sensor(config) (heaters.py:280-300)
instantiates the sensor factory with the SAME section config, so an SPI sensor
class reads its own params directly from [extruder]/[heater_bed]/etc.
spi_temperature.py MAX31865 reads rtd_nominal_r / rtd_reference_r (:285-286),
rtd_use_50Hz_filter (:334) and rtd_num_of_wires (:336); MAX31856 reads tc_type,
tc_use_50Hz_filter and tc_averaging_count. The stock sample
printer-modix-big60-2020.cfg uses all four rtd_* params under [extruder] and
[extruder1] with sensor_type: MAX31865 — KWC false-errored 8 unknown_param
findings on it.

Scope note: only sections whose sensor_type accepts the generic SENSOR_TYPE_ENUM
(and therefore MAX31865/MAX31856) gain the family. Sections with fixed sensor
enums ([angle], [load_cell], [probe_eddy_current], [load_cell_probe]) cannot
host an RTD chip and must NOT accept these params.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config  # noqa: E402
from parser.config_schema import SECTION_DEFS, SENSOR_TYPE_ENUM  # noqa: E402
from parser.validator import validate_config  # noqa: E402


RTD_TC_PARAMS = [
    "rtd_nominal_r",
    "rtd_reference_r",
    "rtd_num_of_wires",
    "rtd_use_50Hz_filter",
    "tc_type",
    "tc_use_50Hz_filter",
    "tc_averaging_count",
]


def _validate(text: str):
    return validate_config(parse_config(text, 'printer.cfg'))


def _unknown_params(result):
    return [e for e in result.errors if e.code == "unknown_param"]


# ── 1. [extruder] with MAX31865 (modix-big60 shape) validates clean ────

def test_extruder_max31865_rtd_params_accepted():
    text = """
[printer]
kinematics: cartesian
max_velocity: 300
max_accel: 3000
max_z_velocity: 15
max_z_accel: 100

[extruder]
step_pin: PD5
dir_pin: PA1
enable_pin: !PC6
microsteps: 256
rotation_distance: 22.9344
nozzle_diameter: 0.400
filament_diameter: 1.750
heater_pin: !PA20
sensor_type: MAX31865
spi_bus: usart0
sensor_pin: PB2
rtd_nominal_r: 100
rtd_reference_r: 400
rtd_num_of_wires: 3
rtd_use_50Hz_filter: True
min_temp: 0
max_temp: 350
"""
    result = _validate(text)
    assert _unknown_params(result) == [], (
        f"MAX31865 RTD params under [extruder] must be known: {_unknown_params(result)}"
    )


# ── 2.heater-family + other generic-sensor sections carry the family ───

def test_sensor_sections_carry_rtd_tc_params():
    generic_sections = [
        "extruder",
        "extruder1",
        "heater_bed",
        "heater_generic",
        "temperature_fan",
        "temperature_sensor",
        "z_thermal_adjust",
    ]
    for sec in generic_sections:
        names = {p.name for p in SECTION_DEFS[sec].params}
        for param in RTD_TC_PARAMS:
            assert param in names, f"{sec} is missing sensor-family param '{param}'"


def test_max31856_tc_params_accepted_on_heater_generic():
    text = """
[heater_generic heater_chamber]
heater_pin: PF6
sensor_type: MAX31856
spi_bus: spi1
sensor_pin: PB2
tc_type: K
tc_use_50Hz_filter: True
tc_averaging_count: 4
max_power: 1.0
min_temp: 0
max_temp: 90
control: pid
pid_Kp: 50
pid_Ki: 1
pid_Kd: 10
"""
    result = _validate(text)
    assert _unknown_params(result) == [], (
        f"MAX31856 TC params under [heater_generic] must be known: {_unknown_params(result)}"
    )


# ── 3. Positive controls: genuinely unknown params still flagged ───────

def test_bogus_param_on_extruder_still_flagged():
    text = """
[printer]
kinematics: cartesian
max_velocity: 300
max_accel: 3000
max_z_velocity: 15
max_z_accel: 100

[extruder]
step_pin: PD5
dir_pin: PA1
microsteps: 16
rotation_distance: 22.9344
nozzle_diameter: 0.400
filament_diameter: 1.750
heater_pin: !PA20
sensor_type: MAX31865
spi_bus: usart0
sensor_pin: PB2
rtd_nominal_r: 100
rtd_bogus_r: 400
min_temp: 0
max_temp: 350
"""
    result = _validate(text)
    flagged = [e for e in _unknown_params(result) if "rtd_bogus_r" in e.message]
    assert len(flagged) == 1, "a param outside the sensor family must still be unknown_param"


def test_fixed_enum_sections_do_not_carry_rtd_params():
    # [angle] (a1333/as5047d/tle5012b) and [load_cell] (HX711/...) cannot host
    # an RTD chip — accepting rtd_* there would be a false NEGATIVE.
    for sec in ("angle", "load_cell", "probe_eddy_current"):
        names = {p.name for p in SECTION_DEFS[sec].params}
        assert "rtd_nominal_r" not in names, (
            f"{sec} has a fixed sensor_type enum and must NOT accept RTD params"
        )


# ── 4. Bounds carried with the family (spi_temperature.py getfloat above=0) ──

def test_rtd_bounds_match_klipper():
    params = {p.name: p for p in SECTION_DEFS["extruder"].params}
    assert params["rtd_nominal_r"].strict_above == "0" or float(params["rtd_nominal_r"].strict_above) == 0.0
    assert params["rtd_reference_r"].strict_above is not None
    assert params["rtd_num_of_wires"].min_val is None or int(params["rtd_num_of_wires"].min_val) <= 0


# ── 5. tc_type / tc_averaging_count are getchoice-read: invalid values are
#       config-load hard-fails (spi_temperature.py:165-184, configfile.py:84) ──

def test_invalid_tc_type_is_error():
    text = """
[heater_generic chamber]
heater_pin: PF6
sensor_type: MAX31856
spi_bus: spi1
sensor_pin: PB2
tc_type: Z
max_power: 1.0
min_temp: 0
max_temp: 90
"""
    result = _validate(text)
    errs = [e for e in result.errors
            if e.severity == "error" and e.param == "tc_type"]
    assert len(errs) == 1, f"tc_type Z is not a getchoice value — must error: {result.errors}"


def test_invalid_tc_averaging_count_is_error():
    text = """
[heater_generic chamber]
heater_pin: PF6
sensor_type: MAX31856
spi_bus: spi1
sensor_pin: PB2
tc_type: K
tc_averaging_count: 3
max_power: 1.0
min_temp: 0
max_temp: 90
"""
    result = _validate(text)
    errs = [e for e in result.errors
            if e.severity == "error" and e.param == "tc_averaging_count"]
    assert len(errs) == 1, f"tc_averaging_count 3 is not a getchoice value — must error: {result.errors}"


def test_temperature_probe_tc_params_are_enums():
    # temperature_probe carries its own copy of the RTD/TC family.
    params = {p.name: p for p in SECTION_DEFS["temperature_probe"].params}
    assert params["tc_type"].enum_values == ["B", "E", "J", "K", "N", "R", "S", "T"]
    assert params["tc_averaging_count"].enum_values == ["1", "2", "4", "8", "16"]


# ── 6. spi_speed is read unconditionally by bus.py MCU_SPI_from_config ──

def test_spi_speed_accepted_on_extruder_and_temperature_sensor():
    for sec in ("extruder", "temperature_sensor"):
        names = {p.name for p in SECTION_DEFS[sec].params}
        assert "spi_speed" in names, f"{sec} must accept spi_speed (bus.py:137)"
    text = """
[temperature_sensor rtd_probe]
sensor_type: MAX31865
spi_bus: spi1
spi_speed: 500000
sensor_pin: PB2
rtd_nominal_r: 100
rtd_reference_r: 400
min_temp: 0
max_temp: 300
"""
    result = _validate(text)
    assert _unknown_params(result) == [], (
        f"spi_speed under [temperature_sensor] must be known: {_unknown_params(result)}"
    )
