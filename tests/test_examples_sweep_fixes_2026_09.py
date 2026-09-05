"""Seven false-positive fixes from the klipper/config examples sweep (2026-09-04).

Ground truth for each is klipper master (f0892d82) source + headless klippy
fixtures (recipes in kwc-validation skill, references/klipper-examples-audit-2026-09-04.md):

1. sensor_type enum — user-defined [thermistor NAME] sections are valid
   sensor_type values (Config_Reference: "if one defines a
   [thermistor my_thermistor] section then one may use sensor_type:
   my_thermistor"). Fixture fx2/a_therm.cfg reaches 'Starting serial
   connect'; an undefined name is a Config error.
2. TMC driver for [manual_stepper <name>] — klippy joins ALL header words
   after the driver type (tmc.py TMCMicrostepHelper: " ".join(...)), so
   [tmc2208 manual_stepper gear_stepper] resolves to the FULL header
   [manual_stepper gear_stepper]. Fixture fx2/b_mmu.cfg loads clean.
3. SPI cs_pin daisy chain — tmc2130.MCU_TMC_SPI_chain looks up cs_pin with
   share_type="tmc_spi_cs" when chain_length >= 2 (tmc2130.py:190-194), so
   chained TMC2130/TMC5160 drivers legally share one cs_pin (fixture
   c2_chain2130 loads clean); without chain_length the same config fails
   "pin PF5 used multiple times" (fixture c_chain_ctl). tmc5160 routes
   through tmc2130.MCU_TMC_SPI (tmc5160.py:328).
4. [printer] max_angular_velocity — valid, polar kinematics
   (kinematics/polar.py:52 config.getfloat, default 0).
5. [endstop_phase] endstop_accuracy — float in klippy
   (endstop_phase.py:78 config.getfloat); stock makergear-m2 '.200' loads.
6. [temperature_sensor] I2C sensor params — the sensor chip's bus params
   apply under [temperature_sensor]: i2c family + htu21d_hold_master +
   htu21d_resolution (Config_Reference HTU21D section).
7. Multi-word section types whose first word is a load_config_prefix module
   (dac084S085 stepper_digipot, ds18b20 sensor_name, hx711 <name>,
   lis2dw <name>): known, params not flagged. Unknown multi-word types
   (stepper_1) remain unknown_section warnings.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config  # noqa: E402
from parser.validator import validate_config, validate_project_configs  # noqa: E402


def _validate(text: str):
    return validate_config(parse_config(text, 'printer.cfg'))


def _errors(result, code: str | None = None):
    return [
        e for e in result.errors
        if e.severity == "error" and (code is None or e.code == code)
    ]


# ── 1. Custom [thermistor NAME] satisfies sensor_type ──────────────────

_THERM_BASE = """
[printer]
kinematics: cartesian
max_velocity: 300
max_accel: 3000
max_z_velocity: 15
max_z_accel: 100

[stepper_x]
step_pin: PF0
dir_pin: PF1
enable_pin: !PD7
microsteps: 16
rotation_distance: 40
endstop_pin: ^PE5
position_endstop: 0
position_max: 200

[stepper_y]
step_pin: PF6
dir_pin: !PF7
enable_pin: !PF2
microsteps: 16
rotation_distance: 40
endstop_pin: ^PJ1
position_endstop: 0
position_max: 200

[stepper_z]
step_pin: PL3
dir_pin: PL1
enable_pin: !PK0
microsteps: 16
rotation_distance: 8
endstop_pin: ^PD3
position_endstop: 0
position_max: 200

[extruder]
step_pin: PA4
dir_pin: PA6
enable_pin: !PA2
microsteps: 16
rotation_distance: 33.5
nozzle_diameter: 0.400
filament_diameter: 1.750
heater_pin: PB4
sensor_type: {sensor}
sensor_pin: PK5
control: pid
pid_kp: 22.2
pid_ki: 1.08
pid_kd: 114
min_temp: 0
max_temp: 250

