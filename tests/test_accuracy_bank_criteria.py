"""Accuracy-bank criteria meta-test (F9 class, review round-1 2026-11-14).

The SIMTOOL-02 quad-escape (``"printer\\\\\\\\.cfg"`` compiling to a
literal-backslash pattern that could NEVER match a real filename)
shipped through every live leg because nothing statically checked the
criteria VALUES — the offline re-scorer only replays them against
captured runs, and a regex that can never pass makes a leg FAIL, not
drift green. This test locks the class forever:

1. every regex-shaped criterion value in every builder COMPILES;
2. no regex value requires a literal backslash (two consecutive
   backslashes in the pattern = the quad-escape family);
3. every filename regex actually matches at least one of the question's
   own context_files names (a filename pattern matching nothing the
   question ships is dead by construction);
4. substring-kind values carry no backslashes (regex confusion in a
   substring criterion).

Pure-static: no backend, no model, no fixtures beyond the bank itself.
"""
from __future__ import annotations

import importlib.util
import re
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


def _all_questions():
    for attr in sorted(dir(H)):
        if attr.startswith("build_") and attr.endswith("_questions"):
            fn = getattr(H, attr)
            if callable(fn):
                for q in fn():
                    yield attr, q


def _pairs(q):
    """Yield (kind, value) for criteria + edit_criteria, descending one
    level into any_of arms (mirrors criterion_ok's single-level guard)."""
    for src in (q.criteria or (), q.edit_criteria or ()):
        for kind, value in src:
            if kind == "any_of":
                import json as _json
                try:
                    arms = _json.loads(value)
                except ValueError:
                    pytest.fail(f"{q.qid}: any_of value is not JSON: {value!r}")
                for arm in arms:
                    for sub_kind, sub_value in arm:
                        assert sub_kind != "any_of", \
                            f"{q.qid}: nested any_of is not supported"
                        yield sub_kind, sub_value
            else:
                yield kind, value


# Kinds whose (part of the) value is compiled as a regex.
_PLAIN_REGEX_KINDS = {"regex", "reply_not_regex"}
_SUBSTR_KINDS = {"contains", "not_contains", "staged_param",
                 "staged_param_ci", "staged_header",
                 "staged_new_file_header", "staged_section_absent",
                 "failed_named_in_reply", "not_staged", "not_staged_any",
                 "staged_any_param"}
# "file::substring" kinds whose filename segment is an EXACT-match target.
_EXACT_FN_PREFIX_KINDS = {"staged_param", "staged_param_ci", "staged_header"}


def _decode_fn(name: str) -> str:
    """The harness's data-escaped-dot convention (\\ . -> .) for the
    EXACT-match filename segments."""
    return name.replace("\\.", ".")


def _regex_parts(kind: str, value: str):
    """Yield (label, pattern_or_None, exact_filename_or_None,
    fn_regex_or_None) for values of this kind, mirroring criterion_ok's
    parsing exactly."""
    if kind in _PLAIN_REGEX_KINDS:
        yield kind, value, None, None
    elif kind in ("staged_regex", "staged_not_regex"):
        filename, _, pattern = value.partition("::")
        yield f"{kind}.body", pattern, _decode_fn(filename), None
    elif kind == "staged_section_regex":
        parts = value.split("::")
        if len(parts) == 3:
            yield "staged_section_regex.body", parts[2], \
                _decode_fn(parts[0]), None
    elif kind in _EXACT_FN_PREFIX_KINDS:
        filename, _, _needle = value.partition("::")
        yield f"{kind}.file", None, _decode_fn(filename), None
    elif kind == "memory_has":
        # "field:regex" — profile-field regex (round-2 D5: these ARE
        # regexes and were previously never compiled).
        _field, _, pattern = value.partition(":")
        if pattern:
            yield "memory_has.regex", pattern, None, None
    elif kind == "staged_file":
        yield "staged_file", None, value, None
    elif kind == "staged_renders_clean":
        # the ONLY filename value compiled as a regex
        yield "staged_renders_clean", value, None, value
    elif kind == "tool_args":
        # "tool_name:key[:regex]" — regex optional.
        _, _, rest = value.partition(":")
        _, _, pattern = rest.partition(":")
        if pattern:
            yield "tool_args.regex", pattern, None, None
    elif kind == "tool_output_regex":
        _, _, pattern = value.partition("::")
        if pattern:
            yield "tool_output_regex.regex", pattern, None, None
    elif kind == "tool_output_not_regex":
        _, _, pattern = value.partition("::")
        if pattern:
            yield "tool_output_not_regex.regex", pattern, None, None


