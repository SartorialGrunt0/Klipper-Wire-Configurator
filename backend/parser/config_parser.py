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
    separator: str = ":"  # original separator used (: or =)
    raw_comment_suffix: str = ""  # e.g. "\t\t\t#Max 15 for ..." — full original suffix
    raw_line: str = ""  # full original line text for perfect reproduction


@dataclass
class ConfigSection:
    section_type: str  # e.g. "stepper_x", "tmc2209", "heater_fan"
    section_name: str  # e.g. "" for [stepper_x], "stepper_x" for [tmc2209 stepper_x]
    full_header: str  # e.g. "tmc2209 stepper_x", "stepper_x"
    params: list[ConfigParam] = field(default_factory=list)
    header_comments: list[str] = field(default_factory=list)
    line_number: int = 0
    trailing_comments: list[str] = field(default_factory=list)  # comments after last param
    trailing_blank_lines: int = 0  # number of blank lines after section
    is_commented_out: bool = False  # True when header was #[header] (suppressed)

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
                    "separator": p.separator,
                }
                for p in self.params
            ],
            "header_comments": self.header_comments,
            "trailing_comments": self.trailing_comments,
            "is_commented_out": self.is_commented_out,
        }


@dataclass
class ConfigFile:
    filename: str
    sections: list[ConfigSection] = field(default_factory=list)
    includes: list[str] = field(default_factory=list)
    header_comments: list[str] = field(default_factory=list)
    raw_text: str = ""
    save_config_sections: list[ConfigSection] = field(default_factory=list)
    save_config_start_line: int = 0
    # (line_number, header_text) for each malformed section header — a
    # column-0 '[' with no closing ']' on the line. Detected at parse time
    # from the raw text (the lines the parser folds into the previous value
    # or a comment are still visible there), so validation can point at the
    # exact line Klipper would refuse to load.
    unclosed_headers: list[tuple[int, str]] = field(default_factory=list)

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
            "raw_text": self.raw_text,
        }


# Regex patterns
SECTION_RE = re.compile(r"^\[([^\]]+)\]\s*(?:#.*)?$")
COMMENTED_SECTION_RE = re.compile(r"^#\[([^\]]+)\]\s*(?:#.*)?$")
INCLUDE_RE = re.compile(r"^\[include\s+([^\]]+)\]\s*(?:#.*)?$")
# A section header line that opens a '[' at column 0 but has no closing
# ']' anywhere on the line (e.g. "[mcu"). Klipper hard-fails on these
# ("Unable to read section header"); KWC used to swallow them silently.
UNCLOSED_SECTION_RE = re.compile(r"^\[[^\]]*$")
PARAM_RE = re.compile(r"^(\w[\w]*)\s*([:=])\s*(.*?)(?:\s*#(.*))?$")
COMMENTED_PARAM_RE = re.compile(r"^#\s*(\w[\w]*)\s*([:=])\s*(.*?)(?:\s*#(.*))?$")
SAVE_CONFIG_BANNER_RE = re.compile(r"^#\*#\s*<.*SAVE_CONFIG.*>\s*$")
SAVE_CONFIG_SECTION_RE = re.compile(r"^#\*#\s*\[([^\]]+)\]\s*(?:#.*)?$")
SAVE_CONFIG_PARAM_RE = re.compile(r"^#\*#\s*(\w[\w]*)\s*([:=])\s*(.*?)(?:\s*#(.*))?$")
CONTINUATION_RE = re.compile(r"^([ \t]+\S.*)$")

