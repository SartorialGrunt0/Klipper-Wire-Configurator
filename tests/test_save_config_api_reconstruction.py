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


# ── Param line numbers across the reconstruction boundary ──────────────
# ParamUpdate carries no line_number, so every reconstructed param is 0.
# Section-anchored findings survive, but macro Jinja findings are computed
# as param.line + body offset: with param.line=0 they collapse to the bare
# offset (e.g. line 3) — a CONFIDENT wrong number the frontend treats as
# fresh and authoritative (the same class as the historical "dot on the
# wrong line" reports). The reconstructor now re-derives param lines from
# raw_text; a finding emitted for the rebuilt file must carry the same line
# as the same finding emitted from the fresh parse.

_FILLER = "\n".join(f"# filler line {i}" for i in range(1, 200))

JINJA_TEXT = _FILLER + """
[gcode_macro START_PRINT]
gcode:
  {% set foo = 1 %}
  {% if foo %}
    M117 hi
"""


def test_macro_jinja_line_matches_fresh_parse():
    fresh = client.post("/api/validate", json=_config_dict(JINJA_TEXT)).json()
    fresh_lines = [
        e["line_number"] for e in fresh["errors"]
        if e.get("code") == "macro_jinja_unterminated"
    ]
    assert len(fresh_lines) == 1, fresh["errors"]
    assert fresh_lines[0] > 200, "control: body offset must be file-absolute on parse"

    # Same payload shape the editor sends (to_dict + raw_text): the finding
    # must keep the authoritative line, not collapse to the body offset.
    res = client.post("/api/validate", json=_config_dict(JINJA_TEXT))
    rebuilt = [
        e for e in res.json()["errors"]
        if e.get("code") == "macro_jinja_unterminated"
    ]
    assert rebuilt and rebuilt[0]["line_number"] == fresh_lines[0], rebuilt


def test_param_value_error_line_restored_via_reconstruction():
    """A value error deep in the file keeps its param line (0 → heuristic
    fallback was the old behavior; the gutter dot for e.g. 'microsteps: abc'
    should anchor on the param line authoritatively)."""
    text = _FILLER + """

[printer]
kinematics: cartesian
max_velocity: 300
max_accel: 3000

[stepper_x]
step_pin: PF0
dir_pin: PF1
enable_pin: !PD7
microsteps: abc
rotation_distance: 40
endstop_pin: ^PE5
position_endstop: 0
position_max: 200

[stepper_y]
step_pin: PF6
dir_pin: !PF7
enable_pin: !PF2
microsteps: 16
rotation_distance: 40
endstop_pin: ^PJ1
position_endstop: 0
position_max: 200

[stepper_z]
step_pin: PL3
dir_pin: PL1
enable_pin: !PK0
microsteps: 16
rotation_distance: 8
endstop_pin: ^PD3
position_endstop: 0
position_max: 200

[mcu]
serial: /dev/ttyFAKE
"""
    d = _config_dict(text)
    microsteps_line = next(
        i for i, l in enumerate(text.splitlines(), start=1)
        if l.startswith("microsteps: abc")
    )
    res = client.post("/api/validate", json=d)
    errs = [e for e in res.json()["errors"] if e["param"] == "microsteps"]
    assert errs, res.json()["errors"]
    assert errs[0]["line_number"] == microsteps_line, errs


def test_renamed_param_line_stays_zero():
    """Params that don't exist in raw_text (graph-editor additions) must stay
    line 0 so the frontend heuristic resolves them — the matcher must not
    misattribute a neighboring param's line."""
    d = _config_dict("[printer]\nkinematics: cartesian\nmax_velocity: 300\nmax_accel: 3000\n")
    # Inject a brand-new section with a bad value that raw_text doesn't have.
    d["sections"].append({
        "full_header": "fan", "section_type": "fan", "section_name": "",
        "line_number": 0,
        "params": [
            {"key": "pin", "value": "PB0", "is_commented_out": False, "comment": "", "separator": ":"},
            {"key": "cycle_time", "value": "hello", "is_commented_out": False, "comment": "", "separator": ":"},
        ],
        "header_comments": [], "trailing_comments": [], "is_commented_out": False,
    })
    res = client.post("/api/validate", json=d)
    errs = [e for e in res.json()["errors"] if e["param"] == "cycle_time"]
    assert errs, res.json()["errors"]
    assert errs[0]["line_number"] == 0, (
        "invented params must not borrow a line from raw_text", errs)

