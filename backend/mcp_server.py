"""
Embedded Model Context Protocol (MCP) server for Klipper-Wire-Configurator.

Provides AI agents with tools to search/read Klipper documentation, validate
config snippets, look up section schemas, detect boards, and more.

Two usage modes:
  1. Embedded inside the FastAPI process (default) — zero extra RAM.
     Call handle_jsonrpc() directly or post to /api/mcp.
  2. Standalone stdio server for external MCP clients:
         python -m backend.mcp_server
     (Claude Desktop, pi, VS Code, etc. connect via subprocess.)

No extra dependencies. No ML. No git clone. Docs are read from the bundled
reference directory.
"""

from __future__ import annotations

import json
import os
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

# ── Paths ────────────────────────────────────────────────────────────

BACKEND_DIR = Path(__file__).parent
REFERENCE_DIR = BACKEND_DIR.parent / "reference"
KLIPPER_DOCS_DIR = REFERENCE_DIR / "reference_docs" / "klipper_docs"
DOC_CATALOG_PATH = KLIPPER_DOCS_DIR
CONFIG_REFERENCE_PATH = KLIPPER_DOCS_DIR / "Config_Reference.md"
GCODE_MACRO_SUMMARY_PATH = KLIPPER_DOCS_DIR / "Klipper_GCode_Macro_AI_Summary.md"
DOCS_SUMMARY_PATH = KLIPPER_DOCS_DIR / "Klipper_Docs_AI_Summary.md"
CONFIG_EXAMPLES_DIR = REFERENCE_DIR / "config"
# The system path for Klipper configs (e.g. /home/pi/.klipper/config)
# Can be overridden via KLIPPER_CONFIG_PATH environment variable.
SYSTEM_CONFIG_PATH = Path(os.environ.get("KLIPPER_CONFIG_PATH", "/home/pi/.klipper/config"))
# Local fallback directory for imported configs when not running on a Pi.
LOCAL_CONFIGS_DIR = BACKEND_DIR / "user_configs"


# ── Constants ─────────────────────────────────────────────────────────

MCP_PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "klipper-wire-configurator"
SERVER_VERSION = "1.0.0"
MAX_SEARCH_RESULTS = 10
MAX_READ_CHARS = 16_000
SNIPPET_CHARS = 300
STOP_WORDS = frozenset({
    "a", "an", "and", "are", "as", "at", "be", "by", "can", "cfg",
    "config", "configuration", "do", "for", "from", "has", "have",
    "help", "how", "i", "if", "in", "is", "it", "its", "klipper",
    "me", "my", "not", "of", "on", "or", "please", "printer", "set",
    "settings", "show", "so", "tell", "that", "the", "this", "to",
    "use", "was", "what", "when", "where", "which", "who", "will",
    "with", "would", "you", "your",
})

CONFIG_SECTION_HEADER_RE = re.compile(r"^### \[([^\]]+)\]\s*$", re.MULTILINE)
CONFIG_ALIAS_RE = re.compile(r"^\[([^\]]+)\]\s*$", re.MULTILINE)
HEADING_RE = re.compile(r"^##?\s+(.+)$", re.MULTILINE)

# Word-level synonyms mapping common human spellings to canonical config
# terms. Applied symmetrically at index + query time so both directions
# converge (a doc containing "end_stop" and a query "endstop" both emit
# [end, stop]). Keep entries minimal and justify each from a real gap.
ALIAS_MAP: dict[str, tuple[str, ...]] = {
    "endstop": ("end_stop", "end-stop", "end stop"),
    "bltouch": ("bl_touch", "bl-touch", "bl touch"),
    "zoff": ("z_offset", "z-offset", "z offset"),
    "z_off": ("z_offset",),
}

# Common irregular plurals that naive suffix-stripping gets wrong.
_IRREGULAR_PLURALS = {
    "axes": "axis",
    "feet": "foot",
    "teeth": "tooth",
}


def _fold_plural(word: str) -> str:
    """Best-effort singular form for retrieval (symmetric, ranking-only)."""
    if len(word) < 5:
        return word
    if word in _IRREGULAR_PLURALS:
        return _IRREGULAR_PLURALS[word]
    if word.endswith("ies") and len(word) > 5:
        return word[:-3] + "y"
    if word.endswith(("ses", "xes", "zes", "ches", "shes")):
        return word[:-2]
    if word.endswith("s") and not word.endswith(("ss", "us", "is")):
        return word[:-1]
    return word


# ══════════════════════════════════════════════════════════════════════
#  Search Engine
# ══════════════════════════════════════════════════════════════════════

