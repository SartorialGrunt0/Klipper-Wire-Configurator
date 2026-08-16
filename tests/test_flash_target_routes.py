import sys
from pathlib import Path
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import asyncio  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402

import api.native_routes as native_routes  # noqa: E402
from main import app  # noqa: E402


client = TestClient(app)


def test_blocking_subprocess_routes_are_sync():
    """Blocking subprocess/socket/file routes must run in the threadpool,
    not on the FastAPI event loop (a frozen loop stalls AI chat, config
    saves, and every other request while a build/flash/scan is running).
    """
    blocking_routes = [
        native_routes.list_devices,
        native_routes.get_canbus_uuids,
        native_routes.read_config_files,
        native_routes.apply_config,
        native_routes.klipper_firmware_restart,
        native_routes.klipper_status,
        native_routes.klipper_log_excerpt,
        native_routes.scan_flash_target_devices_api,
        native_routes.build_flash_target_api,
        native_routes.flash_target_api,
        native_routes.flash_target_state,
        native_routes.preview_flash_target,
        native_routes.save_flash_target,
        native_routes.download_flash_target_artifact,
        native_routes.delete_saved_flash_target_artifact,
        native_routes.klipper_firmware_state,
        native_routes.update_klipper_firmware_config,
        native_routes.preview_klipper_firmware_config,
        native_routes.build_klipper_firmware_api,
        native_routes.flash_klipper_firmware_api,
    ]
    for route in blocking_routes:
        assert asyncio.iscoroutinefunction(route) is False, f"{route.__name__} is still async"


def test_build_route_does_not_block_concurrent_status(monkeypatch):
    """A slow build must not stall a concurrent request: the build sleeps in
    the threadpool while /status completes on the event loop.

    Uses a real uvicorn server + httpx (TestClient serializes requests at the
    transport level and cannot exercise concurrency).
    """
    import socket as socket_mod

    import httpx
    import uvicorn

    def slow_build(target, checkout_path=None):
        time.sleep(1.5)
        return {
            'target': target,
            'display_name': 'Klipper',
            'success': True,
            'error': None,
            'log': '$ make',
            'checkout_path': '/home/pi/klipper',
            'out_path': '/home/pi/klipper/out',
            'artifacts': [],
            'primary_artifact': None,
            'flash_device': '',
            'flash_method': '',
        }

    monkeypatch.setattr(native_routes, 'is_native_platform', lambda: True)
    monkeypatch.setattr(native_routes, 'build_flash_target', slow_build)

    with socket_mod.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]

    server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=port, log_level='warning'))
    server_thread = threading.Thread(target=server.run, daemon=True)
    server_thread.start()

    base_url = f'http://127.0.0.1:{port}'
    deadline = time.monotonic() + 10
    try:
        with httpx.Client(base_url=base_url) as probe:
            while True:
                try:
                    if probe.get('/api/native/status').status_code in (200, 501):
                        break
                except Exception:
                    pass
                if time.monotonic() > deadline:
                    raise RuntimeError('test server did not become ready')
                time.sleep(0.05)

            results = {}

            def run_build():
                results['build'] = probe.post(
                    '/api/native/flash/klipper/build',
                    json={'checkout_path': '/home/pi/klipper'},
                )

            def run_status():
                time.sleep(0.2)  # let the build start first
                start = time.monotonic()
                results['status'] = probe.get('/api/native/status')
                results['status_elapsed'] = time.monotonic() - start

            build_thread = threading.Thread(target=run_build)
            status_thread = threading.Thread(target=run_status)
            build_thread.start()
            status_thread.start()
            build_thread.join(timeout=10)
            status_thread.join(timeout=10)

            assert results['build'].status_code == 200
            assert results['status'].status_code == 200
            assert results['status_elapsed'] < 1.0, (
                f"/status took {results['status_elapsed']:.2f}s while a build was running — event loop is blocked"
            )
    finally:
        server.should_exit = True
        server_thread.join(timeout=5)


def test_preview_flash_target_route_forwards_assignments(monkeypatch):
    captured = {}

    def fake_preview(target, assignments, checkout_path=None, help_limit=0):
        captured['target'] = target
        captured['assignments'] = assignments
        captured['checkout_path'] = checkout_path
        captured['help_limit'] = help_limit
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
        'help_limit': 0,
    }


def test_flash_field_help_route_forwards_field_id(monkeypatch):
    captured = {}

    def fake_help(target, field_id, checkout_path=None):
        captured['target'] = target
        captured['field_id'] = field_id
        captured['checkout_path'] = checkout_path
        return {'field_id': field_id, 'help': 'full help text'}

    monkeypatch.setattr(native_routes, 'is_native_platform', lambda: True)
    monkeypatch.setattr(native_routes, 'get_flash_field_help', fake_help)

    response = client.get(
        '/api/native/flash/klipper/field-help',
        params={'field_id': 'MACH_AVR', 'checkout_path': '/home/pi/klipper'},
    )

    assert response.status_code == 200
    assert response.json() == {'field_id': 'MACH_AVR', 'help': 'full help text'}
    assert captured == {
        'target': 'klipper',
        'field_id': 'MACH_AVR',
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
