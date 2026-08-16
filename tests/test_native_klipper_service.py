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


def test_klipper_service_stop_command_none_when_inactive(monkeypatch):
    monkeypatch.setattr(native_services, 'klipper_service_state', lambda: 'inactive')
    assert native_services.klipper_service_stop_command() is None


def test_klipper_service_stop_command_when_active(monkeypatch):
    monkeypatch.setattr(native_services, 'klipper_service_state', lambda: 'active')
    command = native_services.klipper_service_stop_command()
    assert command is not None
    assert command[-2:] == ['stop', 'klipper']


def test_klipper_service_start_command_shape(monkeypatch):
    monkeypatch.setattr(native_services, 'klipper_service_state', lambda: 'active')
    command = native_services.klipper_service_start_command()
    assert command is not None
    assert command[-2:] == ['start', 'klipper']


def test_klipper_service_can_control_as_root(monkeypatch):
    monkeypatch.setattr(native_services.os, 'geteuid', lambda: 0)
    assert native_services.klipper_service_can_control() is True


def test_klipper_service_can_control_with_passwordless_sudo(monkeypatch):
    monkeypatch.setattr(native_services.os, 'geteuid', lambda: 1000)
    monkeypatch.setattr(
        native_services.subprocess, 'run',
        lambda *args, **kwargs: type('_C', (), {'returncode': 0})(),
    )
    assert native_services.klipper_service_can_control() is True


def test_klipper_service_can_control_without_sudo(monkeypatch):
    monkeypatch.setattr(native_services.os, 'geteuid', lambda: 1000)
    monkeypatch.setattr(
        native_services.subprocess, 'run',
        lambda *args, **kwargs: type('_C', (), {'returncode': 1})(),
    )
    assert native_services.klipper_service_can_control() is False


def test_klipper_service_state_unknown_service(monkeypatch):
    class _Completed:
        stdout = ''
        stderr = 'Unit klipper.service could not be found.'
        returncode = 4

    def _fake_run(*args, **kwargs):
        return _Completed()

    monkeypatch.setattr(native_services.subprocess, 'run', _fake_run)
    assert native_services.klipper_service_state() == ''