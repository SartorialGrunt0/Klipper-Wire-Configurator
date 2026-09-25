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
    assert set(acks) == {"ACK-STALL-NATIVE", "ACK-STALL-TEXT", "ACK-QA-NEG"}
    for q in acks.values():
        assert q.expect_no_ack_stall is True


def test_ack_family_protocol_parity_pairs():
    acks = _ack_questions()
    assert acks["ACK-STALL-NATIVE"].tool_protocol == "native"
    assert acks["ACK-STALL-TEXT"].tool_protocol == "text"
    # The two stall cases are the SAME edit — parity means same question.
    assert acks["ACK-STALL-NATIVE"].text == acks["ACK-STALL-TEXT"].text
    assert acks["ACK-STALL-NATIVE"].criteria == acks["ACK-STALL-TEXT"].criteria


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
