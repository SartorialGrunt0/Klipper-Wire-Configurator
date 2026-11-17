"""Pre-edit verdict guard — simulate-then-silently-fix amnesia.

MACRO-17 measured the same miss through four prompt levers (answer-first
law, fixture re-cut, positional first-sentence law, frame removal): the
model runs simulate_macro on the as-written text, receives the tool's
ERROR findings, stages a fix, re-simulates CLEAN — and the final answer
reports ONLY the post-fix world. The as-written verdict exists in the
request's own tool trace but never reaches the answer.

The guard is trace-mechanical (intent law clean — no prose parsing of
claims): a pre-write simulate_macro whose output carries ERROR findings,
a staged write to the SAME [gcode_macro ...] later in the request, and a
final answer that omits every failing value token the tool reported.
The re-prompt quotes the tool's own first ERROR line back.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import api.ai_routes as ai_routes  # noqa: E402


SIM_FAIL_OUTPUT = """# simulate_macro gcode_macro GLOW
Source: working state (printer.cfg). Body renders per scenario; line numbers are gcode-body lines.

## scenario-1
Declared: params: {}
Rendered (1 path(s)):
  L1: SET_LED LED=Chamber_LEDs RED=1.8 GREEN=1.8 BLUE=1.8
Expected effect (commanded, not observed):
  - LED 'Chamber_LEDs' set to RED=1.8 GREEN=1.8 BLUE=1.8
Findings:
  - ERROR: SET_LED BLUE=1.8 is outside the range Klipper accepts — the call errors at run time (BLUE must have maximum of 1.0). (L1)
  - ERROR: SET_LED RED=1.8 is outside the range Klipper accepts — the call errors at run time (RED must have maximum of 1.0). (L1)

---
Limits: this renders the TEMPLATE only — CALL macros are not recursed.
"""

SIM_CLEAN_OUTPUT = """# simulate_macro gcode_macro GLOW
Source: working state (printer.cfg).

## scenario-1
Declared: params: {}
Rendered (1 path(s)):
  L1: SET_LED LED=Chamber_LEDs RED=1.0 GREEN=1.0 BLUE=1.0
Findings:
  none

