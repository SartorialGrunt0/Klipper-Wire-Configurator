#!/usr/bin/env python3
"""Derive the unknown-param escalation coverage dataset.

Emits backend/parser/klipper_param_coverage.json: for every Klipper section
type KWC can ground, the set of option names Klipper actually accepts there.
The validator consults this ONLY to decide whether an unknown_param finding
may escalate to an un-acknowledgeable ERROR (see
.hermes/plans/2026-09-29_230500-unknown-param-escalation.md).

Ground truth for the hard-fail predicate: klippy/configfile.py check_unused
(424-441) raises "Option 'x' is not valid in section 'y'" as the last step of
startup (klippy.py:127).

Sources (both bundled):
  - reference/klipper_config_sections.json  (Config_Reference.md extraction)
  - reference/klipper source snapshot       (every option a module reads)

Attribution rule: a source read counts for a section type only when the
reading module OWNS that section (module defines load_config*) or is pulled
in by the owner via `from . import X` / `printer.load_object(config, 'X')`.
Helper modules (bus.py, probe.py, heaters.py, buttons.py, gcode_macro.py...)
therefore contribute their common reads to every section that loads them.
Deliberate over-inclusion: a dataset that is a superset of reality only
weakens escalation for that section; an incomplete one would BLOCK configs
Klipper accepts. Sections whose option names are built at runtime are waived.

Rerun after every Klipper snapshot bump; tests/test_param_coverage_dataset.py
is the CI tripwire.
"""
from __future__ import annotations

import argparse
import datetime
import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
KLIPPY_ROOT = REPO_ROOT / "reference" / "klipper" / "klippy"
DOC_SECTIONS_PATH = REPO_ROOT / "reference" / "klipper_config_sections.json"
OUT_PATH = REPO_ROOT / "backend" / "parser" / "klipper_param_coverage.json"

sys.path.insert(0, str(REPO_ROOT / "backend"))
from parser.config_schema import SECTION_DEFS  # noqa: E402

# ── read shapes ────────────────────────────────────────────────────────────
# plain: config.getfloat('max_z_adjustment', ...) — the variable must be
# named exactly `config` (the section's own proxy). Derived proxies that
# point at a DIFFERENT section (sconfig in tmc.py/stepper.py, printconfig,
# gcmd) must not contribute, or we'd attribute the stepper rail's options
# to the driver section that merely holds `sconfig`.
READ_RE = re.compile(
    r"\bconfig\s*\.\s*get(?:float|int|boolean|choice|str|list|intlist|floatlist|with_preprocess)?\s*\(\s*['\"]([A-Za-z][A-Za-z0-9_%.\-]*)['\"]"
)
# helper-mediated: gcode_macro.load_template(config, 'activate_gcode', ''),
# intParamHelper(config, "buzz_filter_delay", ...), setup_heater(config, ...)
# — anything whose FIRST argument is `config` and second a string literal.
HELPER_RE = re.compile(r"\(\s*config\s*,\s*['\"]([A-Za-z][A-Za-z0-9_%.\-]*)['\"]")
# module ownership + helper graph
LOAD_CFG_RE = re.compile(r"^def\s+(load_config(?:_prefix|_multi\w*)?)\s*\(", re.M)
IMPORT_RE = re.compile(r"^\s*from\s+\.([\w.]+)\s+import|^\s*from\s+\.\s+import\s+(\w+)", re.M)
LOAD_OBJECT_RE = re.compile(r"(?:load_object|lookup_object)\(\s*(?:config\s*,\s*)?['\"](\w+)['\"]")

# A captured name is a real option candidate iff lowercase-alnum+underscore
# once Klipper-normalized (configfile.py lowercases options) and >=3 chars.
OPTIONISH_RE = re.compile(r"^[a-z][a-z0-9_]{2,}$")

# format-string names (bed_mesh 'faulty_region_%d_min') become wildcards
FMT_RE = re.compile(r"%[-+ #0]*[\d.]*[sdifgeuGEX]")

# ── exclusions ─────────────────────────────────────────────────────────────
# Source package excluded wholesale: the configurable-display package builds
# section names AND option names at runtime (menu item names are user scripts;
# display items take arbitrary param_* / dynamic keys). Any record here would
# be a lie, and a lie at the error tier blocks valid configs.
EXCLUDED_PATHS = {"extras/display"}

