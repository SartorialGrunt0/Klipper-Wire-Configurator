"""Tests for install.sh's Moonraker update_manager include handling.

The include line is appended to the user's own moonraker.conf, which the
installer does not own. Appending to a file whose last line has no trailing
newline merges the directive into it — corrupting the user's config and leaving
text that --uninstall's anchored sed can never match, so the installer's change
could never be undone. ensure_trailing_newline exists for exactly this.

Note on the allow-list: there is deliberately NO moonraker.asvc handling here
(see the NOTE in scripts/install.sh). Moonraker's is_service_allowed() permits
any service matching ^klipper[_-]?\\d* regardless of that file, so an entry has
never been required for klipper-wire-configurator.
"""

from __future__ import annotations

import os
import subprocess
import textwrap
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALL_SH = REPO_ROOT / "scripts" / "install.sh"

INCLUDE_LINE = "[include klipper-wire-configurator-update.cfg]"
INCLUDE_FILE = "klipper-wire-configurator-update.cfg"

HEADER = textwrap.dedent(
    """\
    set -Eeuo pipefail
    info()  { echo "[INFO] $*"; }
    ok()    { echo "[OK] $*"; }
    warn()  { echo "[WARN] $*"; }
    error() { echo "[ERROR] $*"; exit 1; }
    SERVICE_NAME="klipper-wire-configurator"
    KWC_PORT=8099
    INSTALL_DIR="$HOME/kwc"
    REPO_URL="https://example.invalid/Klipper-Wire-Configurator.git"
    """
)

BODY = textwrap.dedent(
    """\
    # Defined AFTER the slice so it overrides the installer's real one, which
    # would otherwise shell out to systemctl.
    restart_moonraker() { echo "[RESTART] moonraker"; }

    install_moonraker_updater
    apply_moonraker_changes

    install_moonraker_updater
    apply_moonraker_changes

    remove_moonraker_updater
    apply_moonraker_changes
    """
)

# A hand-edited config with no final newline — how the merge happens.
CONF_NO_NEWLINE = "[server]\nhost: 0.0.0.0\n[virtual_sdcard]\npath: ~/gcode_files"
EXPECTED_LINES = ["[server]", "host: 0.0.0.0", "[virtual_sdcard]", "path: ~/gcode_files"]


def slice_installer_functions() -> str:
    """install.sh's function definitions, up to on_error() and no further."""
    lines = INSTALL_SH.read_text().splitlines()
    start = next(
        i
        for i, line in enumerate(lines)
        if line.startswith("is_legacy_user_service_active()")
    )
    end = next(i for i, line in enumerate(lines) if line.startswith("on_error()"))
    return "\n".join(lines[start:end])


def run_case(tmp_path: Path, conf_text: str) -> tuple[subprocess.CompletedProcess[str], Path, Path]:
    home = tmp_path / "home"
    config_dir = home / "printer_data" / "config"
    config_dir.mkdir(parents=True)
    conf = config_dir / "moonraker.conf"
    conf.write_text(conf_text)

    script = tmp_path / "harness.sh"
    script.write_text(HEADER + slice_installer_functions() + "\n" + BODY)

    env = dict(os.environ)
    env["HOME"] = str(home)
    proc = subprocess.run(
        ["bash", str(script)], capture_output=True, text=True, env=env, timeout=60
    )
    return proc, conf, config_dir / INCLUDE_FILE


def test_include_line_starts_a_new_line_and_uninstall_reverses_it(tmp_path: Path) -> None:
    proc, conf, include_file = run_case(tmp_path, CONF_NO_NEWLINE)
    output = proc.stdout + proc.stderr

    assert proc.returncode == 0, output

    # install → uninstall returns the user's file to exactly its original lines.
    remaining = conf.read_text().splitlines()
    assert remaining == EXPECTED_LINES, (
        f"the user's moonraker.conf was not restored: {remaining!r}"
    )
    assert not include_file.exists(), "the include file survived --uninstall"


