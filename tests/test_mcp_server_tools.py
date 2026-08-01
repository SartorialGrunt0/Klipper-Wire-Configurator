"""Tests for the embedded MCP server (mcp_server.py).

Covers the DocIndex search engine, all 14 tool handlers, argument
coercion, and the JSON-RPC protocol surface (initialize, tools/list,
tools/call, resources, ping).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import mcp_server  # noqa: E402
from mcp_server import DocIndex, McpServer  # noqa: E402


# ── Fixtures ────────────────────────────────────────────────────────────


def _make_doc(tmp_path, filename, content):
    path = tmp_path / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def _index_for(tmp_path):
    index = DocIndex(docs_dir=tmp_path)
    index.load()
    return index


def _call_tool(server, name, arguments):
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
    """Server backed by a synthetic docs index plus isolated user configs."""
    _make_doc(tmp_path / "docs", "Bed_Mesh.md", (
        "# Bed Mesh\n\n"
        "## horizontal_move_z\n\n"
        "The bed_mesh horizontal_move_z parameter sets the Z hop before travel.\n"
    ))
    _make_doc(tmp_path / "docs", "Probe.md", (
        "# Probe\n\n"
        "## z_offset\n\n"
        "The probe z_offset is calibrated against the nozzle.\n"
    ))
    _make_doc(tmp_path / "docs", "Config_Reference.md", (
        "# Config Reference\n\n"
        "### [bed_mesh]\n"
        "horizontal_move_z: The Z gap when traversing the mesh.\n"
        "\n"
        "### [extruder]\n"
        "heater_pin: Heater output pin.\n"
    ))
    server = McpServer(index=DocIndex(docs_dir=tmp_path / "docs"))
    server.index.load()

    # Isolated user config storage.
    mcp_server.LOCAL_CONFIGS_DIR = tmp_path / "user_configs"
    mcp_server.SYSTEM_CONFIG_PATH = tmp_path / "system_config"
    mcp_server.CONFIG_EXAMPLES_DIR = tmp_path / "config"
    (tmp_path / "config").mkdir(parents=True, exist_ok=True)
    return server, tmp_path


# ── DocIndex ────────────────────────────────────────────────────────────


def test_doc_index_loads_and_lists_docs(tmp_path):
    _make_doc(tmp_path, "Bed_Mesh.md", "# Bed Mesh\n\ncontent here")
    _make_doc(tmp_path, "Probe.md", "# Probe\n\nmore content")
    index = _index_for(tmp_path)

    assert index.is_ready()
    assert index.get_doc_count() == 2
    docs = index.list_docs()
    assert {d["filename"] for d in docs} == {"Bed_Mesh.md", "Probe.md"}
    assert all("headings" in d and "size_bytes" in d for d in docs)


def test_doc_index_load_missing_dir():
    index = DocIndex(docs_dir=Path("/nonexistent/path"))
    index.load()
    assert not index.is_ready()
    assert index.get_doc_count() == 0
    assert index.list_docs() == []


def test_doc_index_search_ranks_and_snippets(tmp_path):
    _make_doc(tmp_path, "Bed_Mesh.md", "# Bed Mesh\n\n" + "horizontal_move_z " * 30)
    _make_doc(tmp_path, "Probe.md", "# Probe\n\nno matching words here")
    index = _index_for(tmp_path)

    results = index.search("horizontal_move_z", limit=10)
    assert results
    assert results[0]["filename"] == "Bed_Mesh.md"
    assert results[0]["score"] > 0
    assert "horizontal_move_z" in results[0]["snippet"].lower()


def test_doc_index_search_empty_query(tmp_path):
    _make_doc(tmp_path, "Bed_Mesh.md", "# Bed Mesh")
    index = _index_for(tmp_path)
    assert index.search("") == []
    assert index.search("   ") == []


def test_doc_index_search_underscore_space_synonyms(tmp_path):
    _make_doc(tmp_path, "Bed_Mesh.md", "# Bed Mesh\n\n" + "horizontal_move_z " * 30)
    _make_doc(tmp_path, "Probe.md", "# Probe\n\nno matching words here")
    index = _index_for(tmp_path)

    # Natural-language spacing must match the joined config term.
    results = index.search("horizontal move z", limit=10)
    assert results
    assert results[0]["filename"] == "Bed_Mesh.md"


def test_doc_index_search_plural_fold(tmp_path):
    _make_doc(tmp_path, "Probe.md", "# Probe\n\nThe probe z_offset is calibrated. Probes measure offsets.\n")
    _make_doc(tmp_path, "Bed_Mesh.md", "# Bed Mesh\n\nno matching words here")
    index = _index_for(tmp_path)

    # Plural query forms must fold onto singular index terms (and vice versa).
    results = index.search("probe z offsets", limit=10)
    assert results
    assert results[0]["filename"] == "Probe.md"


def test_doc_index_search_alias_map(tmp_path):
    _make_doc(tmp_path, "Endstop.md", "# Endstop\n\nThe end_stop pin is configured.\n")
    _make_doc(tmp_path, "Probe.md", "# Probe\n\nno matching words here")
    index = _index_for(tmp_path)

    # Unseparated human spelling must match the joined config term.
    results = index.search("endstop", limit=10)
    assert results
    assert results[0]["filename"] == "Endstop.md"


def test_doc_index_read_doc_pagination(tmp_path):
    content = "A" * 100 + "B" * 100
    _make_doc(tmp_path, "Bed_Mesh.md", content)
    index = _index_for(tmp_path)

    first = index.read_doc("Bed_Mesh", limit=50)
    assert first["content"] == "A" * 50
    assert first["truncated"] is True
    assert first["total_chars"] == 200

    second = index.read_doc("Bed_Mesh", offset=100, limit=200)
    assert second["content"] == "B" * 100
    assert second["truncated"] is False

    assert index.read_doc("Missing") is None


def test_doc_index_config_reference_section(tmp_path):
    _make_doc(tmp_path, "Config_Reference.md", (
        "# Config Reference\n\n"
        "### [bed_mesh]\n"
        "horizontal_move_z: The Z gap.\n"
        "\n"
        "### [extruder]\n"
        "heater_pin: Heater output.\n"
    ))
    index = _index_for(tmp_path)

    result = index.get_config_reference_section("bed_mesh")
    assert result is not None
    assert result["section"] == "bed_mesh"
    assert "horizontal_move_z" in result["content"]
    assert "bed_mesh" in result["aliases"]

    assert index.get_config_reference_section("nonexistent") is None


# ── search_klipper_docs / read_klipper_doc / list_klipper_docs ──────────


def test_search_klipper_docs(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "search_klipper_docs", {"query": "horizontal_move_z"})
    assert "Search results for: horizontal_move_z" in out
    assert "Bed_Mesh.md" in out
    assert "score" in out


def test_search_klipper_docs_empty_query(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "search_klipper_docs", {"query": "  "})
    assert "Please provide a search query" in out


def test_search_klipper_docs_no_results(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "search_klipper_docs", {"query": "zzzznomatchzzzz"})
    assert "No results found" in out


def test_read_klipper_doc(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "read_klipper_doc", {"filename": "Bed_Mesh.md"})
    assert "# Bed_Mesh.md" in out
    assert "horizontal_move_z" in out


def test_read_klipper_doc_partial_match(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "read_klipper_doc", {"filename": "Bed_Mesh"})
    assert "# Bed_Mesh.md" in out


def test_read_klipper_doc_not_found(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "read_klipper_doc", {"filename": "Nope.md"})
    assert "not found" in out


def test_read_klipper_doc_empty_filename(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "read_klipper_doc", {"filename": ""})
    assert "Please provide a filename" in out


def test_list_klipper_docs(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "list_klipper_docs", {})
    assert "Klipper Documentation" in out
    assert "Bed_Mesh.md" in out
    assert "Probe.md" in out


# ── get_config_reference_section / get_section_schema ───────────────────


def test_get_config_reference_section(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "get_config_reference_section", {"section_name": "bed_mesh"})
    assert "# [bed_mesh]" in out
    assert "horizontal_move_z" in out


def test_get_config_reference_section_not_found(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "get_config_reference_section", {"section_name": "warp_drive"})
    assert "not found" in out


def test_get_section_schema(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "get_section_schema", {"section_type": "extruder"})
    assert "Section schema" in out
    assert "[extruder]" in out


def test_get_section_schema_unknown(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "get_section_schema", {"section_type": "warp_drive"})
    assert "No schema found" in out


# ── validate_klipper_config ─────────────────────────────────────────────


def test_validate_klipper_config_valid(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "validate_klipper_config", {
        "config_text": "[mcu]\nserial: /dev/serial/by-id/usb-klipper\n",
    })
    assert "Validation result" in out
    assert "valid" in out.lower() or "Errors" in out


def test_validate_klipper_config_empty(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "validate_klipper_config", {"config_text": ""})
    assert "Please provide config text" in out


# ── search_example_configs / read_example_config ────────────────────────


def test_search_example_configs(tmp_path):
    server, root = _server(tmp_path)
    mainboard = root / "config" / "Mainboard"
    mainboard.mkdir(parents=True)
    (mainboard / "generic-bigtreetech-manta-m4p.cfg").write_text(
        "# BTT Manta M4P board\n[mcu]\nserial: /dev/serial/by-id/xyz\n",
        encoding="utf-8",
    )
    out = _call_tool(server, "search_example_configs", {"query": "manta"})
    assert "Example configs matching: manta" in out
    assert "generic-bigtreetech-manta-m4p.cfg" in out


def test_search_example_configs_empty_query(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "search_example_configs", {"query": ""})
    assert "Please provide a search query" in out


def test_search_example_configs_no_results(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "search_example_configs", {"query": "zzzznomatch"})
    assert "No example configs matching" in out


def test_read_example_config(tmp_path):
    server, root = _server(tmp_path)
    mainboard = root / "config" / "Mainboard"
    mainboard.mkdir(parents=True)
    (mainboard / "generic-bigtreetech-manta-m4p.cfg").write_text(
        "[mcu]\nserial: xyz\n",
        encoding="utf-8",
    )
    out = _call_tool(server, "read_example_config", {"filename": "generic-bigtreetech-manta-m4p.cfg"})
    assert "generic-bigtreetech-manta-m4p.cfg" in out
    assert "[mcu]" in out


def test_read_example_config_not_found(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "read_example_config", {"filename": "nope.cfg"})
    assert "not found" in out


# ── search_user_configs / read_user_config ──────────────────────────────


def test_search_user_configs(tmp_path):
    server, root = _server(tmp_path)
    user_dir = root / "user_configs"
    user_dir.mkdir(parents=True)
    (user_dir / "my_printer.cfg").write_text(
        "[mcu]\nserial: /dev/serial/by-id/voron\n",
        encoding="utf-8",
    )
    out = _call_tool(server, "search_user_configs", {"query": "voron"})
    assert "User configs matching: voron" in out
    assert "my_printer.cfg" in out


def test_search_user_configs_empty_query(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "search_user_configs", {"query": ""})
    assert "Please provide a search query" in out


def test_search_user_configs_no_results(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "search_user_configs", {"query": "zzzznomatch"})
    assert "No user configs matching" in out


def test_read_user_config(tmp_path):
    server, root = _server(tmp_path)
    user_dir = root / "user_configs"
    user_dir.mkdir(parents=True)
    (user_dir / "my_printer.cfg").write_text(
        "[mcu]\nserial: xyz\n",
        encoding="utf-8",
    )
    out = _call_tool(server, "read_user_config", {"filename": "my_printer.cfg"})
    assert "my_printer.cfg" in out
    assert "[mcu]" in out


def test_read_user_config_not_found(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "read_user_config", {"filename": "missing.cfg"})
    assert "not found" in out


# ── detect_board ────────────────────────────────────────────────────────


def test_detect_board(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "detect_board", {
        "config_text": "[mcu]\nserial: /dev/serial/by-id/usb-klipper\n",
    })
    assert "Board Detection Results" in out


def test_detect_board_empty(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "detect_board", {"config_text": ""})
    assert "Please provide config text" in out


# ── calculate_rotation_distance ─────────────────────────────────────────


def test_rotation_distance_leadscrew(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "calculate_rotation_distance", {"method": "leadscrew", "pitch": 2, "starts": 1})
    assert "rotation_distance: 2.0" in out
    assert "Formula" in out


def test_rotation_distance_belt(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "calculate_rotation_distance", {"method": "belt", "pulley_teeth": 20, "belt_pitch": 2})
    assert "rotation_distance: 40.0" in out


def test_rotation_distance_from_steps_per_mm(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "calculate_rotation_distance", {
        "method": "from_steps_per_mm", "steps_per_mm": 80, "microsteps": 16,
    })
    assert "rotation_distance: 40.0" in out


def test_rotation_distance_missing_method(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "calculate_rotation_distance", {})
    assert "Please specify a calculation method" in out


def test_rotation_distance_unknown_method(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "calculate_rotation_distance", {"method": "magic"})
    assert "Unknown method" in out


def test_rotation_distance_invalid_pitch(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "calculate_rotation_distance", {"method": "leadscrew", "pitch": 0})
    assert "valid leadscrew pitch" in out


# ── generate_macro_template ─────────────────────────────────────────────


def test_generate_macro_template_print_start(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "generate_macro_template", {"macro_name": "PRINT_START"})
    assert "## PRINT_START" in out
    assert "[gcode_macro PRINT_START]" in out


def test_generate_macro_template_print_start_with_bed_mesh(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "generate_macro_template", {
        "macro_name": "PRINT_START", "include_bed_mesh": True,
    })
    assert "BED_MESH_CALIBRATE" in out


def test_generate_macro_template_unknown(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "generate_macro_template", {"macro_name": "FOO"})
    assert "Unknown macro" in out


def test_generate_macro_template_pause_custom_values(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "generate_macro_template", {
        "macro_name": "PAUSE", "park_x": 10, "park_y": 20, "park_z": 5, "retract_distance": 3,
    })
    assert "## PAUSE" in out
    assert "default(10)" in out
    assert "default(20)" in out
    assert "default(5.0)" in out
    assert "default(3.0)" in out


# ── validate_macro ──────────────────────────────────────────────────────


def test_validate_macro_clean(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "validate_macro", {"macro_text": (
        "[gcode_macro TEST]\n"
        "description: A safe test macro\n"
        "gcode:\n"
        "    G28\n"
        "    G90\n"
    )})
    assert "No issues found" in out


def test_validate_macro_missing_header(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "validate_macro", {"macro_text": "G28\n"})
    assert "Missing or invalid [gcode_macro" in out
    assert "issue(s) found" in out


def test_validate_macro_unbalanced_jinja(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "validate_macro", {"macro_text": (
        "[gcode_macro TEST]\n"
        "gcode:\n"
        "    {% if printer.bed_mesh %}\n"
        "    G28\n"
    )})
    assert "Unbalanced {% if %}" in out


def test_validate_macro_save_restore_state(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "validate_macro", {"macro_text": (
        "[gcode_macro TEST]\n"
        "gcode:\n"
        "    SAVE_GCODE_STATE NAME=X\n"
        "    G1 X10 Y10 F3000\n"
    )})
    assert "SAVE_GCODE_STATE" in out


def test_validate_macro_bed_bounds_warning(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "validate_macro", {"macro_text": (
        "[gcode_macro TEST]\n"
        "gcode:\n"
        "    G90\n"
        "    G1 X500 Y500 F3000\n"
    ), "bed_x": 300, "bed_y": 300})
    assert "exceeds bed bounds" in out


def test_validate_macro_empty(tmp_path):
    server, _ = _server(tmp_path)
    out = _call_tool(server, "validate_macro", {"macro_text": ""})
    assert "Please provide macro text" in out


# ── JSON-RPC protocol ───────────────────────────────────────────────────


def test_initialize_handshake(tmp_path):
    server, _ = _server(tmp_path)
    response = server.handle_jsonrpc({
        "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {},
    })
    assert response["result"]["protocolVersion"] == mcp_server.MCP_PROTOCOL_VERSION
    assert response["result"]["serverInfo"]["name"] == mcp_server.SERVER_NAME


def test_notification_returns_none(tmp_path):
    server, _ = _server(tmp_path)
    assert server.handle_jsonrpc({
        "jsonrpc": "2.0", "method": "notifications/initialized", "params": {},
    }) is None


def test_tools_list(tmp_path):
    server, _ = _server(tmp_path)
    response = server.handle_jsonrpc({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
    names = {t["name"] for t in response["result"]["tools"]}
    assert "search_klipper_docs" in names
    assert "validate_klipper_config" in names
    assert "generate_macro_template" in names
    assert len(names) == 14


def test_tools_call_unknown_tool(tmp_path):
    server, _ = _server(tmp_path)
    response = server.handle_jsonrpc({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "not_a_tool", "arguments": {}},
    })
    assert response["result"]["isError"] is True
    assert "Unknown tool" in response["result"]["content"][0]["text"]


def test_resources_list(tmp_path):
    server, _ = _server(tmp_path)
    response = server.handle_jsonrpc({"jsonrpc": "2.0", "id": 1, "method": "resources/list", "params": {}})
    assert response["result"]["resources"]
    assert response["result"]["resources"][0]["uri"].startswith("kwc://docs/")


def test_resources_read(tmp_path):
    server, _ = _server(tmp_path)
    response = server.handle_jsonrpc({
        "jsonrpc": "2.0", "id": 1, "method": "resources/read",
        "params": {"uri": "kwc://docs/Bed_Mesh"},
    })
    assert response["result"]["contents"][0]["uri"] == "kwc://docs/Bed_Mesh"
    assert "horizontal_move_z" in response["result"]["contents"][0]["text"]


def test_ping(tmp_path):
    server, _ = _server(tmp_path)
    response = server.handle_jsonrpc({"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {}})
    assert response["result"] == {}


def test_unknown_method_returns_error(tmp_path):
    server, _ = _server(tmp_path)
    response = server.handle_jsonrpc({"jsonrpc": "2.0", "id": 1, "method": "bogus", "params": {}})
    assert "error" in response
    assert response["error"]["code"] == -32601


# ── Argument coercion ───────────────────────────────────────────────────


def test_coerce_args_types(tmp_path):
    server, _ = _server(tmp_path)
    coerced = server._coerce_args({
        "pitch": "2.5",
        "starts": "4",
        "include_bed_mesh": "true",
        "keep": "plain text",
    })
    assert coerced == {
        "pitch": 2.5,
        "starts": 4,
        "include_bed_mesh": True,
        "keep": "plain text",
    }


def test_coerce_args_leaves_real_types(tmp_path):
    server, _ = _server(tmp_path)
    coerced = server._coerce_args({"pitch": 2.5, "starts": 4, "flag": True})
    assert coerced == {"pitch": 2.5, "starts": 4, "flag": True}
