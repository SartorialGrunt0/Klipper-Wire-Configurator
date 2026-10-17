"""Unit tests for the accuracy harness's BULK-family grading helpers.

Step 5 (large-edit rework 2026-10-17): the five new criterion kinds
(coverage / no_fence / single_request / failed_named_in_reply) and the
any_of recursion forwarding of the new kwargs. Pure scoring — no live
backend needed (same harness-import shape as
test_accuracy_harness_ack_guard.py).

Evidence law: coverage counts come from the server's own changeSet
trace, never from reply prose; these tests pin that boundary.
"""
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "ai_chat_accuracy_test.py"

sys.path.insert(0, str(ROOT / "backend"))

_spec = importlib.util.spec_from_file_location("ai_chat_accuracy_test", SCRIPT)
harness = importlib.util.module_from_spec(_spec)
# Register before exec: dataclass processing resolves annotations via
# sys.modules[cls.__module__].
sys.modules[_spec.name] = harness
_spec.loader.exec_module(harness)

c = harness.criterion_ok

CS = {"edits": [
    {"file": "printer.cfg", "section": "gcode_macro A", "op": "patch",
     "superseded": False},
    {"file": "printer.cfg", "section": "gcode_macro A", "op": "patch",
     "superseded": True},
    {"file": "printer.cfg", "section": "gcode_macro B", "op": "patch",
     "superseded": False},
    {"file": "printer.cfg", "section": "fan", "op": "patch",
     "superseded": False},
    {"file": "other.cfg", "section": "gcode_macro C", "op": "patch",
     "superseded": False},
]}


# ── coverage ───────────────────────────────────────────────────────────


def test_coverage_counts_distinct_non_superseded():
    assert c("coverage", "printer.cfg::2", "", change_set=CS)
    assert c("coverage", "printer.cfg::3", "", change_set=CS)
    # A appears twice but once is superseded: never double-counted.
    assert not c("coverage", "printer.cfg::4", "", change_set=CS)


def test_coverage_prefix_filter_case_insensitive():
    assert c("coverage", "printer.cfg::gcode_macro::1", "", change_set=CS)
    assert not c("coverage", "printer.cfg::gcode_macro::3", "", change_set=CS)


def test_coverage_file_scoped():
    # other.cfg has exactly one section; the printer.cfg rows must not leak.
    assert c("coverage", "other.cfg::1", "", change_set=CS)
    assert not c("coverage", "other.cfg::2", "", change_set=CS)


def test_coverage_malformed_and_missing():
    assert not c("coverage", "badvalue", "", change_set=CS)
    assert not c("coverage", "printer.cfg::notanint", "", change_set=CS)
    assert not c("coverage", "printer.cfg::1", "", change_set=None)
    assert not c("coverage", "printer.cfg::1", "", change_set={})


# ── no_fence ───────────────────────────────────────────────────────────


def test_no_fence_clean_reply_passes():
    assert c("no_fence", "", "All done, three sections updated.")


def test_no_fence_catches_inert_draft():
    assert not c("no_fence", "", "Here:\n```cfg\n[x]\n```")
    # The fence is the signal regardless of language-case.
    assert not c("no_fence", "", "```TOOL\nsearch_user_configs\n```")


# ── single_request ─────────────────────────────────────────────────────


def test_single_request_turn_boundary_inclusive():
    assert c("single_request", "max_turns=6", "", tool_turns=6)
    assert not c("single_request", "max_turns=6", "", tool_turns=7)


def test_single_request_attempts_require_evidence():
    # None attempts = no trace evidence = fail (trace-only law).
    assert not c("single_request", "max_turns=6,max_attempts=10", "",
                 tool_turns=3, edit_attempts=None)
    assert c("single_request", "max_turns=6,max_attempts=10", "",
             tool_turns=3, edit_attempts=9)
    assert not c("single_request", "max_turns=6,max_attempts=10", "",
                 tool_turns=3, edit_attempts=11)


def test_single_request_malformed_term_fails_closed():
    assert not c("single_request", "max_turns=6,", "", tool_turns=6)
    assert not c("single_request", "max_retries=2", "", tool_turns=1)


# ── failed_named_in_reply ──────────────────────────────────────────────


def test_failed_named_case_insensitive_substring():
    assert c("failed_named_in_reply", "Temperature_Fan Chamber",
             "I could not find [temperature_fan chamber] in the file.")


def test_failed_named_rejects_blind_success_claim():
    assert not c("failed_named_in_reply", "temperature_fan chamber",
                 "All done, everything worked.")


# ── any_of recursion forwards the new kwargs ───────────────────────────


def test_any_of_forwards_change_set():
    arms = '[[["coverage", "printer.cfg::3"]], [["contains", "zzz-nope"]]]'
    assert c("any_of", arms, "", change_set=CS)


def test_any_of_forwards_tool_turns():
    arms = '[[["single_request", "max_turns=5"]], [["contains", "fine"]]]'
    assert c("any_of", arms, "fine", tool_turns=9)


def test_staged_section_regex_line_anchored_pattern():
    """BULK-03 re-run (2026-10-17): author wrote '^\\s+level_bed\\b'
    expecting line anchoring; without re.MULTILINE the '^' matched only
    string start and a correctly-staged body failed. re.M widens '^'/'$'
    only — no pre-existing passing arm can flip to fail."""
    pe = [{"file": "printer.cfg", "newText":
           "[gcode_macro PRINT_START]\ngcode:\n    M104 S200\n    level_bed\n"}]
    assert c("staged_section_regex",
             "printer.cfg::gcode_macro PRINT_START::^\\s+level_bed\\b",
             "", pending_edits=pe)
    # negative control: the name only mid-line must NOT satisfy ^\s+
    pe2 = [{"file": "printer.cfg", "newText":
            "[gcode_macro PRINT_START]\ngcode:\n    RESPOND X=level_bed\n"}]
    assert not c("staged_section_regex",
                 "printer.cfg::gcode_macro PRINT_START::^\\s+level_bed\\b",
                 "", pending_edits=pe2)


# ── bank wiring ────────────────────────────────────────────────────────


def test_bulk_family_registered_and_disjoint():
    bulk = harness.build_bulk_questions()
    assert [q.qid for q in bulk] == [
        "BULK-01", "BULK-02", "BULK-03", "BULK-04", "BULK-05"]
    others = (harness.build_questions() + harness.build_macro_questions()
              + harness.build_trident_questions()
              + harness.build_ambiguity_questions()
              + harness.build_setup_questions()
              + harness.build_live_context_questions()
              + harness.build_edit_tool_questions()
              + harness.build_rename_questions()
              + harness.build_comment_questions()
              + harness.build_skill_gate_questions()
              + harness.build_tool_coverage_questions()
              + harness.build_ack_guard_questions())
    assert not {q.qid for q in bulk} & {q.qid for q in others}


def test_bulk_criteria_kinds_all_known():
    # Every criterion kind used by the BULK bank must be dispatched by
    # criterion_ok (i.e. not silently fall through to the unknown-kind
    # False at the tail).
    for q in harness.build_bulk_questions():
        for kind, _value in q.criteria:
            # A kind that fell through would return False on a reply
            # crafted to trivially satisfy no criterion — instead check
            # the kind is in the explicit dispatch set via source probe.
            src = Path(SCRIPT).read_text()
            assert f'if kind == "{kind}"' in src or kind == "any_of", kind
