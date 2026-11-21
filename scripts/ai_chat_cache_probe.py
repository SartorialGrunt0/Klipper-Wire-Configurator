#!/usr/bin/env python3
"""C3 cache-hit/miss probe harness (plan .hermes/plans/2026-11-20_ai-chat-cache-hit-miss.md).

Drives a scripted multi-turn conversation through the running backend's
/ai/chat and reports the provider-reported prefix-cache telemetry per turn:
usage.prompt_tokens / lastCachedTokens (llama.cpp and OpenAI report
prompt_tokens_details.cached_tokens; Anthropic cache_read_input_tokens).

Why this exists: prefix-continuity of the wire payload is only a PROXY for
cache hits (see the offline LCP guard test); the ground truth for hit/miss
behavior is what the inference server itself reports. cachedShare should
CLIMB with conversation length; a step drop pinpoints the turn where
something upstream of the tail started moving.

The --ledger option replays the C1 failure mode directly: one synthetic
pending-ledger row is sent on every turn with BOTH the legacy turnOffset
and the absolute turnOrdinal. Old backends render the relative label
("previous turn" -> "2 turns ago") and mutate the merged system prefix
every turn; C1 backends render the absolute label and the ledger bytes
stop moving. Same payload to both = an honest A/B.

Laws inherited from the accuracy harness (kwc-repo-operations):
- NEVER run concurrently with an accuracy bank leg or another probe
  (shared backend log slices + one router slot, parallel=1).
- Exit codes: 0 all turns OK, 2 any turn errored.

Usage:
  backend/.venv-test/bin/python scripts/ai_chat_cache_probe.py \
      --url http://localhost:8099 --model default \
      --api-url http://192.168.1.34:8080/v1/chat/completions \
      --turns 4 --ledger [--output /tmp/cache-probe.json]
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

# Fixed synthetic questions: the transcript must be identical across A/B
# legs, so nothing here is random or time-dependent.
TURNS = [
    "In one sentence, what does [virtual_sdcard] do in Klipper?",
    "And what does max_velocity control? One sentence.",
    "Which section would I edit to change the accelerate limit? One sentence.",
    "Summarize what we discussed in one short list.",
    "One sentence: what is pressure_advance?",
    "Which pin family is used for stepper enable? One sentence.",
]

# One pending row for a section 'staged' in the FIRST turn. turnOffset is
# recomputed per send the way the pre-C1 client did it; turnOrdinal is the
# absolute creation turn (C1). Both ride so old and new backends can read
# the SAME payload (each ignores the field it doesn't know).
LEDGER_SECTION = "gcode_macro CACHE_PROBE"
LEDGER_FILE = "printer.cfg"


def chat(url: str, body: dict, timeout: int) -> dict:
    req = urllib.request.Request(
        url.rstrip("/") + "/ai/chat",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def build_body(args, messages: list, turn_index: int) -> dict:
    body = {
        "messages": list(messages),
        "apiKey": args.api_key or "cache-probe",
        "model": args.model,
        "apiUrl": args.api_url,
        "apiProvider": "openai-compatible",
    }
    if args.drafts_change:
        # S3b/C user scenario: the user edits a config between turns. The
        # blank-memory auto-fill derives machine facts from these drafts, so
        # before S3b/C the derived block sat in the system HEAD and moved its
        # bytes on every turn -> whole-prefix cache bust.
        body["contextFiles"] = {
            "printer.cfg": {
                "content": (
                    "[printer]\nkinematics: corexy\n"
                    f"[stepper_x]\nposition_max: {200 + turn_index * 10}\n"
                    f"[stepper_y]\nposition_max: {200 + turn_index * 10}\n"
                    "[stepper_z]\nposition_max: 210\n"
                ),
                "label": "printer.cfg",
            },
        }
    if args.ledger:
        # 'staged' verdict: no decision store involved, deterministic.
        # Client law offset = current - ordinal (current counts the user
        # message being sent), so the turn-1 event shows from turn 2 on.
        turn_offset = turn_index
        body["workLedger"] = [{
            "turnOffset": max(1, turn_offset),
            "turnOrdinal": 1,
            "file": LEDGER_FILE,
            "section": LEDGER_SECTION,
            "verdict": "pending",
        }]
    return body


def main() -> int:
    ap = argparse.ArgumentParser(description="C3 prefix-cache hit/miss probe for /ai/chat")
    ap.add_argument("--url", default="http://localhost:8099", help="KWC backend base URL")
    ap.add_argument("--api-url", required=True, help="Provider chat-completions URL")
    ap.add_argument("--model", required=True)
    ap.add_argument("--api-key", default="")
    ap.add_argument("--turns", type=int, default=4, choices=range(2, len(TURNS) + 1))
    ap.add_argument("--ledger", action="store_true",
                    help="replay a ledger-present conversation (C1 failure mode)")
    ap.add_argument("--drafts-change", action="store_true",
                    help="S3b/C: send a config draft whose contents change every "
                         "turn, as a user editing mid-conversation would")
    ap.add_argument("--timeout", type=int, default=600)
    ap.add_argument("--output", default="", help="write the full report JSON here")
    args = ap.parse_args()

    messages: list = []
    rows = []
    failed = False
    for i in range(args.turns):
        messages.append({"role": "user", "content": TURNS[i]})
        _t0 = time.monotonic()
        try:
            data = chat(args.url, build_body(args, messages, i), args.timeout)
        except (urllib.error.URLError, urllib.error.HTTPError) as exc:
            rows.append({"turn": i + 1, "error": str(exc)[:300]})
            failed = True
            break
        except Exception as exc:  # noqa: BLE001 — probe reports, never debugs live
            rows.append({"turn": i + 1, "error": f"{type(exc).__name__}: {str(exc)[:300]}"})
            failed = True
            break
        if data.get("error"):
            rows.append({"turn": i + 1, "error": str(data["error"])[:300]})
            failed = True
            break
        usage = data.get("usage") or {}
        prompt = usage.get("lastPromptTokens")
        cached = usage.get("lastCachedTokens")
        share = (cached / prompt) if isinstance(prompt, int) and prompt > 0 and isinstance(cached, int) else None
        rows.append({
            "turn": i + 1,
            "promptTokens": prompt,
            "cachedTokens": cached,
            "cachedShare": round(share, 4) if share is not None else None,
            # user-facing latency: whole round trip for this turn (includes
            # generation — prefill is the part the cache removes)
            "elapsedMs": round((time.monotonic() - _t0) * 1000),
        })
        messages.append({"role": "assistant", "content": data.get("content") or ""})

    warm = [r for r in rows[1:] if r.get("cachedShare") is not None]
    summary = {
        "turns": len(rows),
        "ledger": args.ledger,
        "model": args.model,
        "warmTurns": len(warm),
        # Mean cached share over turns 2..N: the single number the plan's
        # acceptance gate reads (turn 1 is cold by definition).
        "meanWarmCachedShare": (round(sum(r["cachedShare"] for r in warm) / len(warm), 4)
                                if warm else None),
        "meanWarmElapsedMs": (round(sum(r["elapsedMs"] for r in warm if r.get("elapsedMs")) /
                                    len([r for r in warm if r.get("elapsedMs")]))
                              if any(r.get("elapsedMs") for r in warm) else None),
        "failed": failed,
    }
    print(f"{'turn':>4} {'prompt':>8} {'cached':>8} {'share':>7}")
    for r in rows:
        if "error" in r:
            print(f"{r['turn']:>4} {'ERROR: ' + r['error']}")
        else:
            share = f"{r['cachedShare']:.3f}" if r["cachedShare"] is not None else "  n/a"
            ms = f"{r.get('elapsedMs')}ms" if r.get("elapsedMs") else "n/a"
            print(f"{r['turn']:>4} {r['promptTokens']!s:>8} {r['cachedTokens']!s:>8} {share:>7} {ms:>9}")
    print(json.dumps(summary, indent=2))
    if args.output:
        with open(args.output, "w") as fh:
            json.dump({"summary": summary, "rows": rows}, fh, indent=2)
        print(f"report written: {args.output}")
    return 2 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
