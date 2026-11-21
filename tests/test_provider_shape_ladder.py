"""C2 — provider wire-shape ladder (volatile tail, template-compat fallback).

Pins the laws from the cache-hit plan (2026-11-20) plus the shape probe of
2026-11-21 (router .34:8080): qwen/Qwen3.8-flash-next's chat template
raises 'System message must be at the beginning' (HTTP 500, pre-generation)
on a trailing system message, while gemma and gpt-oss accept it and every
slot accepts a trailing USER message.

Laws:
- Volatile per-turn blocks (work ledger, W3 observation) ride the END of
  the payload so the stable head + replayed transcript stay a byte-prefix
  for the provider's prefix cache; the merge-into-messages[0] path is what
  put them ahead of the transcript and busted ~11K tokens on first
  appearance.
- The strict-template answer is a LADDER, not a flag: tail_system ->
  tail_user -> merged. A template rejection retries the next rung
  transparently (user never sees the failure) and the working shape is
  remembered per (url, model) so a strict provider pays the rejection
  once per process, not once per turn.
- Retry ONLY on template/role-rejection signatures. A 401/429/503/timeout
  is never reshaped and never retried here.
- Anthropic keeps its separate top-level system field (unchanged).
"""
import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from api import ai_routes  # noqa: E402


def sample_messages():
    """The shape _prepare_messages returns: stable head blocks, transcript,
    then the trailing seam (task anchor / refs / skill body / ledger / trace)."""
    return [
        {"role": "system", "content": "MAIN PROMPT"},
        {"role": "system", "content": "CONFIG CONTEXT"},
        {"role": "user", "content": "first question"},
        {"role": "assistant", "content": "first answer"},
        {"role": "user", "content": "second question"},
        {"role": "system", "content": "TASK ANCHOR"},
        {"role": "system", "content": "WORK LEDGER: turn 1 [led] pending"},
    ]


def tail_of(payload):
    return [m for m in payload["messages"]
            if m["role"] == "system" and m["content"] in ("TASK ANCHOR",
                                                          "WORK LEDGER: turn 1 [led] pending")]


# ── rung 1: tail placement ──────────────────────────────────────────

def test_rung1_stable_head_merged_blocks_trailing_blocks_stay_at_end():
    payload = ai_routes._build_provider_payload(
        "openai", sample_messages(), "test-model", merge_system=False)
    roles = [m["role"] for m in payload["messages"]]
    assert roles == ["system", "user", "assistant", "user", "system", "system"]
    # The two stable leading blocks are ONE message (multi-leading-system
    # is the other strict-template failure class).
    assert payload["messages"][0]["content"] == "MAIN PROMPT\n\nCONFIG CONTEXT"
    # The tail keeps its own bytes and its ORDER (law: append-only).
    assert [m["content"] for m in tail_of(payload)] == ["TASK ANCHOR",
                                                       "WORK LEDGER: turn 1 [led] pending"]


def test_rung1_prefix_is_byte_stable_across_first_ledger_appearance():
    """THE property C1 could not deliver: the ledger's FIRST-APPEARANCE
    turn must still be a byte-extension of the previous turn's payload."""
    without = ai_routes._build_provider_payload(
        "openai", sample_messages()[:-1], "test-model", merge_system=False)
    with_ledger = ai_routes._build_provider_payload(
        "openai", sample_messages(), "test-model", merge_system=False)
    prev = [str(m) for m in without["messages"]]
    curr = [str(m) for m in with_ledger["messages"]]
    assert curr[:len(prev) - 1] == prev[:len(prev) - 1]
    # Everything before the tail is identical bytes.
    def stable(msgs):
        kept = []
        for m in msgs:
            if m["role"] == "system" and m["content"] in ("TASK ANCHOR",
                                                          "WORK LEDGER: turn 1 [led] pending"):
                break
            kept.append(str(m))
        return kept
    assert stable(with_ledger["messages"]) == stable(without["messages"])


# ── rungs 2 and 3: the downgrade is a pure function of the sent payload ──

def test_downgrade_tail_user_labels_and_recasts_the_tail():
    payload = ai_routes._build_provider_payload(
        "openai", sample_messages(), "test-model", merge_system=False)
    down = ai_routes._reshape_for_template_fallback(payload, "tail_user")
    assert [m["role"] for m in down["messages"]] == [
        "system", "user", "assistant", "user", "user"]
    tail = down["messages"][-1]["content"]
    assert "TASK ANCHOR" in tail and "WORK LEDGER" in tail
    # The human's own message is untouched — the harness block is separate.
    assert down["messages"][3]["content"] == "second question"
    # And the block announces itself: the model must not read it as human prose.
    assert tail.lstrip().startswith(ai_routes.VOLATILE_TAIL_LABEL)


