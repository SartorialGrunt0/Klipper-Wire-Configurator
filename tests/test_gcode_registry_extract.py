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
        # convention-resolved loop handlers + shared-dispatch negative control
        "SET_GCODE_STATE", "GET_STATE", "DISPATCH_A", "DISPATCH_B",
        # per-axis loop reads (numeric vs presence)
        "SET_FAKE_OFFSET", "FAKE_HOME",
        # guards.py review-F1/F2 policy fixtures
        "GUARDED", "ALIASED",
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


def test_fixture_extracts_param_types_and_required():
    """W1 task 1.2: handler gcmd.get_* calls become typed params.

    The mux key LED stays required; the handler's own calls add type +
    default. Bare get('LABEL') (no default) is required; get_int with a
    None default is optional.
    """
    mod = _load_extractor()
    registry = mod.extract_registry(FAKE_TREE)
    params = registry["commands"]["SET_LED"]["params"]
    assert params["LED"] == {"required": True}
    assert params["RED"] == {"type": "float", "required": False, "default": 0.0}
    assert params["INDEX"] == {"type": "int", "required": False,
                               "default": None, "minval": 1}
    assert params["SYNC"] == {"type": "bool", "required": False, "default": True}
    assert params["LABEL"] == {"type": "str", "required": True}


# ── review F1/F2: required policy + gcmd-receiver restriction ──────────────

def test_fixture_guarded_reads_are_never_required():
    """F1 (skew_correction:119-120 / manual_stepper:129 / servo:71 shape):
    a name read only via test-then-read or inside an if/elif/else action
    chain is NOT required — the command runs fine without it, and the
    old last-call-wins policy false-FAILed every valid invocation
    (18 of the 24 corpus errors)."""
    mod = _load_extractor()
    registry = mod.extract_registry(FAKE_TREE)
    params = registry["commands"]["GUARDED"]["params"]
    for name in ("LOAD", "SAVE", "FALLBACK"):
        assert params[name]["required"] is False, name


def test_fixture_gcmd_alias_harvested_non_receivers_dropped():
    """F2 (heaters.py:374 became a REQUIRED TEMPERATURE_WAIT DEBUGOUTPUT):
    only the gcmd parameter (through assignment aliases) is a param
    source; self.printer.get_start_args().get(...) is a dict lookup."""
    mod = _load_extractor()
    registry = mod.extract_registry(FAKE_TREE)
    params = registry["commands"]["ALIASED"]["params"]
    assert params["MUST"] == {"type": "int", "required": True}  # via alias
    assert "DEBUGOUTPUT" not in params
    assert params["DELAY"] == {"type": "float", "required": False,
                               "default": 1.0}


# ── loop registrations: the `cmd_` convention ──────────────────────────────

def test_fixture_loop_getattr_resolves_handler_by_convention():
    """klippy/extras/gcode_move.py:22-27 registers its handler table as
    `func = getattr(self, 'cmd_' + cmd); register_command(cmd, func)`.
    The second argument is a LOCAL, so every command in that loop carried
    no handler and therefore no params — SAVE/RESTORE_GCODE_STATE,
    SET_GCODE_OFFSET, M220/M221 among them. The `cmd_<NAME>` name IS the
    convention, so the handler is derivable."""
    mod = _load_extractor()
    cmds = mod.extract_registry(FAKE_TREE)["commands"]
    state = cmds["SET_GCODE_STATE"]["params"]
    assert state["NAME"] == {"type": "str", "required": False,
                             "default": "default"}
    assert state["MOVE"] == {"type": "int", "required": False, "default": 0}
    assert state["MOVE_SPEED"] == {"type": "float", "required": False,
                                    "above": 0.0}
    assert cmds["GET_STATE"]["params"] == {
        "INDEX": {"type": "int", "required": False, "default": 1,
                  "minval": 0},
        "SPEED": {"type": "float", "required": False, "default": 1.0,
                  "above": 0.0},
        "OFFSET": {"type": "float", "required": False, "default": 0.0,
                   "minval": -1, "maxval": 1}}


