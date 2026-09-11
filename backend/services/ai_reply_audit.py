"""Deterministic post-apply audit for AI chat replies (#3).

Three checks that run UNCONDITIONALLY on harness code after a reply is
produced — never model-callable tools (the "model must choose to call it"
gap is exactly what this design rejects, see kwc-ai-chat-pipeline skill):

1. ``check_stated_requirements`` — regex over the user's own message for
   literal stated values ("set max_accel to 12000", "probe_count: 3x3")
   and verifies each appears in the applied/merged config. Source: the
   user's message + the merged ConfigFiles (AST), not model output.
2. ``check_macro_preconditions`` — static precondition table on gcode
   bodies that were added/changed (BED_MESH_CALIBRATE needs homing, etc.).
   Source: static Klipper knowledge, no parsing guesswork.
3. ``check_led_inventory`` — when a change touches an LED-ish section,
   enumerate ALL LED/strip sections in the project from the AST so the
   model can't silently leave siblings inconsistent (TRIDENT-15/16 class).

Every check only ever ATTACHES an observation note. A wrong check is a
useless note; it never changes routing, the model's input, or whether the
reply is accepted (intent-guessing law). Notes are appended to the final
reply under a clearly-marked audit footer.
"""
from __future__ import annotations

import re

from parser.config_parser import ConfigFile

# ── 1. Stated-requirement checker ────────────────────────────────────

# "<verb> <param> to/at/= <value>" and "<param> to/at/= <value>" where the
# param looks like a Klipper snake_case key. Verb list keeps us from
# matching prose questions ("what is max_velocity?" has no target value).
_REQ_VERB_RE = re.compile(
    r"\b(?:set|change|update|make|raise|lower|increase|decrease|adjust|tune)\b"
    r"[^.\n]{0,40}?\b([a-z][a-z0-9_]{2,})\b(?:\s+(?:to|at|=|->|:))\s+"
    r"(-?\d+(?:\.\d+)?)\b",
    re.IGNORECASE,
)
# Bare "<param> = <value>" / "<param>: <value>" phrasing ("max_accel: 12000").
_REQ_BARE_RE = re.compile(
    r"\b([a-z][a-z0-9_]{2,})\s*(?:=|:)\s*(-?\d+(?:\.\d+)?)(?!\s*(?:x|px)\b)",
)
# "<param> NxM" grid values (probe_count 3x3, mesh_pps 2x2).
_REQ_GRID_RE = re.compile(
    r"\b(probe_count|mesh_pps|speed_vompute)\b\s*(?:=|:|to|at)?\s*(\d+)\s*[xX]\s*(\d+)",
)

# Params so generic that a bare mention would produce noise; the verb form
# is required for these.
_BARE_SKIP_PARAMS = frozenset(
    {"value", "count", "size", "number", "length", "width", "height", "min", "max", "timeout", "pin", "name"}
)


def _num_eq(a: str, b: str) -> bool:
    try:
        return float(a) == float(b)
    except ValueError:
        return a.strip() == b.strip()


def _merged_param_values(merged_files: dict[str, ConfigFile]) -> dict[str, list[str]]:
    """param key -> [values] across every section of every merged file."""
    out: dict[str, list[str]] = {}
    for cfg in merged_files.values():
        for section in cfg.sections:
            for param in section.params:
                if param.is_commented_out:
                    continue
                out.setdefault(param.key, []).append(param.value)
    return out


def check_stated_requirements(
    user_message: str,
    merged_files: dict[str, ConfigFile],
) -> list[str]:
    """Literal values the user asked for that are NOT in the merged result."""
    requested: dict[str, list[str]] = {}
    for m in _REQ_VERB_RE.finditer(user_message):
        requested.setdefault(m.group(1).lower(), []).append(m.group(2))
    for m in _REQ_BARE_RE.finditer(user_message):
        key = m.group(1).lower()
        if key in _BARE_SKIP_PARAMS:
            continue
        requested.setdefault(key, []).append(m.group(2))
    grids: list[tuple[str, str]] = []
    for m in _REQ_GRID_RE.finditer(user_message):
        grids.append((m.group(1).lower(), f"{m.group(2)}x{m.group(3)}"))
        requested.setdefault(m.group(1).lower(), []).append(f"{m.group(2)}x{m.group(3)}")

    if not requested:
        return []

    available = _merged_param_values(merged_files)
    notes: list[str] = []
    for key, values in requested.items():
        if key not in available:
            # Typo/alias tolerance: 'max_acceleration' → real param
            # 'max_accel' (prefix match). The validator rejects unknown
            # params outright, so an unknown stated key with a close real
            # sibling means the repair pipeline already resolved it —
            # check the sibling instead of crying wolf. GUARDED: siblings
            # must be ≥8 chars and ≥half the requested key's length, or a
            # bare `probe` would swallow `probe_count` (different params).
            aliases = [
                k for k in available
                if (k.startswith(key) or key.startswith(k))
                and min(len(k), len(key)) >= 8
                and min(len(k), len(key)) * 2 >= max(len(k), len(key))
            ]
            if aliases:
                key = min(aliases, key=len)
            # Unknown key with no sibling: fall through so it is flagged as
            # "no value" — the requirement demonstrably did not land.
        have = available.get(key, [])
        for want in values:
            # Grid values: "5x5" matches stored "5,5" / "5, 5" / "5x5".
            def _norm_grid(v: str) -> str:
                return re.sub(r"[\s,]+", "x", v.strip().lower()).rstrip("x")

            norm_have = [_norm_grid(h) for h in have]
            if any(_num_eq(want, h) or _norm_grid(want) == h for h in norm_have):
                continue
            if not have:
                found_desc = "no value"
            elif len(have) == 1:
                found_desc = f"`{have[0]}`"
            else:
                found_desc = f"`{have[0]}` (found: {', '.join('`' + h + '`' for h in have[:4])})"
            notes.append(
                f"Your message asked for `{key}` = `{want}`, but the merged config has "
                f"{found_desc} for that parameter. Review whether the change landed."
            )
    return notes


