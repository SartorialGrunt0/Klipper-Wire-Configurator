"""The malformed_config_line finding must survive the VALIDATION API path.

Same reconstruction trap class as unclosed_section_header: the frontend
live-edit path serializes the model (to_dict() — which does NOT carry
malformed_lines) plus raw_text to /validate and /validate-project. The
reconstructor re-derives malformed_lines from raw_text; without it, a
value accidentally wrapped to column 0 (the rename_existing shape) would
show clean in the editor's gutter while Klipper refuses to load.

Also covers the user-reported rename_existing: <unindented continuation>
end-to-end through the API.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402
from parser.config_parser import parse_config  # noqa: E402

CODE = "malformed_config_line"
client = TestClient(app)


def _config_dict(text: str, filename: str = "printer.cfg") -> dict:
    d = parse_config(text, filename).to_dict()
    d["raw_text"] = text
    return d


def _project_body(files: dict[str, str]) -> dict:
    return {"config_files": [_config_dict(t, fn) for fn, t in files.items()]}


WRAP_TEXT = (
    "[gcode_macro PROBE_ACCURACY]\n"
    "rename_existing: \n"
    "PROBE_ACCURACY\n"
    "gcode:\n"
    "  M114\n"
)


def test_validate_project_flags_wrap():
    res = client.post("/api/validate-project", json=_project_body({
        "printer.cfg": WRAP_TEXT,
        "macros.cfg": "[gcode_macro OTHER]\ngcode:\n  M115\n",
    }))
    assert res.status_code == 200
    files = res.json()["files"]
    codes = [e.get("code") for e in files["printer.cfg"]["errors"]]
    assert CODE in codes


def test_validate_single_flags_wrap():
    res = client.post("/api/validate", json=_config_dict(WRAP_TEXT))
    assert res.status_code == 200
    codes = [e.get("code") for e in res.json()["errors"]]
    assert CODE in codes


def test_parse_path_flags_wrap():
    res = client.post("/api/parse", json={"text": WRAP_TEXT, "filename": "printer.cfg"})
    assert res.status_code == 200
    codes = [e.get("code") for e in res.json()["validation"]["errors"]]
    assert CODE in codes


def test_valid_rename_clean_on_api():
    ok = WRAP_TEXT.replace(
        "rename_existing: \nPROBE_ACCURACY",
        "rename_existing: _PROBE_ACCURACY")
    res = client.post("/api/validate-project", json=_project_body({
        "printer.cfg": ok,
        "macros.cfg": "[gcode_macro OTHER]\ngcode:\n  M115\n",
    }))
    files = res.json()["files"]
    codes = [e.get("code") for e in files["printer.cfg"]["errors"]]
    assert CODE not in codes
