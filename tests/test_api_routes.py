"""Tests for the main config editor API routes (api/routes.py).

Covers import/parse, validate, export, generate, examples, reference docs,
schema lookup, project persistence, config saving, and warning
acknowledgements — the core workflow endpoints the frontend uses.
"""
import sys
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import api.routes as routes  # noqa: E402
import api.ai_routes as ai_routes  # noqa: E402
from main import app  # noqa: E402


client = TestClient(app)

SIMPLE_CFG = """[printer]
kinematics: corexy
max_velocity: 500
max_accel: 5000

[mcu]
serial: /dev/serial/by-id/usb-klipper
"""

PROJECT_CFG = """[printer]
kinematics: corexy
max_velocity: 500
max_accel: 5000

[mcu]
serial: /dev/serial/by-id/usb-klipper

[include other.cfg]
"""

OTHER_CFG = """[extruder]
step_pin: PA0
heater_pin: PA1
sensor_pin: PA2
"""


def _section(section_type, params, full_header=None):
    return {
        "full_header": full_header or section_type,
        "section_type": section_type,
        "section_name": "",
        "line_number": 0,
        "params": [
            {
                "key": k,
                "value": v,
                "is_commented_out": False,
                "comment": "",
                "separator": ":",
            }
            for k, v in params.items()
        ],
        "header_comments": [],
        "trailing_comments": [],
        "is_commented_out": False,
    }


def _config_update(filename="printer.cfg", sections=None, includes=None, raw_text=None):
    return {
        "filename": filename,
        "sections": sections or [
            _section("printer", {
                "kinematics": "corexy",
                "max_velocity": "500",
                "max_accel": "5000",
            }),
            _section("mcu", {"serial": "/dev/serial/by-id/usb-klipper"}),
        ],
        "includes": includes or [],
        "header_comments": [],
        "raw_text": raw_text,
    }


# ── Import / Parse ──────────────────────────────────────────────────────


def test_import_single_cfg(monkeypatch, tmp_path):
    monkeypatch.setattr(routes, 'CONFIG_STORAGE_DIR', tmp_path)

    response = client.post(
        '/api/import',
        files={'file': ('printer.cfg', SIMPLE_CFG.encode(), 'text/plain')},
    )

    assert response.status_code == 200
    body = response.json()
    assert body['config']['filename'] == 'printer.cfg'
    section_types = {s['section_type'] for s in body['config']['sections']}
    assert 'printer' in section_types
    assert 'mcu' in section_types
    assert 'validation' in body
    assert 'board_info' in body
    # The imported file is persisted for MCP tool access.
    assert (tmp_path / 'printer.cfg').exists()


def test_import_project_multi_file(monkeypatch, tmp_path):
    monkeypatch.setattr(routes, 'CONFIG_STORAGE_DIR', tmp_path)

    response = client.post(
        '/api/import-project',
        files=[
            ('files', ('printer.cfg', PROJECT_CFG.encode(), 'text/plain')),
            ('files', ('other.cfg', OTHER_CFG.encode(), 'text/plain')),
        ],
    )

    assert response.status_code == 200
    body = response.json()
    assert set(body['files'].keys()) == {'printer.cfg', 'other.cfg'}
    assert body['project']['main_file'] == 'printer.cfg'
    assert body['project']['file_count'] == 2
    # Include in printer.cfg resolves to the imported other.cfg.
    assert body['project']['includes'] == [{
        'path': 'other.cfg',
        'resolved': True,
        'filename': 'other.cfg',
    }]
    # MCU discovered from printer.cfg.
    mcu_names = [m['name'] for m in body['project']['mcus']]
    assert mcu_names == ['']


def test_import_project_ignores_non_cfg(monkeypatch, tmp_path):
    monkeypatch.setattr(routes, 'CONFIG_STORAGE_DIR', tmp_path)

    response = client.post(
        '/api/import-project',
        files=[
            ('files', ('notes.txt', b'not a config', 'text/plain')),
            ('files', ('printer.cfg', SIMPLE_CFG.encode(), 'text/plain')),
        ],
    )

    assert response.status_code == 200
    assert set(response.json()['files'].keys()) == {'printer.cfg'}


