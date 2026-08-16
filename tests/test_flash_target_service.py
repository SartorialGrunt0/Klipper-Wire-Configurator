import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from services.flash_targets import (  # noqa: E402
    _FLASH_METHOD_DFU_UTIL,
    _FLASH_METHOD_FLASHTOOL,
    _FLASH_METHOD_MAKE_FLASH,
    _is_dfu_util_success,
    _resolve_dfu_util_flash_command,
    _truncate_help,
    delete_flash_target_artifact,
    get_flash_field_help,
    get_flash_target_state,
    flash_flash_target,
    list_flash_target_artifacts,
    pick_primary_flash_target_artifact,
    plan_flash_flash_job,
    save_flash_target_config,
    scan_flash_target_devices,
)

import services.flash_targets as flash_targets  # noqa: E402


class _FakeSymbol:
    def __init__(self, value: str):
        self.str_value = value
        self.nodes: list[_FakeMenuNode] = []


class _FakeMenuNode:
    def __init__(self, help_text: str = "", prompt=("Prompt", None), filename: str = "Kconfig", linenr: int = 1):
        self.help = help_text
        self.prompt = prompt
        self.filename = filename
        self.linenr = linenr


class _FakeKconf:
    def __init__(self, nodes: list[_FakeMenuNode] | None = None, **symbols):
        self.syms = {name: _FakeSymbol(value) for name, value in symbols.items()}
        self._nodes = list(nodes or [])
        self.loads: list[str] = []

    def node_iter(self):
        return iter(self._nodes)

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
    monkeypatch.setattr('services.flash_targets._rp2040_usb_flash_device_candidates', lambda: [])

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
    monkeypatch.setattr('services.flash_targets._rp2040_usb_flash_device_candidates', lambda: [])
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
    monkeypatch.setattr('services.flash_targets._rp2040_usb_flash_device_candidates', lambda: [])
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
    monkeypatch.setattr('services.flash_targets.klipper_service_stop_command', lambda: None)

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
    monkeypatch.setattr('services.flash_targets.klipper_service_stop_command', lambda: None)

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


def test_get_flash_field_help_returns_full_text_for_symbol(monkeypatch, tmp_path):
    full_help = 'FULL HELP ' + 'x' * 500
    node = _FakeMenuNode(help_text=full_help, filename='Kconfig', linenr=42)
    kconf = _FakeKconf(MACH_AVR='y')
    kconf.syms['MACH_AVR'].nodes = [node]

    monkeypatch.setattr(
        'services.flash_targets.resolve_flash_target_checkout',
        lambda target, checkout_path=None: (tmp_path, None),
    )
    monkeypatch.setattr(
        'services.flash_targets._load_target_kconfig_state',
        lambda target, checkout_path: (object(), kconf, tmp_path / '.config'),
    )

    result = get_flash_field_help('klipper', 'MACH_AVR', str(tmp_path))

    assert result == {'field_id': 'MACH_AVR', 'help': full_help}
    assert len(result['help']) > 400, 'full help must not be truncated'


def test_get_flash_field_help_resolves_choice_ids(monkeypatch, tmp_path):
    full_help = 'Choice help text'
    node = _FakeMenuNode(help_text=full_help, filename='Kconfig', linenr=42)
    kconf = _FakeKconf(nodes=[node])

    monkeypatch.setattr(
        'services.flash_targets.resolve_flash_target_checkout',
        lambda target, checkout_path=None: (tmp_path, None),
    )
    monkeypatch.setattr(
        'services.flash_targets._load_target_kconfig_state',
        lambda target, checkout_path: (object(), kconf, tmp_path / '.config'),
    )

    result = get_flash_field_help('klipper', 'choice:Kconfig:42', str(tmp_path))

    assert result == {'field_id': 'choice:Kconfig:42', 'help': full_help}


