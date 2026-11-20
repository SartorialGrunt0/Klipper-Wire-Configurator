"""PR #43 round-1 review fixes (all findings except the deferred verdict-
guard redesign, which Clifford reviews with the macro skills separately).

Contract pinned here, by finding id:

A-01  Letter params tokenize with Klipper's args_r pairing (gcode.py:198-215):
      a space between the letter and its value ('M106 S 100') is legal and
      must not raise macro_param_renders_empty.
A-02  Param-dependence shield survives attribution loss: a one-line
      '{% if %}…{% endif %}' without a space after the tag loses its
      line_src and must still be treated as param-dependent, never
      escalated to an error.
A-03  The fail-open / refuse-early paths no longer mute the compile check:
      Klipper compiles the whole body at load, so a body with a Jinja
      syntax error reports macro_jinja_syntax even when the simulation
      path bails early ({% raw %}, huge range).
A-04  The SET_GCODE_VARIABLE unquoted-VALUE advice quotes correctly:
      VALUE="'on'" — the old advice (plain VALUE='on') is itself broken
      because the tokenizer strips the quotes.
B-02  McpServer._handle_validate_macro structural scans are bounded to the
      named macro's OWN section: a later macro's broken body is not
      attributed to it, and its own missing 'gcode:' is not suppressed.
B-03  POST /ai/context-window degrades to graceful null when a 200 body is
      not JSON (res.json() raises ValueError, NOT httpx.HTTPError).
B-04  The work-ledger flood cap drops the OLDEST rows — turnOffset 1 is the
      NEWEST turn, so the tail is what the model needs.
B-05  The sim hardware inventory judges a disk-only include (overlay sees
      the includer, the 512 KB mirror cap skipped the included file) as
      UNDECIDABLE, never as hardware-absent.
C-02  scripts/validate_criteria_offline.py is fail-closed: a missing report
      leg and a zero-rows examination reach the exit status.
"""
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import pytest  # noqa: E402

import mcp_server  # noqa: E402
from mcp_server import McpServer  # noqa: E402
from parser.macro_render import simulate_macro_uncached  # noqa: E402

INV = dict(params={}, invocation_given=True)
NOINV = dict(params={}, invocation_given=False)


def _codes(result):
    return {(f.severity, f.code) for f in result.findings}


# ── A-01 ──────────────────────────────────────────────────────────────────

def test_letter_param_whitespace_is_klipper_legal():
    # 'M106 S 100' pairs as S='100' under args_r (gcode.py:198-215); the
    # old naive whitespace split saw an empty S and errored a legal line.
    assert _codes(simulate_macro_uncached("M106 S 100", **INV)) == set()


def test_letter_param_tight_shape_still_clean():
    assert _codes(simulate_macro_uncached("M106 S100", **INV)) == set()


# ── A-02 ──────────────────────────────────────────────────────────────────

def test_one_line_if_no_space_keeps_param_dependence_shield():
    # Line attribution fails on this legal shape; the shield must fire
    # anyway: with invocation_given=False the body is never adjudicated
    # against absent params, and NOTHING escalates to an error. (The
    # space-separated shape still gets the honest info-level hint —
    # equivalence was never the contract; error-freedom is.)
    b_nospace = "{% if params.A is defined %}SET_LED LED=x RED={params.R}{% endif %}"
    b_space = "{% if params.A is defined %} SET_LED LED=x RED={params.R}{% endif %}"
    for body in (b_nospace, b_space):
        codes = _codes(simulate_macro_uncached(body, **NOINV))
        assert not any(sev == "error" for sev, _ in codes), body
        assert ("error", "macro_param_renders_empty") not in codes, body


# ── A-03 ──────────────────────────────────────────────────────────────────

def test_raw_body_syntax_error_still_reports_jinja_syntax():
    body = "M117 {% raw %}{{ x }}{% endraw %}\n{% if %}"
    codes = _codes(simulate_macro_uncached(body, **INV))
    assert ("error", "macro_jinja_syntax") in codes


def test_huge_range_body_syntax_error_still_reports():
    body = "M117 ok\n{% for i in range(1000000) %}M117 x{% endfor %}\n{% if %}"
    codes = _codes(simulate_macro_uncached(body, **INV))
    assert ("error", "macro_jinja_syntax") in codes


def test_valid_raw_body_stays_clean():
    body = "M117 {% raw %}{{ x }}{% endraw %}"
    assert _codes(simulate_macro_uncached(body, **INV)) == set()


# ── A-04 ──────────────────────────────────────────────────────────────────

def test_set_gcode_variable_advice_quotes_correctly():
    result = simulate_macro_uncached(
        "SET_GCODE_VARIABLE MACRO=X VARIABLE=y VALUE=on", **INV)
    advice = [f for f in result.findings if f.code == "macro_param_unparseable"]
    assert advice, "unquoted VALUE=on must error"
    msg = advice[0].message
    assert 'VALUE="\'on\'"' in msg          # the shape that actually works
    assert "quotes stripped" in msg          # and WHY plain VALUE='on' fails


