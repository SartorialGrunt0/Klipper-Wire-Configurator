"""Path containment for the raw-path native routes (security-work 1.2).

Live probe (2026-11-22, pre-fix): GET /api/native/config-files?path=/etc
→ 200 with a /etc listing; POST /api/native/apply {"config_path": <any dir>}
→ wrote files anywhere the backend user could write. The fix: every
request-supplied path must resolve INSIDE an allowed root — the settings
config_path plus KWC_EXTRA_CONFIG_DIRS — with symlinks resolved
(Moonraker file_manager semantics: a symlink escaping the root is an
escape).
"""
import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import api.native_routes as native_routes  # noqa: E402
from main import app  # noqa: E402
from services import path_containment  # noqa: E402

client = TestClient(app)


# ── pure helper ───────────────────────────────────────────────────────

def test_within_root_passes_outside_rejected(tmp_path):
    cfg = tmp_path / 'config'
    cfg.mkdir()
    (cfg / 'printer.cfg').write_text('[mcu]\n')
    assert path_containment.resolve_within_roots(
        str(cfg / 'printer.cfg'), [cfg]) == (cfg / 'printer.cfg').resolve()
    assert path_containment.resolve_within_roots(
        str(cfg), [cfg]) == cfg.resolve()
    # 'real path inside, ugly spelling' normalizes through.
    assert path_containment.resolve_within_roots(
        str(cfg / '..' / 'config' / 'printer.cfg'), [cfg]
    ) == (cfg / 'printer.cfg').resolve()
    with pytest.raises(ValueError):
        path_containment.resolve_within_roots(str(tmp_path / 'other'), [cfg])
    with pytest.raises(ValueError):
        path_containment.resolve_within_roots('/etc', [cfg])


def test_error_names_the_escape_hatch(tmp_path):
    cfg = tmp_path / 'config'
    cfg.mkdir()
    with pytest.raises(ValueError, match='KWC_EXTRA_CONFIG_DIRS'):
        path_containment.resolve_within_roots('/etc', [cfg])


def test_symlink_outside_is_escape_inside_is_fine(tmp_path):
    cfg = tmp_path / 'config'
    cfg.mkdir()
    outside = tmp_path / 'elsewhere'
    outside.mkdir()
    (outside / 'kamp.cfg').write_text('[gcode_macro KAMP]\n')
    (cfg / 'kamp.cfg').symlink_to(outside / 'kamp.cfg')          # escapes
    (cfg / 'local-link').symlink_to(cfg)                          # loops back in
    with pytest.raises(ValueError):
        path_containment.resolve_within_roots(str(cfg / 'kamp.cfg'), [cfg])
    assert path_containment.resolve_within_roots(
        str(cfg / 'local-link'), [cfg]) == cfg.resolve()


def test_nonexistent_inside_root_is_allowed(tmp_path):
    # apply writes NEW files; containment must not require existence.
    cfg = tmp_path / 'config'
    cfg.mkdir()
    resolved = path_containment.resolve_within_roots(
        str(cfg / 'brand-new.cfg'), [cfg])
    assert resolved == (cfg / 'brand-new.cfg').resolve()


def test_extra_dirs_env_expands_roots(tmp_path, monkeypatch):
    cfg = tmp_path / 'config'
    extra = tmp_path / 'klippers'
    cfg.mkdir()
    extra.mkdir()
    monkeypatch.setenv('KWC_EXTRA_CONFIG_DIRS', str(extra))
    assert cfg in path_containment.config_roots(str(cfg))
    assert extra in path_containment.config_roots(str(cfg))
    assert path_containment.resolve_within_roots(
        str(extra / 'moonraker-obico.cfg'), path_containment.config_roots(str(cfg))
    ) == (extra / 'moonraker-obico.cfg').resolve()


# ── route level ───────────────────────────────────────────────────────

@pytest.fixture
def config_dir(tmp_path, monkeypatch):
    cfg = tmp_path / 'printer_data' / 'config'
    cfg.mkdir(parents=True)
    (cfg / 'printer.cfg').write_text(
        '[virtual_sdcard]\npath: gcodes\n', encoding='utf-8')
    monkeypatch.setattr(native_routes, 'load_settings',
                        lambda: {'config_path': str(cfg)})
    monkeypatch.delenv('KWC_EXTRA_CONFIG_DIRS', raising=False)
    return cfg


def test_config_files_listing_escapes_are_400(config_dir, tmp_path):
    resp = client.get('/api/native/config-files', params={'path': '/etc'})
    assert resp.status_code == 400
    assert 'KWC_EXTRA_CONFIG_DIRS' in resp.text
    # Inside the root still works, and the no-arg default is untouched.
    ok = client.get('/api/native/config-files',
                    params={'path': str(config_dir)})
    assert ok.status_code == 200
    default = client.get('/api/native/config-files')
    assert default.status_code == 200
    assert default.json()['config_path'] == str(config_dir)


def test_config_files_read_escape_is_400(config_dir, tmp_path):
    (tmp_path / 'elsewhere').mkdir()
    resp = client.post('/api/native/config-files/read', json={
        'config_path': str(tmp_path / 'elsewhere'),
        'filenames': ['x.cfg'],
    })
    assert resp.status_code == 400
    assert 'KWC_EXTRA_CONFIG_DIRS' in resp.text


def test_apply_escape_is_400_and_writes_nothing(config_dir, tmp_path):
    outside = tmp_path / 'scratch'
    outside.mkdir()
    resp = client.post('/api/native/apply', json={
        'config_path': str(outside),
        'files': {'evil.cfg': '[mcu]\n'},
    })
    assert resp.status_code == 400
    assert 'KWC_EXTRA_CONFIG_DIRS' in resp.text
    assert list(outside.iterdir()) == []
    # Legitimate apply inside the root still lands.
    ok = client.post('/api/native/apply', json={
        'files': {'extra.cfg': '[gcode_macro HI]\ngcode:\n    G28\n'},
    })
    assert ok.status_code == 200
    assert (config_dir / 'extra.cfg').is_file()


def test_apply_symlinked_target_is_400(config_dir, tmp_path):
    # A pre-existing symlink inside the config dir that points OUT must
    # not become a write primitive to its target.
    outside = tmp_path / 'victim.cfg'
    outside.write_text('PRECIOUS\n', encoding='utf-8')
    (config_dir / 'link.cfg').symlink_to(outside)
    resp = client.post('/api/native/apply', json={
        'files': {'link.cfg': '[mcu]\n'},
    })
    assert resp.status_code == 400
    assert outside.read_text(encoding='utf-8') == 'PRECIOUS\n'
