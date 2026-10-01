"""Tests for the G-code command registry endpoint (/api/gcode-commands).

The endpoint feeds editor completion from the SAME registry the validator's
command scan uses, so a completion can never suggest a command that then fails
validation. These tests pin the contract the frontend depends on.
"""
import sys
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from main import app  # noqa: E402
from api import routes  # noqa: E402

client = TestClient(app)


def payload():
    res = client.get('/api/gcode-commands')
    assert res.status_code == 200, res.text
    return res.json()


def test_route_is_mounted_under_the_api_prefix():
    # The app serves an SPA catch-all, so an un-prefixed path returns the shell
    # rather than 404. What matters is that the JSON lives under /api and the
    # un-prefixed path is not the endpoint.
    api = client.get('/api/gcode-commands')
    assert api.status_code == 200
    assert api.headers['content-type'].startswith('application/json')
    shell = client.get('/gcode-commands')
    assert shell.headers['content-type'].startswith('text/html')


def test_payload_shape():
    body = payload()
    assert set(body) == {'source_rev', 'commands'}
    assert isinstance(body['commands'], dict)
    assert body['commands'], 'registry must not be empty'
    assert body['source_rev']


def test_command_names_are_upper_case_tokens():
    for name in payload()['commands']:
        assert name == name.upper()
        assert ' ' not in name


def test_common_commands_are_present():
    commands = payload()['commands']
    for name in ('G28', 'G1', 'M104', 'M109', 'SET_PIN', 'BED_MESH_CALIBRATE'):
        assert name in commands, name


def test_gating_is_preserved():
    # G3 only works with [gcode_arcs] loaded — the frontend shows this as the
    # completion's detail line.
    g3 = payload()['commands']['G3']
    assert g3['requires_sections'] == ['gcode_arcs']
    assert g3['requires_mode'] == 'any'
    assert g3['extra'] == 'gcode_arcs'


def test_ungated_commands_have_empty_requirements():
    g28 = payload()['commands']['G28']
    assert g28['requires_sections'] == []
    assert g28['requires_flags'] == {}


def test_flag_gated_commands_carry_requires_flags():
    # FORCE_MOVE only registers inside `[force_move] enable_force_move`.
    force_move = payload()['commands'].get('FORCE_MOVE')
    assert force_move is not None
    assert force_move['requires_flags'] == {'force_move': 'enable_force_move'}


def test_every_entry_has_the_full_shape():
    for name, entry in payload()['commands'].items():
        assert set(entry) == {
            'requires_sections',
            'requires_mode',
            'requires_flags',
            'extra',
            'simulated',
        }, name
        assert isinstance(entry['requires_sections'], list)
        assert isinstance(entry['simulated'], bool)


def test_payload_is_built_once_per_process():
    routes._gcode_commands_payload = None
    first = payload()
    cached = routes._gcode_commands_payload
    second = payload()
    assert routes._gcode_commands_payload is cached
    assert first == second
