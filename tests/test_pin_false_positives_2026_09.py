"""Four shared-pin / pin-chip false-positive fixes (klipper_backup audit, 2026-09-04).

Ground truth verified by running real klippy on minimal fixtures (same method
as plan 3.5):

1. probe chip — klippy/extras/probe.py:215 registers the 'probe' chip inside
   HomingViaProbeHelper.__init__, which is constructed by [probe] (probe.py:619),
   [bltouch] (bltouch.py:292), [smart_effector] (smart_effector.py:169),
   [load_cell_probe] (load_cell_probe.py:698) and [probe_eddy_current]
   (probe_eddy_current.py:729). A bltouch-only config with
   endstop_pin: probe:z_virtual_endstop reaches 'Starting serial connect';
   removing [bltouch] fails with "Unknown pin chip name 'probe'".

2. TMC diag_pin — klippy/extras/tmc.py:598 allocates diag_pin ONLY inside
   TMCVirtualPinHelper.setup_pin, i.e. only when a stepper's endstop_pin
   references <driver>:virtual_endstop. With sensorless commented out, the
   diag pin is dead: stepper endstop + unused diag on the same GPIO loads
   clean; the same config with the virtual endstop ACTIVE fails
   "pin gpio3 used multiple times in config".

3. Duplicate-section merge — RawConfigParser(strict=False) is a per-option
   union, later definition wins. A pin claimed by an EARLIER [fan] definition
   that a later [fan] definition overrides is never allocated (fixture loads
   clean). Same-file and cross-file (include order = recursive walk,
   configfile.py _parse_config buffers includes and parses linearly).

4. rotation_distance optional with gear_ratio — klippy/stepper.py
   parse_step_distance (297-309): rotation_distance is read only when
   gear_ratio is absent (the units_in_radians path uses 2*pi).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config  # noqa: E402
from parser.validator import validate_config, validate_project_configs  # noqa: E402


def _validate(text: str):
    return validate_config(parse_config(text, 'printer.cfg'))


def _project(files: dict[str, str]) -> dict:
    return validate_project_configs({
        name: parse_config(text, name) for name, text in files.items()
    })


def _shared_pin_errors(results) -> list:
    if not isinstance(results, dict):
        results = {'printer.cfg': results}
    return [
        e
        for res in results.values()
        for e in res.errors
        if getattr(e, 'code', '') == 'shared_pin'
    ]


def _unknown_chip_errors(results) -> list:
    if not isinstance(results, dict):
        results = {'printer.cfg': results}
    return [
        e
        for res in results.values()
        for e in res.errors
        if 'Unknown pin chip name' in e.message
    ]


# ── 1. probe chip registered by the probe family, not only [probe] ─────────


BLTOUCH_PRINTER = """
[mcu]
serial: /tmp/klippy.sock

[printer]
kinematics: cartesian
max_velocity: 200
max_accel: 5000
max_z_velocity: 25
max_z_accel: 100

[stepper_x]
step_pin: PB0
dir_pin: PB1
enable_pin: !PB2
microsteps: 16
rotation_distance: 40
endstop_pin: ^PB3
position_endstop: 0
position_max: 235

[stepper_y]
step_pin: PB4
dir_pin: !PB5
enable_pin: !PB6
microsteps: 16
rotation_distance: 40
endstop_pin: ^PB7
position_endstop: 0
position_max: 235

[stepper_z]
step_pin: PB8
dir_pin: !PB9
enable_pin: !PB10
microsteps: 16
rotation_distance: 8
endstop_pin: probe:z_virtual_endstop
position_min: -5
position_max: 250

