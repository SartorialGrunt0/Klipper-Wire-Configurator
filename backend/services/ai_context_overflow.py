"""W8 — graceful context-window overflow handling (pure logic).

Two compensations for "the conversation blew past the model's window",
per the approved plan (.hermes/plans/2026-11-12_205839-macro-jinja-reliability.md
§W8, research .hermes/plans/2026-11-12_context-window-harness-research.md):

1. PRE-FLIGHT — estimate the fully-assembled prompt and refuse an
   obviously-over request BEFORE spending a provider round-trip. llama.cpp
   can HANG instead of erroring on an over-long prompt (the flashnext
   failure class; there is deliberately no response timeout anywhere in the
   chat path), so the pre-flight is the only defense there.

2. MAPPING — provider context-length errors (400 bodies or 200-with-error
   bodies) become one structured, actionable error instead of the raw
   "API request failed: ..." passthrough. Never a silent timeout, never a
   raw dump.

Number sources (per the meta-law: every constant gets a citation):
- chars/4 estimate: pi coding agent's exact pre-flight trick
  (dabit3 gist, research 2026-11-12). Deliberately a cheap deterministic
  heuristic — it only ever refuses when the estimate is OVER the window,
  and chars/token is usually 3-4, so an obviously-over estimate is
  near-certainly truly over. Borderline requests go through and the
  provider decides.
- 1000 tokens/image constant: conservative upper bound for a single image
  part (OpenAI's own scheme: 85 base low-detail; high-detail 765-token
  tiles — a few tiles never reach 1000). KWC chat is text-only today; the
  list-content branch exists so a future multimodal payload is counted
  for its pixels, not its base64 length.
"""
from __future__ import annotations

import json
import math

#: Structured error code on the /ai/chat error payload. The frontend keys
#: the overflow banner on THIS, never on the message prose.
CONTEXT_OVERFLOW_ERROR_CODE = "context_overflow"

#: The one user-facing label. Actionable by construction: both actions
#: that actually fit in a window are named, no numbers demanded of the
#: user (W7 UI law). Locked by tests — update WITH them.
CONTEXT_OVERFLOW_MESSAGE = (
    "This conversation exceeds the model's context window — "
    "start a new chat or drop pinned references."
)

#: Conservative constant per image part — see module docstring for source.
_IMAGE_TOKEN_ESTIMATE = 1000

_CHARS_PER_TOKEN = 4


def _content_chars(content: object) -> int:
    """Char count of one message's content across the payload shapes.

    str = the ordinary chat text; list = multimodal parts (text parts by
    chars, image parts by the constant — never their URL/base64 length);
    None/anything else = defensive str() so a malformed row can only
    inflate the estimate, never hide from it.
    """
    if content is None:
        return 0
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        total = 0
        for part in content:
            if isinstance(part, str):
                total += len(part)
            elif isinstance(part, dict):
                ptype = str(part.get("type", ""))
                if "image" in ptype or "audio" in ptype:
                    total += _IMAGE_TOKEN_ESTIMATE * _CHARS_PER_TOKEN
                else:
                    text = part.get("text")
                    total += len(text) if isinstance(text, str) else len(str(part))
        return total
    return len(str(content))


def _tools_chars(tools: object) -> int:
    """Serialized size of the provider tools payload (PR #43 review F9).

    json.dumps with default=str never raises on ordinary tool schemas;
    the ValueError leg covers circular references, and the final str()
    fallback keeps the estimate a length, never an exception — an
    estimate failure must not become a 500 on the chat route.
    """
    try:
        return len(json.dumps(tools, default=str))
    except (TypeError, ValueError):
        return len(str(tools))


def estimate_prompt_tokens(messages: list, tools: object = None) -> int:
    """chars/4 estimate of one provider payload's prompt size (ceil).

    Ceil, never floor: underestimating is the direction that defeats a
    pre-flight. Malformed rows are str()'d defensively — same direction.
    `tools` is the native function-calling payload when one is sent:
    providers bill it against the context window, so counting only the
    messages understated an edit-armed request by ~8k tokens (PR #43
    review F9, measured 4,215 counted vs 12,392 sent).
    """
    total = 0
    for msg in messages:
        if isinstance(msg, dict):
            total += _content_chars(msg.get("content"))
    if tools:
        total += _tools_chars(tools)
    return math.ceil(total / _CHARS_PER_TOKEN)


def preflight_overflow(messages: list, context_window: object,
                       tools: object = None) -> dict | None:
    """Refuse an obviously-over request, or None to let it through.

    Only an ``int > 0`` window can block (bools are not windows — W7's
    ``_positive_int`` law). An estimate must be strictly OVER the window;
    borderline is the provider's call. The payload carries harness-visible
    telemetry (estimate + window) alongside the user-facing label.
    ``tools`` is the native tools payload sent with the same request —
    it occupies the window too and joins the estimate (F9).
    """
    if isinstance(context_window, bool) or not isinstance(context_window, int) or context_window <= 0:
        return None
    estimate = estimate_prompt_tokens(messages, tools=tools)
    if estimate > context_window:
        return {
            "error": CONTEXT_OVERFLOW_MESSAGE,
            "errorCode": CONTEXT_OVERFLOW_ERROR_CODE,
            "estimatedPromptTokens": estimate,
            "contextWindow": context_window,
        }
    return None


#: Lowercase substrings of context-length errors as the real providers
#: report them (samples pinned by tests from OpenAI/vLLM, llama.cpp,
#: Anthropic, Google). Literal matching only — intent-law clean: a wrong
#: match downgrades a raw error to a clean label; it never blocks or
#: rewrites anything else.
_OVERFLOW_MARKERS = (
    "context_length_exceeded",
    "maximum context",              # OpenAI / vLLM: "maximum context length is N tokens"
    "context size",                 # llama.cpp: "Exceeded context size (4096 vs 2048)"
    "available context",            # llama.cpp: "exceed available context, try reducing..."
    "prompt is too long",           # Anthropic
    "input token count",            # Google
    "maximum number of tokens",     # Google's tail, generic fallback
    "too many tokens",
    "context window",
    "reduce the length of the messages",
)


def is_context_overflow_error(text: object) -> bool:
    """True when a provider error text is a context-length failure.

    Reads literal substrings only. Unrelated errors (rate limit, bad key,
    502s, policy refusals) must fall through to the generic surface —
    pinned in the both-direction tests.
    """
    if not isinstance(text, str) or not text:
        return False
    lowered = text.lower()
    return any(marker in lowered for marker in _OVERFLOW_MARKERS)
