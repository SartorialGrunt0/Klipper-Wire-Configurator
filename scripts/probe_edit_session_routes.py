"""Probe which file/op routes the real EditSession ACCEPTS for a given change.

Use before writing or widening a `staged_*` criterion: the answer decides
which files the criterion must accept, and whether a question is passable at
all. Two argument-shape pitfalls this probe exists to document: `set_param`
needs `key`/`value` (not `param`), and `add_section`/`replace_section` take
the section BODY only — passing the `[header]` line is a hard failure.

Scenario below: is `printer.cfg::[respond]` a legal target, or does the existing
empty `[respond]` in mainsail.cfg make it a duplicate-section error?

Context: SETUP-05's criterion is file-scoped to printer.cfg
(`staged_section_regex printer\.cfg::respond::default_...`). Two models
edited the section in mainsail.cfg — where it actually lives — and were
scored FAIL. Before proposing a criterion change, prove which routes the
product accepts.

Run from the repo root with the backend venv:
    backend/.venv-test/bin/python scripts/probe_setup05_respond_routes.py
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

from services.ai_edit_tools import EditSession  # noqa: E402

USER_CONFIGS = REPO / "backend" / "user_configs"


def files() -> dict:
    out = {}
    for name in ("printer.cfg", "mainsail.cfg"):
        p = USER_CONFIGS / name
        if p.exists():
            out[name] = {"content": p.read_text()}
    return out


def run(label: str, args: dict) -> None:
    session = EditSession(files())
    text, _ = session.execute({"name": "config_edit", "arguments": args})
    staged = session.pending_edits_payload()
    print(f"\n=== {label}")
    print(f"  result : {str(text)[:300]}")
    print(f"  staged : {len(staged)} edit(s)")
    for e in staged:
        nt = e.get("newText") or ""
        marker = "[respond]" in nt
        print(f"    op={e.get('op')} file={e.get('file')} has_respond_section={marker}")


def main() -> None:
    # Route A — add the section to printer.cfg (what the criterion demands).
    run("A: add_section printer.cfg [respond]", {
        "file": "printer.cfg", "op": "add_section", "section": "respond",
        "new_text": "default_type: echo\ndefault_prefix: echo:",
    })

    # Route B — set a param in the section that already exists (mainsail.cfg).
    run("B: set_param mainsail.cfg [respond] default_type", {
        "file": "mainsail.cfg", "op": "set_param", "section": "respond",
        "key": "default_type", "value": "echo",
    })

    # Route C — replace the section body where it already lives.
    run("C: replace_section mainsail.cfg [respond]", {
        "file": "mainsail.cfg", "op": "replace_section", "section": "respond",
        "new_text": "[respond]\ndefault_type: echo\ndefault_prefix: echo:",
    })


if __name__ == "__main__":
    main()
