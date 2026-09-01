"""
3c (F8): pin conflicts are detected across files, not just within one file.

Ground truth: Klipper reads the whole project (main + includes) into ONE
configparser and pins.py tracks active pins per chip:pin across the entire
loaded set — a pin used by two sections in DIFFERENT files is the same
hard "pin X used multiple times" condition as within one file. KWC only
tracked pins per file, so the same conflict passed clean when the two
sections lived in separate included files.

KWC already exempts legal shared-pin patterns (TMC UART, stepper enable,
SPI/CAN comms, display buttons) via _is_allowed_shared_pin — the cross-file
pass reuses the same exemptions so they stay consistent.
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


def _shared_pin_warnings(results: dict) -> list:
    return [
        e for fr in results.values() for e in fr.errors
        if e.code == "shared_pin"
    ]


STEPPER_X = (
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
)

STEPPER_Y = (
    "[stepper_y]\n"
    "step_pin: PB3\n"
    "dir_pin: PB4\n"
    "enable_pin: !PB5\n"
    "microsteps: 16\n"
    "rotation_distance: 40\n"
    "position_endstop: ^PA6\n"
    "position_max: 250\n"
    "position_min: 0\n"
    "homing_speed: 50\n"
)


def _y_conflicting_pin(pin: str) -> str:
    return STEPPER_Y.replace("step_pin: PB3", f"step_pin: {pin}")


def test_cross_file_conflict_is_flagged():
    results = _project({
        "printer.cfg": "[include extra.cfg]\n" + STEPPER_X,
        "extra.cfg": _y_conflicting_pin("PB0"),
    })
    warnings = _shared_pin_warnings(results)
    assert warnings, "same pin in two files must be a conflict"
    assert any("PB0" in e.message and "stepper_x" in e.message and "stepper_y" in e.message
               for e in warnings), f"message must list both users: {[e.message for e in warnings]}"


def test_cross_file_conflict_is_error_severity():
    # Same hard-fail as the in-file case: Klipper's active-pin tracking
    # spans the whole loaded project (pins.py), so a cross-file conflict
    # also breaks startup — error, not warning.
    results = _project({
        "printer.cfg": "[include extra.cfg]\n" + STEPPER_X,
        "extra.cfg": _y_conflicting_pin("PB0"),
    })
    warnings = [e for e in _shared_pin_warnings(results) if "PB0" in e.message]
    assert warnings
    assert all(e.severity == "error" for e in warnings), \
        f"cross-file shared pin must be an error, got {[e.severity for e in warnings]}"


def test_duplicate_pin_override_suppresses_cross_file_conflict():
    # [duplicate_pin_override] in an active file exempts its pins project-wide.
    results = _project({
        "printer.cfg": ("[include extra.cfg]\n" + STEPPER_X +
                        "\n[duplicate_pin_override]\npins: PB0\n"),
        "extra.cfg": _y_conflicting_pin("PB0"),
    })
    warnings = [e for e in _shared_pin_warnings(results) if "PB0" in e.message]
    assert not warnings, f"override-listed pin must stay exempt: {[e.message for e in warnings]}"


def test_cross_file_conflict_appears_once():
    results = _project({
        "printer.cfg": "[include extra.cfg]\n" + STEPPER_X,
        "extra.cfg": _y_conflicting_pin("PB0"),
    })
    pb0 = [e for e in _shared_pin_warnings(results) if "PB0" in e.message]
    assert len(pb0) == 1, f"cross-file conflict must not double-report, got: {[e.message for e in pb0]}"


def test_same_file_conflict_still_single():
    # Regression: within-file conflicts keep working and are not duplicated
    # by the new cross-file pass.
    conflicting = STEPPER_X + "\n" + _y_conflicting_pin("PB0")
    results = _project({
        "printer.cfg": "[include extra.cfg]\n" + conflicting,
        "extra.cfg": "[gcode_macro X]\ngcode: G28\n",
    })
    pb0 = [e for e in _shared_pin_warnings(results) if "PB0" in e.message]
    assert len(pb0) == 1, f"same-file conflict must appear once, got: {[e.message for e in pb0]}"


def test_chip_prefixed_pin_conflicts_across_files():
    # Normalization preserves the chip prefix, so EBBCan:PB0 used twice is a
    # conflict too.
    results = _project({
        "printer.cfg": "[include extra.cfg]\n" + STEPPER_X.replace("step_pin: PB0", "step_pin: EBBCan:PB0"),
        "extra.cfg": _y_conflicting_pin("EBBCan:PB0"),
    })
    warnings = [e for e in _shared_pin_warnings(results) if "EBBCan:PB0" in e.message]
    assert warnings, "chip-prefixed pin used in two files must conflict"


def test_enabled_shared_pin_across_files_exempt():
    # enable_pin sharing across stepper sections is legal (Klipper allows a
    # shared enable line) and already exempt in-file — the cross-file pass
    # must honor the same exemption.
    results = _project({
        "printer.cfg": "[include extra.cfg]\n" + STEPPER_X,
        "extra.cfg": STEPPER_Y,  # both use enable_pin: !PB2
    })
    warnings = [e for e in _shared_pin_warnings(results) if "PB2" in e.message]
    assert not warnings, f"shared enable_pin must stay exempt: {[e.message for e in warnings]}"


def test_distinct_pins_across_files_clean():
    results = _project({
        "printer.cfg": "[include extra.cfg]\n" + STEPPER_X,
        "extra.cfg": STEPPER_Y,
    })
    assert not _shared_pin_warnings(results), "no shared pins here — no warnings"
