"""Klipper configuration validator.

Checks for:
- Required parameters missing
- Invalid parameter types
- Unknown sections
- Duplicate sections (when max_instances=1)
- Missing required hardware dependencies
- Pin conflicts
- Invalid enum values
"""
from __future__ import annotations

import glob
import os
import re
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Optional

import jinja2

from parser.config_parser import ConfigFile, ConfigSection
from parser.config_schema import (
    SECTION_DEFS,
    ParamType,
    get_section_def,
)
from services.warning_acknowledgments import (
    canonicalize_section,
    load_acknowledged_duplicate_section_types,
    load_acknowledged_warning_sections,
)


@dataclass
class ValidationError:
    severity: str  # "error", "warning", "info"
    section: str  # Section header where error occurs
    param: str  # Parameter name (empty if section-level)
    message: str
    line_number: int = 0
    # Stable machine-facing identity for error classes that the frontend
    # branches on (retry-exempt, acknowledge gate, Jinja repair derivation).
    # Empty string when no consumer needs a code. `message` stays human-facing
    # and may be reworded freely without breaking those branches.
    code: str = ""

    def to_dict(self) -> dict:
        return {
            "severity": self.severity,
            "section": self.section,
            "param": self.param,
            "message": self.message,
            "line_number": self.line_number,
            "code": self.code,
        }


@dataclass
class ValidationResult:
    errors: list[ValidationError] = field(default_factory=list)

    @property
    def has_errors(self) -> bool:
        return any(e.severity == "error" for e in self.errors)

    @property
    def has_warnings(self) -> bool:
        return any(e.severity == "warning" for e in self.errors)

    def to_dict(self) -> dict:
        return {
            "has_errors": self.has_errors,
            "has_warnings": self.has_warnings,
            "errors": [e.to_dict() for e in self.errors],
        }


@dataclass(frozen=True)
class PinUse:
    pin: str
    section: str
    section_type: str
    param: str
    line_number: int = 0
    filename: str = ""

    @property
    def label(self) -> str:
        if self.filename:
            return f"{self.filename}:[{self.section}] {self.param}"
        return f"[{self.section}] {self.param}"


PIN_RE = re.compile(
    r"^[!^~]*(?:[A-Za-z0-9_][A-Za-z0-9_-]*:\s*)?(?:<[^>]+>|[A-Za-z0-9_]+(?:[./][A-Za-z0-9_]+)*)$",
    re.IGNORECASE,
)
LETTERED_STEPPER_RE = re.compile(r"^stepper_([a-w])$", re.IGNORECASE)
SCREW_PARAM_RE = re.compile(r"^screw\d+$", re.IGNORECASE)


REQUIREMENT_COMPONENT_GROUPS: dict[str, set[str]] = {
    "probe": {"probe"},
    "adxl345": {"accelerometer"},
}

# Base stepper sections each kinematics looks up BY EXACT NAME at startup.
# Ground truth (Klipper source, verified 2026-08-25):
#   cartesian/corexy/hybrid_corexy: LookupMultiRail(getsection('stepper_' + n))
#       for n in 'xyz'  (cartesian.py:21, corexy.py:13, hybrid_corexy.py:15-17)
#   delta/rotary_delta: rail_a/b/c from getsection('stepper_a'/'b'/'c')
#       (delta.py, rotary_delta.py)
#   deltesian: [getsection('stepper_' + s) for s in ('left','right','y')]
#       (deltesian.py:19)
#   polar: getsection('stepper_arm'/'stepper_bed'/'stepper_z') (polar.py)
#   winch: loops 'stepper_a'..'stepper_z', getsection on the first present one
#       (winch.py:13-17) — requires at least [stepper_a]
# Numbered extras (stepper_x1, stepper_z2, ...) are OPTIONAL additional rails on
# the same axis (LookupMultiRail appends them; winch adds anchors) and never
# satisfy the base lookup, which is by exact section name.
KINEMATICS_BASE_STEPPERS: dict[str, list[str]] = {
    "cartesian": ["stepper_x", "stepper_y", "stepper_z"],
    "corexy": ["stepper_x", "stepper_y", "stepper_z"],
    "hybrid_corexy": ["stepper_x", "stepper_y", "stepper_z"],
    "delta": ["stepper_a", "stepper_b", "stepper_c"],
    "rotary_delta": ["stepper_a", "stepper_b", "stepper_c"],
    "deltesian": ["stepper_left", "stepper_right", "stepper_y"],
    "polar": ["stepper_arm", "stepper_bed", "stepper_z"],
    "winch": ["stepper_a"],
}

PROBE_PLUGIN_SECTION_TYPES = {"beacon"}

# TMC driver section types whose header word references the stepper section
# the driver controls (name_references="stepper"). Ground truth (tmc.py
# TMCMicrostepHelper, called unconditionally from the TMC base at tmc.py:339):
#   stepper_name = " ".join(config.get_name().split()[1:])
#   if not config.has_section(stepper_name):
#       raise config.error("Could not find config section '[%s]' ...")
#   mres = sconfig.getchoice('microsteps',
#       {256: 0, 128: 1, 64: 2, 32: 3, 16: 4, 8: 5, 4: 6, 2: 7, 1: 8})
# Both are config-load hard-fails. The microsteps restriction applies ONLY to
# steppers a TMC driver references: a plain stepper reads microsteps as a
# plain getint(minval=1) (stepper.py) and accepts any int — which is why the
# microsteps schema enum could not be seeded statically (3n).
TMC_STEPPER_DRIVER_TYPES = frozenset(
    st for st, sd in SECTION_DEFS.items() if sd.name_references == "stepper"
)
TMC_MRES_VALUES = (1, 2, 4, 8, 16, 32, 64, 128, 256)


@dataclass(frozen=True)
class SpecialTemperatureSensorUse:
    filename: str
    section: ConfigSection
    sensor_type: str
    sensor_target: str


def _basename(filename: str) -> str:
    return filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]


def _get_printer_kinematics(config: ConfigFile) -> str | None:
    printer = config.get_section("printer")
    if printer is None or printer.is_commented_out:
        return None
    kinematics = printer.get_value("kinematics").strip().lower()
    return kinematics or None


def _normalize_pin_values(value: str) -> list[str]:
    pins: list[str] = []
    for raw_pin in value.split(","):
        clean_pin = re.sub(r"\s*:\s*", ":", raw_pin.lstrip("!^~").strip())
        if clean_pin and not clean_pin.startswith("<"):
            pins.append(clean_pin)
    return pins


def _find_main_project_file(configs: dict[str, ConfigFile]) -> str | None:
    if not configs:
        return None

    for filename in configs:
        if _basename(filename) == "printer.cfg":
            return filename

    max_includes = -1
    max_file: str | None = None
    for filename, config in configs.items():
        if len(config.includes) > max_includes:
            max_includes = len(config.includes)
            max_file = filename
    if max_file is not None:
        return max_file

    for filename, config in configs.items():
        if any(section.section_type == "mcu" and not section.section_name for section in config.sections):
            return filename

    return next(iter(configs))


def _get_active_project_files(configs: dict[str, ConfigFile]) -> set[str]:
    main_file = _find_main_project_file(configs)
    if main_file is None:
        return set()

    basename_map = {_basename(filename): filename for filename in configs}
    active_files = {main_file}
    pending = [main_file]

    while pending:
        filename = pending.pop()
        for include_path in configs[filename].includes:
            target = include_path if include_path in configs else basename_map.get(_basename(include_path))
            if target is None or target in active_files:
                continue
            active_files.add(target)
            pending.append(target)

    return active_files


def _project_duplicate_message(sec_type: str, other_files: list[str]) -> str:
    # Cross-file duplication of a singleton section is INFO: Klipper merges
    # duplicate sections (RawConfigParser(strict=False), later file wins) and
    # never hard-fails. The finding's value is stating the precedence — which
    # definition wins — not alarm.
    message = f"Section [{sec_type}] is also defined in: {', '.join(other_files)}."
    message += " Klipper merges duplicate sections — the later include"
    message += " takes precedence."
    return message


def _is_suppressed_for_validation(section: ConfigSection, category: str | None) -> bool:
    # Suppressed sub-components/features should not participate in validation.
    if category not in ("sub_component", "feature"):
        return False
    if section.is_commented_out:
        return True
    real_params = [p for p in section.params if p.key != "_comment_"]
    return bool(real_params) and all(p.is_commented_out for p in real_params)


def _collect_special_temperature_sensor_uses(
    configs: dict[str, ConfigFile],
    *,
    active_files: set[str] | None = None,
) -> list[SpecialTemperatureSensorUse]:
    uses: list[SpecialTemperatureSensorUse] = []

    for filename, config in configs.items():
        if active_files is not None and filename not in active_files:
            continue

        for section in config.sections:
            if section.section_type != "temperature_sensor" or section.is_commented_out:
                continue

            sec_def = get_section_def(section.section_type)
            if _is_suppressed_for_validation(section, sec_def.category if sec_def else None):
                continue

            sensor_type = section.get_value("sensor_type").strip()
            if sensor_type == "temperature_host":
                uses.append(SpecialTemperatureSensorUse(
                    filename=filename,
                    section=section,
                    sensor_type=sensor_type,
                    sensor_target="host",
                ))
            elif sensor_type == "temperature_mcu":
                uses.append(SpecialTemperatureSensorUse(
                    filename=filename,
                    section=section,
                    sensor_type=sensor_type,
                    sensor_target=section.get_value("sensor_mcu", "mcu").strip() or "mcu",
                ))

    return uses


def _format_special_temperature_sensor_conflicts(
    uses: list[SpecialTemperatureSensorUse],
    current: SpecialTemperatureSensorUse,
) -> str:
    multi_file = len({use.filename for use in uses}) > 1
    references: list[str] = []

    for use in uses:
        if (
            use.filename == current.filename
            and use.section.full_header == current.section.full_header
            and use.section.line_number == current.section.line_number
        ):
            continue

        if multi_file:
            references.append(f"{use.filename}:[{use.section.full_header}]")
        else:
            references.append(f"[{use.section.full_header}]")

    return ", ".join(references)


