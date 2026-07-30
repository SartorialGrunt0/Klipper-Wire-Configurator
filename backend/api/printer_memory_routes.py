"""Printer Memory API — persistent printer information for AI context."""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

logger = logging.getLogger("kwc.printer_memory")

BACKEND_DIR = Path(__file__).parent.parent
PRINTER_MEMORY_PATH = BACKEND_DIR / "data" / "printer_memory.json"

router = APIRouter()


class PrinterMemory(BaseModel):
    mainboard: str = ""
    toolheadBoard: str = ""
    expanderBoards: str = ""
    printerName: str = ""
    kinematics: str = ""
    probe: str = ""
    additionalNotes: str = ""


def _ensure_default() -> None:
    """Create a default printer_memory.json if it doesn't exist."""
    PRINTER_MEMORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not PRINTER_MEMORY_PATH.exists():
        PRINTER_MEMORY_PATH.write_text(
            json.dumps(PrinterMemory().model_dump(), indent=2),
            encoding="utf-8",
        )
        logger.info("Created default printer_memory.json")


def load_printer_memory() -> PrinterMemory:
    """Load the printer memory from disk."""
    _ensure_default()
    try:
        data = json.loads(PRINTER_MEMORY_PATH.read_text(encoding="utf-8"))
        return PrinterMemory(**data)
    except (json.JSONDecodeError, Exception) as exc:
        logger.warning("Failed to parse printer_memory.json, using defaults: %s", exc)
        return PrinterMemory()


def save_printer_memory(memory: PrinterMemory) -> None:
    """Save the printer memory to disk."""
    _ensure_default()
    PRINTER_MEMORY_PATH.write_text(
        json.dumps(memory.model_dump(), indent=2),
        encoding="utf-8",
    )
    logger.info("Saved printer_memory.json")


def is_printer_memory_blank(memory: PrinterMemory) -> bool:
    """Check if all printer memory fields are blank/empty."""
    return all(
        not getattr(memory, field, "")
        for field in PrinterMemory.model_fields.keys()
    )


def printer_memory_to_context(memory: PrinterMemory) -> str:
    """Format the printer memory for inclusion as a system message."""
    data = memory.model_dump()
    parts = [
        "# Printer Memory",
        "",
        "The following information about your printer has been saved:",
        "",
    ]
    populated = False
    for key, label in [
        ("mainboard", "Mainboard"),
        ("toolheadBoard", "Toolhead Board"),
        ("expanderBoards", "Expander Boards"),
        ("printerName", "Printer Name"),
        ("kinematics", "Kinematics"),
        ("probe", "Probe"),
        ("additionalNotes", "Additional Notes"),
    ]:
        value = data.get(key, "")
        if value:
            populated = True
            parts.append(f"- **{label}**: {value}")
        else:
            parts.append(f"- **{label}**: (not yet set)")

    if not populated:
        parts.append("")
        parts.append(
            "All fields are currently blank. Use the available tools to fill them in:\n"
            "  - `search_example_configs` to find matching bundled example configs for the "
            "user's board/printer\n"
            "  - `read_example_config` to examine the most relevant configs in full\n"
            "  - `search_klipper_docs`, `get_config_reference_section`, and `detect_board` "
            "to confirm hardware details\n"
            "For any details you cannot determine, ask the user to provide them.\n"
            "\n"
            "IMPORTANT: Only these 7 fields are allowed — do NOT add any extra fields:\n"
            "mainboard, toolheadBoard, expanderBoards, printerName, kinematics, "
            "probe, additionalNotes. Any unsupported fields will be rejected."
        )

    parts.append("")
    parts.append(
        "To update this printer memory, return the full updated JSON in a fenced `printer-memory` code block. "
        "The block must contain ONLY the 7 fields listed above — no extras. "
        "The application will let the user review and confirm before saving. "
        "Use this information to avoid asking the user for the same details repeatedly."
    )
    return "\n".join(parts)


# ── REST Endpoints ──────────────────────────────────────────────────


@router.get("/printer-memory")
async def get_printer_memory_endpoint():
    """Get the current printer memory."""
    memory = load_printer_memory()
    return memory.model_dump()


@router.put("/printer-memory")
async def update_printer_memory_endpoint(data: PrinterMemory):
    """Update the printer memory."""
    save_printer_memory(data)
    return {"status": "ok", "memory": data.model_dump()}
