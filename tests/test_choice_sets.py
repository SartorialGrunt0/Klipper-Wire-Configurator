"""
3n (F21, user-reported 2026-08-24): populate the verified static choice sets.

Klipper hard-fails every one of these at config load via getchoice, so the
severity is error (enforcement already exists in _validate_param_value's
ENUM branch — this is schema data + one special case).

Ground truth verified in ~/klipper 2026-08-25 (getchoice is CASE-SENSITIVE):
  - control -> {'watermark': ControlBangBang, 'pid': ControlPID}
    (extras/heaters.py:52). The plan's "['enable']" was wrong. Applies to all
    11 heater sections (extruder*, heater_bed, heater_generic,
    temperature_fan) — same 4 ParamDef objects.
  - respond.default_type -> {'echo','command','error'}
    (extras/respond.py:7). The plan's "['status','echo','command']" was wrong.
  - bltouch.set_output_mode -> ['5V', 'OD', None] (extras/bltouch.py:44).
    Fixes a LIVE false positive: valid value '5V' previously tripped the INT
    branch ("Expected integer").
  - display.encoder_steps_per_detent -> [2, 4] (extras/display/menu_keys.py:19)
  - neopixel.color_order -> each entry must be a permutation of 'RGB' or
    'RGBW' (extras/neopixel.py:33-37) — a per-LED chain list, so it is a
    dedicated check, not a plain enum.

Deliberately NOT in this batch (ground truth says static sets would be wrong):
  - microsteps: only getchoice'd when a TMC driver consumes the stepper
    (tmc.py:682); a non-TMC stepper accepts any int. Value-conditional —
    defer (would false-positive on non-TMC steppers).
  - dual_carriage/extra_carriage.primary_carriage: getchoice('primary_carriage',
    <declared carriage names>) — DYNAMIC per config (generic_cartesian.py:44),
    not a static set. Cross-section check = 3r.
  - load_cell.gain/sample_rate: not read by [load_cell] (phantom schema
    params — the real reads are in [hx71x]/[ads1220], which KWC doesn't
    model). display.line_length: same (lives in [hd44780]).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config  # noqa: E402
from parser.validator import validate_config  # noqa: E402


def _errors(cfg: str) -> list:
    return validate_config(parse_config(cfg, 'printer.cfg')).errors


def _choice_errors(errors: list, param: str) -> list:
    return [e for e in errors if e.param == param and e.severity == "error"
            and "Invalid value" in e.message]


# ── control: watermark/pid across all heater sections ────────────────────

def test_control_valid_values_pass():
    for value in ("pid", "watermark"):
        for sec in ("extruder", "heater_bed"):
            cfg = f"[{sec}]\nheater_pin: PB0\nsensor_type: thermistor\ncontrol: {value}\n"
            bad = _choice_errors(_errors(cfg), "control")
            assert not bad, f"[{sec}] control: {value} must pass, got: {[e.message for e in bad]}"


def test_control_invalid_value_errors():
    # (A trailing space, e.g. "pid ", is stripped by the config parser before
    # validation — Klipper sees "pid" too — so it is not in the list.)
    for value in ("enable", "bang_bang", "PID"):
        cfg = "[extruder]\nheater_pin: PB0\nsensor_type: thermistor\ncontrol: " + value + "\n"
        bad = _choice_errors(_errors(cfg), "control")
        assert bad, f"control: {value!r} is not watermark/pid — must be an error (case-sensitive)"


def test_temperature_fan_control_validates():
    cfg = "[temperature_fan]\nfan_pin: PB0\nsensor_type: thermistor\ncontrol: pid\n"
    assert not _choice_errors(_errors(cfg), "control")
    cfg = "[temperature_fan]\nfan_pin: PB0\nsensor_type: thermistor\ncontrol: enable\n"
    assert _choice_errors(_errors(cfg), "control")


# ── respond.default_type: echo/command/error ─────────────────────────────

def test_respond_default_type_validates():
    for value in ("echo", "command", "error"):
        cfg = f"[respond]\ndefault_type: {value}\n"
        assert not _choice_errors(_errors(cfg), "default_type"), f"{value} must pass"
    # 'status' is in the plan but NOT in Klipper (respond.py:7) — must error
    cfg = "[respond]\ndefault_type: status\n"
    assert _choice_errors(_errors(cfg), "default_type"), "'status' is not a Klipper respond type"


# ── bltouch.set_output_mode: 5V/OD (fixes live false positive) ──────────

def test_bltouch_set_output_mode_validates():
    BLTOUCH = "[bltouch]\nsensor_pin: PB0\n"
    for value in ("5V", "OD"):
        cfg = BLTOUCH + f"set_output_mode: {value}\n"
        errors = _errors(cfg)
        assert not [e for e in errors if e.param == "set_output_mode" and e.severity == "error"], \
            f"set_output_mode: {value} is valid in Klipper — must not error"
    cfg = BLTOUCH + "set_output_mode: 3V3\n"
    assert _choice_errors(_errors(cfg), "set_output_mode"), "invalid output mode must error"


# ── display.encoder_steps_per_detent: 2/4 ────────────────────────────────

def test_display_encoder_steps_validates():
    for value in ("2", "4"):
        cfg = f"[display]\nencoder_steps_per_detent: {value}\n"
        assert not _choice_errors(_errors(cfg), "encoder_steps_per_detent"), f"{value} must pass"
    cfg = "[display]\nencoder_steps_per_detent: 8\n"
    assert _choice_errors(_errors(cfg), "encoder_steps_per_detent"), "8 is not 2 or 4"


# ── neopixel.color_order: permutation of RGB / RGBW (per chain) ─────────

def test_neopixel_color_order_validates():
    for value in ("GRB", "RGB", "RGBW", "WRBG", "GRB, RGB"):
        cfg = f"[neopixel test]\nchain_count: 1\npin: PB0\ncolor_order: {value}\n"
        if "," in value:
            cfg = cfg.replace("chain_count: 1", "chain_count: 2")
        errors = _errors(cfg)
        assert not [e for e in errors if e.param == "color_order" and e.severity == "error"], \
            f"color_order: {value} is a valid permutation — must not error"


def test_neopixel_color_order_invalid_errors():
    for value in ("abcd", "RGBG", "RGB,XX", "RG"):
        cfg = f"[neopixel test]\nchain_count: 1\npin: PB0\ncolor_order: {value}\n"
        if "," in value:
            cfg = cfg.replace("chain_count: 1", "chain_count: 2")
        errors = _errors(cfg)
        assert [e for e in errors if e.param == "color_order" and e.severity == "error"], \
            f"color_order: {value} is not an RGB/RGBW permutation — must error"


# ── case sensitivity (getchoice is case-sensitive) ───────────────────────

def test_enum_check_is_case_sensitive():
    cfg = "[respond]\ndefault_type: ECHO\n"
    assert _choice_errors(_errors(cfg), "default_type"), "getchoice is case-sensitive"
