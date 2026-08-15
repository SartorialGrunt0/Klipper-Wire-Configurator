import sys
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import api.native_routes as native_routes  # noqa: E402
from main import app  # noqa: E402


client = TestClient(app)


def test_native_apply_deletes_removed_files(monkeypatch, tmp_path):
    """Deleting a file in the model must remove it from the Pi config dir."""
    monkeypatch.setattr(native_routes, 'is_native_platform', lambda: True)
    monkeypatch.setattr(native_routes, 'load_settings', lambda: {})
    monkeypatch.setattr(native_routes, 'get_default_config_path', lambda: str(tmp_path))
    (tmp_path / 'printer.cfg').write_text('[printer]\nkinematics: cartesian\n', encoding='utf-8')
    (tmp_path / 'toolhead_board.cfg').write_text('[mcu toolhead]\nserial: /dev/serial/by-id/x\n', encoding='utf-8')

    response = client.post('/api/native/apply', json={
        'files': {'printer.cfg': '[printer]\nkinematics: cartesian\n'},
        'deleted': ['toolhead_board.cfg'],
    })

    assert response.status_code == 200
    body = response.json()
    assert body['files'] == ['printer.cfg']
    assert body['removed'] == ['toolhead_board.cfg']
    assert (tmp_path / 'printer.cfg').exists()
    assert not (tmp_path / 'toolhead_board.cfg').exists()


def test_native_apply_rejects_traversal_in_deleted(monkeypatch, tmp_path):
    monkeypatch.setattr(native_routes, 'is_native_platform', lambda: True)
    monkeypatch.setattr(native_routes, 'load_settings', lambda: {})
    monkeypatch.setattr(native_routes, 'get_default_config_path', lambda: str(tmp_path))

    response = client.post('/api/native/apply', json={
        'files': {'printer.cfg': '[printer]\nkinematics: cartesian\n'},
        'deleted': ['../evil.cfg'],
    })

    assert response.status_code == 400
    assert not (tmp_path.parent / 'evil.cfg').exists()


def test_klipper_firmware_state_returns_service_payload(monkeypatch):
    payload = {
        'available': True,
        'error': None,
        'klipper_path': '/home/pi/klipper',
        'config_path': '/home/pi/klipper/.config',
        'out_path': '/home/pi/klipper/out',
        'config_exists': True,
        'fields': [],
        'artifacts': [],
        'primary_artifact': None,
    }

    monkeypatch.setattr(native_routes, 'is_native_platform', lambda: True)
    monkeypatch.setattr(native_routes, 'get_klipper_firmware_state', lambda klipper_path=None: payload)

    response = client.get('/api/native/firmware')

    assert response.status_code == 200
    assert response.json() == payload


def test_update_klipper_firmware_config_forwards_assignments(monkeypatch):
    captured = {}

    def fake_save(assignments, klipper_path=None):
        captured['assignments'] = assignments
        captured['klipper_path'] = klipper_path
        return {'available': True, 'error': None, 'fields': []}

    monkeypatch.setattr(native_routes, 'is_native_platform', lambda: True)
    monkeypatch.setattr(native_routes, 'save_klipper_menuconfig', fake_save)

    response = client.put(
        '/api/native/firmware',
        json={
            'klipper_path': '/home/pi/klipper',
            'assignments': [{'symbol': 'LOW_LEVEL_OPTIONS', 'value': 'y'}],
        },
    )

    assert response.status_code == 200
    assert captured == {
        'assignments': [('LOW_LEVEL_OPTIONS', 'y')],
        'klipper_path': '/home/pi/klipper',
    }


def test_build_klipper_firmware_route_returns_service_result(monkeypatch):
    payload = {
        'success': False,
        'error': 'build failed',
        'log': '$ make',
        'klipper_path': '/home/pi/klipper',
        'out_path': '/home/pi/klipper/out',
        'artifacts': [],
        'primary_artifact': None,
    }

    monkeypatch.setattr(native_routes, 'is_native_platform', lambda: True)
    monkeypatch.setattr(native_routes, 'build_klipper_firmware', lambda klipper_path=None: payload)

    response = client.post('/api/native/firmware/build', json={'klipper_path': '/home/pi/klipper'})

    assert response.status_code == 200
    assert response.json() == payload


def test_klippy_log_excerpt_route_returns_service_result(monkeypatch):
    payload = {
        'status': 'ok',
        'log_path': '/home/pi/printer_data/logs/klippy.log',
        'excerpt': 'Config error\nTraceback...',
        'matched_on': 'mcu ebbcan',
    }

    monkeypatch.setattr(native_routes, 'is_native_platform', lambda: True)
    monkeypatch.setattr(native_routes, 'get_klippy_log_excerpt', lambda section_name=None, error_text=None, context_lines=40: payload)

    response = client.post(
        '/api/native/klipper/log-excerpt',
        json={
            'section_name': 'mcu ebbcan',
            'error_text': "Option 'baud' is not valid in section 'mcu ebbcan'",
            'context_lines': 20,
        },
    )

    assert response.status_code == 200
    assert response.json() == payload
