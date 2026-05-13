import sys
from pathlib import Path
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import api.native_routes as native_routes  # noqa: E402
from main import app  # noqa: E402


client = TestClient(app)


def test_preview_flash_target_route_forwards_assignments(monkeypatch):
    captured = {}

    def fake_preview(target, assignments, checkout_path=None):
        captured['target'] = target
        captured['assignments'] = assignments
        captured['checkout_path'] = checkout_path
        return {'target': target, 'available': True, 'fields': []}

    monkeypatch.setattr(native_routes, 'is_native_platform', lambda: True)
    monkeypatch.setattr(native_routes, 'preview_flash_target_config', fake_preview)

    response = client.post(
        '/api/native/flash/klipper/preview',
        json={
            'checkout_path': '/home/pi/klipper',
            'assignments': [{'symbol': 'LOW_LEVEL_OPTIONS', 'value': 'y'}],
        },
    )

    assert response.status_code == 200
    assert response.json()['target'] == 'klipper'
    assert captured == {
        'target': 'klipper',
        'assignments': [('LOW_LEVEL_OPTIONS', 'y')],
        'checkout_path': '/home/pi/klipper',
    }


def test_flash_target_route_forwards_device(monkeypatch):
    captured = {}

    def fake_flash(target, checkout_path=None, flash_device=None):
        captured['target'] = target
        captured['checkout_path'] = checkout_path
        captured['flash_device'] = flash_device
        return {
            'target': target,
            'success': True,
            'error': None,
            'log': '$ make flash',
            'checkout_path': checkout_path,
            'out_path': f'{checkout_path}/out',
            'artifacts': [],
            'primary_artifact': None,
            'flash_device': flash_device,
        }

    monkeypatch.setattr(native_routes, 'is_native_platform', lambda: True)
    monkeypatch.setattr(native_routes, 'flash_flash_target', fake_flash)

    response = client.post(
        '/api/native/flash/katapult/flash',
        json={
            'checkout_path': '/home/pi/katapult',
            'flash_device': '0483:df11',
        },
    )

    assert response.status_code == 200
    assert response.json()['success'] is True
    assert captured == {
        'target': 'katapult',
        'checkout_path': '/home/pi/katapult',
        'flash_device': '0483:df11',
    }
