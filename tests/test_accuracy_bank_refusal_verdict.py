"""SIMTOOL-07 refusal-verdict grading (2026-11-19).

Why this exists: SIMTOOL-07 asks whether 240 °C is outside any range
Klipper checks. For three consecutive live rounds the correct answer was
FAILed because the criterion tried to prove an AFFIRMATION with a regex
enumerating spellings ("valid|fine|allowed|ok|not rejected|no findings|
..."). Affirmative prose is an open set — each leg invents a new one:

  r1 ("will accept it")            missed 'accepted'  -> arm added
  r2 (bold "only one of")          markdown broke it  -> whack-a-mole
  p3-r1 ("in range — no rejection" / "Findings: none" /
         "will not be rejected")   three more spellings -> still missed

The fix inverts the test: REFUSAL claims are a CLOSED set, and every
correct answer that mentions one scopes it conditionally ("only if
max_temp is below 240") or environmentally ("won't run on this printer —
config error"). So the kind asserts *no unscoped refusal claim*, and
scope is decided structurally (clause + negator/conditional markers),
never by enumerating ways to say yes.

The corpus (`tests/data/simtool07_verdicts.json`) is the adjudicated
answers — five real live legs that are correct, five fabrications that
must stay red. Append new live legs to the corpus rather than adding a
regex arm.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

_spec = importlib.util.spec_from_file_location(
    "ai_chat_accuracy_test", ROOT / "scripts" / "ai_chat_accuracy_test.py")
H = importlib.util.module_from_spec(_spec)
sys.modules.setdefault(_spec.name, H)
_spec.loader.exec_module(H)

CORPUS = json.loads(
    (ROOT / "tests" / "data" / "simtool07_verdicts.json").read_text())
ENTRIES = CORPUS["entries"]

# The clean simulate_macro artifact the scoreboard produces for this qid:
# M104 S240 rendered, no invented bound in the tool output. Prose-only
# controls below therefore fail (or pass) on the PROSE arms alone.
CLEAN_SIM_OUTPUT = (
    "Rendered (1 path(s)):\n"
    "  L1: M104 S240\n"
    "  L2: M109 S240\n"
    "Execution trace (...):\n"
    "  L1: M104 S240 \u2192 extruder target \u2014 \u2192 240\u00b0C\n"
    "Findings: none \u2014 every rendered command matched the registry shape "
    "on this invocation.")


def _simtool07_criteria():
    for q in H.build_simtool_questions():
        if q.qid == "SIMTOOL-07":
            return tuple(q.edit_criteria or q.criteria)
    raise AssertionError("SIMTOOL-07 missing from build_simtool_questions()")


def _score(entry: dict) -> bool:
    """Score one corpus answer through the qid's own criteria."""
    calls = [{"name": "simulate_macro", "output": CLEAN_SIM_OUTPUT}]
    return all(
        H.criterion_ok(kind, value, entry["text"],
                       tool_calls=calls, pending_edits=[])
        for kind, value in _simtool07_criteria())


@pytest.mark.parametrize("entry", ENTRIES, ids=[e["label"] for e in ENTRIES])
def test_corpus_answer_scores_as_adjudicated(entry):
    assert _score(entry) is (entry["expect"] == "pass"), entry["label"]


_CLAIM_ENTRIES = [e for e in ENTRIES if not e["label"].startswith("vacuous")]


@pytest.mark.parametrize("entry", _CLAIM_ENTRIES,
                         ids=[e["label"] for e in _CLAIM_ENTRIES])
def test_kind_alone_scores_as_adjudicated(entry):
    """The kind grades CLAIMS only — the vacuous entry is excluded on
    purpose: it makes no claim, so the kind passes it and the ENGAGEMENT
    arm is what fails it (see test_engagement_arm_rejects_a_vacuous_answer).
    Keeping those two concerns separate is what lets the kind compose."""
    ok = H.criterion_ok("no_asserted_refusal", "", entry["text"])
    assert ok is (entry["expect"] == "pass"), entry["label"]


def test_kind_is_silent_on_an_answer_that_makes_no_claim():
    vacuous = next(e for e in ENTRIES if "vacuous" in e["label"])
    assert H.criterion_ok("no_asserted_refusal", "", vacuous["text"])


def test_corpus_is_a_real_corpus():
    live = [e for e in ENTRIES if e["source"].startswith("live leg")]
    assert len(live) >= 4, "corpus lost its live legs"
    assert {e["expect"] for e in ENTRIES} == {"pass", "fail"}


def test_simtool07_has_no_affirmation_enumerating_regex():
    """Static guard: the arms must be structural. An affirmative regex
    enumerating verdict vocabulary is the defect this change removed."""
    criteria = _simtool07_criteria()
    kinds = [k for k, _ in criteria]
    assert ("no_asserted_refusal", "") in criteria, (
        f"SIMTOOL-07 lost its structural verdict arm: {criteria}")
    affirmations = ("finite", "allowed", "not rejected")
    for kind, value in criteria:
        if kind == "regex":
            low = value.lower()
            assert not any(a in low for a in affirmations), (
                f"affirmation-enumerating arm is back: {value!r}")
            # the one prose regex left is the ENGAGEMENT arm: it must name
            # the value under test, not a verdict vocabulary.
            assert "240" in value or "m104" in low, (
                f"unexpected prose regex arm: {value!r}")
    assert kinds.count("no_asserted_refusal") == 1


def test_engagement_arm_rejects_a_vacuous_answer():
    vacuous = next(e for e in ENTRIES if "vacuous" in e["label"])
    assert not _score(vacuous)
