"""Persistence for acknowledged validation warnings.

Two acknowledgment flavors:

1. Unknown plugin sections: the section's full normalized snippet is stored.
   Unknown sections copied into a local cfg file outside the repo are
   suppressed by the same snippet matching.
2. Duplicate sections: only the section *type* is stored. Duplicating a
   ``max_instances=1`` section (same file or across included files) is legal
   in Klipper (later definition wins) but surprising, so it is flagged as a
   warning the user can acknowledge once per type. Storing the type — not a
   param snippet — keeps the ack stable across param edits.
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


def _acknowledged_duplicate_sections_file() -> Path:
    app_state_dir = _app_state_dir()
    app_state_dir.mkdir(parents=True, exist_ok=True)
    return app_state_dir / "acknowledged_duplicate_sections.txt"


def _serialize_param_value(value: str) -> list[str]:
    """Split a param value into its physical lines for the canonical snippet.

    Continuation lines MUST be emitted verbatim — with the exact indentation
    the parser captured in the value. The acknowledgment comparison is
    ``canonicalize_section(live) == canonicalize_section(parse(stored))``, and
    the parser preserves continuation-line whitespace as-is. Any re-indentation
    here inflates on every write->parse cycle, so the stored snippet never
    matches the live config (real case: ``[update_manager moonraker-obico]``
    with an indented ``managed_services:`` block could never be acknowledged).
    """
    return value.split("\n")


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


def load_acknowledged_duplicate_section_types() -> set[str]:
    """Load section types whose duplicate-section warning has been acknowledged."""
    path = _acknowledged_duplicate_sections_file()
    if not path.exists():
        return set()
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        return set()
    return {
        line.strip()
        for line in content.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }


def acknowledge_duplicate_section_type(section_type: str) -> str:
    """Record that duplicate sections of ``section_type`` have been acknowledged."""
    section_type = section_type.strip()
    path = _acknowledged_duplicate_sections_file()
    if not section_type:
        return str(path)

    if section_type in load_acknowledged_duplicate_section_types():
        return str(path)

    with path.open("a", encoding="utf-8") as handle:
        if path.exists() and path.stat().st_size > 0:
            handle.write("\n")
        handle.write(f"{section_type}\n")

    return str(path)