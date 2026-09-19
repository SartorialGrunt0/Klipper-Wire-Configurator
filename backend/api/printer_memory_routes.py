"""Printer Memory API — persistent printer information for AI context."""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, field_validator

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
    buildVolume: str = ""
    extruderType: str = ""
    additionalNotes: str = ""

    @field_validator("extruderType")
    @classmethod
    def _closed_set_extruder_type(cls, v: str) -> str:
        # Closed set: DIRECT DRIVE or BOWDEN are the ONLY options (Sir's
        # spec). Blank = unknown stays valid; anything else is rejected
        # at the API edge so a hallucinated "direct"/"bowden drive"
        # variant can never persist. Accepted spellings canonicalize to
        # the two stored values.
        key = v.strip().lower()
        accepted = {
            "": "",
            "direct": "direct",
            "direct drive": "direct",
            "direct-drive": "direct",
            "directdrive": "direct",
            "bowden": "bowden",
            "bowden drive": "bowden",
            "bowden-drive": "bowden",
            "bowdendrive": "bowden",
        }
        try:
            return accepted[key]
        except KeyError:
            raise ValueError(
                "extruderType must be 'direct' or 'bowden' (got "
                f"{v!r})") from None


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


# ── Mechanical machine-fact derivation (Macro Designer parity) ────────
#
# Kinematics and build volume are NOT guesses — they are mechanically
# derivable from any valid printer.cfg, exactly the way the frontend
# Macro Designer does (macroDesigner.ts createMachineProfile):
#   kinematics   <- [printer] kinematics:
#   build volume <- [stepper_x/y/z] position_min/position_max
#                  (Klipper requires position_max on all three;
#                  position_min defaults to 0), or
#   delta beds   <- [printer] print_radius / delta_radius -> "round ØN"
# Exposed so the blank-memory auto-fill prompt can hand the model the
# derived values verbatim instead of letting it re-derive (or ask).

KINEMATICS_TYPES = [
    "cartesian", "corexy", "corexz", "delta", "deltesian",
    "polar", "rotary_delta", "winch", "hybrid_corexy", "hybrid_corexz",
    "generic_cartesian", "none",
]
_ROUND_KINEMATICS = {"delta", "rotary_delta"}

# MCU role classification mirrors graphBuilder.ts classifyMcuName (the
# graph's orange TOOLHEAD / expander card labelling) so the AI and the
# visual graph can never disagree about what EBBCan or PIS are.
_SBC_NAME_TOKENS = ("host", "rpi", "cb1", "linux")
_TOOLHEAD_NAME_TOKENS = ("ebb", "toolhead", "th")

# Major component section types (parser/config_schema.py is the source
# of truth; these are the probe + accelerometer families users actually
# run, e.g. a Voron Tap lands in [probe], an ADXL in [adxl345]).
PROBE_SECTIONS = {
    "probe": "generic [probe]",
    "bltouch": "BLTouch",
    "smart_effector": "Smart Effector (Klicky-style)",
    "load_cell": "load cell",
    "load_cell_probe": "load cell probe",
    "probe_eddy_current": "eddy current probe",
}
ACCEL_SECTIONS = ("adxl345", "lis2dw", "lis3dh", "bmi160", "mpu9250",
                  "icm20948")


def _chip_from_serial(serial: str) -> str:
    """Chip token from a Klipper usb by-id serial path
    (usb-Klipper_stm32f446xx_<uid>-if00 -> STM32F446). Empty for
    canbus_uuid / raw paths, which reveal no chip."""
    m = re.search(r"Klipper_([A-Za-z0-9]+?)_[0-9A-Fa-f]{6,}", serial)
    if not m:
        return ""
    chip = m.group(1).upper()
    if chip.endswith("XX"):
        chip = chip[:-2]
    return chip


def _hosting_mcu(params: dict[str, str], mcu_names: list[str]) -> str:
    """Which MCU a component section hangs off: explicit sensor_mcu/mcu
    param first, then any 'NAME:' pin prefix (EBBCan:PB13). Empty when
    the section sits on the primary MCU."""
    for key in ("sensor_mcu", "mcu"):
        val = params.get(key, "").strip()
        for name in mcu_names:
            if name and val == name:
                return name
    for value in params.values():
        for name in mcu_names:
            if name and f"{name}:" in value:
                return name
    return ""


