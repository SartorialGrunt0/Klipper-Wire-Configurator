"""Tests for the server-side AI draft pipeline (#1 apply+validate+repair,
#3 deterministic audit).

Covers:
- services/ai_reply_audit: stated-requirement checker, precondition table,
  LED inventory, footer assembly.
- services/ai_draft_validation: delta semantics, retry-exempt, shadow
  suppression, Jinja repair commands, REPAIR-01 feedback shape.
- api/ai_routes._server_validate_and_repair: clean apply, dirty apply with
  one successful repair, failed repair keeps the original, retry-exempt
  skips the query, flags-off returns unchanged.
"""
import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import api.ai_routes as ai_routes  # noqa: E402
from parser.config_parser import parse_config  # noqa: E402
from services.ai_reply_audit import (  # noqa: E402
    build_audit_footer,
    check_led_inventory,
    check_macro_preconditions,
    check_stated_requirements,
)
from services.ai_draft_validation import (  # noqa: E402
    build_validation_feedback,
    collect_new_validation_errors,
    derive_jinja_repair_commands,
    has_only_retry_exempt_issues,
    suppress_errors_shadowed_by_full_rewrite,
)


BASE_CFG = """\
[printer]
kinematics: corexy
max_velocity: 300
max_accel: 3000

[gcode_macro LEVEL_BED]
gcode:
  {% if "xyz" not in printer.toolhead.homed_axes %}
  G28
  {% endif %}
  BED_MESH_CALIBRATE

[neopixel CASE_LEDs]
pin: PB3

[neopixel SB_LEDs]
pin: PB6
"""


def _files():
    return {"printer.cfg": parse_config(BASE_CFG, "printer.cfg")}


# ── #3 audit: stated requirements ────────────────────────────────────


def test_requirement_check_passes_when_value_applied():
    files = _files()
    files["printer.cfg"].sections[0].params[2].value = "12000"  # max_accel
    notes = check_stated_requirements("set max_accel to 12000", files)
    assert notes == []


def test_requirement_check_flags_missing_value():
    notes = check_stated_requirements("set max_accel to 12000", _files())
    assert len(notes) == 1
    assert "max_accel" in notes[0] and "12000" in notes[0]


def test_requirement_check_grid_value():
    notes = check_stated_requirements("change probe_count to 3x3", _files())
    assert len(notes) == 1 and "probe_count" in notes[0]
    files = _files()
    files["printer.cfg"].sections.append(
        parse_config("[bed_mesh]\nprobe_count: 3,3\n", "printer.cfg").sections[0]
    )
    assert check_stated_requirements("change probe_count to 3x3", files) == []


def test_requirement_check_ignores_questions():
    assert check_stated_requirements("what is max_velocity?", _files()) == []


# ── #3 audit: preconditions ──────────────────────────────────────────


def test_precondition_flags_unhomed_bed_mesh():
    notes = check_macro_preconditions(
        [("gcode_macro LVL", "M104 S60\nBED_MESH_CALIBRATE\n")]
    )
    assert len(notes) == 1 and "G28" in notes[0]


def test_precondition_ok_when_homed():
    notes = check_macro_preconditions(
        [("gcode_macro LVL", "G28\nBED_MESH_CALIBRATE\n")]
    )
    assert notes == []


# ── #3 audit: LED inventory ──────────────────────────────────────────


def test_led_inventory_lists_siblings():
    notes = check_led_inventory(["neopixel CASE_LEDs"], _files())
    assert len(notes) == 1
    assert "SB_LEDs" in notes[0] and "CASE_LEDs" not in notes[0].split("were NOT changed")[1]


def test_led_inventory_silent_for_non_led_change():
    assert check_led_inventory(["printer"], _files()) == []


def test_audit_footer_format():
    assert build_audit_footer([]) == ""
    footer = build_audit_footer(["note one"])
    assert "Harness checks" in footer and "- note one" in footer


# ── #1 validation port semantics ─────────────────────────────────────


def _err(severity="error", section="s", param="", message="m", code=""):
    return {"severity": severity, "section": section, "param": param,
            "message": message, "line_number": 0, "code": code}


