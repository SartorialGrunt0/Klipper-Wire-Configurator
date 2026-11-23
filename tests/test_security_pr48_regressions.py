"""PR #48 review-round fixes, pinned (each test = one confirmed finding).

Round-1 independent review (3 fresh-context reviewers, parent-verified by
live probes) found 23 issues in the security branch. These are the
REGRESSION PINS for the fixes — each docstring names the finding it
locks shut. They must FAIL if the fix is reverted, and must not encode
anything the settled design laws reject (trusted-LAN posture, plaintext
keys-at-rest, bearer-only gate, SPA-never-authenticates).
"""
import asyncio
import json
import os
import stat
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import main as main_mod  # noqa: E402
import api.ai_routes as ai_routes  # noqa: E402
import api.native_routes as native_routes  # noqa: E402
from services import api_keys  # noqa: E402
import services.flash_targets as flash_targets  # noqa: E402
import services.native_services as native_services  # noqa: E402

client = TestClient(main_mod.app)

# A fixture credential — pattern-shaped, value meaningless. Assembled
# like every other pin here so no grep-for-literal ever flags a real one.
FIX_KEY = '***' + 'r3gr3ssion' + '0' * 22
_INIT = {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
         'params': {'protocolVersion': '2024-11-05',
                    'clientInfo': {'name': 't', 'version': '1'}}}


@pytest.fixture
def key_store(tmp_path, monkeypatch):
    keys_file = tmp_path / 'api_keys.json'
    monkeypatch.setattr(api_keys, '_keys_file', lambda: keys_file)
    return keys_file


def _settings_store(monkeypatch, tmp_path, initial):
    """In-memory stand-in for settings.json so routes never touch the
    real user settings file."""
    box = dict(initial)
    monkeypatch.setattr(native_routes, 'load_settings', lambda: dict(box))
    monkeypatch.setattr(native_routes, 'save_settings',
                        lambda s: box.clear() or box.update(s))
    return box


# ── C-01: stored provider key may only ride to the URL it was saved for ──

def test_provider_key_bound_to_saved_url(tmp_path, monkeypatch):
    """CRITICAL C-01: an empty-key request naming an attacker apiUrl must
    never pull the stored secret to it (proxy-as-exfil-relay)."""
    state = tmp_path / 'state.json'
    state.write_text(json.dumps({'settings': {
        'apiKey': FIX_KEY, 'apiUrl': 'https://api.example.com/v1'}}))
    monkeypatch.setattr(ai_routes, 'AI_STATE_FILE', state)
    # Off-target: sentinel/'' key + different apiUrl -> NO stored key.
    assert ai_routes._resolve_api_key('', 'http://203.0.113.66:9999/v1') == ''
    assert ai_routes._resolve_api_key(
        ai_routes.API_KEY_STORED_SENTINEL, 'https://evil.example/v1') == ''
    # On-target: exact saved URL -> stored key resolves (no UX change).
    assert ai_routes._resolve_api_key(
        '', 'https://api.example.com/v1') == FIX_KEY
    assert ai_routes._resolve_api_key(
        ai_routes.API_KEY_STORED_SENTINEL, 'https://api.example.com/v1') == FIX_KEY
    # No saved URL at all = no binding (standalone installs unaffected).
    state.write_text(json.dumps({'settings': {'apiKey': FIX_KEY}}))
    assert ai_routes._resolve_api_key('', 'http://anywhere.test/v1') == FIX_KEY
    # An explicitly typed key always wins over the binding logic.
    assert ai_routes._resolve_api_key('typed-key', 'http://anywhere.test') == 'typed-key'


def test_history_save_does_not_spread_key_into_snapshots(tmp_path, monkeypatch):
    """LOW C-L02: the sentinel->key restore on save was scoped to the
    top-level settings; conversation snapshots keep the sentinel."""
    state = tmp_path / 'state.json'
    state.write_text(json.dumps({'settings': {'apiKey': FIX_KEY}}))
    monkeypatch.setattr(ai_routes, 'AI_STATE_FILE', state)
    payload = {'settings': {'apiKey': ai_routes.API_KEY_STORED_SENTINEL},
               'conversations': [
                   {'settings': {'apiKey': ai_routes.API_KEY_STORED_SENTINEL}}
                   for _ in range(3)]}
    out = ai_routes._restore_sentinel_api_key(payload)
    assert out['settings']['apiKey'] == FIX_KEY          # top-level restored
    assert all(c['settings']['apiKey'] == ai_routes.API_KEY_STORED_SENTINEL
               for c in out['conversations'])           # snapshots untouched


