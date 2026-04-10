"""Board type auto-detection from config files and reference configs."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

from parser.config_parser import ConfigFile


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


def detect_board_from_config(config: ConfigFile) -> dict:
    """Attempt to detect the board type from a parsed config file.

    Returns a dict with:
        - board_name: Detected board name or "Unknown"
        - mcu_chip: Detected MCU chip or "Unknown"
        - confidence: float 0-1
        - matches: list of matching patterns
    """
    result = {
        "board_name": "Unknown",
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

    return result


def get_available_examples(reference_dir: Path) -> list[dict]:
    """List all available example configs from the reference directory."""
    config_dir = reference_dir / "config"
    if not config_dir.exists():
        return []

    examples = []
    for cfg_file in sorted(config_dir.glob("*.cfg")):
        name = cfg_file.stem
        category = "other"
        if name.startswith("example-"):
            category = "example"
        elif name.startswith("generic-"):
            category = "generic"
        elif name.startswith("printer-"):
            category = "printer"
        elif name.startswith("sample-"):
            category = "sample"
        elif name.startswith("kit-"):
            category = "kit"

        # Extract board-relevant tags for fuzzy search
        tags = _extract_tags(name)

        examples.append({
            "filename": cfg_file.name,
            "name": name,
            "category": category,
            "tags": tags,
            "path": str(cfg_file),
        })

    return examples


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
