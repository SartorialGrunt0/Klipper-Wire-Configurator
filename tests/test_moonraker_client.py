"""Moonraker API-token client (security-work 2.x).

Measured (2026-11-22): the ONLY Moonraker call in backend/ is the print-
state query; a 401 from a locked-down Moonraker fell through the generic
httpx.HTTPError handler and silently reported NOT printing — the exact
false-happy answer a fleet with [authorization] would get. The empty-
status case (klippy lacks print_stats without [virtual_sdcard]) lies the
same way. Both now report print_state 'unknown'; unreachable Moonraker
keeps today's not-printing fallback (standalone installs).
"""
import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import services.native_services as ns  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


class _Response:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                'boom', request=httpx.Request('GET', 'http://m'),
                response=httpx.Response(self.status_code))

    def json(self):
        return self._payload


def _scripted(response, captured):
    """An httpx.Client stand-in whose get() returns `response`, recording
    the url + headers it was called with."""
    class Scripted:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def get(self, url, headers=None):
            captured['url'] = url
            captured['headers'] = headers or {}
            return response
    return Scripted


def _fake_httpx(client_cls):
    return type('X', (), {'Client': client_cls,
                          'HTTPError': httpx.HTTPError,
                          'HTTPStatusError': httpx.HTTPStatusError})


def _ok(state):
    return _Response(200, {'result': {'status': {'print_stats': {
        'state': state, 'filename': 'cube.gcode'}}}})


_EMPTY = _Response(200, {'result': {'status': {}}})
_401 = _Response(401, {'error': {'message': 'API key required'}})


def test_print_stats_happy_path_unchanged(monkeypatch):
    captured = {}
    monkeypatch.setattr(ns, 'httpx', _fake_httpx(_scripted(_ok('printing'), captured)))
    status = ns._query_moonraker_print_status()
    assert status['is_printing'] is True
    assert status['print_state'] == 'printing'
    assert status['print_filename'] == 'cube.gcode'


def test_empty_status_reports_unknown_not_fake_not_printing(monkeypatch):
    captured = {}
    monkeypatch.setattr(ns, 'httpx', _fake_httpx(_scripted(_EMPTY, captured)))
    status = ns._query_moonraker_print_status()
    assert status['is_printing'] is False
    assert status['print_state'] == 'unknown'


def test_401_reports_unknown_and_flags_auth_required(monkeypatch):
    captured = {}
    monkeypatch.setattr(ns, 'httpx', _fake_httpx(_scripted(_401, captured)))
    status = ns._query_moonraker_print_status()
    assert status['print_state'] == 'unknown'
    assert status['is_printing'] is False
    assert status['moonraker_auth_required'] is True


def test_unreachable_moonraker_keeps_not_printing_fallback(monkeypatch):
    class Dead:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def get(self, url, headers=None):
            raise httpx.ConnectError('nope')

    monkeypatch.setattr(ns, 'httpx', _fake_httpx(Dead))
    status = ns._query_moonraker_print_status()
    assert status['is_printing'] is False
    assert status['print_state'] is None
    assert 'moonraker_auth_required' not in status


def test_configured_key_rides_x_api_key(monkeypatch):
    captured = {}
    monkeypatch.setattr(ns, 'load_settings',
                        lambda: {'moonraker_api_key': 'mk-key-123'})
    monkeypatch.delenv('KWC_MOONRAKER_API_KEY', raising=False)
    monkeypatch.setattr(ns, 'httpx', _fake_httpx(_scripted(_401, captured)))
    ns._query_moonraker_print_status()
    assert captured['headers'].get('X-Api-Key') == 'mk-key-123'


def test_env_var_overrides_settings_key(monkeypatch):
    captured = {}
    monkeypatch.setattr(ns, 'load_settings',
                        lambda: {'moonraker_api_key': 'from-settings'})
    monkeypatch.setenv('KWC_MOONRAKER_API_KEY', 'from-env')
    monkeypatch.setattr(ns, 'httpx', _fake_httpx(_scripted(_401, captured)))
    ns._query_moonraker_print_status()
    assert captured['headers'].get('X-Api-Key') == 'from-env'


def test_no_key_no_header(monkeypatch):
    captured = {}
    monkeypatch.setattr(ns, 'load_settings', lambda: {})
    monkeypatch.delenv('KWC_MOONRAKER_API_KEY', raising=False)
    monkeypatch.setattr(ns, 'httpx', _fake_httpx(_scripted(_ok('ready'), captured)))
    status = ns._query_moonraker_print_status()
    assert captured['headers'] == {}
    assert status['is_printing'] is False


# ── settings routes: masked moonraker key ─────────────────────────────

@pytest.fixture
def native_settings(monkeypatch):
    store = {}

    from api import native_routes
    monkeypatch.setattr(native_routes, 'load_settings',
                        lambda: dict(store))
    monkeypatch.setattr(native_routes, 'save_settings',
                        lambda s: (store.clear(), store.update(s)))
    return store


def test_settings_get_masks_moonraker_key(native_settings):
    native_settings['config_path'] = '/x'
    native_settings['moonraker_api_key'] = 'mk-secret-value'
    resp = client.get('/api/native/settings')
    assert resp.status_code == 200
    body = resp.json()
    assert 'moonraker_api_key' not in body
    assert body['moonraker_key_set'] is True
    assert 'mk-secret-value' not in resp.text


def test_settings_put_roundtrip_preserves_and_clears(native_settings):
    resp = client.put('/api/native/settings', json={
        'config_path': '/x', 'moonraker_api_key': 'mk-abc'})
    assert resp.status_code == 200
    assert native_settings['moonraker_api_key'] == 'mk-abc'
    assert resp.json()['moonraker_key_set'] is True
    assert 'mk-abc' not in resp.text
    # PUT without the field (the old request shape) keeps the stored key.
    client.put('/api/native/settings', json={'config_path': '/y'})
    assert native_settings['moonraker_api_key'] == 'mk-abc'
    # Explicit empty string clears.
    client.put('/api/native/settings',
               json={'config_path': '/y', 'moonraker_api_key': ''})
    assert native_settings['moonraker_api_key'] == ''
