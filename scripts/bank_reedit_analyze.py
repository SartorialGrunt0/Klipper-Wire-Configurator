#!/usr/bin/env python3
"""Post-run analyzer: did the model RE-EDIT sections it already edited?

Reads one or more accuracy-run report dirs (the *.json inside) and, per
question, replays the config_edit/config_write tool_calls in sequence.
Each call is keyed by the (file, section-ish target) it touched and
whether the server reported ops applied ("applied N of M ops").

Definitions:
  re-touch        — a call touching a (file, section) a PREVIOUS call already
                    touched. Classified:
    retry-after-fail  — previous touch of that key applied 0 ops (recovery,
                        expected, NOT waste)
    re-edit           — previous touch applied >0 ops (the model changed
                        something it had already successfully changed)
  re-edit same op-kind / re-edit diff op-kind are split out so a rename
  followed by a patch of the renamed section reads differently from
  patching the same section twice.

Also reports per-arm: pass/fail/err, answer accuracy, judge stats
(usage.completionJudge + per-result completion_judge), edit-call totals.

Usage: bank_reedit_analyze.py <report-dir> [<report-dir> ...]
"""
import glob
import json
import os
import re
import sys

_APPLIED_RE = re.compile(r"applied (\d+) of (\d+) ops", re.I)
_OP_RE = re.compile(r'"op"\s*:\s*"(\w+)"')
_SEC_RE = re.compile(r'"section"\s*:\s*"([^"]+)"')
_FILE_RE = re.compile(r'"file"\s*:\s*"([^"]+)"')

_EDIT_TOOLS = {"config_edit", "config_write"}


def _norm_sec(s):
    """Normalize a section target for key-matching."""
    if not s:
        return ""
    s = s.strip().strip("[]").strip()
    s = re.sub(r"^(gcode_macro|force_move)\s+", "", s)
    return s.lower()


def _ops_from_args(args_str):
    """Return list of (op_kind, section_key, file) from a config_edit
    arguments string. Tolerates unparseable/stringified payloads."""
    try:
        a = json.loads(args_str)
    except (json.JSONDecodeError, TypeError):
        kinds = _OP_RE.findall(args_str or "")
        secs = _SEC_RE.findall(args_str or "")
        files = _FILE_RE.findall(args_str or "")
        f = files[0] if files else "?"
        out = []
        for i, k in enumerate(kinds):
            s = secs[i] if i < len(secs) else ""
            out.append((k, _norm_sec(s), f))
        return out or [("?", "", f)]
    if not isinstance(a, dict):
        return [("?", "", "?")]
    f = a.get("file") or "?"
    ops = a.get("ops")
    if isinstance(ops, str):  # stringified ops envelope
        try:
            ops = json.loads(ops)
        except json.JSONDecodeError:
            return _ops_from_args(ops)
    if not isinstance(ops, list):
        ops = [a]
    out = []
    for op in ops:
        if not isinstance(op, dict):
            continue
        kind = op.get("op", "?")
        sec = (op.get("section") or op.get("old_section")
               or op.get("old_header") or op.get("header")
               or op.get("new_header") or op.get("include") or "")
        out.append((kind, _norm_sec(str(sec)), op.get("file") or f))
    return out


