"""Class-first hardware discovery over the working project state.

`list_hardware(type=...)` answers "where are ALL my <class> sections?"
in ONE deterministic call — the structural question text-search
(`search_user_configs('led')`) answers badly: it misses `[dotstar]`,
`[pca9632]`, or `[output_pin casing_light]` unless the name happens to
contain the keyword, and the model then edits the subset it found while
claiming completeness (the partial-edit failure class the approval
architecture exists to stop).

Matching is registry-driven (parser/config_schema SECTION_DEFS: every
section_type + component_group, validated against Klipper), with two
deliberate extras:

- name tokens: a section whose *name* mentions the class counts even
  when its type lives elsewhere (`[output_pin led_strips]` is an LED);
- suffix tokens: prefixed drivers hang off their class
  (`[tmc2240 stepper_x]` matches "stepper").

Suppressed (`#[...]`) headers are not hardware and never match.

This module reads text; the CALLER decides whose text — the chat layer
passes the EditSession working state so approved-but-unsaved edits are
visible (disk would show stale sections and manufacture old_text
mismatch kickbacks).
"""
from __future__ import annotations

import re
from typing import Any

from parser.config_schema import SECTION_DEFS, get_section_def

# Model-facing class aliases -> (component groups, name/suffix tokens).
# Groups come from SECTION_DEFS; tokens catch sections whose *name* or
# *prefix-suffix* mentions the class regardless of registry group.
CLASS_ALIASES: dict[str, tuple[str, tuple[str, ...], tuple[str, ...]]] = {
    # alias -> (canonical label, groups, tokens)
    "led": ("led", ("led",), ("led", "light", "rgb", "caselight",
                       "neopixel", "dotstar", "strip", "pca9533",
                       "pca9632", "pca9685")),
    "lights": ("led", ("led",), ("led", "light", "rgb", "caselight",
                                "neopixel", "dotstar", "strip",
                                "pca9533", "pca9632", "pca9685")),
    "light": ("led", ("led",), ("led", "light", "rgb", "caselight",
                                "neopixel", "dotstar", "strip")),
    "fan": ("fan", ("fan",), ("fan",)),
    "fans": ("fan", ("fan",), ("fan",)),
    "stepper": ("stepper", ("stepper",), ("stepper",)),
    "steppers": ("stepper", ("stepper",), ("stepper",)),
    "motor": ("stepper", ("stepper",), ("stepper", "motor")),
    "extruder": ("extruder", ("extruder",), ("extruder",)),
    "heater": ("heater", ("heater",), ("heater", "heater_bed")),
    "heaters": ("heater", ("heater",), ("heater",)),
    "probe": ("probe", ("probe",), ("probe", "bltouch", "klicky",
                                   "smart_effector")),
    "probes": ("probe", ("probe",), ("probe", "bltouch", "klicky",
                                     "smart_effector")),
    "accelerometer": ("accelerometer", ("accelerometer",),
                      ("accel", "adxl", "lis2dw", "shaketune")),
    "accel": ("accelerometer", ("accelerometer",),
              ("accel", "adxl", "lis2dw", "shaketune")),
    "board": ("mcu", ("mcu",), ("mcu",)),
    "boards": ("mcu", ("mcu",), ("mcu",)),
    "mcu": ("mcu", ("mcu",), ("mcu",)),
    "mcus": ("mcu", ("mcu",), ("mcu",)),
    "display": ("display", ("display",), ("display", "screen")),
    "servo": ("servo", ("servo",), ("servo",)),
    "servos": ("servo", ("servo",), ("servo",)),
    "filament_sensor": ("filament_sensor", ("filament_sensor",),
                        ("filament",)),
    "temperature_sensor": ("temperature", ("temperature",),
                           ("thermistor", "pt1000", "temperature_probe")),
    "endstop": ("homing", ("homing",), ("endstop",)),
    "macro": ("gcode", ("gcode",), ("gcode_macro", "macro")),
    "macros": ("gcode", ("gcode",), ("gcode_macro", "macro")),
}

# Groups shown in summary mode (no type). 'config' (include/overrides)
# and 'printer' are structure, not hardware.
_SUMMARY_GROUPS = (
    "mcu", "stepper", "stepper_driver", "extruder", "heater", "fan",
    "probe", "accelerometer", "temperature", "sensor", "led", "pin",
    "servo", "display", "filament_sensor", "bed_leveling", "resonance",
    "homing", "gcode", "hardware",
)

_HEADER_RE = re.compile(r"^\s*\[([^\]#][^\]]*)\]\s*$")
_LINE_CAP = 40
_MATCH_CAP = 30


def _section_entries(text: str, filename: str) -> list[dict[str, Any]]:
    """All (header, base type, name-suffix, body) entries in one file.

    Suppressed headers ('#[...]') are skipped: a commented section is
    not hardware (graph/derivation parity).
    """
    entries: list[dict[str, Any]] = []
    header: str | None = None
    body_start = 0
    lines = text.splitlines()
    for idx, line in enumerate(lines):
        m = _HEADER_RE.match(line)
        if m:
            if header is not None:
                entries.append(_entry(header, lines[body_start:idx],
                                      filename, body_start))
            header = m.group(1).strip()
            body_start = idx + 1
    if header is not None:
        entries.append(_entry(header, lines[body_start:],
                              filename, body_start))
    return entries