[bltouch]
sensor_pin: ^PC13
control_pin: PA1
z_offset: -2.0
"""


OTHER_CFG = "[force_move]\nenable_force_move: true\n"


def test_bltouch_registers_probe_chip():
    """bltouch (component_group probe) must satisfy probe:z_virtual_endstop.
    Chip membership is a project-pass check, so run a 2-file project."""
    results = _project({
        'printer.cfg': "[include other.cfg]\n" + BLTOUCH_PRINTER,
        'other.cfg': OTHER_CFG,
    })
    assert _unknown_chip_errors(results) == []


def test_probe_chip_still_unknown_without_any_probe_section():
    """Negative control: no probe family section → error stays."""
    text = BLTOUCH_PRINTER.replace(
        "\n[bltouch]\nsensor_pin: ^PC13\ncontrol_pin: PA1\nz_offset: -2.0\n", ""
    )
    results = _project({
        'printer.cfg': "[include other.cfg]\n" + text,
        'other.cfg': OTHER_CFG,
    })
    errs = _unknown_chip_errors(results)
    assert any("'probe'" in e.message for e in errs), errs


def test_probe_chip_registered_cross_file():
    """The defining [bltouch] may live in an included file."""
    results = _project({
        'printer.cfg': "[include probe.cfg]\n" + BLTOUCH_PRINTER,
        'probe.cfg': "[bltouch]\nsensor_pin: ^PC13\ncontrol_pin: PA1\nz_offset: -2.0\n",
    })
    assert _unknown_chip_errors(results) == []


# ── 2. TMC diag_pin is only claimed when sensorless is active ───────────────


MPMD_STYLE = """
[mcu]
serial: /tmp/klippy.sock

[printer]
kinematics: cartesian
max_velocity: 200
max_accel: 5000
max_z_velocity: 25
max_z_accel: 100

[stepper_x]
step_pin: PB0
dir_pin: PB1
enable_pin: !PB2
microsteps: 16
rotation_distance: 40
endstop_pin: !PB3
position_endstop: 0
position_max: 235

[tmc2209 stepper_x]
uart_pin: PB4
run_current: 0.400
diag_pin: ^PB5
driver_SGTHRS: 52

[stepper_y]
step_pin: PB6
dir_pin: !PB7
enable_pin: !PB8
microsteps: 16
rotation_distance: 40
endstop_pin: !PB5
position_endstop: 0
position_max: 235

[tmc2209 stepper_y]
uart_pin: PB9
run_current: 0.400
diag_pin: ^PB3
driver_SGTHRS: 52
"""


def test_unused_diag_pin_does_not_conflict_with_physical_endstop():
    """MPMDV2 pattern: diag pins cross-wired to the OTHER axis' physical
    endstops with sensorless commented out — klippy loads (fixture:
    'Starting serial connect'); diag_pin is never allocated."""
    result = _validate(MPMD_STYLE)
    assert _shared_pin_errors(result) == []


def test_active_sensorless_diag_conflict_still_fires():
    """Positive control: endstop_pin: tmc2209_stepper_x:virtual_endstop makes
    the diag pin live — klippy fixture fails 'pin used multiple times'."""
    text = MPMD_STYLE.replace(
        "endstop_pin: !PB3\nposition_endstop: 0",
        "endstop_pin: tmc2209_stepper_x:virtual_endstop\nposition_endstop: 0",
    )
    result = _validate(text)
    errs = _shared_pin_errors(result)
    assert errs, "expected a shared_pin error once stepper_x homes sensorless"
    assert any('PB5' in e.message for e in errs)


def test_diag_pin_conflict_caught_cross_file():
    """Virtual endstop in printer.cfg, diag pin claimed in an included file —
    the project pass must still see the conflict (no false negative)."""
    printer = """
[mcu]
serial: /tmp/klippy.sock

[printer]
kinematics: cartesian
max_velocity: 200
max_accel: 5000
max_z_velocity: 25
max_z_accel: 100

[stepper_x]
step_pin: PB0
dir_pin: PB1
enable_pin: !PB2
microsteps: 16
rotation_distance: 40
endstop_pin: tmc2209_stepper_x:virtual_endstop
position_endstop: 0
position_max: 235
homing_retract_dist: 0

[stepper_y]
step_pin: PB6
dir_pin: !PB7
enable_pin: !PB8
microsteps: 16
rotation_distance: 40
endstop_pin: tmc2209_stepper_y:virtual_endstop
position_endstop: 0
position_max: 235
homing_retract_dist: 0

[include drivers.cfg]
"""
    drivers = """
[tmc2209 stepper_x]
uart_pin: PB4
run_current: 0.400
diag_pin: ^PB13

[tmc2209 stepper_y]
uart_pin: PB9
run_current: 0.400
diag_pin: ^PB13
"""
    results = _project({'printer.cfg': printer, 'drivers.cfg': drivers})
    errs = _shared_pin_errors(results)
    assert any('PB13' in e.message for e in errs), (
        "two ACTIVE diag pins on PB13 must remain an error"
    )


# ── 3. Shadowed pin values in duplicate sections ────────────────────────────


def _fan_cfg(first_pin: str, heater_pin: str, last_pin: str) -> str:
    return f"""
[mcu]
serial: /tmp/klippy.sock

