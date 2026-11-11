"""Static locks for the retired non-native mode (branch: retire-non-native-mode).

The backend now refuses to start off-Linux (``main._assert_native_platform``) and
the standalone MCP stdio server refuses too (``mcp_server.run_stdio``). Those two
assertions are the ONLY platform gates left.

A re-added per-route ``if not is_native_platform(): raise HTTPException(501)`` is
invisible to every behavioural test: it is a no-op on the Linux printer host, so
the suite stays green and the regression only surfaces months later on a
fake-native dev box the docs no longer mention. That is why this file asserts on
the source instead of on behaviour.
"""
import re
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1] / 'backend'

# Files allowed to mention is_native_platform(): the definition plus the two
# startup contracts. Anything else is a per-route guard coming back.
ALLOWED = {
    'main.py',
    'mcp_server.py',
    'services/native_services.py',
}


def _backend_sources():
    for path in BACKEND.rglob('*.py'):
        parts = path.relative_to(BACKEND).parts
        if any(part.startswith('.') or part == '__pycache__' for part in parts[:-1]):
            continue
        yield path


def test_is_native_platform_is_only_the_startup_contract():
    offenders = []
    for path in _backend_sources():
        rel = path.relative_to(BACKEND).as_posix()
        text = path.read_text(encoding='utf-8', errors='replace')
        if 'is_native_platform' in text and rel not in ALLOWED:
            offenders.append(rel)

    assert offenders == [], (
        'per-route platform guard re-introduced in: '
        f'{offenders} — the backend refuses to start off-Linux, so route-level '
        'gating is dead code that hides the contract'
    )


def test_no_router_returns_501():
    offenders = []
    pattern = re.compile(r'status_code\s*=\s*501')
    for path in _backend_sources():
        text = path.read_text(encoding='utf-8', errors='replace')
        if pattern.search(text):
            offenders.append(path.relative_to(BACKEND).as_posix())

    assert offenders == [], (
        f'501 "not the right platform" responses remain in: {offenders}'
    )