---
Limits: this renders the TEMPLATE only.
"""


def _sim(name="GLOW", output=SIM_FAIL_OUTPUT):
    return {"name": "simulate_macro",
            "arguments": '{"macro": "%s"}' % name,
            "output": output}


def _edit(section="[gcode_macro GLOW]"):
    return {"name": "config_edit",
            "arguments": '{"file": "printer.cfg", "section": "%s"}' % section,
            "output": '{"status": "applied"}'}


FAIL_ANSWER = ("Staged the fix in printer.cfg: the GLOW macro's SET_LED line now "
               "reads RED=1.0 GREEN=1.0 BLUE=1.0 (full-brightness white on the "
               "0.0-1.0 scale Klipper requires).")

VERDICT_ANSWER = ("No — as written it fails: the simulation showed "
                  "SET_LED LED=Chamber_LEDs RED=1.8 GREEN=1.8 BLUE=1.8 is "
                  "outside the 0.0-1.0 range. The staged fix moves it to 1.0.")


class TestPreWriteVerdictMiss:
    def test_silent_fix_shape_returns_nudge(self):
        events = [_sim(), _edit()]
        nudge = ai_routes._pre_write_verdict_miss(events, FAIL_ANSWER)
        assert nudge is not None
        # quotes the tool's own verdict material back
        assert "1.8" in nudge
        assert "as written" in nudge.lower()

    def test_answer_citing_failing_value_is_left_alone(self):
        events = [_sim(), _edit()]
        assert ai_routes._pre_write_verdict_miss(events, VERDICT_ANSWER) is None

    def test_changelog_mention_is_not_a_verdict(self):
        # m17guard r7/r9 shape: the failing value survives only as an
        # "instead of 1.8" changelog note — the as-written failure is
        # still never stated. Must nudge.
        changelog = ("Applied and staged for review: the SET_LED line now "
                     "uses RED=1.0 GREEN=1.0 BLUE=1.0 instead of `1.8`.  "
                     "Re-simulated on the staged version: it renders cleanly "
                     "with no findings, so calling GLOW will now work.")
        events = [_sim(), _edit()]
        assert ai_routes._pre_write_verdict_miss(events, changelog) is not None

    def test_max_value_phrasing_without_refusal_is_not_a_verdict(self):
        # m17guard r9 shape: cites the bound but not the as-written failure.
        r9ish = ("Fixed and staged. The SET_LED line now uses RED=1.0 "
                 "GREEN=1.0 BLUE=1.0 instead of 1.8 — full-brightness white, "
                 "the maximum valid values (each channel must be 0.0–1.0).")
        events = [_sim(), _edit()]
        assert ai_routes._pre_write_verdict_miss(events, r9ish) is not None

    def test_clean_pre_write_sim_never_nudges(self):
        events = [_sim(output=SIM_CLEAN_OUTPUT), _edit()]
        assert ai_routes._pre_write_verdict_miss(events, FAIL_ANSWER) is None

    def test_sim_error_after_the_write_is_not_pre_edit_truth(self):
        # write first, then simulate (the model checked only the fix):
        # nothing in the trace says the original failed.
        events = [_edit(), _sim()]
        assert ai_routes._pre_write_verdict_miss(events, FAIL_ANSWER) is None

    def test_write_to_a_different_macro_is_not_the_sim_failure(self):
        events = [_sim("GLOW"), _edit("[gcode_macro OTHER]")]
        assert ai_routes._pre_write_verdict_miss(events, FAIL_ANSWER) is None

    def test_no_write_never_nudges(self):
        events = [_sim()]
        assert ai_routes._pre_write_verdict_miss(events, "It fails: RED=1.8 is out of range.") is None
        assert ai_routes._pre_write_verdict_miss(events, "I would change it.") is None

    def test_empty_and_malformed_traces_never_crash(self):
        assert ai_routes._pre_write_verdict_miss([], FAIL_ANSWER) is None
        broken = [{"name": "simulate_macro", "arguments": "{trunca", "output": SIM_FAIL_OUTPUT},
                  {"name": "config_edit", "arguments": "{trunca", "output": ""}]
        # truncated args: section match is unavailable — must fail SAFE (no nudge)
        assert ai_routes._pre_write_verdict_miss(broken, FAIL_ANSWER) is None

    def test_macro_name_comes_from_the_output_header(self):
        # spec/snippet invocations carry no macro arg; the header names it.
        spec_sim = {"name": "simulate_macro",
                    "arguments": '{"snippet": "[gcode_macro GLOW]\\n..."}',
                    "output": SIM_FAIL_OUTPUT}
        events = [spec_sim, _edit()]
        assert ai_routes._pre_write_verdict_miss(events, FAIL_ANSWER) is not None

    def test_validate_macro_alone_is_out_of_scope(self):
        # v1 pins the guard to simulate output (rendered lines + values).
        events = [{"name": "validate_macro",
                   "arguments": '{"macro": "GLOW"}',
                   "output": "error: RED=1.8 outside range"}, _edit()]
        assert ai_routes._pre_write_verdict_miss(events, FAIL_ANSWER) is None

    def test_read_only_followup_writes_still_gate(self):
        # load_skill/read noise around the core trace changes nothing.
        events = [{"name": "load_skill", "arguments": '{"name": "macro-authoring"}', "output": "..."},
                  _sim(),
                  {"name": "read_user_config", "arguments": "{}", "output": "..."},
                  _edit()]
        assert ai_routes._pre_write_verdict_miss(events, FAIL_ANSWER) is not None


# ── Loop-level pins: the guard fires through /ai/chat and ONLY there ──

import json  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402

client = TestClient(app)

GLOW_CFG = """[neopixel Chamber_LEDs]
pin: PB1
chain_count: 30