def test_staged_section_regex_values_have_three_parts():
    # A value with !=3 "::" parts silently makes the criterion dead
    # (criterion_ok returns False for every artifact) — round-2 D5.
    bad = []
    for builder, q in _all_questions():
        for kind, value in _pairs(q):
            if kind == "staged_section_regex" and len(value.split("::")) != 3:
                bad.append(f"{q.qid}: {value!r}")
    assert not bad, "staged_section_regex values without 3 '::' parts:\n" + \
        "\n".join(bad)


def test_every_regex_criterion_compiles_and_has_no_literal_backslash():
    bad_compile, quad_escape = [], []
    for builder, q in _all_questions():
        for kind, value in _pairs(q):
            for label, pattern, _fn, _fx in _regex_parts(kind, value):
                if pattern is None:
                    continue
                try:
                    re.compile(pattern)
                except re.error as exc:
                    bad_compile.append(f"{q.qid} [{label}] {pattern!r}: {exc}")
                # Direct class check: two CONSECUTIVE backslash chars in the
                # pattern = literal-backslash requirement.
                if "\\\\" in pattern:
                    quad_escape.append(f"{q.qid} [{label}] {pattern!r}")
    assert not bad_compile, "regex criteria that do not compile:\n" + \
        "\n".join(bad_compile)
    assert not quad_escape, ("regex criteria requiring a LITERAL backslash "
                             "(quad-escape family — can never match cfg "
                             "text):\n" + "\n".join(quad_escape))


def test_filename_targets_exist_in_the_questions_own_files():
    dead = []
    for builder, q in _all_questions():
        names = {n for (n, _label, _body) in (q.context_files or ())}
        all_src = tuple(q.criteria or ()) + tuple(q.edit_criteria or ())
        # A create-a-new-file question legitimately stages files that are
        # not in context_files; a wildcard staged_new_file ("" value) can
        # stage ANY name, so membership is simply unchecked there.
        new_file_kinds = [v for k, v in all_src
                          if k in ("staged_new_file",
                                   "staged_new_file_header")]
        if any(v == "" for v in new_file_kinds):
            continue
        allowed = names | {v.partition("::")[0]
                           for v in new_file_kinds if v}
        # A question that NAMES a new file in its prompt ("create
        # park_macros.cfg") legitimately stages that file — accept any
        # .cfg filename the prompt itself introduces (round-2 D5).
        allowed |= set(re.findall(r"[\w.-]+\.cfg", q.text or ""))
        for kind, value in _pairs(q):
            for label, _pattern, exact, fn_rx in _regex_parts(kind, value):
                if exact and "." in exact and allowed and exact not in allowed:
                    dead.append(f"{q.qid} [{label}] exact filename "
                                f"{exact!r} not among {sorted(allowed)}")
                if fn_rx:
                    try:
                        rx = re.compile(fn_rx, re.IGNORECASE)
                    except re.error:
                        continue  # reported by the compile test
                    if allowed and not any(rx.search(n) for n in allowed):
                        dead.append(f"{q.qid} [{label}] filename regex "
                                    f"{fn_rx!r} matches none of "
                                    f"{sorted(allowed)}")
    assert not dead, "criteria targeting files that the question never " \
        "ships (dead by construction — guaranteed FAIL):\n" + \
        "\n".join(dead)


