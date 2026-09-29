"""Unit tests for the accuracy harness's Phase-6.5.5 grading helpers.

The harness itself needs a live backend; these tests cover the pure
scoring pieces: the narration-vs-tool mismatch detector and the
expect_no_ack_stall FAIL override shape, plus the ACK-* bank cases
existing with their assertions wired.
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


# ── _narration_tool_mismatch (structural SET_LED-style detector) ───────


def test_mismatch_narrated_edit_read_only_batch():
    turns = [{"turn": 2, "narration": "Applying the change to printer.cfg now.",
              "toolNames": ["read_user_config"]}]
    assert harness._narration_tool_mismatch(turns) is True


def test_mismatch_write_tool_present_no_flag():
    turns = [{"turn": 2, "narration": "Applying the change to printer.cfg now.",
              "toolNames": ["config_edit"]}]
    assert harness._narration_tool_mismatch(turns) is False


def test_mismatch_pure_read_narration_no_flag():
    # Narrow verb law: reading/checking/looking up never read as edit
    # claims even beside read-only batches.
    turns = [
        {"turn": 1, "narration": "Reading printer.cfg first.",
         "toolNames": ["read_user_config"]},
        {"turn": 2, "narration": "Checking the docs for the parameter.",
         "toolNames": ["search_klipper_docs"]},
    ]
    assert harness._narration_tool_mismatch(turns) is False


def test_mismatch_empty_and_missing_fields():
    assert harness._narration_tool_mismatch([]) is False
    assert harness._narration_tool_mismatch([{}]) is False
    assert harness._narration_tool_mismatch(
        [{"turn": 1, "narration": "", "toolNames": []}]) is False


def test_mismatch_second_turn_flags():
    turns = [
        {"turn": 1, "narration": "Reading the file.", "toolNames": ["read_user_config"]},
        {"turn": 2, "narration": "Now updating the macro value.", "toolNames": ["list_user_config_sections"]},
    ]
    assert harness._narration_tool_mismatch(turns) is True


# ── ACK-* bank wiring ──────────────────────────────────────────────────


def _ack_questions():
    return {q.qid: q for q in harness.build_ack_guard_questions()}


def test_ack_family_exists_with_assertions():
    acks = _ack_questions()
    assert set(acks) == {"ACK-01", "ACK-02", "ACK-N01"}
    for q in acks.values():
        assert q.expect_no_ack_stall is True


def test_ack_family_protocol_parity_pairs():
    acks = _ack_questions()
    assert acks["ACK-01"].tool_protocol == "native"
    assert acks["ACK-02"].tool_protocol == "text"
    # The two stall cases are the SAME edit — parity means same question.
    assert acks["ACK-01"].text == acks["ACK-02"].text
    assert acks["ACK-01"].criteria == acks["ACK-02"].criteria


def test_ack_family_reachable_from_main():
    # The runner line concatenates build_ack_guard_questions() into the
    # bank; a missing registration would break --questions ACK silently.
    import inspect
    src = inspect.getsource(harness.main) if hasattr(harness, "main") else ""
    assert "build_ack_guard_questions()" in src


def test_chat_payload_per_question_protocol_override():
    # The runner must honor TestQuestion.tool_protocol over the run flag.
    q = harness.build_ack_guard_questions()[0]
    settings = {"api_key": "", "model": "m", "api_url": "http://x/y",
                "provider": "openai-compatible", "max_tokens": 100,
                "temperature": 0.7, "tool_protocol": "auto"}
    # Reach the payload construction without HTTP: replicate the dict the
    # way chat_request does, asserting the override line's logic.
    protocol = q.tool_protocol or settings.get("tool_protocol", "auto")
    assert protocol == "native"
    plain = harness.build_questions()[0]
    assert (plain.tool_protocol or settings.get("tool_protocol", "auto")) == "auto"


# ── Criterion kinds added 2026-09-28 (criteria audit) ──────────────────


def _crit(kind, value, *, response="", edits=()):
    return harness.criterion_ok(kind, value, response, memory=None,
                                tool_calls=[], pending_edits=list(edits))


def _edit(file, text, op="patch_section"):
    return {"file": file, "op": op, "summary": "", "newText": text}


def test_staged_param_is_case_sensitive_but_ci_sibling_is_not():
    # Klipper upper-cases gcode params (klippy/gcode.py) and lower-cases
    # config option names (configparser.RawConfigParser.optionxform), so a
    # model writing `adaptive=1` or `MAX_ACCEL:` is correct. The original
    # `staged_param` byte-matched and false-FAILed it; `staged_param_ci`
    # is the fix. Section headers are deliberately NOT covered — Klipper
    # does not normalise those.
    edits = [_edit("printer.cfg", "BED_MESH_CALIBRATE adaptive=1\n")]
    assert _crit("staged_param", "printer.cfg::ADAPTIVE=1", edits=edits) is False
    assert _crit("staged_param_ci", "printer.cfg::ADAPTIVE=1", edits=edits) is True
    edits = [_edit("printer.cfg", "MAX_ACCEL: 12000\n")]
    assert _crit("staged_param", "printer.cfg::max_accel: 12000", edits=edits) is False
    assert _crit("staged_param_ci", "printer.cfg::max_accel: 12000", edits=edits) is True


def test_staged_param_ci_still_scoped_to_the_named_file():
    edits = [_edit("aux_fan.cfg", "adaptive=1\n")]
    assert _crit("staged_param_ci", "printer.cfg::ADAPTIVE=1", edits=edits) is False


def test_not_staged_any_closes_the_cross_file_hole():
    # SKILL-N04 2026-09-28: the user said "don't add it to my config" and
    # gemma-4-e4b created macros.cfg. The file-scoped kind went green.
    edits = [_edit("macros.cfg", "[gcode_macro PARK_X]\n", op="new_file")]
    assert _crit("not_staged", "printer.cfg", edits=edits) is True   # the hole
    assert _crit("not_staged_any", "", edits=edits) is False         # the fix
    assert _crit("not_staged_any", "", edits=[]) is True


def test_macro_01_accepts_g0_as_a_park_move():
    # G-Codes.md documents "Move (G0 or G1)" — they are the same command.
    body = ("```cfg\n[gcode_macro PARK_HEAD]\ndescription: parks\n"
            "gcode:\n    G0 X0 Y0 Z10 F6000\n    M106 S0\n```")
    q = {q.qid: q for q in harness.build_macro_questions()}["MACRO-01"]
    assert all(harness.criterion_ok(k, v, body) for k, v in q.criteria)
    # A move that never reaches X0 must still fail.
    stray = body.replace("G0 X0 Y0 Z10 F6000", "G1 Z10 F600")
    assert not all(harness.criterion_ok(k, v, stray) for k, v in q.criteria)


def test_comment_03_targets_an_optional_printer_param():
    # max_accel is REQUIRED in [printer] (Config_Reference "This parameter
    # must be specified"), so asking to comment it out produced a config the
    # validator correctly refused to stage — no model could pass by doing the
    # right thing. The qid now targets the optional max_z_velocity.
    q = {q.qid: q for q in harness.build_comment_questions()}["COMMENT-03"]
    assert "max_z_velocity" in q.text
    assert "max_accel" not in q.text
    assert "max_z_velocity" in q.criteria[0][1]


def test_ambi_07_grades_the_edit_on_the_staged_artifact():
    # The explanation half stays prose; the edit half must not be graded on
    # the reply's phrasing (3/3 models staged the value and still FAILed).
    q = {q.qid: q for q in harness.build_ambiguity_questions()}["AMBI-07"]
    kinds = [k for k, _ in q.edit_criteria]
    assert kinds.count("staged_regex") == 2
    # Prose-only claims must NOT satisfy the edit arm.
    prose = ("Add pressure_advance: 0.05 in [extruder] and an [input_shaper] "
             "section. Explains both.")
    assert not all(harness.criterion_ok(k, v, prose, memory=None, tool_calls=[],
                                        pending_edits=[])
                   for k, v in q.edit_criteria)


def test_skill_n04_uses_the_any_file_negation():
    q = {q.qid: q for q in harness.build_skill_gate_questions()}["SKILL-N04"]
    assert ("not_staged_any", "") in q.criteria
    assert not any(k == "not_staged" for k, _ in q.criteria)


def test_q19_clarification_accepts_natural_phrasing():
    # The 2026-09-28 regression: a textbook clarifying answer scored FAIL
    # because none of the eight arms matched "I'll need some basic hardware
    # details … paste them here".
    q = {q.qid: q for q in harness.build_questions()}["Q19"]
    answer = ("I'd be happy to help you set up Klipper for your new printer! "
              "To get started, I'll need some basic hardware details:\n"
              "1. Printer model or type\n2. Mainboard/MCU\n"
              "If you have config files, paste them here and I can extract "
              "the details.\n")
    assert all(harness.criterion_ok(k, v, answer) for k, v in q.criteria)
    # Answering without asking must still FAIL.
    assert not all(
        harness.criterion_ok(k, v, "Sure! Here is a complete printer.cfg for "
                                   "a Voron 2.4 with an Octopus board.")
        for k, v in q.criteria)
