#!/usr/bin/env python3
"""Compare an AI-chat accuracy run against a prior run, on the OVERLAPPING qid set.

Usage: python3 scripts/bank_compare.py <new_run.log> <old_run.log> [--label NAME]
Parses the harness per-question result lines: "  QID STATUS  tools=[...] tok=N  desc"
"""
import re
import sys

LINE = re.compile(r"^\s{2}(\S+)\s+(PASS|FAIL|ERROR|CONDITIONAL)\b")
SUMMARY = re.compile(r"^SUMMARY — (\d+)/(\d+) passed")


def parse(path):
    per, summary = {}, None
    with open(path, errors="replace") as fh:
        for line in fh:
            m = SUMMARY.match(line)
            if m:
                summary = (int(m.group(1)), int(m.group(2)))
                continue
            m = LINE.match(line)
            if m and m.group(1) not in per:
                per[m.group(1)] = m.group(2)
    return per, summary


def family(qid):
    return re.sub(r"-?N?\d+$", "", qid) or qid


def main():
    new_path, old_path = sys.argv[1], sys.argv[2]
    label = sys.argv[4] if len(sys.argv) > 4 and sys.argv[3] == "--label" else ""
    new, new_sum = parse(new_path)
    old, old_sum = parse(old_path)
    if not new_sum or not old_sum:
        print(f"!! missing SUMMARY (new={new_sum} old={old_sum})")
        return

    print(f"### {label}")
    print(f"new: {new_sum[0]}/{new_sum[1]}   old: {old_sum[0]}/{old_sum[1]}")

    common = [q for q in old if q in new]
    ok_common = sum(1 for q in common if new[q] == "PASS")
    ok_old_common = sum(1 for q in common if old[q] == "PASS")
    print(f"overlap ({len(common)} qids): new {ok_common}/{len(common)}  vs  old {ok_old_common}/{len(common)}")

    added = [q for q in new if q not in old]
    if added:
        ok_add = sum(1 for q in added if new[q] == "PASS")
        print(f"added qids ({len(added)}): {ok_add}/{len(added)}  -> {sorted(added)}")

    fixed = [q for q in common if old[q] != "PASS" and new[q] == "PASS"]
    broke = [q for q in common if old[q] == "PASS" and new[q] != "PASS"]
    print(f"fixed ({len(fixed)}): {sorted(fixed)}")
    print(f"regressed ({len(broke)}): {sorted(broke)}")

    fams = {}
    for q in new:
        f = family(q)
        fams.setdefault(f, [0, 0, 0, 0])  # new_ok, new_tot, old_ok, old_tot
        fams[f][1] += 1
        if new[q] == "PASS":
            fams[f][0] += 1
        if q in old:
            fams[f][3] += 1
            if old[q] == "PASS":
                fams[f][2] += 1
    print("family: new | old(overlap)")
    for f in sorted(fams):
        n_ok, n_tot, o_ok, o_tot = fams[f]
        print(f"  {f}: {n_ok}/{n_tot} | {o_ok}/{o_tot}")
    print()


if __name__ == "__main__":
    main()
