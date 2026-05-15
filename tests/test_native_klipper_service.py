import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import services.native_services as native_services  # noqa: E402


def test_get_klippy_log_excerpt_returns_context_for_matching_section(monkeypatch, tmp_path):
    log_path = tmp_path / 'klippy.log'
    log_path.write_text(
        '\n'.join([
            'Info line 1',
            'Info line 2',
            'Config error',
            'Traceback (most recent call last):',
            'raise error("Option \'%s\' is not valid in section \'%s\'"',
            "configparser.Error: Option 'baud' is not valid in section 'mcu ebbcan'",
            'Printer is halted',
        ]),
        encoding='utf-8',
    )

    monkeypatch.setattr(native_services, '_klippy_log_candidates', lambda: [log_path])

    result = native_services.get_klippy_log_excerpt(
        section_name='mcu ebbcan',
        error_text="Option 'baud' is not valid in section 'mcu ebbcan'",
        context_lines=2,
    )

    assert result['log_path'] == str(log_path)
    assert "configparser.Error: Option 'baud' is not valid in section 'mcu ebbcan'" in result['excerpt']
    assert 'Traceback (most recent call last):' in result['excerpt']
    assert result['matched_on'] in {'mcu ebbcan', "option 'baud' is not valid in section 'mcu ebbcan'", "section 'mcu ebbcan'", 'baud'}