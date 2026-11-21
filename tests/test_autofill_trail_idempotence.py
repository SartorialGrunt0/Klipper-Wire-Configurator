"""S3b/C — blank-memory auto-fill rides the trailing seam.

Law (cache plan 2026-11-20 / Sir's ruling 2026-11-21, option C + A):

The auto-fill block carries keystroke-derived facts (derive_machine_facts /
derived hardware inventory) computed from the drafts the client sends. In the
system HEAD those bytes sit at offset ~0 of the provider's prefix cache: any
config edit between turns rewrites the head and busts the whole transcript.

C — move it to the trailing seam (same content, same every-turn recurrence,
      head becomes independent of printer-memory state and of draft content).
A — keep the pinning-marker idempotence guard: a trail that already carries
      the block gets no second copy.

Main's salience order is preserved by placing it AHEAD of the task anchor.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import api.ai_routes as ai_routes  # noqa: E402
from api.printer_memory_routes import PrinterMemory  # noqa: E402

AUTOFILL_HEADER = '**Printer Memory Auto-Fill**'


def _blank_memory(monkeypatch):
    monkeypatch.setattr(ai_routes, 'load_printer_memory', lambda: PrinterMemory())


def _filled_memory(monkeypatch):
    monkeypatch.setattr(ai_routes, 'load_printer_memory',
                        lambda: PrinterMemory(mainboard='BTT Octopus Pro v1.1'))


def _head(prepared):
    systems = [m for m in prepared if m['role'] == 'system']
    assert systems, 'prepared payload has no system head'
    return systems[0]['content']


def _autofill_msgs(prepared):
    return [m for m in prepared
            if m['role'] == 'system' and AUTOFILL_HEADER in str(m['content'])]


# ── C: the block is OUT of the head ─────────────────────────────────────


def test_autofill_is_not_in_the_system_head(monkeypatch):
    _blank_memory(monkeypatch)
    prepared = ai_routes._prepare_messages([{'role': 'user', 'content': 'hi'}])
    assert AUTOFILL_HEADER not in _head(prepared)


def test_autofill_still_reaches_the_model_every_turn(monkeypatch):
    """Option C keeps main's behaviour: the block is present on turn 1 and
    on a much later turn — it is a seam rider, not a one-shot."""
    _blank_memory(monkeypatch)
    turn1 = ai_routes._prepare_messages([{'role': 'user', 'content': 'hi'}])
    turn4 = ai_routes._prepare_messages([
        {'role': 'user', 'content': 'hi'},
        {'role': 'assistant', 'content': 'hello'},
        {'role': 'user', 'content': 'q2'},
        {'role': 'assistant', 'content': 'a2'},
        {'role': 'user', 'content': 'q3'},
        {'role': 'assistant', 'content': 'a3'},
        {'role': 'user', 'content': 'q4'},
    ])
    assert len(_autofill_msgs(turn1)) == 1
    assert len(_autofill_msgs(turn4)) == 1


def test_autofill_rides_after_the_transcript(monkeypatch):
    """It must sit AFTER the last user message, never before it."""
    _blank_memory(monkeypatch)
    prepared = ai_routes._prepare_messages([
        {'role': 'user', 'content': 'q1'},
        {'role': 'assistant', 'content': 'a1'},
        {'role': 'user', 'content': 'q2'},
    ])
    idx_autofill = next(i for i, m in enumerate(prepared)
                        if AUTOFILL_HEADER in str(m['content']))
    idx_last_user = max(i for i, m in enumerate(prepared) if m['role'] == 'user')
    assert idx_autofill > idx_last_user


def test_autofill_precedes_the_task_anchor(monkeypatch):
    """Main's salience order (anchor speaks last) is preserved."""
    _blank_memory(monkeypatch)
    prepared = ai_routes._prepare_messages([{'role': 'user', 'content': 'hi'}])
    idx_autofill = next(i for i, m in enumerate(prepared)
                        if AUTOFILL_HEADER in str(m['content']))
    idx_anchor = next(i for i, m in enumerate(prepared)
                      if 'latest (last) message' in str(m['content']))
    assert idx_autofill < idx_anchor


# ── The cache law: head is blind to memory state and draft content ──────


