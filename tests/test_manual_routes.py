"""Tests for the embedded user manual endpoints (/api/manual)."""
import os
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
    # The manual ends with an appendix section (survives section renumbers)
    assert data["sections"][-1].endswith("appendix")
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
    # Pager nav: middle section has both links
    assert 'href="/api/manual/01-getting-started"' in html
    assert 'href="/api/manual/03-text-ui"' in html


def test_manual_section_html_popout_pager_edges():
    sections = client.get("/api/manual").json()["sections"]
    assert len(sections) >= 3
    first, last = sections[0], sections[-1]
    first_html = client.get(f"/api/manual/{first}").text
    assert f'href="/api/manual/{first}"' not in first_html  # no prev
    assert f'href="/api/manual/{sections[1]}"' in first_html  # next
    last_html = client.get(f"/api/manual/{last}").text
    assert f'href="/api/manual/{last}"' not in last_html  # no next
    assert f'href="/api/manual/{sections[-2]}"' in last_html  # prev


def test_manual_markdown_fences_balanced():
    # A stray ``` line opens a code fence that swallows everything after it,
    # silently hiding headings, figures, and nav. Every section's fences must
    # be balanced (even count) so no content is eaten.
    for md in sorted(os.listdir(MANUAL_DIR)):
        if not md.endswith(".md") or not md[0].isdigit():
            continue
        text = (MANUAL_DIR / md).read_text(encoding="utf-8")
        fences = sum(1 for line in text.splitlines() if line.startswith("```"))
        assert fences % 2 == 0, f"{md} has an odd number ({fences}) of code fences"


def test_manual_section_html_missing():
    resp = client.get("/api/manual/99-nope")
    assert resp.status_code == 404