def _append_special_temperature_sensor_errors(
    results_by_file: dict[str, ValidationResult],
    uses: list[SpecialTemperatureSensorUse],
    *,
    require_multiple_files: bool = False,
):
    host_uses = [use for use in uses if use.sensor_type == "temperature_host"]
    if len(host_uses) > 1 and (not require_multiple_files or len({use.filename for use in host_uses}) > 1):
        for use in host_uses:
            message = "Only one [temperature_sensor] may use 'temperature_host'."
            conflicts = _format_special_temperature_sensor_conflicts(host_uses, use)
            if conflicts:
                message += f" Also defined in: {conflicts}."

            result = results_by_file[use.filename]
            if not any(
                error.severity == "error"
                and error.section == use.section.full_header
                and error.param == "sensor_type"
                and error.message == message
                for error in result.errors
            ):
                result.errors.append(ValidationError(
                    severity="error",
                    section=use.section.full_header,
                    param="sensor_type",
                    message=message,
                    line_number=use.section.line_number,
                ))

    mcu_uses_by_target: dict[str, list[SpecialTemperatureSensorUse]] = {}
    for use in uses:
        if use.sensor_type != "temperature_mcu":
            continue
        mcu_uses_by_target.setdefault(use.sensor_target, []).append(use)

    for sensor_target, target_uses in mcu_uses_by_target.items():
        if len(target_uses) <= 1:
            continue
        if require_multiple_files and len({use.filename for use in target_uses}) <= 1:
            continue

        for use in target_uses:
            message = f"Only one [temperature_sensor] may use 'temperature_mcu' for MCU '{sensor_target}'."
            conflicts = _format_special_temperature_sensor_conflicts(target_uses, use)
            if conflicts:
                message += f" Also defined in: {conflicts}."

            result = results_by_file[use.filename]
            if not any(
                error.severity == "error"
                and error.section == use.section.full_header
                and error.param == "sensor_type"
                and error.message == message
                for error in result.errors
            ):
                result.errors.append(ValidationError(
                    severity="error",
                    section=use.section.full_header,
                    param="sensor_type",
                    message=message,
                    line_number=use.section.line_number,
                ))


# Klipper's own macro template environment (klippy/extras/gcode_macro.py):
# custom single-brace variable delimiters. Parsing gcode bodies with the
# same engine flags unbalanced {% if %}/{% endif %}, {% for %}/{% endfor %},
# {% raw %}/{% endraw %}, and other template syntax errors exactly as Klippy
# would when loading the macro.
_MACRO_JINJA_ENV = jinja2.Environment("{%", "%}", "{", "}")

# Section types whose bodies are Jinja templates evaluated by Klipper. The
# gcode family stores the body in 'gcode'; display_template / display_data
# store it in 'text' and load it through the same gcode_macro.load_template
# machinery (klippy/extras/display/display.py DisplayTemplate.__init__ /
# DisplayGroup.__init__), so both are validated with the identical env.
_MACRO_TEMPLATE_SECTIONS = frozenset({"gcode_macro", "delayed_gcode"})
_DISPLAY_TEMPLATE_SECTIONS = frozenset({"display_template", "display_data"})
_TEMPLATE_SECTION_BODIES = {
    **{sec: "gcode" for sec in _MACRO_TEMPLATE_SECTIONS},
    **{sec: "text" for sec in _DISPLAY_TEMPLATE_SECTIONS},
}

# Compile results are cached by comment-stripped body: project validation runs
# on every load (and per file), so a config with many macros spends most of its
# startup time re-parsing the same template text. Line numbers returned are
# body-relative and re-based at call time, so cached entries are safe to reuse
# across sections/files. Bounded to keep memory in check.
@lru_cache(maxsize=2048)
def _compile_macro_template(body: str) -> tuple[str, int] | None:
    """Compile a stripped gcode body as Klipper Jinja.

    Returns None when the template is valid, or (message, body_lineno) on a
    TemplateSyntaxError. body_lineno is 1-indexed within the gcode body.
    """
    # A body with no '{' at all is plain text — jinja2 can never raise on it.
    # ~half of real-world macros are plain G-code, so skip the compile entirely
    # (behavior-identical: from_string on text-only templates always succeeds).
    if "{" not in body:
        return None
    try:
        _MACRO_JINJA_ENV.from_string(body)
        return None
    except jinja2.exceptions.TemplateSyntaxError as exc:
        # str(None) renders "None" — same output the caller's f-string produced.
        return (str(exc.message), exc.lineno)


def _strip_inline_comments(body: str) -> str:
    """Mirror Klipper's config parsing before templates reach jinja2.

    Two passes, matching how Klippy actually reads a config:
    1. klippy/configfile.py _parse_config strips from the first '#' on every
       line unconditionally (community macros write '#' as \\x23 inside jinja
       strings to survive this, e.g. sample-macros.cfg M117).
    2. configparser inline_comment_prefixes=(';', '#') strips ';' only when
       preceded by whitespace or at line start — so 'split(\\';\\', 1)' inside
       a jinja expression is preserved while 'G28 ; home' is not.
    """
    stripped_lines = []
    for line in body.split("\n"):
        hash_pos = line.find("#")
        if hash_pos >= 0:
            line = line[:hash_pos]
        semi_match = re.search(r"(?:^|\s);", line)
        if semi_match:
            line = line[: semi_match.start() + 1]
        stripped_lines.append(line)
    return "\n".join(stripped_lines)


def _validate_macro_jinja(section: ConfigSection, result: ValidationResult) -> None:
    """Validate a Jinja-template body (gcode_macro / delayed_gcode /
    display_template / display_data) as a Klipper Jinja template.

    Catches structural template errors (dropped {% endif %}, unbalanced
    {% for %}/{% endfor %}, malformed blocks) that a plain config parser
    cannot see because the body is opaque text to it. Uses the same
    jinja2 environment Klipper builds for macros, so valid Klipper
    single-brace syntax ({printer.x}) is accepted. The body param is 'gcode'
    for the gcode family and 'text' for the display family.
    """
    body_param = _TEMPLATE_SECTION_BODIES[section.section_type]
    gcode_param = section.get_param(body_param)
    if gcode_param is None:
        return
    body = gcode_param.value
    if not body.strip():
        return
    # Klipper strips inline #/; comments from every config line before
    # the body is templated; do the same so community comment styles do
    # not false-positive.
    outcome = _compile_macro_template(_strip_inline_comments(body))
    if outcome is None:
        return
    message, body_lineno = outcome
    # body_lineno is 1-indexed within the body, which starts on the
    # line after the body key ('gcode:' / 'text:').
    # Code only for the dropped-closer case: it's the class the AI repair
    # loop derives a prescriptive "append {% endX %}" fix from. Other
    # template errors (bad expression, stray brace) get no code.
    label = "macro" if section.section_type in _MACRO_TEMPLATE_SECTIONS else "display template"
    result.errors.append(ValidationError(
        severity="error",
        section=section.full_header,
        param=body_param,
        message=f"Jinja template error in {label}: {message}",
        line_number=gcode_param.line_number + body_lineno,
        code="macro_jinja_unterminated" if "Unexpected end of template" in message else "",
    ))


def _validate_neopixel_color_order(section: ConfigSection, result: ValidationResult) -> None:
    """Validate neopixel.color_order entries are permutations of RGB or RGBW.

    Ground truth (klippy/extras/neopixel.py:29-37):
        color_order = config.getlist("color_order", ["GRB"])
        ...
        for lidx, co in enumerate(color_order):
            if sorted(co) not in (sorted("RGB"), sorted("RGBW")):
                raise config.error("Invalid color_order '%s'" % (co,))
    It is a per-chain list (one entry per LED chain), so it is checked entry
    by entry rather than as a single enum value.
    """
    param = section.get_param("color_order")
    if param is None or not param.value:
        return
    entries = [e.strip() for e in param.value.split(",") if e.strip()]
    for entry in entries:
        if sorted(entry) not in (sorted("RGB"), sorted("RGBW")):
            result.errors.append(ValidationError(
                severity="error",
                section=section.full_header,
                param="color_order",
                message=f"Invalid color_order '{entry}'. Each entry must be a permutation of RGB or RGBW.",
                line_number=param.line_number,
            ))