def test_delta_drops_pre_existing_errors():
    base = {"printer.cfg": {"errors": [_err(message="pre-existing")]}}
    cand = {"printer.cfg": {"errors": [_err(message="pre-existing"), _err(message="new")]}}
    issues = collect_new_validation_errors(base, cand)
    assert len(issues) == 1 and len(issues[0]["errors"]) == 1
    assert issues[0]["errors"][0]["message"] == "new"


def test_delta_multiset_counts_duplicates():
    base = {"f": {"errors": [_err(message="dup")]}}
    cand = {"f": {"errors": [_err(message="dup"), _err(message="dup")]}}
    issues = collect_new_validation_errors(base, cand)
    assert issues[0]["errors"][0]["message"] == "dup"


def test_retry_exempt_classification():
    exempt = [{"filename": "f", "errors": [_err(code="shared_pin", severity="warning")]}]
    assert has_only_retry_exempt_issues(exempt)
    mixed = exempt + [{"filename": "f", "errors": [_err(code="unknown_param")]}]
    assert not has_only_retry_exempt_issues(mixed)


def test_jinja_repair_command_derivation():
    issues = [{"filename": "f", "errors": [_err(
        section="gcode_macro M300",
        message="Template: Unexpected end of template. The innermost block that needs to be closed is 'if'",
        code="macro_jinja_unterminated",
    )]}]
    cmds = derive_jinja_repair_commands(issues)
    assert cmds == [
        "The innermost open Jinja block in [gcode_macro M300] is 'if' — append {% endif %} at the end of its gcode body."
    ]


def test_feedback_shape_repair01():
    issues = [{"filename": "printer.cfg", "errors": [_err(message="bad thing")]}]
    fb = build_validation_feedback(issues, None)
    assert "Do NOT copy or repeat your previous reply" in fb
    assert "read_user_config" in fb
    assert "bad thing" in fb
    # The invalid content is never part of the feedback (lean by construction).
    assert "Previous invalid reply" not in fb


def test_full_rewrite_shadow_suppression():
    issues = [{"filename": "f.cfg", "errors": [
        _err(section="gcode_macro M300", message="full rewrite", code="macro_full_rewrite"),
        _err(section="gcode_macro M300", param="gcode", message="artifact", code="unknown_param"),
        _err(section="bed_mesh", param="mesh_min", message="real", code="unknown_param"),
    ]}]
    out = suppress_errors_shadowed_by_full_rewrite(issues)
    kept = [(e["section"], e["message"]) for g in out for e in g["errors"]]
    assert ("bed_mesh", "real") not in kept
    assert ("gcode_macro M300", "full rewrite") in kept


# ── #1 route-level flow ──────────────────────────────────────────────


def _chat_request(context_files, **over):
    return ai_routes.ChatRequest(
        messages=[{"role": "user", "content": "tweak the config"}],
        apiKey="",
        model="test-model",
        apiUrl="http://localhost:1234/v1/chat/completions",
        apiProvider="chatgpt",
        contextFiles=context_files,
        **over,
    )


def _ctx():
    return {"printer.cfg": {"content": BASE_CFG, "label": "Active config"}}


DIRTY_REPLY = """\
Sure:

```cfg
# file: printer.cfg
[printer]
bogus_param_here: 1
```
"""

CLEAN_REPLY = """\
Sure:

```cfg
# file: printer.cfg
[printer]
max_accel: 12000
```
"""


def _run_validate(req, content, repair_response=None, capture=None):
    """Call _server_validate_and_repair with a stubbed provider query."""

    async def fake_query(client, url, headers, payload, provider, logger_context="", stop_event=None):
        if capture is not None:
            capture.append({"payload": payload, "context": logger_context})
        if repair_response is None:
            raise AssertionError("repair query issued but none configured")
        return repair_response, {"choices": [{"message": {"content": repair_response}}]}

    original = ai_routes._query_provider
    ai_routes._query_provider = fake_query
    try:
        return asyncio.run(req and ai_routes._server_validate_and_repair(
            None, req, {}, content, list(req.messages), [], None,
        ))
    finally:
        ai_routes._query_provider = original


