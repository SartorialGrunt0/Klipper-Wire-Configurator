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

    def fake_flash(target, checkout_path=None, flash_device=None, flash_method=None):
        captured['target'] = target
        captured['checkout_path'] = checkout_path
        captured['flash_device'] = flash_device
        captured['flash_method'] = flash_method
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
            'flash_method': flash_method,
        }

    monkeypatch.setattr(native_routes, 'is_native_platform', lambda: True)
    monkeypatch.setattr(native_routes, 'flash_flash_target', fake_flash)

    response = client.post(
        '/api/native/flash/katapult/flash',
        json={
            'checkout_path': '/home/pi/katapult',
            'flash_device': '0483:df11',
            'flash_method': 'dfu_util',
        },
    )

    assert response.status_code == 200
    assert response.json()['success'] is True
    assert captured == {
        'target': 'katapult',
        'checkout_path': '/home/pi/katapult',
        'flash_device': '0483:df11',
        'flash_method': 'dfu_util',
    }


def test_list_flash_profiles_route_returns_profiles(monkeypatch):
    monkeypatch.setattr(native_routes, 'is_native_platform', lambda: True)
    monkeypatch.setattr(
        native_routes,
        'list_flash_profiles',
        lambda target: [{
            'name': 'AVR Profile',
            'target': target,
            'checkout_path': '/home/pi/klipper',
            'flash_device': '/dev/serial/by-id/usb-avr',
            'flash_method': 'flashtool',
            'assignment_count': 2,
            'created': 1,
            'modified': 2,
        }],
    )

    response = client.get('/api/native/flash/klipper/profiles')

    assert response.status_code == 200
    assert response.json() == {
        'profiles': [{
            'name': 'AVR Profile',
            'target': 'klipper',
            'checkout_path': '/home/pi/klipper',
            'flash_device': '/dev/serial/by-id/usb-avr',
            'flash_method': 'flashtool',
            'assignment_count': 2,
            'created': 1,
            'modified': 2,
        }],
    }


def test_save_flash_profile_route_forwards_payload(monkeypatch):
    captured = {}

    def fake_save(target, name, data):
        captured['target'] = target
        captured['name'] = name
        captured['data'] = data
        return {'target': target, 'name': name, **data}

    monkeypatch.setattr(native_routes, 'is_native_platform', lambda: True)
    monkeypatch.setattr(native_routes, 'save_flash_profile', fake_save)

    response = client.post(
        '/api/native/flash/klipper/profiles',
        json={
            'name': 'AVR Profile',
            'checkout_path': '/home/pi/klipper',
            'flash_device': '/dev/serial/by-id/usb-avr',
            'flash_method': 'flashtool',
            'assignments': [{'symbol': 'MACH_AVR', 'value': 'y'}],
        },
    )

    assert response.status_code == 200
    assert captured == {
        'target': 'klipper',
        'name': 'AVR Profile',
        'data': {
            'checkout_path': '/home/pi/klipper',
            'flash_device': '/dev/serial/by-id/usb-avr',
            'flash_method': 'flashtool',
            'assignments': [{'symbol': 'MACH_AVR', 'value': 'y'}],
        },
    }


def test_delete_flash_profile_route_deletes_named_profile(monkeypatch):
    captured = {}

    def fake_delete(target, name):
        captured['target'] = target
        captured['name'] = name
        return True

    monkeypatch.setattr(native_routes, 'is_native_platform', lambda: True)
    monkeypatch.setattr(native_routes, 'delete_flash_profile', fake_delete)

    response = client.delete('/api/native/flash/katapult/profiles/CAN%20Toolhead')

    assert response.status_code == 200
    assert response.json() == {'status': 'deleted', 'name': 'CAN Toolhead'}
    assert captured == {'target': 'katapult', 'name': 'CAN Toolhead'}


def test_delete_flash_target_artifact_route_forwards_filename(monkeypatch):
    captured = {}

    def fake_delete(target, filename, checkout_path=None):
        captured['target'] = target
        captured['filename'] = filename
        captured['checkout_path'] = checkout_path
        return {'status': 'deleted', 'filename': filename, 'artifacts': [], 'primary_artifact': None}

    monkeypatch.setattr(native_routes, 'is_native_platform', lambda: True)
    monkeypatch.setattr(native_routes, 'delete_flash_target_artifact', fake_delete)

    response = client.delete('/api/native/flash/klipper/artifacts/klipper.bin?checkout_path=%2Fhome%2Fpi%2Fklipper')

    assert response.status_code == 200
    assert response.json()['status'] == 'deleted'
    assert captured == {
        'target': 'klipper',
        'filename': 'klipper.bin',
        'checkout_path': '/home/pi/klipper',
    }
