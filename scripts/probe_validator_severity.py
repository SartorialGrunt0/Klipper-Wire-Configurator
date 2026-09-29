#!/usr/bin/env python3
"""Does KWC's info/warn/error schema catch each failure shape?

Drives the real validator (parser/validator.py) — the same entry point the
/validate and /validate-project routes use — over the defect shapes that
came out of the 2026-09-28 bank sweep plus the Klipper config-load
hard-fails they map to. Prints severity + code per finding.

Usage: backend/.venv-test/bin/python scripts/probe_validator_severity.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from parser.config_parser import parse_config  # noqa: E402
from parser.validator import validate_config  # noqa: E402

BASE_PRINTER = ("[printer]\nkinematics: corexy\nmax_velocity: 300\n"
                "max_accel: 3000\n\n")

# A complete, valid bed_mesh+probe base so the ONLY variable under test is
# the gcode parameter value (an incomplete base floods the result with
# required-parameter errors and masks it).
MESH_BASE = (BASE_PRINTER
             + "[probe]\npin: PB1\nx_offset: 0\ny_offset: 0\nz_offset: 0\n"
               "speed: 5\n\n"
             + "[bed_mesh]\nspeed: 100\nmesh_min: 20,20\nmesh_max: 200,200\n"
               "probe_count: 5,5\n\n")

CASES = [
    ("mis-cased TYPE token  [Gcode_Macro x]",
     "[Gcode_Macro LEVEL_BED1]\ngcode:\n    G28\n",
     "Klipper: 'Unable to load module' — hard fail"),
    ("dropped family prefix  [level_bed1]",
     "[level_bed1]\ngcode:\n    G28\n",
     "Klipper: unknown section — hard fail"),
    ("case-variant duplicate  [printer]+[Printer]",
     BASE_PRINTER + "[Printer]\nmax_accel: 4000\n",
     "Klipper: 'Printer' is not a loadable module — hard fail"),
    ("param-as-section  [pressure_advance]",
     BASE_PRINTER + "[pressure_advance]\npressure_advance: 0.05\n",
     "Klipper: unknown section — hard fail"),
    ("hallucinated gcode command  SMART_PARK",
     BASE_PRINTER + "[gcode_macro X]\ngcode:\n    SMART_PARK\n",
     "Klipper: unknown command at RUN time"),
    ("hallucinated command + valid section  SET_LED",
     BASE_PRINTER + "[led my_led]\nred_pin: PB0\n\n"
                    "[gcode_macro X]\ngcode:\n    SET_LED LED=my_led RED=1 GREEN=0\n",
     "Klipper: runs fine (control — must NOT be flagged)"),
    ("case-variant macro duplicate  [gcode_macro A]+[gcode_macro a]",
     BASE_PRINTER + "[gcode_macro Level_Bed]\ngcode:\n    G28\n\n"
                    "[gcode_macro level_bed]\ngcode:\n    G28\n",
     "Klipper: same alias -> 'already registered' at connect"),
    ("bool-ish param value  adaptive=true  (valid base)",
     MESH_BASE + "[gcode_macro X]\ngcode:\n    BED_MESH_CALIBRATE adaptive=true\n",
     "Klipper: int('true') -> error at run time"),
    ("valid control  adaptive=1  (valid base)",
     MESH_BASE + "[gcode_macro X]\ngcode:\n    BED_MESH_CALIBRATE adaptive=1\n",
     "Klipper: fine (control — must NOT be flagged)"),
    ("unknown section  [not_a_real_section]",
     BASE_PRINTER + "[not_a_real_section]\nfoo: 1\n",
     "Klipper: unknown section — hard fail"),
    ("required param missing  [printer] w/o max_accel",
     "[printer]\nkinematics: corexy\nmax_velocity: 300\n",
     "Klipper: must be specified — hard fail"),
    ("rename_existing self-collision",
     BASE_PRINTER + "[gcode_macro PROBE_ACCURACY]\nrename_existing: PROBE_ACCURACY\n"
                    "gcode:\n    G28\n",
     "Klipper: 'already registered' at connect"),
]

for label, text, klipper in CASES:
    config = parse_config(text, "printer.cfg")
    result = validate_config(config)
    data = result.to_dict()
    findings = data.get("errors") or data.get("findings") or []
    print("=" * 76)
    print(f"CASE   {label}")
    print(f"       ({klipper})")
    if not findings:
        print("  -> NOTHING REPORTED")
        continue
    for f in findings:
        sev = (f.get("severity") or "?").upper()
        code = f.get("code") or f.get("error_code") or "-"
        msg = (f.get("message") or "").splitlines()[0][:96]
        print(f"  [{sev:7s}] {code:34s} {msg}")
