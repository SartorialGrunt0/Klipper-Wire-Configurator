"""Generate Klipper .cfg files from structured data."""
from __future__ import annotations

from collections import defaultdict, deque
from difflib import SequenceMatcher

from parser.config_parser import ConfigFile, ConfigSection, ConfigParam, parse_config


def _preserved_tail_start(raw_lines: list[str], save_config_start_line: int) -> int:
    if save_config_start_line <= 0:
        return len(raw_lines)

    tail_start = save_config_start_line - 1
    while tail_start > 0 and not raw_lines[tail_start - 1].strip():
        tail_start -= 1
    return tail_start


def smart_export(config: ConfigFile) -> str:
    """Export config text, using raw_text as the base when available.

    If raw_text is present, parses it to find each section's line range,
    matches submitted sections with parsed originals by line number when
    available and by header name as a fallback,
    and only re-generates sections that have changed.  Unchanged sections
    keep their exact original text (comments, whitespace, formatting, and all).

    Falls back to ``write_config`` when raw_text is not available.
    """
    if not config.raw_text:
        return write_config(config)

    raw_lines = config.raw_text.splitlines()
    original = parse_config(config.raw_text, config.filename)
    preserved_tail_start = _preserved_tail_start(raw_lines, original.save_config_start_line)

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

        # End = start of next section (including its header comments), or the
        # preserved SAVE_CONFIG/footer tail.
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
            end = preserved_tail_start

        section_ranges.append((start, end))

    # Build lookup of original sections by line number first and by header name
    # as a fallback for newly-added sections or older clients.
    orig_by_line: dict[int, tuple[int, ConfigSection]] = {}
    orig_by_header: dict[str, deque[tuple[int, ConfigSection]]] = defaultdict(deque)
    for idx, sec in enumerate(original.sections):
        if sec.line_number > 0:
            orig_by_line[sec.line_number] = (idx, sec)
        orig_by_header[sec.full_header].append((idx, sec))
    used_orig_indices: set[int] = set()

    # Build output
    result_parts: list[str] = []

    # Content before first section (header comments, blank lines, etc.)
    pre_start = section_ranges[0][0] if section_ranges else preserved_tail_start
    if pre_start > 0:
        result_parts.append("\n".join(raw_lines[:pre_start]))

    # Match submitted sections against originals.
    for sub_sec in config.sections:
        orig_entry = None
        if sub_sec.line_number > 0:
            line_entry = orig_by_line.get(sub_sec.line_number)
            if line_entry is not None and line_entry[0] not in used_orig_indices:
                orig_entry = line_entry

        if orig_entry is None:
            entries = orig_by_header.get(sub_sec.full_header)
            while entries and entries[0][0] in used_orig_indices:
                entries.popleft()
            orig_entry = entries.popleft() if entries else None

        if orig_entry is not None:
            orig_idx, orig_sec = orig_entry
            used_orig_indices.add(orig_idx)
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

    if preserved_tail_start < len(raw_lines):
        tail_text = "\n".join(raw_lines[preserved_tail_start:])
        if tail_text:
            result_parts.append(tail_text)

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
    if original.header_comments != submitted.header_comments:
        return False
    if original.trailing_comments != submitted.trailing_comments:
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
            # Respect commented-out state for include directives
            if section.is_commented_out:
                lines.append(f"#[{section.full_header}]")
            else:
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
                result += "\n" + _render_value_line(f"{prefix}  ", vl)
            else:
                result += "\n"
        return result + comment_suffix

    # Single-line value: use original separator with spacing
    if sep == "=":
        return f"{prefix}{param.key} = {param.value}{comment_suffix}"
    else:
        return f"{prefix}{param.key}: {param.value}{comment_suffix}"


def _render_value_line(prefix: str, line: str) -> str:
    """Render one multi-line value line under *prefix*.

    If the line already carries its own leading whitespace (gcode bodies are
    conventionally indented and the parser now preserves that), use it
    verbatim instead of stacking another prefix on top.
    """
    if not line:
        return prefix.rstrip()
    if line[0] in (" ", "\t"):
        return line
    return f"{prefix}{line}"


def _build_multiline_prefix(raw_line: str, original_value_line: str, fallback: str) -> str:
    if not raw_line:
        return fallback
    # The original raw line's leading whitespace IS the block indent.
    # (Value lines now carry their own indentation, so we can't recover it
    # by subtracting the value from the raw line anymore.)
    prefix = raw_line[: len(raw_line) - len(raw_line.lstrip(" \t"))]
    if prefix:
        return prefix
    # Fall back for lines with no leading whitespace (e.g. a flat body or
    # the section's first line): preserve the old subtraction-based logic
    # so first-line handling keeps working.
    if raw_line.endswith(original_value_line):
        return raw_line[:-len(original_value_line)]
    return fallback


def _format_multiline_param_preserving_original(param: ConfigParam, original_param: ConfigParam) -> str:
    original_value_lines = original_param.value.split("\n")
    new_value_lines = param.value.split("\n")
    original_raw_lines = original_param.raw_line.split("\n") if original_param.raw_line else []

    first_separator = original_param.separator if original_param.separator else param.separator
    first_prefix = _build_multiline_prefix(
        original_raw_lines[0] if original_raw_lines else "",
        original_value_lines[0] if original_value_lines else "",
        f"{('#' if param.is_commented_out else '')}{param.key}{first_separator} ",
    )
    continuation_fallback = f"{('#' if param.is_commented_out else '')}  "

    rendered_lines = [""] * len(new_value_lines)
    matcher = SequenceMatcher(a=original_value_lines, b=new_value_lines)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for offset in range(j2 - j1):
                orig_idx = i1 + offset
                new_idx = j1 + offset
                if orig_idx < len(original_raw_lines):
                    rendered_lines[new_idx] = original_raw_lines[orig_idx]
                else:
                    prefix = first_prefix if new_idx == 0 else continuation_fallback
                    rendered_lines[new_idx] = _render_value_line(prefix, new_value_lines[new_idx])
            continue

        for new_idx in range(j1, j2):
            if new_idx == 0:
                rendered_lines[new_idx] = _render_value_line(first_prefix, new_value_lines[new_idx])
                continue

            orig_idx = i1 + min(new_idx - j1, max(0, i2 - i1 - 1))
            prefix = continuation_fallback
            if 0 <= orig_idx < len(original_raw_lines) and orig_idx < len(original_value_lines):
                prefix = _build_multiline_prefix(original_raw_lines[orig_idx], original_value_lines[orig_idx], continuation_fallback)
            rendered_lines[new_idx] = _render_value_line(prefix, new_value_lines[new_idx])

    return "\n".join(rendered_lines)


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
                    and orig_p.is_commented_out == param.is_commented_out):
                lines.append(orig_p.raw_line)
            elif (orig_p
                    and orig_p.raw_line
                    and orig_p.is_commented_out == param.is_commented_out
                    and "\n" in param.value):
                lines.append(_format_multiline_param_preserving_original(param, orig_p))
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
