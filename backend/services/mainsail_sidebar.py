"""Self-healing Mainsail sidebar entry for KWC.

Context (V2.6.0 user report 2026-09-03): updating KWC through Moonraker's
update_manager does NOT re-run install.sh — Moonraker's git_repo type only
does git pull + pip requirements + managed_services restart (its
`install_script:` option is merely *parsed* for apt package names, never
executed). The Mainsail sidebar link lives outside the repo (navi.json in
the Klipper config dir's .theme folder), so after an update the entry was
only restored by re-running scripts/install.sh by hand.

This module mirrors scripts/install.sh's sidebar logic (mainsail detection,
theme-dir resolution, navi.json merge semantics) so the backend can heal the
entry at every service start — and every update_manager update restarts the
service via managed_services.

All operations are best-effort: any failure is swallowed to a status string
so app startup can never break on this.
"""
from __future__ import annotations

import json
import os
import shutil
import socket
from pathlib import Path

# KWC favicon mark (frontend/public/favicon.svg) converted to a single filled
# SVG path — identical to the icon strings/install.sh writes. Coordinates
# shifted (-2,-4) from the favicon so the whole mark sits inside the 24x24
# viewBox; nav icons render monochrome with the sidebar text color.
KWC_NAV_ICON = (
    "M6 13L22 13A1 1 0 0 1 22 11L6 11A1 1 0 0 1 6 13Z"
    "M13 4L13 20A1 1 0 0 1 15 20L15 4A1 1 0 0 1 13 4Z"
    "M7.293 6.707L19.293 18.707A1 1 0 0 1 20.707 17.293L8.707 5.293A1 1 0 0 1 7.293 6.707Z"
    "M19.293 5.293L7.293 17.293A1 1 0 0 1 8.707 18.707L20.707 6.707A1 1 0 0 1 19.293 5.293Z"
    "M4 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0Z"
    "M20 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0Z"
    "M12 4a2 2 0 1 0 4 0a2 2 0 1 0 -4 0Z"
    "M12 20a2 2 0 1 0 4 0a2 2 0 1 0 -4 0Z"
)


def _home() -> Path:
    return Path(os.path.expanduser("~"))


def resolve_moonraker_config_dir() -> Path | None:
    """Locate the Klipper/Moonraker config dir (kiauh layouts, installer parity)."""
    home = _home()
    for candidate in (home / "printer_data" / "config", home / "klipper_config"):
        if candidate.is_dir():
            return candidate
    return None


def resolve_mainsail_theme_dir() -> Path | None:
    """Locate (or nominate) Mainsail's .theme folder, installer parity."""
    config_dir = resolve_moonraker_config_dir()
    if config_dir is None:
        return None
    theme = config_dir / ".theme"
    return theme


def mainsail_installed() -> bool:
    """Detect Mainsail: the checkout dir or an update_manager entry in moonraker.conf."""
    home = _home()
    if (home / "mainsail").is_dir():
        return True
    for config_dir in (home / "printer_data" / "config", home / "klipper_config"):
        moonraker_conf = config_dir / "moonraker.conf"
        try:
            if moonraker_conf.is_file() and "[update_manager mainsail]" in moonraker_conf.read_text():
                return True
        except OSError:
            continue
    return False


def detect_ip() -> str:
    """Best-effort primary LAN IP (installer uses `hostname -I | awk '{print $1}'`)."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # No packets are sent for UDP connect; this just selects the route's source IP.
        sock.connect(("8.8.8.8", 80))
        return str(sock.getsockname()[0])
    except OSError:
        return ""
    finally:
        sock.close()


def _write_navi(path: Path, entries: list) -> None:
    path.write_text(json.dumps(entries, indent=2) + "\n", encoding="utf-8")


def ensure_sidebar_entry(theme_dir: Path, url: str) -> str:
    """Merge the KWC entry into theme_dir/navi.json. Returns added|updated|failed.

    Merge semantics match install.sh edit_mainsail_navi: replace the KWC
    entry in place, preserve every other custom entry, and back up a
    corrupt/non-array file before replacing it.
    """
    navi_path = theme_dir / "navi.json"
    entries: list = []
    parseable = True
    existing_raw: str | None = None
    try:
        existing_raw = navi_path.read_text(encoding="utf-8")
        parsed = json.loads(existing_raw)
        if isinstance(parsed, list):
            entries = parsed
        else:
            parseable = False
    except FileNotFoundError:
        pass
    except (OSError, ValueError):
        parseable = False

    if not parseable:
        if existing_raw is not None:
            try:
                shutil.copy2(navi_path, str(navi_path) + ".bak")
            except OSError:
                pass
        entries = []

    before = len(entries)
    entries = [
        e for e in entries
        if not (isinstance(e, dict) and e.get("title") == "KWC")
    ]
    was_present = len(entries) != before
    entries.append({
        "title": "KWC",
        "href": url,
        "target": "_blank",
        "position": 95,
        "icon": KWC_NAV_ICON,
    })
    try:
        theme_dir.mkdir(parents=True, exist_ok=True)
        _write_navi(navi_path, entries)
    except OSError:
        return "failed"
    return "updated" if was_present else "added"


def self_heal_sidebar(port: int | None = None, ip_addr: str | None = None) -> str:
    """Heal the Mainsail sidebar entry at startup. Returns a status string.

    Statuses: added | updated | skipped | failed. Never raises.
    """
    try:
        if port is None:
            port = int(os.environ.get("KWC_PORT", "8099"))
        if not mainsail_installed():
            return "skipped"
        theme_dir = resolve_mainsail_theme_dir()
        if theme_dir is None:
            return "skipped"
        if ip_addr is None:
            ip_addr = detect_ip()
        if not ip_addr:
            # Installer parity: never write a placeholder/localhost entry —
            # a sidebar link pointing nowhere is worse than no link.
            return "skipped"
        # If the entry is already current, do not rewrite the file.
        navi_path = theme_dir / "navi.json"
        url = f"http://{ip_addr}:{port}"
        try:
            parsed = json.loads(navi_path.read_text(encoding="utf-8"))
            if isinstance(parsed, list) and any(
                isinstance(e, dict) and e.get("title") == "KWC" and e.get("href") == url
                for e in parsed
            ):
                return "skipped"
        except (OSError, ValueError):
            pass
        return ensure_sidebar_entry(theme_dir, url)
    except Exception:
        return "failed"
