"""Tests for the Klipper config-path resolution shared by native mode,
the AI user-config tools (mcp_server.SYSTEM_CONFIG_PATH), and the docs
native-deploy marker (klipper_paths.DEPLOYMENT_CONFIG_PATH).

Priority: KLIPPER_CONFIG_PATH env override > modern ~/printer_data/config
> legacy /home/pi/.klipper/config.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import klipper_paths  # noqa: E402


def test_env_override_wins(tmp_path, monkeypatch):
    override = tmp_path / "override"
    override.mkdir()
    monkeypatch.setenv("KLIPPER_CONFIG_PATH", str(override))
    # Even when a modern layout exists, the explicit override wins.
    modern = tmp_path / "modern"
    modern.mkdir()
    monkeypatch.setattr(klipper_paths, "get_default_config_path", lambda: str(modern))
    # Even when a saved native setting exists, the env override wins.
    saved = tmp_path / "saved"
    saved.mkdir()
    monkeypatch.setattr(klipper_paths, "load_settings", lambda: {"config_path": str(saved)})
    assert klipper_paths.resolve_config_path() == override


def test_prefers_modern_layout(tmp_path, monkeypatch):
    modern = tmp_path / "printer_data" / "config"
    modern.mkdir(parents=True)
    monkeypatch.setattr(klipper_paths, "get_default_config_path", lambda: str(modern))
    # No saved override -> modern layout.
    monkeypatch.setattr(klipper_paths, "load_settings", lambda: {"config_path": str(modern)})
    monkeypatch.delenv("KLIPPER_CONFIG_PATH", raising=False)
    assert klipper_paths.resolve_config_path() == modern


def test_saved_native_setting_wins_over_modern(tmp_path, monkeypatch):
    # The user picked a custom path in the "Open from Pi" menu (settings.json
    # has a config_path different from the modern default) — it must win over
    # the automatic modern layout so the AI tools scan the same directory the
    # native file browser uses.
    modern = tmp_path / "printer_data" / "config"
    modern.mkdir(parents=True)
    saved = tmp_path / "custom_config"
    saved.mkdir()
    monkeypatch.setattr(klipper_paths, "get_default_config_path", lambda: str(modern))
    monkeypatch.setattr(klipper_paths, "load_settings", lambda: {"config_path": str(saved)})
    monkeypatch.delenv("KLIPPER_CONFIG_PATH", raising=False)
    assert klipper_paths.resolve_config_path() == saved


def test_saved_native_setting_equal_to_default_falls_through(tmp_path, monkeypatch):
    # settings.json may hold the default value explicitly; it must not change
    # resolution (modern layout when present, legacy fallback otherwise).
    modern = tmp_path / "printer_data" / "config"
    modern.mkdir(parents=True)
    monkeypatch.setattr(klipper_paths, "get_default_config_path", lambda: str(modern))
    monkeypatch.setattr(klipper_paths, "load_settings", lambda: {"config_path": str(modern)})
    monkeypatch.delenv("KLIPPER_CONFIG_PATH", raising=False)
    assert klipper_paths.resolve_config_path() == modern


def test_falls_back_to_legacy_layout(tmp_path, monkeypatch):
    # Modern layout missing (e.g. dev checkout) -> legacy path, even though
    # it also does not exist, preserving "no system configs" behavior.
    missing = tmp_path / "nope"
    monkeypatch.setattr(klipper_paths, "get_default_config_path", lambda: str(missing))
    # Saved setting absent/equal to default -> legacy fallback applies.
    monkeypatch.setattr(klipper_paths, "load_settings", lambda: {"config_path": str(missing)})
    monkeypatch.delenv("KLIPPER_CONFIG_PATH", raising=False)
    assert klipper_paths.resolve_config_path() == Path("/home/pi/.klipper/config")
