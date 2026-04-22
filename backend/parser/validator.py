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

import re
from dataclasses import dataclass, field
from typing import Optional

from parser.config_parser import ConfigFile, ConfigSection
from parser.config_schema import (
    SECTION_DEFS,
    ParamType,
    get_section_def,
)
from services.warning_acknowledgments import (
    canonicalize_section,
    load_acknowledged_warning_sections,
)


@dataclass
class ValidationError:
    severity: str  # "error", "warning", "info"
    section: str  # Section header where error occurs
    param: str  # Parameter name (empty if section-level)
    message: str
    line_number: int = 0

    def to_dict(self) -> dict:
        return {
            "severity": self.severity,
            "section": self.section,
            "param": self.param,
            "message": self.message,
            "line_number": self.line_number,
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

    @property
    def label(self) -> str:
        return f"[{self.section}] {self.param}"


PIN_RE = re.compile(
    r"^[!^~]*(?:[A-Za-z0-9_][A-Za-z0-9_-]*:\s*)?(?:<[^>]+>|[A-Za-z0-9_]+(?:[./][A-Za-z0-9_]+)*)$",
    re.IGNORECASE,
)


REQUIREMENT_COMPONENT_GROUPS: dict[str, set[str]] = {
    "probe": {"probe"},
    "adxl345": {"accelerometer"},
}


def validate_config(config: ConfigFile, *, is_multi_file: bool = False) -> ValidationResult:
    """Validate a full configuration file."""
    result = ValidationResult()
    acknowledged_sections = load_acknowledged_warning_sections()

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
        save_config_section_types.add(save_section.section_type)
        sec_def = get_section_def(save_section.section_type)
        if sec_def:
            save_config_component_groups.add(sec_def.component_group)

    def _is_suppressed_for_validation(section: ConfigSection, category: str | None) -> bool:
        # Suppressed sub-components/features should not participate in validation.
        if category not in ("sub_component", "feature"):
            return False
        if section.is_commented_out:
            return True
        real_params = [p for p in section.params if p.key != "_comment_"]
        return bool(real_params) and all(p.is_commented_out for p in real_params)

    for section in config.sections:
        if section.section_type == "include":
            continue
        sec_type = section.section_type

        # Get schema definition
        sec_def = get_section_def(sec_type)

        if _is_suppressed_for_validation(section, sec_def.category if sec_def else None):
            continue

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
            ))
            continue

        # Check max instances
        if sec_def.max_instances == 1 and section_counts[sec_type] > 1:
            result.errors.append(ValidationError(
                severity="error",
                section=section.full_header,
                param="",
                message=f"Section [{sec_type}] can only be defined once.",
                line_number=section.line_number,
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

        # MCU-specific: validate communication method (serial XOR canbus_uuid)
        if sec_type == "mcu":
            has_serial = "serial" in active_params
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

        # Validate individual parameters
        for param in section.params:
            if param.is_commented_out or param.key == "_comment_":
                continue

            # Find param definition (case-insensitive match)
            param_def = None
            param_key_lower = param.key.lower()
            for pd in sec_def.params:
                if pd.name == param.key or pd.name.lower() == param_key_lower or ("*" in pd.name and param.key.startswith(pd.name.replace("*", ""))):
                    param_def = pd
                    break

            if param_def is None:
                result.errors.append(ValidationError(
                    severity="warning",
                    section=section.full_header,
                    param=param.key,
                    message=f"Unknown parameter '{param.key}' for section [{sec_type}].",
                    line_number=param.line_number,
                ))
                continue

            # Type validation
            _validate_param_value(param, param_def, section, result)

            # Track pin usage
            if param_def.param_type == ParamType.PIN and param.value:
                clean_pin = re.sub(r"\s*:\s*", ":", param.value.lstrip("!^~").strip())
                if clean_pin and not clean_pin.startswith("<"):
                    if clean_pin not in used_pins:
                        used_pins[clean_pin] = []
                    used_pins[clean_pin].append(PinUse(
                        pin=clean_pin,
                        section=section.full_header,
                        section_type=section.section_type,
                        param=param.key,
                    ))

    # Check for required sections
    _check_dependencies(
        config,
        defined_sections,
        save_config_section_types,
        save_config_component_groups,
        result,
    )

    # Check for pin conflicts
    _check_pin_conflicts(used_pins, result)

    return result


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
        return

    if param_def.param_type == ParamType.INT:
        try:
            int(value)
        except ValueError:
            # Could be a boolean string
            if value.lower() not in ("true", "false"):
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
            # Allow formulas like "homing_speed/2"
            if not any(c.isalpha() for c in value):
                result.errors.append(ValidationError(
                    severity="error",
                    section=section.full_header,
                    param=param.key,
                    message=f"Expected number for '{param.key}', got '{value}'.",
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


def _skip_missing_required_param(section: ConfigSection, param_name: str, active_params: set[str]) -> bool:
    if "*" in param_name:
        return True

    if section.section_type == "bed_mesh" and param_name in {"mesh_min", "mesh_max"}:
        return _is_round_bed_mesh(active_params)

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


def _check_pin_conflicts(used_pins: dict[str, list[PinUse]], result: ValidationResult):
    """Check for pins used by multiple sections."""
    for pin, users in used_pins.items():
        if len(users) <= 1 or _is_allowed_shared_pin(users):
            continue

        result.errors.append(ValidationError(
            severity="warning",
            section="",
            param="",
            message=f"Pin '{pin}' is used by multiple sections: {', '.join(user.label for user in users)}",
        ))


def _is_allowed_shared_pin(users: list[PinUse]) -> bool:
    return _is_allowed_shared_tmc_uart_pin(users) or _is_allowed_shared_enable_pin(users)


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