def test_include_line_is_not_merged_into_the_users_last_line(tmp_path: Path) -> None:
    """The regression: without ensure_trailing_newline the last line becomes
    'path: ~/gcode_files[include ...]' and the include never takes effect."""
    proc, conf, _ = run_case(tmp_path, CONF_NO_NEWLINE)
    output = proc.stdout + proc.stderr
    assert proc.returncode == 0, output

    # Re-run just the install half and inspect the file before removal.
    home = tmp_path / "home2"
    config_dir = home / "printer_data" / "config"
    config_dir.mkdir(parents=True)
    conf2 = config_dir / "moonraker.conf"
    conf2.write_text(CONF_NO_NEWLINE)

    script = tmp_path / "harness2.sh"
    script.write_text(
        HEADER
        + slice_installer_functions()
        + textwrap.dedent(
            """\

            restart_moonraker() { echo "[RESTART] moonraker"; }
            install_moonraker_updater
            apply_moonraker_changes
            """
        )
    )
    env = dict(os.environ)
    env["HOME"] = str(home)
    proc2 = subprocess.run(
        ["bash", str(script)], capture_output=True, text=True, env=env, timeout=60
    )
    assert proc2.returncode == 0, proc2.stdout + proc2.stderr

    lines = conf2.read_text().splitlines()
    assert lines == EXPECTED_LINES + [INCLUDE_LINE], (
        f"the include line is not on its own line: {lines!r}"
    )
    assert (config_dir / INCLUDE_FILE).exists()


def test_a_no_op_run_does_not_restart_moonraker(tmp_path: Path) -> None:
    proc, _, _ = run_case(tmp_path, CONF_NO_NEWLINE + "\n")
    output = proc.stdout + proc.stderr

    assert proc.returncode == 0, output
    # One restart for the install, none for the identical second run, one for
    # the uninstall.
    assert output.count("[RESTART] moonraker") == 2, output


def test_a_config_that_already_ends_with_a_newline_is_untouched(tmp_path: Path) -> None:
    proc, conf, _ = run_case(tmp_path, CONF_NO_NEWLINE + "\n")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert conf.read_text().splitlines() == EXPECTED_LINES


def test_a_removal_that_cannot_happen_warns_and_does_not_restart(tmp_path: Path) -> None:
    """`changed=1` must mean "we changed something", not "we tried".

    Regression: the flag was set before the write was attempted, so a removal
    that could not happen still restarted Moonraker and --uninstall reported a
    cleanup it never performed.
    """
    home = tmp_path / "home"
    config_dir = home / "printer_data" / "config"
    config_dir.mkdir(parents=True)
    conf = config_dir / "moonraker.conf"
    conf.write_text("[server]\nhost: 0.0.0.0\n" + INCLUDE_LINE + "\n")
    include_file = config_dir / INCLUDE_FILE
    include_file.write_text("[update_manager klipper-wire-configurator]\n")

    bindir = tmp_path / "bin"
    bindir.mkdir()
    # Fail the tools rather than the permissions: a read-only directory is only
    # read-only for an unprivileged uid, so a chmod-based barrier would silently
    # stop testing anything if this ever ran as root.
    for name in ("sudo", "rm", "sed"):
        stub = bindir / name
        stub.write_text("#!/usr/bin/env bash\nexit 1\n")
        stub.chmod(0o755)

    script = tmp_path / "harness.sh"
    script.write_text(
        HEADER
        + slice_installer_functions()
        + textwrap.dedent(
            """\

            restart_moonraker() { echo "[RESTART] moonraker"; }
            remove_moonraker_updater
            apply_moonraker_changes
            """
        )
    )

    env = dict(os.environ)
    env["HOME"] = str(home)
    env["PATH"] = f"{bindir}:{env['PATH']}"

    proc = subprocess.run(
        ["bash", str(script)], capture_output=True, text=True, env=env, timeout=60
    )

    output = proc.stdout + proc.stderr
    assert proc.returncode == 0, output
    assert "[RESTART] moonraker" not in output, "restarted for a removal that never happened"
    assert "Could not remove" in output
    assert "Could not remove the include line" in output
    assert include_file.exists()
    assert INCLUDE_LINE in conf.read_text()
