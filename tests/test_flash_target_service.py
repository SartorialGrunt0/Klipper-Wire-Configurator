import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from services.flash_targets import (  # noqa: E402
    _FLASH_METHOD_DFU_UTIL,
    _FLASH_METHOD_FLASHTOOL,
    _FLASH_METHOD_MAKE_FLASH,
    delete_flash_target_artifact,
    get_flash_target_state,
    flash_flash_target,
    list_flash_target_artifacts,
    pick_primary_flash_target_artifact,
    scan_flash_target_devices,
)


class _FakeSymbol:
    def __init__(self, value: str):
        self.str_value = value


class _FakeKconf:
    def __init__(self, **symbols):
        self.syms = {name: _FakeSymbol(value) for name, value in symbols.items()}


def test_list_flash_target_artifacts_prefers_katapult_primary_names(tmp_path):
    out_dir = tmp_path / 'out'
    out_dir.mkdir()
    (out_dir / 'katapult.bin').write_bytes(b'bin')
    (out_dir / 'katapult.uf2').write_bytes(b'uf2')
    (out_dir / 'deployer.bin').write_bytes(b'deployer')

    artifacts = list_flash_target_artifacts('katapult', tmp_path)

    assert [artifact['name'] for artifact in artifacts] == ['katapult.uf2', 'katapult.bin', 'deployer.bin']
    assert pick_primary_flash_target_artifact('katapult', artifacts)['name'] == 'katapult.uf2'


def test_get_flash_target_state_keeps_dynamic_serial_candidates_in_scan_results(monkeypatch, tmp_path):
    config_path = tmp_path / '.config'
    config_path.write_text('CONFIG_MACH_AVR=y\n', encoding='utf-8')

    monkeypatch.setattr(
        'services.flash_targets.resolve_flash_target_checkout',
        lambda target, checkout_path=None: (tmp_path, None),
    )
    monkeypatch.setattr(
        'services.flash_targets._load_target_kconfig_state',
        lambda target, checkout_path: (object(), _FakeKconf(MACH_AVR='y'), config_path),
    )
    monkeypatch.setattr('services.flash_targets._serialize_kconfig_fields', lambda kconfiglib, kconf: [])
    monkeypatch.setattr(
        'services.flash_targets.list_usb_serial_devices',
        lambda: [{
            'path': '/dev/ttyACM0',
            'description': 'usb-Klipper_atmega32u4-if00',
            'by_id': '/dev/serial/by-id/usb-Klipper_atmega32u4-if00',
        }],
    )
    monkeypatch.setattr(
        'services.flash_targets.list_uart_devices',
        lambda: [{'path': '/dev/ttyS0', 'description': 'ttyS0', 'by_id': ''}],
    )
    monkeypatch.setattr('services.flash_targets._dfu_flash_device_candidates', lambda: [])

    state = get_flash_target_state('klipper', str(tmp_path))
    scan_result = scan_flash_target_devices('klipper', str(tmp_path))

    assert state['flash_supported'] is True
    assert state['flash_device_candidates'] == []
    assert [candidate['value'] for candidate in state['flash_method_candidates']] == [_FLASH_METHOD_MAKE_FLASH]
    assert state['default_flash_method'] == _FLASH_METHOD_MAKE_FLASH

    assert scan_result == {
        'target': 'klipper',
        'candidates': [
        {
            'value': '/dev/serial/by-id/usb-Klipper_atmega32u4-if00',
            'label': 'USB serial: usb-Klipper_atmega32u4-if00 (/dev/ttyACM0)',
            'transport': 'serial',
        },
        {
            'value': '/dev/ttyS0',
            'label': 'Serial: ttyS0',
            'transport': 'serial',
        },
        ],
        'error': None,
        'cached': False,
    }


def test_get_flash_target_state_keeps_dynamic_dfu_candidates_in_scan_results(monkeypatch, tmp_path):
    monkeypatch.setattr(
        'services.flash_targets.resolve_flash_target_checkout',
        lambda target, checkout_path=None: (tmp_path, None),
    )
    monkeypatch.setattr(
        'services.flash_targets._load_target_kconfig_state',
        lambda target, checkout_path: (object(), _FakeKconf(MACH_STM32='y'), tmp_path / '.config'),
    )
    monkeypatch.setattr('services.flash_targets._serialize_kconfig_fields', lambda kconfiglib, kconf: [])
    monkeypatch.setattr(
        'services.flash_targets._dfu_flash_device_candidates',
        lambda: [{'value': '0483:df11', 'label': 'DFU device: 0483:df11 (STM32 DFU mode)'}],
    )
    monkeypatch.setattr('services.flash_targets.list_usb_serial_devices', lambda: [])
    monkeypatch.setattr('services.flash_targets.list_uart_devices', lambda: [])

    state = get_flash_target_state('katapult', str(tmp_path))
    scan_result = scan_flash_target_devices('katapult', str(tmp_path))

    assert state['flash_supported'] is True
    assert state['flash_device_candidates'] == []
    assert [candidate['value'] for candidate in state['flash_method_candidates']] == [
        _FLASH_METHOD_MAKE_FLASH,
        _FLASH_METHOD_DFU_UTIL,
    ]
    assert state['default_flash_method'] == _FLASH_METHOD_MAKE_FLASH

    assert scan_result == {
        'target': 'katapult',
        'candidates': [
            {
                'value': '0483:df11',
                'label': 'DFU device: 0483:df11 (STM32 DFU mode)',
                'transport': 'usb_id',
            },
        ],
        'error': None,
        'cached': False,
    }