# Section types that take a name parameter
NAMED_SECTION_TYPES = {
    "tmc2130", "tmc2208", "tmc2209", "tmc2660", "tmc2240", "tmc5160",
    "heater_fan", "controller_fan", "temperature_fan", "fan_generic",
    "temperature_sensor", "temperature_probe", "thermistor", "adc_temperature",
    "heater_generic", "verify_heater",
    "output_pin", "static_digital_output", "multi_pin", "pwm_tool", "pwm_cycle_time",
    # static_pwm_clock.py uses load_config_prefix (named instances).
    "static_pwm_clock",
    "servo", "gcode_button",
    "neopixel", "dotstar", "led", "pca9533", "pca9632",
    "filament_switch_sensor", "filament_motion_sensor",
    "gcode_macro", "delayed_gcode",
    "display_data", "display_template", "display_glyph", "menu",
    "mcu", "board_pins",
    "autotune_tmc", "motor_constants", "motor_alias",
    "homing_heaters", "endstop_phase",
    "manual_stepper", "extruder_stepper",
    "stepper", "carriage", "extra_carriage", "dual_carriage",
    "stepper_z1", "stepper_z2", "stepper_z3",
    "ad5206", "mcp4451", "mcp4728", "mcp4018",
    "sx1509", "samd_sercom", "adc_scaled", "ads1x1x",
    "load_cell", "load_cell_probe",
    "adxl345", "lis2dw", "lis3dh", "bmi160", "mpu9250", "icm20948",
    "angle", "probe_eddy_current",
    "axis_twist_compensation", "smart_effector",
    # Moonraker update_manager entries: `[update_manager <name>]` sections
    # live in moonraker.conf (not Klipper), but they are a legitimate named
    # section type and must not be flagged as unknown by the validator.
    "update_manager",
}


def find_unclosed_headers(text: str) -> list[tuple[int, str]]:
    """Find malformed section headers in raw config text.

    A malformed header is a column-0 line that opens '[' with no closing ']'
    anywhere on the line (e.g. ``[mcu``). Klipper hard-fails on these.
    Detected from the raw text because the main parse loop folds such a line
    into the previous multi-line value or stashes it as a comment — but the
    line is still visible in the text itself.

    Indented lines and comment lines are never section headers in Klipper, so
    they're skipped. Returns ``(line_number, header_text)`` pairs.
    """
    found: list[tuple[int, str]] = []
    for idx, raw in enumerate(text.splitlines()):
        if raw[:1] in (" ", "\t") or raw.lstrip().startswith("#"):
            continue
        if UNCLOSED_SECTION_RE.match(raw):
            found.append((idx + 1, raw.strip()))
    return found


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


def _parse_save_config_sections(lines: list[str]) -> tuple[int, list[ConfigSection]]:
    save_config_start = 0
    for index, line in enumerate(lines):
        if SAVE_CONFIG_BANNER_RE.match(line.strip()):
            save_config_start = index + 1
            break

    if save_config_start == 0:
        return 0, []

    sections: list[ConfigSection] = []
    current_section: Optional[ConfigSection] = None

    for index in range(save_config_start, len(lines)):
        raw_line = lines[index]
        stripped = raw_line.strip()
        if not stripped.startswith("#*#"):
            break

        section_match = SAVE_CONFIG_SECTION_RE.match(stripped)
        if section_match:
            header = section_match.group(1).strip()
            sec_type, sec_name = parse_section_header(header)
            current_section = ConfigSection(
                section_type=sec_type,
                section_name=sec_name,
                full_header=header,
                line_number=index + 1,
            )
            sections.append(current_section)
            continue

        param_match = SAVE_CONFIG_PARAM_RE.match(stripped)
        if param_match and current_section is not None:
            current_section.params.append(ConfigParam(
                key=param_match.group(1),
                value=param_match.group(3).strip(),
                comment=param_match.group(4).strip() if param_match.group(4) else "",
                is_commented_out=False,
                line_number=index + 1,
                separator=param_match.group(2),
                raw_line=raw_line,
            ))

    return save_config_start, sections