[printer]
kinematics: cartesian
max_velocity: 200
max_accel: 5000
max_z_velocity: 25
max_z_accel: 100

[stepper_x]
step_pin: PB0
dir_pin: PB1
enable_pin: !PB2
microsteps: 16
rotation_distance: 40
endstop_pin: ^PB3
position_endstop: 0
position_max: 235

[fan]
pin: {first_pin}

[heater_fan hotend_fan]
pin: {heater_pin}
heater: extruder
heater_temp: 50.0

[fan]
pin: {last_pin}
"""


def test_shadowed_duplicate_pin_in_same_file_is_not_a_conflict():
    """Later [fan] definition wins the merge; the earlier pin value is dead.
    Klipper fixture: loads clean."""
    result = _validate(_fan_cfg('PA0', 'PA0', 'PA1'))
    assert _shared_pin_errors(result) == []


def test_genuine_conflict_survives_unrelated_duplicate_section():
    """The shadow pass must not swallow real conflicts: the surviving [fan]
    definition (last wins) still collides with [heater_fan]."""
    result = _validate(_fan_cfg('PA9', 'PA0', 'PA0'))
    errs = _shared_pin_errors(result)
    assert any('PA0' in e.message for e in errs), errs


def test_shadowed_duplicate_pin_across_files_is_not_a_conflict():
    """voron_01 pattern: sample-EBB [fan] pin PA0 (earlier in include order)
    is overridden by printer.cfg's later [fan] pin PA1 → no conflict with
    printer.cfg's [heater_fan hotend_fan] pin PA0."""
    sample = """
[fan]
pin: EBBCan: PA0
"""
    printer = """
[mcu EBBCan]
canbus_uuid: aabbccddee11

[printer]
kinematics: corexy
max_velocity: 300
max_accel: 5000
max_z_velocity: 15
max_z_accel: 100

[include sample-ebb.cfg]

[fan]
pin: EBBCan: PA1

[heater_fan hotend_fan]
pin: EBBCan: PA0
heater: extruder
heater_temp: 50.0
"""
    results = _project({'printer.cfg': printer, 'sample-ebb.cfg': sample})
    assert _shared_pin_errors(results) == []


def test_cross_file_conflict_survives_when_later_def_clamps_to_taken_pin():
    """If the LAST definition of the duplicated section pins onto the
    contested pin, the conflict is real and must still fire."""
    sample = """
[fan]
pin: EBBCan: PA9
"""
    printer = """
[mcu EBBCan]
canbus_uuid: aabbccddee11

[printer]
kinematics: corexy
max_velocity: 300
max_accel: 5000
max_z_velocity: 15
max_z_accel: 100

[include sample-ebb.cfg]

[fan]
pin: EBBCan: PA0

[heater_fan hotend_fan]
pin: EBBCan: PA0
heater: extruder
heater_temp: 50.0
"""
    results = _project({'printer.cfg': printer, 'sample-ebb.cfg': sample})
    errs = _shared_pin_errors(results)
    assert any('PA0' in e.message for e in errs), errs


# ── 4. rotation_distance optional when gear_ratio present ───────────────────


def _stepper_x(extra: str) -> str:
    return f"""
[mcu]
serial: /tmp/klippy.sock

[printer]
kinematics: cartesian
max_velocity: 200
max_accel: 5000
max_z_velocity: 25
max_z_accel: 100

[stepper_x]
step_pin: PB0
dir_pin: PB1
enable_pin: !PB2
microsteps: 16
{extra}
endstop_pin: ^PB3
position_endstop: 0
position_max: 235
"""


def test_gear_ratio_satisfies_rotation_distance_requirement():
    """parse_step_distance: gear_ratio alone is legal (units_in_radians path).
    Pico.cfg Afterburner-style configs ship gear_ratio: 50:10 with no
    rotation_distance and load fine."""
    result = _validate(_stepper_x("gear_ratio: 50:10"))
    assert not [e for e in result.errors if 'rotation_distance' in e.message], (
        "gear_ratio must satisfy the rotation_distance requirement"
    )


def test_rotation_distance_still_required_without_gear_ratio():
    result = _validate(_stepper_x("rotation_distance: 40"))
    assert not [e for e in result.errors if 'rotation_distance' in e.message]
    result2 = _validate(_stepper_x("#rotation_distance: 40"))
    assert [e for e in result2.errors if 'rotation_distance' in e.message]