# ── A-01: SPA catch-all may not read outside frontend/dist ───────────────

def test_spa_catchall_cannot_read_outside_dist(tmp_path, monkeypatch):
    """CRITICAL A-01: percent-encoded %2e%2e traversal decoded to '..'
    and served /etc/passwd (live-probed). The catch-all now contains."""
    dist = tmp_path / 'dist'
    (dist / 'assets').mkdir(parents=True)
    (dist / 'index.html').write_text('<html>SPA</html>')
    secret = tmp_path / 'outside.json'
    secret.write_text('{"canary": "must-never-be-served"}')
    monkeypatch.setattr(main_mod, 'FRONTEND_DIST', dist)
    r = client.get('/%2e%2e/%2e%2e/outside.json')
    assert 'must-never-be-served' not in r.text
    assert '<html>SPA</html>' in r.text   # falls back to the SPA shell
    # Absolute-path pseudo-joins (Path('dist') / '/etc/passwd') too:
    r = client.get('//absolute/etc/passwd%00')
    assert 'root:' not in r.text
    # Legit SPA routes still get the shell:
    assert '<html>SPA</html>' in client.get('/some/spa/route').text


# ── A-02: corrupt key store fails the gate CLOSED ────────────────────────

def test_corrupt_key_store_fails_closed(key_store):
    """CRITICAL-adjacent A-02: unparseable api_keys.json used to read as
    'zero keys' = gate OPEN. Corruption now denies; only deletion opens."""
    key_store.write_text('{not json at all')
    assert api_keys.has_any() is True              # state: broken, not empty
    assert api_keys.validate(FIX_KEY) is None
    r = client.post('/api/mcp', json=_INIT)
    assert r.status_code == 401
    # A JSON OBJECT where rows must be: same closed door.
    key_store.write_text(json.dumps({'keys': []}))
    assert api_keys.has_any() is True
    assert client.post('/api/mcp', json=_INIT).status_code == 401
    # Deleting the file remains the documented OPEN path:
    key_store.unlink()
    assert api_keys.has_any() is False
    assert client.post('/api/mcp', json=_INIT).status_code == 200


# ── A-03 / L-03 / L-04: expiry is total over every legal input shape ─────

def test_aware_expiry_never_raises(key_store):
    """HIGH A-03: an offset-aware expires_at raised TypeError inside the
    auth path (500) and in the Manage Keys list."""
    entry = api_keys.create_key(name='aw',
                                expires_at='2027-01-31T00:00:00+08:00')
    assert api_keys.validate(entry['key']) is not None      # future: valid
    assert api_keys.list_key_metadata()                     # no raise
    dead = api_keys.create_key(name='aw2',
                               expires_at='2020-01-01T00:00:00+08:00')
    assert api_keys.validate(dead['key']) is None           # past: refused


def test_date_only_expiry_means_end_of_day(key_store):
    """LOW L-04: a typed date deadline meant midnight — keys died at
    00:00 of the chosen day. Date-only now means END of that day."""
    entry = api_keys.create_key(name='today',
                                expires_at=date.today().isoformat())
    assert api_keys.validate(entry['key']) is not None
    past = api_keys.create_key(name='yesterday',
                               expires_at=(date.today() - timedelta(days=1)).isoformat())
    assert api_keys.validate(past['key']) is None


def test_stored_malformed_expiry_refuses_key(key_store):
    """LOW L-03: a hand-planted unparseable expires_at used to fail
    OPEN (never expires). Unparseable expiry now refuses the key; the
    route-side half (create with garbage) is pinned as a 400 elsewhere."""
    entry = api_keys.create_key(name='m')
    rows = json.loads(key_store.read_text())
    rows[0]['expires_at'] = 'someday'
    key_store.write_text(json.dumps(rows))
    assert api_keys.validate(entry['key']) is None


def test_atomic_write_survives_replace_failure(key_store, monkeypatch):
    """HIGH A-05: a crash between truncate and close (or ENOSPC) left a
    half-written file that read as corruption/open. The write is now
    temp+replace: a failed rename leaves the PREVIOUS store intact."""
    good = api_keys.create_key(name='keeper')
    real_replace = os.replace
    monkeypatch.setattr(api_keys.os, 'replace',
                        lambda *a, **k: (_ for _ in ()).throw(OSError('ENOSPC')))
    with pytest.raises(OSError):
        api_keys.delete_key(good['id'])
    monkeypatch.setattr(api_keys.os, 'replace', real_replace)
    assert api_keys.validate(good['key']) is not None       # pre-state intact
    assert stat.S_IMODE(key_store.stat().st_mode) == 0o600  # mode never regressed


