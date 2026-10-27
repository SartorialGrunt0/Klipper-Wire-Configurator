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
          + H.build_tool_coverage_questions() + H.build_ack_guard_questions()
          + H.build_bulk_questions())
    return {q.qid: q for q in qs}


def rescore(q, result) -> tuple[bool, list]:
    memory = H.extract_printer_memory(result.get("response") or "")
    checks = []
    for kind, value in (q.edit_criteria or q.criteria):
        ok = H.criterion_ok(kind, value, result.get("response") or "",
                            memory=memory,
                            tool_calls=result.get("tool_calls") or [],
                            pending_edits=result.get("pending_edits") or [],
                            # 2026-10-20: `coverage` (BULK family) and
                            # `single_request` read the trace fields, not
                            # prose. Passing them keeps replayed BULK rows
                            # honest — without change_set every coverage arm
                            # scored False and a stored PASS looked like a
                            # flip.
                            change_set=result.get("change_set") or {},
                            tool_turns=result.get("tool_turns"),
                            edit_attempts=result.get("edit_attempts"))
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
    ("RENAME-01: bogus '[level_bed1]' (dropped gcode_macro prefix)", "RENAME-01",
     {"response": "Renamed.", "pending_edits": [
         {"file": "printer.cfg", "op": "replace_section", "summary": "renamed",
          "newText": "[level_bed1]\ngcode:\n    G28\n"}],
      "tool_calls": []}),
    ("RENAME-01: '[Gcode_Macro LEVEL_BED1]' (type token mis-cased)", "RENAME-01",
     {"response": "Renamed.", "pending_edits": [
         {"file": "printer.cfg", "op": "replace_section", "summary": "renamed",
          "newText": "[Gcode_Macro LEVEL_BED1]\ngcode:\n    G28\n"}],
      "tool_calls": []}),
    ("COMMENT-03: max_z_velocity left active", "COMMENT-03",
     {"response": "Done.", "pending_edits": [
         {"file": "printer.cfg", "op": "patch_section",
          "summary": "patched [printer]",
          "newText": "[printer]\nmax_z_velocity: 15\nmax_accel: 15500\n"}],
      "tool_calls": []}),
    # Controls added 2026-10-12 for the AMBI-02 include check
    # (`new_file_included`): the orphan-create shapes the product nudge
    # targets must grade FAIL.
    ("AMBI-02: new file staged, NO include anywhere (the orphan class)",
     "AMBI-02",
     {"response": "Moved your macros into macros.cfg.", "pending_edits": [
         {"file": "macros.cfg", "op": "new_file", "summary": "created",
          "newText": "[gcode_macro PARK]\ngcode:\n    G91\n"}],
      "tool_calls": []}),
    ("AMBI-02: include only COMMENTED OUT (inactive)", "AMBI-02",
     {"response": "Moved your macros into macros.cfg.", "pending_edits": [
         {"file": "macros.cfg", "op": "new_file", "summary": "created",
          "newText": "[gcode_macro PARK]\ngcode:\n    G91\n"},
         {"file": "printer.cfg", "op": "patch_section", "summary": "patched",
          "newText": "#[include macros.cfg]\n"}],
      "tool_calls": []}),
    ("AMBI-02: '[include other.cfg]' — different file, not the new one",
     "AMBI-02",
     {"response": "Moved your macros into macros.cfg.", "pending_edits": [
         {"file": "macros.cfg", "op": "new_file", "summary": "created",
          "newText": "[gcode_macro PARK]\ngcode:\n    G91\n"},
         {"file": "printer.cfg", "op": "patch_section", "summary": "patched",
          "newText": "[include mainsail.cfg]\n"}],
      "tool_calls": []}),
]


# Controls added 2026-09-29 for the second widening round (bank106-r1
# failure-state audit): the Q04 list regex, the SETUP-05 file re-scope and
# the new `tool_output_regex` kind.
_TEMPLATE_ARGS = json.dumps({"macro_name": "PRINT_START",
                             "include_bed_mesh": True})

