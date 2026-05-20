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


@dataclass(frozen=True)
class SpecialTemperatureSensorUse:
    filename: str
    section: ConfigSection
    sensor_type: str
    sensor_target: str


def _basename(filename: str) -> str:
    return filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]


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


def _project_duplicate_severity(sec_type: str, category: str | None) -> str:
    if sec_type != "printer" and category in ("sub_component", "feature"):
        return "warning"
    return "error"


def _project_duplicate_message(sec_type: str, severity: str, other_files: list[str]) -> str:
    if severity == "warning":
        message = f"Section [{sec_type}] is reused across active included config files."
    else:
        message = f"Section [{sec_type}] can only be defined once across active included config files."

    if other_files:
        message += f" Also defined in: {', '.join(other_files)}."
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

    for section in config.sections:
        if section.section_type == "include" or section.is_commented_out:
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
            param_def = None
            param_key_lower = param.key.lower()
            for pd in sec_def.params:
                wildcard_match = False
                if "*" in pd.name:
                    wildcard_prefix, wildcard_suffix = pd.name.lower().split("*", 1)
                    wildcard_match = (
                        param_key_lower.startswith(wildcard_prefix)
                        and param_key_lower.endswith(wildcard_suffix)
                    )

                if pd.name == param.key or pd.name.lower() == param_key_lower or wildcard_match:
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
    _check_pin_conflicts(used_pins, result)

    return result


def validate_project_configs(configs: dict[str, ConfigFile]) -> dict[str, ValidationResult]:
    """Validate a set of config files as one Klipper project.

    Single-file validation remains file-local. For multi-file projects, this
    adds cross-file checks for sections that Klipper allows only once across the
    effective configuration, such as [printer], [stepper_x], or [stepper_z].
    """
    results = {
        filename: validate_config(config, is_multi_file=len(configs) > 1)
        for filename, config in configs.items()
    }

    if len(configs) <= 1:
        return results

    active_files = _get_active_project_files(configs)

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

        sec_def = get_section_def(sec_type)
        severity = _project_duplicate_severity(sec_type, sec_def.category if sec_def else None)

        for filename, section in entries:
            other_files = sorted(files - {filename})
            message = _project_duplicate_message(sec_type, severity, other_files)

            result = results[filename]
            if any(
                error.severity == severity
                and error.section == section.full_header
                and error.message == message
                for error in result.errors
            ):
                continue

            result.errors.append(ValidationError(
                severity=severity,
                section=section.full_header,
                param="",
                message=message,
                line_number=section.line_number,
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
    - Named sections whose type starts with 'probe' (e.g., probe_eddy_current, probe_rr, probe_4in1, temperature_probe)
    """
    if section.section_type == "probe" or section.section_type == "bltouch":
        return True
    if section.section_type.startswith("probe"):
        return True
    return False


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
        value = value.split(":", 1)[1]
    # Strip macro references (e.g., "<z_virtual_endstop>")
    value = value.strip("<>")
    return value.lower() if value else None


def _check_virtual_endstop_without_probe(
    configs: dict[str, ConfigFile],
    active_files: set[str] | None = None,
) -> list[tuple[str, ValidationError]]:
    """Check for endstop_pin = z_virtual_endstop without a probe section.

    In Klipper, using z_virtual_endstop as an endstop_pin requires a probe
    section (BLTouch, bed probe, eddy current probe, temperature_probe, etc.)
    to be defined for Z-offset management. This warning is only valid when
    checking multiple config files as a project.

    Only probe sections in active (included) files are considered, because
    probes in non-included files won't actually be loaded by Klipper.

    Returns a list of (filename, ValidationError) tuples so the caller can
    attach the warning to the correct file's results.
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
        return results

    # No probe found — check each ACTIVE file for z_virtual_endstop usage.
    # Only active (included) files are checked because Klipper won't load
    # sections from non-included files.
    for filename, cfg in configs.items():
        if active_files is not None and filename not in active_files:
            continue
        for section in cfg.sections:
            if section.is_commented_out:
                continue
            for param in section.params:
                if param.is_commented_out or param.key != "endstop_pin":
                    continue
                base_value = _extract_virtual_endstop_value(param.value)
                if base_value in ("z_virtual_endstop", "manually_set_z_virtual_endstop"):
                    results.append((filename, ValidationError(
                        severity="warning",
                        section=section.full_header,
                        param="endstop_pin",
                        message=(
                            f"Section [{section.section_type}] uses 'z_virtual_endstop' "
                            "as the endstop_pin, but no probe section (BLTouch, probe, "
                            "scanner, etc.) is defined. A probe is required for "
                            "z_virtual_endstop to work."
                        ),
                        line_number=param.line_number,
                    )))

    return results


def _get_probe_section_types() -> set[str]:
    """Get all section types that are considered probe sections.
    
    Includes:
    - [probe] (top-level)
    - [bltouch] (top-level)
    - Named sections whose type starts with 'probe' (e.g., probe_eddy_current, probe_rr, probe_4in1)
    """
    types = {"probe", "bltouch"}
    for sec_def in SECTION_DEFS.values():
        if sec_def.section_type.startswith("probe"):
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
                if section.section_type in probe_types or section.section_type.startswith("probe"):
                    probe_sections.add(section.full_header)
    else:
        # No active_files specified — check all files (single-file mode)
        for filename, cfg in configs.items():
            for section in cfg.sections:
                if section.is_commented_out:
                    continue
                if section.section_type in probe_types or section.section_type.startswith("probe"):
                    probe_sections.add(section.full_header)
    
    # Check each file for sections that require probe
    for filename, cfg in configs.items():
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
