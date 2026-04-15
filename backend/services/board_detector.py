"""Board type auto-detection from config files and reference configs."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

from parser.config_parser import ConfigFile


# Board type constants
BOARD_TYPE_MAINBOARD = "mainboard"
BOARD_TYPE_TOOLHEAD = "toolhead"
BOARD_TYPE_PROBE = "probe"
BOARD_TYPE_EXPANDER = "expander"
BOARD_TYPE_ACCELEROMETER = "accelerometer"
BOARD_TYPE_OTHER = "other"

# Maps subdirectory names to board_type values
BOARD_TYPE_DIRS = {
    "Mainboard": BOARD_TYPE_MAINBOARD,
    "Toolhead": BOARD_TYPE_TOOLHEAD,
    "Probe": BOARD_TYPE_PROBE,
    "Expander": BOARD_TYPE_EXPANDER,
    "Accelerometer": BOARD_TYPE_ACCELEROMETER,
    "Other": BOARD_TYPE_OTHER,
}

# Board identification patterns from config filenames and MCU types
BOARD_PATTERNS = [
    # BigTreeTech boards
    (r"bigtreetech|btt", "BigTreeTech"),
    (r"octopus", "BigTreeTech Octopus"),
    (r"skr[\s_-]?mini[\s_-]?e3", "BigTreeTech SKR Mini E3"),
    (r"skr[\s_-]?pro", "BigTreeTech SKR Pro"),
    (r"skr[\s_-]?v?1\.[134]", "BigTreeTech SKR v1.x"),
    (r"skr[\s_-]?[23]", "BigTreeTech SKR 2/3"),
    (r"skr[\s_-]?pico", "BigTreeTech SKR Pico"),
    (r"manta", "BigTreeTech Manta"),
    (r"skr[\s_-]?e3", "BigTreeTech SKR E3"),
    # Creality boards
    (r"creality[\s_-]?v4\.2\.[71]0?", "Creality v4.2.x"),
    (r"creality", "Creality"),
    # FYSETC
    (r"fysetc[\s_-]?s6", "FYSETC S6"),
    (r"fysetc[\s_-]?cheetah", "FYSETC Cheetah"),
    (r"fysetc[\s_-]?f6", "FYSETC F6"),
    (r"fysetc[\s_-]?spider", "FYSETC Spider"),
    (r"fysetc", "FYSETC"),
    # Duet
    (r"duet[\s_-]?3[\s_-]?6hc", "Duet 3 6HC"),
    (r"duet[\s_-]?3[\s_-]?mini", "Duet 3 Mini"),
    (r"duet[\s_-]?2[\s_-]?maestro", "Duet 2 Maestro"),
    (r"duet[\s_-]?2", "Duet 2"),
    (r"duet", "Duet"),
    # Einsy
    (r"einsy[\s_-]?rambo", "Einsy Rambo"),
    # MKS boards
    (r"mks[\s_-]?robin[\s_-]?nano", "MKS Robin Nano"),
    (r"mks[\s_-]?robin", "MKS Robin"),
    (r"mks[\s_-]?gen[\s_-]?l", "MKS Gen L"),
    (r"mks[\s_-]?sgen", "MKS SGen"),
    (r"mks", "MKS"),
    # Mellow
    (r"mellow[\s_-]?fly", "Mellow Fly"),
    (r"mellow", "Mellow"),
    # LDO
    (r"ldo[\s_-]?leviathan", "LDO Leviathan"),
    (r"ldo", "LDO"),
    # Generic
    (r"ramps", "RAMPS"),
    (r"archim", "Archim"),
    (r"rambo", "RAMBo"),
]

# MCU chip identification
MCU_PATTERNS = [
    (r"stm32f446", "STM32F446"),
    (r"stm32f429", "STM32F429"),
    (r"stm32f407", "STM32F407"),
    (r"stm32f401", "STM32F401"),
    (r"stm32f103", "STM32F103"),
    (r"stm32g0b1", "STM32G0B1"),
    (r"stm32h723", "STM32H723"),
    (r"rp2040", "RP2040"),
    (r"lpc176", "LPC1768/1769"),
    (r"at90usb", "AT90USB"),
    (r"atmega2560", "ATmega2560"),
    (r"atmega1284p", "ATmega1284P"),
    (r"samd51", "SAMD51"),
    (r"same70", "SAME70"),
    (r"sam[34]", "SAM3/4"),
]

# ── Board-type heuristics (filename-based) ───────────────────────

# Known toolhead board patterns (CAN bus toolheads)
_TOOLHEAD_PATTERNS = [
    r"ebb[\s_-]?canbus",
    r"ebb[\s_-]?sb",
    r"hermit[\s_-]?crab",
    r"huvud",
    r"duet[\s_-]?3[\s_-]?1lc",
    r"sht[\s_-]?3[56]",      # Mellow SHT36/SHT42
    r"sht[\s_-]?42",
    r"fly[\s_-]?sht",
    r"sb[\s_-]?canbus",
    r"toolhead",
]

# Known probe patterns
_PROBE_PATTERNS = [
    r"cartographer",
    r"beacon",
    r"bltouch",
    r"probe[\s_-]?as[\s_-]?z",
    r"klicky",
    r"euclid",
    r"tap",                   # Voron Tap
    r"eddy",                  # BTT Eddy
    r"inductive[\s_-]?probe",
    r"scanner",
]

# Known expander patterns
_EXPANDER_PATTERNS = [
    r"exp[\s_-]?mot",
    r"expander",
    r"ext[\s_-]?mot",
    r"motor[\s_-]?expan",
]

# Known accelerometer patterns
_ACCELEROMETER_PATTERNS = [
    r"adxl[\s_-]?345",
    r"lis2dw",
    r"mpu[\s_-]?[69]",
    r"accelerometer",
    r"input[\s_-]?shaper",
]


def _match_any(text: str, patterns: list[str]) -> bool:
    """Return True if any pattern matches the text."""
    for pat in patterns:
        if re.search(pat, text, re.IGNORECASE):
            return True
    return False


def detect_board_type_from_filename(filename: str) -> tuple[str, float]:
    """Infer board_type from a config filename prefix and known patterns.

    Returns (board_type, confidence) where confidence reflects how
    certain the heuristic is.
    """
    name = filename.lower().removesuffix(".cfg")

    # Prefix-based rules (high confidence)
    if name.startswith("generic-") or name.startswith("kit-"):
        return BOARD_TYPE_MAINBOARD, 0.9
    if name.startswith("printer-"):
        return BOARD_TYPE_MAINBOARD, 0.9

    # For sample- and other prefixes, use pattern matching
    if _match_any(name, _TOOLHEAD_PATTERNS):
        return BOARD_TYPE_TOOLHEAD, 0.85
    if _match_any(name, _PROBE_PATTERNS):
        return BOARD_TYPE_PROBE, 0.85
    if _match_any(name, _EXPANDER_PATTERNS):
        return BOARD_TYPE_EXPANDER, 0.85
    if _match_any(name, _ACCELEROMETER_PATTERNS):
        return BOARD_TYPE_ACCELEROMETER, 0.85

    # example-* files are reference examples, not board-specific
    if name.startswith("example-") or name == "example":
        return BOARD_TYPE_OTHER, 0.7

    # sample- prefix with no recognized pattern → uncertain
    if name.startswith("sample-"):
        return BOARD_TYPE_OTHER, 0.3

    return BOARD_TYPE_OTHER, 0.0


def detect_board_type_from_content(config: ConfigFile) -> tuple[str, float]:
    """Infer board_type by analysing the sections present in the config.

    Heuristics:
    - Has [printer] + stepper_x/y/z + heater_bed → mainboard
    - Has [mcu] with canbus_uuid and extruder on same MCU → toolhead
    - Has scanner/probe sections only → probe
    - Has adxl345 / resonance_tester → accelerometer
    - Has extra steppers but no printer section → expander
    """
    section_types = set()
    section_headers = set()
    has_canbus = False
    has_printer = False
    has_bed = False
    has_extruder = False
    has_probe_section = False
    has_scanner = False
    has_accel = False
    stepper_count = 0

    for section in config.sections:
        stype = section.section_type.lower()
        header = section.full_header.lower()
        section_types.add(stype)
        section_headers.add(header)

        if stype == "printer":
            has_printer = True
        if stype == "heater_bed":
            has_bed = True
        if stype == "extruder" or header.startswith("[extruder"):
            has_extruder = True
        if stype in ("probe", "bltouch"):
            has_probe_section = True
        if stype == "scanner" or "cartographer" in header:
            has_scanner = True
        if stype in ("adxl345", "lis2dw", "resonance_tester"):
            has_accel = True
        if stype.startswith("stepper_"):
            stepper_count += 1

        for param in section.params:
            if param.key == "canbus_uuid" and not param.is_commented_out:
                has_canbus = True

    # Mainboard: has [printer] with bed and steppers
    if has_printer and has_bed and stepper_count >= 2:
        return BOARD_TYPE_MAINBOARD, 0.9

    # Mainboard: has [printer] section (even without bed – could be a delta, etc.)
    if has_printer and stepper_count >= 2:
        return BOARD_TYPE_MAINBOARD, 0.7

    # Toolhead: CAN bus MCU with extruder, no [printer]
    if has_canbus and has_extruder and not has_printer:
        return BOARD_TYPE_TOOLHEAD, 0.85

    # Probe-only: scanner/probe sections without printer/bed/steppers
    if (has_scanner or has_probe_section) and not has_printer and stepper_count == 0:
        return BOARD_TYPE_PROBE, 0.8

    # Accelerometer: adxl/resonance only
    if has_accel and not has_printer and not has_extruder:
        return BOARD_TYPE_ACCELEROMETER, 0.8

    # Expander: extra steppers but no printer section
    if stepper_count > 0 and not has_printer and not has_extruder:
        return BOARD_TYPE_EXPANDER, 0.7

    return BOARD_TYPE_OTHER, 0.0


def detect_board_from_config(config: ConfigFile) -> dict:
    """Attempt to detect the board type from a parsed config file.

    Returns a dict with:
        - board_name: Detected board name or "Unknown"
        - board_type: "mainboard" | "toolhead" | "probe" | "expander"
                      | "accelerometer" | "other"
        - board_type_confidence: float 0-1
        - mcu_chip: Detected MCU chip or "Unknown"
        - confidence: float 0-1
        - matches: list of matching patterns
    """
    result = {
        "board_name": "Unknown",
        "board_type": BOARD_TYPE_OTHER,
        "board_type_confidence": 0.0,
        "mcu_chip": "Unknown",
        "confidence": 0.0,
        "matches": [],
    }

    # Gather text to search: comments, serial paths, all text
    search_text = ""
    for comment in config.header_comments:
        search_text += comment.lower() + "\n"

    for section in config.sections:
        for comment in section.header_comments:
            search_text += comment.lower() + "\n"
        for param in section.params:
            if param.comment:
                search_text += param.comment.lower() + "\n"
            if param.key == "serial":
                search_text += param.value.lower() + "\n"

    search_text += config.raw_text.lower()

    # Board detection
    for pattern, name in BOARD_PATTERNS:
        if re.search(pattern, search_text, re.IGNORECASE):
            result["board_name"] = name
            result["matches"].append(f"Board pattern: {name}")
            result["confidence"] = max(result["confidence"], 0.6)
            break

    # MCU detection
    for pattern, chip in MCU_PATTERNS:
        if re.search(pattern, search_text, re.IGNORECASE):
            result["mcu_chip"] = chip
            result["matches"].append(f"MCU: {chip}")
            result["confidence"] = max(result["confidence"], 0.4)
            break

    # Higher confidence if both detected
    if result["board_name"] != "Unknown" and result["mcu_chip"] != "Unknown":
        result["confidence"] = 0.85

    # ── Board type detection ──────────────────────────────────
    # Try filename first, then fall back to content analysis
    fname_type, fname_conf = detect_board_type_from_filename(config.filename)
    content_type, content_conf = detect_board_type_from_content(config)

    # Use whichever method is more confident
    if content_conf >= fname_conf:
        result["board_type"] = content_type
        result["board_type_confidence"] = content_conf
        if content_conf > 0:
            result["matches"].append(f"Board type (content): {content_type}")
    else:
        result["board_type"] = fname_type
        result["board_type_confidence"] = fname_conf
        if fname_conf > 0:
            result["matches"].append(f"Board type (filename): {fname_type}")

    return result


def get_available_examples(reference_dir: Path) -> list[dict]:
    """List all available example configs from the reference directory.

    Scans subdirectories (Mainboard, Toolhead, Probe, Expander,
    Accelerometer, Other) and falls back to flat *.cfg in the config
    root for backwards compatibility.
    """
    config_dir = reference_dir / "config"
    if not config_dir.exists():
        return []

    examples = []

    # Scan typed subdirectories
    for subdir_name, board_type in BOARD_TYPE_DIRS.items():
        subdir = config_dir / subdir_name
        if not subdir.is_dir():
            continue
        for cfg_file in sorted(subdir.glob("*.cfg")):
            name = cfg_file.stem
            category = _category_from_prefix(name)
            tags = _extract_tags(name)
            examples.append({
                "filename": cfg_file.name,
                "name": name,
                "category": category,
                "board_type": board_type,
                "tags": tags,
                "path": str(cfg_file),
                "subdir": subdir_name,
            })

    # Also pick up any .cfg files still in the config root (migration compat)
    for cfg_file in sorted(config_dir.glob("*.cfg")):
        name = cfg_file.stem
        category = _category_from_prefix(name)
        detected_type, _ = detect_board_type_from_filename(cfg_file.name)
        tags = _extract_tags(name)
        examples.append({
            "filename": cfg_file.name,
            "name": name,
            "category": category,
            "board_type": detected_type,
            "tags": tags,
            "path": str(cfg_file),
            "subdir": None,
        })

    return examples


def _category_from_prefix(name: str) -> str:
    """Derive a filename-prefix category (example, generic, etc.)."""
    if name.startswith("example-") or name == "example":
        return "example"
    if name.startswith("generic-"):
        return "generic"
    if name.startswith("printer-"):
        return "printer"
    if name.startswith("sample-"):
        return "sample"
    if name.startswith("kit-"):
        return "kit"
    return "other"


def _extract_tags(name: str) -> list[str]:
    """Extract searchable tags from a config filename."""
    # Remove prefix
    clean = re.sub(r"^(example|generic|printer|sample|kit)-", "", name)
    # Split on separators
    parts = re.split(r"[-_.]", clean)
    # Remove empty/short parts
    tags = [p for p in parts if len(p) > 1]
    return tags


def fuzzy_match_examples(query: str, examples: list[dict], max_results: int = 20) -> list[dict]:
    """Simple fuzzy matching for example config search."""
    query_lower = query.lower()
    query_parts = query_lower.split()

    scored = []
    for ex in examples:
        score = 0
        name_lower = ex["name"].lower()
        tags_lower = [t.lower() for t in ex.get("tags", [])]

        # Exact name match
        if query_lower == name_lower:
            score += 100
        # Name contains full query
        elif query_lower in name_lower:
            score += 50
        # All query parts found in name or tags
        else:
            all_text = name_lower + " " + " ".join(tags_lower)
            matches = sum(1 for part in query_parts if part in all_text)
            if matches > 0:
                score += (matches / len(query_parts)) * 30

        # Tag matches
        for part in query_parts:
            for tag in tags_lower:
                if part in tag:
                    score += 5
                if part == tag:
                    score += 10

        if score > 0:
            scored.append((score, ex))

    scored.sort(key=lambda x: -x[0])
    return [item[1] for item in scored[:max_results]]