def test_get_flash_field_help_returns_empty_for_unknown(monkeypatch, tmp_path):
    kconf = _FakeKconf(MACH_AVR='y')

    monkeypatch.setattr(
        'services.flash_targets.resolve_flash_target_checkout',
        lambda target, checkout_path=None: (tmp_path, None),
    )
    monkeypatch.setattr(
        'services.flash_targets._load_target_kconfig_state',
        lambda target, checkout_path: (object(), kconf, tmp_path / '.config'),
    )

    assert get_flash_field_help('klipper', 'NO_SUCH_SYMBOL', str(tmp_path)) == {
        'field_id': 'NO_SUCH_SYMBOL',
        'help': '',
    }
    assert get_flash_field_help('klipper', 'choice:bad', str(tmp_path)) == {
        'field_id': 'choice:bad',
        'help': '',
    }


class _FakeCompleted:
    def __init__(self, returncode: int = 0, stdout: str = '', stderr: str = ''):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def _write_bin_artifact(root: Path) -> Path:
    artifact = root / 'out' / 'klipper.bin'
    artifact.parent.mkdir(parents=True)
    artifact.write_bytes(b'\x00' * 16)
    return artifact


def test_dfu_util_fallback_used_when_make_fails_but_device_listed(monkeypatch, tmp_path):
    artifact = _write_bin_artifact(tmp_path)
    calls: list[list[str]] = []

    def fake_run(command, **kwargs):
        calls.append(command)
        if command[0] == 'make':
            return _FakeCompleted(returncode=1, stderr='make: *** No rule to make target')
        return _FakeCompleted(
            stdout='Found DFU: [0483:df11] ver=2200, devnum=13, cfg=1, alt=0, name="STM32 BOOTLOADER"'
        )

    monkeypatch.setattr('services.flash_targets.subprocess.run', fake_run)

    command, error, log = _resolve_dfu_util_flash_command(tmp_path, '0483:df11', artifact)

    assert command == [
        'dfu-util', '-d', ',0483:df11', '-R', '-a', '0', '-s', '0x08000000:leave', '-D', str(artifact),
    ]
    assert error is None
    assert ['dfu-util', '-l'] in calls


def test_dfu_util_fallback_used_when_make_parses_no_token(monkeypatch, tmp_path):
    artifact = _write_bin_artifact(tmp_path)
    calls: list[list[str]] = []

    def fake_run(command, **kwargs):
        calls.append(command)
        if command[0] == 'make':
            return _FakeCompleted(returncode=0, stdout='make: Nothing to be done for `flash`.')
        return _FakeCompleted(stdout='Found DFU: [0483:df11] ver=2200')

    monkeypatch.setattr('services.flash_targets.subprocess.run', fake_run)

    command, error, log = _resolve_dfu_util_flash_command(tmp_path, '0483:df11', artifact)

    assert command == [
        'dfu-util', '-d', ',0483:df11', '-R', '-a', '0', '-s', '0x08000000:leave', '-D', str(artifact),
    ]
    assert error is None


def test_dfu_util_fallback_uses_kconf_application_address(monkeypatch, tmp_path):
    artifact = _write_bin_artifact(tmp_path)
    (tmp_path / '.config').write_text(
        'CONFIG_MACH_STM32=y\nCONFIG_FLASH_APPLICATION_ADDRESS=0x08004000\n',
        encoding='utf-8',
    )

    def fake_run(command, **kwargs):
        if command[0] == 'make':
            return _FakeCompleted(returncode=1)
        return _FakeCompleted(stdout='Found DFU: [0483:df11] ver=2200')

    monkeypatch.setattr('services.flash_targets.subprocess.run', fake_run)

    command, error, log = _resolve_dfu_util_flash_command(tmp_path, '0483:df11', artifact)

    assert command == [
        'dfu-util', '-d', ',0483:df11', '-R', '-a', '0', '-s', '0x08004000:leave', '-D', str(artifact),
    ]
    assert error is None


def test_dfu_util_fallback_rejects_when_device_not_listed(monkeypatch, tmp_path):
    artifact = _write_bin_artifact(tmp_path)

    def fake_run(command, **kwargs):
        if command[0] == 'make':
            return _FakeCompleted(returncode=1)
        return _FakeCompleted(stdout='No DFU capable USB device available')

    monkeypatch.setattr('services.flash_targets.subprocess.run', fake_run)

    command, error, log = _resolve_dfu_util_flash_command(tmp_path, '0483:df11', artifact)

    assert command is None
    assert error is not None
    assert '0483:df11' in error