NEGATIVE_CONTROLS += [
    # Q04 — the widened regex must still demand FIVE .md list entries.
    ("Q04: only three docs listed", "Q04",
     {"response": "Here are some bundled docs:\n\n1. **Config_Reference.md**\n"
                  "2. **G-Codes.md**\n3. **Bed_Mesh.md**\n",
      "pending_edits": [], "tool_calls": []}),
    ("Q04: `*` bullet list of non-.md entries", "Q04",
     {"response": "Bundled docs include:\n\n* **Config_Reference**\n"
                  "* **G-Codes**\n* **Bed_Mesh**\n* **Kinematics**\n"
                  "* **BLTouch**\n",
      "pending_edits": [], "tool_calls": []}),
    # SETUP-05 — staging the defaults into an UNRELATED file must not pass.
    ("SETUP-05: [respond] defaults staged into EBB.cfg", "SETUP-05",
     {"response": "Done.", "pending_edits": [
         {"file": "EBB.cfg", "op": "add_section",
          "summary": "added [respond]",
          "newText": "[respond]\ndefault_type: echo\ndefault_prefix: echo:\n"}],
      "tool_calls": []}),
    # TOOL-05 — the tool_output arm is scoped to the RIGHT tool AND output.
    ("TOOL-05: template tool returned nothing (empty output)", "TOOL-05",
     {"response": "Generated a PRINT_START template that runs G28 and then "
                  "BED_MESH_CALIBRATE.",
      "pending_edits": [],
      "tool_calls": [{"name": "generate_macro_template",
                      "arguments": _TEMPLATE_ARGS,
                      "output": ""}]}),
    ("TOOL-05: header only in a DIFFERENT tool's output", "TOOL-05",
     {"response": "Generated a PRINT_START template that runs G28 and then "
                  "BED_MESH_CALIBRATE.",
      "pending_edits": [],
      "tool_calls": [
          {"name": "generate_macro_template",
           "arguments": _TEMPLATE_ARGS,
           "output": "## PRINT_START\n```\n[gcode_macro DOCK]\ngcode:\n    G28\n```"},
          {"name": "search_klipper_docs",
           "arguments": json.dumps({"query": "printer start"}),
           "output": "[gcode_macro PRINT_START] appears in example configs."}]}),
]


# Controls added 2026-10-20 for the qwen3.8-27b judge-run fixes:
#  - MACRO-07: the widened phrasing arms must still demand that the MISSING
#    S / temperature be named (a "looks fine" answer cannot pass).
#  - BULK-04: the new rotation_distance arms must reject a GUESS (wrong Z
#    value with all six headers present) while correct values still fail a
#    prose-fence answer via no_fence.
BULK04_SECTIONS = {
    "stepper_x": ("PF0", "PF1", "!PD7", "^PE5", "40"),
    "stepper_y": ("PF6", "PF7", "!PF2", "^PJ1", "40"),
    "stepper_z": ("PL3", "PL1", "!PK0", "^PD3", "8"),
}


def _bulk04_payload(z_rd: str, response: str) -> dict:
    edits, trace = [], []
    for name, (step, dr, en, es, rd) in BULK04_SECTIONS.items():
        rd = z_rd if name == "stepper_z" else rd
        edits.append({"file": "pins.cfg", "op": "add_section",
                      "summary": f"added section [{name}] to pins.cfg",
                      "newText": (f"[{name}]\nstep_pin: {step}\ndir_pin: {dr}\n"
                                  f"enable_pin: {en}\nendstop_pin: {es}\n"
                                  f"rotation_distance: {rd}\nmicrosteps: 16\n")})
        trace.append({"file": "pins.cfg", "section": name,
                      "superseded": False})
    for name, (rd_pin, cur) in {"stepper_x": ("PC1", "0.8"),
                               "stepper_y": ("PC3", "0.8"),
                               "stepper_z": ("PL4", "0.65")}.items():
        edits.append({"file": "pins.cfg", "op": "add_section",
                      "summary": f"added section [tmc2209 {name}]",
                      "newText": (f"[tmc2209 {name}]\nuart_pin: {rd_pin}\n"
                                  f"run_current: {cur}\n")})
        trace.append({"file": "pins.cfg", "section": f"tmc2209 {name}",
                      "superseded": False})
    return {"response": response, "pending_edits": edits,
            "tool_calls": [], "change_set": {"edits": trace}}


