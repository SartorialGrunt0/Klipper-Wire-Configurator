"""
Regression: the malformed-header (unclosed '[') finding must survive the
VALIDATION API path, not just the raw-text /parse path.

The frontend's live-edit path does NOT send raw text to /parse for
validation — it sends the serialized model dicts (ConfigFile.to_dict()
shape, with raw_text attached) to /validate and /validate-project, which
reconstruct ConfigFile objects server-side. to_dict() does not serialize
unclosed_headers, so the reconstruction had to re-derive it from raw_text.
Without that, a broken header typed into the editor was silently clean in
the project validation the center gutter renders from.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402
from parser.config_parser import parse_config  # noqa: E402

CODE = "unclosed_section_header"
client = TestClient(app)


def _config_dict(text: str, filename: str = "printer.cfg") -> dict:
    """Exactly what the frontend store sends: to_dict() + raw_text."""
    d = parse_config(text, filename).to_dict()
    d["raw_text"] = text
    return d


def _project_body(files: dict[str, str]) -> dict:
    return {"config_files": [_config_dict(t, fn) for fn, t in files.items()]}


def test_validate_project_flags_unclosed_header():
    res = client.post("/api/validate-project", json=_project_body({
        "printer.cfg": "[include a.cfg]\n[printer]\nkinematics: cartesian\n",
        "a.cfg": "[mcu mainboard\nserial: /dev/ttyUSB0\n",
    }))
    assert res.status_code == 200
    findings = [
        e for e in res.json()["files"]["a.cfg"]["errors"] if e["code"] == CODE
    ]
    assert findings, f"unclosed header must be flagged via the API path: {res.json()['files']['a.cfg']['errors']}"
    assert findings[0]["severity"] == "error"
    assert findings[0]["line_number"] == 1


def test_validate_single_file_flags_unclosed_header():
    res = client.post("/api/validate", json=_config_dict("[mcu\nstatus_timeout: 500\n"))
    assert res.status_code == 200
    findings = [e for e in res.json()["errors"] if e["code"] == CODE]
    assert findings, "single-file /validate must flag the unclosed header too"
    assert findings[0]["line_number"] == 1


def test_well_formed_file_stays_clean_via_api():
    res = client.post("/api/validate", json=_config_dict(
        "[printer]\nkinematics: corexy\n[mcu mainboard]\nserial: /dev/ttyUSB0\n"))
    assert res.status_code == 200
    assert not [e for e in res.json()["errors"] if e["code"] == CODE], \
        "well-formed headers must not be flagged via the API path"


def test_raw_text_absent_yields_no_false_positive():
    # A reconstructed file WITHOUT raw_text (older client) must simply have
    # no malformed-header findings — not a crash, not a false positive.
    d = _config_dict("[mcu mainboard\nserial: /dev/ttyUSB0\n")
    d.pop("raw_text")
    res = client.post("/api/validate", json=d)
    assert res.status_code == 200
    assert not [e for e in res.json()["errors"] if e["code"] == CODE]
