"""Functional tests for scripts/run-service.sh.

That script is the only thing that runs after a Moonraker update_manager
update (its git_repo handler pulls the repo and restarts the service; it never
executes install.sh), so the frontend rebuild it performs decides whether an
update can take the app down. These tests run the real script against a
throwaway checkout with fake `npm` and `uvicorn` binaries on PATH:

  * a successful rebuild swaps the bundle atomically, keeping the old one;
  * a FAILED rebuild still starts the app on the existing bundle (field
    failure 2026-10-01: the unit crash-looped instead and KWC stayed down);
  * the low-memory Node heap guard is applied only on small hosts;
  * a current bundle is not rebuilt at all.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
RUN_SERVICE = REPO_ROOT / "scripts" / "run-service.sh"

FAKE_NPM = """#!/usr/bin/env bash
echo "npm $*" >> "$FAKE_NPM_LOG"
echo "NODE_OPTIONS=${NODE_OPTIONS:-<unset>}" >> "$FAKE_NPM_LOG"
if [ "$1" = "ci" ]; then
    exit "${FAKE_NPM_CI_EXIT:-0}"
fi
out=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --outDir) out="$2"; shift 2 ;;
        *) shift ;;
    esac
done
if [ -z "$out" ]; then
    echo "fake npm: no --outDir passed" >&2
    exit 2
fi
if [ "${FAKE_NPM_BUILD_EXIT:-0}" != "0" ]; then
    echo "fake npm: build failed on purpose" >&2
    exit "${FAKE_NPM_BUILD_EXIT}"