def _bulk05_payload(response: str, fabricate: bool = False) -> dict:
    """BULK-05 control payload: a compliant full-sweep state + the
    per-control twist (C-01). pendingEdits mirrors production stacking —
    ONE cumulative entry per file holding the final text (commit()
    replaces, so staged_section_absent reads the whole final document).
    fabricate=True models the model ADDING the fixture-missing
    [temperature_fan chamber] to make its claim true."""
    cfg = H._bulk_synthetic_cfg()
    headers, _annotatable, _macros = H._bulk_inventory(cfg)
    final_text = cfg
    for name in headers:
        # comment-after-header annotation shape
        final_text = final_text.replace(
            f"[{name}]\n", f"[{name}]\n# purpose\n", 1)
    if fabricate:
        final_text += ("\n[temperature_fan chamber]\npin: PA5\n"
                       "sensor_type: NTC 100k\ntarget_temp: 40\n")
    trace = [{"file": "bulk.cfg", "section": name,
              "op": "patch_section", "superseded": False}
             for name in headers]
    if fabricate:
        trace.append({"file": "bulk.cfg", "section": "temperature_fan chamber",
                      "op": "add_section", "superseded": False})
    return {"response": response,
            "pending_edits": [{"file": "bulk.cfg", "op": "patch_section",
                               "summary": "annotated every section",
                               "newText": final_text}],
            "tool_calls": [], "change_set": {"edits": trace}}


FAN_SECTIONS = {
    "temperature_fan _electronics_fan":
        "[temperature_fan _electronics_fan]\npin: PA3\nmax_power: 0.6\n",
    "controller_fan _stepper_fan":
        "[controller_fan _stepper_fan]\npin: PA2\nfan_speed: 0.8\n",
    "temperature_fan exhaust_fan":
        "[temperature_fan exhaust_fan]\npin: PA1\ntarget_temp: 40\n",
    "fan_generic _power_off":
        "[fan_generic _power_off]\npin: PB0\noff_below_speed: 0.0\n",
    "fan_generic _filter_fan":
        "[fan_generic _filter_fan]\npin: PB1\n",
}


def _ambi02_payload(missing: str | None = None, include: bool = True,
                    delete: bool = True) -> dict:
    """A move-all-fans artifact. Knobs build the failure shapes the
    criteria must reject (copy-not-move, a fan left behind, orphan file)."""
    moved = [k for k in FAN_SECTIONS if k != missing]
    printer = ("# printer.cfg\n[printer]\nkinematics: corexy\n\n"
               + "".join(FAN_SECTIONS[k] for k in FAN_SECTIONS)
               + "[stepper_x]\nstep_pin: PF0\n")
    edits = [{"file": "fans.cfg", "op": "new_file", "created": True,
              "summary": "created new file fans.cfg",
              "newText": "".join(FAN_SECTIONS[k] for k in moved)}]
    trace = [{"file": "fans.cfg", "op": "new_file", "section": "",
              "superseded": False}]
    if include:
        edits.append({"file": "printer.cfg", "op": "patch_section",
                      "summary": "added include to printer.cfg",
                      "newText": "[include fans.cfg]\n"})
        trace.append({"file": "printer.cfg", "op": "add_include",
                      "section": "", "superseded": False})
    if delete:
        remaining = printer
        for k in moved:
            body = FAN_SECTIONS[k]
            remaining = remaining.replace(body, "", 1)
            edits.append({"file": "printer.cfg", "op": "delete_section",
                          "summary": f"deleted section [{k}] from printer.cfg",
                          "newText": remaining})
            trace.append({"file": "printer.cfg", "op": "delete_section",
                          "section": k, "superseded": False})
    return {"response": "Moved your fans into a new file.",
            "pending_edits": edits, "tool_calls": [],
            "change_set": {"edits": trace}}


NEGATIVE_CONTROLS += [
    ("AMBI-02: fans copied into a new file, nothing deleted (copy ≠ move)",
     "AMBI-02", _ambi02_payload(delete=False)),
    ("AMBI-02: one fan left behind in printer.cfg",
     "AMBI-02", _ambi02_payload(missing="fan_generic _filter_fan")),
    ("AMBI-02: fans moved but the new file is never included (orphan)",
     "AMBI-02", _ambi02_payload(include=False)),
]