def test_dfu_util_fallback_rejects_when_no_artifact(monkeypatch, tmp_path):
    missing_artifact = tmp_path / 'out' / 'missing.bin'
    dfu_util_called = []

    def fake_run(command, **kwargs):
        if command[0] == 'make':
            return _FakeCompleted(returncode=1)
        dfu_util_called.append(command)
        return _FakeCompleted(stdout='Found DFU: [0483:df11]')

    monkeypatch.setattr('services.flash_targets.subprocess.run', fake_run)

    command, error, log = _resolve_dfu_util_flash_command(tmp_path, '0483:df11', missing_artifact)

    assert command is None
    assert error is not None
    # Without an artifact the fallback must not even list devices.
    assert dfu_util_called == []


def test_dfu_util_make_resolution_still_preferred(monkeypatch, tmp_path):
    artifact = _write_bin_artifact(tmp_path)
    calls: list[list[str]] = []

    def fake_run(command, **kwargs):
        calls.append(command)
        if command[0] == 'make':
            return _FakeCompleted(stdout=f'dfu-util -a 0 -R -D {artifact}')
        return _FakeCompleted(stdout='Found DFU: [0483:df11]')

    monkeypatch.setattr('services.flash_targets.subprocess.run', fake_run)

    command, error, log = _resolve_dfu_util_flash_command(tmp_path, '0483:df11', artifact)

    assert command == ['dfu-util', '-a', '0', '-R', '-D', str(artifact)]
    assert error is None
    assert ['dfu-util', '-l'] not in calls


def test_is_dfu_util_success_detects_downloaded_marker():
    assert _is_dfu_util_success(
        ['dfu-util', '-d', ',0483:df11', '-D', 'x.bin'],
        'Download done.\nFile downloaded successfully\n',
    ) is True
    assert _is_dfu_util_success(['dfu-util', '-l'], 'Found DFU: [0483:df11]') is False
    assert _is_dfu_util_success(['make', 'flash'], 'File downloaded successfully') is False
    assert _is_dfu_util_success(['dfu-util', '-D', 'x.bin'], 'download failed') is False


def test_plan_flash_flash_job_wraps_commands_with_klipper_service(monkeypatch, tmp_path):
    checkout = tmp_path / 'klipper'
    checkout.mkdir()
    (checkout / '.config').write_text('CONFIG_MACH_STM32=y\n', encoding='utf-8')

    monkeypatch.setattr(flash_targets, 'resolve_flash_target_checkout', lambda target, path: (checkout, None))
    monkeypatch.setattr(flash_targets, 'get_flash_target_state', lambda target, path: {
        'flash_supported': True,
        'flash_reason': None,
        'flash_method_candidates': [{
            'value': _FLASH_METHOD_MAKE_FLASH,
            'label': 'make flash',
            'supported': True,
            'device_required': False,
        }],
        'flash_device_candidates': [],
        'default_flash_method': _FLASH_METHOD_MAKE_FLASH,
        'default_flash_device': '',
    })
    monkeypatch.setattr(flash_targets, 'klipper_service_stop_command', lambda: ['sudo', '-n', 'systemctl', 'stop', 'klipper'])
    monkeypatch.setattr(flash_targets, 'klipper_service_start_command', lambda: ['sudo', '-n', 'systemctl', 'start', 'klipper'])
    monkeypatch.setattr(flash_targets, 'klipper_service_can_control', lambda: True)

    planned = plan_flash_flash_job('klipper', str(checkout))

    assert planned['immediate'] is False
    assert planned['commands'][0] == ['sudo', '-n', 'systemctl', 'stop', 'klipper']
    assert planned['cleanup_commands'] == [['sudo', '-n', 'systemctl', 'start', 'klipper']]