def derive_hardware_inventory(config_texts: list[str]) -> dict[str, Any]:
    """Mechanically parse the project's board + major-component roster.

    Mirrors what the graph view draws (cards + labelling): every [mcu]
    section becomes a board with a role, and every probe/accelerometer
    section a component with the board hosting it. Fully deterministic
    — this is what gets injected into the blank-memory auto-fill so the
    model never has to 'pick up' boards by guessing.

    Returns {} when nothing is derivable. Suppressed (commented-out)
    sections never parse (header lines starting with '#' are not
    headers), matching the graph's suppression semantics.
    """
    boards: list[dict[str, str]] = []
    mcu_names: list[str] = []
    for text in config_texts:
        if not text:
            continue
        in_mcu = False
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith("["):
                name = stripped[1:].split("]", 1)[0].strip()
                lower = name.lower()
                if lower == "mcu" or lower.startswith("mcu "):
                    in_mcu = True
                    boards.append({"name": name[3:].strip(), "serial": ""})
                    mcu_names.append(name[3:].strip())
                else:
                    in_mcu = False
                continue
            if in_mcu and ":" in stripped and not stripped.startswith("#"):
                key, _, value = stripped.partition(":")
                if key.strip().lower() == "serial":
                    boards[-1]["serial"] = value.split("#", 1)[0].strip()
    roster: dict[str, Any] = {}
    for b in boards:
        name = b["name"]
        role = _mcu_role(name)
        chip = _chip_from_serial(b["serial"])
        label = name or "primary"
        entry = {"name": label, "role": role}
        if chip:
            entry["chip"] = chip
        roster.setdefault(role, []).append(entry)

    probes: list[dict[str, str]] = []
    accels: list[dict[str, str]] = []
    for text in config_texts:
        if not text:
            continue
        for section, kind in PROBE_SECTIONS.items():
            params = _section_params(text, section)
            if params:
                host = _hosting_mcu(params, mcu_names)
                probes.append({"kind": kind,
                               "mcu": host or "primary"})
        for section in ACCEL_SECTIONS:
            params = _section_params(text, section)
            if params:
                host = _hosting_mcu(params, mcu_names)
                accels.append({"kind": section,
                               "mcu": host or "primary"})
        if _section_params(text, "resonance_tester"):
            roster["resonance_tester"] = True

    if not (roster or probes or accels):
        return {}
    out: dict[str, Any] = {}
    if roster:
        out["boards"] = roster
    if probes:
        out["probes"] = probes
    if accels:
        out["accelerometers"] = accels
    return out


def _mcu_role(name: str) -> str:
    if not name:
        return "mainboard"
    lower = name.lower()
    if any(t in lower for t in _SBC_NAME_TOKENS):
        return "sbc"
    if any(t in lower for t in _TOOLHEAD_NAME_TOKENS):
        return "toolhead"
    return "expander"


def format_hardware_inventory(inv: dict[str, Any]) -> str:
    """Compact prompt rendering of derive_hardware_inventory's roster."""
    parts: list[str] = []
    boards = inv.get("boards", {})
    for role, field_label in (
        ("toolhead", "toolhead board(s)"),
        ("expander", "expander board(s)"),
        ("sbc", "host/SBC mcu(s)"),
        ("mainboard", "main mcu(s)"),
    ):
        entries = boards.get(role) or []
        if entries:
            def _fmt(e: dict[str, str]) -> str:
                chip = e.get("chip")
                return f"{e['name']} ({chip} chip)" if chip else e["name"]
            parts.append(f"{field_label}: "
                         + ", ".join(_fmt(e) for e in entries))
    probes = inv.get("probes") or []
    if probes:
        parts.append("probes: " + ", ".join(
            f"{p['kind']} on {p['mcu']}" for p in probes))
    accels = inv.get("accelerometers") or []
    if accels:
        line = "accelerometers: " + ", ".join(
            f"{a['kind']} on {a['mcu']}" for a in accels)
        if boards.get("resonance_tester") or inv.get("resonance_tester"):
            line += " (+ [resonance_tester] present)"
        parts.append(line)
    return "; ".join(parts)


