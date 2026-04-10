"""Generate Klipper .cfg files from structured data."""
from __future__ import annotations

from parser.config_parser import ConfigFile, ConfigSection, ConfigParam


def write_config(config: ConfigFile) -> str:
    """Generate a .cfg file string from a ConfigFile object."""
    lines: list[str] = []

    # Header comments
    for comment in config.header_comments:
        lines.append(comment)
    if config.header_comments:
        lines.append("")

    # Includes
    for inc in config.includes:
        lines.append(f"[include {inc}]")
    if config.includes:
        lines.append("")

    # Sections
    for i, section in enumerate(config.sections):
        if section.section_type == "include":
            continue  # Already written above

        # Section header comments
        for comment in section.header_comments:
            lines.append(comment)

        lines.append(f"[{section.full_header}]")

        # Parameters
        for param in section.params:
            line = _format_param(param)
            lines.append(line)

        # Blank line between sections
        if i < len(config.sections) - 1:
            lines.append("")

    return "\n".join(lines) + "\n"


def _format_param(param: ConfigParam) -> str:
    """Format a single parameter line."""
    prefix = "#" if param.is_commented_out else ""
    comment_suffix = f"   # {param.comment}" if param.comment else ""

    # Handle multi-line values
    if "\n" in param.value:
        value_lines = param.value.split("\n")
        first = f"{prefix}{param.key}:"
        if value_lines[0].strip():
            first += f" {value_lines[0]}"
        result = first
        for vl in value_lines[1:]:
            result += f"\n{prefix}    {vl}"
        return result + comment_suffix

    return f"{prefix}{param.key}: {param.value}{comment_suffix}"


def write_section(section: ConfigSection) -> str:
    """Generate text for a single config section."""
    lines = []
    for comment in section.header_comments:
        lines.append(comment)
    lines.append(f"[{section.full_header}]")
    for param in section.params:
        lines.append(_format_param(param))
    return "\n".join(lines)


def sections_to_config(
    filename: str,
    sections: list[ConfigSection],
    includes: list[str] | None = None,
    header_comments: list[str] | None = None,
) -> ConfigFile:
    """Create a ConfigFile from sections for export."""
    return ConfigFile(
        filename=filename,
        sections=sections,
        includes=includes or [],
        header_comments=header_comments or [],
    )
