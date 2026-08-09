"""Backup config file filtering.

Klipper's SAVE_CONFIG writes timestamped backups (printer-YYYYMMDD_HHMMSS.cfg)
into the config directory. KWC treats those as noise everywhere configs are
listed: the native listing endpoint (native_services.list_config_files) and
the MCP user-config tools (list_user_configs, search_user_configs,
read_user_config via _resolve_user_config_file).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import mcp_server  # noqa: E402
from services.native_services import is_backup_config_file, list_config_files  # noqa: E402


# ── is_backup_config_file unit tests ────────────────────────────


def test_matches_klipper_save_config_backup():
    assert is_backup_config_file("printer-20250810_142619.cfg")


def test_matches_case_insensitively():
    assert is_backup_config_file("PRINTER-20250810_142619.CFG")


def test_matches_paths_by_basename():
    assert is_backup_config_file("backups/printer-20250810_142619.cfg")
    assert is_backup_config_file("config/backup/printer-20250810_142619.cfg")


def test_rejects_regular_configs():
    for name in ("printer.cfg", "aux_fan.cfg", "macros.cfg", "PIS.cfg"):
        assert not is_backup_config_file(name)


def test_rejects_lookalike_names():
    # No underscore-time component, wrong date width, wrong extension, and
    # example-config naming (printer-<model>-<year>.cfg) must not match.
    for name in (
        "printer-20250810.cfg",
        "printer-2025081_142619.cfg",
        "printer-20250810_142619.bak",
        "printer-voron-2021.cfg",
        "printer-voron2-350.cfg",
    ):
        assert not is_backup_config_file(name)


# ── list_config_files (native listing endpoint) ─────────────────


def test_list_config_files_excludes_backups(tmp_path):
    (tmp_path / "printer.cfg").write_text("[printer]\n")
    (tmp_path / "aux_fan.cfg").write_text("[fan_generic Aux_Fan]\n")
    (tmp_path / "printer-20250810_142619.cfg").write_text("[printer]\n")
    (tmp_path / "backup").mkdir()
    (tmp_path / "backup" / "printer-20250901_120000.cfg").write_text("[printer]\n")

    names = [f["name"] for f in list_config_files(str(tmp_path))]

    assert "printer.cfg" in names
    assert "aux_fan.cfg" in names
    assert "printer-20250810_142619.cfg" not in names
    assert "backup/printer-20250901_120000.cfg" not in names


# ── MCP user-config tools ───────────────────────────────────────


def _make_server_with_configs(tmp_path):
    """McpServer whose local user-config dir contains a backup file."""
    docs = tmp_path / "docs"
    docs.mkdir()
    server = mcp_server.McpServer(index=mcp_server.DocIndex(docs_dir=docs))
    server.index.load()
    configs = tmp_path / "user_configs"
    configs.mkdir()
    (configs / "printer.cfg").write_text("[printer]\n# main config\n")
    (configs / "printer-20250810_142619.cfg").write_text("[printer]\n# main config\n")
    mcp_server.LOCAL_CONFIGS_DIR = configs
    return server


def _call_tool(server, name, arguments):
    response = server.handle_jsonrpc({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    })
    assert response is not None
    assert "result" in response, response
    content = response["result"].get("content", [])
    return "\n".join(item.get("text", "") for item in content)


def test_list_user_configs_excludes_backups(tmp_path):
    server = _make_server_with_configs(tmp_path)
    out = _call_tool(server, "list_user_configs", {})
    assert "printer.cfg" in out
    assert "printer-20250810_142619.cfg" not in out


def test_search_user_configs_excludes_backups(tmp_path):
    server = _make_server_with_configs(tmp_path)
    # "main" hits the content of both files; only printer.cfg may surface.
    out = _call_tool(server, "search_user_configs", {"query": "main"})
    assert "printer.cfg" in out
    assert "printer-20250810_142619.cfg" not in out


def test_read_user_config_cannot_target_backup(tmp_path):
    server = _make_server_with_configs(tmp_path)
    out = _call_tool(server, "read_user_config", {"filename": "printer-20250810_142619.cfg"})
    assert "not found" in out.lower()
    # Normal configs remain readable.
    out2 = _call_tool(server, "read_user_config", {"filename": "printer.cfg"})
    assert "[printer]" in out2
