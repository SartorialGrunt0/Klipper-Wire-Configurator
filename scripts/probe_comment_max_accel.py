"""Empirical check: does the KWC edit pipeline ACCEPT commenting out a line?

Drives the real EditSession (same code path the backend uses) against the
harness's printer.cfg fixture, for several candidate strategies.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from services.ai_edit_tools import EditSession  # noqa: E402
from services.ai_draft_project import ProjectState  # noqa: E402

FIXTURE = Path(__file__).resolve().parents[1] / "reference" / "Trident_backup" / "printer_data" / "config" / "printer.cfg"
text = FIXTURE.read_text(encoding="utf-8")

ACTIVE = "max_accel: 15500 #Ellis Tuned"
COMMENTED = "#max_accel: 15500 #Ellis Tuned"
print("fixture has active line:", ACTIVE in text, "| already-commented form:", COMMENTED in text)

CASES = [
    ("patch_section (anchor the active line)",
     {"file": "printer.cfg", "op": "patch_section", "section": "printer",
      "old_text": ACTIVE, "new_text": COMMENTED}),
    ("patch_section (op=comment_line style guess)",
     {"file": "printer.cfg", "op": "patch_section", "section": "printer",
      "old_text": ACTIVE, "new_text": "# " + ACTIVE}),
    ("set_param with a '#'-prefixed value (wrong tool)",
     {"file": "printer.cfg", "op": "set_param", "section": "printer",
      "key": "max_accel", "value": "#15500"}),
]

for label, args in CASES:
    print("\n" + "=" * 72)
    print("CASE:", label)
    session = EditSession({"printer.cfg": {"content": text}})
    name = "config_edit"
    tool_call = {"name": name, "arguments": args}
    try:
        result_text, result = session.execute(tool_call)
    except Exception as exc:  # noqa: BLE001
        print("  EXCEPTION:", type(exc).__name__, exc)
        continue
    print("  result_text:", (result_text or "")[:600])
    print("  ok:", (result or {}).get("ok"), "| error:", (result or {}).get("error"))
    pe = session.pending_edits_payload()
    print("  staged ops:", [(p["file"], p["op"], p["summary"][:90]) for p in pe])
    if pe:
        body = pe[0].get("newText", "")
        line = [l for l in body.splitlines() if "15500" in l]
        print("  resulting 15500 line(s):", line)
