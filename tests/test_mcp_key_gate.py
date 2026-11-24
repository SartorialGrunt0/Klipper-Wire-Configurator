"""MCP key gate + DNS-rebinding Host guard + CORS posture
(security-work 3.2-3.4).

Gate law (D1): no keys defined -> /api/mcp behaves exactly as today;
>=1 active key -> POST /api/mcp over HTTP must authenticate with
`Authorization: Bearer <key>` (the MCP authorization-spec header;
deliberately bearer-ONLY — one header, zero-config for spec clients).
The SPA is unaffected (chat calls MCP in-process).

Host law: trusted_clients-style loopback trust does NOT survive DNS
rebinding — a rebound drive-by request ARRIVES as loopback. So
state-changing methods additionally require a Host that is one of the
machine's own names/IPs, ON regardless of any key.
"""
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import main as main_mod  # noqa: E402
from services import api_keys  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)

_INIT = {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
         'params': {'protocolVersion': '2024-11-05',
                    'clientInfo': {'name': 't', 'version': '1'}}}


@pytest.fixture
def key_store(tmp_path, monkeypatch):
    keys_file = tmp_path / 'api_keys.json'
    monkeypatch.setattr(api_keys, '_keys_file', lambda: keys_file)
    return keys_file


# ── MCP key gate ──────────────────────────────────────────────────────

def test_mcp_open_when_no_keys_defined(key_store):
    # Pinning test: today's behavior survives untouched.
    resp = client.post('/api/mcp', json=_INIT)
    assert resp.status_code == 200
    assert 'result' in resp.json()


def test_mcp_requires_key_once_any_exists(key_store):
    entry = api_keys.create_key(name='gate')
    assert client.post('/api/mcp', json=_INIT).status_code == 401
    ok = client.post('/api/mcp', json=_INIT,
                     headers={'Authorization': f"Bearer {entry['key']}"})
    assert ok.status_code == 200
    assert 'result' in ok.json()
    assert client.post('/api/mcp', json=_INIT,
                       headers={'Authorization': 'Bearer kwc_deadbeef' + '0' * 20}
                       ).status_code == 401


def test_mcp_is_bearer_only(key_store):
    # Deliberate design (2026-11-23): X-Api-Key is NOT a second accepted
    # path — MCP-spec clients send Bearer, so one header, no dual support.
    entry = api_keys.create_key(name='gate')
    assert client.post('/api/mcp', json=_INIT,
                       headers={'X-Api-Key': entry['key']}
                       ).status_code == 401
    assert client.post('/api/mcp', json=_INIT,
                       headers={'Authorization': f"bearer {entry['key']}"}
                       ).status_code == 200          # scheme case-insensitive
    assert client.post('/api/mcp', json=_INIT,
                       headers={'Authorization': 'Basic dXNlcjpwdw=='}
                       ).status_code == 401          # other schemes ignored
    assert client.post('/api/mcp', json=_INIT,
                       headers={'Authorization': 'Bearer'}
                       ).status_code == 401          # no value


def test_expired_key_gated_out(key_store):
    entry = api_keys.create_key(
        name='gone',
        expires_at=(datetime.now() - timedelta(days=1)).date().isoformat())
    assert client.post('/api/mcp', json=_INIT,
                       headers={'Authorization': f"Bearer {entry['key']}"}
                       ).status_code == 401


def test_401_names_the_fix(key_store):
    api_keys.create_key()
    resp = client.post('/api/mcp', json=_INIT)
    assert 'Manage Keys' in resp.text


def test_mcp_health_stays_open(key_store):
    api_keys.create_key()
    assert client.get('/api/mcp/health').status_code == 200


# ── Host guard (pure decision table) ──────────────────────────────────

LOCALS = {'192.168.1.15', 'voron01', 'voron01.local',
          'localhost', '::1'}


@pytest.mark.parametrize('host,ok', [
    ('192.168.1.15:8099', True),      # LAN IP with port
    ('192.168.1.15', True),
    ('VORON01:8099', True),           # case-insensitive
    ('voron01.local', True),          # mDNS
    ('localhost:8099', True),
    ('[::1]:8099', True),             # IPv6 bracketed with port
    ('evil.example.com', False),      # DNS-rebind
    ('evil.example.com:8099', False),
    ('attacker.local', False),
])
def test_host_allow_table(host, ok):
    assert main_mod._host_is_local(host, LOCALS) is ok


def test_allowed_hosts_env_extends(monkeypatch):
    monkeypatch.setenv('KWC_ALLOWED_HOSTS', 'kwc-print,printer.lan')
    assert main_mod._extra_allowed() == {'kwc-print', 'printer.lan'}


def test_interface_addresses_include_default_route_ip():
    # Real-machine ground truth: the IP this host uses to reach the LAN
    # must be recognized as local, whatever /etc/hosts says the hostname
    # is (dogfood bug 2026-11-23: cloud-image hosts map hostname ->
    # 127.0.1.1, and gethostbyname_ex alone misses every LAN interface).
    import socket
    route_ip = None
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(('192.0.2.1', 1))  # TEST-NET: routing lookup, no traffic
        route_ip = probe.getsockname()[0]
    except OSError:
        pass
    finally:
        probe.close()
    if route_ip is None:
        pytest.skip('no routable interface on this machine')
    assert route_ip in main_mod._interface_addresses()


def test_local_host_values_survive_localhost_only_hosts_file(monkeypatch):
    # Pin the exact dogfood failure shape: hostname resolves ONLY to
    # 127.0.1.1. Interface enumeration must still put the LAN IP in.
    import socket
    monkeypatch.setattr(main_mod, '_local_hosts_cache', (0.0, set()))
    monkeypatch.setattr(socket, 'gethostname', lambda: 'hermes')
    monkeypatch.setattr(socket, 'gethostbyname_ex',
                        lambda n: ('hermes', ['hermes'], ['127.0.1.1']))
    route_ip = None
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(('192.0.2.1', 1))
        route_ip = probe.getsockname()[0]
    except OSError:
        pass
    finally:
        probe.close()
    if route_ip is None:
        pytest.skip('no routable interface on this machine')
    assert route_ip in main_mod._local_host_values()


def test_guard_decision():
    # State-changing + real IP client + foreign Host -> block.
    assert main_mod._host_guard_blocks('POST', '192.168.1.42',
                                       'evil.example.com', LOCALS) is True
    assert main_mod._host_guard_blocks('POST', '127.0.0.1',
                                       'evil.example.com', LOCALS) is True
    # Same Host from a non-IP client (in-process harness) is not a socket.
    assert main_mod._host_guard_blocks('POST', 'testclient',
                                       'testserver', LOCALS) is False
    # Safe Host, or a read method, never blocked.
    assert main_mod._host_guard_blocks('POST', '192.168.1.42',
                                       '192.168.1.15:8099', LOCALS) is False
    assert main_mod._host_guard_blocks('GET', '192.168.1.42',
                                       'evil.example.com', LOCALS) is False


def test_cors_no_credentials():
    # KWC has no cookie auth: wildcard + credentials is invalid AND it
    # lets foreign pages ride the user's session — both gone.
    cors = [m for m in app.user_middleware
            if 'CORSMiddleware' in str(m.cls)][0]
    assert cors.kwargs.get('allow_credentials') is False