def test_import_project_no_cfg_files(monkeypatch, tmp_path):
    monkeypatch.setattr(routes, 'CONFIG_STORAGE_DIR', tmp_path)

    response = client.post(
        '/api/import-project',
        files=[('files', ('notes.txt', b'not a config', 'text/plain'))],
    )

    assert response.status_code == 400
    assert response.json()['detail'] == 'No .cfg files found in upload'


def test_parse_text():
    response = client.post('/api/parse', json={'text': SIMPLE_CFG, 'filename': 'printer.cfg'})

    assert response.status_code == 200
    body = response.json()
    assert body['config']['filename'] == 'printer.cfg'
    assert body['config']['sections'][0]['section_type'] == 'printer'
    assert 'validation' in body


# ── Validate ────────────────────────────────────────────────────────────


def test_validate_config():
    response = client.post('/api/validate', json=_config_update())

    assert response.status_code == 200
    body = response.json()
    assert isinstance(body, dict)
    assert 'errors' in body or 'warnings' in body or 'sections' in body


def test_validate_project():
    response = client.post('/api/validate-project', json={
        'config_files': [
            _config_update(),
            _config_update(filename='other.cfg', sections=[
                _section('extruder', {
                    'step_pin': 'PA0',
                    'heater_pin': 'PA1',
                    'sensor_pin': 'PA2',
                }),
            ]),
        ],
    })

    assert response.status_code == 200
    body = response.json()
    assert set(body['files'].keys()) == {'printer.cfg', 'other.cfg'}


# ── Export ──────────────────────────────────────────────────────────────


def test_export_config_returns_cfg_text():
    response = client.post('/api/export', json=_config_update(raw_text=SIMPLE_CFG))

    assert response.status_code == 200
    assert response.headers['content-type'].startswith('text/plain')
    assert '[printer]' in response.text
    assert 'kinematics: corexy' in response.text
    assert '[mcu]' in response.text


def test_export_project_returns_files():
    response = client.post('/api/export-project', json={
        'project': {
            'name': 'test-project',
            'config_files': [
                _config_update(raw_text=SIMPLE_CFG),
                _config_update(filename='other.cfg', sections=[
                    _section('extruder', {
                        'step_pin': 'PA0',
                        'heater_pin': 'PA1',
                        'sensor_pin': 'PA2',
                    }),
                ], raw_text=OTHER_CFG),
            ],
            'graph_layout': {'nodes': [], 'edges': []},
        },
    })

    assert response.status_code == 200
    body = response.json()
    assert set(body['files'].keys()) == {'printer.cfg', 'other.cfg'}
    assert '[extruder]' in body['files']['other.cfg']


# ── Generate ────────────────────────────────────────────────────────────


def test_generate_blank_corexy():
    response = client.post('/api/generate', json={'template': None, 'kinematics': 'corexy'})

    assert response.status_code == 200
    body = response.json()
    section_types = {s['section_type'] for s in body['config']['sections']}
    assert 'printer' in section_types
    assert 'mcu' in section_types
    assert 'extruder' in section_types
    printer = next(s for s in body['config']['sections'] if s['section_type'] == 'printer')
    assert any(p['key'] == 'kinematics' and p['value'] == 'corexy' for p in printer['params'])


def test_generate_from_template(monkeypatch):
    # Reference examples are bundled and tracked in git.
    response = client.post('/api/generate', json={
        'template': 'generic-bigtreetech-manta-m4p.cfg',
        'kinematics': 'cartesian',
    })

    assert response.status_code == 200
    body = response.json()
    assert body['config']['filename'] == 'printer.cfg'
    assert len(body['config']['sections']) > 0


def test_generate_template_not_found():
    response = client.post('/api/generate', json={'template': 'does-not-exist.cfg'})

    assert response.status_code == 404


# ── Examples ────────────────────────────────────────────────────────────


def test_list_examples():
    response = client.get('/api/examples')

    assert response.status_code == 200
    body = response.json()
    assert isinstance(body['examples'], list)
    assert len(body['examples']) > 0
    assert 'filename' in body['examples'][0]