def test_fixture_shared_dispatch_handler_not_attributed():
    """A loop that registers ONE handler for several names (gcode.py's
    builtin dispatch) must not hand that handler's params to each name."""
    mod = _load_extractor()
    cmds = mod.extract_registry(FAKE_TREE)["commands"]
    for name in ("DISPATCH_A", "DISPATCH_B"):
        assert "params" not in cmds[name], cmds[name]
        assert cmds[name]["extra"] == "gcode_move"


@pytest.mark.skipif(not REAL_KLIPPY.is_dir(), reason="reference klipper absent")
def test_real_tree_gcode_move_loop_params_present():
    """The real Klipper tree: the gcode_move handler table's params are the
    ones a start macro actually writes (M220/M221 S=, SET_GCODE_OFFSET)."""
    mod = _load_extractor()
    cmds = mod.extract_registry(REAL_KLIPPY)["commands"]
    for name in ("M220", "M221"):
        assert cmds[name]["params"]["S"]["type"] == "float", name
        assert cmds[name]["params"]["S"]["required"] is False, name
    offset = cmds["SET_GCODE_OFFSET"]["params"]
    assert offset["MOVE"] == {"type": "int", "required": False, "default": 0}
    assert offset["MOVE_SPEED"]["type"] == "float"
    assert cmds["SAVE_GCODE_STATE"]["params"]["NAME"]["default"] == "default"


def test_fixture_axis_loop_names_are_typed():
    """A numeric per-axis read names its params from the loop literal:
    `gcmd.get_float(axis)` / `get_float(axis + '_ADJUST')` over XYZE is how
    SET_GCODE_OFFSET, BED_MESH_OFFSET and G92 read every parameter they
    have. Each axis is independently optional — the caller passes a subset."""
    mod = _load_extractor()
    cmds = mod.extract_registry(FAKE_TREE)["commands"]
    params = cmds["SET_FAKE_OFFSET"]["params"]
    assert set(params) == {"X", "Y", "Z",
                           "X_ADJUST", "Y_ADJUST", "Z_ADJUST"}, params
    assert params["Y"] == {"type": "float", "required": False}
    assert params["Z_ADJUST"] == {"type": "float", "required": False}


def test_fixture_presence_axis_loop_is_not_typed():
    """G28's `gcmd.get(axis)` is a PRESENCE read: `G28 X Y` is canonical and
    carries no value, so typing X/Y/Z would fabricate 'renders EMPTY' on
    working configs. Only numeric getters may be expanded."""
    mod = _load_extractor()
    cmds = mod.extract_registry(FAKE_TREE)["commands"]
    assert "params" not in cmds["FAKE_HOME"], cmds["FAKE_HOME"]


@pytest.mark.skipif(not REAL_KLIPPY.is_dir(), reason="reference klipper absent")
def test_real_tree_per_axis_params_present_and_g28_safe():
    mod = _load_extractor()
    cmds = mod.extract_registry(REAL_KLIPPY)["commands"]
    offset = cmds["SET_GCODE_OFFSET"]["params"]
    for axis in ("X", "Y", "Z", "E"):
        assert offset[axis] == {"type": "float", "required": False}, axis
    assert offset["Z_ADJUST"]["type"] == "float"
    assert {"X", "Y"} <= set(cmds["BED_MESH_OFFSET"]["params"])
    assert {"X", "Y", "Z", "E"} <= set(cmds["G92"]["params"])
    # G28 reads its axes with a presence check — must stay untyped.
    assert not cmds["G28"].get("params"), cmds["G28"]