def test_dirty_reply_repaired_by_one_query(monkeypatch):
    monkeypatch.setenv("KWC_SERVER_DRAFT_VALIDATION", "1")
    monkeypatch.setattr(ai_routes, "load_printer_memory", lambda: None, raising=False)
    req = _chat_request(_ctx())
    captured = []
    # Realistic REPAIR-01 reply: the feedback reports both the unknown param
    # and the missing required kinematics, so the model rewrites the full
    # section (guard off by default → full writes accepted).
    repair = (
        "```cfg\n# file: printer.cfg\n[printer]\n"
        "kinematics: corexy\nmax_velocity: 300\nmax_accel: 3000\n```"
    )
    content, info = _run_validate(req, DIRTY_REPLY, repair_response=repair, capture=captured)
    assert info == {"attempted": True, "repaired": True, "issuesAfter": []}
    assert content == repair
    assert len(captured) == 1
    assert captured[0]["context"] == "server-repair-1"
    # Feedback must follow REPAIR-01: no quoting of the previous reply.
    repair_user_msg = captured[0]["payload"]["messages"][-1]["content"]
    assert "Do NOT copy or repeat your previous reply" in repair_user_msg
    assert "bogus_param_here" in repair_user_msg


def test_failed_repair_keeps_original(monkeypatch):
    monkeypatch.setenv("KWC_SERVER_DRAFT_VALIDATION", "1")
    req = _chat_request(_ctx())
    still_bad = "```cfg\n# file: printer.cfg\n[printer]\nbogus_param_here: 2\n```"
    content, info = _run_validate(req, DIRTY_REPLY, repair_response=still_bad)
    assert info["attempted"] is True
    assert info["repaired"] is False
    # Original reply stands — never show a worse one.
    assert content == DIRTY_REPLY
    assert info["issuesAfter"]


def test_prose_only_reply_untouched(monkeypatch):
    monkeypatch.setenv("KWC_SERVER_DRAFT_VALIDATION", "1")
    req = _chat_request(_ctx())
    content, info = _run_validate(req, "Just an explanation, no cfg block.", repair_response=None)
    assert content == "Just an explanation, no cfg block."
    assert info is None


def test_no_context_files_short_circuits(monkeypatch):
    monkeypatch.setenv("KWC_SERVER_DRAFT_VALIDATION", "1")
    req = _chat_request({})
    content, info = _run_validate(req, DIRTY_REPLY, repair_response=None)
    assert info is None and content == DIRTY_REPLY


def test_retry_exempt_does_not_burn_query(monkeypatch):
    monkeypatch.setenv("KWC_SERVER_DRAFT_VALIDATION", "1")
    # A duplicate [printer] section is project_duplicate → retry-exempt.
    dup_reply = "```cfg\n# file: printer.cfg\n[printer]\nkinematics: corexy\nmax_velocity: 300\nmax_accel: 3000\n```"
    req = _chat_request(_ctx())

    def boom(*a, **k):
        raise AssertionError("repair query must not be issued for retry-exempt issues")

    original = ai_routes._query_provider
    ai_routes._query_provider = boom
    try:
        content, info = asyncio.run(ai_routes._server_validate_and_repair(
            None, req, {}, dup_reply, list(req.messages), [], None,
        ))
    finally:
        ai_routes._query_provider = original
    # Same-section restate may merge identically (no new errors) OR surface
    # project_duplicate; either way, no query was issued (boom unused).
    assert content == dup_reply


def test_audit_footer_on_clean_apply(monkeypatch):
    # Audit-only mode: both harness flags default ON (2026-09-09), so
    # validation must be explicitly disabled to isolate the audit path.
    monkeypatch.setenv("KWC_POST_APPLY_AUDIT", "1")
    monkeypatch.setenv("KWC_SERVER_DRAFT_VALIDATION", "0")
    req = _chat_request(_ctx())
    req.messages = [{"role": "user", "content": "set max_accel to 99999"}]
    content, info = _run_validate(req, CLEAN_REPLY, repair_response=None)
    assert info is None  # audit-only mode returns no repair info
    # 99999 was NOT applied (reply set 12000) → requirement note attached.
    assert "Harness checks" in content
    assert "99999" in content
