"""Macro Designer trace log API — durable event log for debugging/testing.

The frontend Macro Designer posts structured events (apply decisions,
section matching, comment preservation, simulation plan summaries) to
this endpoint. Events are appended as timestamped JSON lines to
``macro_designer.log`` in the backend directory, so the log survives
browser reloads and can be read/tailed directly (e.g. by an agent or
during user testing) without asking the user to copy anything.

Companion to the ai_chat.log pattern (kwc.ai logger in ai_routes.py).
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

logger = logging.getLogger("kwc.macro_designer")

BACKEND_DIR = Path(__file__).parent.parent
MACRO_DESIGNER_LOG = BACKEND_DIR / "macro_designer.log"

# Attach a dedicated file handler once (module import time).
if not logger.handlers:
    _file_handler = logging.FileHandler(MACRO_DESIGNER_LOG, mode="a", encoding="utf-8")
    _file_handler.setLevel(logging.INFO)
    _formatter = logging.Formatter("%(asctime)s | %(message)s")
    _file_handler.setFormatter(_formatter)
    logger.addHandler(_file_handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False

router = APIRouter()


class MacroDesignerLogRequest(BaseModel):
    events: list[dict[str, Any]] = []


@router.post("/log/macro-designer")
async def log_macro_designer(req: MacroDesignerLogRequest) -> dict:
    """Append each frontend event as one timestamped JSON line."""
    for event in req.events:
        try:
            line = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError):
            continue
        logger.info("EVENT %s", line)
    return {"ok": True, "count": len(req.events)}
