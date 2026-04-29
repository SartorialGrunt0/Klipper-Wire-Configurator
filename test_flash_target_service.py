import sys

sys.path.insert(0, 'backend')

from services.flash_targets import (  # noqa: E402
    get_flash_target_state,
    list_flash_target_artifacts,
    pick_primary_flash_target_artifact,
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


def test_get_flash_target_state_surfaces_serial_flash_candidates(monkeypatch, tmp_path):
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

    assert state['flash_supported'] is True
    assert state['flash_device_candidates'] == [
        {
            'value': '/dev/serial/by-id/usb-Klipper_atmega32u4-if00',
            'label': 'USB serial: usb-Klipper_atmega32u4-if00 (/dev/ttyACM0)',
        },
        {
            'value': '/dev/ttyS0',
            'label': 'Serial: ttyS0',
        },
    ]


def test_get_flash_target_state_surfaces_dfu_candidates(monkeypatch, tmp_path):
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

    assert state['flash_supported'] is True
    assert state['flash_device_candidates'] == [
        {'value': '0483:df11', 'label': 'DFU device: 0483:df11 (STM32 DFU mode)'},
    ]