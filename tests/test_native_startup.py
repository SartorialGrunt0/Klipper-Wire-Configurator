"""Startup contract: KWC refuses to boot on a non-Linux host.

Retiring non-native (browser/dev-server) mode deleted every per-route
``is_native_platform()`` guard on the strength of this assertion, so it is
load-bearing, not a convenience check. These tests therefore exercise the
real import of ``backend/main.py`` in a subprocess — patching the module
in-process would not prove the assertion actually runs at boot.
"""
import os
import subprocess
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"

# Patched before `import main` so services.native_services sees it.
# `platform` is already in sys.modules, so setting the attribute on the
# module is enough — is_native_platform() calls platform.system().
_IMPORT_MAIN = "import platform; platform.system = lambda: {target!r}\nimport main\n"


def _import_main(target: str, extra_env: dict, tmp_path: Path) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if k != "KWC_FAKE_NATIVE"}
    env["KWC_PROJECTS_DIR"] = str(tmp_path / "projects")
    env["PYTHONPATH"] = str(BACKEND_DIR)
    env.update(extra_env)
    return subprocess.run(
        [sys.executable, "-c", _IMPORT_MAIN.format(target=target)],
        cwd=str(BACKEND_DIR),
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )


def test_non_linux_backend_exits_and_names_the_override(tmp_path):
    """A non-Linux host must fail at import, and say how to dev around it."""
    proc = _import_main("Windows", {}, tmp_path)

    assert proc.returncode != 0, "main.py imported on a non-Linux host"
    assert "KWC requires Linux" in proc.stderr
    assert "KWC_FAKE_NATIVE" in proc.stderr, "the failure message must name the dev override"
    # A bare SystemExit(str) prints only the message — a traceback here would
    # mean something else crashed before the assertion could run.
    assert "Traceback" not in proc.stderr


def test_fake_native_override_boots_on_non_linux(tmp_path):
    """KWC_FAKE_NATIVE (what start-dev.ps1 exports) is the Windows dev path."""
    proc = _import_main("Windows", {"KWC_FAKE_NATIVE": "1"}, tmp_path)

    assert proc.returncode == 0, proc.stderr


def test_linux_boots_without_any_override(tmp_path):
    """The printer host needs no env var at all."""
    proc = _import_main("Linux", {}, tmp_path)

    assert proc.returncode == 0, proc.stderr


# ── standalone stdio MCP entry (`python -m backend.mcp_server`) ──
# main.py documents this as the Claude Desktop path, so it is a separate
# process the HTTP backend's assertion cannot protect. Same contract applies.

_RUN_STDIO = (
    "import platform; platform.system = lambda: {target!r}\n"
    "import mcp_server\n"
    "mcp_server.run_stdio()\n"
)


def test_mcp_stdio_server_refuses_non_linux(tmp_path):
    env = {k: v for k, v in os.environ.items() if k != "KWC_FAKE_NATIVE"}
    env["PYTHONPATH"] = str(BACKEND_DIR)
    proc = subprocess.run(
        [sys.executable, "-c", _RUN_STDIO.format(target="Windows")],
        cwd=str(BACKEND_DIR),
        env=env,
        stdin=subprocess.DEVNULL,  # the assertion must fire before any read
        capture_output=True,
        text=True,
        timeout=180,
    )

    assert proc.returncode != 0, "stdio MCP server started on a non-Linux host"
    assert "KWC MCP server requires Linux" in proc.stderr
    assert "KWC_FAKE_NATIVE" in proc.stderr