def test_directive_appended_after_the_seam_stays_last_in_every_tail_rung():
    """Route-loop re-prompt directives (ack-guard / edit nudge / steer) are
    appended AFTER the prepared seam. They are the thing the model must act
    on now, so they stay the last message on the wire; reshaping the seam
    must never slide in behind them (the tail is relocated only by the head
    hoist, which is the pre-C2 wire)."""
    msgs = sample_messages() + [
        {"role": "user", "content": "Execute the edit now with the edit tool."}]
    payload = ai_routes._build_provider_payload("openai", msgs, "m",
                                                merge_system=False)
    assert payload["messages"][-1]["content"].startswith("Execute the edit")
    for shape in ("tail_system", "tail_user"):
        shaped = ai_routes._reshape_for_template_fallback(payload, shape)
        assert shaped["messages"][-1]["content"].startswith("Execute the edit"), shape
        seam = [i for i, m in enumerate(shaped["messages"])
                if i and ("TASK ANCHOR" in str(m.get("content", ""))
                          or "WORK LEDGER" in str(m.get("content", ""))
                          or str(m.get("content", "")).startswith(
                              ai_routes.VOLATILE_TAIL_LABEL))]
        assert seam, shape
        assert seam[0] < len(shaped["messages"]) - 1, shape


def test_downgrade_merged_is_the_legacy_head_hoist():
    payload = ai_routes._build_provider_payload(
        "openai", sample_messages(), "test-model", merge_system=False)
    down = ai_routes._reshape_for_template_fallback(payload, "merged")
    roles = [m["role"] for m in down["messages"]]
    assert roles == ["system", "user", "assistant", "user"]
    assert "WORK LEDGER" in down["messages"][0]["content"]


def test_downgrade_of_a_payload_without_a_tail_is_a_noop():
    payload = ai_routes._build_provider_payload(
        "openai", sample_messages()[:4], "test-model", merge_system=False)
    assert ai_routes._reshape_for_template_fallback(payload, "tail_user") is payload
    assert ai_routes._reshape_for_template_fallback(payload, "merged") is payload


def test_reshape_preserves_every_other_payload_field():
    payload = ai_routes._build_provider_payload(
        "openai", sample_messages(), "test-model", tools=[{"function": {"name": "x"}}],
        temperature=0.3, merge_system=False)
    down = ai_routes._reshape_for_template_fallback(payload, "tail_user")
    assert down["model"] == payload["model"]
    assert down["temperature"] == 0.3
    assert down["tools"] == payload["tools"]


def test_anthropic_payload_is_never_reshaped():
    payload = ai_routes._build_provider_payload(
        "anthropic", sample_messages(), "test-model")
    assert ai_routes._reshape_for_template_fallback(payload, "tail_user") is payload


# ── rejection detection: narrow on purpose ──────────────────────────

@pytest.mark.parametrize("body", [
    "Jinja Exception: System message must be at the beginning",
    "While executing CallExpression at line 110 ... raise_exception('System message must be at the beginning')",
    "400 Bad Request: system role must be the first message",
    "template error: unexpected role 'system' in messages[6]",
])
def test_template_rejection_recognised(body):
    assert ai_routes._looks_like_template_rejection(500, body)


@pytest.mark.parametrize("status,body", [
    (401, "invalid api key"),
    (429, "rate limit exceeded"),
    (503, "server busy"),
    (500, "CUDA out of memory"),
    (500, ""),
])
def test_unrelated_errors_are_not_template_rejections(status, body):
    assert not ai_routes._looks_like_template_rejection(status, body)


# ── the ladder itself ───────────────────────────────────────────────

class FakeResponse:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise self._http_error()

    def _http_error(self):
        import httpx
        request = httpx.Request("POST", "http://x/v1/chat/completions")
        response = httpx.Response(self.status_code, request=request,
                                  json=self._body)
        return httpx.HTTPStatusError("boom", request=request, response=response)

    def json(self):
        if self.status_code >= 400:
            # httpx raises on a non-2xx .json() only via raise_for_status;
            # the ladder reads the body directly, which is what this models.
            return self._body
        return self._body