def test_get_flash_target_state_surfaces_rp2040_candidates_for_katapult(monkeypatch, tmp_path):
    monkeypatch.setattr(
        'services.flash_targets.resolve_flash_target_checkout',
        lambda target, checkout_path=None: (tmp_path, None),
    )
    monkeypatch.setattr(
        'services.flash_targets._load_target_kconfig_state',
        lambda target, checkout_path: (object(), _FakeKconf(MACH_RPXXXX='y'), tmp_path / '.config'),
    )
    monkeypatch.setattr('services.flash_targets._serialize_kconfig_fields', lambda kconfiglib, kconf: [])
    monkeypatch.setattr('services.flash_targets._dfu_flash_device_candidates', lambda: [])
    monkeypatch.setattr('services.flash_targets.list_usb_serial_devices', lambda: [])
    monkeypatch.setattr('services.flash_targets.list_uart_devices', lambda: [])

    state = get_flash_target_state('katapult', str(tmp_path))

    assert state['flash_supported'] is True
    assert state['flash_device_candidates'] == [
        {
            'value': 'first',
            'label': 'Auto-detect the first RP2040 mass-storage target',
            'transport': 'mass_storage',
        },
    ]
    assert [candidate['value'] for candidate in state['flash_method_candidates']] == [_FLASH_METHOD_MAKE_FLASH]
    assert state['default_flash_method'] == _FLASH_METHOD_MAKE_FLASH


def test_get_flash_target_state_keeps_dynamic_can_candidates_in_scan_results(monkeypatch, tmp_path):
    script_path = tmp_path / 'scripts' / 'flashtool.py'
    script_path.parent.mkdir()
    script_path.write_text('#!/usr/bin/env python3\n', encoding='utf-8')

    monkeypatch.setattr(
        'services.flash_targets.resolve_flash_target_checkout',
        lambda target, checkout_path=None: (tmp_path, None),
    )
    monkeypatch.setattr(
        'services.flash_targets._load_target_kconfig_state',
        lambda target, checkout_path: (object(), _FakeKconf(MACH_STM32='y'), tmp_path / '.config'),
    )
    monkeypatch.setattr('services.flash_targets._serialize_kconfig_fields', lambda kconfiglib, kconf: [])
    monkeypatch.setattr('services.flash_targets._dfu_flash_device_candidates', lambda: [])
    monkeypatch.setattr('services.flash_targets.list_usb_serial_devices', lambda: [])
    monkeypatch.setattr('services.flash_targets.list_uart_devices', lambda: [])
    monkeypatch.setattr(
        'services.flash_targets._katapult_can_flash_device_candidates',
        lambda script, interface='can0': [{
            'value': 'aabbccddeeff',
            'label': 'CAN UUID: aabbccddeeff (can0, Katapult)',
            'transport': 'can_uuid',
            'interface': 'can0',
        }],
    )

    state = get_flash_target_state('klipper', str(tmp_path))
    scan_result = scan_flash_target_devices('klipper', str(tmp_path))

    assert state['flash_device_candidates'] == []
    assert [candidate['value'] for candidate in state['flash_method_candidates']] == [
        _FLASH_METHOD_MAKE_FLASH,
        _FLASH_METHOD_DFU_UTIL,
        _FLASH_METHOD_FLASHTOOL,
    ]
    assert state['default_flash_method'] == _FLASH_METHOD_MAKE_FLASH
    assert state['default_flash_device'] == ''

    assert scan_result == {
        'target': 'klipper',
        'candidates': [
            {
                'value': 'aabbccddeeff',
                'label': 'CAN UUID: aabbccddeeff (can0, Katapult)',
                'transport': 'can_uuid',
                'interface': 'can0',
            },
        ],
        'error': None,
        'cached': False,
    }


