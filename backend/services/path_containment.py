"""Root containment for request-supplied filesystem paths (security-work 1.2).

The native routes accept a raw directory path (query/body param). Before
containment any caller could enumerate arbitrary directories
(`config-files?path=/etc` listed /etc, live-probed) or have files written
wherever the backend user could write (`apply {"config_path": ...}`).

Rule, mirroring Moonraker file_manager semantics: RESOLVE the path
(symlinks included — KAMP/moonraker-obico installs symlink their .cfg
files INTO the config dir, and an in-root symlink pointing at another
in-root location stays legal), then require the resolved target to sit
inside one of the allowed roots.

Allowed roots = the settings `config_path` plus `KWC_EXTRA_CONFIG_DIRS`
(os.pathsep-separated, empty default). Installs that symlink configs to
targets OUTSIDE the config dir now get a 400 naming the escape hatch —
a 400 that explains itself beats silent traversal.
"""
from __future__ import annotations

import os
from pathlib import Path

EXTRA_DIRS_ENV = "KWC_EXTRA_CONFIG_DIRS"


def extra_config_dirs() -> list[Path]:
    """The KWC_EXTRA_CONFIG_DIRS escape-hatch list (empty by default)."""
    raw = os.environ.get(EXTRA_DIRS_ENV, "")
    return [Path(part) for part in raw.split(os.pathsep) if part.strip()]


def config_roots(settings_config_path: str) -> list[Path]:
    """Allowed roots: the active config dir plus the escape-hatch dirs."""
    return [Path(settings_config_path)] + extra_config_dirs()


def within(root: Path, target: Path) -> bool:
    """True when the RESOLVED target is the RESOLVED root or below it."""
    return target == root or root in target.parents


def resolve_within_roots(path: str, roots: list[Path]) -> Path:
    """Resolve `path` and require it to sit inside one of `roots`.

    Raises ValueError (route turns it into a 400) naming
    KWC_EXTRA_CONFIG_DIRS when the path escapes every root. Resolution is
    non-strict so apply can write NEW files; symlink components are
    followed, which is exactly what makes an escaping symlink fail.
    """
    candidate = Path(path).expanduser().resolve(strict=False)
    for root in roots:
        if within(root.expanduser().resolve(strict=False), candidate):
            return candidate
    raise ValueError(
        f"Path '{path}' is outside the allowed config directories. "
        "If a config legitimately lives elsewhere, add its directory to "
        f"{EXTRA_DIRS_ENV} (os.pathsep-separated)."
    )
