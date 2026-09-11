#!/usr/bin/env python3
"""Generate backend/data/gcode_commands.json from the Klipper source tree.

Scans reference/klipper/klippy/ (gcode.py, klippy.py, extras/*.py) for
``register_command`` / ``register_mux_command`` call sites and emits the
G-code command registry: name -> gating section types, mux key, source
extra module, sim coverage flag.

Mirrors the style of scripts/generate-schema.py (generated artifact,
committed, drift-tested by tests/test_gcode_registry_extract.py).

Usage:
    python3 scripts/generate-gcode-registry.py [--klipper reference/klipper]
"""
from __future__ import annotations

import argparse
import ast
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_KLIPPER = REPO / "reference" / "klipper"
DEFAULT_OUTPUT = REPO / "backend" / "data" / "gcode_commands.json"

SCHEMA_VERSION = 1

# ---------------------------------------------------------------------------
# Gate table: extras module -> config section types whose presence enables the
# module's commands at runtime (the module's load_config/load_config_prefix
# entry point). Modules not listed gate on [] (always available once loaded by
# a builtin section, e.g. gcode_move, homing, heaters core).
#
# "family" entries note modules whose commands are only reachable through a
# parent section family (led.py commands exist only when some led-family
# section exists; neopixel.py/dotstar.py/pca9533.py instantiate led.py
# templates, so they share the same command set).
# ---------------------------------------------------------------------------
GATE_TABLE: dict[str, list[str]] = {
    # LED family (led.py registers SET_LED/SET_LED_TEMPLATE per led instance)
    "led": ["led", "neopixel", "dotstar", "pca9533"],
    "neopixel": ["led", "neopixel", "dotstar", "pca9533"],
    "dotstar": ["led", "neopixel", "dotstar", "pca9533"],
    "pca9533": ["led", "neopixel", "dotstar", "pca9533"],
    "led_effect": ["led_effect"],
    "led_template": ["led", "neopixel", "dotstar", "pca9533"],
    "neopixel_led": ["led", "neopixel"],
    # fans
    "fan": [],  # [fan] is implicit in most printers; M106/M107 broadly known
    "temperature_fan": ["temperature_fan"],
    "fan_generic": ["fan_generic"],
    # probes / leveling
    "probe": ["probe"],
    "bltouch": ["bltouch"],
    "probe_eddy_current": ["probe_eddy_current"],
    "manual_probe": [],          # used by PROBE_CALIBRATE et al. interactively
    "bed_mesh": ["bed_mesh"],
    "bed_screws": ["bed_screws"],
    "bed_tilt": ["bed_tilt"],
    "quad_gantry_level": ["quad_gantry_level"],
    "delta_calibrate": ["delta_calibrate"],
    "screws_tilt_adjust": ["screws_tilt_adjust"],
    "z_tilt": ["z_tilt"],
    "axis_twist_compensation": ["axis_twist_compensation"],
    "z_thermal_adjust": ["z_thermal_adjust"],
    "endstop_phase": ["stepper_endstop"],  # driven from stepper config
    # resonance / input shaper
    "resonance_tester": ["resonance_tester"],
    "input_shaper": ["input_shaper"],
    "shaper_calibrate": ["resonance_tester"],
    "adxl345": ["adxl345"],
    "ldc1612": ["ldc1612"],
    "ads1220": ["resonance_tester"],
    "noise_analyzer": ["noise_analyzer"],
    # TMC
    "tmc": ["tmc2130", "tmc2208", "tmc2209", "tmc2225", "tmc2240",
            "tmc2660", "tmc5160", "tmc5161", "tmc_internal"],
    "tmc_util": ["tmc2130", "tmc2208", "tmc2209", "tmc2225", "tmc2240",
                 "tmc2660", "tmc5160", "tmc5161", "tmc_internal"],
    # steppers / motion
    "manual_stepper": ["manual_stepper"],
    "force_move": [],            # STEPPER_BUZZ/FORCE_MOVE/SET_KINEMATIC_POSITION
    "stepper_enable": [],
    "gcode_arcs": ["gcode_arcs"],
    "arc_parking": ["arc_parking"],
    "homing_override": ["homing_override"],
    "safe_z_home": ["safe_z_home"],
    # heaters / temp
    "heaters": [],
    "heater_bed": [],
    "extruder": [],
    "pid_calibrate": [],
    "temperature_probe": ["temperature_probe"],
    "temperature_host": ["temperature_host"],
    "temperature_mcu": ["temperature_mcu"],
    "bme280": ["bme280"],
    "htu21d": ["htu21d"],
    "lm75": ["lm75"],
    "tmp112": ["tmp112"],
    "sc16is752": ["sc16is752"],
    # pins / outputs
    "output_pin": ["output_pin", "pwm_cycle_time"],
    "pwm_cycle_time": ["output_pin", "pwm_cycle_time"],
    "pwm_tool": ["output_pin", "pwm_cycle_time", "pwm_tool"],
    "servo": ["servo"],
    "mcp4018": ["mcp4018"],
    "mcp4451": ["mcp4451"],
    "pca9685": ["output_pin"],
    # gcode state
    "gcode_macro": [],           # SET_GCODE_VARIABLE always available
    "gcode_move": [],
    "save_variables": ["save_variables"],
    "respond": [],
    "query_adc": ["adc_temperature"],
    "virtual_sdcard": ["virtual_sdcard"],
    "sdcard_loop": ["sdcard_loop"],
    "pause_resume": ["pause_resume"],
    "idle_timeout": ["idle_timeout"],
    "print_stats": [],
    "display_status": [],
    "exclude_object": [],
    # sensors
    "filament_switch_sensor": ["filament_switch_sensor",
                               "filament_motion_sensor"],
    "filament_motion_sensor": ["filament_motion_sensor"],
    "hall_filament_width_sensor": ["hall_filament_width_sensor"],
    "tsl1401cl_filament_width_sensor": ["tsl1401cl_filament_width_sensor"],
    "hall_endstop": ["hall_endstop"],
    # buttons / misc
    "gcode_button": ["gcode_button"],
    "controller_fan": ["controller_fan"],
    "fan_generic_": ["fan_generic"],
    "palette2": ["palette2"],
    "smart_effector": ["smart_effector"],
    "load_cell": ["load_cell"],
    "load_cell_probe": ["load_cell_probe"],
    "load_cell_probe_v2": ["load_cell_probe_v2"],
    "angle": ["angle"],
    "cs1237": ["cs1237", "load_cell"],
    "z_virtual_endstop": ["stepper_z"],
    "skew_correction": ["skew_correction"],
    "tuning_tower": ["tuning_tower"],
    "firmware_retraction": ["firmware_retraction"],
    "delayed_gcode": ["delayed_gcode"],
    "multi_sensor": ["multi_sensor"],
    "probe_sample": ["probe"],
}

