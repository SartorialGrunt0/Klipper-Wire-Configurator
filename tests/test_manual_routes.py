"""Tests for the embedded user manual endpoints (/api/manual)."""
import sys
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from main import app  # noqa: E402
from api.manual_routes import MANUAL_DIR, FIGURES_DIR  # noqa: E402

client = TestClient(app)


def test_manual_section_list():
    resp = client.get("/api/manual")
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] == len(data["sections"])
    assert "01-getting-started" in data["sections"]
    assert "10-appendix" in data["sections"]
    # Sections come back sorted and contain no non-section files
    assert data["sections"] == sorted(data["sections"])
    assert all(s[0].isdigit() for s in data["sections"])


def test_manual_section_content():
    resp = client.get("/api/manual", params={"section": "01-getting-started"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["section"] == "01-getting-started"
    assert "KWC" in data["content"]
    # Relative figure links are rewritten to the API route
    assert "](./figures/" not in data["content"]
    if "figures/" in data["content"]:
        assert "/api/manual/figures/" in data["content"]
    # Cross-section links are rewritten to absolute API routes
    assert "](./02-graph-ui.md)" not in data["content"]
    if "02-graph-ui.md" in (MANUAL_DIR / "01-getting-started.md").read_text():
        assert "](/api/manual/02-graph-ui)" in data["content"]


def test_manual_section_missing():
    resp = client.get("/api/manual", params={"section": "99-nope"})
    assert resp.status_code == 404


def test_manual_section_name_traversal_rejected():
    for bad in ("..", "../main", "main.py"):
        resp = client.get("/api/manual", params={"section": bad})
        assert resp.status_code in (400, 404), bad


def test_manual_figure_served():
    # Pick any real figure that exists
    figs = sorted(p.name for p in FIGURES_DIR.glob("fig-*") if p.suffix in (".png", ".svg"))
    assert figs, f"no figures found in {FIGURES_DIR}"
    resp = client.get(f"/api/manual/figures/{figs[0]}")
    assert resp.status_code == 200
    assert len(resp.content) > 0


def test_manual_figure_traversal_rejected():
    # Starlette normalizes some /.. paths (e.g. ".." → /api/manual/ → JSON
    # section list; others fall through to the SPA catch-all). The invariant:
    # the figures route never serves file content from outside figures/.
    for bad in ("..", "....", "..%2F..%2Fetc%2Fpasswd", "../secret.txt", "main.py", "..%2f..%2fetc%2fpasswd"):
        resp = client.get(f"/api/manual/figures/{bad}")
        ctype = resp.headers.get("content-type", "")
        assert resp.status_code in (400, 404) or ctype.startswith(("application/json", "text/html")), bad
        assert "root:" not in resp.text  # no /etc/passwd content
        assert not ctype.startswith("image/"), bad


def test_manual_section_html_popout():
    resp = client.get("/api/manual/02-graph-ui")
    assert resp.status_code == 200
    assert "text/html" in resp.headers["content-type"]
    html = resp.text
    assert "<!doctype html>" in html.lower()
    assert "KWC User Manual" in html
    # Figures are served from the API route in the pop-out page
    assert "/api/manual/figures/" in html
    # Cross-section nav links are absolute
    assert 'href="/api/manual/01-getting-started"' in html or 'href="/api/manual/03-text-ui"' in html


def test_manual_section_html_missing():
    resp = client.get("/api/manual/99-nope")
    assert resp.status_code == 404
