"""Generate Klipper .cfg files from structured data."""
from __future__ import annotations

from collections import defaultdict, deque

from parser.config_parser import ConfigFile, ConfigSection, ConfigParam, parse_config


def smart_export(config: ConfigFile) -> str:
    """Export config text, using raw_text as the base when available.

    If raw_text is present, parses it to find each section's line range,
    matches submitted sections with parsed originals *by header name*,
    and only re-generates sections that have changed.  Unchanged sections
    keep their exact original text (comments, whitespace, formatting, and all).

    Falls back to ``write_config`` when raw_text is not available.
    """
    if not config.raw_text:
        return write_config(config)

    raw_lines = config.raw_text.splitlines()
    original = parse_config(config.raw_text, config.filename)

    # Quick check: if sections match 1-to-1 in order, return raw_text verbatim.
    if len(original.sections) == len(config.sections):
        all_match = True
        for orig_sec, sub_sec in zip(original.sections, config.sections):
            if not _sections_match(orig_sec, sub_sec):
                all_match = False
                break
        if all_match:
            return config.raw_text

    # Sections differ — do surgical replacement.
    # Build line ranges for each original section (0-indexed, inclusive start,
    # exclusive end).
    section_ranges: list[tuple[int, int]] = []
    for idx, sec in enumerate(original.sections):
        # Start at the section header line
        start = sec.line_number - 1  # 1-based → 0-based

        # Walk backwards to include header_comments above the section header
        if sec.header_comments:
            scan = start - 1
            found = 0
            while scan >= 0 and found < len(sec.header_comments):
                if raw_lines[scan].strip():
                    found += 1
                scan -= 1
            start = scan + 1

        # End = start of next section (including its header comments), or EOF
        if idx + 1 < len(original.sections):
            next_start = original.sections[idx + 1].line_number - 1
            if original.sections[idx + 1].header_comments:
                scan = next_start - 1
                found = 0
                while scan >= 0 and found < len(original.sections[idx + 1].header_comments):
                    if raw_lines[scan].strip():
                        found += 1
                    scan -= 1
                next_start = scan + 1
            end = next_start
        else:
            end = len(raw_lines)

        section_ranges.append((start, end))

    # Build lookup of original sections by header for matching.
    # Use a deque per header to handle duplicate section names correctly
    # (each submitted section consumes the next matching original in order).
    orig_by_header: dict[str, deque[tuple[int, ConfigSection]]] = defaultdict(deque)
    for idx, sec in enumerate(original.sections):
        orig_by_header[sec.full_header].append((idx, sec))

    # Build output
    result_parts: list[str] = []

    # Content before first section (header comments, blank lines, etc.)
    pre_start = section_ranges[0][0] if section_ranges else len(raw_lines)
    if pre_start > 0:
        result_parts.append("\n".join(raw_lines[:pre_start]))

    # Match submitted sections by header name against originals
    for sub_sec in config.sections:
        entries = orig_by_header.get(sub_sec.full_header)
        orig_entry = entries.popleft() if entries else None

        if orig_entry is not None:
            orig_idx, orig_sec = orig_entry
            start, end = section_ranges[orig_idx]

            if _sections_match(orig_sec, sub_sec):
                # Unchanged — use original raw lines
                result_parts.append("\n".join(raw_lines[start:end]))
            else:
                # Changed — regenerate using original as reference
                regenerated = write_section(sub_sec, orig_sec)
                result_parts.append(regenerated)
                # Preserve trailing blank lines from original
                if end > 0 and end <= len(raw_lines):
                    trailing_blanks = []
                    j = end - 1
                    while j >= start and not raw_lines[j].strip():
                        trailing_blanks.append("")
                        j -= 1
                    if trailing_blanks:
                        result_parts.append("\n".join(trailing_blanks))
        else:
            # New section added by user
            result_parts.append("")
            result_parts.append(write_section(sub_sec))

    text = "\n".join(result_parts)
    if not text.endswith("\n"):
        text += "\n"
    return text