def test_head_is_blind_to_the_autofill_block(monkeypatch):
    """The prefix cache's first-appearance region must not carry the block in
    either memory state — only the (stable) memory context itself may differ."""
    trail = [{'role': 'user', 'content': 'hi'}]

    _blank_memory(monkeypatch)
    blank_prepared = ai_routes._prepare_messages(trail)
    assert AUTOFILL_HEADER not in _head(blank_prepared)
    assert len(_autofill_msgs(blank_prepared)) == 1

    _filled_memory(monkeypatch)
    filled_prepared = ai_routes._prepare_messages(trail)
    assert AUTOFILL_HEADER not in _head(filled_prepared)
    assert _autofill_msgs(filled_prepared) == []


def test_head_is_byte_identical_when_the_drafts_change(monkeypatch):
    """Editing a config mid-conversation changes the derived facts. In the
    head that busted the whole prefix; on the seam it must not touch the
    head at all."""
    _blank_memory(monkeypatch)
    trail = [{'role': 'user', 'content': 'q1'}]
    drafts_a = {'printer.cfg': {'content': '[stepper_x]\nrotation_distance: 40\n'}}
    drafts_b = {'printer.cfg': {'content': '[stepper_x]\nrotation_distance: 32\n'}}

    head_a = _head(ai_routes._prepare_messages(trail, context_files=drafts_a))
    head_b = _head(ai_routes._prepare_messages(trail, context_files=drafts_b))

    assert head_a == head_b


def test_seam_carries_the_derived_facts(monkeypatch):
    """C moves the block; it must not lose the derived facts."""
    _blank_memory(monkeypatch)
    drafts = {'printer.cfg': {'content':
        '[printer]\nkinematics: corexy\n'
        '[stepper_x]\nposition_max: 250\nposition_endstop: 0\n\n'
        '[stepper_y]\nposition_max: 250\n'
        '[stepper_z]\nposition_max: 210\n'}}
    prepared = ai_routes._prepare_messages(
        [{'role': 'user', 'content': 'hi'}], context_files=drafts)
    block = _autofill_msgs(prepared)[0]['content']
    assert 'DERIVED MACHINE FACTS' in block


# ── A: idempotence guard still holds ────────────────────────────────────


def test_no_second_copy_when_the_trail_carries_the_block(monkeypatch):
    _blank_memory(monkeypatch)
    trail = [
        {'role': 'assistant', 'content': AUTOFILL_HEADER + '\n\nHere is the block...'},
        {'role': 'user', 'content': 'Now explain pressure advance.'},
    ]
    prepared = ai_routes._prepare_messages(trail)
    assert _autofill_msgs(prepared) == []


def test_marker_match_is_the_exact_header(monkeypatch):
    """Loose prose about auto-fill must NOT suppress the block."""
    _blank_memory(monkeypatch)
    trail = [
        {'role': 'user', 'content': 'Can you auto fill my printer memory some day?'},
        {'role': 'user', 'content': 'Explain pressure advance.'},
    ]
    prepared = ai_routes._prepare_messages(trail)
    assert len(_autofill_msgs(prepared)) == 1


# ── Placement must not resurrect the directive-burial bug (C2 law) ──────


def test_autofill_never_lands_after_a_mid_loop_directive(monkeypatch):
    """C2's law: re-prompt directives appended after the prepared seam stay
    the LAST message. The seam shaper must not slide the autofill behind
    them (they are appended by the route, after _prepare_messages)."""
    _blank_memory(monkeypatch)
    prepared = ai_routes._prepare_messages([{'role': 'user', 'content': 'hi'}])
    directive = {'role': 'user', 'content': 'ACK GUARD DIRECTIVE'}
    sent = prepared + [directive]

    reshape = getattr(ai_routes, '_reshape_for_template_fallback', None)
    reshaped = reshape({'messages': sent}, 'tail_user')['messages'] if reshape else sent

    assert reshaped[-1] == directive


# ── Ablation instruments never carry the block ──────────────────────────


@pytest.mark.parametrize('gate', ['KWC_MINIMAL_PROMPT', 'KWC_NO_SYSTEM'])
def test_ablation_gates_suppress_the_autofill(monkeypatch, gate):
    _blank_memory(monkeypatch)
    monkeypatch.setenv(gate, '1')
    prepared = ai_routes._prepare_messages([{'role': 'user', 'content': 'hi'}])
    assert _autofill_msgs(prepared) == []