def test_search_examples_with_query():
    response = client.get('/api/examples/search', params={'q': 'manta'})

    assert response.status_code == 200
    body = response.json()
    assert isinstance(body['results'], list)
    assert all('manta' in ex['name'].lower() for ex in body['results'])


def test_get_example_by_filename():
    response = client.get('/api/examples/generic-bigtreetech-manta-m4p.cfg')

    assert response.status_code == 200
    body = response.json()
    assert body['config']['filename'] == 'generic-bigtreetech-manta-m4p.cfg'
    assert body['raw_text'].strip()


def test_get_example_rejects_path_traversal():
    # Encoded slashes are rejected by the framework before the route (404);
    # the route's own guard catches any filename containing "..".
    response = client.get('/api/examples/foo..bar.cfg')

    assert response.status_code == 400
    assert response.json()['detail'] == 'Invalid filename'


def test_get_example_not_found():
    response = client.get('/api/examples/nope.cfg')

    assert response.status_code == 404


# ── Reference docs ──────────────────────────────────────────────────────


def test_get_config_reference():
    response = client.get('/api/reference/config-reference')

    assert response.status_code == 200
    assert '# ' in response.json()['content']


def test_get_klipper_doc():
    response = client.get('/api/reference/klipper-docs/Bed_Mesh.md')

    assert response.status_code == 200
    body = response.json()
    assert body['filename'] == 'Bed_Mesh.md'
    assert body['content'].startswith('# Bed Mesh')


def test_get_klipper_doc_rejects_bad_filename():
    # Non-.md filenames are rejected by the route's guard.
    response = client.get('/api/reference/klipper-docs/printer.cfg')

    assert response.status_code == 400
    assert response.json()['detail'] == 'Invalid doc filename'


def test_get_klipper_doc_not_found():
    response = client.get('/api/reference/klipper-docs/Nope.md')

    assert response.status_code == 404


# ── Schema ──────────────────────────────────────────────────────────────


def test_get_all_schemas():
    response = client.get('/api/schema')

    assert response.status_code == 200
    schemas = response.json()['schemas']
    assert 'printer' in schemas
    assert 'mcu' in schemas
    assert 'extruder' in schemas
    assert 'section_type' in schemas['printer']
    assert 'params' in schemas['printer']


def test_get_section_schema():
    response = client.get('/api/schema/extruder')

    assert response.status_code == 200
    body = response.json()
    assert body['section_type'] == 'extruder'
    assert any(p['name'] == 'heater_pin' for p in body['params'])


def test_get_section_schema_unknown():
    response = client.get('/api/schema/not_a_real_section')

    assert response.status_code == 404


# ── Projects ────────────────────────────────────────────────────────────


def test_save_and_list_and_load_project(monkeypatch, tmp_path):
    monkeypatch.setattr(routes, 'PROJECTS_DIR', tmp_path)

    save_resp = client.post('/api/projects/save', json={
        'name': 'My Test Project',
        'config_files': [_config_update()],
        'graph_layout': {
            'nodes': [{
                'id': 'n1',
                'type': 'hardware',
                'component_type': 'mainboard',
                'section_header': 'mcu',
                'label': 'Spider',
            }],
            'edges': [],
        },
    })

    assert save_resp.status_code == 200
    assert save_resp.json() == {'status': 'saved', 'name': 'My Test Project'}

    list_resp = client.get('/api/projects')
    assert list_resp.status_code == 200
    assert list_resp.json()['projects'] == [{
        'name': 'My Test Project',
        'files': ['printer.cfg'],
        'has_layout': True,
    }]

    load_resp = client.get('/api/projects/My%20Test%20Project')
    assert load_resp.status_code == 200
    body = load_resp.json()
    assert body['name'] == 'My Test Project'
    assert 'printer.cfg' in body['configs']
    assert body['layout'] is not None
    assert body['layout']['nodes'][0]['id'] == 'n1'


def test_save_project_invalid_name(monkeypatch, tmp_path):
    monkeypatch.setattr(routes, 'PROJECTS_DIR', tmp_path)

    response = client.post('/api/projects/save', json={
        'name': '!!!',
        'config_files': [],
        'graph_layout': {'nodes': [], 'edges': []},
    })

    assert response.status_code == 400
    assert response.json()['detail'] == 'Invalid project name'