def test_substring_criteria_carry_no_backslashes():
    bad = []
    for builder, q in _all_questions():
        for kind, value in _pairs(q):
            if kind in _SUBSTR_KINDS and "\\" in value:
                bad.append(f"{q.qid} [{kind}] {value!r}")
    assert not bad, "substring-kind values containing backslashes (regex " \
        "escaping does nothing here — silent never-match):\n" + \
        "\n".join(bad)


# ---------------------------------------------------------------------------
# staged_renders_clean semantics (plan 3.5): the grader runs the SHARED
# engine in DECLARED state (no invocation) — static defects FAIL,
# param-dependent reads PASS. Three-direction control.

def _staged(section_body: str):
    return [{"file": "printer.cfg",
             "newText": "[printer]\nkinematics: cartesian\nmax_velocity: 200\n"
                        "max_accel: 1000\n" + section_body}]


def _renders_clean(section_body: str) -> bool:
    return H.criterion_ok("staged_renders_clean", r"printer\.cfg", "",
                          pending_edits=_staged(section_body))


def test_renders_clean_passes_a_clean_macro():
    assert _renders_clean(
        "[gcode_macro FAN_HALF]\ngcode:\n    M106 S128\n")


def test_renders_clean_passes_param_dependent_reads():
    # No declared value, no invocation: an undeclared param read is
    # PARAM-DEPENDENT (info), never a verdict — the staged macro passes.
    assert _renders_clean(
        "[gcode_macro LEVEL_FAN]\ngcode:\n"
        "    {% if params.LEVEL is defined %}\n"
        "    M106 S{params.LEVEL}\n"
        "    {% else %}\n"
        "    M106 S128\n"
        "    {% endif %}\n")


def test_renders_clean_fails_static_empty_default():
    # The field-repro class: params_RED declared EMPTY rides EVERY
    # invocation — static ERROR, grader FAILs even without invocation.
    assert not _renders_clean(
        "[gcode_macro LIT]\nparams_RED:\ngcode:\n"
        "    SET_LED LED=strip RED={params.RED} GREEN=0 BLUE=0\n")


def test_renders_clean_fails_broken_template_syntax():
    assert not _renders_clean(
        "[gcode_macro BROKE]\ngcode:\n"
        "    {% if %}\n    M106 S1\n")


# ── tool_output_not_regex: the negative tool-output criterion is LIVE ────

def _sim_calls(output, name="simulate_macro"):
    return [{"name": name, "arguments": "{}", "output": output}]


def test_tool_output_not_regex_passes_a_clean_sim_output():
    ok = H.criterion_ok(
        "tool_output_not_regex", "simulate_macro::is not valid for", "",
        tool_calls=_sim_calls("Rendered (1 path(s)):\n  L3: M106 S255\n"
                              "Findings: none"))
    assert ok


def test_tool_output_not_regex_fails_the_r9_leg_b_artifact():
    # SET_FAN_SPEED FAN=fan against a project with no [fan_generic fan]:
    # the engine now reports Klipper's own run-time refusal, and THIS is
    # the criterion that must stop it counting as a pass.
    out = ("Rendered (1 path(s)):\n  L3: SET_FAN_SPEED FAN=fan SPEED=1.0\n"
           "Findings:\n  [warning] The value 'fan' is not valid for FAN. "
           "Did you mean 'aux_fan'?")
    assert not H.criterion_ok(
        "tool_output_not_regex", "simulate_macro::is not valid for", "",
        tool_calls=_sim_calls(out))


def test_tool_output_not_regex_requires_the_tool_to_have_run():
    # Silence from an uncalled tool is not a clean result.
    assert not H.criterion_ok(
        "tool_output_not_regex", "simulate_macro::is not valid for", "",
        tool_calls=[])


# ── F11: conditional passes must not exit 0 ──────────────────────────────

def test_exit_code_distinguishes_conditional_passes():
    assert H.exit_code_for([], [], []) == 0
    assert H.exit_code_for(["q"], [], []) == 2
    assert H.exit_code_for([], ["q"], []) == 2
    assert H.exit_code_for([], [], ["q"]) == 3
    # a hard failure outranks a conditional pass
    assert H.exit_code_for(["q"], [], ["q2"]) == 2