def _sections_match(original: ConfigSection, submitted: ConfigSection) -> bool:
    """Check if two sections have the same content (ignoring line numbers)."""
    if original.full_header != submitted.full_header:
        return False
    if original.is_commented_out != submitted.is_commented_out:
        return False

    # Filter out _comment_ pseudo-params for comparison — they represent
    # original inline comments that the frontend doesn't modify.
    orig_params = [(p.key, p.value, p.is_commented_out)
                   for p in original.params if p.key != "_comment_"]
    sub_params = [(p.key, p.value, p.is_commented_out)
                  for p in submitted.params if p.key != "_comment_"]

    return orig_params == sub_params


def write_config(config: ConfigFile) -> str:
    """Generate a .cfg file string from a ConfigFile object.

    If the config has raw_text and the structured data hasn't been modified
    beyond what was parsed, sections and params are written in their original
    order with original formatting preserved.
    """
    lines: list[str] = []

    # Header comments
    for comment in config.header_comments:
        lines.append(comment)
    if config.header_comments:
        lines.append("")

    # Write sections in order (includes are stored as sections too)
    for i, section in enumerate(config.sections):
        # Section header comments (dividers, explanatory comments before [header])
        for comment in section.header_comments:
            lines.append(comment)

        if section.section_type == "include":
            lines.append(f"[{section.full_header}]")
        else:
            # Comment out header if section is suppressed
            if section.is_commented_out:
                lines.append(f"#[{section.full_header}]")
            else:
                lines.append(f"[{section.full_header}]")

            # Parameters (including _comment_ pseudo-params for inline comments)
            for param in section.params:
                if param.key == "_comment_":
                    lines.append(param.value)
                else:
                    line = _format_param(param)
                    lines.append(line)

        # Trailing comments after last param in section
        for comment in section.trailing_comments:
            lines.append(comment)

        # Blank line between sections
        if i < len(config.sections) - 1:
            lines.append("")

    return "\n".join(lines) + "\n"


def _format_param(param: ConfigParam) -> str:
    """Format a single parameter line, preserving original separator style."""
    prefix = "#" if param.is_commented_out else ""
    comment_suffix = f"   # {param.comment}" if param.comment else ""
    sep = param.separator if param.separator else ":"

    # Handle multi-line values
    if "\n" in param.value:
        value_lines = param.value.split("\n")
        first = f"{prefix}{param.key}{sep}"
        if value_lines[0].strip():
            # Use space after separator if there's content on same line
            first += f" {value_lines[0]}"
        result = first
        for vl in value_lines[1:]:
            if vl.strip():
                result += f"\n{prefix}  {vl}"
            else:
                result += "\n"
        return result + comment_suffix

    # Single-line value: use original separator with spacing
    if sep == "=":
        return f"{prefix}{param.key} = {param.value}{comment_suffix}"
    else:
        return f"{prefix}{param.key}: {param.value}{comment_suffix}"


def write_section(section: ConfigSection, original_section: ConfigSection | None = None) -> str:
    """Generate text for a single config section.

    If *original_section* is provided (from a parsed raw_text), params whose
    (key, value, is_commented_out) haven't changed will use their original
    raw line text instead of being reformatted.
    """
    # Build a lookup of original params by (index, key) to compare
    orig_params: dict[tuple[int, str], ConfigParam] = {}
    if original_section:
        idx = 0
        for p in original_section.params:
            orig_params[(idx, p.key)] = p
            idx += 1

    lines = []
    for comment in section.header_comments:
        lines.append(comment)
    if section.is_commented_out:
        lines.append(f"#[{section.full_header}]")
    else:
        lines.append(f"[{section.full_header}]")

    param_idx = 0
    for param in section.params:
        if param.key == "_comment_":
            lines.append(param.value)
        else:
            # Check if this param matches the original
            orig_p = orig_params.get((param_idx, param.key))
            if (orig_p
                    and orig_p.raw_line
                    and orig_p.value == param.value
                    and orig_p.is_commented_out == param.is_commented_out
                    and "\n" not in param.value):
                lines.append(orig_p.raw_line)
            else:
                lines.append(_format_param(param))
        param_idx += 1

    for comment in section.trailing_comments:
        lines.append(comment)
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
