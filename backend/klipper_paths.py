"""Resolve which Klipper doc sources KWC serves.

Hard failover, single source: when KWC is NATIVELY deployed on the Pi (the
app's system config path exists — the same marker routes.py uses) and an
installed Klipper repo with a docs/ directory is found (env
KWC_KLIPPER_DIR, then common install paths), the docs are served from THAT
repo — they track the installed firmware version, which is the version the
user's config must match. Otherwise (dev checkout, Windows, no marker) we
fall back to the bundled copies in reference/. The env override
KWC_KLIPPER_DIR always wins so a dev box can point at a specific checkout.

KWC-authored docs always load alongside from reference/kwc_docs/ (they are
not duplicates of official docs, so they do not break the single-source
rule).
"""

import os
from pathlib import Path

from services.native_services import is_native_platform

BACKEND_DIR = Path(__file__).parent
REFERENCE_DIR = BACKEND_DIR.parent / "reference"
BUNDLED_KLIPPER_DOCS_DIR = REFERENCE_DIR / "reference_docs" / "klipper_docs"
BUNDLED_CONFIG_EXAMPLES_DIR = REFERENCE_DIR / "config"
KWC_CUSTOM_DOCS_DIR = REFERENCE_DIR / "kwc_docs"

_COMMON_KLIPPER_PATHS = (
    Path.home() / "klipper",
    Path("/home/pi/klipper"),
    Path("/usr/share/klipper"),
)

# The Pi deployment marker: this dir only exists when KWC is natively
# installed alongside Klipper (same default as mcp_server.SYSTEM_CONFIG_PATH).
DEPLOYMENT_CONFIG_PATH = Path(
    os.environ.get("KLIPPER_CONFIG_PATH", "/home/pi/.klipper/config")
)


def _deployment_looks_native() -> bool:
    """True when KWC is natively deployed on a Pi (system config path present)
    and we're on Linux — i.e., not a dev checkout / Windows box."""
    return is_native_platform() and DEPLOYMENT_CONFIG_PATH.is_dir()


def find_klipper_install() -> Path | None:
    """Locate an installed Klipper repo with a docs/ dir, or None.

    The KWC_KLIPPER_DIR env override always wins (dev/test escape hatch).
    Otherwise only probes common install paths (KIAUH's default is
    ~/klipper) when the app looks natively deployed on the Pi.
    """
    env_dir = os.environ.get("KWC_KLIPPER_DIR")
    if env_dir:
        cand = Path(env_dir)
        return cand if (cand / "docs").is_dir() else None

    if not _deployment_looks_native():
        return None

    for cand in _COMMON_KLIPPER_PATHS:
        if (cand / "docs").is_dir():
            return cand
    return None


KLIPPER_INSTALL_DIR = find_klipper_install()

# Official Klipper docs: installed repo if present, else bundled copies.
KLIPPER_DOCS_DIR = (
    KLIPPER_INSTALL_DIR / "docs"
    if KLIPPER_INSTALL_DIR is not None
    else BUNDLED_KLIPPER_DOCS_DIR
)

# Example configs stay BUNDLED: KWC reorganizes them into category subdirs
# (Mainboard/, Printer/, ...) that the tools depend on, while the installed
# klipper config/ is flat (root generic-*.cfg + a few subdirs). Pointing
# there would silently drop root files. Staleness here is cosmetic (samples
# for the editor), unlike the docs which the model answers from.
CONFIG_EXAMPLES_DIR = BUNDLED_CONFIG_EXAMPLES_DIR

# Human label surfaced in list_klipper_docs so the model/user knows which
# docset they are reading.
DOC_SOURCE = (
    f"installed Klipper ({KLIPPER_INSTALL_DIR})"
    if KLIPPER_INSTALL_DIR is not None
    else "bundled reference copies"
)
