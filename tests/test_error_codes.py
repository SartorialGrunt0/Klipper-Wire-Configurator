import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config
from parser.validator import (
    ValidationError,
    validate_config,
    validate_project_configs,
)


def _validate(text: str):
    return validate_config(parse_config(text, 'printer.cfg'))


def _validate_project(files: dict[str, str]):
    return validate_project_configs({
        filename: parse_config(text, filename)
        for filename, text in files.items()
    })


def _with_code(errors, code: str):
    return [e for e in errors if e.code == code]


# ── Default / additive behavior ─────────────────────────────────────

def test_validation_error_defaults_to_empty_code():
    err = ValidationError(severity="error", section="s", param="p", message="m")
    assert err.code == ''


def test_to_dict_includes_code():
    err = ValidationError(severity="error", section="s", param="p", message="m", code="unknown_section")
    assert err.to_dict()["code"] == "unknown_section"


# ── unknown_section ────────────────────────────────────────────────

def test_unknown_section_carries_code():
    result = _validate('[totally_bogus_section]\nfoo: 1\n')
    unknowns = [e for e in result.errors if 'Unknown section type' in e.message]
    assert unknowns, "expected an unknown-section warning"
    assert all(e.code == 'unknown_section' for e in unknowns)


# ── project_duplicate ──────────────────────────────────────────────

def test_single_file_duplicate_carries_code():
    result = _validate('[virtual_sdcard]\nnetwork_drive: //x\n[virtual_sdcard]\nnetwork_drive: //y\n')
    dups = [e for e in result.errors if 'can only be defined once' in e.message]
    assert dups, "expected a duplicate-section warning"
    assert all(e.code == 'project_duplicate' for e in dups)


def test_cross_file_duplicate_carries_code():
    results = _validate_project({
        'printer.cfg': '[include stepper-a.cfg]\n[include stepper-b.cfg]\n',
        'stepper-a.cfg': '[stepper_z]\nstep_pin: gpio11\ndir_pin: gpio10\nmicrosteps: 16\nrotation_distance: 40\n',
        'stepper-b.cfg': '[stepper_z]\nstep_pin: gpio21\ndir_pin: gpio20\nmicrosteps: 16\nrotation_distance: 40\n',
    })
    for filename in ('stepper-a.cfg', 'stepper-b.cfg'):
        dups = [e for e in results[filename].errors if 'is reused across active included config files' in e.message]
        assert dups, f"expected a cross-file duplicate warning in {filename}"
        assert all(e.code == 'project_duplicate' for e in dups)


# ── shared_pin ─────────────────────────────────────────────────────

def test_shared_pin_carries_code():
    result = _validate(
        '[stepper_x]\n'
        'step_pin: PB0\ndir_pin: !PB1\nenable_pin: !PB2\nmicrosteps: 16\n'
        'rotation_distance: 40\nendstop_pin: ^PB3\nposition_endstop: 0\nposition_max: 235\n'
        '[stepper_y]\n'
        'step_pin: PB0\ndir_pin: !PB4\nenable_pin: !PB5\nmicrosteps: 16\n'
        'rotation_distance: 40\nendstop_pin: ^PB6\nposition_endstop: 0\nposition_max: 235\n'
    )
    pins = [e for e in result.errors if 'is used by multiple sections' in e.message]
    assert pins, "expected a pin-conflict warning"
    assert all(e.code == 'shared_pin' for e in pins)


# ── macro_jinja_unterminated ───────────────────────────────────────

def test_unterminated_jinja_block_carries_code():
    result = _validate(
        '[gcode_macro FOO]\n'
        'gcode:\n'
        '  {% if 1 %}\n'
        '  M104 S50\n'
    )
    jinja = [e for e in result.errors if 'Jinja template error in macro' in e.message]
    assert jinja, "expected a jinja template error"
    assert all(e.code == 'macro_jinja_unterminated' for e in jinja)


def test_other_jinja_error_has_no_code():
    # A malformed expression is a template error but NOT an unterminated
    # block — no code, so the repair-command derivation skips it.
    result = _validate(
        '[gcode_macro FOO]\n'
        'gcode:\n'
        '  M104 S{{ 1 + }}\n'
    )
    jinja = [e for e in result.errors if 'Jinja template error in macro' in e.message]
    assert jinja, "expected a jinja template error"
    assert all(e.code == '' for e in jinja)


# ── unknown_param ──────────────────────────────────────────────────

def test_unknown_param_carries_code():
    result = _validate('[stepper_x]\nstep_pin: PB0\ntotally_fake_param: 1\n')
    unknowns = _with_code(result.errors, 'unknown_param')
    assert unknowns, "expected an unknown-param warning"
    assert all('Unknown parameter' in e.message for e in unknowns)


# ── Messages with no consumer regex stay codeless ──────────────────

def test_required_param_error_has_no_code():
    result = _validate('[stepper_x]\nstep_pin: PB0\n')
    required = [e for e in result.errors if 'is missing' in e.message]
    assert required, "expected a required-param error"
    assert all(e.code == '' for e in required)
