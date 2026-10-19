"""Fresh-context completion judge (dev A/B arm; plan 2026-10-18 Phase 2 slice).

An independent auditor model grades a confident prose close against the
USER's request and the request's own trace ledger, in a FRESH context:
the worker transcript is deliberately absent — the worker's prose is the
persuasion channel the echo kickback is weak against ("reply to a
question never asked" comes from the worker re-answering in its own
frame). This module is pure logic: payload/verdict contracts,
fail-open parsing, ledger fingerprinting, directive text. The loop
wiring lives in ai_routes.py behind ``completionGuard='judge'`` (the
echo kickback remains the shipped default — Sir's dev-coexistence
call: both arms live until the bank says which wins).

Fail-open law (anti loop-extension): a judge answer we cannot parse, or
a ``continue`` whose unmet obligation cannot be QUOTED VERBATIM from the
user's request, grades ``done``. The judge may only point at text the
user actually wrote — an obligation nobody stated is not established.
"""

from __future__ import annotations

import hashlib
import json as _json
import os as _os

COMPLETION_GUARD_DEFAULT = "kickback"
COMPLETION_GUARD_CHOICES = ("kickback", "judge")
# Judge verdict budget (plan 2.3): at most 2 grades per request. The
# third close is delivered regardless, with unresolved quotes flagged.
COMPLETION_VERDICT_LIMIT = 2

JUDGE_SYSTEM = (
    "You are a completion auditor for a Klipper config editor. You are "
    "NOT the assistant that made the edits and you have no conversation "
    "history: judge ONLY the facts given. Given the user's request and "
    "the editor's staged-change ledger, decide whether the request is "
    "entirely resolved. Return JSON only, no prose:\n"
    '{"verdict": "done|continue|needs_user",\n'
    ' "remaining": [{"quote": "...", "why": "..."}],\n'
    ' "question": "..."}\n'
    "Rules:\n"
    "- A `continue` verdict MUST include `remaining` items, each with a "
    "`quote`: verbatim text copied from the USER'S REQUEST naming the "
    "unmet obligation. If you cannot quote it, the obligation is not "
    'established -> verdict `done`.\n'
    "- If the request itself is ambiguous about what remains, verdict "
    "`needs_user` with a short `question`.\n"
    "- The ledger lists staged ops and failed calls. Staged ops matching "
    "the request's asks count as evidence of completion; do not invent "
    "extra work the user did not ask for."
)


def completion_guard_mode() -> str:
    """'kickback' (default — shipped echo behavior) or 'judge'."""
    raw = _os.environ.get("KWC_COMPLETION_GUARD", "").strip().lower()
    if raw in COMPLETION_GUARD_CHOICES:
        return raw
    return COMPLETION_GUARD_DEFAULT


def _extract_json(text: str) -> dict | None:
    """First JSON object in `text`, tolerating ``` fences and chatter."""
    if not text:
        return None
    body = text.strip()
    if body.startswith("```"):
        body = body.strip("`")
        if body.lower().startswith("json"):
            body = body[4:]
    start = body.find("{")
    end = body.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        data = _json.loads(body[start:end + 1])
    except (ValueError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def _quote_established(quote: str, user_request: str) -> bool:
    """Whitespace/case-insensitive verbatim presence in the user's text.
    Whitespace-flexible: model line-wrapping is not invention; adding or
    changing WORDS is."""
    q = " ".join(str(quote).split()).casefold()
    if not q:
        return False
    goal = " ".join(str(user_request).split()).casefold()
    return q in goal


def parse_verdict(raw: str, user_request: str) -> dict:
    """Validate a judge reply against the schema; FAIL-OPEN to done.

    - unparseable / unknown verdict / empty -> done
    - continue with no remaining item carrying a verbatim-established
      quote -> done (anti loop-extension: no quote, no obligation)
    - needs_user without a question -> done
    """
    data = _extract_json(raw)
    if not data:
        return {"verdict": "done"}
    verdict = str(data.get("verdict", "")).strip().lower()
    if verdict == "needs_user":
        q = str(data.get("question", "")).strip()
        if q:
            return {"verdict": "needs_user", "question": q}
        return {"verdict": "done"}
    if verdict == "continue":
        items = data.get("remaining")
        if not isinstance(items, list):
            return {"verdict": "done"}
        established = []
        for it in items:
            if not isinstance(it, dict):
                continue
            quote = str(it.get("quote", "")).strip()
            if quote and _quote_established(quote, user_request):
                established.append({"quote": quote,
                                    "why": str(it.get("why", "")).strip()})
        if established:
            return {"verdict": "continue", "remaining": established}
        return {"verdict": "done"}
    return {"verdict": "done"}


def ledger_fingerprint(edit_session) -> str:
    """Stable hash of what the ledger currently attests: staged (live)
    records + failed-call count. Identical fingerprint across a continue
    verdict means the worker changed nothing -> re-grading the same
    snapshot is pure latency (deliver + flag instead)."""
    records = [r for r in getattr(edit_session, "edit_records", [])
               if not r.get("superseded")]
    parts = [f"{r.get('file', '')}|{r.get('section', '')}|"
             f"{r.get('key', '')}|{r.get('op', '')}|"
             # Value matter: a re-edit of the SAME key with a NEW value
             # is progress. diffText rides whenever present (it is, for
             # every real op; test-built sessions may omit it).
             f"|{r.get('diffText') or r.get('summary') or ''}"
             for r in records]
    parts.append(f"failures={int(getattr(edit_session, 'write_failures', 0) or 0)}")
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()[:16]


def judge_user_payload(user_request: str, edit_session) -> str:
    """The judge's ONLY input beyond the system rules: request + ledger.

    Facts come from ledger_facts_line — the same builder the kickback
    uses, so both arms see identical staged/failed facts. Worker prose
    never enters this payload (the persuasion channel is cut).
    """
    from services.ai_edit_tools import ledger_facts_line
    return (f"USER REQUEST:\n{user_request}\n\n"
            f"EDITOR LEDGER (server-staged facts, not the worker's "
            f"claims):\n{ledger_facts_line(edit_session)}\n\n"
            "Judge now. JSON only.")


def continue_directive_text(remaining: list[dict]) -> str:
    """SYSTEM-role directive injected into the WORKER loop after a
    `continue` verdict — quotes only, no judge voice, no user role (the
    user said nothing new; impersonating them is the echo's original sin)."""
    items = "; ".join(f'"{it["quote"]}" ({it["why"]})' if it.get("why")
                      else f'"{it["quote"]}"' for it in remaining)
    return ("COMPLETION AUDIT — an independent review of the staged "
            "ledger against the user's request found these requested "
            f"items not yet staged: {items}. Continue with the edit "
            "tools NOW and stage them, or state concretely why each is "
            "not applicable. Do not just re-answer 'done'.")


def flag_footer_text(remaining: list[dict]) -> str:
    """User-visible footer when the verdict budget is spent with items
    still open: advisory wording, never a validator-error tone (the
    edits are staged and user-gated anyway)."""
    items = "; ".join(f'"{it["quote"]}"' for it in remaining)
    return ("\n\n---\n*Completion check flagged as possibly unresolved: "
            f"{items}. Review the staged changes above.*")