def validate_config(config: ConfigFile) -> ValidationResult:
    """Validate a full configuration file."""
    result = ValidationResult()
    acknowledged_sections = load_acknowledged_warning_sections()
    acknowledged_duplicate_types = load_acknowledged_duplicate_section_types()
    printer_kinematics = _get_printer_kinematics(config)

    # Malformed section header (column-0 '[' with no closing ']') — Klipper
    # hard-fails at load with "Unable to read section header", so this is an
    # error that blocks save. The parser records the exact line; the section
    # header itself is absent from config.sections, so this check runs
    # independently of the per-section loop below.
    for line_number, header_text in config.unclosed_headers:
        result.errors.append(ValidationError(
            severity="error",
            section=header_text.lstrip("[").strip() or header_text,
            param="",
            message=(
                f"Section header '{header_text}' is missing its closing ']' — "
                "Klipper will refuse to load this file. Add the closing "
                "bracket (e.g. '[mcu mainboard]')."
            ),
            line_number=line_number,
            code="unclosed_section_header",
        ))

    section_counts: dict[str, int] = {}
    used_pins: dict[str, list[PinUse]] = {}
    defined_sections: set[str] = set()
    save_config_params_by_header: dict[str, set[str]] = {}
    save_config_section_types: set[str] = set()
    save_config_component_groups: set[str] = set()

    for save_section in config.save_config_sections:
        save_config_params_by_header.setdefault(save_section.full_header, set()).update({
            param.key
            for param in save_section.params
            if not param.is_commented_out and param.key != "_comment_"
        })
        defined_sections.add(save_section.full_header)
        # SAVE_CONFIG sections contribute persisted values for existing sections,
        # but they should not satisfy cross-section hardware dependencies.

    for section in config.sections:
        if section.section_type == "include" or section.is_commented_out:
            continue
        sec_type = section.section_type

        # Get schema definition
        sec_def = get_section_def(sec_type)

        if _is_suppressed_for_validation(section, sec_def.category if sec_def else None):
            continue

        # Validate Jinja-template bodies (gcode_macro / delayed_gcode use
        # 'gcode'; display_template / display_data use 'text') so dropped
        # {% endif %} and similar structural errors are caught in the
        # graph/text editors and the AI draft retry loop.
        if sec_type in _MACRO_TEMPLATE_SECTIONS or sec_type in _DISPLAY_TEMPLATE_SECTIONS:
            _validate_macro_jinja(section, result)

        # neopixel.color_order: each entry must be a permutation of RGB or
        # RGBW (extras/neopixel.py:33-37). It is a per-chain list, not a plain
        # enum, so it gets a dedicated check.
        if sec_type == "neopixel":
            _validate_neopixel_color_order(section, result)

        defined_sections.add(section.full_header)

        # Track section counts
        section_counts[sec_type] = section_counts.get(sec_type, 0) + 1

        if sec_def is None:
            if canonicalize_section(section) in acknowledged_sections:
                continue
            # Unknown section - just a warning
            result.errors.append(ValidationError(
                severity="warning",
                section=section.full_header,
                param="",
                message=f"Unknown section type '{sec_type}'. Parameters won't be validated.",
                line_number=section.line_number,
                code="unknown_section",
            ))
            continue

        # Check max instances
        # Klipper merges a duplicated singleton section (later definition
        # wins) and never hard-fails, so this is info — legal, order-
        # dependent, no action required. The old warning tier forced ack +
        # save-button yellow on a finding that was not wrong (3.5).
        # An acknowledged section type still suppresses the finding (ack is
        # per type — existing users' acks stay effective).
        if sec_def.max_instances == 1 and section_counts[sec_type] > 1:
            if sec_type not in acknowledged_duplicate_types:
                result.errors.append(ValidationError(
                    severity="info",
                    section=section.full_header,
                    param="",
                    message=(
                        f"Section [{sec_type}] is defined multiple times in this"
                        " file — the later definition wins."
                    ),
                    line_number=section.line_number,
                    code="project_duplicate",
                ))

        # Check required parameters
        active_params = {
            p.key
            for p in section.params
            if not p.is_commented_out and p.key != "_comment_"
        }
        active_params |= save_config_params_by_header.get(section.full_header, set())
        for param_def in sec_def.params:
            if not param_def.required or param_def.name in active_params:
                continue
            if _skip_missing_required_param(section, param_def.name, active_params):
                continue
            result.errors.append(ValidationError(
                severity="error",
                section=section.full_header,
                param=param_def.name,
                message=f"Required parameter '{param_def.name}' is missing.",
                line_number=section.line_number,
            ))

        if sec_type == "printer":
            _validate_printer_requirements(section, active_params, result)
        elif sec_type == "bed_mesh":
            _validate_bed_mesh_requirements(section, active_params, result)

        if LETTERED_STEPPER_RE.match(sec_type):
            _validate_lettered_stepper_requirements(section, active_params, printer_kinematics, result)

        if sec_type in {"bed_screws", "screws_tilt_adjust"}:
            _validate_minimum_screw_count(section, active_params, result)

        # Sensorless homing warning: diag_pin or driver_SGTHRS with homing_retract_dist != 0
        if sec_type.startswith("stepper") or sec_type.startswith("extruder"):
            _check_sensorless_homing_warning(section, result, config)

        # MCU-specific: validate communication method (serial XOR canbus_uuid)
        if sec_type == "mcu":
            has_serial = "serial" in active_params
            has_baud = "baud" in active_params
            has_canbus = "canbus_uuid" in active_params
            if has_serial and has_canbus:
                result.errors.append(ValidationError(
                    severity="error",
                    section=section.full_header,
                    param="serial",
                    message="Cannot specify both 'serial' and 'canbus_uuid'. Use one communication method.",
                    line_number=section.line_number,
                ))
            elif not has_serial and not has_canbus:
                result.errors.append(ValidationError(
                    severity="error",
                    section=section.full_header,
                    param="serial",
                    message="MCU requires either 'serial' (USB/UART) or 'canbus_uuid' (CAN bus) to be set.",
                    line_number=section.line_number,
                ))
            if has_canbus and has_baud:
                result.errors.append(ValidationError(
                    severity="error",
                    section=section.full_header,
                    param="baud",
                    message="Cannot specify 'baud' when 'canbus_uuid' is set. Baud only applies to serial connections.",
                    line_number=section.line_number,
                ))

        # Validate individual parameters
        for param in section.params:
            if param.is_commented_out or param.key == "_comment_":
                continue

            # Find param definition (case-insensitive match)
            param_def = _find_param_def(sec_def, param.key)

            if param_def is None:
                result.errors.append(ValidationError(
                    severity="warning",
                    section=section.full_header,
                    param=param.key,
                    message=f"Unknown parameter '{param.key}' for section [{sec_type}].",
                    line_number=param.line_number,
                    code="unknown_param",
                ))
                continue

            # Type validation
            _validate_param_value(param, param_def, section, result)

            # Relational validation (param A vs param B, same section)
            _check_relational_param(param, param_def, section, result)

            # Track pin usage
            if param_def.param_type == ParamType.PIN and param.value:
                _track_pin_usage(param, section, used_pins)

    # Check for required sections
    _append_special_temperature_sensor_errors(
        {config.filename: result},
        _collect_special_temperature_sensor_uses({config.filename: config}),
    )

    _check_dependencies(
        config,
        defined_sections,
        save_config_section_types,
        save_config_component_groups,
        result,
    )

    # Check for pin conflicts
    _check_pin_conflicts(
        used_pins,
        result,
        _collect_duplicate_pin_override_pins(
            {config.filename: config}, {config.filename},
        ),
    )

    return result


def validate_project_configs(configs: dict[str, ConfigFile]) -> dict[str, ValidationResult]:
    """Validate a set of config files as one Klipper project.

    Single-file validation remains file-local. For multi-file projects, this
    adds cross-file checks for sections that Klipper allows only once across the
    effective configuration, such as [printer], [stepper_x], or [stepper_z].
    Duplicates are info findings (Klipper merges them, later file wins —
    legal, no action required); an acknowledged section type suppresses them.
    """
    results = {
        filename: validate_config(config)
        for filename, config in configs.items()
    }

    # Cross-section references (F25): a TMC driver's header references the
    # stepper section it drives; Klipper resolves it at config load
    # regardless of file count (tmc.py), so this runs for single-file
    # projects too (unlike the cross-file passes below it).
    _check_tmc_stepper_references(configs, results, _get_active_project_files(configs))

    if len(configs) <= 1:
        return results

    active_files = _get_active_project_files(configs)
    all_basenames = {_basename(filename) for filename in configs}
    acknowledged_duplicate_types = load_acknowledged_duplicate_section_types()

    singleton_sections: dict[str, list[tuple[str, ConfigSection]]] = {}
    for filename, config in configs.items():
        if filename not in active_files:
            continue

        for section in config.sections:
            if section.section_type == "include" or section.is_commented_out:
                continue

            sec_def = get_section_def(section.section_type)
            if _is_suppressed_for_validation(section, sec_def.category if sec_def else None):
                continue
            if sec_def is None or sec_def.max_instances != 1:
                continue

            singleton_sections.setdefault(section.section_type, []).append((filename, section))

    for sec_type, entries in singleton_sections.items():
        files = {filename for filename, _ in entries}
        if len(entries) <= 1 or len(files) <= 1:
            continue

        if sec_type in acknowledged_duplicate_types:
            continue

        for filename, section in entries:
            other_files = sorted(files - {filename})
            message = _project_duplicate_message(sec_type, other_files)

            result = results[filename]
            if any(
                error.severity == "info"
                and error.section == section.full_header
                and error.message == message
                for error in result.errors
            ):
                continue

            result.errors.append(ValidationError(
                severity="info",
                section=section.full_header,
                param="",
                message=message,
                line_number=section.line_number,
                code="project_duplicate",
            ))

    # Cross-file EXACT-header duplicates for multi-instance section types
    # (max_instances=0), e.g. two [gcode_macro FOO] or [tmc2209 stepper_x]
    # across included files. Klipper merges duplicate headers
    # case-insensitively (RawConfigParser(strict=False), later file wins)
    # and never hard-fails, so — like singleton-type duplicates — this is an
    # info finding, not an error or warning. Ack (per section type) still
    # suppresses it, same store as the singleton path above.
    header_sections: dict[str, list[tuple[str, ConfigSection]]] = {}
    for filename, config in configs.items():
        if filename not in active_files:
            continue

        for section in config.sections:
            if section.section_type == "include" or section.is_commented_out:
                continue

            sec_def = get_section_def(section.section_type)
            if _is_suppressed_for_validation(section, sec_def.category if sec_def else None):
                continue
            if sec_def is not None and sec_def.max_instances == 1:
                # Singleton types are already covered by the pass above.
                continue

            header_sections.setdefault(section.full_header.lower(), []).append((filename, section))

    for header_entries in header_sections.values():
        files = {filename for filename, _ in header_entries}
        if len(files) <= 1:
            continue

        sec_type = header_entries[0][1].section_type
        if sec_type in acknowledged_duplicate_types:
            continue

        for filename, section in header_entries:
            other_files = sorted(files - {filename})
            message = _project_duplicate_message(section.full_header, other_files)

            result = results[filename]
            if any(
                error.severity == "info"
                and error.section == section.full_header
                and error.message == message
                for error in result.errors
            ):
                continue

            result.errors.append(ValidationError(
                severity="info",
                section=section.full_header,
                param="",
                message=message,
                line_number=section.line_number,
                code="project_duplicate",
            ))

    _append_special_temperature_sensor_errors(
        results,
        _collect_special_temperature_sensor_uses(configs, active_files=active_files),
        require_multiple_files=True,
    )

    # Check for z_virtual_endstop without a probe section
    virtual_endstop_warnings = _check_virtual_endstop_without_probe(configs, active_files=active_files)
    for filename, warning in virtual_endstop_warnings:
        # Avoid duplicate warnings
        if any(
            error.severity == warning.severity
            and error.section == warning.section
            and error.param == warning.param
            and error.message == warning.message
            for error in results[filename].errors
        ):
            continue
        results[filename].errors.append(warning)

    # Check for cross-file dependency issues (e.g., bed_mesh requiring probe in another file)
    cross_file_warnings = _check_cross_file_dependencies(configs, active_files=active_files)
    for filename, warning in cross_file_warnings:
        # Avoid duplicate warnings
        if any(
            error.severity == warning.severity
            and error.section == warning.section
            and error.message == warning.message
            for error in results[filename].errors
        ):
            continue
        results[filename].errors.append(warning)

    # Remove false single-file "requires probe" warnings when probe exists in another file.
    # The _check_dependencies function only checks within a single file, so if [bed_mesh] is
    # in one file and [probe] is in another, it incorrectly shows "requires [probe]".
    # The cross-file check above already handles this correctly, so we remove the false warnings.
    _remove_false_single_file_probe_warnings(results, cross_file_warnings)

    # Check that the printer's kinematics can find its base stepper sections
    # somewhere in the active project (e.g. corexy needs [stepper_x/y/z]).
    kinematics_warnings = _check_kinematics_stepper_requirements(configs, active_files=active_files)
    for filename, warning in kinematics_warnings:
        results[filename].errors.append(warning)

    # Check that non-glob [include] targets exist in the loaded project
    # (F19). A plain missing include is a Klipper startup hard-fail
    # (configfile.py:187-189 "Include file '%s' does not exist"), so it is
    # an ERROR (severity promotion 2026-08-28). The message carries the
    # resolved path — include resolved relative to the directory of the
    # including file, mirroring configfile.py:183-184 — so the user sees
    # exactly where Klipper would have looked. KWC often loads a PARTIAL
    # import, where the file may exist on disk; the save-gate wording
    # ("will *likely* prevent Klipper from starting") keeps that honest.
    # Globs are never flagged: a glob that matches nothing is legal in
    # Klipper (glob.has_magic) and can never be "resolved" in-memory.
    for filename, config in configs.items():
        if filename not in active_files:
            continue
        for section in config.sections:
            if section.section_type != "include" or section.is_commented_out:
                continue
            spec = section.section_name.strip()
            if not spec or glob.has_magic(spec):
                continue
            if _basename(spec) not in all_basenames:
                include_dir = os.path.dirname(filename.replace("\\", "/"))
                resolved = (
                    f"{include_dir}/{spec}" if include_dir else spec
                )
                message = (
                    f"Include file '{resolved}' was not found in the "
                    "loaded project."
                )
                result = results[filename]
                if any(
                    error.severity == "error"
                    and error.section == section.full_header
                    and error.message == message
                    for error in result.errors
                ):
                    continue
                result.errors.append(ValidationError(
                    severity="error",
                    section=section.full_header,
                    param="",
                    message=message,
                    line_number=section.line_number,
                    code="missing_include",
                ))

    # Cross-file pin conflicts (F8): a pin shared by sections in different
    # project files is the same conflict as within one file — Klipper loads
    # the whole project into a single pin namespace.
    _check_cross_file_pin_conflicts(
        configs,
        results,
        _collect_duplicate_pin_override_pins(configs, active_files),
    )

    # Pin-chip membership (F8): a pin's chip prefix must name a chip the
    # project registers ([mcu NAME], probe, TMC virtual-endstop chips, ...),
    # mirroring klippy/pins.py parse_pin's 'Unknown pin chip name' hard-fail.
    _check_pin_chip_membership(configs, results, active_files)

    return results