# Commands registered outside the scanned pattern set, or needing an override.
# value: dict merged over the extracted entry (requires_sections, ...).
# Applied by main() after extract_registry (fixture trees extract exactly
# what their source says). Currently empty: the klippy/*.py scan covers the
# pre-config builtins (gcode.py) and core commands (toolhead.py,
# configfile.py) directly.
EXTRA_MANUAL: dict[str, dict] = {}

# Commands covered by frontend/src/utils/gcodeSimulator.ts (seed list, grepped
# 2026-09 from its `case '...'` switch; refresh alongside simulator changes).
SIMULATED: list[str] = [
    "ABORT", "ACCEPT", "ACTION_CALL_REMOTE_METHOD", "ACTION_EMERGENCY_STOP",
    "ACTION_RAISE_ERROR", "ACTION_RESPOND_INFO", "ACTIVATE_EXTRUDER",
    "AXIS_TWIST_COMPENSATION_CALIBRATE", "BED_MESH_CALIBRATE",
    "BED_MESH_CLEAR", "BED_MESH_MAP", "BED_MESH_OFFSET", "BED_MESH_OUTPUT",
    "BED_MESH_PROFILE", "BED_SCREWS_ADJUST", "BED_TILT_CALIBRATE",
    "CANCEL_PRINT", "CLEAR_PAUSE", "DELTA_CALIBRATE", "EXCLUDE_OBJECT",
    "EXCLUDE_OBJECT_DEFINE", "FIRMWARE_RESTART", "FORCE_MOVE", "G0", "G1",
    "G28", "G4", "G90", "G91", "G92", "GET_POSITION", "M104", "M105",
    "M106", "M107", "M109", "M112", "M114", "M115", "M117", "M118", "M140",
    "M18", "M190", "M204", "M205", "M220", "M221", "M400", "M82", "M83",
    "M84", "M900", "MANUAL_PROBE", "PAUSE", "PID_CALIBRATE", "PROBE",
    "PROBE_ACCURACY", "PROBE_CALIBRATE", "QUAD_GANTRY_LEVEL",
]