[gcode_macro GLOW]
description: glow at a fixed level
gcode:
    SET_LED LED=Chamber_LEDs RED=1.8 GREEN=1.8 BLUE=1.8
"""


def _chat_payload(messages):
    return {
        'messages': messages,
        'apiKey': 'test-key',
        'model': 'test-model',
        'apiUrl': 'https://api.example.com/v1/chat/completions',
        'apiProvider': 'chatgpt',
        'contextFiles': {'printer.cfg': {'content': GLOW_CFG}},
        'editSkill': True,
    }


def _tool_call(name, arguments):
    block = ("```tool\n"
             + json.dumps({'name': name,
                           'arguments': {k: str(v) for k, v in arguments.items()}})
             + "\n```")
    return {'choices': [{'message': {'content': f'Sure.\n\n{block}'}}]}


def _reply(text):
    return {'choices': [{'message': {'content': text}}]}


def _install_scripted(monkeypatch, scripted):
    seen = []

    class _Resp:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    async def fake_post(url, json=None, headers=None, **kwargs):
        seen.append(json)
        return _Resp(scripted[min(len(seen) - 1, len(scripted) - 1)])

    monkeypatch.setattr(ai_routes.httpx.AsyncClient, 'post',
                        lambda self, url, **kw: fake_post(url, **kw))
    return seen


_SILENT_FIX_ANSWER = ('Staged the fix — the GLOW macro now renders '
                      'full-brightness white with no findings.')

_VERDICT_ANSWER_LIVE = ('No — as written, the bare GLOW call fails: the '
                        'simulation showed RED=1.8 is outside the 0.0-1.0 '
                        'range. The staged fix brings it to 1.0.')


def _glow_fix_call():
    return _tool_call('config_edit', {
        'file': 'printer.cfg', 'op': 'patch_section',
        'section': 'gcode_macro GLOW',
        'old_text': 'SET_LED LED=Chamber_LEDs RED=1.8 GREEN=1.8 BLUE=1.8',
        'new_text': 'SET_LED LED=Chamber_LEDs RED=1.0 GREEN=1.0 BLUE=1.0'})


class TestLoopVerdictGuard:
    def test_silent_fix_answer_gets_reprompted_once(self, monkeypatch):
        seen = _install_scripted(monkeypatch, [
            _tool_call('simulate_macro', {'macro': 'GLOW'}),
            _glow_fix_call(),
            _reply(_SILENT_FIX_ANSWER),      # guard must fire here
            _reply(_VERDICT_ANSWER_LIVE),    # compliant answer lands
        ])
        response = client.post('/ai/chat', json=_chat_payload(
            [{'role': 'user',
              'content': 'My GLOW macro sets chamber lights; will it run?'}]))
        assert response.status_code == 200
        body = response.json()
        assert body['content'] == _VERDICT_ANSWER_LIVE
        assert len(seen) == 4
        # The nudge landed as a user message quoting the tool's own finding.
        reprompt_prompt = json.dumps(seen[3])
        assert 'as-written verdict' in reprompt_prompt
        assert '1.8' in reprompt_prompt
        # The staged fix survives the re-prompt untouched.
        assert body.get('pendingEdits')

    def test_answer_quoting_the_refusal_is_never_reprompted(self, monkeypatch):
        seen = _install_scripted(monkeypatch, [
            _tool_call('simulate_macro', {'macro': 'GLOW'}),
            _glow_fix_call(),
            _reply(_VERDICT_ANSWER_LIVE),    # cites 1.8 -> no nudge
        ])
        response = client.post('/ai/chat', json=_chat_payload(
            [{'role': 'user',
              'content': 'My GLOW macro sets chamber lights; will it run?'}]))
        assert response.status_code == 200
        assert response.json()['content'] == _VERDICT_ANSWER_LIVE
        assert len(seen) == 3
