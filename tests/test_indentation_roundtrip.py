"""Indentation round-trip tests for gcode macro bodies and multi-line params.

The parser must preserve leading whitespace on continuation lines (gcode
bodies are conventionally indented with Jinja blocks), and the writer must
not stack an extra prefix on top of lines that already carry indentation.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config  # noqa: E402
from parser.config_writer import smart_export, write_section  # noqa: E402


INDENTED_MACRO = """# Header
[gcode_macro TEST_MACRO]
description: Test
gcode:
    G28
    {% if printer.extruder.temperature > 170 %}
        M117 Nozzle hot
    {% else %}
        M117 Nozzle cold
    {% endif %}
"""


def get_gcode_param(config, name='TEST_MACRO'):
    section = next(s for s in config.sections if s.section_type == 'gcode_macro' and s.section_name == name)
    return next(p for p in section.params if p.key == 'gcode')


def test_parser_preserves_leading_whitespace_in_multiline_values():
    config = parse_config(INDENTED_MACRO, 'printer.cfg')
    value = get_gcode_param(config).value
    assert '\n    G28' in value
    assert '\n        M117 Nozzle hot' in value
    assert '\n    {% endif %}' in value


def test_smart_export_unchanged_is_byte_identical():
    config = parse_config(INDENTED_MACRO, 'printer.cfg')
    assert smart_export(config) == INDENTED_MACRO


def test_write_section_edited_line_keeps_its_own_indentation():
    """A changed line keeps the indentation of the line it replaced."""
    original = parse_config(INDENTED_MACRO, 'printer.cfg')
    edited = parse_config(INDENTED_MACRO, 'printer.cfg')
    param = get_gcode_param(edited)
    param.value = param.value.replace('M117 Nozzle hot', 'M117 Hot!')

    rendered = write_section(edited.sections[0], original.sections[0])
    assert '        M117 Hot!' in rendered
    assert '    G28' in rendered
    # No doubled indentation anywhere
    assert '\n            ' not in rendered


def test_write_section_frontend_value_with_indentation_is_not_doubled():
    """Simulates the frontend textarea value (already indented) round-tripping."""
    original = parse_config(INDENTED_MACRO, 'printer.cfg')
    edited = parse_config(INDENTED_MACRO, 'printer.cfg')
    param = get_gcode_param(edited)
    param.value = (
        '\n    G28\n'
        '    {% if printer.extruder.temperature > 170 %}\n'
        '        M117 Hot!  # user edited this line\n'
        '    {% else %}\n'
        '        M117 Nozzle cold\n'
        '    {% endif %}'
    )

    rendered = write_section(edited.sections[0], original.sections[0])
    assert '    G28' in rendered
    assert '        M117 Hot!  # user edited this line' in rendered
    assert '    {% if printer.extruder.temperature > 170 %}' in rendered
    assert '        M117 Nozzle cold' in rendered
    # The old bug produced 8/16-space doubled indent — ensure it doesn't
    assert '            M117' not in rendered


def test_new_command_typed_at_column_0_inherits_block_indent():
    """A line inserted at column 0 (textarea Enter drops there) must be
    written with the surrounding block's indentation — a column-0 gcode
    line inside a section is a parse error in real Klipper."""
    original = parse_config(INDENTED_MACRO, 'printer.cfg')
    edited = parse_config(INDENTED_MACRO, 'printer.cfg')
    param = get_gcode_param(edited)
    param.value = (
        '\n    G28\n'
        'G1 X50\n'  # user typed at column 0
        '    {% if printer.extruder.temperature > 170 %}\n'
        '        M117 Nozzle hot\n'
        '    {% else %}\n'
        '        M117 Nozzle cold\n'
        '    {% endif %}'
    )

    rendered = write_section(edited.sections[0], original.sections[0])
    assert '    G1 X50' in rendered
    assert '\nG1 X50\n' not in rendered  # never left at column 0
    # Re-parse the rendered output: value must keep the new command
    reparsed = parse_config(rendered, 'printer.cfg')
    assert '    G1 X50' in get_gcode_param(reparsed).value


def test_flat_body_stays_flat_when_edited():
    """A macro whose body is intentionally unindented must not gain
    indentation on edit."""
    flat = """[gcode_macro FLAT]
gcode:
G28
M117 hi
"""
    original = parse_config(flat, 'printer.cfg')
    edited = parse_config(flat, 'printer.cfg')
    get_gcode_param(edited, 'FLAT').value = '\nG28\nM117 changed'
    rendered = write_section(edited.sections[0], original.sections[0])
    assert 'G28' in rendered
    assert 'M117 changed' in rendered
    assert '\n    G28' not in rendered  # no indent added to flat body
    assert '\nG28\n' in rendered


def test_tab_indented_body_round_trips():
    cfg = """[gcode_macro TABS]
gcode:
\tG28
\t{% for i in range(2) %}
\t\tG1 X{i} F3000
\t{% endfor %}
"""
    config = parse_config(cfg, 'printer.cfg')
    assert smart_export(config) == cfg
    assert '\t\tG1 X{i} F3000' in get_gcode_param(config, 'TABS').value


def test_blank_lines_inside_body_are_kept():
    cfg = """[gcode_macro BLANKY]
gcode:
    G28

    G1 X10 F3000
"""
    config = parse_config(cfg, 'printer.cfg')
    assert smart_export(config) == cfg
    assert get_gcode_param(config, 'BLANKY').value == '\n    G28\n\n    G1 X10 F3000'
