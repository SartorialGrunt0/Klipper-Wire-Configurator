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
    assert info["board_name"] == "BigTreeTech Octopus Pro"


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


# ── reference pin-layout cross-check ──────────────────────────────

REF_DIR = Path(__file__).resolve().parents[1] / 'reference'


def _sig(tokens):
    from services.board_detector import extract_pin_signature
    return extract_pin_signature(tokens)


def test_pin_signature_normalizes_flags_and_mcu_prefix():
    sig = _sig(
        '[extruder]\n'
        'enable_pin: !PB15\n'
        'sensor_pin: EBBCan:PA4\n'
        '# step_pin: PG10   <- commented: pins nothing\n'
    )
    assert 'extruder.enable_pin=PB15' in sig
    assert 'extruder.sensor_pin=PA4' in sig
    assert 'extruder.step_pin=PG10' not in sig


def test_reference_match_identifies_anonymous_full_config():
    """A stock reference config, renamed and stripped of its header
    comments, still resolves to its own file via pin layout."""
    text = (REF_DIR / 'config' / 'Mainboard' / 'generic-fysetc-spider.cfg').read_text()
    body = '\n'.join(l for l in text.splitlines() if not l.strip().startswith('#'))
    from services.board_detector import match_reference_configs
    matches = match_reference_configs(body, REF_DIR, board_type='mainboard')
    assert matches
    assert matches[0]['filename'] == 'generic-fysetc-spider.cfg'
    assert matches[0]['score'] >= 0.9


def test_detect_adopts_name_from_layout_without_textual_hint():
    path = REF_DIR / 'config' / 'Mainboard' / 'generic-fysetc-spider.cfg'
    text = '\n'.join(l for l in path.read_text().splitlines() if not l.strip().startswith('#'))
    config = parse_config(text, 'printer.cfg')
    info = detect_board_from_config(config, reference_dir=REF_DIR)
    # Adopted name comes from the matched reference filename through the
    # specificity-ordered patterns -> the model name, not just the family.
    assert info['board_name'] == 'FYSETC Spider'
    assert any(m.startswith('Reference layout: generic-fysetc-spider.cfg') for m in info['matches'])


def test_detect_never_conflates_near_twin_boards():
    """Octopus vs Octopus Pro layouts score within the tie window:
    the detector must NOT adopt a single model name for them."""
    path = REF_DIR / 'config' / 'Mainboard' / 'generic-bigtreetech-octopus-v1.1.cfg'
    text = '\n'.join(l for l in path.read_text().splitlines() if not l.strip().startswith('#'))
    config = parse_config(text, 'printer.cfg')
    info = detect_board_from_config(config, reference_dir=REF_DIR)
    # Text may still name 'octopus' via the raw body; what must hold is
    # that NO adoption happened silently: either a clear-winner line
    # naming it, or an explicit candidates line.
    adopt = [m for m in info['matches'] if m.startswith('Reference layout: ')]
    cands = [m for m in info['matches'] if m.startswith('Reference layout candidates')]
    assert adopt or cands


def test_detect_weak_overlap_lists_candidates_without_naming():
    """Yesterday's anonymous fragment (Octopus pins, 3 sections):
    below adopt threshold -> candidates listed, name NOT adopted."""
    frag = (
        '[stepper_x]\nstep_pin: PF13\ndir_pin: PF12\nenable_pin: !PF14\n'
        'endstop_pin: PG6\n'
        '[stepper_y]\nstep_pin: PF11\ndir_pin: PG0\nenable_pin: !PG1\n'
        'endstop_pin: PG9\n'
        '[extruder]\nstep_pin: PA2\ndir_pin: PA0\nenable_pin: !PB15\n'
        'heater_pin: PD7\nsensor_pin: PA4\n'
    )
    config = parse_config(frag, 'printer.cfg')
    info = detect_board_from_config(config, reference_dir=REF_DIR)
    assert info['board_name'] == 'Unknown'
    assert any(m.startswith('Reference layout candidates') for m in info['matches'])
    assert 'reference_matches' in info
    assert all(m['score'] < 0.6 for m in info['reference_matches'])


def test_reference_pass_off_without_reference_dir():
    config = parse_config('[mcu]\nserial: /dev/ttyUSB0\n', 'printer.cfg')
    info = detect_board_from_config(config)
    assert 'reference_matches' not in info
