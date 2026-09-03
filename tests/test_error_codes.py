import sys
from itertools import chain
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
    dups = _with_code(result.errors, 'project_duplicate')
    assert dups, "expected a duplicate-section finding"
    assert all(e.severity == 'info' for e in dups), \
        f"duplicate sections are legal (Klipper merges) — info, got {[e.severity for e in dups]}"
    assert all('defined multiple times in this file' in e.message for e in dups)


def test_cross_file_duplicate_carries_code():
    results = _validate_project({
        'printer.cfg': '[include stepper-a.cfg]\n[include stepper-b.cfg]\n',
        'stepper-a.cfg': '[stepper_z]\nstep_pin: gpio11\ndir_pin: gpio10\nmicrosteps: 16\nrotation_distance: 40\n',
        'stepper-b.cfg': '[stepper_z]\nstep_pin: gpio21\ndir_pin: gpio20\nmicrosteps: 16\nrotation_distance: 40\n',
    })
    for filename in ('stepper-a.cfg', 'stepper-b.cfg'):
        dups = _with_code(results[filename].errors, 'project_duplicate')
        assert dups, f"expected a cross-file duplicate finding in {filename}"
        assert all(e.severity == 'info' for e in dups)
        assert all('is also defined in' in e.message for e in dups), \
            f"message should name the other file(s): {[e.message for e in dups]}"


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
    assert pins, "expected a pin-conflict finding"
    assert all(e.code == 'shared_pin' for e in pins)
    assert all(e.severity == 'error' for e in pins), \
        f"shared pin is a Klipper hard-fail — error, got {[e.severity for e in pins]}"


def test_info_only_result_sets_neither_has_errors_nor_has_warnings():
    # A result containing only info findings (e.g. cross-file duplicate
    # sections) is clean for save/status purposes — info counts as neither
    # errors nor warnings.
    results = _validate_project({
        'printer.cfg': '[include extra.cfg]\n[gcode_macro FOO]\ngcode: G28\n',
        'extra.cfg': '[gcode_macro FOO]\ngcode: G1 X10\n',
    })
    dups = _with_code(list(chain(*[r.errors for r in results.values()])), 'project_duplicate')
    assert dups, "expected duplicate findings in the fixture"
    for result in results.values():
        assert not result.has_errors
        assert not result.has_warnings, \
            f"info-only file must not set has_warnings: {[e.severity for e in result.errors]}"


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


def test_update_manager_info_tags_is_known():
    # Moonraker update_manager (validated by Moonraker, not Klipper): the
    # common option set must not produce unknown_param warnings. Regression:
    # KWC's own klipper-wire-configurator-update.cfg ships `info_tags:` with
    # a continuation value, which the schema previously didn't model.
    result = _validate(
        '[update_manager klipper-wire-configurator]\n'
        'type: git_repo\n'
        'channel: dev\n'
        'path: /home/clifgall/Klipper-Wire-Configurator\n'
        'origin: https://github.com/SartorialGrunt0/Klipper-Wire-Configurator.git\n'
        'primary_branch: main\n'
        'virtualenv: /home/clifgall/Klipper-Wire-Configurator/venv\n'
        'requirements: backend/requirements.txt\n'
        'managed_services: klipper-wire-configurator\n'
        'info_tags:\n'
        '\tdesc=Klipper Wire Configurator\n'
    )
    unknowns = [e for e in result.errors if e.param == 'info_tags']
    assert not unknowns, (
        "info_tags is a real Moonraker update_manager option "
        f"(app_deploy.py getlist) — got: {[e.message for e in unknowns]}"
    )
    assert not _with_code(result.errors, 'unknown_param'), (
        f"no option in the shipped update_manager file should be unknown; "
        f"got: {[e.message for e in result.errors]}"
    )


def test_update_manager_bogus_param_still_warns():
    # Adding real options must not loosen the advisory unknown-param check.
    result = _validate(
        '[update_manager klipper-wire-configurator]\n'
        'type: git_repo\n'
        'totally_fake_option: 1\n'
    )
    unknowns = _with_code(result.errors, 'unknown_param')
    assert any('totally_fake_option' in e.message for e in unknowns), (
        "bogus update_manager option must still warn"
    )


# ── Messages with no consumer regex stay codeless ──────────────────

def test_required_param_error_has_no_code():
    result = _validate('[stepper_x]\nstep_pin: PB0\n')
    required = [e for e in result.errors if 'is missing' in e.message]
    assert required, "expected a required-param error"
    assert all(e.code == '' for e in required)
