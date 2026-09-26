"""rename_existing semantics + builtin-shadow registration (Klipper fails).

Ground truth (fixture-proven against real klippy, 2026-09-25):
  * [gcode_macro X] with NO rename_existing where X is a registered stock
    command -> "gcode command X already registered" at LOAD (gcode.py:142).
    This is the user-reported error text.
  * rename_existing target that is gated OUT (its requires_sections absent)
    -> "Existing command 'X' not found in gcode_macro rename" at CONNECT
    (gcode_macro.py:166).
  * rename_existing type mismatch: traditional (G/M+number) vs word, either
    direction -> "rename of different types" at LOAD (gcode_macro.py:138).
  * rename_existing value with embedded whitespace (indented multi-line
    wrap) -> "Can't register ... invalid name" at CONNECT (gcode.py:146).
  * rename_existing option present-but-EMPTY -> Klipper's branch is
    `is not None`, so it takes the rename path with an empty target:
    fails at CONNECT ("Can't register '' ... invalid name" / "not
    found in gcode_macro rename"). Option ABSENT = plain macro.
  * duplicate [gcode_macro X] headers MERGE (RawConfigParser
    strict=False): one merged section, one registration, loads clean.

Severity: warning for all of it — a third-party plugin can register (or
rename) names the stock registry can't see, and false-ERRORs that block
saves violate the validator trust contract. Ghost unknown targets stay
silent for the same reason.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config  # noqa: E402
from parser.validator import validate_config, validate_project_configs  # noqa: E402

CODE = "rename_existing_invalid"
PROBE = "[probe]\npin: ^PG1\nz_offset: 2.0\nspeed: 5.0\n\n"


def _findings(text, code=CODE):
    r = validate_config(parse_config(text, "printer.cfg"))
    return [e for e in r.errors if e.code == code]


# ── shadow: macro over a stock command without renaming ────────────────

def test_shadow_stock_command_warns():
    text = PROBE + "[gcode_macro PROBE_ACCURACY]\ngcode:\n  M114\n"
    fs = _findings(text)
    assert len(fs) == 1
    assert fs[0].severity == "warning"
    assert "already registered" in fs[0].message
    assert fs[0].section == "gcode_macro PROBE_ACCURACY"
    assert fs[0].line_number == 6  # header line (PROBE is 5 lines)


def test_shadow_clean_with_rename():
    text = PROBE + ("[gcode_macro PROBE_ACCURACY]\n"
                    "rename_existing: _PROBE_ACCURACY\ngcode:\n  M114\n")
    assert _findings(text) == []


def test_shadow_gate_absent_clean():
    # No [probe] in project -> stock PROBE_ACCURACY never registers ->
    # a plain macro of that name loads clean.
    text = "[gcode_macro PROBE_ACCURACY]\ngcode:\n  M114\n"
    assert _findings(text) == []


# ── rename target validity + type matching ─────────────────────────────

def test_rename_type_mismatch_warns():
    text = PROBE + ("[gcode_macro PROBE_ACCURACY]\n"
                    "rename_existing: G29\ngcode:\n  M114\n")
    fs = _findings(text)
    assert len(fs) == 1 and "different types" in fs[0].message


def test_rename_trad_pair_clean():
    # G29 -> G29.1: both traditional (is_traditional('G29.1') is True;
    # fixture trad2.cfg passes Klipper's checks). G29 registers only with
    # [probe] present, so the fixture carries one.
    text = PROBE + "[gcode_macro G29]\nrename_existing: G29.1\ngcode:\n  M114\n"
    assert _findings(text) == []


def test_rename_trad_to_word_mismatch_warns():
    # ground truth fixture trad.cfg: "rename of different types
    # ('G29' vs 'G29_OLD')" — word names are NOT traditional
    text = "[gcode_macro G29]\nrename_existing: G29_OLD\ngcode:\n  M114\n"
    fs = _findings(text)
    assert len(fs) == 1 and "different types" in fs[0].message


def test_rename_ghost_target_clean():
    # unknown everywhere -> stays silent (plugin extra possibility)
    text = PROBE + ("[gcode_macro FOO]\n"
                    "rename_existing: FOO_BASE_NOPE\ngcode:\n  M114\n")
    assert _findings(text) == []


def test_rename_alias_gated_out_warns():
    # SET_LED registers only when a led-family section loads. Without one
    # there is nothing to rename -> Klipper fails at connect with
    # "Existing command 'SET_LED' not found in gcode_macro rename".
    text = PROBE + ("[gcode_macro SET_LED]\n"
                    "rename_existing: SET_LED_OLD\ngcode:\n  M114\n")
    fs = _findings(text)
    assert len(fs) == 1 and "SET_LED" in fs[0].message


def test_rename_alias_gate_satisfied_project_wide_clean():
    # gate satisfied by a DIFFERENT file: one namespace at load.
    files = {
        "printer.cfg": ("[gcode_macro SET_LED]\n"
                        "rename_existing: SET_LED_OLD\ngcode:\n  M114\n"),
        "leds.cfg": "[neopixel leds]\npin: PA0\ndata_pin: PA0\nchain_count: 1\n",
    }
    configs = {n: parse_config(t_, n) for n, t_ in files.items()}
    results = validate_project_configs(configs)
    assert not [e for r in results.values()
                for e in r.errors if e.code == CODE]


def test_rename_whitespace_value_warns():
    text = PROBE + ("[gcode_macro PROBE_ACCURACY]\n"
                    "rename_existing: \n    PROBE_ACCURACY\ngcode:\n  M114\n")
    fs = _findings(text)
    assert len(fs) == 1 and "invalid" in fs[0].message


def test_rename_option_present_but_empty_warns():
    # `rename_existing:` with no value still takes Klipper's rename branch
    # (the check is `is not None`); register_command('') then rejects the
    # empty name at connect. Source-simulated 2026-09-25.
    text = PROBE + ("[gcode_macro PROBE_ACCURACY]\nrename_existing:\n"
                    "gcode:\n  M114\n")
    fs = _findings(text)
    assert len(fs) == 1 and "invalid" in fs[0].message


def test_option_absent_plain_macro_clean():
    text = PROBE + "[gcode_macro FOO]\ngcode:\n  M114\n"
    assert _findings(text) == []


def test_duplicate_macro_headers_merge_clean():
    # RawConfigParser(strict=False) MERGES the two [gcode_macro FOO]
    # definitions into ONE section (gcode union, last-wins per option):
    # one registration, loads clean. Fixture-proven (dupreg.cfg).
    text = PROBE + ("[gcode_macro FOO]\ngcode:\n  M114\n\n"
                    "[gcode_macro FOO]\ngcode:\n  M115\n")
    assert _findings(text) == []


# ── project-level: cross-file macro calls stay clean; scan runs on
#    project context, not per-file fragments ────────────────────────────

def test_project_wide_gate_satisfied_clean():
    files = {
        "printer.cfg": "[gcode_macro LIGHTS]\nrename_existing: SET_LED\ngcode:\n  M114\n",
        "leds.cfg": "[neopixel leds]\npin: PA0\ndata_pin: PA0\nchain_count: 1\n",
    }
    configs = {n: parse_config(t, n) for n, t in files.items()}
    results = validate_project_configs(configs)
    assert not [e for r in results.values() for e in r.errors if e.code == CODE]


def test_ai_loop_consumers_stay_exempt():
    text = PROBE + "[gcode_macro PROBE_ACCURACY]\ngcode:\n  M114\n"
    r = validate_config(parse_config(text, "printer.cfg"), gcode_registry=False)
    assert not [e for e in r.errors if e.code == CODE]
