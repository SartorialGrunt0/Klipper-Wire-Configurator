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
import time
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
    # The opening brace may be on the header line or the next one; count from
    # whichever line actually carries it, so a restyle cannot truncate the
    # block to its comment header (which would make the parity test compare two
    # comment blocks and pass forever).
    header = fn_start
    if "{" not in lines[header]:
        header += 1
    depth = 0
    end = header
    while True:
        depth += lines[end].count("{") - lines[end].count("}")
        end += 1
        if depth == 0:
            break
    start = fn_start
    while start > 0 and lines[start - 1].startswith("#"):
        start -= 1
    block = "\n".join(lines[start:end])
    # Refuse to compare something that cannot be a function body: a slicer that
    # silently returns a fragment turns every assertion built on it into a
    # tautology.
    assert len(block.splitlines()) > 5, f"extraction of {name}() is too small: {block!r}"
    assert block.rstrip().endswith("}"), f"extraction of {name}() is unterminated"
    return block


def slice_keepalive_block() -> str:
    """The sudo-keepalive definitions, which sit below on_error()."""
    lines = _lines(INSTALL_SH)
    start = next(
        i for i, line in enumerate(lines) if line.startswith('SUDO_KEEPALIVE_PID=""')
    )
    end = next(i for i, line in enumerate(lines) if line.startswith("SCRIPT_DIR="))
    return "\n".join(lines[start:end])


def slice_dependency_install_block() -> str:
    """The top-level `npm ci` -> `npm install` fallback."""
    lines = _lines(INSTALL_SH)
    start = next(
        i
        for i, line in enumerate(lines)
        if line.startswith('info "Installing frontend dependencies..."')
    )
    end = next(
        i
        for i, line in enumerate(lines)
        if line.startswith('info "Building frontend (this may take')
    )
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


def run_or_recover_case(tmp_path: Path, *, torn: bool) -> tuple[subprocess.CompletedProcess[str], Path]:
    """build_frontend_or_recover with a build that always fails."""
    home = tmp_path / "home"
    repo = home / "kwc"
    frontend = repo / "frontend"
    frontend.mkdir(parents=True)
    (frontend / "package.json").write_text('{"name": "kwc"}')
    (frontend / "package-lock.json").write_text('{"lockfileVersion": 3}')

    if torn:
        # A torn swap: dist is gone and the only good bundle is in dist.previous.
        (frontend / "dist.previous").mkdir()
        (frontend / "dist.previous" / "index.html").write_text("OLD BUNDLE")
    else:
        (frontend / "dist").mkdir()
        (frontend / "dist" / "index.html").write_text("OLD BUNDLE")

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
        + "\nrc=0\nbuild_frontend_or_recover || rc=$?\necho \"rc=$rc\"\n"
    )

    env = dict(os.environ)
    env["HOME"] = str(home)
    env["PATH"] = f"{bindir}:{env['PATH']}"
    env["FAKE_NPM_BUILD_EXIT"] = "1"
    proc = subprocess.run(
        ["bash", str(script)], capture_output=True, text=True, env=env, timeout=60
    )
    return proc, frontend


def test_build_failure_leaves_a_working_bundle_when_the_swap_had_torn(tmp_path: Path) -> None:
    """The install-time half of the stranded-bundle fix.

    install.sh's recovery path must put back a bundle stranded in dist.previous
    before it reports failure, so the service has something to serve.
    """
    proc, frontend = run_or_recover_case(tmp_path, torn=True)
    output = proc.stdout + proc.stderr

    assert "rc=1" in proc.stdout, output
    assert (frontend / "dist" / "index.html").read_text() == "OLD BUNDLE"
    assert not (frontend / "dist.previous").exists()


def test_build_failure_leaves_an_existing_bundle_untouched(tmp_path: Path) -> None:
    proc, frontend = run_or_recover_case(tmp_path, torn=False)
    output = proc.stdout + proc.stderr

    assert "rc=1" in proc.stdout, output
    assert (frontend / "dist" / "index.html").read_text() == "OLD BUNDLE"


