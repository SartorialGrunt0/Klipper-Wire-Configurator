"""
3d (F8): pin values must reference a known pin chip (user-reported 2026-08-24).

Ground truth (klippy/pins.py parse_pin, verified 2026-08-25):
    if ':' not in desc:
        chip_name, pin = 'mcu', desc
    else:
        chip_name, pin = [s.strip() for s in desc.split(':', 1)]
    if chip_name not in self.chips:
        raise error("Unknown pin chip name '%s'" % (chip_name,))

So a pin with an explicit chip prefix hard-fails at config load when the
chip is not registered. `mcu` (no prefix) is always registered by
mcu.add_printer_objects, so unprefixed pins are always resolvable at the
chip level.

Chips are registered not only by [mcu] sections but also by driver objects
(verified against every register_chip call site in klippy, 2026-08-25):
    [mcu NAME]        -> NAME          (also CAN chips: [mcu EBBCan]+canbus_uuid;
                                        there is NO [canbus] section in this
                                        Klipper)
    [probe]           -> probe
    [multi_pin]       -> multi_pin
    [replicape]       -> replicape
    [tmc2130/2209/5160/2240 NAME] -> tmcXXX_NAME  (TMCVirtualPinHelper)
    [adc_scaled NAME] -> NAME
    [ads1x1x NAME]    -> NAME
    [sx1509 NAME]     -> sx1509_NAME

The plan said "mcu/canbus sections only" — that would false-positive on
every sensorless-TMC and probe endstop pin in the real Trident config
(`endstop_pin: tmc2209_stepper_x:virtual_endstop`, `probe:z_virtual_endstop`),
so the full driver-registered namespace is modeled instead.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config  # noqa: E402
from parser.validator import validate_config, validate_project_configs  # noqa: E402


def _project(files: dict[str, str]) -> dict:
    return validate_project_configs({
        name: parse_config(text, name) for name, text in files.items()
    })


def _unknown_chip_errors(results: dict) -> list:
    return [
        e for fr in results.values() for e in fr.errors
        if 'Unknown pin chip name' in e.message
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


def test_unknown_chip_prefix_is_error():
    # User's exact case: pin: EBBCan:PB0 with no [mcu EBBCan] / canbus device.
    results = _project({
        "printer.cfg": "[mcu]\n[include tool.cfg]\n",
        "tool.cfg": STEPPER_X.replace("step_pin: PB0", "step_pin: EBBCan:PB0"),
    })
    errors = _unknown_chip_errors(results)
    assert errors, "pin referencing an undefined chip must be an error"
    assert errors[0].severity == "error"
    assert "EBBCan" in errors[0].message
    # Anchored at the usage site.
    assert errors[0].param == "step_pin"
    assert errors[0].section == "stepper_x"


def test_defined_mcu_chip_passes():
    # [mcu EBBCan] is defined in the project -> no error.
    cfg = "[mcu]\n[mcu EBBCan]\ncanbus_uuid: f3cc6f667348\n[include tool.cfg]\n"
    results = _project({
        "printer.cfg": cfg,
        "tool.cfg": STEPPER_X.replace("step_pin: PB0", "step_pin: EBBCan:PB0"),
    })
    assert not _unknown_chip_errors(results), "defined chip must not be flagged"


def test_unprefixed_pin_never_flagged():
    # The default chip 'mcu' is always registered — even a project with no
    # [mcu] section loaded (partial import) must not flag unprefixed pins.
    results = _project({
        "printer.cfg": STEPPER_X,  # all pins unprefixed, no [mcu] in set
    })
    assert not _unknown_chip_errors(results), "unprefixed pins always resolve to the builtin 'mcu' chip"


def test_tmc_virtual_pin_chip_resolves():
    # Real Trident pattern: sensorless endstops reference the TMC driver's
    # virtual-endstop chip via endstop_pin (PIN-typed; position_endstop stays
    # a float — that's what the real Trident has).
    results = _project({
        "printer.cfg": (
            "[mcu]\n"
            "[tmc2209 stepper_x]\n"
            "stepper: stepper_x\n"
            + STEPPER_X.replace("position_endstop: ^PA0", "endstop_pin: tmc2209_stepper_x:virtual_endstop")
        ),
    })
    assert not _unknown_chip_errors(results), "tmc virtual-endstop chip must resolve"


def test_tmc_virtual_pin_chip_missing_driver_errors():
    results = _project({
        "printer.cfg": "[mcu]\n[include tool.cfg]\n",
        "tool.cfg": STEPPER_X.replace("position_endstop: ^PA0", "endstop_pin: tmc2209_stepper_x:virtual_endstop"),
    })
    errors = _unknown_chip_errors(results)
    assert errors, "tmc chip with no [tmc2209 stepper_x] section must be an error"
    assert "tmc2209_stepper_x" in errors[0].message


def test_probe_chip_resolves():
    # Real Trident pattern: [probe] registers the 'probe' chip for
    # z_virtual_endstop.
    results = _project({
        "printer.cfg": (
            "[mcu]\n"
            "[probe]\n"
            "z_offset: 2\n"
            + STEPPER_X.replace("position_endstop: ^PA0", "position_endstop: probe:z_virtual_endstop")
        ),
    })
    assert not _unknown_chip_errors(results), "probe chip must resolve when [probe] is present"


def test_multi_word_mcu_name_resolves():
    # [mcu host_mcu] style names (real Trident) register under their section name.
    results = _project({
        "printer.cfg": (
            "[mcu host_mcu]\n"
            + STEPPER_X.replace("step_pin: PB0", "step_pin: host_mcu:PB0")
        ),
    })
    assert not _unknown_chip_errors(results), "[mcu host_mcu] must register chip 'host_mcu'"


def test_chip_name_case_insensitive():
    # Klipper section names are case-sensitive: [mcu ebbcan] + ebbcan:PB0
    # works, so a [mcu EBBcan] definition must satisfy an ebbcan: pin.
    results = _project({
        "printer.cfg": "[mcu]\n[mcu EBBcan]\ncanbus_uuid: f3cc6f667348\n[include tool.cfg]\n",
        "tool.cfg": STEPPER_X.replace("step_pin: PB0", "step_pin: ebbcan:PB0"),
    })
    assert not _unknown_chip_errors(results), "chip matching must be case-insensitive"


def test_single_file_mode_does_not_check_membership():
    # validate_config has no project context — the chip may live in another
    # file. Membership is a project-pass check only.
    result = validate_config(parse_config(
        STEPPER_X.replace("step_pin: PB0", "step_pin: EBBCan:PB0"), "printer.cfg"
    ))
    assert not [e for e in result.errors if 'Unknown pin chip name' in e.message]
