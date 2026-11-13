"""Startup contract: KWC boots on any OS and says so off the printer host.

Retiring non-native (browser/dev-server) mode deleted every per-route
``is_native_platform()`` guard, and the native services degrade defensively
instead (empty device lists, 503 from the missing Klipper socket), so a
non-Linux boot is a legitimate dev run — not a misconfiguration. The
contract is therefore: boot everywhere, warn once off a Linux host, and
keep every platform decision OUT of the request paths (the static locks
live in tests/test_no_platform_guards.py). These tests exercise the real
import of ``backend/main.py`` in a subprocess — patching the module
in-process would not prove the boot warning actually runs at startup.
"""
import os
import subprocess
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"

# Stable substring of services.native_services.OFF_HOST_WARNING.
OFF_HOST_PHRASE = "not running on a Linux printer host"

# Patched before `import main` so services.native_services sees it.
# `platform` is already in sys.modules, so setting the attribute on the
# module is enough — is_native_platform() calls platform.system().
_IMPORT_MAIN = "import platform; platform.system = lambda: {target!r}\nimport main\n"


def _import_main(target: str, tmp_path: Path) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["KWC_PROJECTS_DIR"] = str(tmp_path / "projects")
    env["PYTHONPATH"] = str(BACKEND_DIR)
    return subprocess.run(
        [sys.executable, "-c", _IMPORT_MAIN.format(target=target)],
        cwd=str(BACKEND_DIR),
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )


def test_non_linux_host_boots_and_warns(tmp_path):
    """Off the printer host: boot anyway, but say what will find nothing."""
    proc = _import_main("Windows", tmp_path)

    assert proc.returncode == 0, proc.stderr
    assert OFF_HOST_PHRASE in proc.stdout, "the boot warning must fire off Linux"
    # Nothing may crash on the way — a traceback means some module still
    # assumes Linux instead of degrading defensively.
    assert "Traceback" not in proc.stderr


def test_linux_host_boots_silently(tmp_path):
    """The printer host needs no warning and no env var at all."""
    proc = _import_main("Linux", tmp_path)

    assert proc.returncode == 0, proc.stderr
    assert OFF_HOST_PHRASE not in proc.stdout


# ── standalone stdio MCP entry (`python -m backend.mcp_server`) ──
# main.py documents this as the Claude Desktop path, so it is a separate
# process with the same boot-anywhere contract. The warning must go to
# stderr: stdout is the JSON-RPC channel.

_RUN_STDIO = (
    "import platform; platform.system = lambda: {target!r}\n"
    "import mcp_server\n"
    "mcp_server.run_stdio()\n"
)


def test_mcp_stdio_warns_but_starts_off_linux(tmp_path):
    env = dict(os.environ)
    env["PYTHONPATH"] = str(BACKEND_DIR)
    proc = subprocess.run(
        [sys.executable, "-c", _RUN_STDIO.format(target="Windows")],
        cwd=str(BACKEND_DIR),
        env=env,
        stdin=subprocess.DEVNULL,  # EOF ends the stdio loop immediately
        capture_output=True,
        text=True,
        timeout=180,
    )

    assert proc.returncode == 0, proc.stderr  # warns, then serves — no refusal
    assert OFF_HOST_PHRASE in proc.stderr
    # The warning must never leak into the JSON-RPC stdout channel.
    assert OFF_HOST_PHRASE not in proc.stdout


def test_documented_mcp_entry_point_starts(tmp_path):
    """`python -m backend.mcp_server` must actually reach run_stdio().

    The test above imports `mcp_server` with PYTHONPATH=backend. That works, but
    it is not the command this module documents, and the documented form used to
    die at `from klipper_paths import ...` with ModuleNotFoundError — so the
    entry point itself must be proven from the path it names. PYTHONPATH is
    cleared here to prove the module's own sys.path bootstrap does the work.
    """
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)

    proc = subprocess.run(
        [sys.executable, "-m", "backend.mcp_server"],
        cwd=str(BACKEND_DIR.parent),
        env=env,
        stdin=subprocess.DEVNULL,  # EOF ends the stdio loop immediately
        capture_output=True,
        text=True,
        timeout=180,
    )

    assert "ModuleNotFoundError" not in proc.stderr, proc.stderr
    assert proc.returncode == 0, proc.stderr
    assert "MCP server:" in proc.stderr
