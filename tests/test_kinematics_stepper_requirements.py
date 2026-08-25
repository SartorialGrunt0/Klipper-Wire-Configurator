"""
3e (F10): kinematics -> base stepper section requirements.

Ground truth (Klipper kinematics sources, verified 2026-08-25):
  cartesian / corexy / hybrid_corexy / winch:
      stepper.LookupMultiRail(config.getsection('stepper_' + n)) for n in 'xyz'
      (cartesian.py:21-22, corexy.py:13-15, hybrid_corexy.py, winch.py xyz loop)
  delta / rotary_delta:
      rail_a/rail_b/rail_c = LookupMultiRail(getsection('stepper_a'/'b'/'c'))
      (delta.py, rotary_delta.py)
  deltesian:
      stepper_configs = [getsection('stepper_' + s) for s in ['left','right','y']]
      (deltesian.py:19-20)
  polar:
      explicit getsection('stepper_arm' / 'stepper_bed' / 'stepper_z')

Each missing base section is a Klipper startup hard-fail:
  configfile.getsection raises "Error in section 'printer' ... config section
  'stepper_x' is required but not defined".

KWC gap: _check_dependencies only has a static per-section `requires` list
(bed_mesh->probe, resonance_tester->adxl345). The kinematics->stepper edge is
VALUE-CONDITIONAL (depends on [printer].kinematics), so it is not expressible
as a static list — a dedicated project-level check is needed (mirrors the
probe cross-file check: [printer] and the steppers routinely live in different
files, so a single-file check would false-positive on the real Trident).
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config
from parser.validator import validate_project_configs, ValidationResult


def _project(files: dict[str, str]) -> dict[str, ValidationResult]:
    if len(files) == 1:
        (name, text), = files.items()
        return validate_project_configs({name: parse_config(text, name)})
    main = "printer.cfg" if "printer.cfg" in files else next(iter(files))
    includes = [f"[include {n}]" for n in files if n != main]
    configs = {n: parse_config(t, n) for n, t in files.items()}
    configs[main] = parse_config("\n".join(includes) + "\n" + files[main], main)
    return validate_project_configs(configs)


# --- cartesian: base x/y/z required ------------------------------------------

def test_cartesian_missing_stepper_z_warns():
    result = _project({
        "printer.cfg": (
            "[printer]\n"
            "kinematics: cartesian\n"
            "\n"
            "[stepper_x]\n"
            "step_pin: PB0\n"
            "dir_pin: PB1\n"
            "enable_pin: !PB2\n"
            "microsteps: 16\n"
            "rotation_distance: 40\n"
            "position_endstop: ^PA0\n"
            "position_max: 250\n"
            "position_min: 0\n"
            "homing_speed: 50\n"
            "\n"
            "[stepper_y]\n"
            "step_pin: PB3\n"
            "dir_pin: PB4\n"
            "enable_pin: !PB5\n"
            "microsteps: 16\n"
            "rotation_distance: 40\n"
            "position_endstop: ^PA1\n"
            "position_max: 250\n"
            "position_min: 0\n"
            "homing_speed: 50\n"
        ),
        "extras.cfg": (
            "[gcode_macro _KIN_CHECK]\n"
            "gcode:\n"
            "    RESPOND MSG=ok\n"
        ),
    })
    kin_warnings = [
        e for e in result["printer.cfg"].errors
        if e.code == "kinematics_stepper_missing"
    ]
    assert len(kin_warnings) == 1, f"expected one kinematics stepper warning, got: {[e.message for e in kin_warnings]}"
    assert "stepper_z" in kin_warnings[0].message
    # Warning (not error): cross-file project checks are ack-able, because KWC's
    # loaded file set may be incomplete — a save-blocking error would false-positive
    # on a project that simply does not include the stepper file.
    assert kin_warnings[0].severity == "warning"
    assert kin_warnings[0].section == "printer"


def test_cartesian_with_all_base_steppers_no_warning():
    result = _project({
        "printer.cfg": (
            "[printer]\n"
            "kinematics: cartesian\n"
        ),
        "steppers.cfg": (
            "[stepper_x]\n"
            "step_pin: PB0\n"
            "dir_pin: PB1\n"
            "enable_pin: !PB2\n"
            "microsteps: 16\n"
            "rotation_distance: 40\n"
            "position_endstop: ^PA0\n"
            "position_max: 250\n"
            "position_min: 0\n"
            "homing_speed: 50\n"
            "\n"
            "[stepper_y]\n"
            "step_pin: PB3\n"
            "dir_pin: PB4\n"
            "enable_pin: !PB5\n"
            "microsteps: 16\n"
            "rotation_distance: 40\n"
            "position_endstop: ^PA1\n"
            "position_max: 250\n"
            "position_min: 0\n"
            "homing_speed: 50\n"
            "\n"
            "[stepper_z]\n"
            "step_pin: PB6\n"
            "dir_pin: PB7\n"
            "enable_pin: !PB8\n"
            "microsteps: 16\n"
            "rotation_distance: 8\n"
            "position_endstop: ^PA2\n"
            "position_max: 250\n"
            "position_min: 0\n"
            "homing_speed: 5\n"
        ),
    })
    all_errors = [e for fname in result for e in result[fname].errors]
    assert not [e for e in all_errors if e.code == "kinematics_stepper_missing"], (
        f"no kinematics stepper warning expected, got: {[e.message for e in all_errors if e.code == 'kinematics_stepper_missing']}"
    )


# --- corexy: base x/y/z required (x1/y1 are optional extra steppers) ----------

def test_corexy_missing_stepper_y_warns():
    result = _project({
        "printer.cfg": (
            "[printer]\n"
            "kinematics: corexy\n"
        ),
        "steppers.cfg": (
            "[stepper_x]\n"
            "step_pin: PB0\n"
            "dir_pin: PB1\n"
            "enable_pin: !PB2\n"
            "microsteps: 16\n"
            "rotation_distance: 40\n"
            "position_endstop: ^PA0\n"
            "position_max: 250\n"
            "position_min: 0\n"
            "homing_speed: 50\n"
            "\n"
            "[stepper_z]\n"
            "step_pin: PB6\n"
            "dir_pin: PB7\n"
            "enable_pin: !PB8\n"
            "microsteps: 16\n"
            "rotation_distance: 8\n"
            "position_endstop: ^PA2\n"
            "position_max: 250\n"
            "position_min: 0\n"
            "homing_speed: 5\n"
        ),
    })
    kin_warnings = [
        e for e in result["printer.cfg"].errors
        if e.code == "kinematics_stepper_missing"
    ]
    assert len(kin_warnings) == 1, f"expected one kinematics stepper warning, got: {[e.message for e in kin_warnings]}"
    assert "stepper_y" in kin_warnings[0].message


# --- delta: stepper_a/b/c required -------------------------------------------

def test_delta_missing_stepper_b_warns():
    # Multi-file project: the missing tower must be checked across the active
    # set, not within one file (a lone partial printer.cfg must not fire it).
    result = _project({
        "printer.cfg": (
            "[printer]\n"
            "kinematics: delta\n"
            "delta_radius: 200\n"
        ),
        "steppers.cfg": (
            "[stepper_a]\n"
            "step_pin: PA0\n"
            "dir_pin: PA1\n"
            "enable_pin: !PA2\n"
            "microsteps: 16\n"
            "rotation_distance: 40\n"
            "arm_length: 230\n"
            "position_endstop: ^PC0\n"
            "position_max: 250\n"
            "position_min: -60\n"
            "homing_speed: 50\n"
            "\n"
            "[stepper_c]\n"
            "step_pin: PA3\n"
            "dir_pin: PA4\n"
            "enable_pin: !PA5\n"
            "microsteps: 16\n"
            "rotation_distance: 40\n"
            "arm_length: 230\n"
            "position_endstop: ^PC1\n"
            "position_max: 250\n"
            "position_min: -60\n"
            "homing_speed: 50\n"
        ),
    })
    kin_warnings = [
        e for e in result["printer.cfg"].errors
        if e.code == "kinematics_stepper_missing"
    ]
    assert len(kin_warnings) == 1, f"expected one kinematics stepper warning, got: {[e.message for e in kin_warnings]}"
    assert "stepper_b" in kin_warnings[0].message


def test_delta_with_all_towers_no_warning():
    result = _project({
        "printer.cfg": (
            "[printer]\n"
            "kinematics: delta\n"
            "delta_radius: 200\n"
        ),
        "steppers.cfg": (
            "[stepper_a]\n"
            "step_pin: PA0\n"
            "dir_pin: PA1\n"
            "enable_pin: !PA2\n"
            "microsteps: 16\n"
            "rotation_distance: 40\n"
            "arm_length: 230\n"
            "position_endstop: ^PC0\n"
            "position_max: 250\n"
            "position_min: -60\n"
            "homing_speed: 50\n"
            "\n"
            "[stepper_b]\n"
            "step_pin: PA3\n"
            "dir_pin: PA4\n"
            "enable_pin: !PA5\n"
            "microsteps: 16\n"
            "rotation_distance: 40\n"
            "arm_length: 230\n"
            "position_endstop: ^PC1\n"
            "position_max: 250\n"
            "position_min: -60\n"
            "homing_speed: 50\n"
            "\n"
            "[stepper_c]\n"
            "step_pin: PA6\n"
            "dir_pin: PA7\n"
            "enable_pin: !PA8\n"
            "microsteps: 16\n"
            "rotation_distance: 40\n"
            "arm_length: 230\n"
            "position_endstop: ^PC2\n"
            "position_max: 250\n"
            "position_min: -60\n"
            "homing_speed: 50\n"
        ),
    })
    all_errors = [e for fname in result for e in result[fname].errors]
    assert not [e for e in all_errors if e.code == "kinematics_stepper_missing"], (
        f"no kinematics stepper warning expected, got: {[e.message for e in all_errors if e.code == 'kinematics_stepper_missing']}"
    )


# --- non-kinematics sections in the same project must not be flagged ---------

def test_extra_steppers_do_not_satisfy_base_requirement():
    """[stepper_z1]/[stepper_z2] are extra steppers on the z axis; they do not
    replace the base [stepper_z] that the kinematics looks up by exact name."""
    result = _project({
        "printer.cfg": (
            "[printer]\n"
            "kinematics: cartesian\n"
        ),
        "steppers.cfg": (
            "[stepper_x]\n"
            "step_pin: PB0\n"
            "dir_pin: PB1\n"
            "enable_pin: !PB2\n"
            "microsteps: 16\n"
            "rotation_distance: 40\n"
            "position_endstop: ^PA0\n"
            "position_max: 250\n"
            "position_min: 0\n"
            "homing_speed: 50\n"
            "\n"
            "[stepper_y]\n"
            "step_pin: PB3\n"
            "dir_pin: PB4\n"
            "enable_pin: !PB5\n"
            "microsteps: 16\n"
            "rotation_distance: 40\n"
            "position_endstop: ^PA1\n"
            "position_max: 250\n"
            "position_min: 0\n"
            "homing_speed: 50\n"
            "\n"
            "[stepper_z1]\n"
            "step_pin: PB6\n"
            "dir_pin: PB7\n"
            "enable_pin: !PB8\n"
            "microsteps: 16\n"
            "rotation_distance: 8\n"
            "position_endstop: ^PA2\n"
            "position_max: 250\n"
            "position_min: 0\n"
            "homing_speed: 5\n"
        ),
    })
    kin_warnings = [
        e for fname in result for e in result[fname].errors
        if e.code == "kinematics_stepper_missing"
    ]
    assert len(kin_warnings) == 1, f"z1 does not satisfy base z; expected one warning, got: {[e.message for e in kin_warnings]}"
    assert "stepper_z" in kin_warnings[0].message


# --- no [printer] / no kinematics -> check must be skipped --------------------

def test_no_printer_section_no_kinematics_check():
    result = _project({
        "printer.cfg": (
            "[stepper_x]\n"
            "step_pin: PB0\n"
        ),
    })
    all_errors = [e for fname in result for e in result[fname].errors]
    assert not [e for e in all_errors if e.code == "kinematics_stepper_missing"]


def test_unknown_kinematics_value_no_kinematics_check():
    # An unrecognized kinematics value is its own problem (ENUM, covered by
    # 3n); the stepper-requirement check must not guess.
    result = _project({
        "printer.cfg": (
            "[printer]\n"
            "kinematics: whatever\n"
            "\n"
            "[stepper_x]\n"
            "step_pin: PB0\n"
        ),
    })
    all_errors = [e for fname in result for e in result[fname].errors]
    assert not [e for e in all_errors if e.code == "kinematics_stepper_missing"]