def analyze_run(report_dir):
    files = sorted(glob.glob(os.path.join(report_dir, "*.json")))
    if not files:
        return {"dir": report_dir, "error": "no *.json in dir"}
    d = json.load(open(files[-1]))
    results = d.get("results", [])
    summary = {
        "dir": os.path.basename(report_dir.rstrip("/")),
        "settings": {k: d.get("settings", {}).get(k) for k in
                     ("model", "temperature", "max_tokens",
                      "completion_check", "completion_guard",
                      "completion_judge_payload")},
        "total": len(results),
        "passed": sum(1 for r in results if r.get("status") == "PASS"),
        "failed": sum(1 for r in results if r.get("status") == "FAIL"),
        "errored": sum(1 for r in results if r.get("status") == "ERROR"),
        "edit_calls": 0, "applied_ops": 0, "failed_ops": 0,
        "re_touches": 0, "retry_after_fail": 0,
        "intra_call_dupes": 0,
        "re_edits": 0, "re_edits_same_kind": 0, "re_edits_diff_kind": 0,
        "questions_with_re_edit": [],
        "questions_with_retry": [],
        "judge_calls": 0, "judge_done": 0, "judge_needs_work": 0,
        "judge_flagged_q": 0,
        "fail_list": [r["qid"] for r in results if r.get("status") == "FAIL"],
        "err_list": [r["qid"] for r in results if r.get("status") == "ERROR"],
    }
    for r in results:
        # judge stats (field present only on judge arm)
        cj = r.get("completion_judge") or {}
        if cj:
            summary["judge_calls"] += cj.get("calls", 0) or 0
            for v in cj.get("verdicts", []):
                if v == "done":
                    summary["judge_done"] += 1
                else:
                    summary["judge_needs_work"] += 1
            if cj.get("flagged"):
                summary["judge_flagged_q"] += 1
        touched = {}  # key -> (call_idx, kind, applied)
        q_re_edit = []
        q_retry = []
        for idx, tc in enumerate(r.get("tool_calls", [])):
            if tc.get("name") not in _EDIT_TOOLS:
                continue
            summary["edit_calls"] += 1
            out = tc.get("output") or ""
            m = _APPLIED_RE.search(out)
            if m:
                applied, total_ops = int(m.group(1)), int(m.group(2))
            else:
                looks_ok = ("staged" in out.lower()
                            or "applied" in out.lower()
                            or "saved" in out.lower())
                applied = 1 if looks_ok else 0
                total_ops = 1
            summary["applied_ops"] += applied
            summary["failed_ops"] += max(0, total_ops - applied)
            if tc.get("name") == "config_write":
                # C-03 (round-1 review 2026-10-25): the executed tool-call
                # record carries {name, arguments, output} — the target
                # file lives INSIDE the arguments JSON, never on the
                # record. Reading tc["file"] returned None for every
                # call, collapsing all config_writes onto ('?','write-all')
                # and reporting two creates of DIFFERENT files as one
                # re-edit — the analyzer's headline metric, inflated.
                target = "?"
                try:
                    args_obj = json.loads(tc.get("arguments") or "{}")
                    target = str(args_obj.get("file") or "?")
                except (TypeError, ValueError):
                    pass
                keys = [(target, "write-all")]
                kinds = ["config_write"]
            else:
                ops = _ops_from_args(tc.get("arguments", ""))
                keys = [(f, s) for (_k, s, f) in ops]
                kinds = [k for (k, _s, _f) in ops]
            for key, kind in zip(keys, kinds):
                prev = touched.get(key)
                if prev is not None:
                    summary["re_touches"] += 1
                    p_idx, p_kind, p_applied = prev
                    if p_idx == idx:
                        # same batch call touched this key twice — sloppy
                        # op list, but NOT a re-edit across the loop
                        summary["intra_call_dupes"] += 1
                        continue
                    if p_applied == 0:
                        summary["retry_after_fail"] += 1
                        q_retry.append(f"{key}<-c{p_idx}")
                    else:
                        summary["re_edits"] += 1
                        if kind == p_kind:
                            summary["re_edits_same_kind"] += 1
                        q_re_edit.append(
                            f"{key} c{p_idx}({p_kind})->c{idx}({kind})")
                touched[key] = (idx, kind, applied)
        if q_re_edit:
            summary["questions_with_re_edit"].append(
                {"qid": r["qid"], "status": r.get("status"),
                 "re_edits": q_re_edit})
        if q_retry:
            summary["questions_with_retry"].append(
                {"qid": r["qid"], "status": r.get("status"),
                 "retries": q_retry})
    return summary


def print_summary(s):
    st = s.get("settings", {})
    print(f"\n=== {s['dir']} ===")
    if s.get("error"):
        print("  ERROR:", s["error"])
        return
    print(f"  model={st.get('model')} t={st.get('temperature')}"
          f" max_tok={st.get('max_tokens')}"
          f" guard={'off' if not st.get('completion_check') else st.get('completion_guard')}"
          f"/{st.get('completion_judge_payload')}")
    print(f"  PASS {s['passed']}  FAIL {s['failed']}  ERR {s['errored']}"
          f"  (answer {s['passed']}/{s['total']})")
    print(f"  edit calls {s['edit_calls']}  ops applied {s['applied_ops']}"
          f"  ops failed {s['failed_ops']}")
    print(f"  RE-EDITS after success: {s['re_edits']}"
          f" (same kind {s['re_edits_same_kind']})"
          f" across {len(s['questions_with_re_edit'])} questions")
    print(f"  retries after fail (expected recovery): {s['retry_after_fail']}"
          f" across {len(s['questions_with_retry'])} questions")
    print(f"  intra-call duplicate op targets: {s['intra_call_dupes']}")
    if s["judge_calls"] or s["judge_flagged_q"]:
        print(f"  judge: {s['judge_calls']} calls,"
              f" done {s['judge_done']}, needs-work {s['judge_needs_work']},"
              f" questions flagged {s['judge_flagged_q']}")
    if s["fail_list"]:
        print("  fails:", ", ".join(s["fail_list"]))
    if s["err_list"]:
        print("  errs:", ", ".join(s["err_list"]))
    for q in s["questions_with_re_edit"]:
        print(f"    {q['qid']} [{q['status']}]: " + "; ".join(q["re_edits"]))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    summaries = [analyze_run(p) for p in sys.argv[1:]]
    for s in summaries:
        print_summary(s)
    print()


if __name__ == "__main__":
    main()