@pytest.mark.skipif(not REAL_KLIPPY.is_dir(), reason="reference klipper absent")
def test_real_tree_guarded_families_not_required():
    """The four exact F1/F2 false-FAILs from probe p4 must be gone."""
    mod = _load_extractor()
    cmds = mod.extract_registry(REAL_KLIPPY)["commands"]
    skew = cmds["SKEW_PROFILE"]["params"]
    assert not any(skew[n]["required"] for n in ("LOAD", "SAVE", "REMOVE"))
    assert cmds["SET_SERVO"]["params"]["ANGLE"]["required"] is False
    ms = cmds["MANUAL_STEPPER"]["params"]
    assert ms["MOVE"]["required"] is False
    tw = cmds["TEMPERATURE_WAIT"]["params"]
    assert "DEBUGOUTPUT" not in tw
    # preserved-correct entries (the SET_LED assertion of plan 2.2):
    led = cmds["SET_LED"]["params"]
    assert led["LED"]["required"] is True
    assert led["RED"] == {"type": "float", "required": False, "default": 0.0,
                          "minval": 0.0, "maxval": 1.0}


def test_fixture_literal_bounds_recorded_dynamic_ones_not():
    """v4: Klipper's own range refusals ride the param entry, but only when
    the limit is a LITERAL. `maxval=self.count` is a config value, so the
    check would be a guess — the key must be absent, not defaulted."""
    mod = _load_extractor()
    cmds = mod.extract_registry(FAKE_TREE)["commands"]
    state = cmds["GET_STATE"]["params"]
    assert state["INDEX"]["minval"] == 0
    assert "maxval" not in state["INDEX"], state["INDEX"]
    assert state["SPEED"]["above"] == 0.0
    assert state["OFFSET"] == {"type": "float", "required": False,
                               "default": 0.0, "minval": -1, "maxval": 1}


def test_fixture_schema_version_bumped():
    mod = _load_extractor()
    assert mod.SCHEMA_VERSION == 4
    registry = mod.extract_registry(FAKE_TREE)
    assert registry["schema_version"] == 4


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
def test_real_tree_optional_mux_key_when_registered_with_none():
    """A mux key registered with a literal None VALUE is optional: gcode.py
    _cmd_mux then reads it with a default. Missing it made the registry
    demand EXTRUDER/DISPLAY and the simulator false-ERROR the canonical
    single-extruder `SET_PRESSURE_ADVANCE ADVANCE=.05` and
    `SET_DISPLAY_GROUP GROUP=printing`."""
    mod = _load_extractor()
    cmds = mod.extract_registry(REAL_KLIPPY)["commands"]
    assert cmds["SET_PRESSURE_ADVANCE"]["params"]["EXTRUDER"]["required"] is False
    assert cmds["SET_DISPLAY_GROUP"]["params"]["DISPLAY"]["required"] is False
    # ...while a key only ever registered with a NAME stays required.
    assert cmds["SET_FAN_SPEED"]["params"]["FAN"]["required"] is True
    assert cmds["SYNC_EXTRUDER_MOTION"]["params"]["EXTRUDER"]["required"] is True


@pytest.mark.skipif(
    not (REAL_KLIPPY / "klippy").is_dir(),
    reason="reference/klipper tree not present",
)
def test_real_tree_scans_extras_subpackages():
    """extras/display/ is a subpackage; a non-recursive glob missed
    SET_DISPLAY_GROUP and the save gate told users it "is not a Klipper
    command"."""
    mod = _load_extractor()
    cmds = mod.extract_registry(REAL_KLIPPY)["commands"]
    assert "SET_DISPLAY_GROUP" in cmds
    assert cmds["SET_DISPLAY_GROUP"]["extra"] == "display"
    assert cmds["SET_DISPLAY_GROUP"]["requires_sections"] == ["display"]


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
    assert data["schema_version"] == 4
    assert isinstance(data["commands"], dict) and data["commands"]
    entry = data["commands"]["SET_LED"]
    assert set(entry) >= {"extra", "requires_sections", "requires_mode",
                          "params", "simulated"}
    assert entry["requires_mode"] == "any"
    assert entry["params"]["LED"]["required"] is True