# ── 2. Macro precondition table ──────────────────────────────────────

# command -> (precondition note, regex that satisfies it anywhere EARLIER in
# the same macro body). Static Klipper knowledge; keep entries only where a
# violation is a real runtime failure, not a style preference.
_PRECONDITIONS: list[tuple[str, re.Pattern, str, re.Pattern]] = [
    (
        "BED_MESH_CALIBRATE",
        re.compile(r"\bBED_MESH_CALIBRATE\b"),
        "bed mesh calibration requires the toolhead to be homed first",
        re.compile(r"\bG28\b|\bQUAD_GANTRY_LEVEL\b"),
    ),
    (
        "PROBE_CALIBRATE",
        re.compile(r"\bPROBE_CALIBRATE\b"),
        "probe calibration requires a homed, stable toolhead",
        re.compile(r"\bG28\b"),
    ),
    (
        "QGL",
        re.compile(r"\bQUAD_GANTRY_LEVEL\b"),
        "quad gantry level requires the printer homed and usually heated",
        re.compile(r"\bG28\b"),
    ),
    (
        "CALIBRATE_Z_OFFSET",
        re.compile(r"\bCALIBRATE_Z_OFFSET\b"),
        "z-offset calibration requires the toolhead homed",
        re.compile(r"\bG28\b"),
    ),
]


def check_macro_preconditions(changed_gcode_bodies: list[tuple[str, str]]) -> list[str]:
    """(section_header, gcode_body) for macros that were added/changed."""
    notes: list[str] = []
    for header, body in changed_gcode_bodies:
        for name, cmd_re, note, satisfied_re in _PRECONDITIONS:
            match = cmd_re.search(body)
            if not match:
                continue
            before = body[: match.start()]
            if satisfied_re.search(before) or satisfied_re.search(body[match.end():]):
                continue
            notes.append(
                f"`[{header}]` calls {name}, which {note}, but the macro never runs "
                f"`G28`. Consider adding a homing step (or confirming the macro is "
                f"only ever called after homing)."
            )
    return notes


# ── 3. LED / sibling-section inventory sweep ─────────────────────────

_LED_TYPE_RE = re.compile(r"^(neopixel|dotstar|led|pca9533|pca9685)\b")
# LED commands in changed gcode count as touching that LED even when the
# EDITED section isn't an LED section (TRIDENT-15 class: SET_LED added to
# [idle_timeout] for one strip only). Literal command-argument matching on
# the AST-enumerated strip names — deterministic, observation-only.
_LED_CMD_RE = re.compile(r"\bSET_LED\b|\bSTOP_LED_EFFECTS\b|\bSET_LED_EFFECTS\b",
                         re.IGNORECASE)


def check_led_inventory(
    changed_section_headers: list[str],
    project_files: dict[str, ConfigFile],
    changed_gcode_bodies: list[tuple[str, str]] | None = None,
) -> list[str]:
    """If the change touched an LED section (or runs an LED command naming
    a strip), list every LED section in the project so none is silently
    left inconsistent."""
    touched_led = [h for h in changed_section_headers if _LED_TYPE_RE.match(h)]
    touched_names = {h.split(None, 1)[1] for h in touched_led if " " in h}
    for _, body in changed_gcode_bodies or []:
        if not _LED_CMD_RE.search(body):
            continue
        for filename, cfg in project_files.items():
            for section in cfg.sections:
                if _LED_TYPE_RE.match(section.full_header) and " " in section.full_header:
                    strip_name = section.full_header.split(None, 1)[1]
                    if re.search(rf"\b{re.escape(strip_name)}\b", body):
                        touched_names.add(strip_name)
    if not touched_names:
        return []
    inventory: list[str] = []
    for filename, cfg in project_files.items():
        for section in cfg.sections:
            if not _LED_TYPE_RE.match(section.full_header):
                continue
            strip_name = section.full_header.split(None, 1)[1] if " " in section.full_header else ""
            if strip_name and strip_name not in touched_names:
                inventory.append(f"[{section.full_header}] ({filename})")
    if not inventory:
        return []
    return [
        "This change touches "
        + ", ".join(f"`{n}`" for n in sorted(touched_names))
        + ". Other LED sections in the project were NOT changed: "
        + ", ".join(inventory)
        + ". Check whether they need the same change."
    ]


# ── Footer assembly ──────────────────────────────────────────────────

_AUDIT_HEADER = "\n\n---\n_Harness checks (automatic, not the model):_"


def build_audit_footer(notes: list[str]) -> str:
    if not notes:
        return ""
    return _AUDIT_HEADER + "\n" + "\n".join(f"- {n}" for n in notes)


def run_post_apply_audit(
    user_message: str,
    merged_files: dict[str, ConfigFile],
    changed_gcode_bodies: list[tuple[str, str]],
    changed_section_headers: list[str],
) -> list[str]:
    """Run all three audits; returns the combined observation notes."""
    notes: list[str] = []
    notes.extend(check_stated_requirements(user_message, merged_files))
    notes.extend(check_macro_preconditions(changed_gcode_bodies))
    notes.extend(check_led_inventory(
        changed_section_headers, merged_files, changed_gcode_bodies
    ))
    return notes
