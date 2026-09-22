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

# Board identification patterns from config filenames and MCU types.
# ORDER IS SPECIFICITY: within a vendor family the model-specific
# patterns MUST precede the family pattern — board_name takes the first
# hit in list order (2026-09-21 audit: family-first ordering let
# "BTT Octopus Pro" be named just "BigTreeTech").
BOARD_PATTERNS = [
    # BigTreeTech models (family catch-all last in this group)
    # Octopus Pro first: the Pro/non-Pro pin maps are NOT compatible
    # (reference header warns a wrong-config mix can enable a heater).
    (r"octopus[ _-]?pro", "BigTreeTech Octopus Pro"),
    (r"octopus", "BigTreeTech Octopus"),
    (r"skr[\s_-]?mini[\s_-]?e3", "BigTreeTech SKR Mini E3"),
    (r"skr[\s_-]?pro", "BigTreeTech SKR Pro"),
    (r"skr[\s_-]?v?1\.[134]", "BigTreeTech SKR v1.x"),
    (r"skr[\s_-]?[23]", "BigTreeTech SKR 2/3"),
    (r"skr[\s_-]?pico", "BigTreeTech SKR Pico"),
    (r"manta", "BigTreeTech Manta"),
    (r"skr[\s_-]?e3", "BigTreeTech SKR E3"),
    (r"bigtreetech|btt", "BigTreeTech"),
    # Creality models (family catch-all last)
    (r"creality[\s_-]?v4\.2\.[71]0?", "Creality v4.2.x"),
    (r"creality", "Creality"),
    # FYSETC models (family catch-all last)
    (r"fysetc[\s_-]?s6", "FYSETC S6"),
    (r"fysetc[\s_-]?cheetah", "FYSETC Cheetah"),
    (r"fysetc[\s_-]?f6", "FYSETC F6"),
    (r"fysetc[\s_-]?spider", "FYSETC Spider"),
    (r"fysetc", "FYSETC"),
    # Duet models (family catch-all last)
    (r"duet[\s_-]?3[\s_-]?6hc", "Duet 3 6HC"),
    (r"duet[\s_-]?3[\s_-]?mini", "Duet 3 Mini"),
    (r"duet[\s_-]?2[\s_-]?maestro", "Duet 2 Maestro"),
    (r"duet[\s_-]?2", "Duet 2"),
    (r"duet", "Duet"),
    # Einsy
    (r"einsy[\s_-]?rambo", "Einsy Rambo"),
    # MKS models (family catch-all last)
    (r"mks[\s_-]?robin[\s_-]?nano", "MKS Robin Nano"),
    (r"mks[\s_-]?robin", "MKS Robin"),
    (r"mks[\s_-]?gen[\s_-]?l", "MKS Gen L"),
    (r"mks[\s_-]?sgen", "MKS SGen"),
    (r"mks", "MKS"),
    # Mellow models (family catch-all last)
    (r"mellow[\s_-]?fly", "Mellow Fly"),
    (r"mellow", "Mellow"),
    # LDO models (family catch-all last)
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

    # Expander: MULTIPLE extra steppers but no printer section. One
    # stepper alone proves nothing — fragments, includes-in-progress and
    # truncated pastes all hit this shape, and a confident 'expander'
    # guess on them misleads the model (2026-09-21 audit; kickback
    # doctrine: never over-claim).
    if stepper_count >= 2 and not has_printer and not has_extruder:
        return BOARD_TYPE_EXPANDER, 0.7

    return BOARD_TYPE_OTHER, 0.0


def detect_board_from_config(config: ConfigFile, reference_dir: Optional[Path] = None) -> dict:
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

    # Gather text to search: filename, comments, serial paths, all text.
    # The filename carries the board model for reference configs
    # (generic-bigtreetech-octopus-*.cfg) whose contents don't.
    search_text = config.filename.lower() + "\n"
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

    # Board detection: report EVERY match so the caller sees the full
    # evidence chain; board_name is the first hit in list order, which is
    # specificity-ordered (model patterns before family catch-alls).
    for pattern, name in BOARD_PATTERNS:
        if re.search(pattern, search_text, re.IGNORECASE):
            if result["board_name"] == "Unknown":
                result["board_name"] = name
            result["matches"].append(f"Board pattern: {name}")
            result["confidence"] = max(result["confidence"], 0.6)

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

    # ── Reference pin-layout cross-check (opt-in) ─────────────────
    # Compare the config's pin fingerprint against the bundled
    # reference library. A clear single winner (no near-twin within the
    # tie window) can establish the board NAME even when the text never
    # says it; weaker overlaps are surfaced as candidates for the model
    # to read up, never adopted.
    if reference_dir is not None:
        type_pool = (
            result["board_type"]
            if result["board_type"] != BOARD_TYPE_OTHER
            else None
        )
        ref_matches = match_reference_configs(
            config.raw_text, reference_dir, board_type=type_pool
        )
        if ref_matches:
            result["reference_matches"] = ref_matches
            best = ref_matches[0]
            runner_up = ref_matches[1]["score"] if len(ref_matches) > 1 else 0.0
            ref_name = _name_from_reference_filename(best["filename"])
            if (
                best["score"] >= MATCH_ADOPT
                and ref_name
                and best["score"] - runner_up >= MATCH_TIE_WINDOW
            ):
                if result["board_name"] == "Unknown":
                    result["board_name"] = ref_name
                    # Pin layout identifies the board but not the chip
                    # actually flashed on it — capped below name+chip.
                    result["confidence"] = max(result["confidence"], 0.8)
                result["matches"].append(
                    f"Reference layout: {best['filename']} "
                    f"(similarity {best['score']})"
                )
            else:
                listed = ", ".join(
                    f"{m['filename']} ({m['score']})" for m in ref_matches[:3]
                )
                result["matches"].append(
                    f"Reference layout candidates (no clear winner): {listed}"
                )

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


# ── Reference-config pin-layout matching ─────────────────────────────
# The regex pass only sees boards whose NAME appears in the text. Most
# real user configs never name their board, but their PIN LAYOUT is a
# literal fingerprint of it: Klipper's reference configs under
# reference/config/ pin every supported board, so comparing pin tokens
# identifies the board even when nothing says its name (2026-09-21).
# Calibrated on the real 280-file library: identical file = 1.0,
# near-twin variants (Octopus vs Octopus Pro) = 0.95, anonymous
# fragments of one real board = ~0.36 (top-up evidence only), unrelated
# shapes < 0.15.

# score >= MATCH_ADOPT -> adopt the layout-derived name (still reported
# as a match, with evidence); MATCH_CANDIDATE..ADOPT -> name nothing,
# list as candidates. Ties within MATCH_TIE_WINDOW never pick a single
# model (near-twin boards must not be silently conflated).
MATCH_ADOPT = 0.6
MATCH_CANDIDATE = 0.3
MATCH_TIE_WINDOW = 0.05

_SIG_PIN_KEY_RE = re.compile(r"(^|_)pin$")
_SIG_HEADER_RE = re.compile(r"^\[([^\]]+)\]")

# path -> (mtime, signature); reference configs are immutable in
# practice, so a plain mtime-keyed dict is enough.
_sig_cache: dict[str, tuple[float, frozenset[str]]] = {}


def _normalize_pin_value(value: str) -> str:
    value = value.strip().lstrip("!~^").strip()
    if ":" in value:
        value = value.rsplit(":", 1)[-1]
    return value.upper()


def extract_pin_signature(text: str) -> frozenset[str]:
    """Fingerprint pin assignments as 'sectionroot.key=VALUE' tokens.

    Raw-text scan (not the parser) — the reference library is large and
    mostly stock Klipper shapes; commented lines don't pin anything, so
    they're skipped with the rest. Value normalization folds the
    negation/pull flags and MCU-name prefix ('!PB15', 'EBBCan:PB12' ->
    'PB12') because layouts, not wiring style, are what we identify.
    """
    sig: set[str] = set()
    section_root = "mcu"
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        header = _SIG_HEADER_RE.match(line)
        if header:
            first = header.group(1).split()
            section_root = first[0].split("_")[0] if first else "mcu"
            continue
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        if _SIG_PIN_KEY_RE.search(key):
            sig.add(f"{section_root}.{key}={_normalize_pin_value(value)}")
    return frozenset(sig)


def _file_signature(path: Path) -> frozenset[str]:
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return frozenset()
    key = str(path)
    cached = _sig_cache.get(key)
    if cached is None or cached[0] != mtime:
        try:
            sig = extract_pin_signature(path.read_text(errors="replace"))
        except OSError:
            sig = frozenset()
        _sig_cache[key] = (mtime, sig)
        return sig
    return cached[1]


def _name_from_reference_filename(filename: str) -> str:
    lowered = filename.lower()
    for pattern, name in BOARD_PATTERNS:
        if re.search(pattern, lowered, re.IGNORECASE):
            return name
    return ""


def match_reference_configs(
    text: str,
    reference_dir: Path,
    board_type: Optional[str] = None,
    top: int = 3,
) -> list[dict]:
    """Rank reference configs by pin-layout similarity to ``text``.

    Returns up to ``top`` dicts {filename, path, subdir, board_type,
    score} with score > MATCH_CANDIDATE, best first. When ``board_type``
    is a confident detection, only that type's directory is searched
    (a toolhead snippet must not match mainboard layouts); otherwise
    every typed directory is in the pool.
    """
    sig = extract_pin_signature(text)
    if not sig:
        return []

    scored: list[tuple[float, dict]] = []
    for subdir_name, subdir_type in BOARD_TYPE_DIRS.items():
        if board_type and board_type != subdir_type:
            continue
        subdir = reference_dir / "config" / subdir_name
        if not subdir.is_dir():
            continue
        for cfg_file in sorted(subdir.glob("*.cfg")):
            ref_sig = _file_signature(cfg_file)
            if not ref_sig:
                continue
            overlap = len(sig & ref_sig)
            if overlap == 0:
                continue
            score = 2 * overlap / (len(sig) + len(ref_sig))
            if score > MATCH_CANDIDATE:
                scored.append((score, {
                    "filename": cfg_file.name,
                    "path": str(cfg_file),
                    "subdir": subdir_name,
                    "board_type": subdir_type,
                    "score": round(score, 2),
                }))

    scored.sort(key=lambda item: -item[0])
    return [item[1] for item in scored[:top]]
