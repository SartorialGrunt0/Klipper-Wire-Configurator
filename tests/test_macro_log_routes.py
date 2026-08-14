"""Tests for the Macro Designer trace log endpoint (/api/log/macro-designer)."""
import json
import logging
import sys
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from main import app  # noqa: E402
from api.macro_log_routes import MACRO_DESIGNER_LOG  # noqa: E402

client = TestClient(app)


def test_macro_log_endpoint_appends_json_lines(tmp_path):
    # Point the handler at a temp file so we don't pollute the real log.
    logger = logging.getLogger("kwc.macro_designer")
    for handler in list(logger.handlers):
        logger.removeHandler(handler)
    temp_log = tmp_path / "macro_designer.log"
    handler = logging.FileHandler(temp_log, mode="a", encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s | %(message)s"))
    logger.addHandler(handler)

    resp = client.post("/api/log/macro-designer", json={
        "events": [
            {"event": "apply", "title": "PRINT_START", "action": "update"},
            {"event": "sim:plan", "macro": "PRINT_START", "stepCount": 3},
        ],
    })

    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "count": 2}

    lines = temp_log.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 2
    for line in lines:
        assert "EVENT " in line
        # Each line carries the full JSON event payload.
        payload = json.loads(line.split("EVENT ", 1)[1])
        assert "event" in payload


def test_macro_log_endpoint_handles_empty_batch(tmp_path):
    resp = client.post("/api/log/macro-designer", json={"events": []})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "count": 0}
