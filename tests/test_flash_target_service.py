import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from services.flash_targets import (  # noqa: E402
    _FLASH_METHOD_DFU_UTIL,
    _FLASH_METHOD_FLASHTOOL,
    _FLASH_METHOD_MAKE_FLASH,
    _truncate_help,
    delete_flash_target_artifact,
    get_flash_target_state,
    flash_flash_target,
    list_flash_target_artifacts,
    pick_primary_flash_target_artifact,
    save_flash_target_config,
    scan_flash_target_devices,
)


class _FakeSymbol:
    def __init__(self, value: str):
        self.str_value = value


class _FakeKconf:
    def __init__(self, **symbols):
        self.syms = {name: _FakeSymbol(value) for name, value in symbols.items()}
        self.loads: list[str] = []

    def load_config(self, filename):
        """Mirror kconfiglib's replace semantics: reset, then apply the file."""
        self.loads.append(str(filename))
        for sym in self.syms.values():
            sym.str_value = "n"
        try:
            text = Path(filename).read_text(encoding="utf-8")
        except OSError:
            return
        for line in text.splitlines():
            line = line.strip()
            if line.startswith("CONFIG_") and "=" in line:
                name, value = line[len("CONFIG_"):].split("=", 1)
                self.syms.setdefault(name, _FakeSymbol("n")).str_value = value

    def unset_values(self):
        for sym in self.syms.values():
            sym.str_value = "n"

    def write_config(self, filename):
        lines = [f"CONFIG_{name}={sym.str_value}" for name, sym in sorted(self.syms.items())]
        Path(filename).write_text("\n".join(lines) + "\n", encoding="utf-8")


class _CountingKconfigLib:
    """Stand-in for the vendored kconfiglib module; counts tree parses."""

    def __init__(self):
        self.kconfig_calls = 0
        self.last_kconf: _FakeKconf | None = None

    def Kconfig(self, filename):
        self.kconfig_calls += 1
        self.last_kconf = _FakeKconf()
        return self.last_kconf


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
    monkeypatch.setattr('services.flash_targets._serialize_kconfig_fields', lambda kconfiglib, kconf, help_limit=0: [])
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
    monkeypatch.setattr('services.flash_targets._serialize_kconfig_fields', lambda kconfiglib, kconf, help_limit=0: [])
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
    monkeypatch.setattr('services.flash_targets._serialize_kconfig_fields', lambda kconfiglib, kconf, help_limit=0: [])
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
    monkeypatch.setattr('services.flash_targets._serialize_kconfig_fields', lambda kconfiglib, kconf, help_limit=0: [])
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


def _fake_checkout(tmp_path, config_text: str | None = None) -> Path:
    """Create a minimal checkout with src/Kconfig so the tree cache keying works."""
    src_kconfig = tmp_path / 'src' / 'Kconfig'
    src_kconfig.parent.mkdir()
    src_kconfig.write_text('mainmenu "Test"\n', encoding='utf-8')
    (tmp_path / 'lib' / 'kconfiglib').mkdir(parents=True)
    (tmp_path / 'lib' / 'kconfiglib' / 'kconfiglib.py').write_text('', encoding='utf-8')
    if config_text is not None:
        (tmp_path / '.config').write_text(config_text, encoding='utf-8')
    return tmp_path


def _monkeypatch_state_deps(monkeypatch, checkout: Path, config_text: str | None):
    monkeypatch.setattr(
        'services.flash_targets.resolve_flash_target_checkout',
        lambda target, checkout_path=None: (checkout, None),
    )
    monkeypatch.setattr('services.flash_targets._serialize_kconfig_fields', lambda kconfiglib, kconf, help_limit=0: [])
    monkeypatch.setattr('services.flash_targets.list_usb_serial_devices', lambda: [])
    monkeypatch.setattr('services.flash_targets.list_uart_devices', lambda: [])
    monkeypatch.setattr('services.flash_targets._dfu_flash_device_candidates', lambda: [])
    monkeypatch.setattr('services.flash_targets._katapult_can_flash_device_candidates', lambda script, interface='can0': [])


def test_get_flash_target_state_reuses_cached_kconfig_tree(monkeypatch, tmp_path):
    checkout = _fake_checkout(tmp_path, config_text='CONFIG_MACH_AVR=y\n')
    fake_lib = _CountingKconfigLib()
    monkeypatch.setattr('services.flash_targets._load_kconfiglib_module', lambda module_path: fake_lib)
    _monkeypatch_state_deps(monkeypatch, checkout, None)

    state1 = get_flash_target_state('klipper', str(checkout))
    assert state1['available'] is True

    # The .config changed on disk between requests; the cached tree must pick
    # it up (fresh load_config per request) without re-parsing the Kconfig.
    (checkout / '.config').write_text('CONFIG_MACH_STM32=y\n', encoding='utf-8')
    state2 = get_flash_target_state('klipper', str(checkout))
    assert state2['available'] is True

    assert fake_lib.kconfig_calls == 1, 'Kconfig tree should be parsed once for two requests'
    kconf = fake_lib.last_kconf
    assert kconf is not None
    assert kconf.syms['MACH_STM32'].str_value == 'y'
    assert kconf.syms['MACH_AVR'].str_value == 'n', 'stale symbol from the first request leaked'
    assert len(kconf.loads) == 2, 'config must be reloaded fresh on every request'


def test_save_flash_target_config_invalidates_kconfig_cache(monkeypatch, tmp_path):
    checkout = _fake_checkout(tmp_path, config_text='CONFIG_MACH_AVR=y\n')
    fake_lib = _CountingKconfigLib()
    monkeypatch.setattr('services.flash_targets._load_kconfiglib_module', lambda module_path: fake_lib)
    _monkeypatch_state_deps(monkeypatch, checkout, None)

    get_flash_target_state('klipper', str(checkout))
    get_flash_target_state('klipper', str(checkout))
    assert fake_lib.kconfig_calls == 1

    result = save_flash_target_config('klipper', [], str(checkout))
    assert result['available'] is True
    # The save's own state read reuses the cache; the invalidation forces the
    # NEXT request to re-parse.
    get_flash_target_state('klipper', str(checkout))
    assert fake_lib.kconfig_calls == 2, 'cache entry should be invalidated after a save'


def test_get_flash_target_state_passes_help_limit_to_serializer(monkeypatch, tmp_path):
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
    captured = {}

    def fake_serialize(kconfiglib, kconf, help_limit=0):
        captured['help_limit'] = help_limit
        return []

    monkeypatch.setattr('services.flash_targets._serialize_kconfig_fields', fake_serialize)
    monkeypatch.setattr('services.flash_targets.list_usb_serial_devices', lambda: [])
    monkeypatch.setattr('services.flash_targets.list_uart_devices', lambda: [])
    monkeypatch.setattr('services.flash_targets._dfu_flash_device_candidates', lambda: [])

    get_flash_target_state('klipper', str(tmp_path), help_limit=400)
    assert captured['help_limit'] == 400

    get_flash_target_state('klipper', str(tmp_path))
    assert captured['help_limit'] == 0, 'default keeps the full-help contract'


def test_truncate_help_caps_long_text():
    assert _truncate_help('short', 400) == 'short'
    assert _truncate_help('', 400) == ''
    assert _truncate_help('x' * 500, 400) == 'x' * 400 + '…'
    assert _truncate_help('x' * 400, 400) == 'x' * 400