def _remove_false_single_file_probe_warnings(
    results: dict[str, ValidationResult],
    cross_file_warnings: list[tuple[str, ValidationError]],
) -> None:
    """Remove false 'requires [probe]' warnings that are resolved by cross-file probe detection.
    
    When [bed_mesh] is in one file and [probe] is in another, the single-file
    _check_dependencies function incorrectly shows "requires [probe] which is not defined."
    The cross-file check above already handles this correctly, so we remove the false warnings.
    """
    for filename, cfg in results.items():
        filtered_errors = []
        for error in cfg.errors:
            # If this is a "requires [probe]" warning for bed_mesh, keep it only if
            # there's also a cross-file warning for the same section (meaning no probe exists)
            if "requires [probe]" in error.message and error.section.startswith("bed_mesh"):
                # Check if there's a cross-file warning for this same section
                has_cross_file_warning = any(
                    w.section == error.section and "not defined" in w.message
                    for _, w in cross_file_warnings
                )
                if not has_cross_file_warning:
                    # Probe exists somewhere — this single-file warning is false
                    continue
            filtered_errors.append(error)
        cfg.errors = filtered_errors


def _check_tmc_stepper_references(
    configs: dict[str, ConfigFile],
    results: dict[str, ValidationResult],
    active_files: set[str],
) -> None:
    """Validate TMC driver header references to their stepper sections (F25).

    A `[tmcXXX <stepper>]` section references the section named `<stepper>`
    (the words after the type). Klipper resolves it at config load
    (tmc.py TMCMicrostepHelper):
      1. the referenced section must exist, else
         "Could not find config section '[<stepper>]' required by tmc driver";
      2. that stepper's microsteps must be a TMC mres value
         (1/2/4/8/16/32/64/128/256) via getchoice — any other int hard-fails.
    Both are config-load hard-fails, so both are errors here. The reference is
    resolved against the ACTIVE project (the stepper may be in an included
    file), mirroring how Klipper loads all includes into one namespace.
    """
    # Map referenced section name (lowercased) -> first active ConfigSection.
    referenced_sections: dict[str, tuple[str, ConfigSection]] = {}
    for filename, config in configs.items():
        if filename not in active_files:
            continue
        for section in config.sections:
            if section.section_type == "include" or section.is_commented_out:
                continue
            key = section.section_type.lower()
            if key not in referenced_sections:
                referenced_sections[key] = (filename, section)

    for filename, config in configs.items():
        if filename not in active_files:
            continue
        for section in config.sections:
            if section.section_type not in TMC_STEPPER_DRIVER_TYPES:
                continue
            if section.is_commented_out:
                continue
            ref_name = section.section_name.strip()
            if not ref_name:
                continue
            ref_key = ref_name.lower()
            result = results[filename]
            if ref_key not in referenced_sections:
                if not any(
                    error.severity == "error"
                    and error.section == section.full_header
                    and error.message == f"Could not find config section '[{ref_name}]' required by tmc driver."
                    for error in result.errors
                ):
                    result.errors.append(ValidationError(
                        severity="error",
                        section=section.full_header,
                        param="",
                        message=f"Could not find config section '[{ref_name}]' required by tmc driver.",
                        line_number=section.line_number,
                    ))
                continue
            # Referenced stepper exists — check its microsteps is a TMC mres.
            ref_filename, ref_section = referenced_sections[ref_key]
            ms_param = ref_section.get_param("microsteps")
            if ms_param is None or not ms_param.value.strip():
                continue
            try:
                ms = int(ms_param.value.strip())
            except ValueError:
                continue  # non-int microsteps are a type error, already reported
            if ms not in TMC_MRES_VALUES:
                message = (
                    f"microsteps {ms} is not a valid TMC value "
                    f"(must be one of {', '.join(str(v) for v in TMC_MRES_VALUES)})."
                )
                if not any(
                    error.severity == "error"
                    and error.section == section.full_header
                    and error.param == "microsteps"
                    and error.message == message
                    for error in result.errors
                ):
                    result.errors.append(ValidationError(
                        severity="error",
                        section=section.full_header,
                        param="microsteps",
                        message=message,
                        line_number=section.line_number,
                    ))


def _check_kinematics_stepper_requirements(
    configs: dict[str, ConfigFile],
    active_files: set[str] | None = None,
) -> list[tuple[str, ValidationError]]:
    """Check that the base stepper sections the printer's kinematics requires exist.

    Each kinematics looks up its rail sections BY EXACT NAME at startup
    (see KINEMATICS_BASE_STEPPERS). A missing base section is a Klipper
    startup hard-fail: configfile.getsection raises at config load
    (corexy.py:12, cartesian.py, delta.py, rotary_delta.py, deltesian.py,
    polar.py, winch.py). ERROR (severity promotion 2026-08-28, plan Task
    4.0) — Klipper deterministically refuses to load this config.

    [printer] and the stepper sections routinely live in different files,
    so this runs only against the full active project set (multi-file
    mode). In single-file mode the kinematics cannot be combined with a
    missing rail in the same file without it being caught by other checks,
    and a lone [printer] file must not be warned about steppers that live
    in files KWC was not asked to validate.
    """
    if active_files is None or len(active_files) <= 1:
        return []

    # Locate the active [printer] section (first one in active files).
    printer_section: ConfigSection | None = None
    printer_file: str | None = None
    for filename in sorted(active_files):
        for section in configs[filename].sections:
            if section.section_type == "printer" and not section.is_commented_out:
                printer_section = section
                printer_file = filename
                break
        if printer_section is not None:
            break
    if printer_section is None or printer_file is None:
        return []

    kinematics = printer_section.get_value("kinematics").strip().lower()
    required = KINEMATICS_BASE_STEPPERS.get(kinematics)
    if not required:
        # No [printer], no kinematics, or an unrecognized value — that is
        # covered by other checks (unknown param / enum); do not guess here.
        return []

    present: set[str] = set()
    for filename in active_files:
        for section in configs[filename].sections:
            if section.is_commented_out:
                continue
            if section.section_type in required:
                present.add(section.section_type)

    results: list[tuple[str, ValidationError]] = []
    for stepper_type in required:
        if stepper_type in present:
            continue
        results.append((printer_file, ValidationError(
            severity="error",
            section="printer",
            param="kinematics",
            message=(
                f"Kinematics '{kinematics}' requires [{stepper_type}], which is not "
                "defined in any active config file. Klipper looks up this section "
                "by exact name and will fail to start without it. (Numbered extra "
                "steppers such as [stepper_z1] do not satisfy the base section.)"
            ),
            line_number=printer_section.line_number,
            code="kinematics_stepper_missing",
        )))

    return results


