#!/usr/bin/env python3
"""Sweep stock example configs + Trident backup through the gcode registry
scan; report would-be warnings per file (FP survey before wiring)."""
from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from backend.parser.config_parser import parse_config_file
from backend.services.gcode_registry import (
    STATUS_CONDITIONAL_OUT,
    build_project_context,
    scan_gcode_body,
)

_GCODE_SECTION_TYPES = {"gcode_macro", "delayed_gcode"}


def sweep(tree: Path, label: str, recursive=True):
    cfgs = sorted(tree.rglob("*.cfg") if recursive else tree.glob("*.cfg"))
    cfgs = [c for c in cfgs if "klipper_backup" not in str(c)]
    configs = {}
    for p in cfgs:
        try:
            configs[str(p)] = parse_config_file(p)
        except Exception as e:
            print(f"  parse-fail {p}: {e}")
    # one context for the whole tree = project semantics (cross-file macro
    # calls are legal; Klipper loads includes into one namespace)
    ctx = build_project_context(configs)
    unknown: Counter = Counter()
    cond: Counter = Counter()
    where: dict[str, list] = {}
    for fname, cfg in configs.items():
        fctx = ctx
        for section in cfg.sections:
            if section.section_type not in _GCODE_SECTION_TYPES:
                continue
            if section.is_commented_out:
                continue
            gp = section.get_param("gcode")
            if not gp or gp.is_commented_out:
                continue
            base = gp.line_number - 1
            for rel_line, verdict in scan_gcode_body(gp.value, fctx):
                key = f"{verdict.name}"
                if verdict.status == STATUS_CONDITIONAL_OUT:
                    cond[key] += 1
                else:
                    unknown[key] += 1
                where.setdefault(key, []).append(
                    f"{Path(fname).name}:{base + rel_line}"
                    f"[{verdict.status}]")
    print(f"\n== {label}: {len(cfgs)} files ==")
    print(f"unknown: {sum(unknown.values())} occurrences, "
          f"{len(unknown)} distinct")
    for name, n in unknown.most_common(30):
        print(f"  {n:3d}  {name}  e.g. {where[name][:3]}")
    print(f"conditional_out: {sum(cond.values())} occurrences, "
          f"{len(cond)} distinct")
    for name, n in cond.most_common(15):
        print(f"  {n:3d}  {name}  e.g. {where[name][:3]}")


if __name__ == "__main__":
    sweep(REPO / "reference/Trident_backup/printer_data/config", "Trident (per-dir ctx)")
    # stock examples: each file standalone (fragment soup, worst case)
    for tree in (REPO / "reference/config",
                 REPO / "frontend/public/reference/config"):
        if tree.is_dir():
            sweep(tree, f"{tree.relative_to(REPO)} (standalone files)")