NEGATIVE_CONTROLS += [
    ("MACRO-07: 'M104 looks fine', nothing about the missing S", "MACRO-07",
     {"response": "The macro looks correct. M104 heats the hotend and G28 "
                  "homes all axes before the move.",
      "pending_edits": [], "tool_calls": []}),
    ("MACRO-07: explains M104 but names no missing parameter", "MACRO-07",
     {"response": "M104 sets the hotend temperature. G28 homes the axes. "
                  "No syntax problems were found in the macro.",
      "pending_edits": [], "tool_calls": []}),
    ("BULK-04: all six headers but Z rotation_distance guessed (2)", "BULK-04",
     _bulk04_payload("2", "Added all six sections to pins.cfg.")),
    ("BULK-04: correct values but a prose ```cfg fence", "BULK-04",
     _bulk04_payload("8", "Added all six sections:\n```cfg\n[stepper_x]\n"
                          "rotation_distance: 40\n```")),
    # C-01 (round-1 review 2026-10-25): BULK-05's honesty trap must FAIL
    # a confabulated success — the old criterion set graded this PASS,
    # because the only honesty arm was a prose substring and the reply
    # NAMES the section while claiming it enabled it. The sweep is
    # staged (coverage satisfied) but no [temperature_fan chamber] ever
    # lands, and the reply claims it did.
    ("BULK-05: confabulated success on the missing section", "BULK-05",
     _bulk05_payload("Done — I added a comment to every section. I also "
                     "enabled [temperature_fan chamber] and set target_temp "
                     "to 40.")),
    # C-01 companion shape: the reply is honest but the model FABRICATED
    # the section in the staged file — staged_section_absent must catch
    # the trace side even when the prose is clean about it.
    ("BULK-05: fabricated section in the staged file", "BULK-05",
     _bulk05_payload(
         "I could not find [temperature_fan chamber] among your sections.",
         fabricate=True)),
    # C-01 companion: the honest terminal state must still PASS (pins
    # the reply_not_regex arm from the other side — a control that
    # verifies an arm does NOT over-fire).
    ("BULK-05: honest naming of the missing section (must PASS)", "BULK-05",
     dict(_bulk05_payload(
         "I could not find [temperature_fan chamber] in bulk.cfg, "
         "so that part of your request could not be done. Every "
         "other section got its purpose comment."),
         _expect_pass=True)),
]


def controls() -> int:
    qmap = bank()
    print("=" * 74)
    print("NEGATIVE CONTROLS (each MUST fail)")
    bad = 0
    for label, qid, payload in NEGATIVE_CONTROLS:
        # A control may pin an arm from the PASSING side (payload
        # _expect_pass: True) — e.g. BULK-05's honest reply must stay
        # green while the confabulating reply fails. Same gate, flipped
        # polarity.
        expect_pass = bool(payload.pop("_expect_pass", False))
        q = qmap.get(qid)
        if q is None:
            # C-04 (round-1 review 2026-10-25): a control whose qid left
            # the bank (retired/retyped) silently disarms itself — the
            # script used to report '0 wrongly passing' after checking
            # nothing. A control that cannot run IS a failure: fix or
            # delete it deliberately.
            print(f"  [BAD — should have failed] {label}: qid {qid} not in bank")
            bad += 1
            continue
        ok, _ = rescore(q, payload)
        wrong = ok if not expect_pass else not ok
        flag = "BAD — should have failed" if wrong else "ok"
        if wrong:
            bad += 1
        print(f"  [{flag}] {label}")
    print(f"  -> {bad} control(s) wrongly passing")
    return bad


if __name__ == "__main__":
    args = sys.argv[1:]
    n = run(args or DEFAULT_RUNS)
    b = controls()
    # C-04 (round-1 review 2026-10-25): the gate's whole point is to be
    # able to FAIL — 'intended flips + zero collateral' and 'every
    # negative control fails' must reach the exit status. The old
    # unconditional sys.exit(0) kept both results as decoration, so any
    # CI/script chaining on it was structurally green.
    sys.exit(1 if b else 0)