def _validate_param_value(param, param_def, section, result):
    """Validate a parameter value against its definition."""
    value = param.value.strip()
    if not value:
        # Empty values are invalid for enum params — they must be one of the allowed options
        if param_def.param_type == ParamType.ENUM and param_def.enum_values:
            result.errors.append(ValidationError(
                severity="error",
                section=section.full_header,
                param=param.key,
                message=f"Empty value for '{param.key}'. "
                        f"Expected one of: {', '.join(param_def.enum_values)}",
                line_number=param.line_number,
            ))
        elif param_def.param_type in (ParamType.INT, ParamType.FLOAT, ParamType.BOOL, ParamType.PIN):
            # A present-but-empty typed param is a Klipper startup hard-fail:
            # the option IS present so the code's default is never used —
            # getint('')/getfloat('')/getboolean('') raise, and lookup_pin('')
            # fails in parse_pin with a traceback rather than a config error.
            # STRING and MULTI_LINE params may legitimately be empty.
            result.errors.append(ValidationError(
                severity="error",
                section=section.full_header,
                param=param.key,
                message=f"Empty value for '{param.key}'. This parameter requires a value.",
                line_number=param.line_number,
            ))
        return

    if param_def.param_type == ParamType.INT:
        # Ground truth: getint -> RawConfigParser.getint = int(value).
        # '16'/'-1'/'007' parse; '16.0', 'true', 'hello', formulas all
        # raise (verified empirically 2026-08-25).
        try:
            int(value)
        except ValueError:
            result.errors.append(ValidationError(
                severity="error",
                section=section.full_header,
                param=param.key,
                message=f"Expected integer for '{param.key}', got '{value}'.",
                line_number=param.line_number,
            ))

    elif param_def.param_type == ParamType.FLOAT:
        try:
            float(value)
        except ValueError:
            # Not a plain number. Klipper also tolerates pin references
            # (position_endstop: ^PA0 when the endstop object supplies the
            # position) and formula-shaped values (homing_speed/2) — the old
            # alpha-skip existed to keep those passing. What we DO reject is a
            # lone bare identifier ('hello', 'xyz', 'true'): a pure word that
            # is neither a number, a pin, nor an expression, which can never be
            # a valid Klipper numeric value. This is the F22(a) spec ("allow
            # homing_speed/2 but reject hello").
            # Ground truth (2026-08-25): Klipper has NO formula/symbol support
            # in config parsing, so 'homing_speed/2' would in fact hard-fail —
            # the formula tolerance is kept per the spec to avoid false
            # positives on community configs. See plan F22(a).
            if re.fullmatch(r"[A-Za-z_]+", value.strip()):
                result.errors.append(ValidationError(
                    severity="error",
                    section=section.full_header,
                    param=param.key,
                    message=f"Expected number for '{param.key}', got '{value}'.",
                    line_number=param.line_number,
                ))

    elif param_def.param_type == ParamType.BOOL:
        # Ground truth: Klipper getboolean -> RawConfigParser.getboolean
        # (klippy/configfile.py:73) = Python configparser. Accepts exactly
        # BOOLEAN_STATES = true/false/yes/no/on/off/1/0 (case-insensitive,
        # whitespace-stripped); anything else raises ValueError -> startup
        # hard-fail. 'on'/'off' are valid — do not flag them.
        if value.lower() not in ("true", "false", "yes", "no", "1", "0", "on", "off"):
            result.errors.append(ValidationError(
                severity="error",
                section=section.full_header,
                param=param.key,
                message=f"Expected boolean (true/false/yes/no/on/off/1/0) for '{param.key}', got '{value}'.",
                line_number=param.line_number,
            ))

    elif param_def.param_type == ParamType.ENUM:
        if param_def.enum_values and value not in param_def.enum_values:
            result.errors.append(ValidationError(
                severity="error",
                section=section.full_header,
                param=param.key,
                message=f"Invalid value '{value}' for '{param.key}'. "
                        f"Expected one of: {', '.join(param_def.enum_values)}",
                line_number=param.line_number,
            ))

    elif param_def.param_type == ParamType.PIN:
        if value and not PIN_RE.match(value) and "," not in value:
            result.errors.append(ValidationError(
                severity="warning",
                section=section.full_header,
                param=param.key,
                message=f"Pin format '{value}' may be invalid for '{param.key}'.",
                line_number=param.line_number,
            ))
        # F22: a bare (unprefixed) pin name with no digits is not a pin shape
        # — real pins are PB0/PE11/gpio20/AA1, chip-prefixed virtual pins
        # (tmc2209_stepper_x:virtual_endstop — pin-part letters allowed),
        # <placeholders>, or device paths. 'step_pin: abcd' passes PIN_RE but
        # Klipper would look for a pin literally named 'abcd' and fail at
        # connect/identify. Warning (not error): KWC's ceiling is config-load
        # validation, and exotic board pin names may be legal.
        for raw_pin in value.split(","):
            clean_pin = raw_pin.strip().lstrip("!^~").strip()
            if not clean_pin or clean_pin.startswith("<") or ":" in clean_pin or clean_pin.startswith("/"):
                continue
            if not any(c.isdigit() for c in clean_pin) and clean_pin.isidentifier():
                result.errors.append(ValidationError(
                    severity="warning",
                    section=section.full_header,
                    param=param.key,
                    message=f"Pin '{clean_pin}' does not look like a valid pin (no chip prefix, no number). Klipper only validates pin names at connect time.",
                    line_number=param.line_number,
                ))
                break

    # Range enforcement (F17): only params that actually carry bounds are
    # checked — 0 ParamDefs have them yet, and populating them is Phase 6.
    # A value that float() can't parse is not range-checked (it is already a
    # FLOAT/INT type error from the branch above; F22 removed formula
    # tolerance since Klipper has no formula support).
    if param_def.param_type in (ParamType.INT, ParamType.FLOAT):
        if param_def.min_val is not None or param_def.max_val is not None:
            try:
                numeric = float(value)
            except ValueError:
                numeric = None
            if numeric is not None:
                if param_def.min_val is not None and numeric < param_def.min_val:
                    result.errors.append(ValidationError(
                        severity="error",
                        section=section.full_header,
                        param=param.key,
                        message=f"Value {value} for '{param.key}' is below the minimum of {_format_bound(param_def.min_val)}.",
                        line_number=param.line_number,
                    ))
                elif param_def.max_val is not None and numeric > param_def.max_val:
                    result.errors.append(ValidationError(
                        severity="error",
                        section=section.full_header,
                        param=param.key,
                        message=f"Value {value} for '{param.key}' is above the maximum of {_format_bound(param_def.max_val)}.",
                        line_number=param.line_number,
                    ))


def _format_bound(value: float) -> str:
    # Render integer-valued bounds without a trailing .0 (min_val=1 -> "1").
    return str(int(value)) if float(value).is_integer() else str(value)


def _check_relational_param(param, param_def, section: ConfigSection, result: ValidationResult) -> None:
    """Validate a same-section relational constraint (param A vs param B).

    Ground truth (klippy/configfile.py _get_wrapper, verified 2026-08-25):
        above=X  -> error when v <= X   (strictly above)
        below=X  -> error when v >= X   (strictly below)
    The `rel_between=(low, high)` form (stepper position_endstop within
    [position_min, position_max]) is INCLUSIVE: error when v < low or v > high.

    Skip when the param or its reference is absent/unparseable (a formula or
    pin reference, e.g. position_endstop: ^PA0) — matching the range branch.
    """
    if param_def.rel_above is None and param_def.rel_below is None and param_def.rel_between is None:
        return

    def _num(value: str):
        try:
            return float(value)
        except ValueError:
            return None

    my_num = _num(param.value) if param.value else None
    if my_num is None:
        return  # formula / pin reference / empty — not comparable

    if param_def.rel_above is not None:
        ref = section.get_value(param_def.rel_above)
        ref_num = _num(ref) if ref else None
        if ref_num is not None and my_num <= ref_num:
            result.errors.append(ValidationError(
                severity="error",
                section=section.full_header,
                param=param.key,
                message=f"{param.key} ({param.value}) must be above {param_def.rel_above} ({ref}).",
                line_number=param.line_number,
            ))

    if param_def.rel_below is not None:
        ref = section.get_value(param_def.rel_below)
        ref_num = _num(ref) if ref else None
        if ref_num is not None and my_num >= ref_num:
            result.errors.append(ValidationError(
                severity="error",
                section=section.full_header,
                param=param.key,
                message=f"{param.key} ({param.value}) must be below {param_def.rel_below} ({ref}).",
                line_number=param.line_number,
            ))

    if param_def.rel_between is not None:
        low_name, high_name = param_def.rel_between
        low = section.get_value(low_name)
        high = section.get_value(high_name)
        low_num = _num(low) if low else None
        high_num = _num(high) if high else None
        if low_num is None or high_num is None:
            return  # skip when either bound is missing/unparseable
        if my_num < low_num or my_num > high_num:
            result.errors.append(ValidationError(
                severity="error",
                section=section.full_header,
                param=param.key,
                message=f"{param.key} ({param.value}) must be between {low_name} ({low}) and {high_name} ({high}).",
                line_number=param.line_number,
            ))


def _skip_missing_required_param(section: ConfigSection, param_name: str, active_params: set[str]) -> bool:
    if "*" in param_name:
        return True

    if section.section_type == "bed_mesh" and param_name in {"mesh_min", "mesh_max"}:
        return _is_round_bed_mesh(active_params)

    if section.section_type == "dual_carriage" and "primary_carriage" in active_params:
        return param_name in {"axis", "step_pin", "dir_pin", "microsteps", "rotation_distance"}

    return False


