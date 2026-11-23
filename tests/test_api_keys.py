"""MCP-scoped API keys (security-work 3.1).

The key gates the MCP HTTP surface ONLY — never the app (decisions D1).
Plaintext at rest on purpose: the key's whole job is re-copyability into
external client configs (Claude Desktop, Pi Agent, VS Code); hashing
would break its job. Blast radius of a leaked key = the MCP tool list,
not KWC. Masked in list responses; a key value only ever arrives via an
explicit create or replace response — reveal was retired in PR #48, no
route serves an existing value.
"""
import json
import stat
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from services import api_keys  # noqa: E402
from api import native_routes  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


@pytest.fixture
def key_store(tmp_path, monkeypatch):
    keys_file = tmp_path / 'api_keys.json'
    monkeypatch.setattr(api_keys, '_keys_file', lambda: keys_file)
    return keys_file


# ── pure store ────────────────────────────────────────────────────────

def test_create_validate_roundtrip(key_store):
    entry = api_keys.create_key(name='Pi Agent')
    assert entry['key'].startswith('kwc_')
    assert len(entry['key']) == len('kwc_') + 32
    assert api_keys.validate(entry['key'])['id'] == entry['id']
    assert api_keys.validate('kwc_forged' + '0' * 28) is None
    assert api_keys.validate('') is None
    assert api_keys.has_any() is True


def test_file_is_owner_only_and_holds_values(key_store):
    entry = api_keys.create_key(name='desk')
    assert stat.S_IMODE(key_store.stat().st_mode) == 0o600
    saved = json.loads(key_store.read_text())
    assert saved[0]['key'] == entry['key']  # plaintext: see module docstring


def test_expired_key_does_not_validate_but_is_listed(key_store):
    past = (datetime.now() - timedelta(days=1)).date().isoformat()
    entry = api_keys.create_key(name='old', expires_at=past)
    assert api_keys.validate(entry['key']) is None
    metas = api_keys.list_key_metadata()
    assert metas[0]['expired'] is True
    assert entry['key'][:10] in metas[0]['key_prefix']


def test_future_expiry_validates(key_store):
    future = (datetime.now() + timedelta(days=7)).date().isoformat()
    entry = api_keys.create_key(name='week', expires_at=future)
    assert api_keys.validate(entry['key']) is not None


def test_bad_expiry_rejected(key_store):
    with pytest.raises(ValueError):
        api_keys.create_key(expires_at='next tuesday')


def test_delete(key_store):
    entry = api_keys.create_key()
    assert api_keys.delete_key(entry['id']) is True
    assert api_keys.delete_key(entry['id']) is False
    assert api_keys.has_any() is False


def test_last_used_throttled(key_store):
    entry = api_keys.create_key()
    api_keys.validate(entry['key'])
    stamped = json.loads(key_store.read_text())[0]['last_used_at']
    assert stamped
    # Immediate second use must NOT rewrite the file (write amplification).
    recent = datetime.now(timezone.utc).isoformat(
        timespec="seconds")
    key_store.write_text(json.dumps([{**json.loads(key_store.read_text())[0],
                                      'last_used_at': recent}]))
    api_keys.validate(entry['key'])
    assert json.loads(key_store.read_text())[0]['last_used_at'] == recent


def test_list_key_metadata_never_leaks_values(key_store):
    entry = api_keys.create_key(name='a')
    metas = api_keys.list_key_metadata()
    assert entry['key'] not in json.dumps(metas)


# ── routes ────────────────────────────────────────────────────────────

def test_route_create_list_replace_delete(key_store, tmp_path, monkeypatch):
    # PR #48 D-2: the reveal route is GONE — no endpoint serves an
    # existing value. Replace rotates in place and shows the fresh
    # value once. This pin asserts the dead route STAYS dead.
    created = client.post('/api/native/api-keys',
                          json={'name': 'claude desktop'})
    assert created.status_code == 200
    key = created.json()['key']
    assert key.startswith('kwc_')
    key_id = created.json()['id']

    listed = client.get('/api/native/api-keys')
    assert listed.status_code == 200
    assert key not in listed.text  # list is metadata-only
    assert listed.json()['keys'][0]['name'] == 'claude desktop'

    # Route removal quirk worth knowing: a removed POST sub-route falls
    # through to the SPA catch-all, whose PATH matches (GET-only) — so
    # Starlette answers 405, not 404. Both answers are value-free: 405
    # is a bare JSON error, and the GET fallthrough serves index.html,
    # never a key. What is pinned is that NO verb ever yields the value.
    # The shell is a temp dist, not the repo's: CI checkouts ship no
    # built frontend, and the pin must mean the same thing everywhere.
    import main as main_mod
    dist = tmp_path / 'dist'
    dist.mkdir()
    (dist / 'index.html').write_text('<html>SPA</html>')
    monkeypatch.setattr(main_mod, 'FRONTEND_DIST', dist)
    dead = client.post(f'/api/native/api-keys/{key_id}/reveal')
    assert dead.status_code == 405 and key not in dead.text
    sham = client.get(f'/api/native/api-keys/{key_id}/reveal')
    assert 'text/html' in sham.headers.get('content-type', '')
    assert key not in sham.text

    replaced = client.post(f'/api/native/api-keys/{key_id}/replace')
    assert replaced.status_code == 200
    fresh = replaced.json()['key']
    assert fresh.startswith('kwc_') and fresh != key
    assert replaced.json()['id'] == key_id           # rotated in place
    assert api_keys.validate(fresh) is not None      # new value works
    assert api_keys.validate(key) is None            # old value is dead

    assert client.delete(f'/api/native/api-keys/{key_id}').status_code == 200
    assert client.get('/api/native/api-keys').json()['keys'] == []
    assert client.delete(f'/api/native/api-keys/{key_id}').status_code == 404
    assert client.post(f'/api/native/api-keys/{key_id}/replace').status_code == 404


def test_route_bad_expiry_is_400(key_store):
    resp = client.post('/api/native/api-keys',
                       json={'name': 'x', 'expires_at': 'someday'})
    assert resp.status_code == 400
