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
    "the editor's staged-change ledger (plus the current text of edited "
    "files when provided), decide whether the request is entirely "
    "resolved. Return JSON only, no prose:\n"
    '{"verdict": "done|continue|needs_user",\n'
    ' "actions": [{"text": "...", "file": "...", "quote": "...", '
    '"evidence": "..."}],\n'
    ' "question": "..."}\n'
    "Rules:\n"
    "- `continue` means work remains and MUST list `actions`. Each "
    "action `text` is ONE imperative instruction for the editor model, "
    "under 20 words, naming the exact file/section/macro/key and what to "
    "do to it, e.g. \"rename existing gcode_macro _bed_mesh_calibrate to "
    "bed_mesh_calibrate in printer.cfg\" or \"[gcode_macro PRINT_START] "
    "still references level_bed — update that reference\". No "
    "justification prose, no hedging, only the action.\n"
    "- `file` names the file the action targets when known.\n"
    "- Every action MUST carry a `quote`: verbatim text copied from the "
    "USER'S REQUEST naming the obligation. If you cannot quote it, the "
    "obligation is not established -> drop the action; if no actions "
    "remain, verdict `done`.\n"
    "- When CURRENT TEXT OF EDITED FILES is provided, `evidence` MUST be "
    "a verbatim snippet copied from that text showing the action is "
    "still needed (e.g. the line that still names the old macro). "
    "Omit `evidence` when unsure — never invent it.\n"
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


# Judge payload enrichment modes (dev A/B 2026-10-19). 'labels' = the
# shipped judge arm: request + ledger line only. 'dump' adds the two
# deterministic context blocks Sir scoped: the project section inventory
# (so "did it get ALL the steppers" is judgeable) and the CURRENT text of
# every file the request edited (post-edit server state — the facts the
# worker claims to have produced). No tools either way.
JUDGE_PAYLOAD_DEFAULT = "labels"
JUDGE_PAYLOAD_CHOICES = ("labels", "dump")
DUMP_FILE_CAP = 16000  # chars per edited file before section fallback
DUMP_TOTAL_CAP = 40000  # whole dump block, hard stop


def judge_payload_mode() -> str:
    raw = _os.environ.get("KWC_COMPLETION_JUDGE_PAYLOAD", "").strip().lower()
    if raw in JUDGE_PAYLOAD_CHOICES:
        return raw
    return JUDGE_PAYLOAD_DEFAULT


def project_inventory(edit_session) -> str:
    """`file: [section], [section], …` per project file, live staged state.

    Header-detection mirrors the engine's own ([ at col 0, not a
    comment). Files with no sections still list (top-level keys live
    under a file's first implicit section; an empty list is honest)."""
    lines_out = []
    for name in sorted(getattr(edit_session.state, "files", {})):
        text = edit_session.state.files[name]
        headers = [ln.strip() for ln in text.splitlines()
                   if ln.startswith("[") and ln.rstrip().endswith("]")]
        lines_out.append(f"{name}: " + (", ".join(headers) if headers
                                         else "(no sections)"))
    return "\n".join(lines_out)


def _file_dump(name: str, text: str, edited_sections: set) -> str:
    """Current file text, capped. Under cap: verbatim. Over cap: every
    EDITED section verbatim + the rest as section headers with line
    counts — the judge sees the changed truth plus the shape of what it
    did not get."""
    if len(text) <= DUMP_FILE_CAP:
        return text
    kept = [f"[truncated {name}: over {DUMP_FILE_CAP} chars; edited "
            f"sections verbatim, remainder as inventory]"]
    current = None
    buf = []
    remainder_headers = []
    for ln in text.splitlines():
        is_header = ln.startswith("[") and ln.rstrip().endswith("]")
        if is_header and current is not None:
            if current in edited_sections:
                kept.append("\n".join([current] + buf))
            else:
                remainder_headers.append(f"{current} ({len(buf)} lines)")
            buf = []
        if is_header:
            current = ln.rstrip()
        else:
            buf.append(ln)
    if current is not None:
        if current in edited_sections:
            kept.append("\n".join([current] + buf))
        else:
            remainder_headers.append(f"{current} ({len(buf)} lines)")
    kept.append("[other sections] " + ", ".join(remainder_headers))
    out = "\n\n".join(kept)
    return out[:DUMP_FILE_CAP]