def _validate_printer_requirements(section: ConfigSection, active_params: set[str], result: ValidationResult):
    kinematics = section.get_value("kinematics").strip().lower()
    conditional_requirements = {
        "delta": ["delta_radius"],
        "rotary_delta": ["shoulder_radius", "shoulder_height"],
    }

    for param_name in conditional_requirements.get(kinematics, []):
        if param_name in active_params:
            continue
        result.errors.append(ValidationError(
            severity="error",
            section=section.full_header,
            param=param_name,
            message=f"Required parameter '{param_name}' is missing.",
            line_number=section.line_number,
        ))


def _is_round_bed_mesh(active_params: set[str]) -> bool:
    return any(param in active_params for param in ("mesh_radius", "mesh_origin", "round_probe_count"))


def _validate_bed_mesh_requirements(section: ConfigSection, active_params: set[str], result: ValidationResult):
    required_params = ["mesh_radius"] if _is_round_bed_mesh(active_params) else ["mesh_min", "mesh_max"]

    for param_name in required_params:
        if param_name in active_params:
            continue
        result.errors.append(ValidationError(
            severity="error",
            section=section.full_header,
            param=param_name,
            message=f"Required parameter '{param_name}' is missing.",
            line_number=section.line_number,
        ))


def _validate_lettered_stepper_requirements(
    section: ConfigSection,
    active_params: set[str],
    printer_kinematics: str | None,
    result: ValidationResult,
) -> None:
    match = LETTERED_STEPPER_RE.match(section.section_type)
    if match is None or printer_kinematics is None:
        return

    stepper_letter = match.group(1).lower()
    required_params: list[str] = []

    if printer_kinematics == "delta":
        required_params.append("rotation_distance")
        if stepper_letter == "a":
            required_params.extend(["position_endstop", "arm_length"])
    elif printer_kinematics == "rotary_delta":
        required_params.append("gear_ratio")
        if "rotation_distance" in active_params:
            result.errors.append(ValidationError(
                severity="error",
                section=section.full_header,
                param="rotation_distance",
                message="Parameter 'rotation_distance' is not valid for rotary_delta stepper sections; use 'gear_ratio' instead.",
                line_number=section.line_number,
            ))
        if stepper_letter == "a":
            required_params.extend(["position_endstop", "upper_arm_length", "lower_arm_length"])
    elif printer_kinematics == "winch":
        required_params.extend(["rotation_distance", "anchor_x", "anchor_y", "anchor_z"])
    else:
        return

    for param_name in required_params:
        if param_name in active_params:
            continue
        result.errors.append(ValidationError(
            severity="error",
            section=section.full_header,
            param=param_name,
            message=f"Required parameter '{param_name}' is missing.",
            line_number=section.line_number,
        ))


def _validate_minimum_screw_count(
    section: ConfigSection,
    active_params: set[str],
    result: ValidationResult,
) -> None:
    screw_count = sum(1 for param_name in active_params if SCREW_PARAM_RE.fullmatch(param_name))
    if screw_count >= 3:
        return

    result.errors.append(ValidationError(
        severity="error",
        section=section.full_header,
        param="",
        message=f"{section.section_type}: Must have at least three screws",
        line_number=section.line_number,
    ))


def _check_dependencies(
    config: ConfigFile,
    defined_sections: set[str],
    save_config_section_types: set[str],
    save_config_component_groups: set[str],
    result: ValidationResult,
):
    """Check that required dependencies are present."""
    active_sections: list[ConfigSection] = []
    active_component_groups: set[str] = set()
    for s in config.sections:
        sec_def = get_section_def(s.section_type)
        if sec_def is None:
            active_sections.append(s)
            continue
        if sec_def.category in ("sub_component", "feature"):
            if s.is_commented_out:
                continue
            real_params = [p for p in s.params if p.key != "_comment_"]
            if real_params and all(p.is_commented_out for p in real_params):
                continue
        active_sections.append(s)
        active_component_groups.add(sec_def.component_group)

    section_types = {s.section_type for s in active_sections} | save_config_section_types
    active_component_groups |= save_config_component_groups

    for section in active_sections:
        sec_def = get_section_def(section.section_type)
        if sec_def and sec_def.requires:
            for req in sec_def.requires:
                if not _dependency_is_satisfied(req, section_types, active_component_groups):
                    result.errors.append(ValidationError(
                        severity="warning",
                        section=section.full_header,
                        param="",
                        message=f"Section [{section.full_header}] requires [{req}] which is not defined.",
                        line_number=section.line_number,
                    ))


def _dependency_is_satisfied(req: str, section_types: set[str], component_groups: set[str]) -> bool:
    if req in section_types:
        return True

    return bool(REQUIREMENT_COMPONENT_GROUPS.get(req, set()) & component_groups)


def _find_param_def(sec_def, key: str):
    """Match a config param key against a section's param defs.

    Case-insensitive on both sides, with `prefix*suffix` wildcard names.
    Returns the first matching ParamDef or None.
    """
    if sec_def is None:
        return None
    param_key_lower = key.lower()
    for pd in sec_def.params:
        wildcard_match = False
        if "*" in pd.name:
            wildcard_prefix, wildcard_suffix = pd.name.lower().split("*", 1)
            wildcard_match = (
                param_key_lower.startswith(wildcard_prefix)
                and param_key_lower.endswith(wildcard_suffix)
            )
        if pd.name == key or pd.name.lower() == param_key_lower or wildcard_match:
            return pd
    return None


def _track_pin_usage(param, section, used_pins: dict, filename: str = "") -> None:
    """Record every normalized pin value of a PIN param into used_pins."""
    for clean_pin in _normalize_pin_values(param.value):
        if clean_pin not in used_pins:
            used_pins[clean_pin] = []
        used_pins[clean_pin].append(PinUse(
            pin=clean_pin,
            section=section.full_header,
            section_type=section.section_type,
            param=param.key,
            line_number=param.line_number,
            filename=filename,
        ))


def _check_pin_conflicts(
    used_pins: dict[str, list[PinUse]],
    result: ValidationResult,
    duplicate_pin_override_pins: frozenset[str] = frozenset(),
) -> None:
    """Check for pins used by multiple sections.

    Severity: error. Klipper hard-fails a pin claimed twice
    (klippy/pins.py: "pin %s used multiple times in config") unless the pin
    is in allow_multi_use_pins ([duplicate_pin_override]) or the sharing goes
    through a shared share_type — and _is_allowed_shared_pin models exactly
    those share_type families, so every conflict that survives the exemptions
    is a startup failure (ground-truthed on the Trident, plan 3.5/Q2).
    """
    for pin, users in used_pins.items():
        if len(users) <= 1 or _is_allowed_shared_pin(users):
            continue
        if pin in duplicate_pin_override_pins:
            continue  # [duplicate_pin_override] registered it — legal multi-use

        # Anchor the finding to the first user so it renders in the gutter
        # (line) and on the section node dot. The message still lists all users.
        anchor = next((u for u in users if u.section), users[0])
        result.errors.append(ValidationError(
            severity="error",
            section=anchor.section,
            param=anchor.param,
            message=_shared_pin_message(pin, users),
            line_number=anchor.line_number,
            code="shared_pin",
        ))


def _shared_pin_message(pin: str, users: list[PinUse]) -> str:
    return (
        f"Pin '{pin}' is used by multiple sections: "
        f"{', '.join(user.label for user in users)} — Klipper will fail to"
        " start (pin used multiple times in config)."
    )


def _check_cross_file_pin_conflicts(
    configs: dict[str, ConfigFile],
    results: dict[str, ValidationResult],
    duplicate_pin_override_pins: frozenset[str] = frozenset(),
) -> None:
    """Detect pins shared between sections in DIFFERENT project files.

    Klipper loads the whole project into one config namespace and pins.py
    tracks active pins across it, so a pin used by two sections in two files
    is the same conflict as within one file. Per-file _check_pin_conflicts
    cannot see across files; this pass aggregates PIN usage over active
    files. Exemptions (_is_allowed_shared_pin) and dedup against already
    reported in-file conflicts are reused, so each conflict is reported once.
    """
    used_pins: dict[str, list[PinUse]] = {}
    active_files = _get_active_project_files(configs)
    for filename in sorted(active_files):
        config = configs[filename]
        for section in config.sections:
            if section.is_commented_out or section.section_type == "include":
                continue
            sec_def = get_section_def(section.section_type)
            for param in section.params:
                if param.is_commented_out or param.key == "_comment_":
                    continue
                param_def = _find_param_def(sec_def, param.key)
                if param_def is not None and param_def.param_type == ParamType.PIN and param.value:
                    _track_pin_usage(param, section, used_pins, filename=filename)

    # Pins already reported by a per-file check (both users in the same file)
    # are deduped by (pin, sorted user labels).
    reported = set()
    for result in results.values():
        for err in result.errors:
            if err.code != "shared_pin":
                continue
            reported.add((err.section, err.param, err.line_number))

    for pin, users in used_pins.items():
        if len(users) <= 1 or _is_allowed_shared_pin(users):
            continue
        if pin in duplicate_pin_override_pins:
            continue  # [duplicate_pin_override] registered it — legal multi-use
        files_involved = {u.filename for u in users}
        if len(files_involved) < 2:
            continue  # same-file conflict already reported per-file
        anchor = next((u for u in users if u.section), users[0])
        already = any(
            (u.section, u.param, u.line_number) in reported
            for u in users
        )
        if already:
            continue
        result = results.get(anchor.filename)
        if result is None:
            continue
        result.errors.append(ValidationError(
            severity="error",
            section=anchor.section,
            param=anchor.param,
            message=_shared_pin_message(pin, users),
            line_number=anchor.line_number,
            code="shared_pin",
        ))


