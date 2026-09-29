#!/usr/bin/env python3
"""Offline criteria validator — re-score captured runs against the CURRENT bank.

The harness needs a live backend; this replays the *captured* payloads
(response / tool_calls / pending_edits) through the harness's own
`criterion_ok` so a criteria edit can be validated before any live run.

Usage:
    python3 scripts/validate_criteria_offline.py                 # all known runs
    python3 scripts/validate_criteria_offline.py <dir> [<dir>...]

Prints, per qid, any answer_ok verdict that differs from the recorded one,
then a negative-control battery for the changed criteria.
"""
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

_spec = importlib.util.spec_from_file_location(
    "ai_chat_accuracy_test", ROOT / "scripts" / "ai_chat_accuracy_test.py")
H = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = H
_spec.loader.exec_module(H)

REPORTS = ROOT / "reports" / "ai-chat-accuracy"
DEFAULT_RUNS = [
    "bank106-r1-cachypc-gemma-4-12b",
    "bank106-r1-cachypc-qwen3.5-4b",
    "bank106-r1-cachypc-gemma-4-e4b",
    "bank106-r1-cachypc-qwen3.5-9b",
    "bank106-r1-thor-qwen3.6-35b-a3b",
    "bank106-r1-thor-qwen3.8-27b",
    "bank106-r1-thor-gemma-4-26b-a4b",
]


def bank() -> dict:
    qs = (H.build_questions() + H.build_macro_questions()
          + H.build_trident_questions() + H.build_ambiguity_questions()
          + H.build_setup_questions() + H.build_live_context_questions()
          + H.build_edit_tool_questions() + H.build_rename_questions()
          + H.build_comment_questions() + H.build_skill_gate_questions()
          + H.build_tool_coverage_questions() + H.build_ack_guard_questions())
    return {q.qid: q for q in qs}


def rescore(q, result) -> tuple[bool, list]:
    memory = H.extract_printer_memory(result.get("response") or "")
    checks = []
    for kind, value in (q.edit_criteria or q.criteria):
        ok = H.criterion_ok(kind, value, result.get("response") or "",
                            memory=memory,
                            tool_calls=result.get("tool_calls") or [],
                            pending_edits=result.get("pending_edits") or [])
        checks.append((kind, value, ok))
    return all(c[2] for c in checks), checks


def run(runs: list[str]) -> int:
    qmap = bank()
    changes = 0
    unknown = set()
    for name in runs:
        hits = sorted(glob_json(name))
        if not hits:
            print(f"!! no run json for {name}")
            continue
        data = json.load(open(hits[-1]))["results"]
        for r in data:
            q = qmap.get(r["qid"])
            if q is None:
                unknown.add(r["qid"])
                continue
            new_ok, new_checks = rescore(q, r)
            old_ok = r["answer_ok"]
            if new_ok != old_ok:
                changes += 1
                print(f"{name}  {r['qid']:12s} answer_ok {old_ok} -> {new_ok}")
                for kind, value, ok in new_checks:
                    mark = "PASS" if ok else "FAIL"
                    print(f"      [{mark}] {kind} :: {value[:88]}")
    if unknown:
        print("qids in runs but not in the bank:", sorted(unknown))
    print(f"\n{changes} verdict change(s) across {len(runs)} run(s).")
    return changes


def glob_json(name: str):
    return (REPORTS / name).glob("ai_chat_accuracy_*.json")


# ── Negative controls: payloads that MUST still fail after a widening ──
NEGATIVE_CONTROLS = [
    # (label, question qid, payload)
    ("AMBI-07: nothing staged at all", "AMBI-07",
     {"response": "Pressure advance compensates for the elasticity of the filament. "
                  "Input shaper reduces ringing. I have not changed any files.",
      "pending_edits": [], "tool_calls": []}),
    ("AMBI-07: input_shaper staged, no pressure_advance", "AMBI-07",
     {"response": "Both explained.", "pending_edits": [
         {"file": "printer.cfg", "op": "add_section",
          "summary": "added [input_shaper]", "newText": "[input_shaper]\nshaper_type_x: mzv\n"}],
      "tool_calls": []}),
    ("MACRO-01: no move command at all", "MACRO-01",
     {"response": "```cfg\n[gcode_macro PARK_HEAD]\ndescription: parks\n"
                  "gcode:\n    M106 S0\n```",
      "pending_edits": [], "tool_calls": []}),
    ("MACRO-01: G1 present but never reaches X0", "MACRO-01",
     {"response": "```cfg\n[gcode_macro PARK_HEAD]\ndescription: parks\n"
                  "gcode:\n    G1 Z10 F600\n    M106 S0\n```",
      "pending_edits": [], "tool_calls": []}),
    ("MACRO-01: no fence, no move (prose only)", "MACRO-01",
     {"response": "Just call G28 and you are done.", "pending_edits": [],
      "tool_calls": []}),
    ("AMBI-07: value only in prose, nothing staged", "AMBI-07",
     {"response": "Add pressure_advance: 0.05 in [extruder] and an [input_shaper] "
                  "section. Pressure advance and input shaper explained.",
      "pending_edits": [], "tool_calls": []}),
    ("Q19: answers without asking anything", "Q19",
     {"response": "Sure! Here is a complete printer.cfg for a Voron 2.4 with an "
                  "Octopus board. Save it as printer.cfg.",
      "pending_edits": [], "tool_calls": []}),
    ("COMMENT-03: max_z_velocity left active", "COMMENT-03",
     {"response": "Done.", "pending_edits": [
         {"file": "printer.cfg", "op": "patch_section",
          "summary": "patched [printer]",
          "newText": "[printer]\nmax_z_velocity: 15\nmax_accel: 15500\n"}],
      "tool_calls": []}),
]


def controls() -> int:
    qmap = bank()
    print("=" * 74)
    print("NEGATIVE CONTROLS (each MUST fail)")
    bad = 0
    for label, qid, payload in NEGATIVE_CONTROLS:
        q = qmap.get(qid)
        if q is None:
            print(f"  ?? {label}: qid {qid} not in bank")
            continue
        ok, _ = rescore(q, payload)
        flag = "BAD — should have failed" if ok else "ok"
        if ok:
            bad += 1
        print(f"  [{flag}] {label}")
    print(f"  -> {bad} control(s) wrongly passing")
    return bad


if __name__ == "__main__":
    args = sys.argv[1:]
    n = run(args or DEFAULT_RUNS)
    b = controls()
    sys.exit(0)
