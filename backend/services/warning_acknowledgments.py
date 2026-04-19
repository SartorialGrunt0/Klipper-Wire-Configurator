"""Persistence for acknowledged validation warnings.

Unknown plugin sections can be copied into a local cfg file outside the repo.
If the same section configuration appears there, validation suppresses the
unknown-section warning.
"""
from __future__ import annotations

import os
from pathlib import Path

from parser.config_parser import ConfigSection, parse_config


def _app_state_dir() -> Path:
    return Path(os.environ.get(
        "KWC_LAYOUT_DIR",
        os.path.expanduser("~/.config/klipper-wire-configurator"),
    ))


def _acknowledged_warnings_file() -> Path:
    app_state_dir = _app_state_dir()
    app_state_dir.mkdir(parents=True, exist_ok=True)
    return app_state_dir / "acknowledged_warnings.cfg"


def _serialize_param_value(value: str) -> list[str]:
    parts = value.split("\n")
    if len(parts) <= 1:
        return [parts[0]]
    lines = [parts[0]]
    lines.extend(f"    {part}" for part in parts[1:])
    return lines


def canonicalize_section(section: ConfigSection) -> str:
    """Return a normalized cfg snippet for a section's active parameters."""
    lines = [f"[{section.full_header}]"]
    for param in section.params:
        if param.key == "_comment_" or param.is_commented_out:
            continue
        value_lines = _serialize_param_value(param.value)
        lines.append(f"{param.key}: {value_lines[0]}")
        lines.extend(value_lines[1:])
    return "\n".join(lines).strip()


def load_acknowledged_warning_sections() -> set[str]:
    """Load normalized acknowledged section snippets from disk."""
    path = _acknowledged_warnings_file()
    if not path.exists():
        return set()
    try:
        config = parse_config(path.read_text(encoding="utf-8"), path.name)
    except OSError:
        return set()
    return {
        canonicalize_section(section)
        for section in config.sections
        if section.section_type != "include" and not section.is_commented_out
    }


def acknowledge_warning_for_section(section: ConfigSection) -> str:
    """Append a normalized section snippet to the acknowledgements file."""
    snippet = canonicalize_section(section)
    path = _acknowledged_warnings_file()
    if not snippet:
        return str(path)

    existing = load_acknowledged_warning_sections()
    if snippet in existing:
        return str(path)

    prefix = ""
    if path.exists():
        try:
            current = path.read_text(encoding="utf-8")
        except OSError:
            current = ""
        if current and not current.endswith("\n"):
            prefix = "\n"
        if current.strip():
            prefix += "\n"

    with path.open("a", encoding="utf-8") as handle:
        handle.write(f"{prefix}{snippet}\n")

    return str(path)