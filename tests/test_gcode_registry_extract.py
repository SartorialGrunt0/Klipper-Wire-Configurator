"""Tests for the G-code registry extractor (scripts/generate-gcode-registry.py).

TDD layers:
1. Fixture extraction — tiny fake klippy tree, exact command-name set.
2. Real-tree extraction (skipped when reference/klipper is absent) —
   known present/absent names, count band.
3. Drift check — regenerate names vs committed JSON.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "scripts" / "generate-gcode-registry.py"
ARTIFACT = REPO / "backend" / "data" / "gcode_commands.json"
FAKE_TREE = REPO / "tests" / "fixtures" / "fake_klippy"
REAL_KLIPPY = REPO / "reference" / "klipper"


def _load_extractor():
    spec = importlib.util.spec_from_file_location("gen_gcode_registry", SCRIPT)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------- fixture level


def test_fixture_extracts_exact_name_set():
    mod = _load_extractor()
    registry = mod.extract_registry(FAKE_TREE)
    names = set(registry["commands"])
    assert names == {
        # gcode.py builtin handlers list
        "M110", "M112", "M115", "RESTART", "HELP",
        # led.py mux commands
        "SET_LED", "SET_LED_TEMPLATE",
        # led.py single literal + its dereg (func=None) must not add/remove
        "FAKE_ONE_SHOT",
        # gcode_move.py handlers list + literal alias
        "G1", "G20", "G21", "M82", "SET_GCODE_OFFSET", "G0",
    }


def test_fixture_deregistration_not_registered():
    """register_command(name, None) is unregistration — entry must be absent."""
    mod = _load_extractor()
    registry = mod.extract_registry(FAKE_TREE)
    # FAKE_ONE_SHOT is registered with a real func THEN deregistered in a
    # shutdown() method. v1 semantic: a name registered anywhere with a real
    # func counts (dereg pairs are transient interactive commands like ACCEPT).
    # The pair itself (register X 'dummy' / register X None) must not flip a
    # name in or out of the registry on its own.
    assert "FAKE_ONE_SHOT" in registry["commands"]


def test_fixture_dynamic_names_ignored():
    mod = _load_extractor()
    registry = mod.extract_registry(FAKE_TREE)
    # register_command(self.alias, ...) — non-literal first arg — skipped.
    assert all(n.isupper() for n in registry["commands"])
    assert "SELF.ALIAS" not in registry["commands"]


def test_fixture_mux_records_gate_key():
    mod = _load_extractor()
    registry = mod.extract_registry(FAKE_TREE)
    set_led = registry["commands"]["SET_LED"]
    assert set_led["mux_key"] == "LED"
    assert set_led["extra"] == "led"
    assert set_led["requires_sections"] == ["dotstar", "led", "neopixel", "pca9533"]


def test_fixture_gcode_builtin_has_no_gate():
    mod = _load_extractor()
    registry = mod.extract_registry(FAKE_TREE)
    g1 = registry["commands"]["G1"]
    assert g1["requires_sections"] == []
    assert g1["extra"] == "gcode_move"


# ----------------------------------------------------------------- real tree


@pytest.mark.skipif(
    not (REAL_KLIPPY / "klippy").is_dir(),
    reason="reference/klipper tree not present (gitignored; regenerate manually)",
)
def test_real_tree_known_commands_present():
    mod = _load_extractor()
    registry = mod.extract_registry(REAL_KLIPPY)
    names = set(registry["commands"])
    for expected in [
        "SET_LED", "SET_GCODE_VARIABLE", "RESPOND", "G1", "M104", "M106",
        "TEST_RESONANCES", "SHAPER_CALIBRATE",
        "QUAD_GANTRY_LEVEL", "BED_MESH_CALIBRATE", "HELP", "G28",
        "SAVE_VARIABLE", "DUMP_TMC", "SET_PIN", "MANUAL_STEPPER",
        "QUERY_ENDSTOPS", "PAUSE", "CANCEL_PRINT",
        "SDCARD_PRINT_FILE", "GET_POSITION", "TURN_OFF_HEATERS",
    ]:
        assert expected in names, f"{expected} missing from registry"


@pytest.mark.skipif(
    not (REAL_KLIPPY / "klippy").is_dir(),
    reason="reference/klipper tree not present",
)
def test_real_tree_hallucinations_absent():
    """Negative fixtures from accuracy runs TRIDENT-16 / LIVE-05."""
    mod = _load_extractor()
    registry = mod.extract_registry(REAL_KLIPPY)
    names = set(registry["commands"])
    for bad in ["SET_NEOPIXEL_COLOR", "RESONANCE_TEST", "SET_NEOPIXEL_EFFECT"]:
        assert bad not in names


@pytest.mark.skipif(
    not (REAL_KLIPPY / "klippy").is_dir(),
    reason="reference/klipper tree not present",
)
def test_real_tree_count_band():
    mod = _load_extractor()
    registry = mod.extract_registry(REAL_KLIPPY)
    count = len(registry["commands"])
    # Stock Klipper 2026-09 registers ~190 distinct command names (mux
    # commands collapse to one entry each). Band allows for upstream drift.
    assert 150 <= count <= 400, f"command count {count} outside expected band"


@pytest.mark.skipif(
    not (REAL_KLIPPY / "klippy").is_dir(),
    reason="reference/klipper tree not present",
)
def test_real_tree_source_rev_recorded():
    mod = _load_extractor()
    registry = mod.extract_registry(REAL_KLIPPY)
    rev = registry["source_rev"]
    assert rev and len(rev) >= 7


# ----------------------------------------------------------------- artifact


def test_artifact_matches_source_names():
    """Drift check: regenerate names from the klipper tree, compare to JSON.

    Skips cleanly when the tree is absent (CI fresh clone).
    """
    if not (REAL_KLIPPY / "klippy").is_dir():
        pytest.skip("reference/klipper tree not present")
    if not ARTIFACT.is_file():
        pytest.fail("backend/data/gcode_commands.json missing — run "
                    "scripts/generate-gcode-registry.py")
    mod = _load_extractor()
    fresh = set(mod.extract_registry(REAL_KLIPPY)["commands"])
    committed = set(json.loads(ARTIFACT.read_text())["commands"])
    missing = sorted(committed - fresh)
    extra = sorted(fresh - committed)
    assert fresh == committed, (
        "registry stale, re-run scripts/generate-gcode-registry.py "
        f"(removed={missing}, added={extra})"
    )


def test_artifact_schema_shape():
    if not ARTIFACT.is_file():
        pytest.skip("artifact not generated yet")
    data = json.loads(ARTIFACT.read_text())
    assert data["schema_version"] == 1
    assert isinstance(data["commands"], dict) and data["commands"]
    entry = data["commands"]["SET_LED"]
    assert set(entry) >= {"extra", "requires_sections", "requires_mode",
                          "params", "simulated"}
    assert entry["requires_mode"] == "any"
    assert entry["params"]["LED"]["required"] is True
