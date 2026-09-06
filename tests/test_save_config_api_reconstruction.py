"""
Regression: #*# SAVE_CONFIG tail values must survive the VALIDATION API path.

The frontend's live-edit path sends serialized model dicts (to_dict() shape +
raw_text) to /validate and /validate-project, which reconstruct ConfigFile
objects server-side. to_dict() does not serialize save_config_sections, so the
reconstruction produced a file with NO saved-config tail. The validator's
required-param checks merge saved-config params into active_params (a SAVE_CONFIG
block satisfies e.g. position_endstop/arm_length/delta_radius — Klipper appends
the autosave data into the same RawConfigParser), so the empty reconstruction
made valid configs report false "Required parameter ... is missing" errors.

Reported shape: a Monoprice Mini Delta (MPMDV2) config whose position_endstop,
arm_length and delta_radius live only in the #*# tail — Klipper loads it clean,
KWC flagged three errors. Same class as the unclosed_headers API-path gap.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402
from parser.config_parser import parse_config  # noqa: E402

client = TestClient(app)

# Delta config whose required params exist ONLY in the SAVE_CONFIG tail
# (the post-DELTA_CALIBRATE / DELTA_TUNE state of a real MPMDV2 printer.cfg).
MPMD_TEXT = """[printer]
kinematics: delta
max_velocity: 300
max_accel: 3000

[stepper_a]
homing_speed: 50
step_pin: PB12
dir_pin: PB11
enable_pin: !PB10
microsteps: 16
rotation_distance: 56
endstop_pin: ^PC14
#position_endstop: 125.00
#arm_length: 120.8

[stepper_b]
step_pin: PB2
dir_pin: PB1
enable_pin: !PB10
microsteps: 16
rotation_distance: 56
endstop_pin: ^PC13

[stepper_c]
step_pin: PB0
dir_pin: PC5
enable_pin: !PB10
microsteps: 16
rotation_distance: 56
endstop_pin: ^PC4

[mcu]
serial: /dev/ttyFAKE

#*# <---------------------- SAVE_CONFIG ---------------------->
#*# DO NOT EDIT THIS BLOCK OR BELOW. The contents are auto-generated.
#*#
#*# [stepper_a]
#*# position_endstop = 125.00
#*# arm_length = 120.8
#*#
#*# [printer]
#*# delta_radius = 87.062
"""

TAIL_REQUIRED = {"delta_radius", "position_endstop", "arm_length"}


def _config_dict(text: str, filename: str = "printer.cfg") -> dict:
    """Exactly what the frontend store sends: to_dict() + raw_text."""
    d = parse_config(text, filename).to_dict()
    d["raw_text"] = text
    return d


def _tail_missing_errors(errors: list[dict]) -> list[dict]:
    return [
        e for e in errors
        if e.get("param") in TAIL_REQUIRED
        and "is missing" in e.get("message", "")
    ]


def test_direct_parse_has_no_false_required_errors():
    """Control: the parse path already merges the tail into required checks."""
    cfg = parse_config(MPMD_TEXT, "printer.cfg")
    assert [s.full_header for s in cfg.save_config_sections] == ["stepper_a", "printer"]
    res = client.post("/api/validate", json=_config_dict(MPMD_TEXT))
    assert res.status_code == 200
    assert not _tail_missing_errors(res.json()["errors"]), res.json()["errors"]


def test_validate_single_file_survives_reconstruction():
    """/validate rebuilds the ConfigFile from the model dict — the tail must be
    re-derived from raw_text, not silently dropped."""
    # Sanity: the model dict carries no ACTIVE save_config params (the tail
    # values appear at most as comments — that is the reconstruction gap; the
    # validator only counts non-commented params).
    d = _config_dict(MPMD_TEXT)
    active = {
        p["key"]
        for s in d["sections"]
        for p in s["params"]
        if not p["is_commented_out"]
    }
    assert TAIL_REQUIRED.isdisjoint(active)

    res = client.post("/api/validate", json=d)
    assert res.status_code == 200
    missing = _tail_missing_errors(res.json()["errors"])
    assert not missing, f"tail values must satisfy required params via API path: {missing}"


def test_validate_project_survives_reconstruction():
    """The multi-file path the live editor renders from."""
    body = {"config_files": [
        _config_dict("[include stepper_b_c.cfg]\n" + MPMD_TEXT.replace(
            "[stepper_b]", "#[stepper_b]", 1).replace("[stepper_c]", "#[stepper_c]", 1
        ), "printer.cfg"),
        _config_dict(
            "[stepper_b]\nstep_pin: PB2\ndir_pin: PB1\nenable_pin: !PB10\n"
            "microsteps: 16\nrotation_distance: 56\nendstop_pin: ^PC13\n\n"
            "[stepper_c]\nstep_pin: PB0\ndir_pin: PC5\nenable_pin: !PB10\n"
            "microsteps: 16\nrotation_distance: 56\nendstop_pin: ^PC4\n",
            "stepper_b_c.cfg",
        ),
    ]}
    res = client.post("/api/validate-project", json=body)
    assert res.status_code == 200
    files = res.json()["files"]
    for fname, validation in files.items():
        missing = _tail_missing_errors(validation["errors"])
        assert not missing, f"{fname}: tail values lost in project reconstruction: {missing}"


def test_missing_required_still_errors_when_no_tail():
    """Positive control: without a tail the same config MUST still error —
    the fix must not blind the required-param checks."""
    text = MPMD_TEXT.split("#*#")[0]
    res = client.post("/api/validate", json=_config_dict(text))
    assert res.status_code == 200
    missing = _tail_missing_errors(res.json()["errors"])
    assert {e["param"] for e in missing} == TAIL_REQUIRED, missing