[fan]
pin: PH6
"""

_THERM_DEF = """
[thermistor G2]
temperature1: 20
resistance1: 1000000
beta: 3700
"""


def test_custom_thermistor_satisfies_sensor_type():
    # fx2/a_therm.cfg: klippy 'Starting serial connect'
    result = _validate(_THERM_DEF + _THERM_BASE.format(sensor="G2"))
    assert not [e for e in _errors(result) if "sensor_type" in (e.param or "")]


def test_undefined_sensor_type_still_errors():
    # fixture a_therm_ctl.cfg: klippy Config error for an undefined name
    result = _validate(_THERM_BASE.format(sensor="G2_NOT_DEFINED"))
    hits = [e for e in _errors(result) if e.param == "sensor_type"]
    assert hits and "Invalid value" in hits[0].message


def test_cross_file_thermistor_satisfies_sensor_type():
    # Klipper loads includes into one namespace — a [thermistor] in any
    # project file is valid for a heater in another.
    results = validate_project_configs({
        "printer.cfg": parse_config(
            "[include sensors.cfg]\n" + _THERM_BASE.format(sensor="G2"), "printer.cfg"),
        "sensors.cfg": parse_config(_THERM_DEF, "sensors.cfg"),
    })
    assert not [e for e in _errors(results["printer.cfg"]) if e.param == "sensor_type"]


# ── 2. TMC driver header referencing [manual_stepper <name>] ───────────

_MANUAL_TMC = """
[mcu]
serial: /dev/ttyUSB0

[printer]
kinematics: cartesian
max_velocity: 300
max_accel: 3000
max_z_velocity: 15
max_z_accel: 100

[stepper_x]
step_pin: PF0
dir_pin: PF1
enable_pin: !PD7
microsteps: 16
rotation_distance: 40
endstop_pin: ^PE5
position_endstop: 0
position_max: 200

[stepper_y]
step_pin: PF6
dir_pin: !PF7
enable_pin: !PF2
microsteps: 16
rotation_distance: 40
endstop_pin: ^PJ1
position_endstop: 0
position_max: 200

[stepper_z]
step_pin: PL3
dir_pin: PL1
enable_pin: !PK0
microsteps: 16
rotation_distance: 8
endstop_pin: ^PD3
position_endstop: 0
position_max: 200

[manual_stepper gear_stepper]
step_pin: PC4
dir_pin: PC5
enable_pin: !PH2
microsteps: 16
rotation_distance: 8

[tmc2208 manual_stepper gear_stepper]
uart_pin: PK6
run_current: 0.350
sense_resistor: 0.110
stealthchop_threshold: 999999
"""


def test_tmc_for_manual_stepper_resolves_full_header():
    # fixture fx2/b_mmu.cfg: klippy 'Starting serial connect'
    results = validate_project_configs({"printer.cfg": parse_config(_MANUAL_TMC, "printer.cfg")})
    assert not [e for e in _errors(results["printer.cfg"]) if "required by tmc driver" in e.message]


def test_tmc_for_nonexistent_manual_stepper_still_errors():
    results = validate_project_configs({"printer.cfg": parse_config(_MANUAL_TMC.replace(
        "[manual_stepper gear_stepper]", "[manual_stepper other_stepper]"), "printer.cfg")})
    assert any(
        "required by tmc driver" in e.message
        and "manual_stepper gear_stepper" in e.message
        for e in _errors(results["printer.cfg"])
    )


def test_tmc_microsteps_check_still_applies_via_full_header():
    # microsteps on the referenced manual_stepper must still be a TMC mres
    results = validate_project_configs({"printer.cfg": parse_config(_MANUAL_TMC.replace(
        "[manual_stepper gear_stepper]\nstep_pin: PC4\ndir_pin: PC5\nenable_pin: !PH2\nmicrosteps: 16",
        "[manual_stepper gear_stepper]\nstep_pin: PC4\ndir_pin: PC5\nenable_pin: !PH2\nmicrosteps: 5"), "printer.cfg")})
    assert any(
        e.param == "microsteps" and "not a valid TMC value" in e.message
        for e in _errors(results["printer.cfg"])
    )


# ── 3. SPI daisy-chain cs_pin sharing (tmc2130/tmc5160) ────────────────

_CHAIN_BASE = """
[mcu]
serial: /dev/ttyUSB0