def edited_file_dumps(edit_session) -> str:
    """CURRENT text of every file with a non-superseded staged edit.

    This is post-edit server state (EditSession.state is mutated as ops
    stage), NOT the worker's re-telling — same trust law as the ledger.
    Edited sections (from edit_records) drive the over-cap fallback."""
    records = [r for r in getattr(edit_session, "edit_records", [])
               if not r.get("superseded")]
    by_file: dict[str, set] = {}
    for r in records:
        by_file.setdefault(r.get("file", ""), set()).add(
            f"[{r.get('section', '')}]" if r.get("section") else "")
    out = []
    used = 0
    for name in sorted(by_file):
        text = getattr(edit_session.state, "files", {}).get(name)
        if text is None:
            continue
        dump = _file_dump(name, text, by_file[name])
        block = f"--- {name} ---\n{dump}"
        if used + len(block) > DUMP_TOTAL_CAP:
            out.append(f"--- {name} --- [omitted: dump total cap]")
            break
        out.append(block)
        used += len(block)
    return "\n".join(out)


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
    - continue with no action carrying a verbatim-established `quote`
      -> done (anti loop-extension: no quote, no obligation)
    - needs_user without a question -> done

    Actions normalize to {text, file, quote, evidence, why}: `text` is
    the imperative for the worker; `evidence`/`why` are log-only. A
    judge that returns the legacy `remaining` shape (quote-only items)
    is still accepted — the quote law applies identically.
    """
    data = _extract_json(raw)
    if not data:
        return {"verdict": "done"}
    verdict = str(data.get("verdict", "")).strip().lower()
    if verdict == "needs_user":
        # `or ''`: live judges emit explicit JSON nulls ("question":
        # null) — str(None) would leak the literal "None" downstream.
        q = str(data.get("question") or "").strip()
        if q:
            return {"verdict": "needs_user", "question": q}
        return {"verdict": "done"}
    if verdict == "continue":
        items = data.get("actions")
        if not isinstance(items, list):
            items = data.get("remaining")
        if not isinstance(items, list):
            return {"verdict": "done"}
        established = []
        for it in items:
            if not isinstance(it, dict):
                continue
            quote = str(it.get("quote") or "").strip()
            if not quote or not _quote_established(quote, user_request):
                continue
            text = str(it.get("text") or "").strip() or quote
            established.append({
                "text": text,
                "file": str(it.get("file") or "").strip(),
                "quote": quote,
                "evidence": str(it.get("evidence") or "").strip(),
                "why": str(it.get("why") or "").strip(),
            })
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


def judge_user_payload(user_request: str, edit_session, *,
                       mode: str | None = None) -> str:
    """The judge's ONLY input beyond the system rules: request + ledger
    (+ inventory + edited-file dumps in 'dump' mode).

    Facts come from ledger_facts_line — the same builder the kickback
    uses, so both arms see identical staged/failed facts. Worker prose
    never enters this payload (the persuasion channel is cut). In dump
    mode the judge additionally sees the project's section inventory
    (completeness is then a completable judgment) and the CURRENT
    server-side text of every touched file (what is true now, not what
    the worker claims).
    """
    from services.ai_edit_tools import ledger_facts_line
    if mode is None:
        mode = judge_payload_mode()
    out = (f"USER REQUEST:\n{user_request}\n\n"
           f"EDITOR LEDGER (server-staged facts, not the worker's "
           f"claims):\n{ledger_facts_line(edit_session)}\n")
    if mode == "dump":
        out += ("\nPROJECT INVENTORY (live sections per file):\n"
                f"{project_inventory(edit_session)}\n\n"
                "CURRENT TEXT OF EDITED FILES (server state after the "
                f"staged edits):\n{edited_file_dumps(edit_session)}\n")
    return out + "\nJudge now. JSON only."


def continue_directive_text(remaining: list[dict],
                            prior_texts: set | None = None) -> str:
    """SYSTEM-role directive injected into the WORKER loop after a
    `continue` verdict — pure imperative, no judge voice, no user role
    (the user said nothing new; impersonating them is the echo's
    original sin), and NO justification: evidence/why stay in the logs
    for forensics. The worker's only job on receiving this is to obey
    each action line.

    `prior_texts` (action texts already injected this request) are
    dropped so a repeated verdict cannot re-extend the loop with the
    same instruction; if everything repeats we still emit the header —
    an empty directive is worse than a redundant one.
    """
    items = []
    for it in remaining:
        text = str(it.get("text") or it.get("quote") or "").strip()
        if not text:
            continue
        if prior_texts is not None and text.casefold() in prior_texts:
            continue
        file = str(it.get("file") or "").strip()
        items.append(f"- {text}" + (f" [{file}]" if file else ""))
    return ("Verdict: needs work\n\n"
            "Complete these actions now. Do not continue, re-answer, or "
            "declare done without addressing each one:\n\n"
            "Actions:\n" + "\n".join(items))


def flag_footer_text(remaining: list[dict]) -> str:
    """User-visible footer when the verdict budget is spent with items
    still open: advisory wording, never a validator-error tone (the
    edits are staged and user-gated anyway). Renders the ACTION text
    (imperative, what the worker failed to do) falling back to the
    quote; dedupes — several actions can share one request-quote, and
    the old quote-only render printed the same sentence five times
    (AMBI-02, full bank 2026-10-19)."""
    items = []
    for it in remaining:
        label = (str(it.get("text") or "").strip()
                 or str(it.get("quote") or "").strip())
        if label and label not in items:
            items.append(label)
    return ("\n\n---\n*Completion check flagged as possibly unresolved: "
            + "; ".join(items) + ". Review the staged changes above.*")
