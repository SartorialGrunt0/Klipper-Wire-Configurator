"""Static locks for the retired non-native mode (branch: retire-non-native-mode).

The backend now refuses to start off-Linux (``main._assert_native_platform``) and
the standalone MCP stdio server refuses too (``mcp_server.run_stdio``). Those two
assertions are the ONLY platform gates left.

A re-added per-route ``if not is_native_platform(): raise HTTPException(501)`` is
invisible to every behavioural test: it is a no-op on the Linux printer host, so
the suite stays green and the regression only surfaces months later on a
fake-native dev box the docs no longer mention. That is why this file asserts on
the source instead of on behaviour.

The detectors are deliberately wider than the one historical spelling: the
positional ``HTTPException(501, ...)`` form, the ``status.HTTP_501_*`` constant,
and inline ``sys.platform`` / ``os.name`` / ``platform.system()`` predicates all
count as offenders. ``test_detectors_catch_every_501_and_platform_spelling``
locks that in, so the lock itself cannot rot.
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

# Third-party trees are not the code under test: scanning them would let a
# dependency bump (a shipped ``status_code = 501`` or ``sys.platform`` in any
# package) redden these locks with a site-packages path in the message.
SKIP_PARTS = {'__pycache__', 'venv', 'node_modules', 'site-packages'}

# Every 501 spelling a guard could plausibly return with. The Starlette
# constant needs (?!\d), not \b — there is no word boundary between the
# "1" and the "_" in HTTP_501_NOT_IMPLEMENTED.
_HTTP_501 = re.compile(
    r'HTTPException\(\s*501\b'
    r'|status_code\s*=\s*(?:501\b|status\.HTTP_501(?!\d))'
)

# Platform predicates that bypass the is_native_platform symbol entirely.
_PLATFORM_PREDICATE = re.compile(
    r'\bsys\.platform\b|\bos\.name\b|\bplatform\.system\s*\('
)


def _py_sources(root: Path):
    for path in root.rglob('*.py'):
        parts = path.relative_to(root).parts
        if any(
            part.startswith('.') or part in SKIP_PARTS
            for part in parts[:-1]
        ):
            continue
        yield path


def _backend_sources():
    yield from _py_sources(BACKEND)


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
    for path in _backend_sources():
        text = path.read_text(encoding='utf-8', errors='replace')
        if _HTTP_501.search(text):
            offenders.append(path.relative_to(BACKEND).as_posix())

    assert offenders == [], (
        f'501 "not the right platform" responses remain in: {offenders}'
    )


def test_no_inline_platform_predicates():
    offenders = []
    for path in _backend_sources():
        rel = path.relative_to(BACKEND).as_posix()
        if rel in ALLOWED:
            continue
        text = path.read_text(encoding='utf-8', errors='replace')
        if _PLATFORM_PREDICATE.search(text):
            offenders.append(rel)

    assert offenders == [], (
        f'inline platform check in: {offenders} — the ONLY platform decision '
        'is the startup contract (main._assert_native_platform / run_stdio)'
    )


def test_scan_set_is_first_party_only():
    # A mis-scoped walk that silently scans only third-party code (or nothing)
    # would pass every lock above vacuously.
    sources = list(_backend_sources())
    assert len(sources) >= 20, f'lock scanned only {len(sources)} files'
    leaked = sorted(
        str(p.relative_to(BACKEND))
        for p in sources
        if SKIP_PARTS & set(p.relative_to(BACKEND).parts[:-1])
    )
    assert leaked == [], f'lock is scanning third-party trees: {leaked}'


def test_detectors_catch_every_501_and_platform_spelling():
    # The 501 detector: the three spellings a re-added guard realistically
    # takes, and no false alarm on other codes.
    assert _HTTP_501.search('raise HTTPException(501, "Only on the printer host")')
    assert _HTTP_501.search('raise HTTPException(status_code=501)')
    assert _HTTP_501.search('raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED)')
    assert not _HTTP_501.search('raise HTTPException(status_code=503)')
    assert not _HTTP_501.search('status_code = 1501')

    # The platform-predicate detector.
    assert _PLATFORM_PREDICATE.search('if sys.platform != "linux":')
    assert _PLATFORM_PREDICATE.search('if os.name != "posix":')
    assert _PLATFORM_PREDICATE.search('if platform.system() != "Linux":')
    assert not _PLATFORM_PREDICATE.search('hostname_platform = "printer host"')


def test_detectors_fire_on_a_synthetic_tree(tmp_path):
    (tmp_path / 'bad_positional.py').write_text(
        'raise HTTPException(501, "Only on the printer host")\n'
    )
    (tmp_path / 'bad_platform.py').write_text(
        'import sys\nif sys.platform != "linux":\n    raise HTTPException(status_code=403)\n'
    )
    (tmp_path / 'venv' / 'deep').mkdir(parents=True)
    (tmp_path / 'venv' / 'deep' / 'dep.py').write_text('x = 1  # status_code = 501 here\n')

    scanned = list(_py_sources(tmp_path))
    names = {p.name for p in scanned}
    assert 'bad_positional.py' in names
    assert 'bad_platform.py' in names
    assert 'dep.py' not in names, 'venv subtree leaked into the scan set'
    assert any(_HTTP_501.search(p.read_text()) for p in scanned)
    assert any(_PLATFORM_PREDICATE.search(p.read_text()) for p in scanned)