# Factory modules excluded from read attribution: their `config.` reads run
# against a section they are ASKED ABOUT (mcu.py reads the [mcu ...] section
# via get_printer_mcu/section_factory; stepper.py reads rail sections reached
# through getsection), not the caller's section. Importing them for helpers
# must not bleed their option literals into a sensor's record. They may still
# own sections of their own (mcu does) — only their reads via the import
# closure are dropped.
FACTORY_MODULES = {"mcu.py", "stepper.py", "pins.py", "toolhead.py", "gcode.py",
                   "gcode_move.py", "webhooks.py"}

# Waived section types: modeled in SECTION_DEFS for the UI but NOT groundable.
#   menu/display/display_template/display_data/display_glyph — dynamic names (see above)
#   thermistor — heaters.py reads arbitrary R0/B/T0/T1... via a name-built loop
#   board_pins — 'aliases_<name>' is a docs wildcard, not a fixed param
#   update_manager — Moonraker-owned; no Klipper module, no doc record
#   shaketune/autotune_tmc/motor_constants/motor_alias — third-party extras
WAIVED_SECTIONS = {
    "menu", "display", "display_template", "display_data", "display_glyph",
    "thermistor", "board_pins",
}

# The tmc trap: klippy/extras/tmc.py reads microsteps/full_steps_per_rotation
# off `sconfig` (the referenced STEPPER section, tmc.py:682), not the driver
# section. klippy genuinely rejects `[tmc2209 stepper_x] microsteps:` — the
# corpus sweep's 7 findings prove it — so these must never land in a tmc*
# record even though the import closure reaches tmc.py from every driver.
TMC_TYPES = {"tmc2130", "tmc2208", "tmc2209", "tmc2240", "tmc2660", "tmc5160"}
TMC_EXCLUDE = {"microsteps", "full_steps_per_rotation", "rotation_distance", "gear_ratio"}


def normalize(raw: str) -> list[str]:
    """Klipper-lowercase an option literal; expand %-format names to wildcards."""
    name = raw.lower()
    if "%" in name:
        wild = FMT_RE.sub("*", name)
        # keep only the wildcard form ('faulty_region_%d_min' ->
        # 'faulty_region_*_min'); the literal % form is not a real option
        return [wild] if OPTIONISH_RE.match(wild.replace("*", "x")) else []
    return [name] if OPTIONISH_RE.match(name) else []


def collect_modules() -> dict[str, str]:
    """relpath -> source, for every klippy module (display pkg excluded)."""
    mods = {}
    for p in sorted(KLIPPY_ROOT.rglob("*.py")):
        rel = str(p.relative_to(KLIPPY_ROOT))
        if any(rel == x or rel.startswith(x + "/") for x in EXCLUDED_PATHS):
            continue
        if rel.startswith("__pycache__") or "/__pycache__/" in rel:
            continue
        mods[rel.removesuffix(".py").replace("/", ".")] = p.read_text(encoding="utf-8")
    return mods


def owners(mods: dict[str, str]) -> dict[str, list[str]]:
    """section-token -> owner module dotted paths (module filename == type)."""
    out: dict[str, list[str]] = {}
    for mod, src in mods.items():
        if not LOAD_CFG_RE.search(src):
            continue
        token = mod.rsplit(".", 1)[-1]
        out.setdefault(token, []).append(mod)
    return out


def closure(mod: str, mods: dict[str, str], cache: dict) -> set[str]:
    """Owner + every helper module reachable via relative imports / load_object."""
    if mod in cache:
        return cache[mod]
    cache[mod] = set()  # cycle guard
    src = mods[mod]
    reach = {mod}
    deps = set()
    for m in IMPORT_RE.finditer(src):
        dep = m.group(1) or m.group(2)
        deps.add(dep)
    for m in LOAD_OBJECT_RE.finditer(src):
        deps.add(m.group(1))
    for dep in deps:
        # extras subpackage members are addressed as 'display.menu' etc.;
        # the whole display package is excluded anyway
        cand = f"extras.{dep}" if f"extras.{dep}" in mods else dep
        if cand in mods:
            reach |= closure(cand, mods, cache)
        elif dep in mods:
            reach |= closure(dep, mods, cache)
    cache[mod] = reach
    return reach