fi
mkdir -p "$out/assets"
printf 'NEW BUNDLE' > "$out/index.html"
printf 'console.log(1);' > "$out/assets/index-newhash.js"
"""

FAKE_UVICORN = """#!/usr/bin/env bash
echo "UVICORN STARTED $*"
"""


def make_checkout(tmp_path: Path, *, bundle_age_s: int = 3600) -> Path:
    """A throwaway KWC checkout whose frontend sources are newer than dist."""
    repo = tmp_path / "repo"
    (repo / "scripts").mkdir(parents=True)
    shutil.copy2(RUN_SERVICE, repo / "scripts" / "run-service.sh")
    (repo / "backend").mkdir()

    frontend = repo / "frontend"
    for sub in ("src", "public", "scripts", "node_modules"):
        (frontend / sub).mkdir(parents=True)
    (frontend / "index.html").write_text("<html></html>")
    (frontend / "package.json").write_text('{"name": "kwc", "version": "0.0.0"}')
    (frontend / "src" / "App.tsx").write_text("export const App = 1;\n")

    dist = frontend / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("OLD BUNDLE")
    if bundle_age_s:
        stamp = time.time() - bundle_age_s
        os.utime(dist / "index.html", (stamp, stamp))

    uvicorn = repo / "venv" / "bin" / "uvicorn"
    uvicorn.parent.mkdir(parents=True)
    uvicorn.write_text(FAKE_UVICORN)
    uvicorn.chmod(0o755)
    return repo


def run_service(
    repo: Path, tmp_path: Path, **env_overrides: str
) -> tuple[subprocess.CompletedProcess[str], str]:
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    npm = bindir / "npm"
    npm.write_text(FAKE_NPM)
    npm.chmod(0o755)

    npm_log = tmp_path / "npm.log"
    npm_log.write_text("")

    env = dict(os.environ)
    env["PATH"] = f"{bindir}:{env['PATH']}"
    env["FAKE_NPM_LOG"] = str(npm_log)
    env["KWC_PORT"] = "8099"
    env.pop("NODE_OPTIONS", None)
    env.update(env_overrides)

    proc = subprocess.run(
        ["bash", str(repo / "scripts" / "run-service.sh")],
        capture_output=True,
        text=True,
        cwd=str(repo),
        env=env,
        timeout=180,
    )
    return proc, npm_log.read_text()


def test_successful_rebuild_swaps_bundle_and_keeps_previous(tmp_path: Path) -> None:
    repo = make_checkout(tmp_path)
    proc, _ = run_service(repo, tmp_path)
    output = proc.stdout + proc.stderr

    assert proc.returncode == 0, output
    assert "UVICORN STARTED" in proc.stdout
    assert "Frontend bundle updated." in proc.stdout

    frontend = repo / "frontend"
    assert (frontend / "dist" / "index.html").read_text() == "NEW BUNDLE"
    assert (frontend / "dist.previous" / "index.html").read_text() == "OLD BUNDLE"
    assert not (frontend / "dist.next").exists()
    # the build ran under the shared lock
    assert (frontend / ".kwc-build.lock").exists()


def test_failed_rebuild_still_starts_the_app(tmp_path: Path) -> None:
    repo = make_checkout(tmp_path)
    proc, _ = run_service(repo, tmp_path, FAKE_NPM_BUILD_EXIT="1")
    output = proc.stdout + proc.stderr

    assert proc.returncode == 0, output
    assert "UVICORN STARTED" in proc.stdout
    assert "Frontend rebuild failed" in output
    assert "existing bundle" in output

    frontend = repo / "frontend"
    assert (frontend / "dist" / "index.html").read_text() == "OLD BUNDLE"
    assert not (frontend / "dist.next").exists()
    assert not (frontend / "dist.previous").exists()


def test_failed_npm_ci_still_starts_the_app(tmp_path: Path) -> None:
    repo = make_checkout(tmp_path)
    frontend = repo / "frontend"
    # package-lock.json newer than node_modules forces the npm ci path
    (frontend / "package-lock.json").write_text("{}")
    stale = time.time() - 3600
    os.utime(frontend / "node_modules", (stale, stale))

    proc, _ = run_service(repo, tmp_path, FAKE_NPM_CI_EXIT="1")
    output = proc.stdout + proc.stderr

    assert proc.returncode == 0, output
    assert "UVICORN STARTED" in proc.stdout
    assert "npm ci failed." in output
    assert (frontend / "dist" / "index.html").read_text() == "OLD BUNDLE"


def test_missing_bundle_still_starts_and_warns(tmp_path: Path) -> None:
    repo = make_checkout(tmp_path)
    shutil.rmtree(repo / "frontend" / "dist")

    proc, _ = run_service(repo, tmp_path, FAKE_NPM_BUILD_EXIT="1")
    output = proc.stdout + proc.stderr

    assert proc.returncode == 0, output
    assert "UVICORN STARTED" in proc.stdout
    assert "the web UI will be unavailable" in output


def test_current_bundle_is_not_rebuilt(tmp_path: Path) -> None:
    repo = make_checkout(tmp_path, bundle_age_s=0)
    proc, npm_log = run_service(repo, tmp_path)

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "Building frontend bundle..." not in proc.stdout
    assert npm_log.strip() == ""
    assert (repo / "frontend" / "dist" / "index.html").read_text() == "OLD BUNDLE"


def test_low_memory_host_raises_the_node_heap(tmp_path: Path) -> None:
    repo = make_checkout(tmp_path)
    meminfo = tmp_path / "meminfo"
    # 424 MB RAM + 1024 MB swap, the Pi Zero 2 W that hit the ceiling
    meminfo.write_text("MemTotal:         434176 kB\nSwapTotal:       1048576 kB\n")

    proc, npm_log = run_service(repo, tmp_path, KWC_MEMINFO_FILE=str(meminfo))

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "Low-memory device (1448 MB RAM+swap): Node heap raised to 724 MB." in proc.stdout
    assert "--max-old-space-size=724" in npm_log


def test_roomy_host_leaves_the_node_heap_alone(tmp_path: Path) -> None:
    repo = make_checkout(tmp_path)
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemTotal:        8123456 kB\nSwapTotal:       2097152 kB\n")

    proc, npm_log = run_service(repo, tmp_path, KWC_MEMINFO_FILE=str(meminfo))

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "Low-memory device" not in proc.stdout
    assert "NODE_OPTIONS=<unset>" in npm_log


def test_a_failed_swap_reports_failure_and_keeps_the_old_bundle(tmp_path: Path) -> None:
    """Regression 2026-10-01: the swap was unchecked.

    build_frontend runs inside `if ! ensure_frontend_build`, where bash suspends
    errexit for the whole call, so an unchecked `mv` fell through to
    `log "Frontend bundle updated."` and `return 0` while dist/ still held the
    old bundle and the new one sat stranded in dist.next. The caller believed a
    bundle that was never installed.
    """
    repo = make_checkout(tmp_path)
    frontend = repo / "frontend"
    # A staging dir the fake npm can still write into, inside a frontend dir
    # that can no longer be modified — so `mv dist dist.previous` fails.
    staging = frontend / "dist.next"
    (staging / "assets").mkdir(parents=True)
    (staging / "index.html").write_text("STALE")
    frontend.chmod(0o555)
    try:
        proc, _ = run_service(repo, tmp_path)
        output = proc.stdout + proc.stderr
    finally:
        frontend.chmod(0o755)

    # Fail-open is preserved: the app still starts on the existing bundle.
    assert proc.returncode == 0, output
    assert "UVICORN STARTED" in proc.stdout
    # ...but the failure is reported rather than swallowed.
    assert "Frontend bundle updated." not in output
    assert "Could not move the current bundle aside" in output

    assert (frontend / "dist" / "index.html").read_text() == "OLD BUNDLE"
    assert (staging / "index.html").read_text() == "NEW BUNDLE"


def test_a_stranded_previous_bundle_is_restored_rather_than_serving_nothing(
    tmp_path: Path,
) -> None:
    """An interrupted swap leaves dist/ absent and the good bundle in
    dist.previous. Rebuilding into that state and failing must not leave the UI
    dead while a usable bundle sits on disk."""
    repo = make_checkout(tmp_path)
    frontend = repo / "frontend"
    (frontend / "dist").rename(frontend / "dist.previous")  # torn swap
    (frontend / "dist.next" / "assets").mkdir(parents=True)
    (frontend / "dist.next" / "index.html").write_text("NEW BUNDLE")

    proc, _ = run_service(repo, tmp_path, FAKE_NPM_BUILD_EXIT="1")
    output = proc.stdout + proc.stderr

    assert proc.returncode == 0, output
    assert "UVICORN STARTED" in proc.stdout
    assert "the web UI will be unavailable" not in output
    assert "No bundle in" in output
    assert (frontend / "dist" / "index.html").read_text() == "OLD BUNDLE"
    assert not (frontend / "dist.previous").exists()
