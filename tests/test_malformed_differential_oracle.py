"""Differential parity: find_malformed_lines vs the configparser oracle.

KWC's column-0 garbage detector must agree with what configparser actually
rejects (Klipper loads every file through it). Parametrized over the raw
line shapes that appear in real configs; each case asserts BOTH directions:
flagged iff configparser raises ParsingError naming that line.
"""
import configparser
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import find_malformed_lines  # noqa: E402

# (label, inserted line, expect_flagged)
SHAPES = [
    ("bare prose", "Some bare prose line", True),
    ("separator eq", "=======", True),
    ("separator dash", "-------", True),
    ("bare word", "SOMEWORD", True),
    ("prose with colon", "Did you read: yes", False),  # cfg: option line
    ("bare jinja tag", "{% if true %}", True),
    ("bare jinja expr", "{{ myvar }}", True),
    ("indented continuation", "    continuation", False),
    ("tab continuation", "\tcontinuation", False),
    ("hash comment", "# note", False),
    ("semi comment", "; note", False),
    ("commented section", "#[old_sec]", False),
    ("commented param", "#key: val", False),
    ("save-config tail", "#*# position_endstop: 0.3", False),
    ("key colon value", "key: value", False),
    ("key equals", "key = value", False),
    ("key no space", "key:value", False),
    ("leading colon", ":foo", True),
    ("leading equals", "=foo", True),
    ("odd key chars", "key@name!x: 1", False),  # cfg accepts; unknown_param owns it
    ("section header", "[new_section]", False),
    ("named section", "[gcode_macro FOO]", False),
    ("include", "[include x.cfg]", False),
    ("unclosed header", "[mcu", False),  # unclosed_section_header owns it
    ("empty line", "", False),
    ("whitespace only", "   ", False),
    ("dollar var", "$HOME", True),
    ("backtick", "`cmd`", True),
    ("percent fmt", "%d items", True),
    ("number line", "12345", True),
]


def _cfg_rejects_line3(text):
    cp = configparser.RawConfigParser(
        strict=False, inline_comment_prefixes=(';', '#'))
    try:
        cp.read_string(text, "t.cfg")
        return False
    except configparser.Error as e:
        return bool(re.search(r"\[line\s+3\]", str(e)))


@pytest.mark.parametrize("label,line,expect", SHAPES,
                         ids=[s[0] for s in SHAPES])
def test_parity_with_configparser(label, line, expect):
    text = f"[stepper_x]\nmicrosteps: 16\n{line}\nnext_key: 1\n"
    flagged = any(ln == 3 for ln, _ in find_malformed_lines(text))
    assert flagged == expect, label
    if label == "unclosed header":
        # Intentional delegation: configparser rejects it, but the
        # dedicated unclosed_section_header check owns the finding — a
        # line must get exactly ONE error, not two.
        return
    # oracle direction: flagged <=> configparser names the line
    assert flagged == _cfg_rejects_line3(text), (
        f"{label}: detector={flagged} but configparser-named="
        f"{_cfg_rejects_line3(text)}")


def test_all_content_before_first_section_flagged():
    # MissingSectionHeaderError has no line pin, but EVERY content line
    # before the first header aborts the load.
    hits = find_malformed_lines("Ok great.\nsecond line.\n[printer]\n")
    assert [ln for ln, _ in hits] == [1, 2]