def parse_config(text: str, filename: str = "printer.cfg") -> ConfigFile:
    """Parse a Klipper config file from text content.

    Handles multi-line values (gcode blocks, activate_gcode, etc.) that may
    contain blank lines, Jinja2 template lines, and arbitrary indented content.
    A multi-line value continues until:
      - A new section header ``[...]`` is encountered
      - A new top-level parameter ``key: value`` or ``key= value`` at column 0
      - A commented-out parameter ``#key: value`` at column 0
      - End of file
    """
    # Normalize line endings to \n so that round-trip export is consistent
    # regardless of the platform the file was created on.
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    config = ConfigFile(filename=filename, raw_text=text)
    lines = text.splitlines()

    current_section: Optional[ConfigSection] = None
    pending_comments: list[str] = []
    last_param: Optional[ConfigParam] = None
    # For tracking multi-line: we peek ahead to decide if blank/comment lines
    # are part of a multi-line value or between sections.
    i = 0
    n = len(lines)

    def _is_continuation_context(from_idx: int) -> bool:
        """Check if lines following a blank/comment are still within a
        multi-line value.  Walk forward from *from_idx* and return True if we
        hit an indented continuation line before we hit a section header, a
        top-level parameter, or end-of-file."""
        j = from_idx
        while j < n:
            l = lines[j]
            ls = l.strip()
            if not ls:
                # another blank line — keep looking
                j += 1
                continue
            if ls.startswith("#"):
                # commented-out section header is a boundary
                if COMMENTED_SECTION_RE.match(ls):
                    return False
                # comment line — could be inside gcode; keep looking
                j += 1
                continue
            if l[0] in (" ", "\t"):
                # Indented lines continue a multi-line value even if they look
                # like key/value pairs once stripped (for example board_pins aliases).
                return True
            if SECTION_RE.match(ls) or INCLUDE_RE.match(ls):
                return False
            if PARAM_RE.match(ls) or COMMENTED_PARAM_RE.match(ls):
                return False
            # Non-indented, non-param, non-section (e.g. bare Jinja line at col 0)
            # This is ambiguous; treat as continuation if preceded by a multi-line param
            return True
        return False

    def _is_commented_gcode_continuation(line: str) -> bool:
        if last_param is None or current_section is None:
            return False
        if not line.startswith("#") or len(line) < 2:
            return False
        if line[1] not in (" ", "\t"):
            return False
        return last_param.key == "gcode" or last_param.key.endswith("_gcode")

    while i < n:
        line = lines[i]
        stripped = line.strip()

        # ── Empty line ──────────────────────────────────────────
        if not stripped:
            # Could be inside a multi-line value (gcode blocks have blank lines)
            if last_param is not None and current_section is not None:
                if _is_continuation_context(i + 1):
                    last_param.value += "\n"
                    last_param.raw_line += "\n"
                    i += 1
                    continue
            # Otherwise it's a section/block boundary
            if current_section is None and pending_comments:
                config.header_comments.extend(pending_comments)
                pending_comments = []
            last_param = None
            i += 1
            continue

        # ── Include directive ───────────────────────────────────
        inc_match = INCLUDE_RE.match(stripped)
        if inc_match:
            last_param = None
            config.includes.append(inc_match.group(1).strip())
            sec = ConfigSection(
                section_type="include",
                section_name=inc_match.group(1).strip(),
                full_header=f"include {inc_match.group(1).strip()}",
                line_number=i + 1,
                header_comments=pending_comments[:],
            )
            config.sections.append(sec)
            current_section = None  # includes don't own params
            pending_comments = []
            i += 1
            continue

        # ── Section header ──────────────────────────────────────
        sec_match = SECTION_RE.match(stripped)
        if sec_match:
            last_param = None
            header = sec_match.group(1).strip()
            sec_type, sec_name = parse_section_header(header)
            current_section = ConfigSection(
                section_type=sec_type,
                section_name=sec_name,
                full_header=header,
                line_number=i + 1,
                header_comments=pending_comments[:],
            )
            config.sections.append(current_section)
            pending_comments = []
            i += 1
            continue

        # ── Continuation line (indented → multi-line value) ─────
        if last_param is not None and current_section is not None:
            cont_match = CONTINUATION_RE.match(line)
            if cont_match:
                last_param.value += "\n" + cont_match.group(1)
                last_param.raw_line += "\n" + line
                i += 1
                continue

        # ── Parameter line ──────────────────────────────────────
        param_match = PARAM_RE.match(stripped)
        if param_match and current_section is not None:
            # Attach any pending comments as trailing on this section
            # (they appeared between params in the same section)
            if pending_comments:
                # Store as special comment-params so they round-trip in order
                for c in pending_comments:
                    current_section.params.append(ConfigParam(
                        key="_comment_",
                        value=c,
                        is_commented_out=False,
                        line_number=0,
                        separator=":",
                    ))
                pending_comments = []
            p = ConfigParam(
                key=param_match.group(1),
                value=param_match.group(3).strip(),
                comment=param_match.group(4).strip() if param_match.group(4) else "",
                line_number=i + 1,
                separator=param_match.group(2),
                raw_line=line,
            )
            current_section.params.append(p)
            last_param = p
            i += 1
            continue

        # ── Commented-out parameter ─────────────────────────────
        commented_match = COMMENTED_PARAM_RE.match(stripped)
        if commented_match and current_section is not None:
            if pending_comments:
                for c in pending_comments:
                    current_section.params.append(ConfigParam(
                        key="_comment_",
                        value=c,
                        is_commented_out=False,
                        line_number=0,
                        separator=":",
                    ))
                pending_comments = []
            p = ConfigParam(
                key=commented_match.group(1),
                value=commented_match.group(3).strip(),
                comment=commented_match.group(4).strip() if commented_match.group(4) else "",
                is_commented_out=True,
                line_number=i + 1,
                separator=commented_match.group(2),
                raw_line=line,
            )
            current_section.params.append(p)
            last_param = p
            i += 1
            continue

        # ── Commented-out section header (#[header]) ────────────
        commented_sec_match = COMMENTED_SECTION_RE.match(stripped)
        if commented_sec_match:
            last_param = None
            header = commented_sec_match.group(1).strip()
            sec_type, sec_name = parse_section_header(header)
            current_section = ConfigSection(
                section_type=sec_type,
                section_name=sec_name,
                full_header=header,
                line_number=i + 1,
                header_comments=pending_comments[:],
                is_commented_out=True,
            )
            config.sections.append(current_section)
            pending_comments = []
            i += 1
            continue

        # ── Pure comment line ───────────────────────────────────
        if stripped.startswith("#"):
            # If inside a multi-line value, treat as continuation
            if last_param is not None and current_section is not None:
                if _is_commented_gcode_continuation(line) or _is_continuation_context(i + 1) or (line[0] in (" ", "\t")):
                    last_param.value += "\n" + stripped
                    last_param.raw_line += "\n" + line
                    i += 1
                    continue
            pending_comments.append(stripped)
            last_param = None
            i += 1
            continue

        # ── Unrecognised non-empty line (bare Jinja, etc.) ──────
        # If we have a multi-line param in progress, append as continuation
        if last_param is not None and current_section is not None:
            last_param.value += "\n" + stripped
            last_param.raw_line += "\n" + line
            i += 1
            continue

        # Truly unknown line — store as comment to avoid data loss
        pending_comments.append(stripped)
        last_param = None
        i += 1

    # Remaining trailing comments attach to the last section
    if pending_comments:
        if current_section is not None:
            current_section.trailing_comments = pending_comments
        else:
            config.header_comments.extend(pending_comments)

    config.save_config_start_line, config.save_config_sections = _parse_save_config_sections(lines)

    config.unclosed_headers = find_unclosed_headers(text)

    return config


def parse_config_file(filepath: str | Path) -> ConfigFile:
    """Parse a Klipper config file from a file path."""
    path = Path(filepath)
    text = path.read_text(encoding="utf-8", errors="replace")
    return parse_config(text, filename=path.name)