def _collect_duplicate_pin_override_pins(
    configs: dict[str, ConfigFile],
    active_files: set[str],
) -> frozenset[str]:
    """Collect pins registered by [duplicate_pin_override] in active files.

    Ground truth (klippy/extras/duplicate_pin_override.py): the module adds
    every pin from its `pins:` getlist to PrinterPins.allow_multi_use_pins,
    where those pins may be claimed by multiple sections without the
    "pin used multiple times in config" hard-fail (pins.py:103). KWC must
    exempt the same pins so a legal override setup does not false-positive.
    """
    pins: set[str] = set()
    for filename in sorted(active_files):
        config = configs.get(filename)
        if config is None:
            continue
        for section in config.sections:
            if (
                section.is_commented_out
                or section.section_type != "duplicate_pin_override"
            ):
                continue
            for param in section.params:
                if param.is_commented_out or param.key != "pins" or not param.value:
                    continue
                pins.update(_normalize_pin_values(param.value))
    return frozenset(pins)


def _collect_known_pin_chips(configs: dict[str, ConfigFile], active_files: set[str]) -> set[str]:
    """Collect the pin-chip names Klipper would register for this project.

    Ground truth (klippy/pins.py PrinterPins.register_chip call sites,
    verified 2026-08-25). A pin with an explicit chip prefix must name one of
    these, else `parse_pin` hard-fails `Unknown pin chip name '%s'`:
      - 'mcu' is always registered (mcu.add_printer_objects)
      - [mcu NAME]      -> NAME   (CAN chips too: [mcu EBBCan]+canbus_uuid;
                                   there is NO [canbus] section)
      - [probe]         -> 'probe'
      - [multi_pin]     -> 'multi_pin'
      - [replicape]     -> 'replicape'
      - [tmc2130|tmc2209|tmc5160|tmc2240 NAME] -> '<type>_<name>'
                                   (TMCVirtualPinHelper, sensorless
                                   'virtual_endstop' pins)
      - [adc_scaled NAME] / [ads1x1x NAME] -> NAME
      - [sx1509 NAME]   -> 'sx1509_<name>'
    Case-folded: Klipper section names are case-sensitive, so a config that
    writes [mcu ebbcan] + pin ebbcan:PB0 works — accept either case.
    """
    chips = {"mcu"}
    for filename in sorted(active_files):
        config = configs[filename]
        for section in config.sections:
            if section.is_commented_out:
                continue
            sec_type = section.section_type
            name = section.section_name.strip()
            if sec_type == "mcu":
                chips.add((name or "mcu").lower())
            elif sec_type in ("probe", "multi_pin", "replicape"):
                chips.add(sec_type.lower())
            elif sec_type in ("tmc2130", "tmc2209", "tmc5160", "tmc2240") and name:
                name_parts = name.split()
                chips.add(f"{sec_type}_{name_parts[-1]}".lower())
            elif sec_type in ("adc_scaled", "ads1x1x") and name:
                chips.add(name.split()[-1].lower())
            elif sec_type == "sx1509" and name:
                chips.add(f"sx1509_{name.split()[0]}".lower())
    return chips


def _check_pin_chip_membership(configs: dict[str, ConfigFile], results: dict[str, ValidationResult], active_files: set[str]) -> None:
    """Flag pins whose chip prefix names a chip Klipper never registers.

    Mirrors klippy/pins.py parse_pin: split on the first ':', default chip
    'mcu' when absent. Unprefixed pins always resolve (the builtin 'mcu' chip
    is always present), so only explicit prefixes are checked. `<...>`
    placeholders are skipped (not parseable pins). Project-pass only: in
    single-file validation the defining section may live in another file.
    """
    known_chips = _collect_known_pin_chips(configs, active_files)
    for filename in sorted(active_files):
        config = configs[filename]
        result = results.get(filename)
        if result is None:
            continue
        for section in config.sections:
            if section.is_commented_out or section.section_type == "include":
                continue
            sec_def = get_section_def(section.section_type)
            for param in section.params:
                if param.is_commented_out or param.key == "_comment_":
                    continue
                param_def = _find_param_def(sec_def, param.key)
                if param_def is None or param_def.param_type != ParamType.PIN or not param.value:
                    continue
                for clean_pin in _normalize_pin_values(param.value):
                    if ":" not in clean_pin or clean_pin.startswith("<"):
                        continue
                    chip_name = clean_pin.split(":", 1)[0].strip()
                    if chip_name.lower() not in known_chips:
                        result.errors.append(ValidationError(
                            severity="error",
                            section=section.full_header,
                            param=param.key,
                            message=f"Unknown pin chip name '{chip_name}'. No [mcu {chip_name}] (or driver section) defines this chip in the project.",
                            line_number=param.line_number,
                        ))


def _is_allowed_shared_pin(users: list[PinUse]) -> bool:
    return (
        _is_allowed_shared_tmc_uart_pin(users)
        or _is_allowed_shared_enable_pin(users)
        or _is_allowed_shared_communication_pin(users)
        or _is_allowed_shared_display_button_pin(users)
    )


def _is_allowed_shared_tmc_uart_pin(users: list[PinUse]) -> bool:
    if not users:
        return False

    shared_params = {"uart_pin", "tx_pin"}
    shared_driver_types = {"tmc2208", "tmc2209"}
    return all(user.section_type in shared_driver_types and user.param in shared_params for user in users)


def _is_allowed_shared_enable_pin(users: list[PinUse]) -> bool:
    if not users:
        return False

    return all(
        user.param == "enable_pin"
        and (
            user.section_type.startswith("stepper_")
            or user.section_type.startswith("extruder")
            or user.section_type == "manual_stepper"
        )
        for user in users
    )


def _is_allowed_shared_communication_pin(users: list[PinUse]) -> bool:
    if not users:
        return False

    shared_param = users[0].param
    shared_params = {
        "spi_software_sclk_pin",
        "spi_software_mosi_pin",
        "spi_software_miso_pin",
        "i2c_software_scl_pin",
        "i2c_software_sda_pin",
    }
    return shared_param in shared_params and all(user.param == shared_param for user in users)


def _is_allowed_shared_display_button_pin(users: list[PinUse]) -> bool:
    if not users:
        return False

    shared_params = {"up_pin", "down_pin", "click_pin", "back_pin", "kill_pin"}
    section = users[0].section
    return all(user.section_type == "display" and user.section == section and user.param in shared_params for user in users)


def _is_probe_section(section: ConfigSection) -> bool:
    """Check if a section is a probe-related section.

    Includes:
    - [probe] (top-level)
    - [bltouch] (top-level)
    - Schema probe components (for example smart_effector)
    - Probe plugins such as [beacon] and scanner-style sections
    - Named sections whose type starts with 'probe' or ends with '_probe'
    """
    return _is_probe_like_section_type(section.section_type)


def _is_probe_like_section_type(section_type: str) -> bool:
    lowered = section_type.strip().lower()
    if not lowered:
        return False

    sec_def = get_section_def(lowered)
    if sec_def and sec_def.component_group == "probe":
        return True

    return (
        lowered in PROBE_PLUGIN_SECTION_TYPES
        or lowered.startswith("probe")
        or lowered.endswith("_probe")
        or "scanner" in lowered
    )


def _extract_virtual_endstop_value(raw_value: str) -> str | None:
    """Extract the base pin value from a Klipper pin expression.

    Handles:
    - Pin modifiers: ! (invert), ^ (pull-up), ~ (PWM)
    - MCU prefix: mcu:pin
    - z_virtual_endstop and manually_set_z_virtual_endstop
    """
    value = raw_value.strip()
    # Strip pin modifiers
    value = value.lstrip("!^~")
    # Strip MCU prefix if present (e.g., "mcu:z_virtual_endstop")
    if ":" in value:
        value = value.split(":", 1)[1].strip()
        value = value.lstrip("!^~")
    # Strip macro references (e.g., "<z_virtual_endstop>")
    value = value.strip().strip("<>").strip()
    return value.lower() if value else None


