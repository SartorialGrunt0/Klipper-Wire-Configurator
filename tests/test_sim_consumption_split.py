"""W4R.2 consumption-split contract (decisions D1/D2/D3, plan
2026-11-12_205839-macro-jinja-reliability.md).

- D1: human-facing validation responses never carry render-simulation
  WARNINGS/INFOS; sim ERRORS pass (true rendered-shape defects).
- D2: the AI write-path delta gate sees sim findings ONLY at error
  severity — never as advisories.
- D3: sim warnings/infos exist as tool results — the validate_macro
  façade (and, from 4R.3, simulate_macro) show the full set.
- Isolation: the engine itself stays unfiltered — the harness
  (staged_renders_clean grader, W3 tracer) reads it directly and must
  keep seeing every severity.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402
from parser.macro_render import SIM_FINDING_CODES, simulate_macro  # noqa: E402
from services.ai_draft_project import ProjectState  # noqa: E402

client = TestClient(app)

# Bare-invocation numeric filter on an undeclared param: sim WARNING
# (macro_param_undefined) — Klipper aborts, but only on this
# (hypothetical) invocation shape.
WARN_MACRO_TEXT = "M117 {params.FOO|int}"
# Required registry value rendering EMPTY: sim ERROR — the command is
# broken on every invocation.
ERROR_MACRO_TEXT = "SET_LED LED=strips RED={params.RED}"

_BASE = ("[printer]\nkinematics: cartesian\nmax_velocity: 200\n"
         "max_accel: 1000\nmax_z_velocity: 5\nmax_z_accel: 100\n")


def _section(full_header, section_type, params, section_name=""):
    return {
        "full_header": full_header,
        "section_type": section_type,
        "section_name": section_name,
        "params": [{"key": k, "value": v} for k, v in params.items()],
    }


def _validate_payload(macro_text, **kw):
    return {
        "filename": "printer.cfg",
        "sections": [
            _section("printer", "printer", {
                "kinematics": "cartesian", "max_velocity": "200",
                "max_accel": "1000", "max_z_velocity": "5",
                "max_z_accel": "100"}),
            _section("gcode_macro SIM", "gcode_macro",
                     {"gcode": macro_text}, "SIM"),
        ],
        "includes": [],
        "header_comments": [],
        "raw_text": None,
        **kw,
    }


def _codes(body):
    return [e["code"] for e in body.get("errors", [])]


# ── D1: human-facing API boundary ─────────────────────────────────────────

def test_validate_api_never_shows_sim_warnings():
    r = client.post('/api/validate', json=_validate_payload(WARN_MACRO_TEXT))
    assert r.status_code == 200
    assert "macro_param_undefined" not in _codes(r.json())


def test_validate_api_still_shows_sim_errors():
    r = client.post('/api/validate', json=_validate_payload(ERROR_MACRO_TEXT))
    assert r.status_code == 200
    errs = [e for e in r.json()["errors"]
            if e["code"] == "macro_param_renders_empty"]
    assert len(errs) == 1
    assert errs[0]["severity"] == "error"


def test_validate_api_boundary_vacuity_lock():
    """The sim ERROR above must DISAPPEAR with gcode_registry=False —
    proving the sim pass really ran on the registry path and the filter
    is a SEVERITY split, not an accident of the sim never firing."""
    r = client.post('/api/validate',
                    json=_validate_payload(ERROR_MACRO_TEXT,
                                           gcode_registry=False))
    assert r.status_code == 200
    assert "macro_param_renders_empty" not in _codes(r.json())


def test_validate_project_api_never_shows_sim_advisories():
    r = client.post('/api/validate-project', json={
        "config_files": [
            _validate_payload(WARN_MACRO_TEXT),
            _validate_payload(ERROR_MACRO_TEXT, filename="leds.cfg"),
        ],
    })
    assert r.status_code == 200
    files = r.json()["files"]
    assert "macro_param_undefined" not in _codes(files["printer.cfg"])
    codes_leds = _codes(files["leds.cfg"])
    assert "macro_param_renders_empty" in codes_leds  # errors survive
    assert not any(c in ("macro_param_undefined", "macro_render_blocked",
                         "macro_render_unexplored", "macro_unknown_value",
                         "macro_rendered_g1_no_feedrate")
                   for c in codes_leds)


def test_parse_endpoint_never_shows_sim_warnings():
    text = _BASE + "[gcode_macro SIM]\ngcode:\n    " + WARN_MACRO_TEXT + "\n"
    r = client.post('/api/parse', json={"text": text,
                                        "filename": "printer.cfg"})
    assert r.status_code == 200
    assert "macro_param_undefined" not in _codes(r.json()["validation"])


# ── D2: the delta gate keeps sim errors, drops sim advisories ─────────────

def _draft_state():
    st = ProjectState({'printer.cfg': _BASE})
    return st, st.validate()


def test_delta_gate_drops_sim_advisory():
    """Pre-fix this op kicked back an advisory carrying
    macro_param_undefined (bare-call hypothetical). Post-fix: clean
    'applied' — no sim code reaches either channel."""
    st, base = _draft_state()
    st1, r = st.apply(base, {
        'op': 'add_section', 'file': 'printer.cfg',
        'section': 'gcode_macro SIM_WARN',
        'text': "gcode:\n    " + WARN_MACRO_TEXT})
    assert r['status'] == 'applied', r
    leaked = [f for f in r['advisories'] + r['newErrors']
              if f.get('code') in SIM_FINDING_CODES]
    assert leaked == []


def test_delta_gate_sim_error_still_kicks_back():
    """A written macro that renders a required value EMPTY is a real
    defect of the edit at hand: it must still block the op (D2 keeps
    sim errors in the write path)."""
    st, base = _draft_state()
    st1, r = st.apply(base, {
        'op': 'add_section', 'file': 'printer.cfg',
        'section': 'gcode_macro SIM_ERR',
        'text': "gcode:\n    " + ERROR_MACRO_TEXT})
    assert r['status'] == 'error'
    assert any(f.get('code') == "macro_param_renders_empty"
               for f in r['newErrors'])


# ── D3: tool surfaces show everything; engine stays unfiltered ────────────

def test_facade_shows_sim_warning():
    from mcp_server import McpServer
    out = McpServer()._handle_validate_macro({
        'macro_text': "[gcode_macro SIM]\ngcode:\n    " + WARN_MACRO_TEXT})
    assert 'FOO' in out  # the warning is visible on the tool surface


def test_engine_result_is_never_filtered():
    """Isolation pin: harness graders and the W3 tracer call the engine
    directly; the pivot moved severity filtering to CONSUMERS, never to
    simulate_macro itself."""
    res = simulate_macro(WARN_MACRO_TEXT)
    assert any(f.code == "macro_param_undefined" and f.severity == "warning"
               for f in res.findings)
