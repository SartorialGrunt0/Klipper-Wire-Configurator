"""The `not_asserted` kind: naming a defect inside a NEGATED CLAUSE is
allowed; naming it anywhere else is a failure.

Why this exists (MACRO-14, 2026-11-17): a cry-wolf-clean answer may
legitimately name the defect it rules out ("so no 'unable to parse' risk
at runtime") — naive containment false-failed it. Why this file exists
(PR #43 second-pass review F11, 2026-11-19): the negation check was
sentence-wide, so the hedge "NOT SURE, but that macro is UNBALANCED"
passed — 'not' from "not sure" rescued an assertion three words later.
The rule is now clause-scoped:

  * a sentence splits on enders AND the word 'but' (which separates a
    hedge from what it concedes);
  * epistemic hedges / assertion boosters ('not sure', 'no doubt',
    'not certain', …) are stripped — they speak about the speaker's
    confidence while the embedded claim stands;
  * the surviving negator must PRECEDE the phrase inside its clause.

Ambiguity is never scored as ruling the defect out (stays RED).

The tail of this file also pins the two residuals the second pass found
(L-3/L-4/L-6 clause scoping, L-5's tense-free refusal claims) — the same
grader file, so one loader and one place to read the law.
"""
from __future__ import annotations

import importlib.util
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


def _ok(answer: str, phrase: str) -> bool:
    return H.criterion_ok("not_asserted", phrase, answer,
                          memory="", tool_calls=[], pending_edits=[])


# ── legitimate: the defect named INSIDE a negated clause ────────────────
@pytest.mark.parametrize("answer,phrase", [
    ("The macro validates fine, so there is no 'unable to parse' risk "
     "at runtime.", "unable to parse"),
    ("Nothing unbalanced here — this macro is correct.", "unbalanced"),
    ("The macro is not unbalanced.", "unbalanced"),
    ("I checked: the macro never renders empty.", "renders empty"),
    ("No syntax error anywhere in the section.", "syntax error"),
])
def test_negated_mention_passes(answer, phrase):
    assert _ok(answer, phrase) is True


# ── F11: hedges and boosters assert; they must not be read as negations ─
@pytest.mark.parametrize("answer,phrase", [
    pytest.param("Not sure, but that macro is unbalanced — the Jinja "
                 "looks fine otherwise.", "unbalanced",
                 id="hedge-but-asserts"),
    pytest.param("No doubt about it: the macro renders empty when called.",
                 "renders empty", id="booster-asserts"),
    pytest.param("I am not sure that macro is unbalanced.", "unbalanced",
                 id="hedged-assert-without-but"),
    pytest.param("The macro is unbalanced, not fine.", "unbalanced",
                 id="negator-after-phrase-is-ambiguity"),
])
def test_hedged_or_bare_assertion_fails(answer, phrase):
    assert _ok(answer, phrase) is False


# ── plain assertions and absent phrases keep the old semantics ─────────
def test_bare_assertion_fails():
    assert _ok("The macro has a syntax error on line 4.",
               "syntax error") is False


def test_phrase_absent_passes():
    assert _ok("Everything checks out.", "renders empty") is True


def test_second_unnegated_occurrence_fails():
    # "no unbalanced branches" is negated; the later bare mention is not.
    answer = ("There are no unbalanced branches. In fact the block is "
              "unbalanced in two places.")
    assert _ok(answer, "unbalanced") is False


# ── PR #43 second-pass L-3: repeated 'but' must not walk the header past ──
# the negator. The old loop mixed an ORIGINAL slice with a MUTATED start, so
# every 'but' before the phrase moved the clause start a second time; two
# 'but's pushed `start` beyond the phrase and the negator fell out of scope
# (phrase_lo went negative), RED-ing answers that do rule the defect out.
@pytest.mark.parametrize("answer,phrase", [
    pytest.param("It's not a bug but a feature, but I wouldn't call it "
                 "unbalanced.", "unbalanced",
                 id="negator-before-two-buts"),
    pytest.param("There is no issue but a style note, but the macro is not "
                 "unbalanced.", "unbalanced",
                 id="negated-tail-after-two-buts"),
])
def test_repeated_but_keeps_the_negator_in_scope(answer, phrase):
    assert _ok(answer, phrase) is True


# ── PR #43 second-pass L-4: an UNLISTED hedge's negator must not rescue ───
# the claim it hedges. The neutralizer was a closed list, so every hedge
# spelling it did not know ("not fully sure", "no question", "nothing to
# worry about") left its 'not/no/nothing' behind as a negator in front of an
# assertion the answer still makes — a false PASS in the dangerous
# direction. The grammar is open; the strip is now pattern-based.
@pytest.mark.parametrize("answer,phrase", [
    pytest.param("I'm not fully sure that macro is unbalanced.",
                 "unbalanced", id="hedge-not-fully-sure"),
    pytest.param("I'm not entirely sure, the macro is unbalanced.",
                 "unbalanced", id="hedge-not-entirely-sure"),
    pytest.param("No question, the macro is unbalanced.",
                 "unbalanced", id="hedge-no-question"),
    pytest.param("Nothing to worry about, the macro is unbalanced.",
                 "unbalanced", id="hedge-nothing-to-worry-about"),
    pytest.param("No concern here: the macro renders empty.",
                 "renders empty", id="hedge-no-concern-here"),
    pytest.param("Not a problem at all, the macro is unbalanced.",
                 "unbalanced", id="hedge-not-a-problem-at-all"),
    pytest.param("No question that the macro renders empty.",
                 "renders empty", id="booster-no-question-that"),
])
def test_unlisted_hedge_does_not_rescue_the_claim(answer, phrase):
    assert _ok(answer, phrase) is False