class DocIndex:
    """Lightweight full-text index over bundled Klipper markdown docs."""

    def __init__(self, docs_dir: Path = DOC_CATALOG_PATH) -> None:
        self.docs_dir = docs_dir
        self._docs: dict[str, str] = {}          # filename stem → full content
        self._headings: dict[str, list[str]] = {}  # filename stem → heading texts
        self._inverted: dict[str, list[tuple[str, int]]] = {}  # word → [(stem, count)]
        self._ready = False

    def load(self) -> None:
        """Scan the docs directory and build the index."""
        self._docs.clear()
        self._headings.clear()
        self._inverted.clear()

        if not self.docs_dir.is_dir():
            return

        for path in sorted(self.docs_dir.glob("*.md")):
            stem = path.stem
            try:
                content = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            self._docs[stem] = content

            # Extract headings
            self._headings[stem] = [
                m.group(1).strip() for m in HEADING_RE.finditer(content)
            ]

            # Build inverted index
            tokens = self._tokenize(content)
            for word, count in Counter(tokens).most_common():
                self._inverted.setdefault(word, []).append((stem, count))

        self._ready = True

    def is_ready(self) -> bool:
        return self._ready

    def get_doc_count(self) -> int:
        return len(self._docs)

    def list_docs(self) -> list[dict[str, Any]]:
        """Return metadata for all indexed docs."""
        result: list[dict[str, Any]] = []
        for stem, content in self._docs.items():
            headings = self._headings.get(stem, [])
            result.append({
                "id": stem,
                "filename": f"{stem}.md",
                "headings": headings[:20],
                "size_bytes": len(content),
                "has_config_sections": any(
                    CONFIG_SECTION_HEADER_RE.findall(content)
                ),
            })
        return result

    def get_doc(self, stem: str) -> str | None:
        """Return full doc content by filename stem."""
        return self._docs.get(stem)

    def read_doc(self, stem: str, offset: int = 0, limit: int = MAX_READ_CHARS) -> dict[str, Any] | None:
        """Return a slice of a document."""
        content = self.get_doc(stem)
        if content is None:
            return None
        total = len(content)
        return {
            "id": stem,
            "filename": f"{stem}.md",
            "content": content[offset:offset + limit],
            "offset": offset,
            "total_chars": total,
            "truncated": (offset + limit) < total,
        }

    def search(self, query: str, limit: int = MAX_SEARCH_RESULTS) -> list[dict[str, Any]]:
        """Search indexed docs by query text. Returns ranked results with snippets."""
        if not self._ready or not query.strip():
            return []

        query_tokens = set(self._tokenize(query))
        if not query_tokens:
            return []

        # Score documents by word overlap
        scores: dict[str, float] = {}
        for word in query_tokens:
            for stem, count in self._inverted.get(word, []):
                # log-scaled TF, capped
                scores[stem] = scores.get(stem, 0.0) + min(1.0 + (count / 5.0), 5.0)

        # Boost filename matches (exact or substring)
        query_lower = query.lower().replace(" ", "_").replace("-", "_")
        for stem in self._docs:
            stem_lower = stem.lower()
            if stem_lower == query_lower:
                scores[stem] = scores.get(stem, 0.0) + 100.0
            elif query_lower in stem_lower or stem_lower in query_lower:
                scores[stem] = scores.get(stem, 0.0) + 20.0

        # Boost heading matches
        query_words = set(query_lower.split("_"))
        for stem, headings in self._headings.items():
            heading_text = " ".join(headings).lower()
            heading_hits = sum(1 for w in query_words if w in heading_text)
            if heading_hits:
                scores[stem] = scores.get(stem, 0.0) + heading_hits * 10.0

        if not scores:
            return []

        # Sort by score descending
        ranked = sorted(scores.items(), key=lambda x: -x[1])

        results: list[dict[str, Any]] = []
        for stem, score in ranked[:limit]:
            content = self._docs[stem]
            snippet = self._make_snippet(content, query)
            results.append({
                "id": stem,
                "filename": f"{stem}.md",
                "score": round(score, 1),
                "snippet": snippet,
                "size_bytes": len(content),
            })

        return results

    def get_config_reference_section(self, section_name: str) -> dict[str, Any] | None:
        """Extract a named section from Config_Reference.md."""
        content = self._docs.get("Config_Reference")
        if content is None:
            return None

        # Normalise the section name
        name_variants = {
            section_name.lower(),
            section_name.lower().replace("_", " "),
            section_name.lower().replace(" ", "_"),
            section_name.lower().replace("-", "_"),
        }

        sections = list(CONFIG_SECTION_HEADER_RE.finditer(content))
        for idx, match in enumerate(sections):
            header_name = match.group(1).strip()
            if header_name.lower() in name_variants:
                start = match.start()
                end = sections[idx + 1].start() if idx + 1 < len(sections) else len(content)
                section_text = content[start:end].strip()

                # Extract aliases from the section body
                aliases = [header_name]
                aliases.extend(
                    m.group(1).strip()
                    for m in CONFIG_ALIAS_RE.finditer(section_text)
                )
                # The section body often repeats the header as a bare [name]
                # line; dedupe and drop empties so 'Also known as:' stays clean.
                aliases = list(dict.fromkeys(a for a in aliases if a))

                return {
                    "section": header_name,
                    "content": section_text,
                    "aliases": aliases,
                }

        return None

    def _tokenize(self, text: str) -> list[str]:
        """Split text into word tokens (underscores/hyphens become separators),
        adding folded plurals and alias variants so natural-language queries
        match joined config terms (e.g. "probe offset" -> probe_offset)."""
        tokens: list[str] = []
        for t in re.findall(r"[a-z0-9]{2,}", text.lower()):
            if t in STOP_WORDS or t.isdigit():
                continue
            tokens.append(t)
            folded = _fold_plural(t)
            if folded != t:
                tokens.append(folded)
            for alias in ALIAS_MAP.get(t, ()):
                tokens.extend(
                    a for a in re.findall(r"[a-z0-9]{2,}", alias.lower())
                    if a not in STOP_WORDS and not a.isdigit()
                )
        return tokens

    def _make_snippet(self, content: str, query: str) -> str:
        """Extract a relevant snippet around the first query match."""
        query_lower = query.lower()
        pos = content.lower().find(query_lower)
        if pos < 0:
            # Fall back to first meaningful paragraph
            for word in self._tokenize(query):
                pos = content.lower().find(word)
                if pos >= 0:
                    break

        if pos < 0:
            return content[:SNIPPET_CHARS].strip() + ("..." if len(content) > SNIPPET_CHARS else "")

        start = max(0, pos - SNIPPET_CHARS // 2)
        end = min(len(content), pos + len(query) + SNIPPET_CHARS // 2)

        snippet = content[start:end].strip()
        if start > 0:
            snippet = "..." + snippet
        if end < len(content):
            snippet = snippet + "..."
        return snippet


# ══════════════════════════════════════════════════════════════════════
#  Global index singleton
# ══════════════════════════════════════════════════════════════════════

_index: DocIndex | None = None


def get_index() -> DocIndex:
    """Get or create the shared DocIndex singleton."""
    global _index
    if _index is None:
        _index = DocIndex()
        _index.load()
    return _index


# ══════════════════════════════════════════════════════════════════════
#  MCP Server
# ══════════════════════════════════════════════════════════════════════

class McpServer:
    """
    Minimal MCP server exposing Klipper documentation and config tools.

    Implements the JSON-RPC 2.0 subset required by the Model Context Protocol.
    """

    def __init__(self, index: DocIndex | None = None) -> None:
        self.index = index or get_index()
        self._initialized = False
        self._client_capabilities: dict[str, Any] = {}

    # ── Tool Definitions ──────────────────────────────────────────

    def _list_tools(self) -> list[dict[str, Any]]:
        return [
            {
                "name": "search_klipper_docs",
                "description": (
                    "Search all bundled Klipper documentation by query. "
                    "Returns up to 10 ranked results with source filename, score, and snippet."
                ),
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Search query — keywords, section names, or natural language",
                        },
                        "limit": {
                            "type": "number",
                            "description": "Max results (default 10)",
                            "default": 10,
                        },
                    },
                    "required": ["query"],
                },
            },
            {
                "name": "read_klipper_doc",
                "description": (
                    "Read the full content of a Klipper documentation file by filename "
                    "(with or without .md extension). Supports pagination via offset/limit."
                ),
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "filename": {
                            "type": "string",
                            "description": "Document filename (e.g. 'Config_Reference.md', 'Bed_Mesh', 'G-Codes.md')",
                        },
                        "offset": {
                            "type": "number",
                            "description": "Character offset to start reading from (default 0)",
                            "default": 0,
                        },
                        "limit": {
                            "type": "number",
                            "description": "Max characters to return (default 16000)",
                            "default": MAX_READ_CHARS,
                        },
                    },
                    "required": ["filename"],
                },
            },
            {
                "name": "list_klipper_docs",
                "description": "List all available Klipper documentation files with their headings and metadata.",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                },
            },
            {
                "name": "get_config_reference_section",
                "description": (
                    "Extract a specific configuration section from Config_Reference.md by section name. "
                    "Returns the full section text with all parameters, defaults, and aliases. "
                    "Example section names: 'bed_mesh', 'extruder', 'stepper_x', 'probe', 'heater_fan'"
                ),
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "section_name": {
                            "type": "string",
                            "description": "Klipper config section name (e.g. 'bed_mesh', 'extruder', 'stepper_x')",
                        },
                    },
                    "required": ["section_name"],
                },
            },
            {
                "name": "validate_klipper_config",
                "description": (
                    "Parse and validate a Klipper config snippet. "
                    "Returns structured results: parsed sections with their parameters, "
                    "any errors or warnings, and the raw config text."
                ),
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "config_text": {
                            "type": "string",
                            "description": "Klipper config text (one or more sections with parameters)",
                        },
                        "filename": {
                            "type": "string",
                            "description": "Config filename hint (default: 'printer.cfg')",
                            "default": "printer.cfg",
                        },
                    },
                    "required": ["config_text"],
                },
            },
            {
                "name": "get_section_schema",
                "description": (
                    "Get the supported parameters, types, defaults, and descriptions "
                    "for a Klipper config section type. Use this to find exactly which "
                    "parameters a section supports and what values are valid."
                ),
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "section_type": {
                            "type": "string",
                            "description": "Section type name (e.g. 'extruder', 'bed_mesh', 'heater_fan', 'temperature_sensor')",
                        },
                    },
                    "required": ["section_type"],
                },
            },
            {
                "name": "search_example_configs",
                "description": (
                    "Search bundled example Klipper configurations by board, printer, or feature keyword. "
                    "Returns matching filenames with their category and a preview snippet. "
                    "Use read_example_config to get the full file content."
                ),
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Search query (e.g. 'voron', 'ender3', 'skr mini', 'bltouch', 'adxl345')",
                        },
                        "limit": {
                            "type": "number",
                            "description": "Max results (default 10)",
                            "default": 10,
                        },
                    },
                    "required": ["query"],
                },
            },
            {
                "name": "read_example_config",
                "description": (
                    "Read the full content of a bundled example Klipper config file by filename "
                    "(with or without .cfg extension). "
                    "Use search_example_configs first to find the exact filename."
                ),
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "filename": {
                            "type": "string",
                            "description": "Config filename (e.g. 'generic-bigtreetech-skr-mini-e3-v3.0.cfg', 'printer-voron-2.4-octopus.cfg')",
                        },
                    },
                    "required": ["filename"],
                },
            },
            {
                "name": "search_user_configs",
                "description": (
                    "Search the user's local configuration files (in the 'user_configs' directory). "
                    "Returns matching filenames with a preview snippet."
                ),
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Search query (e.g. 'voron', 'skr', 'bed_mesh')",
                        },
                        "limit": {
                            "type": "number",
                            "description": "Max results (default 10)",
                            "default": 10,
                        },
                    },
                    "required": ["query"],
                },
            },
            {
                "name": "read_user_config",
                "description": (
                    "Read a user configuration file from the 'user_configs' directory. "
                    "Use search_user_configs first to find the exact filename. "
                    "Pass 'section' to read only one section (lean context for edits); "
                    "omit it to read the whole file."
                ),
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "filename": {
                            "type": "string",
                            "description": "Config filename (e.g. 'my_printer.cfg')",
                        },
                        "section": {
                            "type": "string",
                            "description": (
                                "Optional section header to read only that section "
                                "(e.g. 'extruder' or '[gcode_macro FIX_ME]') instead "
                                "of the whole file (partial context)."
                            ),
                        },
                    },
                    "required": ["filename"],
                },
            },
            {
                "name": "detect_board",
                "description": (
                    "Analyze a Klipper config snippet and detect the likely printer "
                    "board type and MCU family from common pin names, MCU definitions, "
                    "and section patterns."
                ),
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "config_text": {
                            "type": "string",
                            "description": "Klipper config text containing [mcu] or pin definitions",
                        },
                    },
                    "required": ["config_text"],
                },
            },
            {
                "name": "calculate_rotation_distance",
                "description": (
                    "Calculate rotation_distance for a Klipper stepper config. "
                    "Supports three methods: leadscrew (pitch + starts), belt-driven "
                    "(pulley teeth + belt pitch), or deriving from existing steps_per_mm. "
                    "Returns the exact rotation_distance value with the formula used."
                ),
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "method": {
                            "type": "string",
                            "enum": ["leadscrew", "belt", "from_steps_per_mm"],
                            "description": "Calculation method: 'leadscrew' for Z leadscrews, 'belt' for belt-driven axes, 'from_steps_per_mm' if you already know steps_per_mm",
                        },
                        "pitch": {
                            "type": "number",
                            "description": "Leadscrew pitch in mm per rotation (e.g. 2 for a standard 2mm pitch leadscrew). Required for 'leadscrew' method.",
                        },
                        "starts": {
                            "type": "number",
                            "description": "Number of leadscrew starts (default: 1). Most leadscrews are single-start. A 4-start leadscrew with 8mm pitch would have starts=4, pitch=2.",
                        },
                        "pulley_teeth": {
                            "type": "number",
                            "description": "Number of teeth on the pulley attached to the motor. Required for 'belt' method.",
                        },
                        "belt_pitch": {
                            "type": "number",
                            "description": "Belt pitch in mm (default: 2 for GT2 belts). Required for 'belt' method.",
                        },
                        "motor_steps": {
                            "type": "number",
                            "description": "Motor steps per revolution (default: 200 for NEMA17 steppers). Used with 'from_steps_per_mm' method.",
                        },
                        "microsteps": {
                            "type": "number",
                            "description": "Microsteps configured in the stepper driver (e.g. 16). Used with 'from_steps_per_mm' method.",
                        },
                        "steps_per_mm": {
                            "type": "number",
                            "description": "Current steps_per_mm value to derive rotation_distance from. Required for 'from_steps_per_mm' method.",
                        },
                    },
                    "required": ["method"],
                },
            },
            {
                "name": "generate_macro_template",
                "description": (
                    "Generate a Klipper gcode_macro template for common operations. "
                    "Returns a complete, ready-to-use macro section with proper "
                    "save/restore state, error handling, and Klipper-standard gcode. "
                    "Supported macros: PRINT_START, PRINT_END, PAUSE, RESUME, CANCEL_PRINT."
                ),
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "macro_name": {
                            "type": "string",
                            "enum": ["PRINT_START", "PRINT_END", "PAUSE", "RESUME", "CANCEL_PRINT"],
                            "description": "Which macro template to generate",
                        },
                        "include_bed_mesh": {
                            "type": "boolean",
                            "description": "Whether PRINT_START should include BED_MESH_CALIBRATE (default: false). Only applies to PRINT_START.",
                        },
                        "park_x": {
                            "type": "number",
                            "description": "X position to park the toolhead during PAUSE/PRINT_END (default: 0)",
                        },
                        "park_y": {
                            "type": "number",
                            "description": "Y position to park the toolhead during PAUSE/PRINT_END (default: 0)",
                        },
                        "park_z": {
                            "type": "number",
                            "description": "Z lift amount in mm during PAUSE (default: 10)",
                        },
                        "retract_distance": {
                            "type": "number",
                            "description": "Filament retract distance in mm during PAUSE/PRINT_END (default: 5)",
                        },
                        "retract_speed": {
                            "type": "number",
                            "description": "Filament retract speed in mm/s (default: 40)",
                        },
                    },
                    "required": ["macro_name"],
                },
            },
            {
                "name": "validate_macro",
                "description": (
                    "Validate a Klipper gcode_macro for common structural issues. "
                    "Checks syntax, save/restore state pairing, temperature commands, "
                    "macro structure, and potential problems. When bed dimensions "
                    "are supplied (bed_x/bed_y/max_z), also checks moves for "
                    "out-of-bounds targets and no-go zone hits (including path "
                    "crossings between consecutive moves), mirroring the Macro "
                    "Designer's geometry. Does NOT simulate full machine state — "
                    "use the Macro Designer in the app for complete simulation."
                ),
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "macro_text": {
                            "type": "string",
                            "description": "The full macro text including the [gcode_macro ...] header through to the end of the gcode section",
                        },
                        "bed_x": {
                            "type": "number",
                            "description": "Bed width in mm (max X). Required to enable move-bounds and no-go zone checks.",
                        },
                        "bed_y": {
                            "type": "number",
                            "description": "Bed depth in mm (max Y). Required to enable move-bounds and no-go zone checks.",
                        },
                        "max_z": {
                            "type": "number",
                            "description": "Maximum Z travel in mm (default 200).",
                        },
                        "probe_offset_x": {
                            "type": "number",
                            "description": "Probe X offset in mm; expands the allowed X margin by 1.5x.",
                        },
                        "probe_offset_y": {
                            "type": "number",
                            "description": "Probe Y offset in mm; expands the allowed Y margin by 1.5x.",
                        },
                        "no_go_zones": {
                            "type": "array",
                            "description": "List of rectangular no-go zones, each {x, y, width, height} in mm. Endpoints inside a zone or paths crossing one are flagged.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "x": {"type": "number"},
                                    "y": {"type": "number"},
                                    "width": {"type": "number"},
                                    "height": {"type": "number"},
                                },
                            },
                        },
                    },
                    "required": ["macro_text"],
                },
            },
        ]

    # ── Tool Handlers ─────────────────────────────────────────────

    def _call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """Route a tool call to the appropriate handler."""
        handlers: dict[str, Any] = {
            "search_klipper_docs": self._handle_search,
            "read_klipper_doc": self._handle_read,
            "list_klipper_docs": self._handle_list_docs,
            "get_config_reference_section": self._handle_config_section,
            "validate_klipper_config": self._handle_validate,
            "get_section_schema": self._handle_schema,
            "search_example_configs": self._handle_search_examples,
            "read_example_config": self._handle_read_example_config,
            "search_user_configs": self._handle_search_user_configs,
            "read_user_config": self._handle_read_user_config,
            "detect_board": self._handle_detect_board,
            "calculate_rotation_distance": self._handle_calculate_rotation_distance,
            "generate_macro_template": self._handle_generate_macro_template,
            "validate_macro": self._handle_validate_macro,
        }

        handler = handlers.get(name)
        if handler is None:
            return self._error(-32601, f"Unknown tool: {name}")

        try:
            result = handler(self._coerce_args(arguments))
            return self._text_result(result)
        except Exception as exc:
            return self._error(-32603, f"Tool '{name}' failed: {exc}")

    def _coerce_args(self, args: dict[str, Any]) -> dict[str, Any]:
        """Coerce numeric- and boolean-looking strings to typed values.

        Text-protocol tool calls (```tool JSON blocks, <|tool_call|> native
        tokens) arrive as regex-parsed strings even for numeric parameters.
        Handlers that do arithmetic would otherwise raise TypeError (e.g.
        `'20' <= 0`), and `"false"` would be truthy. Native function-calling
        payloads already carry proper types, so this is a no-op for them.
        """
        coerced: dict[str, Any] = {}
        for key, value in args.items():
            if isinstance(value, str):
                stripped = value.strip()
                if re.fullmatch(r"-?\d+", stripped):
                    coerced[key] = int(stripped)
                elif re.fullmatch(r"-?\d*\.\d+", stripped):
                    coerced[key] = float(stripped)
                elif stripped.lower() in ("true", "false"):
                    coerced[key] = stripped.lower() == "true"
                else:
                    coerced[key] = value
            else:
                coerced[key] = value
        return coerced

    def _handle_search(self, args: dict[str, Any]) -> str:
        query = args.get("query", "").strip()
        limit = min(int(args.get("limit", MAX_SEARCH_RESULTS)), 20)

        if not query:
            return "Please provide a search query."

        results = self.index.search(query, limit=limit)
        if not results:
            return f'No results found for "{query}". Try different keywords or use list_klipper_docs to browse available files.'

        lines: list[str] = [f"Search results for: {query}\n"]
        for r in results:
            lines.append(f"## {r['filename']}  (score: {r['score']})")
            lines.append(f"{r['snippet']}\n")

        return "\n".join(lines)

    def _handle_read(self, args: dict[str, Any]) -> str:
        raw = args.get("filename", "").strip()
        if not raw:
            return "Please provide a filename."

        stem = Path(raw).stem  # strips .md if present
        offset = int(args.get("offset", 0))
        limit = min(int(args.get("limit", MAX_READ_CHARS)), 64_000)

        result = self.index.read_doc(stem, offset=offset, limit=limit)
        if result is None:
            # Try a partial match
            matches = [s for s in self.index._docs if stem.lower() in s.lower()]
            if not matches:
                return f'Document "{raw}" not found. Use list_klipper_docs to see available files.'
            result = self.index.read_doc(matches[0], offset=offset, limit=limit)
            if result is None:
                return f'Document not found.'

        header = f"# {result['filename']}\n"
        if result['offset'] > 0:
            header += f"(characters {result['offset']}-{result['offset'] + len(result['content'])} of {result['total_chars']})\n"
        else:
            header += f"({result['total_chars']} total characters)\n"

        content = header + "\n" + result["content"]

        if result["truncated"]:
            content += f"\n\n[... Content truncated. Use offset={result['offset'] + limit}&limit={limit} to read the next section.]"

        return content

    def _handle_list_docs(self, args: dict[str, Any]) -> str:
        docs = self.index.list_docs()
        if not docs:
            return "No documentation files found."

        lines: list[str] = [
            f"# Klipper Documentation ({len(docs)} files)\n",
        ]
        for d in docs:
            config_tag = " [has config sections]" if d["has_config_sections"] else ""
            heading_count = len(d["headings"])
            lines.append(
                f"- **{d['filename']}**  ({d['size_bytes']:,} bytes, {heading_count} headings){config_tag}"
            )

        return "\n".join(lines)

    def _handle_config_section(self, args: dict[str, Any]) -> str:
        # Accept both `section` and `section_name` — small local models often
        # guess the shorter key when the prompt only carries a one-line snippet.
        section = str(args.get("section_name") or args.get("section") or "").strip()
        if not section:
            return "Please provide a section name."

        result = self.index.get_config_reference_section(section)
        if result is None:
            # Fall back to search
            results = self.index.search(f"[{section}]", limit=3)
            if results:
                return (
                    f"Section '[{section}]' not found in Config_Reference.md. "
                    f"Related documents found:\n\n"
                    + "\n\n".join(
                        f"**{r['filename']}** (score {r['score']})\n{r['snippet']}"
                        for r in results
                    )
                )
            return (
                f'Section "[{section}]" not found in Config_Reference.md. '
                f"Use search_klipper_docs to find relevant documentation, or "
                f"use get_section_schema to look up supported section types."
            )

        content = result["content"]
        aliases = result["aliases"]
        alias_line = f"Also known as: {', '.join(a for a in aliases if a != result['section'])}" if len(aliases) > 1 else ""

        return f"# [{result['section']}]\n{alias_line}\n\n{content}" if alias_line else f"# [{result['section']}]\n\n{content}"

    def _handle_validate(self, args: dict[str, Any]) -> str:
        config_text = args.get("config_text", "").strip()
        filename = args.get("filename", "printer.cfg")

        if not config_text:
            return "Please provide config text to validate."

        # Use the app's parser/validator if available, otherwise do basic analysis
        try:
            from parser.config_parser import parse_config
            from parser.validator import validate_config

            parsed = parse_config(config_text, filename)
            validation = validate_config(parsed)

            lines: list[str] = [f"Validation result for: {filename}\n"]

            if validation.errors:
                errors = [e for e in validation.errors if getattr(e, 'severity', 'error') == 'error' or not hasattr(e, 'severity')]
                warnings = [e for e in validation.errors if getattr(e, 'severity', '') == 'warning']

                if errors:
                    lines.append(f"## Errors ({len(errors)})")
                    for err in errors:
                        location = f"[{err.section}] {err.param}" if err.param else f"[{err.section}]"
                        lines.append(f"- {location}: {err.message}")
                    lines.append("")

                if warnings:
                    lines.append(f"## Warnings ({len(warnings)})")
                    for warn in warnings:
                        location = f"[{warn.section}] {warn.param}" if warn.param else f"[{warn.section}]"
                        lines.append(f"- {location}: {warn.message}")
                    lines.append("")

            if not validation.errors:
                lines.append("✅ Config is valid — no errors or warnings.\n")

            sections = parsed if hasattr(parsed, 'sections') else getattr(parsed, 'config', parsed)
            # Show parsed section summary
            if hasattr(parsed, 'sections') and parsed.sections:
                lines.append(f"## Sections ({len(parsed.sections)})")
                for s in parsed.sections:
                    alias_note = f" = {s.section_type}" if hasattr(s, 'section_type') and s.section_type != s.full_header else ""
                    param_count = len(s.params) if hasattr(s, 'params') else 0
                    lines.append(f"- {s.full_header}{alias_note} ({param_count} parameters)")
                lines.append("")

            if hasattr(parsed, 'includes') and parsed.includes:
                lines.append(f"Includes: {', '.join(parsed.includes)}")

            return "\n".join(lines)

        except ImportError:
            # Fallback: basic section/param extraction without parser
            return self._basic_parse(config_text, filename)

    def _basic_parse(self, config_text: str, filename: str) -> str:
        """Simple fallback parse when the full parser is unavailable."""
        lines = config_text.split("\n")
        sections_found: list[str] = []
        current_section: str | None = None
        errors: list[str] = []

        for i, line in enumerate(lines):
            stripped = line.strip()
            # Skip comments and blank lines
            if not stripped or stripped.startswith("#"):
                continue
            # Section header
            m = re.match(r"^\s*\[([^\]]+)\]\s*$", stripped)
            if m:
                current_section = m.group(1).strip()
                sections_found.append(f"[{current_section}]")
                continue
            # Parameter line
            if current_section and "=" in stripped or ":" in stripped:
                continue
            # Lines outside a section before any section is found
            if current_section is None and stripped:
                # Could be a header comment or include
                if stripped.startswith("[include"):
                    sections_found.append(stripped)
                    continue
                errors.append(f"Line {i+1}: content before any section header: {stripped[:60]}")

        result: list[str] = [f"Basic analysis for: {filename}\n"]
        if sections_found:
            result.append(f"Sections found: {', '.join(sections_found)}")
        if errors:
            result.append(f"\nNotes ({len(errors)}):")
            for e in errors:
                result.append(f"- {e}")
        if not sections_found and not errors:
            result.append("No recognizable Klipper sections found.")

        return "\n".join(result)

    def _handle_schema(self, args: dict[str, Any]) -> str:
        section_type = args.get("section_type", "").strip().lower()
        if not section_type:
            return "Please provide a section type."

        try:
            from parser.config_schema import get_section_def

            schema = get_section_def(section_type)
            if not schema:
                return f'No schema found for section type "{section_type}". Available types include: extruder, heater_fan, fan, temperature_sensor, probe, bed_mesh, filament_switch_sensor, gcode_macro, display, etc.'

            lines: list[str] = [
                f"# Section schema: [{section_type}]\n",
                f"**{schema.description}**\n" if hasattr(schema, 'description') and schema.description else "",
            ]

            if hasattr(schema, 'parameters') and schema.parameters:
                lines.append(f"## Parameters ({len(schema.parameters)})")
                for param in schema.parameters:
                    ptype = param.param_type if hasattr(param, 'param_type') else "unknown"
                    default = f"  (default: {param.default})" if hasattr(param, 'default') and param.default else ""
                    desc = param.description if hasattr(param, 'description') and param.description else ""
                    lines.append(f"- **{param.name}**  [{ptype}]{default}")
                    if desc:
                        lines.append(f"  {desc}")
                lines.append("")

            return "\n".join(lines)

        except ImportError:
            return (
                f'Schema lookup for "{section_type}" is not available '
                f"because the full config schema module could not be loaded. "
                f"Use get_config_reference_section or search_klipper_docs instead."
            )

    def _handle_search_examples(self, args: dict[str, Any]) -> str:
        query = args.get("query", "").strip().lower()
        limit = min(int(args.get("limit", 10)), 30)

        if not query:
            return "Please provide a search query."

        examples_dir = CONFIG_EXAMPLES_DIR
        if not examples_dir.is_dir():
            return "Example config directory not found."

        # Scan all .cfg files in the config examples tree
        results: list[dict[str, Any]] = []
        query_terms = query.replace("-", " ").split()

        for cat_dir in sorted(examples_dir.iterdir()):
            if not cat_dir.is_dir():
                continue
            category = cat_dir.name
            for cfg_file in sorted(cat_dir.glob("*.cfg")):
                name = cfg_file.stem
                # Create a searchable text from the file path and name
                search_text = f"{category} {name} {cat_dir.name}".lower().replace("-", " ")
                # Score by number of matching query terms
                score = sum(1 for term in query_terms if term in search_text)
                if score == 0:
                    continue

                # Read first few non-comment lines for a preview snippet
                snippet = ""
                try:
                    text = cfg_file.read_text(encoding="utf-8", errors="replace")
                    content_lines = [
                        l.strip() for l in text.split("\n")
                        if l.strip() and not l.strip().startswith("#")
                    ]
                    snippet = " ".join(content_lines[:5])[:200]
                except OSError:
                    pass

                results.append({
                    "category": category,
                    "filename": cfg_file.name,
                    "score": score,
                    "snippet": snippet,
                    "subcategory": "generic" if name.startswith("generic-") else (
                        "printer" if name.startswith("printer-") or name.startswith("kit-") else "sample"
                    ),
                })

        if not results:
            return f'No example configs matching "{query}". Try different keywords (board name, printer model, etc.).'

        # Sort by score descending, then alphabetically
        results.sort(key=lambda r: (-r["score"], r["category"], r["filename"]))

        lines: list[str] = [f"Example configs matching: {query}\n"]
        for r in results[:limit]:
            lines.append(f"## {r['filename']}  [{r['category']}/{r['subcategory']}]")
            if r["snippet"]:
                lines.append(f"> {r['snippet']}\n")
        lines.append(f"\n{len(results)} match(es) total. Use read_example_config to read the full file.")

        return "\n".join(lines)

    def _handle_read_example_config(self, args: dict[str, Any]) -> str:
        raw = args.get("filename", "").strip()
        if not raw:
            return "Please provide a config filename."

        stem = Path(raw).stem.lower()

        examples_dir = CONFIG_EXAMPLES_DIR
        if not examples_dir.is_dir():
            return "Example config directory not found."

        # Search all .cfg files in the tree
        candidates: list[Path] = []
        for cat_dir in examples_dir.iterdir():
            if not cat_dir.is_dir():
                continue
            for cfg_file in cat_dir.glob("*.cfg"):
                if cfg_file.stem.lower() == stem or cfg_file.name.lower() == raw.lower():
                    candidates.append(cfg_file)

        if not candidates:
            # Try partial match — require ALL query tokens to be present in filename tokens
            query_tokens = set(stem.replace("-", " ").replace("_", " ").split())
            for cat_dir in examples_dir.iterdir():
                if not cat_dir.is_dir():
                    continue
                for cfg_file in cat_dir.glob("*.cfg"):
                    file_tokens = set(cfg_file.stem.lower().replace("-", " ").replace("_", " ").split())
                    if query_tokens and query_tokens <= file_tokens:
                        candidates.append(cfg_file)

        if not candidates:
            return f'Config file "{raw}" not found. Use search_example_configs to find matching files.'

        if len(candidates) > 1:
            names = "\n".join(f"  - {c.name}  [{c.parent.name}]" for c in candidates[:10])
            return f'Multiple configs match "{raw}":\n{names}\n\nPlease specify the exact filename.'

        path = candidates[0]
        try:
            content = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            return f"Error reading {path.name}: {exc}"

        header = f"# {path.name}  ({path.parent.name})\n# {len(content)} bytes\n\n"
        return header + content

    def _handle_search_user_configs(self, args: dict[str, Any]) -> str:
        query = args.get("query", "").strip().lower()
        limit = min(int(args.get("limit", 10)), 30)

        if not query:
            return "Please provide a search query."

        # Collect config files from both the system path and local fallback
        scan_paths: list[Path] = []
        if SYSTEM_CONFIG_PATH.is_dir():
            scan_paths.append(SYSTEM_CONFIG_PATH)
        if LOCAL_CONFIGS_DIR.is_dir():
            scan_paths.append(LOCAL_CONFIGS_DIR)

        results: list[dict[str, Any]] = []
        query_terms = query.replace("-", " ").split()
        seen_filenames: set[str] = set()

        for scan_dir in scan_paths:
            try:
                for cfg_file in sorted(scan_dir.glob("*.cfg")):
                    if cfg_file.name in seen_filenames:
                        continue
                    seen_filenames.add(cfg_file.name)

                    search_text = f"{cfg_file.stem} {cfg_file.name}".lower().replace("-", " ")
                    score = sum(1 for term in query_terms if term in search_text)

                    try:
                        text = cfg_file.read_bytes().decode("utf-8", errors="replace")
                    except OSError:
                        continue

                    if score == 0:
                        # Also check content for keyword matches
                        content_lower = text.lower()
                        content_score = sum(1 for term in query_terms if term in content_lower)
                        if content_score == 0:
                            continue
                        score = content_score * 0.5

                    content_lines = [
                        l.strip() for l in text.split("\n")
                        if l.strip() and not l.strip().startswith("#")
                    ]
                    snippet = " ".join(content_lines[:5])[:200]

                    results.append({
                        "filename": cfg_file.name,
                        "score": round(score, 1),
                        "snippet": snippet,
                    })
            except OSError:
                continue

        if not results:
            return f'No user configs matching "{query}". Try different keywords.'

        results.sort(key=lambda r: (-r["score"], r["filename"]))

        lines: list[str] = [f"User configs matching: {query}\n"]
        for r in results[:limit]:
            lines.append(f"## {r['filename']}")
            if r["snippet"]:
                lines.append(f"> {r['snippet']}\n")
        lines.append(f"\n{len(results)} match(es) total. Use read_user_config to read the full file.")

        return "\n".join(lines)

    def _handle_read_user_config(self, args: dict[str, Any]) -> str:
        raw = args.get("filename", "").strip()
        if not raw:
            return "Please provide a config filename."

        stem = Path(raw).stem.lower()

        # Search both local and system config directories
        scan_paths: list[Path] = []
        if LOCAL_CONFIGS_DIR.is_dir():
            scan_paths.append(LOCAL_CONFIGS_DIR)
        if SYSTEM_CONFIG_PATH.is_dir():
            scan_paths.append(SYSTEM_CONFIG_PATH)

        candidate: Path | None = None

        # First try exact match
        for scan_dir in scan_paths:
            try:
                for cfg_file in sorted(scan_dir.glob("*.cfg")):
                    if cfg_file.name.lower() == raw.lower() or cfg_file.stem.lower() == stem:
                        candidate = cfg_file
                        break
            except OSError:
                continue
            if candidate:
                break

        # If no exact match, try fuzzy match
        if candidate is None:
            query_tokens = set(stem.replace("-", " ").replace("_", " ").split())
            for scan_dir in scan_paths:
                try:
                    for cfg_file in scan_dir.glob("*.cfg"):
                        file_tokens = set(cfg_file.stem.lower().replace("-", " ").replace("_", " ").split())
                        if query_tokens and query_tokens <= file_tokens:
                            candidate = cfg_file
                            break
                except OSError:
                    continue
                if candidate:
                    break

        if candidate is None:
            return f'User config file "{raw}" not found. Use search_user_configs to find matching files.'

        try:
            content = candidate.read_bytes().decode("utf-8", errors="replace")
        except OSError as exc:
            return f"Error reading {candidate.name}: {exc}"

        section = args.get("section", "").strip()

        if section:
            section_text = self._extract_config_section(content, section)
            if section_text is None:
                return (
                    f'Section "{section}" not found in {candidate.name}. '
                    "Use search_user_configs to find the exact filename, or omit "
                    "section to read the whole file."
                )
            result = (
                f"# {candidate.name}  (User Config - section [{section}] partial "
                "context; the file may have more sections)\n\n"
            )
            result += section_text
        else:
            result = f"# {candidate.name}  (User Config)\n# {len(content)} bytes\n\n"
            result += content

        # Append validation results if available (filtered to the requested
        # section when reading partial context).
        try:
            from parser.config_parser import parse_config
            from parser.validator import validate_config

            parsed = parse_config(content, candidate.name)
            validation = validate_config(parsed)

            if hasattr(validation, 'errors') and validation.errors:
                wanted = section.strip().strip("[]").lower() if section else None
                all_issues = list(validation.errors)
                if wanted:
                    all_issues = [
                        e for e in all_issues
                        if str(getattr(e, 'section', '')).strip().strip('[]').lower() == wanted
                    ]
                errors = [
                    e for e in all_issues
                    if getattr(e, 'severity', 'error') == 'error' or not hasattr(e, 'severity')
                ]
                warnings = [
                    e for e in all_issues
                    if getattr(e, 'severity', '') == 'warning'
                ]

                parts = []
                if errors:
                    parts.append(f"## Validation Errors ({len(errors)})")
                    for err in errors:
                        loc = f"[{err.section}]" + (f" {err.param}" if err.param else "")
                        parts.append(f"- {loc}: {err.message}")
                if warnings:
                    parts.append(f"## Validation Warnings ({len(warnings)})")
                    for warn in warnings:
                        loc = f"[{warn.section}]" + (f" {warn.param}" if warn.param else "")
                        parts.append(f"- {loc}: {warn.message}")
                if errors or warnings:
                    result += "\n\n---\n" + "\n".join(parts)
        except ImportError:
            pass  # Parser not available

        return result

    def _extract_config_section(self, content: str, section_name: str) -> str | None:
        """Return the raw text of one config section: banner comments above the
        header through the last line before the next section header.

        Case-insensitive; accepts 'name' or '[name]'. Mirrors the frontend's
        extractSectionText so tool reads and edit-path section targeting agree.
        """
        wanted = section_name.strip().strip("[]").lower()
        lines = content.splitlines()
        header_index: int | None = None
        for i, line in enumerate(lines):
            m = re.match(r"^\s*\[([^\]]+)\]\s*$", line)
            if m and m.group(1).strip().lower() == wanted:
                header_index = i
                break
        if header_index is None:
            return None

        end_index = len(lines)
        for i in range(header_index + 1, len(lines)):
            if re.match(r"^\s*\[([^\]]+)\]\s*$", lines[i]):
                end_index = i
                break

        # Walk back over blank + comment lines above the header (banner
        # comments and separators belong to the section visually).
        start_index = header_index
        while start_index > 0:
            previous = lines[start_index - 1].strip()
            if previous == "" or previous.startswith("#"):
                start_index -= 1
            else:
                break

        return "\n".join(lines[start_index:end_index])

    def _handle_detect_board(self, args: dict[str, Any]) -> str:
        config_text = args.get("config_text", "").strip()
        if not config_text:
            return "Please provide config text to analyse."

        try:
            from parser.config_parser import parse_config
            from services.board_detector import detect_board_from_config

            parsed = parse_config(config_text, "analysis.cfg")
            board_info = detect_board_from_config(parsed)

            lines: list[str] = ["## Board Detection Results\n"]
            if isinstance(board_info, dict):
                for key, value in board_info.items():
                    if value:
                        lines.append(f"- **{key}**: {value}")
            else:
                lines.append(str(board_info))

            return "\n".join(lines) if len(lines) > 1 else "No specific board detected. The config may use generic MCU definitions."

        except ImportError:
            # Basic heuristics
            mcu_match = re.search(r"\[mcu(?:\s+[^\]]+)?\]", config_text)
            if mcu_match:
                return f"MCU section detected: {mcu_match.group(0)}"

            pin_matches = re.findall(r"^\s*(.+)_pin\s*[:=]", config_text, re.MULTILINE)
            if pin_matches:
                return f"Pin references found: {', '.join(set(pin_matches))}"

            return "Could not detect board type from the provided config text."

    def _handle_calculate_rotation_distance(self, args: dict[str, Any]) -> str:
        """Calculate rotation_distance for a Klipper stepper."""
        method = args.get("method", "").strip()
        if not method:
            return "Please specify a calculation method: leadscrew, belt, or from_steps_per_mm."

        if method == "leadscrew":
            pitch = args.get("pitch")
            starts = args.get("starts", 1)
            if not pitch or pitch <= 0:
                return "Please provide a valid leadscrew pitch (e.g. pitch=2 for a 2mm pitch leadscrew)."
            if not starts or starts <= 0:
                return "Number of starts must be a positive number."
            result = round(float(pitch) * float(starts), 4)
            return (
                f"## rotation_distance: {result}\n\n"
                f"Use this value exactly in your answer — do NOT recalculate.\n\n"
                f"Formula: rotation_distance = leadscrew_pitch × number_of_starts\n"
                f"  {float(pitch)} × {float(starts)} = {result}\n\n"
                f"Example [stepper_z] entry:\n"
                f"```\n"
                f"rotation_distance: {result}\n"
                f"```"
            )

        if method == "belt":
            pulley_teeth = args.get("pulley_teeth")
            belt_pitch = args.get("belt_pitch", 2)
            if not pulley_teeth or pulley_teeth <= 0:
                return "Please provide the number of pulley teeth (e.g. pulley_teeth=20 for a 20-tooth GT2 pulley)."
            if not belt_pitch or belt_pitch <= 0:
                return "Belt pitch must be a positive number (default 2 for GT2 belts)."
            result = round(float(pulley_teeth) * float(belt_pitch), 4)
            return (
                f"## rotation_distance: {result}\n\n"
                f"Use this value exactly in your answer — do NOT recalculate.\n\n"
                f"Formula: rotation_distance = pulley_teeth × belt_pitch\n"
                f"  {float(pulley_teeth)} × {float(belt_pitch)} = {result}\n\n"
                f"Example [stepper_x] or [stepper_y] entry:\n"
                f"```\n"
                f"rotation_distance: {result}\n"
                f"```"
            )

        if method == "from_steps_per_mm":
            steps_per_mm = args.get("steps_per_mm")
            motor_steps = args.get("motor_steps", 200)
            microsteps = args.get("microsteps")
            if not steps_per_mm or steps_per_mm <= 0:
                return "Please provide the current steps_per_mm value (e.g. steps_per_mm=80)."
            if not microsteps or microsteps <= 0:
                return "Please provide the microsteps setting (e.g. microsteps=16 for 1/16 stepping)."
            if not motor_steps or motor_steps <= 0:
                return "Motor steps must be a positive number (default 200 for NEMA17)."
            result = round(float(motor_steps) * float(microsteps) / float(steps_per_mm), 4)
            return (
                f"## rotation_distance: {result}\n\n"
                f"Use this value exactly in your answer — do NOT recalculate.\n\n"
                f"Formula: rotation_distance = motor_steps × microsteps ÷ steps_per_mm\n"
                f"  {float(motor_steps)} × {float(microsteps)} ÷ {float(steps_per_mm)} = {result}\n\n"
                f"Example [stepper_x] entry:\n"
                f"```\n"
                f"rotation_distance: {result}\n"
                f"```"
            )

        return f'Unknown method: "{method}". Use "leadscrew", "belt", or "from_steps_per_mm".'

    # ── Macro Templates ────────────────────────────────────────────

    MACRO_TEMPLATES: dict[str, str] = {
        "PRINT_START": (
            "[gcode_macro PRINT_START]\n"
            "description: Start a print - heat bed, mesh level, heat nozzle, prime\n"
            "gcode:\n"
            "    # Parameters (set by slicer)\n"
            "    {% set BED_TEMP = params.BED|default(60)|int %}\n"
            "    {% set EXTRUDER_TEMP = params.EXTRUDER|default(200)|int %}\n"
            "\n"
            "    # Heat bed first so it can soak while mesh loads\n"
            "    M140 S{BED_TEMP}\n"
            "    M104 S{EXTRUDER_TEMP - 40}  # Pre-heat extruder partway\n"
            "\n"
            "    # Home all axes\n"
            "    G28\n"
            "\n"
            "    # Bed mesh (if configured)\n"
            "    {% if printer.bed_mesh %}\n"
            "        BED_MESH_CALIBRATE\n"
            "    {% endif %}\n"
            "\n"
            "    # Wait for bed to reach target\n"
            "    M190 S{BED_TEMP}\n"
            "\n"
            "    # Heat extruder fully\n"
            "    M109 S{EXTRUDER_TEMP}\n"
            "\n"
            "    # Prime nozzle\n"
            "    G92 E0\n"
            "    G1 X10 Y10 Z0.4 F3000\n"
            "    G1 X200 Y10 Z0.4 E25 F600  # purge line\n"
            "    G1 X200 Y10.5 Z0.4 F3000\n"
            "    G1 X10 Y10.5 Z0.4 E50 F600  # second purge line\n"
            "    G92 E0\n"
            "    G1 E-2 F600  # light retract\n"
            "    G92 E0\n"
        ),
        "PRINT_END": (
            "[gcode_macro PRINT_END]\n"
            "description: End a print - park, retract, turn off heaters, disable motors\n"
            "gcode:\n"
            "    # Retract filament\n"
            "    G91  # relative positioning\n"
            "    G1 E-5 F1800  # retract 5mm\n"
            "    G1 Z10 F300  # lift Z\n"
            "    G90  # absolute positioning\n"
            "\n"
            "    # Park toolhead\n"
            "    {% set PARK_X = params.PARK_X|default(0)|int %}\n"
            "    {% set PARK_Y = params.PARK_Y|default(0)|int %}\n"
            "    G1 X{PARK_X} Y{PARK_Y} F6000\n"
            "\n"
            "    # Turn off heater, bed, fans\n"
            "    M140 S0\n"
            "    M104 S0\n"
            "    M106 S0  # part cooling fan off\n"
            "\n"
            "    # Disable steppers\n"
            "    M84\n"
        ),
        "PAUSE": (
            "[gcode_macro PAUSE]\n"
            "description: Pause the print - park, retract, record position\n"
            "gcode:\n"
            "    {% set PARK_X = params.PARK_X|default(0)|int %}\n"
            "    {% set PARK_Y = params.PARK_Y|default(0)|int %}\n"
            "    {% set LIFT_Z = params.LIFT_Z|default(10)|float %}\n"
            "    {% set RETRACT = params.RETRACT|default(5)|float %}\n"
            "    {% set RETRACT_SPEED = params.RETRACT_SPEED|default(40)|int %}\n"
            "\n"
            "    # Save current position\n"
            "    SAVE_GCODE_STATE NAME=PAUSE_STATE\n"
            "\n"
            "    # Retract to prevent ooze\n"
            "    G91\n"
            "    G1 E-{RETRACT} F{RETRACT_SPEED * 60}\n"
            "    G90\n"
            "\n"
            "    # Lift Z to avoid knocking print\n"
            "    G91\n"
            "    G1 Z{LIFT_Z} F300\n"
            "    G90\n"
            "\n"
            "    # Park toolhead\n"
            "    G1 X{PARK_X} Y{PARK_Y} F6000\n"
            "\n"
            "    # Optionally turn off extruder heater\n"
            "    M104 S0\n"
            "\n"
            "    {% raw %}\n"
            "    # Adjust for your display/screen - uncomment if needed:\n"
            "    # M117 Paused\n"
            "    {% endraw %}\n"
        ),
        "RESUME": (
            "[gcode_macro RESUME]\n"
            "description: Resume the print - restore position, prime, unpark\n"
            "gcode:\n"
            "    {% set PRIME = params.PRIME|default(6)|float %}\n"
            "    {% set PRIME_SPEED = params.PRIME_SPEED|default(20)|int %}\n"
            "\n"
            "    # Re-heat extruder (slicer temp is restored by toolhead state)\n"
            "    M109 S{printer.toolhead.target_extruder|int}\n"
            "\n"
            "    # Restore position and prime\n"
            "    RESTORE_GCODE_STATE NAME=PAUSE_STATE MOVE=1 MOVE_SPEED=100\n"
            "\n"
            "    # Prime extruder to rejoin filament\n"
            "    G91\n"
            "    G1 E{PRIME} F{PRIME_SPEED * 60}\n"
            "    G90\n"
            "\n"
            "    {% raw %}\n"
            "    # Adjust for your display/screen - uncomment if needed:\n"
            "    # M117 Resuming\n"
            "    {% endraw %}\n"
        ),
        "CANCEL_PRINT": (
            "[gcode_macro CANCEL_PRINT]\n"
            "description: Cancel the print - cleanup and stop\n"
            "gcode:\n"
            "    # Turn off heaters\n"
            "    M140 S0\n"
            "    M104 S0\n"
            "\n"
            "    # Turn off fans\n"
            "    M106 S0\n"
            "\n"
            "    # Retract filament\n"
            "    G91\n"
            "    G1 E-5 F1800\n"
            "    G90\n"
            "\n"
            "    # Lift Z and park\n"
            "    G91\n"
            "    G1 Z10 F300\n"
            "    G90\n"
            "    G1 X0 Y0 F6000\n"
            "\n"
            "    # Disable steppers\n"
            "    M84\n"
            "\n"
            "    # Clear the print\n"
            "    CLEAR_PAUSE\n"
            "    SDCARD_RESET_FILE\n"
        ),
    }

    def _handle_generate_macro_template(self, args: dict[str, Any]) -> str:
        """Generate a Klipper gcode_macro template."""
        macro_name = args.get("macro_name", "").strip().upper()
        if not macro_name:
            return "Please specify a macro name: PRINT_START, PRINT_END, PAUSE, RESUME, or CANCEL_PRINT."

        template = self.MACRO_TEMPLATES.get(macro_name)
        if template is None:
            return f'Unknown macro: "{macro_name}". Available: PRINT_START, PRINT_END, PAUSE, RESUME, CANCEL_PRINT.'

        # For PRINT_START, handle the include_bed_mesh option
        if macro_name == "PRINT_START" and not args.get("include_bed_mesh", False):
            # Remove the bed mesh block but keep the G28
            template = (
                "[gcode_macro PRINT_START]\n"
                "description: Start a print - heat bed, heat nozzle, prime\n"
                "gcode:\n"
                "    # Parameters (set by slicer)\n"
                "    {% set BED_TEMP = params.BED|default(60)|int %}\n"
                "    {% set EXTRUDER_TEMP = params.EXTRUDER|default(200)|int %}\n"
                "\n"
                "    # Heat bed and pre-heat extruder\n"
                "    M140 S{BED_TEMP}\n"
                "    M104 S{EXTRUDER_TEMP - 40}\n"
                "\n"
                "    # Home all axes\n"
                "    G28\n"
                "\n"
                "    # Wait for bed to reach target\n"
                "    M190 S{BED_TEMP}\n"
                "\n"
                "    # Heat extruder fully\n"
                "    M109 S{EXTRUDER_TEMP}\n"
                "\n"
                "    # Prime nozzle\n"
                "    G92 E0\n"
                "    G1 X10 Y10 Z0.4 F3000\n"
                "    G1 X200 Y10 Z0.4 E25 F600\n"
                "    G1 X200 Y10.5 Z0.4 F3000\n"
                "    G1 X10 Y10.5 Z0.4 E50 F600\n"
                "    G92 E0\n"
                "    G1 E-2 F600\n"
                "    G92 E0\n"
            )

        # Apply custom park/retract values
        park_x = args.get("park_x")
        park_y = args.get("park_y")
        park_z = args.get("park_z")
        retract = args.get("retract_distance")
        retract_speed = args.get("retract_speed")

        # For PAUSE and RESUME, inject custom defaults
        if macro_name in ("PAUSE", "PRINT_END", "CANCEL_PRINT") and (park_x is not None or park_y is not None):
            # Replace default park coordinates
            px = int(park_x) if park_x is not None else 0
            py = int(park_y) if park_y is not None else 0
            template = template.replace("{% set PARK_X = params.PARK_X|default(0)|int %}", f"{{% set PARK_X = params.PARK_X|default({px})|int %}}")
            template = template.replace("{% set PARK_Y = params.PARK_Y|default(0)|int %}", f"{{% set PARK_Y = params.PARK_Y|default({py})|int %}}")

        if macro_name == "PAUSE":
            if park_z is not None:
                template = template.replace("{% set LIFT_Z = params.LIFT_Z|default(10)|float %}", f"{{% set LIFT_Z = params.LIFT_Z|default({float(park_z)})|float %}}")
            if retract is not None:
                template = template.replace("{% set RETRACT = params.RETRACT|default(5)|float %}", f"{{% set RETRACT = params.RETRACT|default({float(retract)})|float %}}")
            if retract_speed is not None:
                template = template.replace("{% set RETRACT_SPEED = params.RETRACT_SPEED|default(40)|int %}", f"{{% set RETRACT_SPEED = params.RETRACT_SPEED|default({int(retract_speed)})|int %}}")

        return (
            f"## {macro_name}\n\n"
            f"```\n{template}\n```\n\n"
            f"To use, copy this macro into your printer.cfg (or a separate macros.cfg and [include] it). "
            f"Adjust park coordinates, temperatures, and purge distances to match your printer geometry."
        )

    def _handle_validate_macro(self, args: dict[str, Any]) -> str:
        """Validate a Klipper gcode_macro for common structural issues."""
        macro_text = args.get("macro_text", "")
        if not macro_text.strip():
            return "Please provide macro text to validate."

        # Accept macros wrapped in fenced code blocks (```cfg or plain ```),
        # which is how generate_macro_template and the chat cfg-block protocol
        # deliver them. Validate the block content, not the surrounding fences.
        fenced = re.findall(r"```(?:cfg|yaml|toml|text)?\s*\n(.*?)```", macro_text, re.DOTALL)
        if fenced:
            macro_text = "\n\n".join(block.strip() for block in fenced)

        issues: list[dict[str, str]] = []  # {severity, message}
        lines = macro_text.split("\n")
        # Non-comment code lines used by several checks below so comments
        # cannot trigger false positives.
        code_lines = [ln.strip() for ln in lines
                      if ln.strip() and not ln.strip().startswith("#")]
        code_text = "\n".join(code_lines)

        # ── 1. Check section header ──
        header_match = re.search(r"\[gcode_macro\s+(\S+)\]", macro_text)
        if not header_match:
            issues.append({"severity": "error", "message": "Missing or invalid [gcode_macro <name>] header."})
        else:
            macro_name = header_match.group(1)
            # Check gcode: key
            for line in lines[1:]:
                stripped = line.strip()
                if stripped.startswith("gcode:") or stripped.startswith("gcode :"):
                    break
                if stripped and not stripped.startswith("#") and not stripped.startswith("description:"):
                    issues.append({"severity": "warning", "message": f"Macro '{macro_name}' is missing the 'gcode:' key. A gcode_macro must have a 'gcode:' section with the commands to run."})
                    break

            # Check description:
            has_description = any(line.strip().startswith("description:") for line in lines[1:10])
            if not has_description:
                issues.append({"severity": "info", "message": f"Macro '{macro_name}' is missing a 'description:' field. Adding one makes the macro self-documenting."})

        # ── 2. Jinja2 template balance ──
        # Check {% raw %}...{% endraw %} pairs
        raw_starts = [i for i, line in enumerate(lines) if "{% raw %}" in line or "{%- raw -%}" in line or "{%raw%}" in line]
        raw_ends = [i for i, line in enumerate(lines) if "{% endraw %}" in line or "{%- endraw -%}" in line or "{%endraw%}" in line]
        if len(raw_starts) != len(raw_ends):
            issues.append({"severity": "error", "message": f"Unbalanced {{% raw %}} / {{% endraw %}} blocks ({len(raw_starts)} starts, {len(raw_ends)} ends)."})

        # Check {% if %}...{% endif %} pairs (rough count)
        if_opens = sum(1 for line in lines if "{% if " in line or "{%if " in line)
        if_closes = sum(1 for line in lines if "{% endif %}" in line or "{%endif%}" in line)
        if if_opens != if_closes:
            issues.append({"severity": "error", "message": f"Unbalanced {{% if %}} / {{% endif %}} blocks ({if_opens} opens, {if_closes} closes)."})

        # Check {% for %}...{% endfor %} pairs
        for_opens = sum(1 for line in lines if "{% for " in line or "{%for " in line)
        for_closes = sum(1 for line in lines if "{% endfor %}" in line or "{%endfor%}" in line)
        if for_opens != for_closes:
            issues.append({"severity": "error", "message": f"Unbalanced {{% for %}} / {{% endfor %}} blocks ({for_opens} opens, {for_closes} closes)."})

        # ── 3. Save/restore state pairing ──
        save_count = len(re.findall(r"SAVE_GCODE_STATE", code_text))
        restore_count = len(re.findall(r"RESTORE_GCODE_STATE", code_text))
        if save_count > restore_count:
            issues.append({"severity": "info", "message": f"SAVE_GCODE_STATE is called {save_count} time(s) but RESTORE_GCODE_STATE is only called {restore_count} time(s) in this macro. This is expected for PAUSE-style macros whose state is restored by another macro (e.g. RESUME); otherwise add a matching RESTORE."})
        elif restore_count > save_count:
            issues.append({"severity": "warning", "message": f"RESTORE_GCODE_STATE is called {restore_count} time(s) without a SAVE_GCODE_STATE in this macro ({save_count} SAVE(s)). Expected for RESUME-style macros restoring state saved by another macro (e.g. PAUSE); otherwise the RESTORE will fail at runtime because no matching saved state exists."})
        if save_count == 0 and re.search(r"\bG1\b", code_text):
            issues.append({"severity": "info", "message": "Macro performs moves but does not use SAVE_GCODE_STATE / RESTORE_GCODE_STATE. Consider wrapping state-changing operations to avoid side effects."})

        # ── 4. Temperature commands ──
        temp_cmds = re.findall(r"(M104|M109|M140|M190)", code_text)
        for cmd in temp_cmds:
            # Check if S parameter is present (or a variable)
            pattern = cmd + r"\s+S"
            if not re.search(pattern, macro_text):
                # Check if it uses a jinja variable for temp
                var_pattern = cmd + r"\s+\{\%"
                if not re.search(var_pattern, macro_text):
                    issues.append({"severity": "warning", "message": f"'{cmd}' without 'S' temperature parameter may not heat as expected. Use 'M140 S60' or 'M104 S{{TEMP}}'."})

        # Check for G1 E moves without F (feedrate). Inspect the whole line —
        # a greedy regex previously cut the match at the E coordinate and
        # missed an F parameter on the same line (e.g. 'G1 X200 Y10 Z0.4 E25 F600').
        for line in lines:
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if not re.match(r"G1\b", stripped, re.IGNORECASE):
                continue
            if re.search(r"\bE\s*[0-9{]", stripped, re.IGNORECASE) and \
               not re.search(r"\bF\s*[0-9{]", stripped, re.IGNORECASE):
                issues.append({"severity": "warning",
                               "message": f"Extrusion move without feedrate: '{stripped[:80]}'. Add F parameter to control extrusion speed."})

        # ── 5. Common issues ──
        # BED_MESH_CALIBRATE without prior G28 (comments ignored)
        if any("BED_MESH_CALIBRATE" in ln for ln in code_lines) and \
           not any(re.search(r"\bG28\b", ln) for ln in code_lines):
            issues.append({"severity": "info", "message": "BED_MESH_CALIBRATE is called but this macro does not include G28. Make sure homing happens before the mesh is probed (e.g., in the calling macro or PRINT_START)."})

        # G28 inside SAVE_GCODE_STATE block - can cause issues.
        # Track save nesting depth and ignore comments so a commented-out
        # 'G28' or 'SAVE_GCODE_STATE' cannot trigger a false positive.
        g28_in_save = False
        save_depth = 0
        for line in lines:
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if "SAVE_GCODE_STATE" in stripped:
                save_depth += 1
            if "RESTORE_GCODE_STATE" in stripped:
                save_depth = max(0, save_depth - 1)
            if save_depth > 0 and re.search(r"\bG28\b", stripped):
                g28_in_save = True
        if g28_in_save:
            issues.append({"severity": "warning", "message": "G28 is used between SAVE_GCODE_STATE and RESTORE_GCODE_STATE. G28 clears the coordinate system, which may make the RESTORE unreliable. Home before saving state instead."})

        # ── 6. Move safety checks (requires printer geometry) ──
        # Mirrors the Macro Designer's bounds/zone geometry (macro_sim.py).
        bed_x = args.get("bed_x")
        bed_y = args.get("bed_y")
        max_z = args.get("max_z")
        probe_off_x = args.get("probe_offset_x")
        probe_off_y = args.get("probe_offset_y")
        raw_zones = args.get("no_go_zones")

        if bed_x is not None and bed_y is not None and bed_x > 0 and bed_y > 0:
            try:
                from services.macro_sim import (
                    MOVE_PARAM_RE, MoveBounds, MoveTracker, NoGoZone,
                    find_path_zone_hit, find_zone_hit,
                )
            except ImportError:
                return ("## Macro validation: geometry module unavailable; "
                        "move-bounds and no-go zone checks skipped.")

            zones: list[NoGoZone] = []
            if isinstance(raw_zones, list):
                for z in raw_zones:
                    if not isinstance(z, dict):
                        continue
                    try:
                        zones.append(NoGoZone(
                            x=float(z.get("x", 0)),
                            y=float(z.get("y", 0)),
                            width=float(z.get("width", 10)),
                            height=float(z.get("height", 10)),
                        ))
                    except (TypeError, ValueError):
                        continue

            bounds = MoveBounds(
                min_x=0.0, max_x=float(bed_x),
                min_y=0.0, max_y=float(bed_y),
                min_z=0.0, max_z=float(max_z) if max_z else 200.0,
                zones=zones,
            )
            margin_x = (probe_off_x or 0) * 1.5
            margin_y = (probe_off_y or 0) * 1.5

            tracker = MoveTracker()
            for line in lines:
                stripped = line.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                upper = stripped.upper()
                if upper.startswith("G90"):
                    tracker.set_mode(True)
                    continue
                if upper.startswith("G91"):
                    tracker.set_mode(False)
                    continue
                if upper.startswith("G28"):
                    tracker.home()
                    continue
                if not (upper.startswith("G0") or upper.startswith("G1 ")):
                    continue

                params = {k.upper(): v for k, v in MOVE_PARAM_RE.findall(stripped)}
                if not params:
                    continue

                try:
                    x = float(params["X"]) if "X" in params else None
                    y = float(params["Y"]) if "Y" in params else None
                    z = float(params["Z"]) if "Z" in params else None
                except ValueError:
                    continue  # template variable in a move

                tx, ty, tz = tracker.move(x, y, z)

                if tx is not None and ty is not None:
                    if tx < -margin_x or tx > bounds.max_x + margin_x or \
                       ty < -margin_y or ty > bounds.max_y + margin_y:
                        issues.append({
                            "severity": "warning",
                            "message": f"Move to X{tx:.1f} Y{ty:.1f} exceeds bed bounds "
                                       f"(0 to {bed_x} x 0 to {bed_y}mm). Line: '{stripped[:80]}'",
                        })
                    if zones:
                        zone = find_zone_hit(bounds, tx, ty)
                        if zone:
                            issues.append({
                                "severity": "warning",
                                "message": f"Move ends inside a no-go zone "
                                           f"(X{zone.x:.0f}-{zone.x + zone.width:.0f}, "
                                           f"Y{zone.y:.0f}-{zone.y + zone.height:.0f}). "
                                           f"Line: '{stripped[:80]}'",
                            })
                        if tracker.prev_x is not None and tracker.prev_y is not None:
                            path_zone = find_path_zone_hit(
                                bounds, tracker.prev_x, tracker.prev_y, tx, ty,
                            )
                            if path_zone:
                                issues.append({
                                    "severity": "warning",
                                    "message": f"Move path crosses a no-go zone "
                                               f"(X{path_zone.x:.0f}-{path_zone.x + path_zone.width:.0f}, "
                                               f"Y{path_zone.y:.0f}-{path_zone.y + path_zone.height:.0f}). "
                                               f"Line: '{stripped[:80]}'",
                                })

                if tz is not None and bounds.max_z:
                    if tz < -1 or tz > bounds.max_z:
                        issues.append({
                            "severity": "warning",
                            "message": f"Move to Z{tz:.1f} exceeds configured Z range "
                                       f"(0 to {bounds.max_z:.0f}mm). Line: '{stripped[:80]}'",
                        })

            # Probe off-bed detection
            if probe_off_x is not None and probe_off_y is not None:
                for line in lines:
                    stripped = line.strip().upper()
                    if "BED_MESH_CALIBRATE" in stripped or "PROBE" in stripped or "PROBE_ACCURACY" in stripped or "PROBE_CALIBRATE" in stripped:
                        if probe_off_x < 0 or probe_off_y < 0:
                            issues.append({
                                "severity": "info",
                                "message": f"Probe offset (X:{probe_off_x}, Y:{probe_off_y}) means the probe extends beyond the nozzle. "
                                f"When probing near X=0 or Y=0, the probe may be off the bed. "
                                f"Consider setting safe probing margins in BED_MESH_CALIBRATE with "
                                f"mesh_min/mesh_max that account for the probe offset."
                            })
                            break


        # ── 7. Build result ──
        if not issues:
            return (
                f"## Macro validation: No issues found\n\n"
                f"The macro passed all basic checks. For a full gcode simulation with machine state "
                f"tracking, movement validation, and zone checking, use the Macro Designer in the app."
            )

        errors = [i for i in issues if i["severity"] == "error"]
        warnings = [i for i in issues if i["severity"] == "warning"]
        info = [i for i in issues if i["severity"] == "info"]

        parts: list[str] = [f"## Macro validation: {len(issues)} issue(s) found\n"]
        if errors:
            parts.append(f"### Errors ({len(errors)})")
            for e in errors:
                parts.append(f"- {e['message']}")
            parts.append("")
        if warnings:
            parts.append(f"### Warnings ({len(warnings)})")
            for w in warnings:
                parts.append(f"- {w['message']}")
            parts.append("")
        if info:
            parts.append(f"### Suggestions ({len(info)})")
            for i_item in info:
                parts.append(f"- {i_item['message']}")
            parts.append("")

        parts.append("---")
        parts.append("For a full gcode simulation with machine state tracking, use the Macro Designer in the app.")

        return "\n".join(parts)

    # ── Printer Memory ────────────────────────────────────────────

    # ── JSON-RPC / MCP Protocol ─────────────────────────────────

    def handle_jsonrpc(self, request: dict) -> dict | None:
        """Process a single JSON-RPC request and return the response."""
        method = request.get("method", "")
        params = request.get("params", {})
        req_id = request.get("id")

        # Notifications (no id) don't get a response
        if method == "notifications/initialized":
            self._initialized = True
            return None

        if method == "initialize":
            return self._rpc_response(req_id, {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {
                    "tools": {},
                    "resources": {},
                },
                "serverInfo": {
                    "name": SERVER_NAME,
                    "version": SERVER_VERSION,
                },
            })

        if method == "tools/list":
            return self._rpc_response(req_id, {"tools": self._list_tools()})

        if method == "tools/call":
            name = params.get("name", "")
            arguments = params.get("arguments", {})
            result = self._call_tool(name, arguments)
            return self._rpc_response(req_id, result)

        if method == "resources/list":
            docs = self.index.list_docs()
            return self._rpc_response(req_id, {
                "resources": [
                    {
                        "uri": f"kwc://docs/{d['id']}",
                        "name": d["filename"],
                        "description": f"Klipper documentation: {d['filename']}",
                        "mimeType": "text/markdown",
                    }
                    for d in docs[:50]
                ],
            })

        if method == "resources/read":
            uri = params.get("uri", "")
            stem_match = re.match(r"kwc://docs/(.+)", uri)
            if stem_match:
                stem = stem_match.group(1)
                doc = self.index.read_doc(stem)
                if doc:
                    return self._rpc_response(req_id, {
                        "contents": [
                            {
                                "uri": uri,
                                "mimeType": "text/markdown",
                                "text": doc["content"],
                            }
                        ],
                    })
            return self._rpc_response(req_id, {
                "contents": [],
            })

        # Root endpoint check
        if method == "ping":
            return self._rpc_response(req_id, {})

        return self._rpc_error(req_id, -32601, f"Method not found: {method}")

    def _rpc_response(self, req_id: Any, result: dict) -> dict:
        return {"jsonrpc": "2.0", "id": req_id, "result": result}

    def _rpc_error(self, req_id: Any, code: int, message: str) -> dict:
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}

    def _text_result(self, text: str) -> dict[str, Any]:
        return {"content": [{"type": "text", "text": text}]}

    def _error(self, code: int, message: str) -> dict[str, Any]:
        return {"content": [{"type": "text", "text": f"Error: {message}"}], "isError": True}


# ══════════════════════════════════════════════════════════════════════
#  Stdio Transport (for external MCP clients)
# ══════════════════════════════════════════════════════════════════════

def run_stdio() -> None:
    """Run the MCP server over stdin/stdout (standard MCP transport)."""
    server = McpServer()
    index = get_index()

    if not index.is_ready():
        print("MCP server: no documentation found at", KLIPPER_DOCS_DIR, file=sys.stderr)
    else:
        print(f"MCP server: {index.get_doc_count()} docs indexed from {KLIPPER_DOCS_DIR}", file=sys.stderr)

    # Readline loop
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            # Respond with parse error
            response = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": f"Parse error: {exc}"}}
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()
            continue

        try:
            response = server.handle_jsonrpc(request)
        except Exception as exc:
            response = {"jsonrpc": "2.0", "id": request.get("id"), "error": {"code": -32603, "message": f"Internal error: {exc}"}}

        if response is not None:
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    run_stdio()
