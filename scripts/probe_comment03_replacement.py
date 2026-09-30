"""Verify which [printer] parameter can actually be commented out (COMMENT-03 redesign).

COMMENT-03 asks the model to comment out `max_accel` in [printer] — which the
validator rejects (required param). This probes candidate replacement lines to
find one that stages cleanly.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from services.ai_edit_tools import EditSession  # noqa: E402

FIXTURE = (Path(__file__).resolve().parents[1] / "reference" / "Trident_backup"
           / "printer_data" / "config" / "printer.cfg")
text = FIXTURE.read_text(encoding="utf-8")

CANDIDATES = [
    ("max_accel (current COMMENT-03 target)", "max_accel: 15500 #Ellis Tuned"),
    ("max_z_velocity", "max_z_velocity: 15"),
    ("max_z_accel", "max_z_accel: 350"),
    ("square_corner_velocity", "square_corner_velocity: 5.0"),
]

for label, line in CANDIDATES:
    if line not in text:
        print(f"{label:40s} -> ANCHOR NOT IN FIXTURE")
        continue
    session = EditSession({"printer.cfg": {"content": text}})
    result_text, _ = session.execute({
        "name": "config_edit",
        "arguments": {"file": "printer.cfg", "op": "patch_section", "section": "printer",
                      "old_text": line, "new_text": "#" + line},
    })
    staged = session.pending_edits_payload()
    verdict = "ACCEPTED + staged" if staged else "REJECTED"
    print(f"{label:40s} -> {verdict}")
    if not staged:
        detail = [l.strip() for l in (result_text or "").splitlines() if "missing" in l or "Empty" in l]
        print(f"{'':40s}    {detail}")
    session.close() if hasattr(session, "close") else None
