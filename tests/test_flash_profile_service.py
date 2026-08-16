import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

import services.native_services as native_services  # noqa: E402


def test_save_and_load_flash_profile(monkeypatch, tmp_path):
    monkeypatch.setattr(native_services, '_LAYOUT_DIR', tmp_path)

    saved = native_services.save_flash_profile('klipper', 'AVR Profile', {
        'checkout_path': '/home/pi/klipper',
        'flash_device': '/dev/serial/by-id/usb-avr',
        'flash_method': 'flashtool',
        'assignments': [
            {'symbol': 'MACH_AVR', 'value': 'y'},
            {'symbol': 'MCU', 'value': 'atmega2560'},
        ],
    })

    loaded = native_services.load_flash_profile('klipper', 'AVR Profile')
    listed = native_services.list_flash_profiles('klipper')

    assert saved['name'] == 'AVR Profile'
    assert loaded['assignments'] == [
        {'symbol': 'MACH_AVR', 'value': 'y'},
        {'symbol': 'MCU', 'value': 'atmega2560'},
    ]
    assert listed == [
        {
            'name': 'AVR Profile',
            'target': 'klipper',
            'checkout_path': '/home/pi/klipper',
            'flash_device': '/dev/serial/by-id/usb-avr',
            'flash_method': 'flashtool',
            'assignment_count': 2,
            'created': loaded['created'],
            'modified': loaded['modified'],
        },
    ]


def test_save_flash_profile_rejects_duplicate_names(monkeypatch, tmp_path):
    monkeypatch.setattr(native_services, '_LAYOUT_DIR', tmp_path)

    native_services.save_flash_profile('katapult', 'CAN Toolhead', {
        'checkout_path': '/home/pi/katapult',
        'flash_device': 'aabbccddeeff',
        'flash_method': 'flashtool',
        'assignments': [],
    })

    try:
        native_services.save_flash_profile('katapult', 'CAN Toolhead', {
            'checkout_path': '/home/pi/katapult',
            'flash_device': 'ffeeddccbbaa',
            'flash_method': 'flashtool',
            'assignments': [],
        })
        assert False, 'Expected duplicate flash profile names to be rejected'
    except FileExistsError as exc:
        assert 'already exists' in str(exc)


def test_save_flash_profile_replaces_existing_with_overwrite(monkeypatch, tmp_path):
    monkeypatch.setattr(native_services, '_LAYOUT_DIR', tmp_path)

    native_services.save_flash_profile('katapult', 'CAN Toolhead', {
        'checkout_path': '/home/pi/katapult',
        'flash_device': 'aabbccddeeff',
        'flash_method': 'flashtool',
        'assignments': [],
    })

    replaced = native_services.save_flash_profile(
        'katapult',
        'CAN Toolhead',
        {
            'checkout_path': '/home/pi/katapult',
            'flash_device': 'ffeeddccbbaa',
            'flash_method': 'flashtool',
            'assignments': [],
        },
        overwrite=True,
    )

    assert replaced['flash_device'] == 'ffeeddccbbaa'
    loaded = native_services.load_flash_profile('katapult', 'CAN Toolhead')
    assert loaded['flash_device'] == 'ffeeddccbbaa'
    # Only the final profile file should exist — no leftover temp files.
    assert sorted(path.name for path in (tmp_path / 'flash_profiles' / 'katapult').iterdir()) == [
        'CAN%20Toolhead.json',
    ]


def test_delete_flash_profile_removes_profile(monkeypatch, tmp_path):
    monkeypatch.setattr(native_services, '_LAYOUT_DIR', tmp_path)
    native_services.save_flash_profile('klipper', 'Temporary', {
        'checkout_path': '/home/pi/klipper',
        'flash_device': '',
        'flash_method': 'make_flash',
        'assignments': [],
    })

    deleted = native_services.delete_flash_profile('klipper', 'Temporary')

    assert deleted is True
    assert native_services.list_flash_profiles('klipper') == []