def reads_from(src: str) -> set[str]:
    names: set[str] = set()
    for rx in (READ_RE, HELPER_RE):
        for m in rx.finditer(src):
            names.update(normalize(m.group(1)))
    return names


def is_factory(mod: str) -> bool:
    return mod.rsplit(".", 1)[-1] + ".py" in FACTORY_MODULES


def doc_records() -> dict[str, set[str]]:
    """doc sections keyed by first header token, mapped onto SECTION_DEFS keys."""
    doc = json.loads(DOC_SECTIONS_PATH.read_text())["sections"]
    out: dict[str, set[str]] = {}

    def add(token: str, params):
        if token not in SECTION_DEFS or token in WAIVED_SECTIONS:
            return
        bucket = out.setdefault(token, set())
        for p in params:
            bucket.update(normalize(p["name"]))

    for s in doc:
        pat = s["pattern"]
        params = [p["name"] for p in s.get("parameters", [])]
        # 'extruder<N> (extruder1, extruder2, ...)' family
        if pat.startswith("extruder<N>"):
            for n in ["extruder"] + [f"extruder{i}" for i in range(1, 8)]:
                add(n, s.get("parameters", []))
            continue
        # slash-families: 'stepper_a / stepper_b / stepper_c (delta kinematics)'
        tokens = []
        for part in pat.split("/"):
            tok = re.split(r"[<( ]", part.strip(), 1)[0].strip()
            if tok:
                tokens.append(tok)
        for tok in tokens:
            add(tok, s.get("parameters", []))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=str(OUT_PATH))
    args = ap.parse_args()

    try:
        head = subprocess.run(
            ["git", "-C", str(REPO_ROOT / "reference" / "klipper"), "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
    except Exception:
        head = "unknown"

    mods = collect_modules()
    own = owners(mods)
    cl_cache: dict = {}
    docs = doc_records()

    sections: dict[str, dict] = {}

    def record(sec_type: str, params: set[str], modules: list[str], from_doc: bool,
               doc_params: "set[str] | None" = None):
        if sec_type in WAIVED_SECTIONS or sec_type not in SECTION_DEFS:
            return
        doc_params = set(doc_params) if doc_params else set()
        if sec_type in TMC_TYPES:
            params -= TMC_EXCLUDE
            doc_params -= TMC_EXCLUDE
        rec = sections.setdefault(
            sec_type, {"params": set(), "doc_params": set(), "modules": [], "doc": False})
        rec["params"] |= params
        rec["doc_params"] |= set(doc_params)
        for m in modules:
            if m not in rec["modules"]:
                rec["modules"].append(m)
        rec["doc"] = rec["doc"] or from_doc

    for token, owner_mods in sorted(own.items()):
        params: set[str] = set()
        reach_all: set[str] = set()
        for om in owner_mods:
            reach = closure(om, mods, cl_cache)
            reach_all |= reach
            for r in sorted(reach):
                if r != om and is_factory(r):
                    continue  # factory reads bind to other sections
                params |= reads_from(mods[r])
        # a token like 'stepper' (root stepper.py has no load_config) still
        # maps through the family below; direct owners get source reads here
        record(token, params, sorted(reach_all), from_doc=token in docs)

    for token, params in sorted(docs.items()):
        record(token, set(params), [], from_doc=True, doc_params=set(params))

    out_sections = {}
    for sec_type in sorted(sections):
        rec = sections[sec_type]
        if not rec["params"]:
            continue  # no claim -> no record -> guard stays warning
        out_sections[sec_type] = {
            "params": sorted(rec["params"]),
            "doc_params": sorted(rec["doc_params"]),
            "sources": {"modules": rec["modules"], "doc": rec["doc"]},
        }

    payload = {
        "_meta": {
            "generated": datetime.date.today().isoformat(),
            "klipper_head": head,
            "generator": "scripts/derive_klipper_param_coverage.py",
            "note": (
                "Option names Klipper accepts per section type, unioned from the "
                "bundled source snapshot reads + Config_Reference.md extraction. "
                "Absence of a section = KWC makes no claim (never escalate). "
                "Superset by design; waived sections carry no record."
            ),
        },
        "sections": out_sections,
    }
    Path(args.out).write_text(json.dumps(payload, indent=1, sort_keys=True) + "\n")
    print(f"wrote {args.out}: {len(out_sections)} sections")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