class FakeClient:
    """Records each payload it is handed; fails per a scripted rule."""

    def __init__(self, fail_for):
        self.calls = []
        self._fail_for = fail_for

    async def post(self, url, headers=None, json=None):
        self.calls.append(json)
        roles = "".join("u" if m["role"] == "user" else m["role"][0]
                        for m in json["messages"])
        if self._fail_for(json):
            return FakeResponse(500, {"error": {"message":
                                                "Jinja Exception: System message must be "
                                                "at the beginning"}})
        return FakeResponse(200, {"choices": [{"message": {"content": "ok",
                                                            "tool_calls": None}}]})


OK = {"choices": [{"message": {"content": "ok"}}]}


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def shape_memory_isolated(monkeypatch):
    """In-memory only: a unit run must not write backend/data/ai/."""
    ai_routes._provider_shape_memory.clear()
    monkeypatch.setattr(ai_routes, "_shape_memory_loaded", True)
    monkeypatch.setattr(ai_routes, "_load_ai_json", lambda path: {})
    monkeypatch.setattr(ai_routes, "_save_ai_json", lambda path, payload: None)
    yield
    ai_routes._provider_shape_memory.clear()


def payload_for(shape):
    return ai_routes._build_provider_payload(
        "openai", sample_messages(), "m", merge_system=(shape == "merged"))


def test_ladder_walks_down_and_remembers():
    # Reject anything with a trailing system message.
    def fail_for(p):
        return any(m["role"] == "system" for m in p["messages"][1:])

    client = FakeClient(fail_for)
    content, _ = run(ai_routes._query_provider(
        client, "http://x/v1/chat/completions", {}, payload_for("tail_system"),
        "openai", logger_context="test"))
    assert content == "ok"
    # rung 1 rejected, rung 2 accepted: two posts, the second tail-user.
    assert len(client.calls) == 2
    assert client.calls[-1]["messages"][-1]["role"] == "user"
    assert ai_routes._provider_shape_memory[("http://x/v1/chat/completions", "m")] == "tail_user"


def test_optimistic_success_is_not_written_to_disk_but_a_downgrade_is(monkeypatch):
    """Only rejection-earned evidence persists: an optimistic first-try
    success stays process-local, otherwise unit traffic poisons the
    production shape file (which is exactly what it did once)."""
    writes: list = []
    monkeypatch.setattr(ai_routes, "_save_ai_json",
                        lambda path, payload: writes.append(dict(payload)))

    run(ai_routes._query_provider(
        FakeClient(lambda p: False), "http://x/v1/chat/completions", {},
        payload_for("tail_system"), "openai", logger_context="happy-path"))
    assert writes == []
    assert ai_routes._provider_shape_memory[("http://x/v1/chat/completions", "m")] == "tail_system"

    run(ai_routes._query_provider(
        FakeClient(lambda p: any(m["role"] == "system" for m in p["messages"][1:])),
        "http://y/v1/chat/completions", {},
        payload_for("tail_system"), "openai", logger_context="strict-path"))
    assert len(writes) == 1
    assert writes[0]["\x00".join(("http://y/v1/chat/completions", "m"))] == "tail_user"


def test_remembered_shape_skips_the_rejected_rung():
    def fail_for(p):
        return any(m["role"] == "system" for m in p["messages"][1:])

    client = FakeClient(fail_for)
    run(ai_routes._query_provider(
        client, "http://x/v1/chat/completions", {}, payload_for("tail_system"),
        "openai", logger_context="first"))
    first_count = len(client.calls)
    client2 = FakeClient(fail_for)
    run(ai_routes._query_provider(
        client2, "http://x/v1/chat/completions", {}, payload_for("tail_system"),
        "openai", logger_context="second"))
    # Second request goes straight out in the learned shape: one post, no 500.
    assert len(client2.calls) == 1
    assert client2.calls[0]["messages"][-1]["role"] == "user"
    assert first_count == 2


def test_non_template_error_propagates_without_retry():
    client = FakeClient(lambda p: False)

    class Boom(FakeClient):
        async def post(self, url, headers=None, json=None):
            self.calls.append(json)
            return FakeResponse(401, {"error": {"message": "invalid api key"}})

    boom = Boom(lambda p: False)
    with pytest.raises(Exception):
        run(ai_routes._query_provider(
            boom, "http://x/v1/chat/completions", {}, payload_for("tail_system"),
            "openai", logger_context="test"))
    assert len(boom.calls) == 1
    assert ai_routes._provider_shape_memory == {}


def test_exhausted_ladder_reports_the_last_error():
    client = FakeClient(lambda p: True)
    with pytest.raises(Exception):
        run(ai_routes._query_provider(
            client, "http://x/v1/chat/completions", {}, payload_for("tail_system"),
            "openai", logger_context="test"))
    # tail_system -> tail_user -> merged, then give up (no infinite retry).
    assert len(client.calls) == 3