def _check_virtual_endstop_without_probe(
    configs: dict[str, ConfigFile],
    active_files: set[str] | None = None,
) -> list[tuple[str, ValidationError]]:
    """Check for probe virtual endstops that fail at Klipper config load.

    Two cases, both load failures (severity promotion 2026-08-28, plan
    Task 4.0):

    1. endstop_pin uses 'z_virtual_endstop' but no probe section is
       defined in the active project. The 'probe:' pin chip is registered
       ONLY when a probe section loads (klippy/extras/probe.py:215);
       without one, klippy/pins.py:81 raises "Unknown pin chip name
       'probe'" during config load.
    2. endstop_pin uses any other probe virtual value (currently
       'manually_set_z_virtual_endstop' — not in current Klipper;
       repo-wide search 2026-08-28: 0 hits). HomingViaProbeHelper.setup_pin
       (probe.py:238-240) raises pins.error("Probe virtual endstop only
       useful as endstop pin") at load for any value other than exactly
       'z_virtual_endstop' — even when a probe section is present.

    Only probe sections in active (included) files are considered, because
    probes in non-included files won't actually be loaded by Klipper.

    Returns a list of (filename, ValidationError) tuples so the caller can
    attach the finding to the correct file's results.
    """
    results: list[tuple[str, ValidationError]] = []

    # Collect all probe section headers across active files only.
    # Note: save_config_sections (lines prefixed with #*#) are Klipper's
    # auto-generated saved configuration output — they should NOT count as
    # real probe definitions since they're just the saved output, not actual
    # probe hardware.
    probe_sections: set[str] = set()
    if active_files:
        for filename, cfg in configs.items():
            if filename not in active_files:
                continue
            for section in cfg.sections:
                if section.is_commented_out:
                    continue
                if _is_probe_section(section):
                    probe_sections.add(section.full_header)
    else:
        # No active_files specified — check all files (single-file mode)
        for filename, cfg in configs.items():
            for section in cfg.sections:
                if section.is_commented_out:
                    continue
                if _is_probe_section(section):
                    probe_sections.add(section.full_header)

    if probe_sections:
        # Probe present — case 1 can't fire. But case 2 still must: any
        # 'probe:' virtual value other than exactly 'z_virtual_endstop'
        # fails at load in HomingViaProbeHelper.setup_pin (probe.py:238-240)
        # even with a probe section defined.
        for filename, cfg in configs.items():
            if active_files is not None and filename not in active_files:
                continue
            for section in cfg.sections:
                if section.is_commented_out:
                    continue
                for param in section.params:
                    if param.is_commented_out or param.key != "endstop_pin":
                        continue
                    raw_value = param.value.strip()
                    if ":" not in raw_value:
                        continue
                    # Only 'probe:'-chip values are virtual endstops; an
                    # MCU-prefixed pin (e.g. 'EBBCan:PB0') is unrelated.
                    chip = raw_value.split(":", 1)[0].strip().lstrip("!^~")
                    if chip != "probe":
                        continue
                    base_value = _extract_virtual_endstop_value(raw_value)
                    if base_value != "z_virtual_endstop":
                        results.append((filename, ValidationError(
                            severity="error",
                            section=section.full_header,
                            param="endstop_pin",
                            message=(
                                f"Section [{section.section_type}] uses "
                                f"'probe:{base_value}' as the endstop_pin, "
                                "but only 'z_virtual_endstop' is accepted — "
                                "any other probe virtual value fails at"
                                " config load even when a probe section is"
                                " defined (probe.py:238-240)."
                            ),
                            line_number=param.line_number,
                            code="z_virtual_endstop_without_probe",
                        )))
        return results

    # No probe found — the 'probe:' pin chip never registers, so ANY
    # 'probe:' virtual endstop value fails at load (pins.py:81 unknown chip).
    for filename, cfg in configs.items():
        if active_files is not None and filename not in active_files:
            continue
        for section in cfg.sections:
            if section.is_commented_out:
                continue
            for param in section.params:
                if param.is_commented_out or param.key != "endstop_pin":
                    continue
                raw_value = param.value.strip()
                if ":" not in raw_value:
                    continue
                chip = raw_value.split(":", 1)[0].strip().lstrip("!^~")
                if chip != "probe":
                    continue
                base_value = _extract_virtual_endstop_value(raw_value)
                if base_value in ("z_virtual_endstop", "manually_set_z_virtual_endstop"):
                    message = (
                        f"Section [{section.section_type}] uses "
                        f"'{base_value}' as the endstop_pin, but no probe"
                        " section (BLTouch, probe, scanner, etc.) is"
                        " defined. Without one the 'probe:' pin chip never"
                        " registers and Klipper fails at config load"
                        " (pins.py:81)."
                    )
                    if base_value != "z_virtual_endstop":
                        message += (
                            f" Additionally '{base_value}' does not exist in"
                            " current Klipper — only 'z_virtual_endstop' is"
                            " accepted (probe.py:238-240)."
                        )
                    results.append((filename, ValidationError(
                        severity="error",
                        section=section.full_header,
                        param="endstop_pin",
                        message=message,
                        line_number=param.line_number,
                        code="z_virtual_endstop_without_probe",
                    )))

    return results


def _get_probe_section_types() -> set[str]:
    """Get all section types that are considered probe sections.
    
    Includes:
    - [probe] (top-level)
    - [bltouch] (top-level)
    - Named sections whose type starts with 'probe' (e.g., probe_eddy_current, probe_rr, probe_4in1)
    """
    types = set(PROBE_PLUGIN_SECTION_TYPES)
    for sec_def in SECTION_DEFS.values():
        if _is_probe_like_section_type(sec_def.section_type):
            types.add(sec_def.section_type)
    return types


def _check_cross_file_dependencies(
    configs: dict[str, ConfigFile],
    active_files: set[str] | None = None,
) -> list[tuple[str, ValidationError]]:
    """Check for sections that require dependencies (like bed_mesh requiring probe)
    across all config files in the project.
    
    This resolves the issue where [bed_mesh] in one file and [probe] in another
    would incorrectly show "requires [probe] which is not defined."
    
    Only probe sections in active (included) files are considered, because
    probes in non-included files won't actually be loaded by Klipper.
    
    Note: save_config_sections (lines prefixed with #*#) are Klipper's
    auto-generated saved configuration output — they should NOT count as
    real probe definitions since they're just the saved output, not actual
    probe hardware.
    
    Returns a list of (filename, ValidationError) tuples for files that have
    missing dependencies.
    """
    results: list[tuple[str, ValidationError]] = []
    
    # Get all probe-related section types
    probe_types = _get_probe_section_types()
    
    # Collect all probe section headers across active files only.
    # save_config_sections are intentionally excluded (they're auto-generated).
    probe_sections: set[str] = set()
    if active_files:
        for filename, cfg in configs.items():
            if filename not in active_files:
                continue
            for section in cfg.sections:
                if section.is_commented_out:
                    continue
                if section.section_type in probe_types or _is_probe_section(section):
                    probe_sections.add(section.full_header)
    else:
        # No active_files specified — check all files (single-file mode)
        for filename, cfg in configs.items():
            for section in cfg.sections:
                if section.is_commented_out:
                    continue
                if section.section_type in probe_types or _is_probe_section(section):
                    probe_sections.add(section.full_header)
    
    # Check each file for sections that require probe
    for filename, cfg in configs.items():
        if active_files is not None and filename not in active_files:
            continue
        for section in cfg.sections:
            if section.is_commented_out:
                continue
            sec_def = get_section_def(section.section_type)
            if sec_def is None:
                continue
            # Check if this section requires probe
            if "probe" not in sec_def.requires:
                continue
            # Check if probe exists in any active file
            if probe_sections:
                continue
            # No probe found — this is a genuine missing dependency
            results.append((filename, ValidationError(
                severity="warning",
                section=section.full_header,
                param="",
                message=(
                    f"Section [{section.section_type}] requires [probe] which is not defined "
                    "in any configuration file. A probe section (BLTouch, probe, "
                    "probe_eddy_current, etc.) is needed for bed_mesh to work correctly."
                ),
                line_number=section.line_number,
            )))
    
    return results


def _check_sensorless_homing_warning(
    section: ConfigSection,
    result: ValidationResult,
    config: ConfigFile | None = None,
) -> None:
    """Warn when sensorless homing is detected with a non-zero homing_retract_dist.

    Sensorless homing is identified by the presence of:
    - driver_SGTHRS (TMC2209 StallGuard threshold)
    - driver_SGT (TMC2130/TMC5160 StallGuard threshold)
    - diag_pin / diag0_pin / diag1_pin (diagnostic pin for stall detection)

    These parameters are looked up in the corresponding TMC driver section
    (e.g., [tmc2209 stepper_x]), not the stepper section itself.

    When sensorless homing is used, homing_retract_dist must be 0 (or omitted)
    because the homing move must continue through the endstop without retracting.
    """
    has_sgthrs = False
    has_diag = False

    # Check the corresponding TMC driver section(s)
    # In Klipper, TMC drivers are configured in sections like [tmc2209 stepper_x]
    sec_type = section.section_type

    # Only process stepper and extruder sections
    if sec_type.startswith("stepper_") or sec_type.startswith("extruder"):
        # Look for TMC driver sections that configure this stepper
        # Common TMC driver types: tmc2130, tmc2208, tmc2209, tmc2660, tmc2240, tmc5160, tmc5200
        tmc_driver_types = {"tmc2130", "tmc2208", "tmc2209", "tmc2660", "tmc2240", "tmc5160", "tmc5200"}
        if config is not None:
            for tmc_type in tmc_driver_types:
                tmc_section_header = f"{tmc_type} {sec_type}"
                tmc_section = config.get_section(tmc_section_header)
                if tmc_section is not None:
                    # Check for sensorless homing indicators in the TMC section
                    tmc_active_params = {
                        p.key.lower()
                        for p in tmc_section.params
                        if not p.is_commented_out and p.key != "_comment_"
                    }
                    if "driver_sgthrs" in tmc_active_params or "driver_sgt" in tmc_active_params:
                        has_sgthrs = True
                    if any(p in tmc_active_params for p in ("diag_pin", "diag0_pin", "diag1_pin")):
                        has_diag = True
                    if has_sgthrs and has_diag:
                        break  # Found both, no need to check more TMC sections

    if not (has_sgthrs or has_diag):
        return

    endstop_pin_value = section.get_value("endstop_pin", "").strip()
    if _extract_virtual_endstop_value(endstop_pin_value) != "virtual_endstop":
        return

    # Check homing_retract_dist value
    # Klipper defaults homing_retract_dist to 5.0 if not specified,
    # which breaks sensorless homing (the homing move pulls away from
    # the endstop before it is triggered).
    homing_retract_dist_val = section.get_value("homing_retract_dist", "").strip()

    should_warn = False
    warning_param = "homing_retract_dist"
    warning_message: str | None = None

    if not homing_retract_dist_val:
        # Parameter not defined - Klipper will default to 5.0
        should_warn = True
        warning_param = ""  # Warn at section level, not param level
        warning_message = (
            "Sensorless homing detected (via driver_SGTHRS or diag_pin in the TMC driver section). "
            "homing_retract_dist is not defined and will default to 5mm in Klipper, "
            "which will break sensorless homing. Set homing_retract_dist to 0 "
            "so the homing move continues through the endstop without retracting."
        )
    elif homing_retract_dist_val != "0":
        # Parameter explicitly set to non-zero value
        try:
            retract_val = float(homing_retract_dist_val)
            if retract_val != 0:
                should_warn = True
                warning_message = (
                    "Sensorless homing detected (via driver_SGTHRS or diag_pin in the TMC driver section). "
                    "homing_retract_dist is set to {} which will break sensorless homing. "
                    "Set homing_retract_dist to 0 so the homing move continues through "
                    "the endstop without retracting.".format(homing_retract_dist_val)
                )
        except ValueError:
            # If it's a formula or reference, skip numeric check
            pass

    if should_warn and warning_message:
        result.errors.append(ValidationError(
            severity="warning",
            section=section.full_header,
            param=warning_param,
            message=warning_message,
            line_number=section.line_number,
        ))
