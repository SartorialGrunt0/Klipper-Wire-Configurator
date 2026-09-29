#!/usr/bin/env python3
"""Does KWC flag a mis-cased SECTION TYPE token, and does it block?

[Gcode_Macro level_bed] is the shape Clifford asked about: the type token
capitalised, the name lowercase. Klipper resolves that token to a module
filename (extras/<token>.py), so it can never load. Two questions:

  1. does the standalone validator flag it, and at what severity?
  2. does the EDIT path block it, or does the finding ride along as a
     non-blocking advisory and reach disk anyway?

Usage: backend/.venv-test/bin/python scripts/probe_casing_validation.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from parser.config_parser import parse_config  # noqa: E402
from parser.validator import validate_config  # noqa: E402
from services.ai_edit_tools import EditSession  # noqa: E402

PRINTER = ("[printer]\nkinematics: corexy\nmax_velocity: 300\n"
           "max_accel: 3000\n")

HEADERS = [
    "gcode_macro level_bed",      # control
    "Gcode_Macro level_bed",      # his case: G and M capitalised
    "Gcode_macro level_bed",      # G only
    "gcode_Macro level_bed",      # M only
    "GCODE_MACRO level_bed",      # all caps
    "Gcode_Macro Level_Bed",      # capitalised type + name
]

print("1) STANDALONE VALIDATOR — severity per header")
print("   " + "-" * 68)
for header in HEADERS:
    text = PRINTER + f"[{header}]\ngcode:\n    G28\n"
    data = validate_config(parse_config(text, "printer.cfg")).to_dict()
    findings = data.get("errors") or []
    if not findings:
        print(f"   {header:26s} -> nothing reported")
        continue
    for f in findings:
        sev = (f.get("severity") or "?").upper()
        code = f.get("code") or "-"
        msg = (f.get("message") or "").splitlines()[0][:64]
        print(f"   {header:26s} -> [{sev}] {code}: {msg}")

print()
print("2) EDIT PATH — does a mis-cased type token get blocked or staged?")
print("   " + "-" * 68)
for section in ("gcode_macro Park_Head", "Gcode_Macro Park_Head"):
    session = EditSession({"printer.cfg": {"content": PRINTER}})
    content, details = session.execute({
        "name": "config_edit",
        "arguments": {"file": "printer.cfg", "op": "add_section",
                      "section": section, "text": "gcode:\n    G28\n"},
    })
    # execute() returns (text, details); the verdict is in `content`
    # ("config_edit applied — …" vs "config_edit FAILED: …").
    outcome = "REFUSED" if "FAILED" in (content or "") else "APPLIED"
    adv = [a.get("code") for a in (details or {}).get("advisories") or []]
    payload = session.pending_edits_payload()
    landed = [line for p in payload
              for line in (p.get("newText") or "").splitlines()
              if line.strip().lower().startswith("[gcode_macro")]
    print(f"   section={section!r}")
    print(f"      {outcome}  advisories={adv}  staged={bool(payload)}")
    print(f"      staged_header={landed}")

print()
print("3) EDIT PATH — what if the MODEL's argument is mis-cased but the")
print("   section already exists? (resolution should absorb it)")
print("   " + "-" * 68)
session = EditSession({"printer.cfg": {
    "content": PRINTER + "[gcode_macro Level_Bed]\ngcode:\n    G28\n"}})
content, details = session.execute({
    "name": "config_edit",
    "arguments": {"file": "printer.cfg", "op": "set_param",
                  "section": "gcode_macro level_bed", "key": "description",
                  "value": "Levels the bed"},
})
outcome = "REFUSED" if "FAILED" in (content or "") else "APPLIED"
adv = [a.get("code") for a in (details or {}).get("advisories") or []]
print(f"   argument section='gcode_macro level_bed' (file has 'Level_Bed')")
print(f"      {outcome}  advisories={adv}")
for p in session.pending_edits_payload():
    print("      ", [ln for ln in (p.get("newText") or "").splitlines()
                     if "description" in ln or ln.startswith("[gcode_macro")])
