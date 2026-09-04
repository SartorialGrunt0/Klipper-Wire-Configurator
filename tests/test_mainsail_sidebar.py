"""V2.6.0 user report 2026-09-03: updating KWC via Moonraker's update_manager
did not add the Mainsail sidebar entry (navi.json) — only re-running
install.sh did.

Root cause: Moonraker's git_repo update type NEVER executes the extension's
installer. Its `install_script:` option is only parsed for apt package names
(deprecated), not run. Updates are git pull + pip + managed_services
restart. So anything install.sh does outside the repo tree (navi.json lives
in the Moonraker config dir) must ALSO be self-healed by the app itself.

Fix: the backend heals the sidebar entry at service startup — which every
update_manager update triggers via managed_services restart.

The merge semantics mirror scripts/install.sh edit_mainsail_navi exactly:
- navi.json is a JSON array of {title, href, target, position, icon}
- the KWC entry is replaced in place (single entry, current URL)
- other custom entries are preserved verbatim
- a corrupt/non-array navi.json is backed up (.bak) before replacement
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import pytest  # noqa: E402

from services.mainsail_sidebar import (  # noqa: E402
    ensure_sidebar_entry,
    resolve_mainsail_theme_dir,
    resolve_moonraker_config_dir,
    self_heal_sidebar,
)


@pytest.fixture()
def fake_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    (home / "printer_data" / "config").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    return home


def _kwc_entries(navi_path: Path):
    entries = json.loads(navi_path.read_text())
    return [e for e in entries if isinstance(e, dict) and e.get("title") == "KWC"]


def test_no_mainsail_no_write(fake_home):
    # No ~/mainsail dir and no [update_manager mainsail] in moonraker.conf:
    # nothing must be created.
    self_heal_sidebar()
    assert not (fake_home / "printer_data" / "config" / ".theme").exists()


def test_mainsail_dir_creates_entry(fake_home):
    (fake_home / "mainsail").mkdir()
    result = self_heal_sidebar(port=8099, ip_addr="192.168.1.50")
    assert result == "added"
    navi = fake_home / "printer_data" / "config" / ".theme" / "navi.json"
    entries = _kwc_entries(navi)
    assert len(entries) == 1
    entry = entries[0]
    assert entry["href"] == "http://192.168.1.50:8099"
    assert entry["target"] == "_blank"
    assert entry["position"] == 95
    assert entry["icon"].startswith("M")


def test_mainsail_via_moonraker_conf_detection(fake_home):
    (fake_home / "printer_data" / "config" / "moonraker.conf").write_text(
        "[update_manager mainsail]\ntype: git_repo\n"
    )
    result = self_heal_sidebar(port=8099, ip_addr="192.168.1.50")
    assert result == "added"


def test_idempotent_and_single_entry(fake_home):
    (fake_home / "mainsail").mkdir()
    self_heal_sidebar(port=8099, ip_addr="192.168.1.50")
    self_heal_sidebar(port=8099, ip_addr="192.168.1.50")
    navi = fake_home / "printer_data" / "config" / ".theme" / "navi.json"
    assert len(json.loads(navi.read_text())) == 1


def test_stale_href_is_repaired(fake_home):
    (fake_home / "mainsail").mkdir()
    theme = fake_home / "printer_data" / "config" / ".theme"
    theme.mkdir()
    (theme / "navi.json").write_text(json.dumps([
        {"title": "KWC", "href": "http://10.0.0.9:8099", "target": "_blank",
         "position": 95, "icon": "M0 0h1v1z"},
    ]))
    result = self_heal_sidebar(port=8099, ip_addr="192.168.1.50")
    assert result == "updated"
    entries = _kwc_entries(theme / "navi.json")
    assert len(entries) == 1
    assert entries[0]["href"] == "http://192.168.1.50:8099"


def test_other_custom_entries_preserved(fake_home):
    (fake_home / "mainsail").mkdir()
    theme = fake_home / "printer_data" / "config" / ".theme"
    theme.mkdir()
    other = {"title": "GCode History", "href": "http://x/gcode-history",
             "target": "_blank", "position": 10, "icon": "M1 1"}
    (theme / "navi.json").write_text(json.dumps([other]))
    self_heal_sidebar(port=8099, ip_addr="192.168.1.50")
    entries = json.loads((theme / "navi.json").read_text())
    assert other in entries
    assert len([e for e in entries if e.get("title") == "KWC"]) == 1


def test_corrupt_navi_backed_up_not_destroyed(fake_home):
    (fake_home / "mainsail").mkdir()
    theme = fake_home / "printer_data" / "config" / ".theme"
    theme.mkdir()
    (theme / "navi.json").write_text("{not json")
    self_heal_sidebar(port=8099, ip_addr="192.168.1.50")
    assert (theme / "navi.json.bak").read_text() == "{not json"
    assert len(_kwc_entries(theme / "navi.json")) == 1


def test_no_ip_skips(fake_home):
    # Same guard as the installer: never write a placeholder/localhost entry.
    (fake_home / "mainsail").mkdir()
    assert self_heal_sidebar(port=8099, ip_addr="") == "skipped"
    assert not (fake_home / "printer_data" / "config" / ".theme" / "navi.json").exists()


def test_no_config_dir_skips(tmp_path, monkeypatch):
    home = tmp_path / "lonely"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    (home / "mainsail").mkdir()
    assert self_heal_sidebar(port=8099, ip_addr="192.168.1.50") == "skipped"


def test_kiauh_layout_resolved(fake_home):
    # Legacy kiauh layout: ~/klipper_config instead of ~/printer_data/config.
    (fake_home / "printer_data" / "config").rmdir()
    (fake_home / "klipper_config").mkdir()
    (fake_home / "mainsail").mkdir()
    assert resolve_moonraker_config_dir() == fake_home / "klipper_config"
    assert resolve_mainsail_theme_dir() == fake_home / "klipper_config" / ".theme"
    assert self_heal_sidebar(port=8099, ip_addr="192.168.1.50") == "added"
    assert (fake_home / "klipper_config" / ".theme" / "navi.json").exists()


def test_ensure_sidebar_entry_unwritable_dir_is_noop(fake_home, monkeypatch):
    # Permission errors must never crash startup: return "failed", no raise.
    (fake_home / "mainsail").mkdir()
    theme = fake_home / "printer_data" / "config" / ".theme"
    theme.mkdir()
    monkeypatch.setattr(
        "services.mainsail_sidebar._write_navi",
        lambda *a, **k: (_ for _ in ()).throw(PermissionError("ro")),
    )
    assert ensure_sidebar_entry(theme, "http://1.2.3.4:8099") == "failed"


def test_startup_hook_runs_heal(fake_home, monkeypatch):
    # Functional: booting the app must write the sidebar entry — that is
    # what makes update_manager updates self-repairing (managed_services
    # restarts the service). End-to-end through the real ASGI lifespan.
    (fake_home / "mainsail").mkdir()
    monkeypatch.setenv("KWC_PORT", "8099")
    from fastapi.testclient import TestClient
    from main import app

    with TestClient(app):  # entering runs the lifespan startup
        pass
    navi = fake_home / "printer_data" / "config" / ".theme" / "navi.json"
    assert navi.is_file(), "app startup did not write the Mainsail sidebar entry"
    assert len(_kwc_entries(navi)) == 1
