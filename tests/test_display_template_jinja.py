"""
3b (F9): display_template / display_data bodies are Jinja-validated.

Ground truth (klippy/extras/display/display.py, verified 2026-08-25):
  - DisplayTemplate:  self.template = gcode_macro.load_template(config, 'text')
  - DisplayGroup:     template = gcode_macro.load_template(c, 'text')  (per item,
    when 'text' is present)
  - gcode_macro.load_template wraps the body in TemplateWrapper using the same
    gcode Jinja environment as macros.

So both section types are Jinja templates, but their body param is 'text',
not 'gcode' — the existing _validate_macro_jinja only read the 'gcode' param,
so a broken {% if %} in a display body passed clean while the same error in a
macro was an error. The AI full-rewrite guard already treated display_template
as Jinja; the backend validator now matches it (and resolves the plan's open
question: display_data IS Jinja too).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config  # noqa: E402
from parser.validator import validate_config  # noqa: E402


def _jinja_errors(cfg_text: str) -> list:
    return [
        e for e in validate_config(parse_config(cfg_text, 'printer.cfg')).errors
        if 'Jinja template error' in e.message
    ]


def test_display_template_valid_jinja_passes():
    errors = _jinja_errors(
        "[display_template header]\n"
        "text: Target: {printer.extruder.target}C\n"
    )
    assert not errors, f"valid display_template jinja must pass, got: {[e.message for e in errors]}"


def test_display_template_unbalanced_if_is_error():
    errors = _jinja_errors(
        "[display_template header]\n"
        "text: {% if printer.toolhead.homed %}Homed\n"
    )
    assert errors, "unbalanced {% if %} in display_template must be an error"
    assert errors[0].param == "text"


def test_display_template_unbalanced_for_is_error():
    errors = _jinja_errors(
        "[display_data grp item1]\n"
        "text: {% for item in [1, 2, 3] %}\n"
        "position: 0, 0\n"
    )
    assert errors, "unbalanced {% for %} in display_data must be an error"
    assert errors[0].param == "text"


def test_display_data_valid_jinja_passes():
    # Balanced block + valid single-brace expression (Klipper uses {printer.x}
    # single-brace variables, NOT {{...}} — double braces are a parse error in
    # the gcode Jinja env).
    errors = _jinja_errors(
        "[display_data grp item1]\n"
        "text: {% if printer.display_status.message %}Msg: {printer.display_status.message}{% endif %}\n"
        "position: 0, 0\n"
    )
    assert not errors, f"valid display_data jinja must pass, got: {[e.message for e in errors]}"


def test_display_data_plain_text_passes():
    errors = _jinja_errors(
        "[display_data grp item1]\n"
        "text: plain text, no braces\n"
        "position: 0, 0\n"
    )
    assert not errors, "plain display_data text must pass"


def test_macro_jinja_still_validated():
    # The original path (gcode param) is unchanged.
    errors = _jinja_errors(
        "[gcode_macro BROKEN]\n"
        "gcode: {% if true %}\n"
        "    G28\n"
    )
    assert errors, "unbalanced macro jinja must still be an error"
    assert errors[0].param == "gcode"
