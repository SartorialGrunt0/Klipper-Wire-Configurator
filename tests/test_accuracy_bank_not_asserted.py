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
