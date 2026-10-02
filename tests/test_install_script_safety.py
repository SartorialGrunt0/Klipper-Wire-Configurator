"""Installer safety tests for paths this repo has failed on before.

Covers the two helpers that keep a failed bundle swap from being reported as a
success, and the lock-file restoration in the npm recovery path:

  * the staged-swap helpers must be byte-identical in scripts/install.sh and
    scripts/run-service.sh — they are a copy, and copies drift;
  * recover_frontend_build deletes the TRACKED frontend/package-lock.json, so
    it must restore it on the failure path too. Leaving it deleted dirties the
    checkout (aborting every later installer run at the clean-tree gate) and
    breaks `npm ci` in the service's rebuild-on-start.

The installer's functions are sliced by ANCHOR rather than line number so the
tests survive edits above them. Two slices are needed: the helper block above
`on_error()` (definitions only), and the swap block below it, which sits in the
top-level body and must stop before `info "Installing frontend dependencies..."`.
"""

from __future__ import annotations

import os
import subprocess
import textwrap
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALL_SH = REPO_ROOT / "scripts" / "install.sh"
RUN_SERVICE = REPO_ROOT / "scripts" / "run-service.sh"

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

FAKE_NPM = """#!/usr/bin/env bash
case "$1" in
    install) exit 0 ;;
    run)
        if [ "${FAKE_NPM_BUILD_EXIT:-0}" != "0" ]; then
            echo "fake npm: build failed on purpose" >&2
            exit "${FAKE_NPM_BUILD_EXIT}"
        fi
        out=""
        shift
        while [ "$#" -gt 0 ]; do
            case "$1" in
                --outDir) out="$2"; shift 2 ;;
                *) shift ;;
            esac
        done
        [ -n "$out" ] || { echo "fake npm: no --outDir passed" >&2; exit 2; }
        mkdir -p "$out/assets"
        printf 'NEW BUNDLE' > "$out/index.html"
        exit 0
        ;;
esac
exit 0
"""


def _lines(path: Path) -> list[str]:
    return path.read_text().splitlines()


def extract_function(path: Path, name: str) -> str:
    """A function's full text, including the comment block above it."""
    lines = _lines(path)
    fn_start = next(
        i for i, line in enumerate(lines) if line.startswith(f"{name}()")
    )
    # Count braces from the FUNCTION line: the comments above it contain none,
    # so starting the count there would end the block immediately.
    depth = 0
    end = fn_start
    while True:
        depth += lines[end].count("{") - lines[end].count("}")
        end += 1
        if depth == 0:
            break
    start = fn_start
    while start > 0 and lines[start - 1].startswith("#"):
        start -= 1
    return "\n".join(lines[start:end])


def slice_helper_block() -> str:
    """install.sh's function definitions, up to on_error() and no further."""
    lines = _lines(INSTALL_SH)
    start = next(
        i
        for i, line in enumerate(lines)
        if line.startswith("is_legacy_user_service_active()")
    )
    end = next(i for i, line in enumerate(lines) if line.startswith("on_error()"))
    return "\n".join(lines[start:end])


def slice_swap_block() -> str:
    """The staged-build helpers, which live in the top-level body region."""
    lines = _lines(INSTALL_SH)
    start = next(
        i for i, line in enumerate(lines) if line.startswith("swap_staged_bundle()")
    )
    while start > 0 and lines[start - 1].startswith("#"):
        start -= 1
    end = next(
        i
        for i, line in enumerate(lines)
        if line.startswith('info "Installing frontend dependencies..."')
    )
    return "\n".join(lines[start:end])


def test_the_swap_helpers_are_identical_in_both_scripts() -> None:
    """They are a deliberate copy; an edit to one alone is a silent divergence."""
    for name in ("swap_staged_bundle", "restore_previous_bundle_if_needed"):
        assert extract_function(INSTALL_SH, name) == extract_function(RUN_SERVICE, name), (
            f"{name}() has drifted between scripts/install.sh and "
            f"scripts/run-service.sh — they are documented as byte-identical"
        )


def run_recover_case(tmp_path: Path, build_exit: int) -> tuple[subprocess.CompletedProcess[str], Path]:
    home = tmp_path / "home"
    repo = home / "kwc"
    frontend = repo / "frontend"
    frontend.mkdir(parents=True)
    (frontend / "package.json").write_text('{"name": "kwc"}')
    (frontend / "package-lock.json").write_text('{"lockfileVersion": 3}')

    for args in (
        ["git", "init", "-q"],
        ["git", "add", "-A"],
        ["git", "-c", "user.email=t@example.invalid", "-c", "user.name=t",
         "commit", "-qm", "init"],
    ):
        subprocess.run(args, cwd=repo, check=True, capture_output=True)

    bindir = tmp_path / "bin"
    bindir.mkdir()
    npm = bindir / "npm"
    npm.write_text(FAKE_NPM)
    npm.chmod(0o755)

    script = tmp_path / "harness.sh"
    script.write_text(
        HEADER
        + slice_swap_block()
        + "\nrc=0\nrecover_frontend_build || rc=$?\necho \"rc=$rc\"\n"
    )

    env = dict(os.environ)
    env["HOME"] = str(home)
    env["PATH"] = f"{bindir}:{env['PATH']}"
    env["FAKE_NPM_BUILD_EXIT"] = str(build_exit)
    proc = subprocess.run(
        ["bash", str(script)], capture_output=True, text=True, env=env, timeout=60
    )
    return proc, frontend


def test_recover_frontend_build_restores_the_lock_file_when_it_fails(tmp_path: Path) -> None:
    """The failure path is the one this function exists for — the lock file must
    come back anyway, or the next installer run aborts on a dirty tree."""
    proc, frontend = run_recover_case(tmp_path, build_exit=1)
    output = proc.stdout + proc.stderr

    assert "rc=1" in proc.stdout, output
    assert (frontend / "package-lock.json").exists(), (
        "package-lock.json was left deleted after a failed recovery build"
    )

    status = subprocess.run(
        ["git", "status", "--porcelain"], cwd=frontend, capture_output=True, text=True
    ).stdout.strip()
    assert status == "", f"checkout left dirty after a failed recovery: {status!r}"


def test_recover_frontend_build_restores_the_lock_file_when_it_succeeds(tmp_path: Path) -> None:
    proc, frontend = run_recover_case(tmp_path, build_exit=0)
    output = proc.stdout + proc.stderr

    assert "rc=0" in proc.stdout, output
    assert (frontend / "package-lock.json").exists()