def test_stale_stamp_cannot_resurrect_deleted_key(key_store):
    """LOW A-L01: a last-used stamp written from an in-flight snapshot
    rewrote the store wholesale and resurrected a just-deleted key."""
    entry = api_keys.create_key(name='revoked')
    snapshot = api_keys._read()                 # mid-validate snapshot
    api_keys.delete_key(entry['id'])
    assert api_keys.validate(entry['key']) is None
    api_keys._maybe_stamp(snapshot[0], snapshot, datetime.now(timezone.utc).replace(tzinfo=None))
    assert json.loads(key_store.read_text()) == []          # stays deleted
    assert api_keys.validate(entry['key']) is None


# ── B-02 / B-05: the containment root is not client-steerable ────────────

def test_put_settings_rejects_unusable_roots(monkeypatch, tmp_path):
    """CRITICAL B-02 + LOW B-05: PUT config_path '/' armed
    GET config-files?path=/etc to list /etc; an empty value collapsed the
    roots to the process cwd (backend checkout listing)."""
    cfg = tmp_path / 'cfg'
    cfg.mkdir()
    box = _settings_store(monkeypatch, tmp_path, {'config_path': str(cfg)})
    for bad in ('/', '', '   ', 'relative/dir'):
        r = client.put('/api/native/settings', json={'config_path': bad})
        assert r.status_code == 400, bad
    assert box['config_path'] == str(cfg)                   # rejected writes
    r = client.put('/api/native/settings',
                   json={'config_path': str(tmp_path / 'new' / 'dir')})
    assert r.status_code == 200                            # absolute = accepted


def test_empty_stored_root_falls_back_never_cwd(monkeypatch, tmp_path):
    """B-05 read side: a hand-edited/legacy empty config_path must not
    list the backend working tree through config-files."""
    cfg = tmp_path / 'default'
    cfg.mkdir()
    (cfg / 'printer.cfg').write_text('[printer]\n')
    _settings_store(monkeypatch, tmp_path, {'config_path': ''})
    monkeypatch.setattr(native_routes, 'get_default_config_path',
                        lambda: str(cfg))
    r = client.get('/api/native/config-files', params={'path': '.'})
    # '.' is outside the default root -> 400 containment refusal, NOT a
    # cwd listing.
    assert r.status_code == 400
    g = client.get('/api/native/config-files')
    assert g.json()['config_path'] == str(tmp_path / 'default')


def test_apply_delete_branch_is_contained(monkeypatch, tmp_path):
    """CRITICAL B-04: the WRITE branch of /apply was contained but the
    DELETE loop followed an in-dir symlinked directory out and unlinked
    the victim."""
    cfg = tmp_path / 'cfg'
    cfg.mkdir()
    outside = tmp_path / 'outside'
    outside.mkdir()
    victim = outside / 'victim.cfg'
    victim.write_text('important')
    (cfg / 'link').symlink_to(outside)
    _settings_store(monkeypatch, tmp_path, {'config_path': str(cfg)})
    d = client.post('/api/native/apply',
                    json={'files': {}, 'deleted': ['link/victim.cfg']})
    assert d.status_code == 400
    assert victim.exists()                                 # still there
    w = client.post('/api/native/apply',
                    json={'files': {'link/evil.cfg': 'x'}, 'deleted': []})
    assert w.status_code == 400
    assert not (outside / 'evil.cfg').exists()


# ── B-01: a planted checkout must never execute on a state read ──────────

def test_planted_checkout_not_executed(tmp_path):
    """CRITICAL B-01: Makefile + src/Kconfig + lib/kconfiglib existence
    was the ONLY gate; the planted kconfiglib.py ran on the first GET.
    The real project's Makefile carries KCONFIG_CONFIG + out/ signatures
    a planted stub lacks."""
    marker = tmp_path / 'executed.marker'
    evil = tmp_path / 'evil'
    (evil / 'src').mkdir(parents=True)
    (evil / 'lib' / 'kconfiglib').mkdir(parents=True)
    (evil / 'Makefile').write_text('all:\n\t@echo planted\n')
    (evil / 'src' / 'Kconfig').write_text('mainmenu "planted"\n')
    (evil / 'lib' / 'kconfiglib' / 'kconfiglib.py').write_text(
        f"open({str(marker)!r},'w').write('EXECUTED')\n"
        "Kconfig = None\nKconfigError = Exception\n")
    try:
        flash_targets.get_flash_target_state('klipper', str(evil))
    except Exception:
        pass
    assert not marker.exists()
    assert flash_targets._is_flash_target_checkout('klipper', evil) is False


