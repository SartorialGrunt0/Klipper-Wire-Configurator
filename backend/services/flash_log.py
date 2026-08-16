"""Flash tool logging (kwc.flash → backend/flash.log).

Mirrors the macro-designer logging convention: a dedicated module-level
logger with a file handler attached once at import time, no propagation
to the root logger.

Set KWC_FLASH_DEBUG=1 for DEBUG detail (per-request timing on the
state/preview hot path) — used during Phase 3 perf work.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

logger = logging.getLogger("kwc.flash")

BACKEND_DIR = Path(__file__).resolve().parent.parent
FLASH_LOG = BACKEND_DIR / "flash.log"

if not logger.handlers:
    _file_handler = logging.FileHandler(FLASH_LOG, mode="a", encoding="utf-8")
    _formatter = logging.Formatter("%(asctime)s | %(levelname)s | %(threadName)s | %(message)s")
    _file_handler.setFormatter(_formatter)
    logger.addHandler(_file_handler)
    logger.setLevel(logging.DEBUG if os.environ.get("KWC_FLASH_DEBUG") == "1" else logging.INFO)
    logger.propagate = False
