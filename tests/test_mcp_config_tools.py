"""Tests for the live-context MCP tools (feature/config-mcp-tools).

Covers the four tools added for AI-chat ↔ real-printer context:
  - validate_config_project  (full schema engine over the live config project)
  - list_connected_devices   (same data as the communication-line dropdowns)
  - get_section_schema       (typed params from config_schema, not prose)
  - get_klippy_status        (state + recent errors + targeted log excerpt)

Plus the service extraction `load_native_project` that `validate_config_project`
and the /api/native/config-files/read route share (include-closure semantics
must not fork — see test_native_read_include_closure.py for the route lock).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import mcp_server  # noqa: E402


# ── Helpers ─────────────────────────────────────────────────────────────


def _call(server, name, arguments):
    """Invoke a tool via the JSON-RPC surface and return its text result."""
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


def _server(tmp_path):
    """Server with isolated config dirs (mirrors test_mcp_server_tools fixture)."""
    server = mcp_server.McpServer()
    mcp_server.LOCAL_CONFIGS_DIR = tmp_path / "user_configs"
    mcp_server._system_config_path = lambda: tmp_path / "system_config"
    return server, tmp_path / "system_config"


# ── Tool registration ───────────────────────────────────────────────────


def test_new_tools_registered():
    names = {t["name"] for t in mcp_server.McpServer()._list_tools()}
    for expected in (
        "validate_config_project",
        "list_connected_devices",
        "get_section_schema",
        "get_klippy_status",
    ):
        assert expected in names, f"{expected} must be registered"


# ── validate_config_project ─────────────────────────────────────────────


def _force_native(monkeypatch):
    import services.native_services as ns

    monkeypatch.setattr(ns, "is_native_platform", lambda: True)


def test_validate_project_reports_severities(tmp_path, monkeypatch):
    _force_native(monkeypatch)
    server, config_dir = _server(tmp_path)
    config_dir.mkdir(parents=True)
    (config_dir / "printer.cfg").write_text(
        "[include aux.cfg]\n"
        "[printer]\n"
        "kinematics: cartesian\n"
        "max_velocity: 300\n"
        "max_accel: 3000\n"
        "max_z_velocity: 5\n"
        "max_z_accel: 100\n",
        encoding="utf-8",
    )
    # aux.cfg: an unknown section (warning) and an unknown param (error).
    (config_dir / "aux.cfg").write_text(
        "[bed_mesh]\n"
        "speed: 100\n"
        "totally_bogus_param: 1\n",
        encoding="utf-8",
    )

    out = _call(server, "validate_config_project", {})
    # Include closure: the tool validated the project, not just printer.cfg.
    assert "aux.cfg" in out
    # The unknown param must surface with its file/section location.
    assert "totally_bogus_param" in out
    # Severity classes appear as distinct labels (error vs warning).
    assert "error" in out.lower()
    # Clean file reported as such, not silently omitted.
    assert "printer.cfg" in out


def test_validate_project_accepts_filenames(tmp_path, monkeypatch):
    _force_native(monkeypatch)
    server, config_dir = _server(tmp_path)
    config_dir.mkdir(parents=True)
    (config_dir / "printer.cfg").write_text(
        "[printer]\nkinematics: corexy\n", encoding="utf-8"
    )
    (config_dir / "other.cfg").write_text(
        "[bed_screws]\nscrew1: 10, 10\n", encoding="utf-8"
    )
    out = _call(server, "validate_config_project", {"filenames": ["other.cfg"]})
    assert "bed_screws" in out
    # printer.cfg was explicitly excluded → not part of the validated set.
    assert "printer.cfg" not in out


def test_validate_project_no_config_dir(tmp_path, monkeypatch):
    _force_native(monkeypatch)
    server, config_dir = _server(tmp_path)
    out = _call(server, "validate_config_project", {})
    assert "no config files" in out.lower()


# ── list_connected_devices ──────────────────────────────────────────────


def test_list_devices_non_native(tmp_path, monkeypatch):
    import services.native_services as ns

    monkeypatch.setattr(ns, "is_native_platform", lambda: False)
    server, _ = _server(tmp_path)
    out = _call(server, "list_connected_devices", {})
    assert "only available" in out.lower()


def test_list_devices_formats_dropdown_data(tmp_path, monkeypatch):
    import services.native_services as ns

    monkeypatch.setattr(ns, "is_native_platform", lambda: True)
    monkeypatch.setattr(ns, "get_all_devices", lambda: {
        "usb_serial": [{
            "path": "/dev/ttyACM0",
            "description": "usb-Klipper_stm32f446xx_42-if00",
            "by_id": "/dev/serial/by-id/usb-Klipper_stm32f446xx_42-if00",
        }],
        "uart": [{
            "path": "/dev/ttyAMA0",
            "description": "ttyAMA0",
            "by_id": "",
        }],
        "can": [{"name": "can0", "state": "up", "bitrate": 1000000}],
    })
    monkeypatch.setattr(
        ns, "query_canbus_uuids",
        lambda interface: {"uuids": ["abc123def456"], "interface": interface, "error": None},
    )

    server, _ = _server(tmp_path)
    out = _call(server, "list_connected_devices", {})
    # Each dropdown group appears with its values.
    assert "usb-Klipper_stm32f446xx_42-if00" in out
    assert "/dev/ttyAMA0" in out
    assert "can0" in out
    # CAN UUID scan runs by default (the dropdown's second step).
    assert "abc123def456" in out


def test_list_devices_can_scan_toggle(tmp_path, monkeypatch):
    import services.native_services as ns

    monkeypatch.setattr(ns, "is_native_platform", lambda: True)
    monkeypatch.setattr(ns, "get_all_devices", lambda: {
        "usb_serial": [], "uart": [], "can": [{"name": "can0", "state": "down", "bitrate": None}],
    })

    def _boom(interface):
        raise AssertionError("must not scan when scan_can_uuids=false")

    monkeypatch.setattr(ns, "query_canbus_uuids", _boom)
    server, _ = _server(tmp_path)
    out = _call(server, "list_connected_devices", {"scan_can_uuids": False})
    assert "can0" in out


# ── get_section_schema ──────────────────────────────────────────────────


def test_section_schema_single(tmp_path):
    server, _ = _server(tmp_path)
    out = _call(server, "get_section_schema", {"section": "bed_mesh"})
    # Typed facts only the schema (not the prose reference) gives compactly.
    assert "speed" in out
    assert "lagrange" in out and "bicubic" in out  # enum values, verbatim
    # Prose-vs-typed discriminator: the tool speaks in types/defaults.
    assert "float" in out.lower() or "bool" in out.lower()


def test_section_schema_batch_and_alias(tmp_path):
    server, _ = _server(tmp_path)
    out = _call(server, "get_section_schema", {"sections": ["extruder", "[gcode_arcs]"]})
    assert "extruder" in out
    assert "resolution" in out  # gcode_arcs' only param


def test_section_schema_unknown_suggests(tmp_path):
    server, _ = _server(tmp_path)
    out = _call(server, "get_section_schema", {"section": "bed_msh"})
    assert "not" in out.lower()  # explicit unknown-section message
    assert "bed_mesh" in out     # close-match suggestion


def test_section_schema_required_flag(tmp_path):
    server, _ = _server(tmp_path)
    # [extruder] nozzle_diameter is required per the schema.
    out = _call(server, "get_section_schema", {"section": "extruder"})
    assert "nozzle_diameter" in out
    assert "required" in out.lower()


# ── get_klippy_status ───────────────────────────────────────────────────


def test_klippy_status_ready(tmp_path, monkeypatch):
    import services.native_services as ns

    monkeypatch.setattr(ns, "query_klipper_status", lambda: {
        "status": "ok",
        "socket_path": "/tmp/klippy_uds",
        "state": "ready",
        "state_message": "Printer is ready",
        "recent_errors": [],
        "log_path": None,
        "is_printing": False,
        "print_state": None,
        "print_filename": None,
    })
    server, _ = _server(tmp_path)
    out = _call(server, "get_klippy_status", {})
    assert "ready" in out.lower()
    # Ready + no excerpt request → no log fetch.
    assert "log excerpt" not in out.lower()


def test_klippy_status_not_ready_attaches_excerpt(tmp_path, monkeypatch):
    import services.native_services as ns

    monkeypatch.setattr(ns, "query_klipper_status", lambda: {
        "status": "ok",
        "socket_path": "/tmp/klippy_uds",
        "state": "startup error",
        "state_message": "Config error",
        "recent_errors": ["Pin 'PB111' is not a valid pin name"],
        "log_path": "/tmp/klippy.log",
        "is_printing": False,
        "print_state": None,
        "print_filename": None,
    })
    calls = {}

    def _excerpt(section_name=None, error_text=None, context_lines=40):
        calls["section_name"] = section_name
        calls["error_text"] = error_text
        return {
            "status": "ok",
            "log_path": "/tmp/klippy.log",
            "excerpt": "Traceback...\nPin 'PB111' is not a valid pin name",
            "matched_on": "error",
        }

    monkeypatch.setattr(ns, "get_klippy_log_excerpt", _excerpt)
    server, _ = _server(tmp_path)
    out = _call(server, "get_klippy_status", {})
    # Failure context auto-attaches when klippy is not ready.
    assert "Pin 'PB111' is not a valid pin name" in out
    assert "Traceback" in out
    assert calls.get("error_text") is not None  # recent error fed into the match


def test_klippy_status_explicit_excerpt_while_ready(tmp_path, monkeypatch):
    import services.native_services as ns

    monkeypatch.setattr(ns, "query_klipper_status", lambda: {
        "status": "ok", "socket_path": "/x", "state": "ready",
        "state_message": "", "recent_errors": [], "log_path": None,
        "is_printing": False, "print_state": None, "print_filename": None,
    })
    monkeypatch.setattr(
        ns, "get_klippy_log_excerpt",
        lambda section_name=None, error_text=None, context_lines=40: {
            "status": "ok", "log_path": "/tmp/klippy.log",
            "excerpt": "old failure line", "matched_on": "probe",
        },
    )
    server, _ = _server(tmp_path)
    out = _call(server, "get_klippy_status", {
        "include_log_excerpt": True, "section_name": "probe",
    })
    assert "old failure line" in out


def test_klippy_status_socket_missing(tmp_path, monkeypatch):
    import services.native_services as ns

    def _missing():
        raise FileNotFoundError("Klipper API socket not found.")

    monkeypatch.setattr(ns, "query_klipper_status", _missing)
    monkeypatch.setattr(
        ns, "get_klippy_log_excerpt",
        lambda section_name=None, error_text=None, context_lines=40: {
            "status": "ok", "log_path": None, "excerpt": "", "matched_on": None,
        },
    )
    server, _ = _server(tmp_path)
    out = _call(server, "get_klippy_status", {})
    assert "not found" in out.lower() or "not responding" in out.lower()


def test_klippy_status_printing_warning(tmp_path, monkeypatch):
    import services.native_services as ns

    monkeypatch.setattr(ns, "query_klipper_status", lambda: {
        "status": "ok", "socket_path": "/x", "state": "ready",
        "state_message": "", "recent_errors": [], "log_path": None,
        "is_printing": True, "print_state": "printing",
        "print_filename": "benchy.gcode",
    })
    server, _ = _server(tmp_path)
    out = _call(server, "get_klippy_status", {})
    assert "benchy.gcode" in out
    # Restart-safety note must appear whenever a print is active.
    assert "interrupt" in out.lower() or "active" in out.lower()