[printer]
kinematics: cartesian
max_velocity: 300
max_accel: 3000
max_z_velocity: 15
max_z_accel: 100

[stepper_x]
step_pin: PF0
dir_pin: PF1
enable_pin: !PD7
microsteps: 16
rotation_distance: 40
endstop_pin: ^PE5
position_endstop: 0
position_max: 200

[stepper_y]
step_pin: PF6
dir_pin: !PF7
enable_pin: !PF2
microsteps: 16
rotation_distance: 40
endstop_pin: ^PJ1
position_endstop: 0
position_max: 200

[stepper_z]
step_pin: PL3
dir_pin: PL1
enable_pin: !PK0
microsteps: 16
rotation_distance: 8
endstop_pin: ^PD3
position_endstop: 0
position_max: 200
"""


def test_chained_tmc2130_shared_cs_pin_allowed():
    # fixture c2_chain2130.cfg: klippy 'Starting serial connect'
    result = _validate(_CHAIN_BASE + """
[tmc2130 stepper_x]
cs_pin: PF5
run_current: 0.800
sense_resistor: 0.075
chain_position: 1
chain_length: 2

[tmc2130 stepper_y]
cs_pin: PF5
run_current: 0.800
sense_resistor: 0.075
chain_position: 2
chain_length: 2
""")
    assert not _errors(result, "shared_pin")


def test_shared_cs_pin_without_chain_still_errors():
    # fixture c_chain_ctl.cfg: klippy 'pin PF5 used multiple times in config'
    result = _validate(_CHAIN_BASE + """
[tmc2130 stepper_x]
cs_pin: PF5
run_current: 0.800
sense_resistor: 0.075

[tmc2130 stepper_y]
cs_pin: PF5
run_current: 0.800
sense_resistor: 0.075
""")
    hits = [e for e in _errors(result, "shared_pin") if "PF5" in e.message]
    assert hits


def test_mixed_chain_lengths_flagged():
    # klippy: "TMC SPI chain must have same length" — same share_type
    # passes pins.py, then the chain helper hard-fails on the mismatch.
    result = _validate(_CHAIN_BASE + """
[tmc2130 stepper_x]
cs_pin: PF5
run_current: 0.800
sense_resistor: 0.075
chain_position: 1
chain_length: 2

[tmc2130 stepper_y]
cs_pin: PF5
run_current: 0.800
sense_resistor: 0.075
chain_position: 1
chain_length: 3
""")
    hits = [e for e in _errors(result) if "same length" in e.message]
    assert hits


def test_duplicate_chain_position_flagged():
    result = _validate(_CHAIN_BASE + """
[tmc2130 stepper_x]
cs_pin: PF5
run_current: 0.800
sense_resistor: 0.075
chain_position: 1
chain_length: 2

[tmc2130 stepper_y]
cs_pin: PF5
run_current: 0.800
sense_resistor: 0.075
chain_position: 1
chain_length: 2
""")
    hits = [e for e in _errors(result) if "duplicate position" in e.message]
    assert hits


def test_chain_position_beyond_length_flagged():
    # tmc2130.py:254 getint('chain_position', minval=1, maxval=chain_len)
    result = _validate(_CHAIN_BASE + """
[tmc2130 stepper_x]
cs_pin: PF5
run_current: 0.800
sense_resistor: 0.075
chain_position: 1
chain_length: 2

[tmc2130 stepper_y]
cs_pin: PG0
run_current: 0.800
sense_resistor: 0.075
chain_position: 5
chain_length: 2
""")
    hits = [e for e in _errors(result) if e.param == "chain_position" and "chain_length" in e.message]
    assert hits


def test_cross_file_chained_cs_pin_allowed():
    results = validate_project_configs({
        "printer.cfg": parse_config("[include drivers.cfg]\n" + _CHAIN_BASE, "printer.cfg"),
        "drivers.cfg": parse_config("""
[tmc5160 stepper_x]
cs_pin: PF5
spi_bus: spi
run_current: 0.800
sense_resistor: 0.075
chain_position: 1
chain_length: 6