# Interactive helper commands that Klipper registers *transiently* (only while
# an assistant flow is active). manual_probe has NO config section of its own
# (load_object from probe_calibrate), so gating NEXT/TESTZ on it could never
# be satisfied — they stay ungated. Commands whose flows are section-driven
# gate on those sections.
TRANSIENT_GATES: dict[str, list[str]] = {
    "ACCEPT": ["bed_screws", "temperature_probe", "load_cell"],
    "ADJUSTED": ["bed_screws"],
    "ABORT": ["bed_screws", "temperature_probe", "load_cell"],
    "NEXT": [],
    "TESTZ": [],
    "CALIBRATE": ["load_cell"],
    "TARE": ["load_cell"],
    "TEMPERATURE_PROBE_NEXT": ["temperature_probe"],
    "TEMPERATURE_PROBE_COMPLETE": ["temperature_probe"],
}


def _is_command_name(name: str) -> bool:
    """Klipper name rule from gcode.register_command (non-traditional cmds):
    upper-case alnum+underscore, not starting with a digit."""
    if not name:
        return False
    n = name.upper()
    if re.fullmatch(r"[A-Z][A-Z0-9_]*", n) is None:
        return False
    return True


def _literal_str(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _literal_str_list(node: ast.AST) -> list[str]:
    """Extract literal string lists: ['M20', 'M21'] or a Name bound to one
    (handlers = [...] nearby)."""
    if isinstance(node, (ast.List, ast.Tuple)):
        out = []
        for elt in node.elts:
            s = _literal_str(elt)
            if s:
                out.append(s)
        return out
    return []


class _FileVisitor(ast.NodeVisitor):
    """Collects (name, mux_key, line) registration events per file.

    Handles three shapes:
      1. gcode.register_command('NAME', func, ...) / register_mux_command(
         'NAME', 'KEY', value, func, ...)
      2. handlers = ['G1', 'G20', ...] ; for cmd in handlers:
             gcode.register_command(cmd, ...)
      3. for cmd in ['M20', ...]: register_command(cmd, ...)
    """

    def __init__(self) -> None:
        self.registrations: list[tuple[str, str | None, int]] = []
        self.list_bindings: dict[str, list[str]] = {}

    # handlers = [...] / omega_handlers = [...]
    def visit_Assign(self, node: ast.Assign) -> None:
        for tgt in node.targets:
            if isinstance(tgt, ast.Name):
                vals = _literal_str_list(node.value)
                if vals:
                    self.list_bindings[tgt.id] = vals
        self.generic_visit(node)

    # for cmd in [...]: / for cmd in handlers:
    def visit_For(self, node: ast.For) -> None:
        loop_names = _literal_str_list(node.iter)
        if not loop_names and isinstance(node.iter, ast.Name):
            loop_names = self.list_bindings.get(node.iter.id, [])
        if loop_names and isinstance(node.target, ast.Name):
            var = node.target.id
            for sub in ast.walk(node):
                if isinstance(sub, ast.Call):
                    fname = _call_name(sub.func)
                    if fname in ("register_command", "register_mux_command"):
                        if (sub.args and isinstance(sub.args[0], ast.Name)
                                and sub.args[0].id == var):
                            mux_key = None
                            if fname == "register_mux_command" and len(sub.args) > 1:
                                mux_key = _literal_str(sub.args[1])
                            for name in loop_names:
                                self.registrations.append(
                                    (name.upper(), mux_key, sub.lineno))
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        fname = _call_name(node.func)
        if fname in ("register_command", "register_mux_command") and node.args:
            name = _literal_str(node.args[0])
            if name:
                # Deregistration calls pass func=None: skip (a name with ANY
                # real-func registration is kept via the other call site).
                mux_key = None
                if fname == "register_mux_command":
                    func_idx = 3
                    if len(node.args) > 1:
                        mux_key = _literal_str(node.args[1])
                else:
                    func_idx = 1
                real_func = (len(node.args) > func_idx
                             and not (isinstance(node.args[func_idx],
                                                 ast.Constant)
                                      and node.args[func_idx].value is None))
                if real_func:
                    self.registrations.append(
                        (name.upper(), mux_key, node.lineno))
        self.generic_visit(node)


def _call_name(func: ast.AST) -> str | None:
    if isinstance(func, ast.Attribute):
        return func.attr
    if isinstance(func, ast.Name):
        return func.id
    return None


def _module_gate(name: str, module: str) -> tuple[list[str], str]:
    """(requires_sections, requires_mode) for `name` registered in `module`."""
    if name in TRANSIENT_GATES:
        return sorted(TRANSIENT_GATES[name]), "any"
    gate = GATE_TABLE.get(module)
    if gate is None:
        # unknown extras module: gate [] (warning-tier verdicts protect us)
        return [], "any"
    return sorted(gate), "any"


def extract_registry(klipper_root: Path) -> dict:
    """Extract the command registry from a Klipper source tree."""
    klippy = klipper_root / "klippy"
    files: list[tuple[str, Path]] = []
    # Top-level klippy modules register core commands (gcode.py builtins,
    # toolhead.py G4/M400/SET_VELOCITY_LIMIT, configfile.py SAVE_CONFIG).
    for p in sorted(klippy.glob("*.py")):
        files.append((p.stem, p))
    extras = klippy / "extras"
    if extras.is_dir():
        for p in sorted(extras.glob("*.py")):
            files.append((p.stem, p))
    # kinematics/ hosts extruder commands (M104/M109 live in
    # kinematics/extruder.py, not extras/).
    kin = klippy / "kinematics"
    if kin.is_dir():
        for p in sorted(kin.glob("*.py")):
            files.append((p.stem, p))

    commands: dict[str, dict] = {}

    def record(name: str, module: str, mux_key: str | None, line: int) -> None:
        if not _is_command_name(name):
            return
        name = name.upper()
        sections, mode = _module_gate(name, module)
        entry = commands.get(name)
        if entry is None:
            commands[name] = {
                "extra": module,
                "requires_sections": sections,
                "requires_mode": mode,
                "params": ({mux_key: {"required": True}} if mux_key else {}),
                "mux_key": mux_key,
                "simulated": name in SIMULATED,
                "source_line": line,
            }
        else:
            # union gates across modules (e.g. Z_OFFSET_APPLY_PROBE from
            # probe.py AND probe_eddy_current.py)
            merged = sorted(set(entry["requires_sections"]) | set(sections))
            if entry["extra"] != module and "" not in merged:
                # Cross-module union only widens gates when both gate on
                # something; a [] gate (always available) wins outright.
                if entry["requires_sections"] and sections:
                    entry["requires_sections"] = merged
                elif not sections:
                    entry["requires_sections"] = []
            if mux_key and not entry.get("mux_key"):
                entry["mux_key"] = mux_key

    for module, path in files:
        try:
            tree = ast.parse(path.read_text(), filename=str(path))
        except SyntaxError as e:  # pragma: no cover - upstream source drift
            print(f"warn: syntax error in {path}: {e}", file=sys.stderr)
            continue
        v = _FileVisitor()
        v.visit(tree)
        for name, mux_key, line in v.registrations:
            record(name, module, mux_key, line)

    # Manual extras are applied by main(), NOT inside extract_registry:
    # fixture trees must extract exactly what their source says.

    # Drop empty param dicts (v1 params are coarse; absent = unknown)
    for entry in commands.values():
        if not entry["params"]:
            del entry["params"]

    return {
        "schema_version": SCHEMA_VERSION,
        "source_rev": _git_rev(klipper_root),
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "commands": dict(sorted(commands.items())),
    }


def _git_rev(klipper_root: Path) -> str:
    try:
        return subprocess.run(
            ["git", "-C", str(klipper_root), "rev-parse", "HEAD"],
            capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return "unknown"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--klipper", default=str(DEFAULT_KLIPPER),
                    help="Klipper source tree root")
    ap.add_argument("--output", default=str(DEFAULT_OUTPUT))
    args = ap.parse_args(argv)

    klipper = Path(args.klipper)
    if not (klipper / "klippy").is_dir():
        print(f"error: {klipper / 'klippy'} not found — clone Klipper first "
              f"(git clone --depth 1 https://github.com/Klipper3d/klipper "
              f"{klipper})", file=sys.stderr)
        return 1

    registry = extract_registry(klipper)
    # Manual overrides that the scan cannot derive.
    for name, override in EXTRA_MANUAL.items():
        entry = registry["commands"].setdefault(
            name, {"extra": "gcode", "requires_sections": [],
                   "requires_mode": "any", "simulated": name in SIMULATED})
        entry.update(override)
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(registry, indent=2) + "\n")
    print(f"wrote {out} ({len(registry['commands'])} commands, "
          f"rev {registry['source_rev'][:9]})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
