"""
3r (F25, user-reported 2026-08-24): cross-section reference validation.

Scope = config-load hard-fails only (the plan's own scope boundary: Klipper
does NOT validate pin existence / runtime errors at load time, so KWC's
ceiling is config-load). Verified in ~/klipper 2026-08-25:

  (a) TMC driver header `[tmcXXX <stepper>]` -> the `<stepper>` section must
      exist (tmc.py:676):
          if not config.has_section(stepper_name):
              raise config.error("Could not find config section '[%s]'...")
      The reference is the section NAME (after the type word). Project-aware:
      the stepper may live in an included file.

  (b) TMC-conditional microsteps (tmc.py:682): when a TMC driver references a
      stepper, that stepper's microsteps must be one of the TMC mres values
      {256,128,64,32,16,8,4,2,1}. A NON-TMC stepper reads microsteps as a
      plain getint(minval=1) (stepper.py:311) and accepts any int — so the
      constraint applies ONLY to steppers a TMC driver references. (This is
      the microsteps item deferred from 3n, which could not be seeded as a
      static schema enum for that reason.)

Deliberately OUT of scope (connect-time, not config-load):
  controller_fan.heater / .stepper — resolved in handle_connect via
  lookup_heater / get_steppers (controller_fan.py), after config load.
  safe_z_home — uses lookup_z_endstop_config, not a param-name reference.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config  # noqa: E402
from parser.validator import validate_project_configs  # noqa: E402


def _project(files: dict[str, str]) -> dict:
    return validate_project_configs({
        name: parse_config(text, name) for name, text in files.items()
    })


def _tmc_stepper_errors(results: dict) -> list:
    return [
        e for fr in results.values() for e in fr.errors
        if e.severity == "error" and ("required by tmc" in e.message.lower()
                                      or "microsteps" in e.message and "tmc" in e.message.lower())
    ]


STEPPER_X = (
    "[stepper_x]\nstep_pin: PB0\ndir_pin: PB1\nenable_pin: !PB2\n"
    "microsteps: 16\nrotation_distance: 40\nposition_endstop: ^PA0\n"
    "position_min: 0\nposition_max: 250\nhoming_speed: 50\n"
)


# ── (a) TMC header -> referenced stepper section must exist ──────────────

def test_tmc_referenced_stepper_exists_passes():
    results = _project({
        "printer.cfg": "[mcu]\n[include tool.cfg]\n",
        "tool.cfg": "[tmc2209 stepper_x]\nuart_pin: PB0\n" + STEPPER_X,
    })
    assert not _tmc_stepper_errors(results), "valid TMC -> stepper ref must pass"


def test_tmc_referenced_stepper_missing_errors():
    # No [stepper_x] anywhere in the project.
    results = _project({
        "printer.cfg": "[mcu]\n[include tool.cfg]\n",
        "tool.cfg": "[tmc2209 stepper_x]\nuart_pin: PB0\n",
    })
    errs = _tmc_stepper_errors(results)
    assert errs, "TMC driver referencing a non-existent stepper must be an error"
    assert "stepper_x" in errs[0].message


def test_tmc_stepper_in_included_file_satisfies():
    # The stepper is in an included file — must still satisfy the ref.
    results = _project({
        "printer.cfg": "[mcu]\n[include tool.cfg]\n[include steppers.cfg]\n",
        "tool.cfg": "[tmc2209 stepper_x]\nuart_pin: PB0\n",
        "steppers.cfg": STEPPER_X,
    })
    assert not _tmc_stepper_errors(results), "stepper in an included file must satisfy the TMC ref"


def test_tmc_extruder_reference():
    # The ref is the name word — 'extruder' is a valid section type too.
    results = _project({
        "printer.cfg": (
            "[mcu]\n[include tool.cfg]\n"
            "[extruder]\nstep_pin: PB5\ndir_pin: PB6\nmicrosteps: 16\n"
            "rotation_distance: 10\nnozzle_diameter: 0.4\nfilament_diameter: 1.75\n"
            "heater_pin: PB7\nsensor_type: thermistor\nmax_temp: 300\n"
        ),
        "tool.cfg": "[tmc2209 extruder]\nuart_pin: PB0\n",
    })
    assert not _tmc_stepper_errors(results), "tmc2209 extruder must reference [extruder]"


# ── (b) TMC-conditional microsteps ───────────────────────────────────────

def _tmc_microstep_results(ms_value: str) -> dict:
    return _project({
        "printer.cfg": "[mcu]\n[include tool.cfg]\n",
        "tool.cfg": (
            "[tmc2209 stepper_x]\nuart_pin: PB0\n"
            + STEPPER_X.replace("microsteps: 16", f"microsteps: {ms_value}")
        ),
    })


def test_tmc_microstep_in_set_passes():
    for ms in ("1", "2", "4", "8", "16", "32", "64", "128", "256"):
        results = _tmc_microstep_results(ms)
        errs = [e for e in _tmc_stepper_errors(results) if "microsteps" in e.message]
        assert not errs, f"microsteps {ms} is a valid TMC value, got: {[e.message for e in errs]}"


def test_tmc_microstep_out_of_set_errors():
    # The plan's example: microsteps 4 on a stepper a TMC driver reads is
    # valid, but e.g. 12 is not a TMC mres value.
    results = _tmc_microstep_results("12")
    errs = [e for e in _tmc_stepper_errors(results) if "microsteps" in e.message]
    assert errs, "microsteps 12 is not a TMC mres value — must be an error"


def test_non_tmc_stepper_microstep_any_int_passes():
    # A stepper with NO TMC driver references it: microsteps is a plain
    # getint(minval=1) — any int >= 1 is legal (this is why 3n could not
    # seed microsteps as a static schema enum).
    results = _project({
        "printer.cfg": "[mcu]\n" + STEPPER_X.replace("microsteps: 16", "microsteps: 12"),
    })
    errs = [e for e in _tmc_stepper_errors(results) if "microsteps" in e.message]
    assert not errs, "non-TMC stepper must accept any int microsteps (12 is fine)"


# ── single-file projects (the check runs regardless of file count) ───────

def test_single_file_tmc_missing_stepper_errors():
    # No includes, one file: the referenced stepper is still absent.
    results = _project({
        "solo.cfg": "[mcu]\n[tmc2209 stepper_x]\nuart_pin: PB0\n",
    })
    errs = _tmc_stepper_errors(results)
    assert errs, "single-file TMC referencing an absent stepper must error"


def test_single_file_tmc_microstep_out_of_set_errors():
    results = _project({
        "solo.cfg": (
            "[mcu]\n"
            "[tmc2209 stepper_x]\nuart_pin: PB0\n"
            + STEPPER_X.replace("microsteps: 16", "microsteps: 3")
        ),
    })
    errs = [e for e in _tmc_stepper_errors(results) if "microsteps" in e.message]
    assert errs, "single-file TMC microsteps 3 (not a TMC mres value) must error"
