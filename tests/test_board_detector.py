"""board_detector heuristics — honesty + specificity (2026-09-21 audit).

Two field failures drove these tests (both reproduced via the detect_board
MCP tool during the TOOL-* coverage work):

1. Model shadowing: text naming "BTT Octopus Pro V1.1" returned
   board_name "BigTreeTech" because BOARD_PATTERNS is first-match and the
   family pattern (bigtreetech|btt) precedes the model pattern (octopus).
2. Confident misclassification: a one-stepper config fragment with no
   [printer] section returned board_type "expander" at confidence 0.7 —
   a guess presented as evidence. Per the kickback doctrine, output must
   never over-claim: with no real evidence the type is "other" at 0.0.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config  # noqa: E402
from services.board_detector import detect_board_from_config  # noqa: E402


def _detect(text: str, filename: str = "analysis.cfg") -> dict:
    return detect_board_from_config(parse_config(text, filename))


# ── 1. board_name specificity ─────────────────────────────────────────

def test_btt_family_text_still_yields_family_name():
    info = _detect("[mcu]\nserial: /dev/ttyUSB0  # BigTreeTech board\n")
    assert info["board_name"] == "BigTreeTech"


def test_model_name_beats_family_pattern_in_same_text():
    # "btt" (family) AND "octopus" (model) both occur; the specific model
    # must win, not whichever pattern is listed first.
    info = _detect(
        "Board: BTT Octopus Pro V1.1\n"
        "[mcu]\n"
        "serial: /dev/serial/by-id/usb-Klipper_stm32f446xx_X-if00\n"
    )
    assert info["board_name"] == "BigTreeTech Octopus"


def test_model_specificity_for_other_vendors():
    info = _detect("# wired to a FYSETC Spider mainboard\n[mcu]\nserial: /dev/ttyUSB0\n")
    assert info["board_name"] == "FYSETC Spider"
    info = _detect("# MKS Robin Nano v3\n[mcu]\nserial: /dev/ttyUSB0\n")
    assert info["board_name"] == "MKS Robin Nano"


def test_all_board_matches_are_reported():
    # Doctrine: the matches list shows what the detector saw, so the
    # model can see the family+model evidence chain rather than one
    # opaque winner.
    info = _detect("BTT Octopus board\n[mcu]\nserial: /dev/ttyUSB0\n")
    assert any("Octopus" in m for m in info["matches"])


def test_reference_filename_identifies_model_board():
    # api/routes.py path: real reference filenames carry the model.
    info = _detect("[mcu]\nserial: /dev/ttyUSB0\n",
                   filename="generic-bigtreetech-octopus-v1.1.cfg")
    assert info["board_name"] == "BigTreeTech Octopus"


# ── 2. board_type honesty ──────────────────────────────────────────────

def test_single_stepper_fragment_is_not_confidently_expander():
    # The exact field repro: one stepper + heater_bed + TMC, NO [printer].
    # Nothing here proves "expander" — an honest answer is other/0.0.
    info = _detect(
        "[stepper_x]\n"
        "step_pin: PC13\n"
        "dir_pin: PC14\n"
        "enable_pin: !PE6\n"
        "microsteps: 16\n"
        "rotation_distance: 40\n"
        "endstop_pin: PF0\n"
        "\n"
        "[tmc2209 stepper_x]\n"
        "uart_pin: PG9\n"
        "run_current: 0.800\n"
        "\n"
        "[heater_bed]\n"
        "heater_pin: PA1\n"
        "sensor_type: Generic 3950\n"
        "sensor_pin: PF3\n"
    )
    assert info["board_type"] == "other"
    assert info["board_type_confidence"] == 0.0


def test_two_steppers_no_printer_still_expander():
    info = _detect(
        "[stepper_x]\nstep_pin: PC13\ndir_pin: PC14\nenable_pin: !PE6\n"
        "[stepper_y]\nstep_pin: PC10\ndir_pin: PC11\nenable_pin: !PC12\n"
    )
    assert info["board_type"] == "expander"
    assert info["board_type_confidence"] >= 0.5


def test_printer_plus_steppers_is_mainboard():
    info = _detect(
        "[printer]\nkinematics: cartesian\nmax_velocity: 200\nmax_accel: 4000\n"
        "[stepper_x]\nstep_pin: PC2\ndir_pin: PB9\nenable_pin: !PC3\n"
        "[stepper_y]\nstep_pin: PB8\ndir_pin: PB7\nenable_pin: !PB6\n"
        "[extruder]\nstep_pin: PB4\ndir_pin: PB5\nheater_pin: PB6\n"
        "sensor_type: NTC 100K\nsensor_pin: PA0\nmin_temp: 0\nmax_temp: 250\n"
    )
    assert info["board_type"] == "mainboard"


def test_no_type_match_adds_no_type_claim_to_matches():
    # A "matches" entry naming a type must not appear when the detector
    # is honestly uncertain (previously 'Board type (content): expander'
    # was appended even for the evidence-free fragment).
    info = _detect("[mcu]\nserial: /dev/serial/by-id/usb-Klipper_stm32f446xx_X-if00\n")
    assert info["board_type"] == "other"
    assert not any("Board type" in m for m in info["matches"])
    # MCU detection still works and still reports honestly.
    assert info["mcu_chip"] == "STM32F446"
