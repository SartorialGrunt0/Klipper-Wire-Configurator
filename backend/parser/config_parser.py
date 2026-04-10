"""Klipper .cfg file parser.

Parses INI-style Klipper config files into structured data.
Handles sections, parameters, comments, includes, multi-line values,
and preserves formatting for round-trip editing.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


@dataclass
class ConfigParam:
    key: str
    value: str
    comment: str = ""
    is_commented_out: bool = False
    line_number: int = 0


@dataclass
class ConfigSection:
    section_type: str  # e.g. "stepper_x", "tmc2209", "heater_fan"
    section_name: str  # e.g. "" for [stepper_x], "stepper_x" for [tmc2209 stepper_x]
    full_header: str  # e.g. "tmc2209 stepper_x", "stepper_x"
    params: list[ConfigParam] = field(default_factory=list)
    header_comments: list[str] = field(default_factory=list)
    line_number: int = 0

    @property
    def display_name(self) -> str:
        return self.full_header

    def get_param(self, key: str) -> Optional[ConfigParam]:
        for p in self.params:
            if p.key == key and not p.is_commented_out:
                return p
        return None

    def get_value(self, key: str, default: str = "") -> str:
        p = self.get_param(key)
        return p.value if p else default

    def get_all_param(self, key: str) -> list[ConfigParam]:
        return [p for p in self.params if p.key == key]

    def to_dict(self) -> dict:
        return {
            "section_type": self.section_type,
            "section_name": self.section_name,
            "full_header": self.full_header,
            "line_number": self.line_number,
            "params": [
                {
                    "key": p.key,
                    "value": p.value,
                    "comment": p.comment,
                    "is_commented_out": p.is_commented_out,
                }
                for p in self.params
            ],
            "header_comments": self.header_comments,
        }


@dataclass
class ConfigFile:
    filename: str
    sections: list[ConfigSection] = field(default_factory=list)
    includes: list[str] = field(default_factory=list)
    header_comments: list[str] = field(default_factory=list)
    raw_text: str = ""

    def get_section(self, full_header: str) -> Optional[ConfigSection]:
        for s in self.sections:
            if s.full_header == full_header:
                return s
        return None

    def get_sections_by_type(self, section_type: str) -> list[ConfigSection]:
        return [s for s in self.sections if s.section_type == section_type]

    def to_dict(self) -> dict:
        return {
            "filename": self.filename,
            "sections": [s.to_dict() for s in self.sections],
            "includes": self.includes,
            "header_comments": self.header_comments,
        }


# Regex patterns
SECTION_RE = re.compile(r"^\[([^\]]+)\]\s*(?:#.*)?$")
INCLUDE_RE = re.compile(r"^\[include\s+([^\]]+)\]\s*(?:#.*)?$")
PARAM_RE = re.compile(r"^(\w[\w]*)\s*[:=]\s*(.*?)(?:\s*#(.*))?$")
COMMENTED_PARAM_RE = re.compile(r"^#\s*(\w[\w]*)\s*[:=]\s*(.*?)(?:\s*#(.*))?$")
CONTINUATION_RE = re.compile(r"^[ \t]+(\S.*)$")

# Section types that take a name parameter
NAMED_SECTION_TYPES = {
    "tmc2130", "tmc2208", "tmc2209", "tmc2660", "tmc2240", "tmc5160",
    "heater_fan", "controller_fan", "temperature_fan", "fan_generic",
    "temperature_sensor", "temperature_probe", "thermistor", "adc_temperature",
    "heater_generic", "verify_heater",
    "output_pin", "static_digital_output", "multi_pin", "pwm_tool", "pwm_cycle_time",
    "servo", "gcode_button",
    "neopixel", "dotstar", "led", "pca9533", "pca9632",
    "filament_switch_sensor", "filament_motion_sensor",
    "gcode_macro", "delayed_gcode",
    "display_data", "display_template", "display_glyph", "menu",
    "mcu", "board_pins",
    "homing_heaters", "endstop_phase",
    "manual_stepper", "extruder_stepper",
    "stepper_z1", "stepper_z2", "stepper_z3",
    "ad5206", "mcp4451", "mcp4728", "mcp4018",
    "sx1509", "samd_sercom", "adc_scaled", "ads1x1x",
    "load_cell", "load_cell_probe",
    "adxl345", "lis2dw", "lis3dh", "bmi160", "mpu9250", "icm20948",
    "angle", "probe_eddy_current",
    "axis_twist_compensation", "smart_effector",
}


def parse_section_header(header: str) -> tuple[str, str]:
    """Parse a section header into (section_type, section_name).

    Examples:
        "stepper_x" -> ("stepper_x", "")
        "tmc2209 stepper_x" -> ("tmc2209", "stepper_x")
        "heater_fan my_fan" -> ("heater_fan", "my_fan")
        "include file.cfg" -> ("include", "file.cfg")
        "gcode_macro START_PRINT" -> ("gcode_macro", "START_PRINT")
    """
    parts = header.strip().split(None, 1)
    if len(parts) == 1:
        return (parts[0], "")

    type_part, name_part = parts
    if type_part in NAMED_SECTION_TYPES or type_part == "include":
        return (type_part, name_part)

    # Check if this looks like a named variant (e.g., extruder1, stepper_z1)
    return (header.strip(), "")


def parse_config(text: str, filename: str = "printer.cfg") -> ConfigFile:
    """Parse a Klipper config file from text content."""
    config = ConfigFile(filename=filename, raw_text=text)
    lines = text.splitlines()

    current_section: Optional[ConfigSection] = None
    pending_comments: list[str] = []
    last_param: Optional[ConfigParam] = None

    for line_num, line in enumerate(lines, 1):
        stripped = line.strip()

        # Empty line
        if not stripped:
            if current_section is None:
                if pending_comments:
                    config.header_comments.extend(pending_comments)
                    pending_comments = []
            last_param = None
            continue

        # Include directive
        inc_match = INCLUDE_RE.match(stripped)
        if inc_match:
            config.includes.append(inc_match.group(1).strip())
            # Also add as a section for completeness
            sec = ConfigSection(
                section_type="include",
                section_name=inc_match.group(1).strip(),
                full_header=f"include {inc_match.group(1).strip()}",
                line_number=line_num,
                header_comments=pending_comments[:],
            )
            config.sections.append(sec)
            pending_comments = []
            last_param = None
            continue

        # Section header
        sec_match = SECTION_RE.match(stripped)
        if sec_match:
            header = sec_match.group(1).strip()
            sec_type, sec_name = parse_section_header(header)
            current_section = ConfigSection(
                section_type=sec_type,
                section_name=sec_name,
                full_header=header,
                line_number=line_num,
                header_comments=pending_comments[:],
            )
            config.sections.append(current_section)
            pending_comments = []
            last_param = None
            continue

        # Continuation line (indented, belongs to previous param)
        cont_match = CONTINUATION_RE.match(line)
        if cont_match and last_param is not None and current_section is not None:
            last_param.value += "\n" + cont_match.group(1)
            continue

        # Parameter line
        param_match = PARAM_RE.match(stripped)
        if param_match and current_section is not None:
            p = ConfigParam(
                key=param_match.group(1),
                value=param_match.group(2).strip(),
                comment=param_match.group(3).strip() if param_match.group(3) else "",
                line_number=line_num,
            )
            current_section.params.append(p)
            last_param = p
            continue

        # Commented-out parameter
        commented_match = COMMENTED_PARAM_RE.match(stripped)
        if commented_match and current_section is not None:
            p = ConfigParam(
                key=commented_match.group(1),
                value=commented_match.group(2).strip(),
                comment=commented_match.group(3).strip() if commented_match.group(3) else "",
                is_commented_out=True,
                line_number=line_num,
            )
            current_section.params.append(p)
            last_param = p
            continue

        # Pure comment line
        if stripped.startswith("#"):
            pending_comments.append(stripped)
            last_param = None
            continue

    # Remaining top-level comments
    if pending_comments and current_section is None:
        config.header_comments.extend(pending_comments)

    return config


def parse_config_file(filepath: str | Path) -> ConfigFile:
    """Parse a Klipper config file from a file path."""
    path = Path(filepath)
    text = path.read_text(encoding="utf-8", errors="replace")
    return parse_config(text, filename=path.name)
