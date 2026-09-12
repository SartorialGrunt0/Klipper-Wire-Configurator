"""Acknowledgement management API: list / remove-one / clear-all.

Covers the three ack stores (unknown-section snippets, duplicate-section
types, bulk finding identities) behind the Settings-menu "Acknowledgements"
manager: GET /api/warning-acknowledgements, DELETE /api/warning-acknowledgements,
DELETE /api/warning-acknowledgements/all.

Store isolation: monkeypatch KWC_LAYOUT_DIR (the store always mkdirs under it).
"""
import sys
from pathlib import Path

from fastapi.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from main import app  # noqa: E402

client = TestClient(app)

SECTION_KEY = "[my_plugin_section]\nsome_param: 1"
DUP_TYPE = "gcode_macro"
IDENTITY = "printer.cfg|unknown_gcode_command|gcode_macro FOO|gcode|SET_BOGUS"


def _seed_stores(layout_dir):
    """Write one ack into each of the three stores via the existing POST API."""
    res = client.post("/api/warning-acknowledgements", json={
        "section": {
            "full_header": "my_plugin_section",
            "section_type": "my_plugin_section",
            "params": [{"key": "some_param", "value": "1"}],
        },
    })
    assert res.status_code == 200, res.text
    res = client.post("/api/warning-acknowledgements/duplicate", json={
        "section": {"full_header": "gcode_macro", "section_type": DUP_TYPE,
                    "params": []},
    })
    assert res.status_code == 200, res.text
    res = client.post("/api/warning-acknowledgements/bulk", json={
        "identities": [{
            "file": "printer.cfg",
            "code": "unknown_gcode_command",
            "section": "gcode_macro FOO",
            "param": "gcode",
            "extra": "SET_BOGUS",
        }],
    })
    assert res.status_code == 200, res.text


# ── GET listing ─────────────────────────────────────────────────


def test_get_empty_stores(monkeypatch, tmp_path):
    monkeypatch.setenv("KWC_LAYOUT_DIR", str(tmp_path))
    res = client.get("/api/warning-acknowledgements")
    assert res.status_code == 200
    data = res.json()
    assert data["sections"] == []
    assert data["duplicate_section_types"] == []
    assert data["identities"] == []


def test_get_lists_all_three_kinds(monkeypatch, tmp_path):
    monkeypatch.setenv("KWC_LAYOUT_DIR", str(tmp_path))
    _seed_stores(tmp_path)
    data = client.get("/api/warning-acknowledgements").json()
    assert len(data["sections"]) == 1
    assert "my_plugin_section" in data["sections"][0]
    assert data["duplicate_section_types"] == [DUP_TYPE]
    assert data["identities"] == [IDENTITY]


# ── DELETE one ──────────────────────────────────────────────────


def test_delete_identity_roundtrip(monkeypatch, tmp_path):
    monkeypatch.setenv("KWC_LAYOUT_DIR", str(tmp_path))
    _seed_stores(tmp_path)
    res = client.request(
        "DELETE", "/api/warning-acknowledgements",
        json={"kind": "identity", "key": IDENTITY},
    )
    assert res.status_code == 200, res.text
    assert res.json()["removed"] == 1
    data = client.get("/api/warning-acknowledgements").json()
    assert data["identities"] == []
    # Other stores untouched.
    assert len(data["sections"]) == 1
    assert data["duplicate_section_types"] == [DUP_TYPE]


def test_delete_duplicate_type_roundtrip(monkeypatch, tmp_path):
    monkeypatch.setenv("KWC_LAYOUT_DIR", str(tmp_path))
    _seed_stores(tmp_path)
    res = client.request(
        "DELETE", "/api/warning-acknowledgements",
        json={"kind": "duplicate", "key": DUP_TYPE},
    )
    assert res.status_code == 200, res.text
    data = client.get("/api/warning-acknowledgements").json()
    assert data["duplicate_section_types"] == []
    assert len(data["sections"]) == 1


def test_delete_section_snippet_roundtrip(monkeypatch, tmp_path):
    monkeypatch.setenv("KWC_LAYOUT_DIR", str(tmp_path))
    _seed_stores(tmp_path)
    snippet = client.get("/api/warning-acknowledgements").json()["sections"][0]
    res = client.request(
        "DELETE", "/api/warning-acknowledgements",
        json={"kind": "section", "key": snippet},
    )
    assert res.status_code == 200, res.text
    data = client.get("/api/warning-acknowledgements").json()
    assert data["sections"] == []
    assert data["duplicate_section_types"] == [DUP_TYPE]


def test_delete_unknown_key_is_404(monkeypatch, tmp_path):
    monkeypatch.setenv("KWC_LAYOUT_DIR", str(tmp_path))
    _seed_stores(tmp_path)
    res = client.request(
        "DELETE", "/api/warning-acknowledgements",
        json={"kind": "identity", "key": "nope|nope|nope||"},
    )
    assert res.status_code == 404


def test_delete_invalid_kind_is_422(monkeypatch, tmp_path):
    monkeypatch.setenv("KWC_LAYOUT_DIR", str(tmp_path))
    res = client.request(
        "DELETE", "/api/warning-acknowledgements",
        json={"kind": "bogus", "key": "x"},
    )
    assert res.status_code == 422


def test_delete_all_endpoints_empty_everything(monkeypatch, tmp_path):
    monkeypatch.setenv("KWC_LAYOUT_DIR", str(tmp_path))
    _seed_stores(tmp_path)
    res = client.request("DELETE", "/api/warning-acknowledgements/all")
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "cleared"
    data = client.get("/api/warning-acknowledgements").json()
    assert data["sections"] == []
    assert data["duplicate_section_types"] == []
    assert data["identities"] == []


# ── Deletion actually re-arms suppression ───────────────────────


def test_removed_identity_reappears_on_revalidation(monkeypatch, tmp_path):
    """Identity ack -> warning suppressed; delete the ack -> it's back."""
    monkeypatch.setenv("KWC_LAYOUT_DIR", str(tmp_path))
    from parser.validator import validate_config

    text = (
        "[stepper_x]\n"
        "step_pin: PF0\n"
        "dir_pin: PF1\n"
        "enable_pin: !PD7\n"
        "microsteps: 16\n"
        "rotation_distance: 40\n"
        "endstop_pin: ^PE5\n"
        "position_endstop: 0\n"
        "position_max: 200\n"
        "homing_speed: 50\n\n"
        "[gcode_macro FOO]\n"
        "gcode:\n"
        "    SET_BOGUS VALUE=1\n"
    )

    def warning_count():
        result = validate_config(parse(text))
        return sum(
            1 for e in result.errors
            if e.severity == "warning"
            and e.code == "unknown_gcode_command"
        )

    from parser.config_parser import parse_config as parse

    assert warning_count() == 1
    client.post("/api/warning-acknowledgements/bulk", json={
        "identities": [{
            "file": "printer.cfg",
            "code": "unknown_gcode_command",
            "section": "gcode_macro FOO",
            "param": "gcode",
            "extra": "SET_BOGUS",
        }],
    })
    assert warning_count() == 0
    client.request(
        "DELETE", "/api/warning-acknowledgements",
        json={"kind": "identity", "key": IDENTITY},
    )
    assert warning_count() == 1