def test_flash_target_uses_flashtool_for_can_uuid(monkeypatch, tmp_path):
    artifacts_dir = tmp_path / 'out'
    artifacts_dir.mkdir()
    (artifacts_dir / 'klipper.bin').write_bytes(b'bin')

    script_path = tmp_path / 'scripts' / 'flashtool.py'
    script_path.parent.mkdir(exist_ok=True)
    script_path.write_text('#!/usr/bin/env python3\n', encoding='utf-8')

    monkeypatch.setattr(
        'services.flash_targets.resolve_flash_target_checkout',
        lambda target, checkout_path=None: (tmp_path, None),
    )
    monkeypatch.setattr(
        'services.flash_targets.get_flash_target_state',
        lambda target, checkout_path=None: {
            'flash_supported': True,
            'flash_reason': None,
            'default_flash_device': '',
            'default_flash_method': _FLASH_METHOD_FLASHTOOL,
            'flash_method_candidates': [
                {
                    'value': _FLASH_METHOD_FLASHTOOL,
                    'device_required': True,
                    'default_device': '',
                },
            ],
        },
    )

    captured = {}

    def fake_run(target, checkout_path, commands, timeout):
        captured['target'] = target
        captured['checkout_path'] = checkout_path
        captured['commands'] = commands
        captured['timeout'] = timeout
        return {
            'target': target,
            'display_name': 'Klipper',
            'success': True,
            'error': None,
            'log': '$ python3 scripts/flashtool.py',
            'checkout_path': str(checkout_path),
            'out_path': str(checkout_path / 'out'),
            'artifacts': [],
            'primary_artifact': None,
            'flash_device': '',
            'flash_method': '',
        }

    monkeypatch.setattr('services.flash_targets._run_commands', fake_run)

    result = flash_flash_target('klipper', str(tmp_path), 'aabbccddeeff', _FLASH_METHOD_FLASHTOOL)

    assert result['success'] is True
    assert result['flash_device'] == 'aabbccddeeff'
    assert result['flash_method'] == _FLASH_METHOD_FLASHTOOL
    assert captured['commands'][-1] == [
        'python3',
        str(script_path),
        '-i',
        'can0',
        '-f',
        str(artifacts_dir / 'klipper.bin'),
        '-u',
        'aabbccddeeff',
    ]


def test_flash_target_auto_selects_method_from_serial_device(monkeypatch, tmp_path):
    artifacts_dir = tmp_path / 'out'
    artifacts_dir.mkdir()
    (artifacts_dir / 'klipper.bin').write_bytes(b'bin')

    script_path = tmp_path / 'scripts' / 'flashtool.py'
    script_path.parent.mkdir(exist_ok=True)
    script_path.write_text('#!/usr/bin/env python3\n', encoding='utf-8')

    monkeypatch.setattr(
        'services.flash_targets.resolve_flash_target_checkout',
        lambda target, checkout_path=None: (tmp_path, None),
    )
    monkeypatch.setattr(
        'services.flash_targets.get_flash_target_state',
        lambda target, checkout_path=None: {
            'flash_supported': True,
            'flash_reason': None,
            'default_flash_device': '',
            'default_flash_method': _FLASH_METHOD_MAKE_FLASH,
            'flash_device_candidates': [
                {
                    'value': '/dev/serial/by-id/usb-test',
                    'label': 'USB serial: test',
                    'transport': 'serial',
                    'preferred_flash_method': _FLASH_METHOD_FLASHTOOL,
                },
            ],
            'flash_method_candidates': [
                {
                    'value': _FLASH_METHOD_MAKE_FLASH,
                    'device_required': True,
                    'default_device': '',
                },
                {
                    'value': _FLASH_METHOD_FLASHTOOL,
                    'device_required': True,
                    'default_device': '',
                },
            ],
        },
    )

    captured = {}

    def fake_run(target, checkout_path, commands, timeout):
        captured['commands'] = commands
        return {
            'target': target,
            'display_name': 'Klipper',
            'success': True,
            'error': None,
            'log': '$ python3 scripts/flashtool.py',
            'checkout_path': str(checkout_path),
            'out_path': str(checkout_path / 'out'),
            'artifacts': [],
            'primary_artifact': None,
            'flash_device': '',
            'flash_method': '',
        }

    monkeypatch.setattr('services.flash_targets._run_commands', fake_run)

    result = flash_flash_target('klipper', str(tmp_path), '/dev/serial/by-id/usb-test')

    assert result['success'] is True
    assert result['flash_method'] == _FLASH_METHOD_FLASHTOOL
    assert captured['commands'][-1] == [
        'python3',
        str(script_path),
        '-d',
        '/dev/serial/by-id/usb-test',
        '-f',
        str(artifacts_dir / 'klipper.bin'),
    ]


def test_delete_flash_target_artifact_removes_file(monkeypatch, tmp_path):
    out_dir = tmp_path / 'out'
    out_dir.mkdir()
    artifact = out_dir / 'klipper.bin'
    artifact.write_bytes(b'firmware')
    (out_dir / 'klipper.uf2').write_bytes(b'uf2')

    monkeypatch.setattr(
        'services.flash_targets.resolve_flash_target_checkout',
        lambda target, checkout_path=None: (tmp_path, None),
    )

    result = delete_flash_target_artifact('klipper', 'klipper.bin', str(tmp_path))

    assert artifact.exists() is False
    assert result['status'] == 'deleted'
    assert [item['name'] for item in result['artifacts']] == ['klipper.uf2']