def test_a_double_dependency_failure_does_not_abort_the_install(tmp_path: Path) -> None:
    """Only the `if` CONDITION is errexit-exempt, not its then-block.

    When `npm ci` and the `npm install` fallback both failed, the unguarded
    fallback call ran with errexit active and aborted the installer before the
    systemd service was installed — the same red line the build stage was fixed
    for. A network outage on the Pi is enough to reach it.
    """
    home = tmp_path / "home"
    (home / "kwc" / "frontend").mkdir(parents=True)

    bindir = tmp_path / "bin"
    bindir.mkdir()
    npm = bindir / "npm"
    npm.write_text('#!/usr/bin/env bash\necho "fake npm: FAIL $*" >&2\nexit 1\n')
    npm.chmod(0o755)

    script = tmp_path / "harness.sh"
    script.write_text(
        HEADER
        + slice_swap_block()
        + slice_dependency_install_block()
        + '\necho "REACHED-END"\n'
    )

    env = dict(os.environ)
    env["HOME"] = str(home)
    env["PATH"] = f"{bindir}:{env['PATH']}"
    proc = subprocess.run(
        ["bash", str(script)], capture_output=True, text=True, env=env, timeout=60
    )

    output = proc.stdout + proc.stderr
    assert proc.returncode == 0, output
    assert "REACHED-END" in proc.stdout, f"the install aborted early:\n{output}"
    assert "Could not install the frontend dependencies." in output


def test_sigterm_still_kills_the_installer_promptly(tmp_path: Path) -> None:
    """The keepalive must not install an INT/TERM trap.

    Bash defers a trapped signal until the running foreground command finishes,
    so trapping TERM would make a 20-minute apt/pip/npm run ignore SIGTERM
    entirely — strictly worse than no trap, which kills the shell at once. An
    orphaned keepalive is instead bounded by the loop's parent check.
    """
    bindir = tmp_path / "bin"
    bindir.mkdir()
    sudo = bindir / "sudo"
    sudo.write_text("#!/usr/bin/env bash\nexit 0\n")
    sudo.chmod(0o755)

    script = tmp_path / "keepalive.sh"
    script.write_text(
        HEADER + slice_keepalive_block() + "\nstart_sudo_keepalive\nsleep 30\n"
    )

    env = dict(os.environ)
    env["PATH"] = f"{bindir}:{env['PATH']}"
    env["KWC_SUDO_KEEPALIVE_INTERVAL"] = "30"

    proc = subprocess.Popen(
        ["bash", str(script)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    try:
        time.sleep(1.0)
        proc.terminate()
        started = time.monotonic()
        try:
            proc.wait(timeout=6)
            exited = True
        except subprocess.TimeoutExpired:
            exited = False
        elapsed = time.monotonic() - started
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()

    assert exited, "the installer ignored SIGTERM while a foreground command was running"
    assert elapsed < 5, f"SIGTERM took {elapsed:.1f}s to take effect"


def test_the_sudo_keepalive_does_not_delay_the_exit_path(tmp_path: Path) -> None:
    """The keepalive loop must not hold the logging pipe open.

    install.sh's stdout is an `exec > >(tee ...)` pipe. If the loop's `sleep`
    inherits it, killing the loop leaves that `sleep` holding the write end, tee
    never sees EOF, and every run is delayed by up to a full interval at exit
    (measured 60.0s before the redirect, 3.0s after). stdout here is a pipe too,
    exactly as under `curl | bash`.
    """
    bindir = tmp_path / "bin"
    bindir.mkdir()
    sudo = bindir / "sudo"
    sudo.write_text("#!/usr/bin/env bash\nexit 0\n")
    sudo.chmod(0o755)

    script = tmp_path / "keepalive.sh"
    script.write_text(
        HEADER + slice_keepalive_block() + "\nstart_sudo_keepalive\nsleep 1\n"
    )

    env = dict(os.environ)
    env["PATH"] = f"{bindir}:{env['PATH']}"
    # Short enough to keep the test fast, long enough that an inherited pipe
    # would still be held open well past the assertion below.
    env["KWC_SUDO_KEEPALIVE_INTERVAL"] = "30"

    started = time.monotonic()
    proc = subprocess.run(
        ["bash", str(script)], capture_output=True, text=True, env=env, timeout=120
    )
    elapsed = time.monotonic() - started

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert elapsed < 15, f"the exit path was delayed by {elapsed:.1f}s"
