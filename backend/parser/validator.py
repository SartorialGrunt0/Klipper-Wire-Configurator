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


PIN_RE = re.compile(r"^[!^~]*(?:[\w]+:)?(?:P[A-Z]\d+|ar\d+|gpio\d+|[A-Z_]+\d*|<\w+>)$", re.IGNORECASE)


def validate_config(config: ConfigFile) -> ValidationResult:
    """Validate a full configuration file."""
    result = ValidationResult()

    section_counts: dict[str, int] = {}
    used_pins: dict[str, list[str]] = {}  # pin -> list of sections using it
    defined_sections: set[str] = set()

    for section in config.sections:
        if section.section_type == "include":
            continue

        defined_sections.add(section.full_header)
        sec_type = section.section_type

        # Track section counts
        section_counts[sec_type] = section_counts.get(sec_type, 0) + 1

        # Get schema definition
        sec_def = get_section_def(sec_type)

        if sec_def is None:
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
        active_params = {p.key for p in section.params if not p.is_commented_out}
        for param_def in sec_def.params:
            if param_def.required and param_def.name not in active_params:
                # Skip wildcard params
                if "*" in param_def.name:
                    continue
                result.errors.append(ValidationError(
                    severity="error",
                    section=section.full_header,
                    param=param_def.name,
                    message=f"Required parameter '{param_def.name}' is missing.",
                    line_number=section.line_number,
                ))

        # Validate individual parameters
        for param in section.params:
            if param.is_commented_out:
                continue

            # Find param definition
            param_def = None
            for pd in sec_def.params:
                if pd.name == param.key or ("*" in pd.name and param.key.startswith(pd.name.replace("*", ""))):
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
                clean_pin = param.value.lstrip("!^~").strip()
                if clean_pin and not clean_pin.startswith("<"):
                    if clean_pin not in used_pins:
                        used_pins[clean_pin] = []
                    used_pins[clean_pin].append(f"[{section.full_header}] {param.key}")

    # Check for required sections
    _check_dependencies(config, defined_sections, result)

    # Check for pin conflicts
    _check_pin_conflicts(used_pins, result)

    # Check printer section exists
    if "printer" not in {s.section_type for s in config.sections if s.section_type != "include"}:
        result.errors.append(ValidationError(
            severity="error",
            section="",
            param="",
            message="Missing required [printer] section.",
        ))

    # Check MCU section exists
    has_mcu = any(s.section_type == "mcu" and not s.section_name for s in config.sections)
    if not has_mcu:
        result.errors.append(ValidationError(
            severity="error",
            section="",
            param="",
            message="Missing required [mcu] section.",
        ))

    return result


def _validate_param_value(param, param_def, section, result):
    """Validate a parameter value against its definition."""
    value = param.value.strip()
    if not value:
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


def _check_dependencies(config: ConfigFile, defined_sections: set[str], result: ValidationResult):
    """Check that required dependencies are present."""
    section_types = {s.section_type for s in config.sections}

    for section in config.sections:
        sec_def = get_section_def(section.section_type)
        if sec_def and sec_def.requires:
            for req in sec_def.requires:
                if req not in section_types:
                    result.errors.append(ValidationError(
                        severity="warning",
                        section=section.full_header,
                        param="",
                        message=f"Section [{section.full_header}] requires [{req}] which is not defined.",
                        line_number=section.line_number,
                    ))


def _check_pin_conflicts(used_pins: dict[str, list[str]], result: ValidationResult):
    """Check for pins used by multiple sections."""
    for pin, users in used_pins.items():
        if len(users) > 1:
            result.errors.append(ValidationError(
                severity="warning",
                section="",
                param="",
                message=f"Pin '{pin}' is used by multiple sections: {', '.join(users)}",
            ))