def test_load_project_not_found(monkeypatch, tmp_path):
    monkeypatch.setattr(routes, 'PROJECTS_DIR', tmp_path)

    response = client.get('/api/projects/Missing')

    assert response.status_code == 404
    assert response.json()['detail'] == 'Project not found'


# ── Config saving / loading ─────────────────────────────────────────────


def test_save_configs(monkeypatch, tmp_path):
    monkeypatch.setattr(routes, 'CONFIG_STORAGE_DIR', tmp_path)

    response = client.post('/api/configs/save', json={
        'files': {
            'printer.cfg': SIMPLE_CFG,
            'other.cfg': OTHER_CFG,
        },
    })

    assert response.status_code == 200
    assert response.json() == {'saved': ['printer.cfg', 'other.cfg'], 'file_count': 2}
    assert (tmp_path / 'printer.cfg').exists()
    assert (tmp_path / 'other.cfg').exists()


def test_save_configs_rejects_path_traversal(monkeypatch, tmp_path):
    monkeypatch.setattr(routes, 'CONFIG_STORAGE_DIR', tmp_path)

    response = client.post('/api/configs/save', json={
        'files': {
            '../../evil.cfg': SIMPLE_CFG,
            'good.cfg': SIMPLE_CFG,
        },
    })

    assert response.status_code == 200
    assert response.json()['saved'] == ['good.cfg']
    assert 'Invalid filename: ../../evil.cfg' in response.json()['errors']


def test_save_configs_no_files():
    response = client.post('/api/configs/save', json={'files': {}})

    assert response.status_code == 400
    assert response.json()['detail'] == 'No files provided'


def test_load_saved_configs_empty(monkeypatch, tmp_path):
    monkeypatch.setattr(routes, 'CONFIG_STORAGE_DIR', tmp_path)

    response = client.get('/api/project/load-saved')

    assert response.status_code == 200
    body = response.json()
    assert body['files'] == {}
    assert body['file_count'] == 0


def test_load_saved_configs_with_files(monkeypatch, tmp_path):
    monkeypatch.setattr(routes, 'CONFIG_STORAGE_DIR', tmp_path)
    (tmp_path / 'printer.cfg').write_text(PROJECT_CFG, encoding='utf-8')
    (tmp_path / 'other.cfg').write_text(OTHER_CFG, encoding='utf-8')

    response = client.get('/api/project/load-saved')

    assert response.status_code == 200
    body = response.json()
    assert body['main_file'] == 'printer.cfg'
    assert body['file_count'] == 2
    assert set(body['files'].keys()) == {'printer.cfg', 'other.cfg'}


# ── Warning acknowledgements ────────────────────────────────────────────


def test_acknowledge_warning(monkeypatch, tmp_path):
    monkeypatch.setenv('KWC_LAYOUT_DIR', str(tmp_path))

    response = client.post('/api/warning-acknowledgements', json={
        'section': _section('my_plugin_section', {'some_param': '1'}),
    })

    assert response.status_code == 200
    body = response.json()
    assert body['status'] == 'acknowledged'
    assert Path(body['file']).name == 'acknowledged_warnings.cfg'
    ack_file = tmp_path / 'acknowledged_warnings.cfg'
    assert ack_file.exists()
    assert '[my_plugin_section]' in ack_file.read_text(encoding='utf-8')


# ── Tool advertisement (_build_mcp_tool_context) ─────────────────────────


def test_tool_context_advertises_exposed_tools():
    ctx = ai_routes._build_mcp_tool_context()
    for tool in (
        "list_klipper_docs",
        "search_user_configs",
        "list_user_configs",
        "generate_macro_template",
    ):
        assert f"- {tool}:" in ctx, f"{tool} should be advertised"


def test_tool_context_hides_detect_board_by_default():
    ctx = ai_routes._build_mcp_tool_context()
    assert "- detect_board:" not in ctx


def test_tool_context_extra_tools_adds_detect_board():
    ctx = ai_routes._build_mcp_tool_context(extra_tools=["detect_board"])
    assert "- detect_board:" in ctx
