#!/usr/bin/env python3
"""Does KWC's validator flag the fixture's duplicate [idle_timeout] — and at
what severity?

Context (bank106-r2 spot re-run, 2026-09-29): SETUP-02 asks to shorten "my
idle timeout", and 4 of 6 models edited `Hotkey.cfg` rather than the copy in
`printer.cfg` — one of them explicitly justifying it as "the section that
actually takes effect since it's the last [idle_timeout] in load order". The
bank's own source comments call the duplicate an *info*-level finding. This
probe drives the real validator over the actual user-config mirror to settle
whether "which copy" is genuinely ambiguous (info) or a hard error (either
copy is wrong).

Usage: backend/.venv-test/bin/python scripts/probe_duplicate_idle_timeout.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from parser.config_parser import parse_config  # noqa: E402
from parser.validator import validate_config  # noqa: E402

MIRROR = Path(__file__).resolve().parents[1] / "backend" / "user_configs"


def main() -> None:
    printer = (MIRROR / "printer.cfg").read_text(encoding="utf-8")
    hotkey = (MIRROR / "Hotkey.cfg").read_text(encoding="utf-8")

    print("printer.cfg has [idle_timeout]:", "[idle_timeout]" in printer)
    print("Hotkey.cfg  has [idle_timeout]:", "[idle_timeout]" in hotkey)

    # Validate the two files TOGETHER, the way Klipper merges includes.
    for label, config in (
        ("printer.cfg alone", printer),
        ("printer.cfg + Hotkey.cfg (merged, as KWC validates a project)",
         printer + "\n" + hotkey),
    ):
        cfg = parse_config(config)
        result = validate_config(cfg)
        findings = list(result.errors)
        dup = [f for f in findings if "idle_timeout" in (f.section or "")]
        print(f"\n=== {label}")
        print(f"  findings: {len(findings)} | has_errors={result.has_errors} "
              f"has_warnings={result.has_warnings}")
        if not dup:
            print("  no [idle_timeout]-related finding")
        for f in dup:
            print(f"  {f.severity:7s} {f.code:22s} {f.message[:120]}")
        if dup and label.startswith("printer.cfg +"):
            print("\n  ^ severity 'info' means the duplicate is NOT an error to KWC,")
            print("    and the message states the SEMANTICS: the later definition")
            print("    wins — which is exactly the load-order argument one model")
            print("    gave for editing the Hotkey.cfg copy.")


if __name__ == "__main__":
    main()