def test_plan_flash_flash_job_skips_klipper_stop_for_dfu_util(monkeypatch, tmp_path):
    checkout = tmp_path / 'klipper'
    checkout.mkdir()
    (checkout / '.config').write_text('CONFIG_MACH_STM32=y\n', encoding='utf-8')

    monkeypatch.setattr(flash_targets, 'resolve_flash_target_checkout', lambda target, path: (checkout, None))
    monkeypatch.setattr(flash_targets, 'get_flash_target_state', lambda target, path: {
        'flash_supported': True,
        'flash_reason': None,
        'flash_method_candidates': [{
            'value': _FLASH_METHOD_DFU_UTIL,
            'label': 'dfu-util',
            'supported': True,
            'device_required': True,
            'default_device': '0483:df11',
        }],
        'flash_device_candidates': [{'value': '0483:df11', 'label': 'STM32 DFU device: 0483:df11'}],
        'default_flash_method': _FLASH_METHOD_DFU_UTIL,
        'default_flash_device': '0483:df11',
    })
    monkeypatch.setattr(flash_targets, '_resolve_dfu_util_flash_command', lambda *args: (
        ['dfu-util', '-d', ',0483:df11', '-D', 'x.bin'], None, '',
    ))
    monkeypatch.setattr(flash_targets, 'klipper_service_stop_command', lambda: ['sudo', '-n', 'systemctl', 'stop', 'klipper'])
    monkeypatch.setattr(flash_targets, 'klipper_service_can_control', lambda: True)

    planned = plan_flash_flash_job('klipper', str(checkout))

    assert planned['immediate'] is False
    # dfu-util talks to a separate USB interface; klipper must NOT be stopped.
    assert all(command[0] != 'sudo' for command in planned['commands'])
    assert planned['cleanup_commands'] == []


def test_plan_flash_flash_job_skips_klipper_stop_for_usb_id_make_flash(monkeypatch, tmp_path):
    checkout = tmp_path / 'klipper'
    checkout.mkdir()
    (checkout / '.config').write_text('CONFIG_MACH_RPXXXX=y\n', encoding='utf-8')

    monkeypatch.setattr(flash_targets, 'resolve_flash_target_checkout', lambda target, path: (checkout, None))
    monkeypatch.setattr(flash_targets, 'get_flash_target_state', lambda target, path: {
        'flash_supported': True,
        'flash_reason': None,
        'flash_method_candidates': [{
            'value': _FLASH_METHOD_MAKE_FLASH,
            'label': 'make flash',
            'supported': True,
            'device_required': True,
            'default_device': '2e8a:0003',
        }],
        'flash_device_candidates': [{'value': '2e8a:0003', 'label': 'RP2040 bootloader: 2e8a:0003'}],
        'default_flash_method': _FLASH_METHOD_MAKE_FLASH,
        'default_flash_device': '2e8a:0003',
    })
    monkeypatch.setattr(flash_targets, 'klipper_service_stop_command', lambda: ['sudo', '-n', 'systemctl', 'stop', 'klipper'])
    monkeypatch.setattr(flash_targets, 'klipper_service_can_control', lambda: True)

    planned = plan_flash_flash_job('klipper', str(checkout))

    assert planned['immediate'] is False
    # RP2040 bootrom is a separate USB interface; no klipper stop needed.
    assert all(command[0] != 'sudo' for command in planned['commands'])
    assert planned['cleanup_commands'] == []


def test_plan_flash_flash_job_fails_fast_when_klipper_active_but_no_sudo(monkeypatch, tmp_path):
    checkout = tmp_path / 'klipper'
    checkout.mkdir()
    (checkout / '.config').write_text('CONFIG_MACH_STM32=y\n', encoding='utf-8')

    monkeypatch.setattr(flash_targets, 'resolve_flash_target_checkout', lambda target, path: (checkout, None))
    monkeypatch.setattr(flash_targets, 'get_flash_target_state', lambda target, path: {
        'flash_supported': True,
        'flash_reason': None,
        'flash_method_candidates': [{
            'value': _FLASH_METHOD_MAKE_FLASH,
            'label': 'make flash',
            'supported': True,
            'device_required': True,
            'default_device': '/dev/serial/by-id/usb-Klipper_stm32f042x6-if00',
        }],
        'flash_device_candidates': [],
        'default_flash_method': _FLASH_METHOD_MAKE_FLASH,
        'default_flash_device': '/dev/serial/by-id/usb-Klipper_stm32f042x6-if00',
    })
    monkeypatch.setattr(flash_targets, 'klipper_service_stop_command', lambda: ['sudo', '-n', 'systemctl', 'stop', 'klipper'])
    monkeypatch.setattr(flash_targets, 'klipper_service_can_control', lambda: False)

    planned = plan_flash_flash_job('klipper', str(checkout))

    assert planned['immediate'] is True
    assert planned['result']['success'] is False
    assert 'passwordless sudo' in planned['result']['error']


