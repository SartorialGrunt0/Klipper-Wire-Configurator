"""Tests for install.sh's Moonraker service allow-list handling.

Moonraker reads `moonraker.asvc` at startup and refuses to start/stop/restart a
service it does not list, so the update_manager section alone is not enough:
an update would pull the repo and then fail to restart KWC, leaving the old
code running with no visible error (observed 2026-09-30 on the reference Pi).

Only the installer's function block is sliced out and sourced — the top-level
body of install.sh would otherwise run a full install.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALL_SH = REPO_ROOT / "scripts" / "install.sh"
SERVICE_NAME = "klipper-wire-configurator"

# Mirrors the reference Pi's allow-list.
DEFAULT_ASVC = (
    "klipper_mcu\n"
    "webcamd\n"
    "MoonCord\n"
    "KlipperScreen\n"
    "moonraker-telegram-bot\n"
    "moonraker-obico\n"
    "sonar\n"
    "crowsnest\n"
    "octoeverywhere\n"
    "ratos-configurator\n"
)

HARNESS_HEADER = """#!/usr/bin/env bash
set -Eeuo pipefail
HOME="{home}"
SERVICE_NAME="{service}"
info()  {{ echo "[INFO] $*"; }}
ok()    {{ echo "[OK] $*"; }}
warn()  {{ echo "[WARN] $*"; }}
error() {{ echo "[ERROR] $*"; exit 1; }}

"""

# Declared after the sliced block so it wins over the real implementation.
RESTART_STUB = 'restart_moonraker() { echo "[RESTART] moonraker"; }\n'


def _installer_functions() -> str:
    """Everything between the first helper and on_error(), verbatim."""
    lines = INSTALL_SH.read_text(encoding="utf-8").splitlines()
    start = next(
        i for i, line in enumerate(lines) if line.startswith("is_legacy_user_service_active()")
    )
    end = next(i for i, line in enumerate(lines) if line.startswith("on_error()"))
    return "\n".join(lines[start:end])


def run_case(
    tmp_path: Path, body: str, asvc_content: str | None
) -> tuple[subprocess.CompletedProcess[str], Path]:
    home = tmp_path / "home"
    (home / "printer_data" / "config").mkdir(parents=True, exist_ok=True)
    asvc_path = home / "printer_data" / "moonraker.asvc"
    if asvc_content is not None:
        asvc_path.write_text(asvc_content)

    script = tmp_path / "harness.sh"
    script.write_text(
        HARNESS_HEADER.format(home=home, service=SERVICE_NAME)
        + _installer_functions()
        + "\n\n"
        + RESTART_STUB
        + body
    )

    env = dict(os.environ)
    env["HOME"] = str(home)
    proc = subprocess.run(
        ["bash", str(script)], capture_output=True, text=True, env=env, timeout=60
    )
    return proc, asvc_path


def test_add_appends_the_service(tmp_path: Path) -> None:
    proc, asvc = run_case(
        tmp_path, "edit_moonraker_allowed_services add\napply_moonraker_changes\n", DEFAULT_ASVC
    )

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert asvc.read_text().splitlines() == DEFAULT_ASVC.splitlines() + [SERVICE_NAME]
    assert "Added" in proc.stdout
    # Moonraker only reads the file at startup, so the change must restart it
    assert proc.stdout.count("[RESTART]") == 1


def test_add_is_idempotent(tmp_path: Path) -> None:
    listed = DEFAULT_ASVC + SERVICE_NAME + "\n"
    proc, asvc = run_case(
        tmp_path, "edit_moonraker_allowed_services add\napply_moonraker_changes\n", listed
    )

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert asvc.read_text() == listed
    # nothing changed, so Moonraker is not restarted
    assert "[RESTART]" not in proc.stdout


def test_add_twice_in_one_run_only_restarts_once(tmp_path: Path) -> None:
    proc, asvc = run_case(
        tmp_path,
        "edit_moonraker_allowed_services add\n"
        "edit_moonraker_allowed_services add\n"
        "apply_moonraker_changes\n",
        DEFAULT_ASVC,
    )

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert asvc.read_text().splitlines().count(SERVICE_NAME) == 1
    assert proc.stdout.count("[RESTART]") == 1


def test_add_terminates_a_missing_final_newline(tmp_path: Path) -> None:
    proc, asvc = run_case(
        tmp_path, "edit_moonraker_allowed_services add\n", "crowsnest\nklipper_mcu"
    )

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert asvc.read_text().splitlines() == ["crowsnest", "klipper_mcu", SERVICE_NAME]


def test_add_does_not_duplicate_a_dot_service_entry(tmp_path: Path) -> None:
    listed = DEFAULT_ASVC + f"{SERVICE_NAME}.service\n"
    proc, asvc = run_case(tmp_path, "edit_moonraker_allowed_services add\n", listed)

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert asvc.read_text() == listed
    assert "[RESTART]" not in proc.stdout


def test_remove_drops_only_the_service_line(tmp_path: Path) -> None:
    proc, asvc = run_case(
        tmp_path,
        "edit_moonraker_allowed_services remove\napply_moonraker_changes\n",
        DEFAULT_ASVC + SERVICE_NAME + "\n",
    )

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert asvc.read_text().splitlines() == DEFAULT_ASVC.splitlines()
    assert proc.stdout.count("[RESTART]") == 1


def test_remove_also_drops_a_dot_service_entry(tmp_path: Path) -> None:
    proc, asvc = run_case(
        tmp_path, "edit_moonraker_allowed_services remove\n", f"{SERVICE_NAME}.service\ncrowsnest\n"
    )

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert asvc.read_text().splitlines() == ["crowsnest"]


def test_remove_on_a_file_without_the_entry_is_a_no_op(tmp_path: Path) -> None:
    proc, asvc = run_case(
        tmp_path, "edit_moonraker_allowed_services remove\napply_moonraker_changes\n", DEFAULT_ASVC
    )

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert asvc.read_text() == DEFAULT_ASVC
    assert "[RESTART]" not in proc.stdout


def test_missing_allow_list_warns_and_creates_nothing(tmp_path: Path) -> None:
    proc, asvc = run_case(tmp_path, "edit_moonraker_allowed_services add\n", None)

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "Could not find moonraker.asvc" in proc.stdout
    # Creating it ourselves would drop Moonraker's own defaults
    assert not asvc.exists()