# ── B-02 ──────────────────────────────────────────────────────────────────

def test_validate_macro_is_bounded_to_the_named_macro_section():
    out = McpServer()._handle_validate_macro({"macro_text": (
        "[gcode_macro FOO]\n"
        "description: fine\n"
        "\n"
        "[gcode_macro BAR]\n"
        "gcode:\n"
        "  {% if %}\n"
    )})
    low = out.lower()
    # BAR's broken body must not be reported as FOO's compile error…
    assert "compile" not in low
    # …and FOO's own missing gcode: must not be masked by BAR having one.
    assert "missing" in low and "gcode" in low


# ── B-03 ──────────────────────────────────────────────────────────────────

def test_context_window_non_json_body_degrades_to_null(monkeypatch):
    from fastapi.testclient import TestClient
    from main import app
    import api.ai_routes as ai_routes

    class _StubResponse:
        status_code = 200

        def raise_for_status(self):
            pass

        def json(self):
            # Exactly what a proxy landing page raises: JSONDecodeError,
            # a ValueError — NOT an httpx.HTTPError.
            raise ValueError("Expecting value: line 1 column 1 (char 0)")

    class _StubClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, headers=None):
            return _StubResponse()

    monkeypatch.setattr(ai_routes.httpx, "AsyncClient", _StubClient)
    client = TestClient(app)
    res = client.post("/ai/context-window", json={
        "apiUrl": "https://misconfigured.invalid/v1/chat/completions",
        "apiKey": "k",
        "model": "some-model",
    })
    assert res.status_code == 200          # never a 500
    body = res.json()
    assert body["contextWindow"] is None
    assert body["error"]


# ── B-04 ──────────────────────────────────────────────────────────────────

def test_ledger_flood_cap_keeps_the_newest_rows():
    import api.ai_routes as ai_routes

    rows = [{"turnOffset": 9, "file": "p.cfg", "section": "aaa_oldest",
             "verdict": "kept"}]
    pad = [{"turnOffset": 9, "file": "p.cfg", "section": f"pad{i:03d}",
            "verdict": "kept"} for i in range(ai_routes.WORK_LEDGER_MAX_ROWS)]
    rows += pad + [{"turnOffset": 1, "file": "p.cfg", "section": "zzz_newest",
                    "verdict": "kept"}]
    text = ai_routes._render_work_ledger(rows)
    assert "zzz_newest" in text            # the recent staging is FOR this
    assert "aaa_oldest" not in text        # the old tail is what gets dropped
    assert text.count("-> kept") == ai_routes.WORK_LEDGER_MAX_ROWS


# ── B-05 ──────────────────────────────────────────────────────────────────

def test_disk_only_include_makes_hardware_undecidable(monkeypatch):
    # Overlay: printer.cfg is mirrored, the included file is NOT (the 512 KB
    # per-file mirror cap). The include resolves to a real file (on disk)
    # whose sections are invisible → NO absence verdict.
    monkeypatch.setattr(mcp_server, "_working_scan_items", lambda: [
        ("printer.cfg", "[include parts/leds.cfg]\n[printer]\nmax_velocity: 300\n"),
    ])
    monkeypatch.setattr(McpServer, "_sim_disk_config_names",
                        staticmethod(lambda: {"leds.cfg"}))
    assert McpServer()._sim_project_sections() is None


def test_included_file_visible_in_overlay_yields_sections(monkeypatch):
    monkeypatch.setattr(mcp_server, "_working_scan_items", lambda: [
        ("printer.cfg", "[include parts/leds.cfg]\n[printer]\nmax_velocity: 300\n"),
        ("parts/leds.cfg", "[neopixel chamber]\npin: PB1\n"),
    ])
    monkeypatch.setattr(McpServer, "_sim_disk_config_names",
                        staticmethod(lambda: set()))
    sections = McpServer()._sim_project_sections()
    assert sections is not None
    assert any("neopixel" in s for s in sections)


# ── C-02 ──────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def criteria_offline():
    path = ROOT / "scripts" / "validate_criteria_offline.py"
    spec = importlib.util.spec_from_file_location("vco", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["vco"] = mod
    spec.loader.exec_module(mod)
    return mod


def test_missing_leg_fails_the_gate(criteria_offline, capsys):
    assert criteria_offline.main(["no_such_leg_xyz"]) != 0
    out = capsys.readouterr().out
    assert "no run json" in out and "FAIL" in out


def test_zero_rows_examined_fails_the_gate(criteria_offline, monkeypatch, capsys):
    report = Path("/tmp/pr43_c02_empty_leg.json")
    report.write_text(json.dumps({"results": [{"qid": "NOT-A-QID",
                                               "answer_ok": True}]}))
    monkeypatch.setattr(criteria_offline, "glob_json",
                        lambda name: [str(report)])
    assert criteria_offline.main(["anything"]) != 0
    out = capsys.readouterr().out
    assert "zero bank rows examined" in out