# ── B-03: Host guard decides by IP parse, not string prefix ──────────────

def test_host_guard_rejects_loopback_prefix_names():
    """CRITICAL B-03: '127.attacker.example' A-records anywhere; the old
    startswith('127.') let a rebound drive-by through the guard."""
    lv = {'192.168.1.39', 'hermes', 'hermes.local', 'localhost'}
    assert main_mod._host_guard_blocks('POST', '192.168.1.50',
                                       '127.attacker.example', lv) is True
    assert main_mod._host_guard_blocks('POST', '192.168.1.50',
                                       'evil.example', lv) is True
    # Real values still pass: exact LAN IP (+port), every 127/8 loopback
    # address, localhost, mDNS, and the machine's own name.
    for host, ok in [('192.168.1.39:8099', True), ('127.0.0.1', True),
                     ('127.4.5.6', True), ('localhost:8099', True),
                     ('hermes.local', True), ('HERMES', True),
                     ('[::1]:8099', True), ('198.51.100.7', False)]:
        assert main_mod._host_is_local(host, lv) is ok, host


# ── Moonraker print-state honesty (shapes that answered-but-lied) ────────

class _FakeResp:
    def __init__(self, code, payload):
        self.status_code, self._p = code, payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                'x', request=httpx.Request('GET', 'http://m'),
                response=httpx.Response(self.status_code))

    def json(self):
        if self._p is None:
            raise ValueError('not json')
        return self._p


def _moonraker_shape(monkeypatch, resp=None, connect_fails=False):
    class FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, url, headers=None):
            if connect_fails:
                raise httpx.ConnectError('nothing here')
            return resp
    monkeypatch.setattr(native_services.httpx, 'Client', FakeClient)
    monkeypatch.setattr(native_services, '_moonraker_api_key', lambda: '')
    monkeypatch.setattr(native_services, '_moonraker_base_urls',
                        lambda: ['http://127.0.0.1:7125'])
    return native_services._query_moonraker_print_status()


def test_moonraker_answered_but_unreadable_is_unknown(monkeypatch):
    """MEDIUM: 403, 5xx, a non-JSON body, or an empty status object all
    fell through to a FAKE 'not printing'. Answered-but-unreadable is
    'unknown' now."""
    shapes = [
        ('403', _FakeResp(403, {})),
        ('500', _FakeResp(500, {})),
        ('malformed-body', _FakeResp(200, None)),
        ('empty-status', _FakeResp(200, {'result': {'status': {}}})),
        ('print_stats-not-dict', _FakeResp(200, {'result': {'status': {'print_stats': 'garbage'}}})),
    ]
    for label, resp in shapes:
        st = _moonraker_shape(monkeypatch, resp=resp)
        assert st['print_state'] == 'unknown', label
        assert st['is_printing'] is False, label


def test_moonraker_network_unreachable_stays_not_printing(monkeypatch):
    """The deliberate half (SECURITY.md law): a network-unreachable
    Moonraker — the normal standalone install — keeps the honest
    not-printing answer, not a scary 'unknown'."""
    st = _moonraker_shape(monkeypatch, connect_fails=True)
    assert st['print_state'] is None
    assert st['is_printing'] is False


# ── D-2 backend half: PUT without config_path preserves the stored root ──

def test_token_put_preserves_stored_config_path(monkeypatch, tmp_path):
    """LOW L-01: the frontend's token save PUT the store's configPath
    copy; a stale value could silently repoint the containment root. The
    field is now optional and omitted by that caller."""
    cfg = tmp_path / 'cfg'
    cfg.mkdir()
    box = _settings_store(monkeypatch, tmp_path, {'config_path': str(cfg)})
    r = client.put('/api/native/settings', json={'moonraker_api_key': 'tok'})
    assert r.status_code == 200
    assert box['config_path'] == str(cfg)                  # preserved
    assert r.json()['moonraker_key_set'] is True
    assert 'moonraker_api_key' not in r.json()             # never served