def _entry(header: str, body_lines: list[str], filename: str,
           line_no: int) -> dict[str, Any]:
    parts = header.split(None, 1)
    base = parts[0] if parts else ""
    suffix = parts[1] if len(parts) > 1 else ""
    return {"header": header, "base": base, "suffix": suffix,
            "body": "\n".join(body_lines).rstrip("\n"),
            "file": filename, "line": line_no}


def _group_of(entry: dict[str, Any]) -> str:
    d = get_section_def(entry["base"])
    return d.component_group if d else ""


def _matches(entry: dict[str, Any], groups: tuple[str, ...],
             tokens: tuple[str, ...]) -> bool:
    if _group_of(entry) in groups:
        return True
    name_hay = f"{entry['base']} {entry['suffix']}".lower()
    words = set(re.split(r"[^a-z0-9]+", name_hay))
    for token in tokens:
        # whole-word on the name; substring only for the prefix-suffix
        # side, where 'stepper_x'/'ebb' live as fragments
        if token in words:
            return True
        suffix = entry["suffix"].lower()
        if suffix and token in suffix:
            return True
    return False


def _render(entry: dict[str, Any]) -> str:
    body = entry["body"]
    lines = body.splitlines()
    note = ""
    if len(lines) > _LINE_CAP:
        body = "\n".join(lines[:_LINE_CAP])
        note = (f"\n# ... ({len(lines) - _LINE_CAP} more lines — "
                f"read_user_config(filename='{entry['file']}', "
                f"section='{entry['header']}') for the rest)")
    return (f"## [{entry['header']}]  in {entry['file']} "
            f"(line {entry['line']})\n{body}{note}\n\n")


def _unknown_reply(requested: str) -> str:
    classes = ", ".join(sorted(CLASS_ALIASES))
    return (
        f"No hardware class '{requested}'. Known classes: {classes}. "
        "You can also pass a literal section type (e.g. 'bed_mesh', "
        "'idle_timeout', 'tmc2240') — it matches every section of that "
        "type. Call with no type for a summary of everything present."
    )


def list_hardware(files: dict[str, str], hw_type: str = "") -> str:
    """Render every hardware section of one class, or a full summary.

    `files` maps filename -> content (working state, not disk). Returns
    model-facing text; never raises on odd input.
    """
    hw_type = str(hw_type or "").strip().lower()
    all_entries: list[dict[str, Any]] = []
    for filename, content in (files or {}).items():
        if not isinstance(content, str) or not content.strip():
            continue
        all_entries.extend(_section_entries(content, filename))

    if not hw_type:
        return _summarize(all_entries)

    alias = CLASS_ALIASES.get(hw_type)
    if alias is not None:
        label, groups, tokens = alias
        hits = [e for e in all_entries if _matches(e, groups, tokens)]
    else:
        # Literal section-type passthrough: 'bed_mesh', 'idle_timeout',
        # 'tmc2240', even unknown types matched by base name equality.
        hits = [e for e in all_entries if e["base"].lower() == hw_type]
        if not hits:
            # maybe a component_group name was passed directly
            hits = [e for e in all_entries
                    if _group_of(e) == hw_type]
        if not hits:
            return _unknown_reply(hw_type)
        label = hw_type

    if not hits:
        return (f"No '{label}' sections found in the current project "
                "(working state, including unsaved approved edits). "
                "If the user says the hardware exists, ask where — it "
                "may genuinely be missing from the config.")

    if len(hits) > _MATCH_CAP:
        listing = "\n".join(f"- [{e['header']}] in {e['file']}"
                            for e in hits[:_MATCH_CAP])
        return (f"# list_hardware type={hw_type} — {len(hits)} matches "
                f"(showing first {_MATCH_CAP}):\n{listing}\n"
                "# Narrow with a literal section type for full text.")

    header_line = (f"# list_hardware type={hw_type} — {len(hits)} "
                   f"match{'es' if len(hits) != 1 else ''} (working "
                   "state, includes approved unsaved edits)\n")
    rendered = "".join(_render(e) for e in hits)
    law = (
        "\n# If the task applies to this hardware CLASS, apply it to "
        "EVERY match above — never a subset. Each edit uses this exact "
        "verbatim text as old_text in config_edit (patch_gcode / "
        "replace_section).\n"
    )
    return header_line + "\n" + rendered + law


def _summarize(entries: list[dict[str, Any]]) -> str:
    by_group: dict[str, list[dict[str, Any]]] = {}
    for e in entries:
        group = _group_of(e) or "other"
        by_group.setdefault(group, []).append(e)
    lines = ["# Hardware present in the current project (working "
             "state):"]
    shown = False
    for group in _SUMMARY_GROUPS:
        items = by_group.get(group)
        if not items:
            continue
        shown = True
        rendered = "; ".join(f"{e['header']} ({e['file']})"
                             for e in items)
        lines.append(f"{group} ({len(items)}): {rendered}")
    extra = [g for g in by_group if g not in _SUMMARY_GROUPS and g != "config"
             and g != "printer"]
    for group in sorted(extra):
        shown = True
        items = by_group[group]
        rendered = "; ".join(f"{e['header']} ({e['file']})"
                             for e in items)
        lines.append(f"{group} ({len(items)}): {rendered}")
    if not shown:
        lines.append("(no config sections found)")
    lines.append("# Call list_hardware(type='<class>') for full section "
                 "text + locations, e.g. type='led', type='fan', "
                 "type='stepper'.")
    return "\n".join(lines)
