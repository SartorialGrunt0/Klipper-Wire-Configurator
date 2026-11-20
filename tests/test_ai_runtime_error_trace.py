"""W3 — trailing runtime-error observation at the chat seam.

When the latest user message quotes a Klipper runtime error
(``Error on '<command>': ...`` — the frame carries the RENDERED command,
klippy/gcode.py get()), the harness deterministically traces the frame
through the project's macros (staged files first, then the disk mirror —
Cliff's scope ruling 2026-11-13) and injects one trailing system
observation naming the source provenance.

Intent-law clean: literal-text frame extraction + render matching, runs
unconditionally, can only attach a useless note — never reroutes the
task, never parses prose for intent. Silence is the default: no frame,
no match, ablation gates, or no project files → zero added messages.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import api.ai_routes as ai_routes  # noqa: E402

TRACE_MACRO = """\
[printer]
kinematics: cartesian

[gcode_macro BLINK]
description: blink
gcode:
    SET_LED LED=c RED={params.RED|default("")}
"""

OTHER_MACRO = """\
[gcode_macro WIGGLE]
description: wiggle
gcode:
    SET_LED LED=c RED={params.RED|default("")}
"""

UNRELATED = """\
[printer]
kinematics: cartesian

[gcode_macro PARK]
gcode:
    G90
"""

ERROR_MSG = ("I ran the blink and Klipper died:\n"
             "Transitioning to shutdown:\n"
             "Error on 'SET_LED LED=c RED=': unable to parse\n")


def _prep(monkeypatch, messages, context_files, mirror=None, env=None):
    from api.printer_memory_routes import PrinterMemory
    monkeypatch.delenv('KWC_MINIMAL_PROMPT', raising=False)
    monkeypatch.delenv('KWC_NO_SYSTEM', raising=False)
    if env:
        monkeypatch.setenv(env, '1')
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())
    monkeypatch.setattr(ai_routes, '_mirror_user_config_files',
                        mirror or (lambda: {}))
    return ai_routes._prepare_messages(messages, context_files=context_files)


def _system_texts(prepared):
    return [m['content'] for m in prepared if m['role'] == 'system']


def test_error_quoted_and_matched_injects_trailing_observation(monkeypatch):
    prepared = _prep(monkeypatch, [{'role': 'user', 'content': ERROR_MSG}],
                     {'printer.cfg': {'content': TRACE_MACRO}})
    obs = [t for t in _system_texts(prepared) if 'Runtime error trace' in t]
    assert len(obs) == 1
    assert '[gcode_macro BLINK]' in obs[0]
    assert 'body line 1' in obs[0]
    # provenance quotes the SOURCE line, not the frame
    assert 'params.RED' in obs[0]
    # trailing placement: last system message rides after everything else
    assert prepared[-1]['role'] == 'system'
    assert 'Runtime error trace' in prepared[-1]['content']


def test_no_error_quote_adds_nothing(monkeypatch):
    prepared = _prep(monkeypatch,
                     [{'role': 'user', 'content': 'why are my leds blue?'}],
                     {'printer.cfg': {'content': TRACE_MACRO}})
    assert not [t for t in _system_texts(prepared)
                if 'Runtime error trace' in t]


def test_frame_without_project_match_stays_silent(monkeypatch):
    prepared = _prep(monkeypatch, [{'role': 'user', 'content': ERROR_MSG}],
                     {'printer.cfg': {'content': UNRELATED}})
    assert not [t for t in _system_texts(prepared)
                if 'Runtime error trace' in t]


def test_ambiguous_matches_are_all_listed_not_resolved(monkeypatch):
    prepared = _prep(monkeypatch, [{'role': 'user', 'content': ERROR_MSG}],
                     {'printer.cfg': {'content': TRACE_MACRO},
                      'macros.cfg': {'content': OTHER_MACRO}})
    obs = [t for t in _system_texts(prepared) if 'Runtime error trace' in t]
    assert len(obs) == 1
    assert '[gcode_macro BLINK]' in obs[0]
    assert '[gcode_macro WIGGLE]' in obs[0]
    # honesty law: the observation says the source is among them
    assert 'among' in obs[0]


def test_staged_file_shadows_the_mirror_and_mirror_fills_the_rest(monkeypatch):
    mirror = lambda: {
        # same name as the staged file, DIFFERENT macro — must not be searched
        'printer.cfg': {'content': OTHER_MACRO},
        'lights.cfg': {'content': OTHER_MACRO.replace('WIGGLE', 'MOONLIGHT')},
    }
    prepared = _prep(monkeypatch, [{'role': 'user', 'content': ERROR_MSG}],
                     {'printer.cfg': {'content': UNRELATED}}, mirror=mirror)
    obs = [t for t in _system_texts(prepared) if 'Runtime error trace' in t]
    assert len(obs) == 1
    assert '[gcode_macro MOONLIGHT]' in obs[0]      # mirror file searched
    assert '[gcode_macro WIGGLE]' not in obs[0]     # shadowed mirror skipped


def test_mirror_failure_degrades_to_staged_only(monkeypatch):
    def boom():
        raise RuntimeError('config dir unreadable')
    prepared = _prep(monkeypatch, [{'role': 'user', 'content': ERROR_MSG}],
                     {'printer.cfg': {'content': TRACE_MACRO}}, mirror=boom)
    obs = [t for t in _system_texts(prepared) if 'Runtime error trace' in t]
    assert len(obs) == 1 and '[gcode_macro BLINK]' in obs[0]


@pytest.mark.parametrize("env", ["KWC_MINIMAL_PROMPT", "KWC_NO_SYSTEM"])
def test_ablation_gates_never_get_the_observation(monkeypatch, env):
    prepared = _prep(monkeypatch, [{'role': 'user', 'content': ERROR_MSG}],
                     {'printer.cfg': {'content': TRACE_MACRO}}, env=env)
    assert not [t for t in _system_texts(prepared)
                if 'Runtime error trace' in t]
