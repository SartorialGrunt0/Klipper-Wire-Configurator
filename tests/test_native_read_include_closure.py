"""
Native read must expand the requested file set to the ON-DISK include
closure, mirroring Klipper's configfile.py _resolve_include (includes resolve
relative to the including file's directory and symlinks are followed freely).

Real-world bug (V2.6.0, 2026-09): third-party installs (KAMP, moonraker-obico,
mainsail macros) commonly symlink their .cfg files *into*
/printer_data/config from elsewhere. list_config_files deliberately hides
files whose symlink target escapes the config root (traversal guard), so the
native auto-read never loads them — and the missing-include ERROR then fires
on printer.cfg / KAMP_Settings.cfg include lines even though Klipper will
load those symlinked files fine at startup. The project KWC builds must be
what Klipper actually loads.
"""
import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import api.native_routes as native_routes  # noqa: E402
from main import app  # noqa: E402
from services.native_services import list_config_files  # noqa: E402

client = TestClient(app)

pytestmark = pytest.mark.skipif(
    not hasattr(os, 'symlink'),
    reason='needs symlink support',
)

_MAINSAIL = '[virtual_sdcard]\npath: ~/printer_data/gcodes\n'
_OBICO_MACROS = '[gcode_macro OBICO_HELPER]\ngcode:\n    RESPOND MSG="ok"\n'
_KAMP_MESH = '[gcode_macro KAMP_MESHING]\ngcode:\n    G28\n'
_KAMP_PURGE = '[gcode_macro LINE_PURGE]\ngcode:\n    G28\n'
_KAMP_PARK = '[gcode_macro SMART_PARK]\ngcode:\n    G28\n'


def _missing_include_messages(body: dict) -> list[str]:
    out = []
    for filename, file_result in body['files'].items():
        for err in file_result['validation'].get('errors', []):
            if err.get('code') == 'missing_include':
                out.append(f"{filename}: {err['message']}")
    return out


def _make_fixture(tmp_path: Path):
    """Build a config dir whose include targets are symlinked outside the root.

    Returns (config_dir, visible_filenames) where visible_filenames are the
    names list_config_files offers (the symlinked targets are hidden).
    """
    external = tmp_path / 'external'
    (external / 'KAMP').mkdir(parents=True)
    (external / 'mainsail.cfg').write_text(_MAINSAIL, encoding='utf-8')
    (external / 'moonraker_obico_macros.cfg').write_text(_OBICO_MACROS, encoding='utf-8')
    (external / 'KAMP' / 'Adaptive_Meshing.cfg').write_text(_KAMP_MESH, encoding='utf-8')
    (external / 'KAMP' / 'Line_Purge.cfg').write_text(_KAMP_PURGE, encoding='utf-8')
    (external / 'KAMP' / 'Smart_Park.cfg').write_text(_KAMP_PARK, encoding='utf-8')

    config_dir = tmp_path / 'config'
    config_dir.mkdir()
    (config_dir / 'printer.cfg').write_text(
        '[include moonraker_obico_macros.cfg]\n'
        '[include mainsail.cfg]\n'
        '[include aux_fan.cfg]\n'
        '[include KAMP_Settings.cfg]\n'
        '[printer]\nkinematics: cartesian\n',
        encoding='utf-8',
    )
    (config_dir / 'KAMP_Settings.cfg').write_text(
        '[include ./KAMP/Adaptive_Meshing.cfg]\n'
        '[include ./KAMP/Line_Purge.cfg]\n'
        '[include ./KAMP/Smart_Park.cfg]\n',
        encoding='utf-8',
    )
    (config_dir / 'aux_fan.cfg').write_text(
        '[gcode_macro AUX_FAN]\ngcode:\n    G28\n', encoding='utf-8',
    )
    # Symlink the include targets to live OUTSIDE the config root — the
    # traversal guard in list_config_files hides these from the listing.
    os.symlink(external / 'mainsail.cfg', config_dir / 'mainsail.cfg')
    os.symlink(external / 'moonraker_obico_macros.cfg', config_dir / 'moonraker_obico_macros.cfg')
    os.symlink(external / 'KAMP', config_dir / 'KAMP')

    visible = [f['name'] for f in list_config_files(str(config_dir))]
    return config_dir, visible


def test_listing_hides_symlinked_include_targets(tmp_path):
    """Precondition: the traversal guard drops the symlinked files."""
    config_dir, visible = _make_fixture(tmp_path)
    assert 'mainsail.cfg' not in visible
    assert 'moonraker_obico_macros.cfg' not in visible
    assert not any(name.startswith('KAMP/') for name in visible)


def test_native_read_expands_to_disk_include_closure(monkeypatch, tmp_path):
    """Read returns the include closure even for files hidden from the listing,
    so no missing_include error fires for on-disk include targets."""
    monkeypatch.setattr(native_routes, 'is_native_platform', lambda: True)
    config_dir, visible = _make_fixture(tmp_path)

    response = client.post('/api/native/config-files/read', json={
        'config_path': str(config_dir),
        'filenames': visible,
    })

    assert response.status_code == 200
    body = response.json()

    loaded = set(body['files'].keys())
    for expected in (
        'mainsail.cfg',
        'moonraker_obico_macros.cfg',
        'KAMP/Adaptive_Meshing.cfg',
        'KAMP/Line_Purge.cfg',
        'KAMP/Smart_Park.cfg',
    ):
        assert expected in loaded, (
            f"include target {expected!r} must be loaded from disk even when "
            f"the listing hides it; loaded: {sorted(loaded)}"
        )

    missing = _missing_include_messages(body)
    assert not missing, (
        "on-disk include targets must not be reported missing; "
        f"got: {missing}"
    )


def test_native_read_still_flags_genuinely_missing_include(monkeypatch, tmp_path):
    """A truly absent include target keeps its missing_include error."""
    monkeypatch.setattr(native_routes, 'is_native_platform', lambda: True)
    config_dir = tmp_path / 'config'
    config_dir.mkdir()
    (config_dir / 'printer.cfg').write_text(
        '[include aux_fan.cfg]\n'
        '[include gone.cfg]\n'
        '[printer]\nkinematics: cartesian\n',
        encoding='utf-8',
    )
    (config_dir / 'aux_fan.cfg').write_text(
        '[gcode_macro AUX_FAN]\ngcode:\n    G28\n', encoding='utf-8',
    )

    response = client.post('/api/native/config-files/read', json={
        'config_path': str(config_dir),
        'filenames': ['printer.cfg', 'aux_fan.cfg'],
    })

    assert response.status_code == 200
    body = response.json()
    missing = _missing_include_messages(body)
    assert any('gone.cfg' in message for message in missing), (
        f"genuinely absent include must still error; got: {missing}"
    )
