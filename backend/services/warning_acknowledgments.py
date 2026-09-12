"""Persistence for acknowledged validation warnings.

Three acknowledgment flavors:

1. Unknown plugin sections: the section's full normalized snippet is stored.
   Unknown sections copied into a local cfg file outside the repo are
   suppressed by the same snippet matching.
2. Duplicate sections: only the section *type* is stored. Duplicating a
   ``max_instances=1`` section (same file or across included files) is legal
   in Klipper (later definition wins) but surprising, so it is flagged as a
   warning the user can acknowledge once per type. Storing the type — not a
   param snippet — keeps the ack stable across param edits.
3. Bulk finding identities (Phase 4 save gate): one line per finding,
   ``file|code|section|param|extra``. This is the store behind
   "Acknowledge all of these warnings" in the save dialog — the only flavor
   that can express ANY warning code (the two snippet/type stores above
   cover exactly two codes). ``extra`` is a code-specific discriminator
   (``missing_include`` -> the include spec, so two different missing
   includes in one file don't collide; empty for all other codes today).
   Deliberately stable across param edits: that's what "acknowledged"
   should mean at save time. Warnings only — errors and info are never
   suppressed from this store (see validator).
"""
from __future__ import annotations

import os
import tempfile
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


# ── 3. Bulk finding identities (Phase 4 save gate) ─────────────────────────

# Finding codes produced by the gcode command registry scan. Their ack
# discriminator is the COMMAND NAME (emit-site `extra`), so one ack silences
# one command in a macro body — not every current/future warning there.
GCODE_FINDING_CODES = frozenset({
    "unknown_gcode_command",
    "gcode_command_section_missing",
})


def _acknowledged_warning_identities_file() -> Path:
    app_state_dir = _app_state_dir()
    app_state_dir.mkdir(parents=True, exist_ok=True)
    return app_state_dir / "acknowledged_warning_identities.txt"


def warning_identity(
    file: str, code: str, section: str, param: str, extra: str = "",
) -> str:
    """Stable machine identity for one finding.

    ``file|code|section|param|extra`` — ``extra`` is a code-specific
    discriminator (``missing_include`` -> the include spec, so two different
    missing includes in one file don't collide; empty for all other codes
    today). Fields must not contain ``|`` (config headers, param keys and
    codes never do; ``extra`` is normalized defensively).

    Callers should prefer :func:`finding_identity`, which derives ``extra``
    server-side so suppression and the bulk-ack endpoint always agree.
    """
    return "|".join([
        file.strip(), code.strip(), section.strip(), param.strip(),
        extra.replace("|", "_").strip(),
    ])


def finding_identity(
    filename: str, code: str, section: str, param: str,
    extra: str = "",
) -> str:
    """Identity for a validator finding, with ``extra`` derived here.

    Single derivation point: the validator's suppression pass and the
    ``/warning-acknowledgements/bulk`` endpoint both use this, so an ack
    written by one is always recognized by the other. Client-supplied
    ``extra`` is deliberately not trusted (a client bug would otherwise
    create identities that suppression never matches) — EXCEPT for the
    gcode registry codes, where the discriminator is the COMMAND NAME
    emitted server-side on the finding and round-tripped verbatim:
    section+param cannot separate two unknown commands in one macro
    body, and without it a single ack would silently suppress every
    current AND future registry warning in that body.
    """
    if code in GCODE_FINDING_CODES:
        extra = extra.strip().upper()
    else:
        extra = ""
    if code == "missing_include":
        # section is "include <spec>"; the spec discriminates multiple
        # missing includes in one file.
        if section.startswith("include "):
            extra = section[len("include "):].strip()
        else:
            extra = section
    return warning_identity(filename, code, section, param, extra)


def load_acknowledged_warning_identities() -> set[str]:
    """Load bulk-acknowledged finding identities from disk."""
    path = _acknowledged_warning_identities_file()
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


def _atomic_write(path: Path, content: str) -> None:
    """Write via temp-file + os.replace: readers never see a torn file."""
    tmp = tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent,
        prefix=path.name + ".", suffix=".tmp", delete=False)
    try:
        try:
            if path.exists():
                os.chmod(tmp.name, path.stat().st_mode & 0o7777)
            tmp.write(content)
        finally:
            tmp.close()
        os.replace(tmp.name, path)
    except BaseException:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        raise


def _rewrite_lines(path: Path, keep) -> int:
    """Rewrite a line-based store file keeping entries ``keep()`` accepts.

    Returns the number of entries removed. Blank/comment lines are dropped
    on rewrite (the loaders skip them anyway; writers never add them).
    """
    if not path.exists():
        return 0
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        return 0
    entries = [
        line.strip() for line in content.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    kept = [entry for entry in entries if keep(entry)]
    removed = len(entries) - len(kept)
    if removed:
        _atomic_write(path, "".join(f"{entry}\n" for entry in kept))
    return removed


def remove_acknowledged_warning_section(snippet: str) -> int:
    """Remove one unknown-section snippet ack (exact canonical match).

    The store is a cfg file of appended canonical snippets; rewriting the
    surviving snippets in canonical form is lossless for machine-written
    content (no comments are ever stored).
    """
    snippet = snippet.strip()
    path = _acknowledged_warnings_file()
    if not path.exists() or not snippet:
        return 0
    try:
        config = parse_config(path.read_text(encoding="utf-8"), path.name)
    except OSError:
        return 0
    kept = []
    removed = 0
    for section in config.sections:
        if section.section_type == "include" or section.is_commented_out:
            continue
        if canonicalize_section(section) == snippet:
            removed += 1
        else:
            kept.append(canonicalize_section(section))
    if removed:
        _atomic_write(path, "\n".join(kept) + ("\n" if kept else ""))
    return removed


def remove_acknowledged_duplicate_section_type(section_type: str) -> int:
    """Remove one duplicate-section-type ack (exact match)."""
    section_type = section_type.strip()
    if not section_type:
        return 0
    return _rewrite_lines(
        _acknowledged_duplicate_sections_file(),
        lambda entry: entry != section_type,
    )


def remove_acknowledged_warning_identity(identity: str) -> int:
    """Remove one bulk finding-identity ack (exact match)."""
    identity = identity.strip()
    if not identity:
        return 0
    return _rewrite_lines(
        _acknowledged_warning_identities_file(),
        lambda entry: entry != identity,
    )


def clear_all_acknowledgements() -> dict:
    """Remove every ack from all three stores. Returns per-kind counts."""
    counts = {
        "sections": len(load_acknowledged_warning_sections()),
        "duplicate_section_types": len(
            load_acknowledged_duplicate_section_types()),
        "identities": len(load_acknowledged_warning_identities()),
    }
    for path in (
        _acknowledged_warnings_file(),
        _acknowledged_duplicate_sections_file(),
        _acknowledged_warning_identities_file(),
    ):
        if path.exists():
            _atomic_write(path, "")
    return counts


def acknowledge_warning_identities(identities: list[str]) -> str:
    """Append finding identities to the bulk-ack store (idempotent)."""
    path = _acknowledged_warning_identities_file()
    existing = load_acknowledged_warning_identities()
    new = [
        ident.strip() for ident in identities
        if ident.strip() and ident.strip() not in existing
    ]
    if new:
        prefix = ""
        if path.exists():
            try:
                current = path.read_text(encoding="utf-8")
            except OSError:
                current = ""
            if current and not current.endswith("\n"):
                prefix = "\n"
        with path.open("a", encoding="utf-8") as handle:
            handle.write(prefix)
            for ident in new:
                handle.write(f"{ident}\n")
    return str(path)