def test_plan_flash_flash_job_skips_klipper_service_when_inactive(monkeypatch, tmp_path):
    checkout = tmp_path / 'klipper'
    checkout.mkdir()
    (checkout / '.config').write_text('CONFIG_MACH_STM32=y\n', encoding='utf-8')

    monkeypatch.setattr(flash_targets, 'resolve_flash_target_checkout', lambda target, path: (checkout, None))
    monkeypatch.setattr(flash_targets, 'get_flash_target_state', lambda target, path: {
        'flash_supported': True,
        'flash_reason': None,
        'flash_method_candidates': [{
            'value': _FLASH_METHOD_MAKE_FLASH,
            'label': 'make flash',
            'supported': True,
            'device_required': False,
        }],
        'flash_device_candidates': [],
        'default_flash_method': _FLASH_METHOD_MAKE_FLASH,
        'default_flash_device': '',
    })
    monkeypatch.setattr(flash_targets, 'klipper_service_stop_command', lambda: None)

    planned = plan_flash_flash_job('klipper', str(checkout))

    assert planned['immediate'] is False
    assert planned['commands'][0][0] == 'make'
    assert planned['cleanup_commands'] == []


def test_flash_flash_target_runs_cleanup_after_main_commands(monkeypatch, tmp_path):
    """The synchronous flash path must run cleanup (klipper start) even on
    success, mirroring the job runner — otherwise the legacy /firmware/flash
    route stops Klipper and never restarts it."""
    checkout = tmp_path / 'klipper'
    checkout.mkdir()
    (checkout / '.config').write_text('CONFIG_MACH_STM32=y\n', encoding='utf-8')
    (checkout / 'Makefile').write_text('all:\n\t@true\nflash:\n\t@true\n', encoding='utf-8')
    (checkout / 'src').mkdir()

    ran_cleanup: list[list[str]] = []

    def fake_run(target, checkout_path, commands, timeout):
        return {
            'success': True,
            'error': None,
            'log': '$ make flash',
            'returncode': 0,
        }

    def fake_subprocess_run(command, **kwargs):
        ran_cleanup.append(command)
        return type('Completed', (), {'returncode': 0, 'stdout': '', 'stderr': ''})()

    monkeypatch.setattr(
        'services.flash_targets.resolve_flash_target_checkout',
        lambda target, checkout_path=None: (checkout, None),
    )
    monkeypatch.setattr(
        'services.flash_targets.get_flash_target_state',
        lambda target, checkout_path=None: {
            'flash_supported': True,
            'flash_reason': None,
            'default_flash_device': '',
            'default_flash_method': _FLASH_METHOD_MAKE_FLASH,
            'flash_device_candidates': [],
            'flash_method_candidates': [{
                'value': _FLASH_METHOD_MAKE_FLASH,
                'label': 'make flash',
                'supported': True,
                'device_required': True,
                'default_device': '/dev/serial/by-id/usb-test',
            }],
        },
    )
    monkeypatch.setattr('services.flash_targets._run_commands', fake_run)
    monkeypatch.setattr(
        'services.flash_targets.klipper_service_stop_command',
        lambda: ['sudo', '-n', 'systemctl', 'stop', 'klipper'],
    )
    monkeypatch.setattr('services.flash_targets.klipper_service_start_command',
                        lambda: ['sudo', '-n', 'systemctl', 'start', 'klipper'])
    monkeypatch.setattr('services.flash_targets.klipper_service_can_control', lambda: True)
    monkeypatch.setattr('services.flash_targets.subprocess.run', fake_subprocess_run)

    result = flash_flash_target('klipper', str(checkout), '/dev/serial/by-id/usb-test', _FLASH_METHOD_MAKE_FLASH)

    assert result['success'] is True
    assert ran_cleanup == [['sudo', '-n', 'systemctl', 'start', 'klipper']]