# ── the hedge strip must not eat a negator that DOES negate the claim ────
# "no concern about the X" / "no problem with the X" are negated mentions,
# not hedge framing: the negated noun carries the claim, so the negator
# stays in scope. (The old closed list never touched them; the pattern
# must not either.)
@pytest.mark.parametrize("answer,phrase", [
    pytest.param("There is no concern about the unbalanced block.",
                 "unbalanced", id="no-concern-about"),
    pytest.param("There is no problem with the unbalanced branches.",
                 "unbalanced", id="no-problem-with"),
    # A concern word with a CLAUSE COMPLEMENT negates the claim itself
    # ("I have no concern that anything is unbalanced" = it is not
    # unbalanced), unlike the booster family ("No doubt that the macro
    # renders empty"). The hedge strip must not reach it.
    pytest.param("I have no concern that anything is unbalanced.",
                 "unbalanced", id="no-concern-that"),
    pytest.param("There is no issue with unbalanced braces.", "unbalanced",
                 id="no-issue-with"),
])
def test_hedge_strip_leaves_a_real_negation_alone(answer, phrase):
    assert _ok(answer, phrase) is True


# ── PR #43 second-pass L-6: a decimal point is not a clause boundary ─────
# Clause starts came from rfind('.') over the enders, so the '.' in "1.8"
# opened a fake clause and dropped the negator in front of the phrase.
@pytest.mark.parametrize("answer,phrase", [
    pytest.param("There is no 1.8 unbalanced offset in this block.",
                 "unbalanced", id="decimal-before-phrase"),
    pytest.param("There is no unbalanced 1.8 offset.", "unbalanced",
                 id="decimal-after-phrase"),
])
def test_decimal_point_does_not_split_the_clause(answer, phrase):
    assert _ok(answer, phrase) is True


# ── PR #43 second-pass L-5: three claim patterns are TENSE-FREE ──────────
# 'out of range' / 'exceeds the maximum' / 'aborts the macro' read the same
# as a claim about what happened and as an irrealis hypothesis, so F10's
# "an irrealis refusal never reaches the scope check" was false for them
# and a correct hypothetical answer was graded a refusal claim (a false
# error). A modal in the claim's own preceding window makes the sentence a
# hypothetical OUTCOME; the claim only counts when no modal frames it (or
# a present-tense refusal verb pins it to fact).
def _refusal_ok(answer: str) -> bool:
    return H.criterion_ok("no_asserted_refusal", "", answer,
                          memory="", tool_calls=[], pending_edits=[])


@pytest.mark.parametrize("answer", [
    pytest.param("Were max_temp 200, the command would exceed the maximum.",
                 id="subjunctive-were-exceeds"),
    pytest.param("240 would be out of range on a 200-degree printer.",
                 id="would-be-out-of-range"),
    pytest.param("If your max_temp were 200, M104 S240 would be out of "
                 "range.", id="if-were-would-scoped"),
])
def test_irrealis_hypothesis_is_not_a_refusal_claim(answer):
    assert _refusal_ok(answer) is True


@pytest.mark.parametrize("answer", [
    # an indicative claim with no modal frame is still a refusal claim.
    pytest.param("M104 S=300 exceeds the maximum.", id="bare-exceeds"),
    pytest.param("M104 S=300 exceeds the maximum on a stock hotend.",
                 id="exceeds-unscoped"),
    # F10's rhetorical frames are NOT irrealis hypotheses: 'should' opening
    # the clause is an inverted conditional (the invocation under test),
    # and a concessive 'while' names that same invocation.
    pytest.param("Should you run it, 240 is outside the range Klipper "
                 "accepts.", id="inverted-should-is-rhetorical"),
    pytest.param("While M104 S240 renders, 240 exceeds the maximum, so "
                 "Klipper refuses the command.", id="concessive-while"),
    # The guard is limited to the TENSE-FREE patterns: an indicative claim
    # ('is rejected') is a claim even when a modal sits near it, and a
    # present-tense refusal in the window pins a tense-free one to fact
    # ('was refused BECAUSE 240 would exceed …' asserts the refusal).
    pytest.param("Klipper would refuse it there, so the command is "
                 "rejected.", id="indicative-claim-next-to-a-modal"),
    pytest.param("The command was refused because 240 would exceed the "
                 "maximum.", id="present-refusal-pins-the-window"),
])
def test_indicative_claim_still_fails(answer):
    assert _refusal_ok(answer) is False


def test_claim_leg_still_fires_under_an_environmental_scope():
    """'on a real printer' is an ENVIRONMENTAL scope (the settled SIMTOOL-07
    law: a refusal attributed to the host's own state is not a claim about
    the command), so the end-to-end verdict is PASS — but the tense-free
    claim must still be DETECTED. Pin the detection leg, not a manufactured
    RED: if the irrealis guard swallowed it, the answer would pass for the
    wrong reason and a real 'exceeds on a real printer' exclusion would be
    invisible to the next reader of this file.
    """
    sentence = "M104 S=300 exceeds the maximum on a real printer."
    claim = H._REFUSAL_CLAIM_RE.search(sentence)
    assert claim is not None and claim.group(0) == "exceeds the maximum"
    assert H._irrealis_frame(sentence, claim.start()) is False