def _section_params(text: str, header: str) -> dict[str, str]:
    """Params of the first [header] section in config text (key -> value,
    inline comments stripped). {} when the section is absent."""
    out: dict[str, str] = {}
    in_section = False
    target = header.lower()
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("["):
            if in_section:
                break
            name = stripped[1:].split("]", 1)[0].strip().lower()
            in_section = name == target
            continue
        if not in_section or not stripped or stripped.startswith("#"):
            continue
        if ":" in stripped:
            key, _, value = stripped.partition(":")
            value = value.split("#", 1)[0].strip()
            if value:
                out.setdefault(key.strip().lower(), value)
    return out


def _num(value: str | None) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def derive_machine_facts(config_texts: list[str]) -> dict[str, str]:
    """Extract certain machine facts from config file texts.

    Returns a dict with ONLY the keys it could determine
    (kinematics, buildVolume, mainboard). Deliberately conservative:
    partial stepper data returns no buildVolume rather than a wrong one.
    """
    kinematics = ""
    build_volume = ""
    mainboard = ""
    for text in config_texts:
        if not text:
            continue
        printer = _section_params(text, "printer")
        if not kinematics and printer.get("kinematics"):
            kinematics = printer["kinematics"].strip().lower()
        if not build_volume and kinematics:
            if kinematics in _ROUND_KINEMATICS:
                radius = _num(printer.get("print_radius")
                              or printer.get("delta_radius"))
                if radius:
                    build_volume = f"round Ø{round(radius * 2)}"
            elif kinematics != "none":
                sx = _section_params(text, "stepper_x")
                sy = _section_params(text, "stepper_y")
                sz = _section_params(text, "stepper_z")
                xmax, ymax, zmax = (
                    _num(sx.get("position_max")),
                    _num(sy.get("position_max")),
                    _num(sz.get("position_max")),
                )
                if xmax is not None and ymax is not None and zmax is not None:
                    xmin = _num(sx.get("position_min")) or 0.0
                    ymin = _num(sy.get("position_min")) or 0.0
                    zmin = _num(sz.get("position_min")) or 0.0
                    w, d, h = (round(xmax - xmin), round(ymax - ymin),
                               round(zmax - zmin))
                    if w > 0 and d > 0 and h > 0:
                        build_volume = f"{w}x{d}x{h}"
        if not mainboard:
            # Main MCU chip IS knowable from the [mcu] serial by-id path
            # (e.g. usb-Klipper_stm32f446xx_<uid>-if00). The board MODEL
            # is not, so the derived value is an honest hedge stating
            # what IS known; naming the chip beats leaving mainboard
            # blank or asking the user something the config answers.
            mcu = _section_params(text, "mcu")
            serial = mcu.get("serial", "")
            m = re.search(
                r"Klipper_([A-Za-z0-9]+?)_[0-9A-Fa-f]{6,}", serial)
            if m:
                chip = m.group(1).upper()
                if chip.endswith("XX"):
                    chip = chip[:-2]
                if chip:
                    mainboard = f"{chip} board (model unconfirmed)"
    facts: dict[str, str] = {}
    if kinematics:
        facts["kinematics"] = kinematics
    if build_volume:
        facts["buildVolume"] = build_volume
    if mainboard:
        facts["mainboard"] = mainboard
    return facts


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
        ("buildVolume", "Build Volume"),
        ("extruderType", "Extruder Type"),
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
            "IMPORTANT: Only these 9 fields are allowed — do NOT add any "
            "extra fields:\n"
            "mainboard, toolheadBoard, expanderBoards, printerName, "
            "kinematics, probe, buildVolume, extruderType, "
            "additionalNotes. Any unsupported fields will be rejected. "
            "extruderType accepts ONLY 'direct' or 'bowden'.\n"
        )

    parts.append("")
    parts.append(
        "To update this printer memory, return the full updated JSON in a fenced `printer-memory` code block. "
        "The block must contain ONLY the 9 fields listed above — no extras. "
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