[tmc5160 stepper_y]
cs_pin: PF5
spi_bus: spi
run_current: 0.800
sense_resistor: 0.075
chain_position: 2
chain_length: 6
""", "drivers.cfg"),
    })
    assert not [
        e for r in results.values() for e in _errors(r, "shared_pin") if "PF5" in e.message
    ]


def test_non_chainable_spi_driver_shared_cs_still_errors():
    # tmc2660 is SPI but routes through its own MCU_TMC_SPI with NO
    # share_type (tmc2660.py:196) — chain params are meaningless there.
    result = _validate(_CHAIN_BASE + """
[tmc2660 stepper_x]
cs_pin: PF5
run_current: 0.800
sense_resistor: 0.075
chain_position: 1
chain_length: 2

[tmc2660 stepper_y]
cs_pin: PF5
run_current: 0.800
sense_resistor: 0.075
chain_position: 2
chain_length: 2
""")
    assert _errors(result, "shared_pin")


# ── 4/5/6. Schema param gaps ────────────────────────────────────────────

def test_printer_max_angular_velocity_known():
    result = _validate("""
[printer]
kinematics: polar
max_velocity: 300
max_accel: 3000
max_z_velocity: 15
max_z_accel: 100
max_angular_velocity: 10
""")
    assert not [e for e in result.errors
                if e.param == "max_angular_velocity" and e.severity == "error"]


def test_endstop_accuracy_accepts_fraction():
    # stock printer-makergear-m2-2012.cfg uses 'endstop_accuracy: .200'
    result = _validate("""
[endstop_phase stepper_x]
endstop_accuracy: .200
""")
    assert not _errors(result)


def test_temperature_sensor_htu21d_i2c_params_known():
    # stock sample-raspberry-pi.cfg enclosure_temp
    result = _validate("""
[temperature_sensor enclosure_temp]
sensor_type: HTU21D
i2c_mcu: rpi
i2c_bus: i2c1
htu21d_hold_master: False
""")
    assert not [e for e in result.errors if e.code == "unknown_param" and e.severity == "error"]


def test_temperature_sensor_i2c_pins_tracked():
    # i2c_software_* pins are real pin claims — a collision with an output
    # must still surface as shared_pin.
    result = _validate("""
[temperature_sensor env]
sensor_type: LM75
i2c_software_scl_pin: PB6

[output_pin laser]
pin: PB6
value: 0
""")
    assert _errors(result, "shared_pin")


# ── 7. load_config_prefix multi-word section types ─────────────────────

def test_dac084s085_named_section_known():
    # stock generic-alligator-r2/r3.cfg — dac084S085.py is a
    # load_config_prefix module (named instances).
    result = _validate("""
[dac084S085 stepper_digipot]
enable_pin: PB14
spi_bus: spi0
scale: 2.50
channel_A: 0.7882
channel_B: 0.7882
channel_C: 0.6814
""")
    assert not [e for e in result.errors
                if e.code in ("unknown_section", "unknown_param") and e.severity in ("error", "warning")]
    # the enable_pin is a real pin claim: colliding it must still conflict
    result2 = _validate("""
[dac084S085 stepper_digipot]
enable_pin: PB14
scale: 2.50

[output_pin laser]
pin: PB14
value: 0
""")
    assert _errors(result2, "shared_pin")


def test_ds18b20_hx711_are_sensor_types_not_sections():
    # ds18b20/hx711 are sensor_type values under [temperature_sensor], not
    # section prefixes (no load_config_prefix in klippy) — must NOT be
    # blessed as section types.
    result = _validate("""
[ds18b20 my_temp]
sensor_pin: PA1

[hx711 load_cell]
dout_pin: PG6
""")
    codes = [e.code for e in result.errors if e.code == "unknown_section"]
    assert len(codes) == 2


def test_unknown_multiword_section_still_warns():
    # stepper_1 is NOT a load_config_prefix module — first-word fallback
    # must not silently bless it.
    result = _validate("""
[stepper_1]
step_pin: EXP2_6
dir_pin: EXP2_5
microsteps: 16
rotation_distance: 40
""")
    hits = [e for e in result.errors if e.code == "unknown_section"]
    assert hits and "stepper_1" in hits[0].message
