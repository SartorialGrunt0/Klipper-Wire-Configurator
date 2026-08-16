"""Shared Kconfig-backed build and flash helpers for local firmware targets."""
from __future__ import annotations

import functools
import getpass
import importlib.util
import json
import os
import re
import shlex
import subprocess
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from services.flash_log import logger
from services.native_services import (
    klipper_service_start_command,
    klipper_service_stop_command,
    load_settings,
    save_settings,
    list_uart_devices,
    list_usb_serial_devices,
)

_SUPPORTED_TARGETS = {"klipper", "katapult"}

_TARGET_DISPLAY_NAMES = {
    "klipper": "Klipper",
    "katapult": "Katapult",
}

_TARGET_SETTINGS_KEYS = {
    "klipper": "klipper_path",
    "katapult": "katapult_path",
}

_TARGET_ENV_VARS = {
    "klipper": "KWC_KLIPPER_PATH",
    "katapult": "KWC_KATAPULT_PATH",
}

_TARGET_DEFAULT_PATHS = {
    "klipper": ("/home/{user}/klipper", "/home/pi/klipper"),
    "katapult": ("/home/{user}/katapult", "/home/pi/katapult"),
}

_TARGET_REQUIRED_FILES = {
    "klipper": (
        ("Makefile",),
        ("src", "Kconfig"),
        ("lib", "kconfiglib", "kconfiglib.py"),
    ),
    "katapult": (
        ("Makefile",),
        ("src", "Kconfig"),
        ("lib", "kconfiglib", "kconfiglib.py"),
    ),
}

_TARGET_ARTIFACT_PRIORITY = {
    "klipper": {
        "klipper.uf2": 0,
        "klipper.bin": 1,
        "klipper.elf.hex": 2,
        "ar100.bin": 3,
        "pru0.elf": 4,
        "pru1.elf": 5,
        "klipper.elf": 6,
    },
    "katapult": {
        "katapult.uf2": 0,
        "katapult.withclear.uf2": 1,
        "katapult.bin": 2,
        "canboot.uf2": 3,
        "canboot.bin": 4,
        "deployer.bin": 5,
        "katapult.elf": 6,
        "deployer.elf": 7,
    },
}

_TRISTATE_VALUE_NAMES = {
    0: "n",
    1: "m",
    2: "y",
}

_FLASH_METHOD_MAKE_FLASH = "make_flash"
_FLASH_METHOD_DFU_UTIL = "dfu_util"
_FLASH_METHOD_FLASHTOOL = "flashtool"

_DFU_UTIL_USB_ID_RE = re.compile(r"\[([0-9a-fA-F]{4}:[0-9a-fA-F]{4})\]")
_DFU_UTIL_NAME_RE = re.compile(r'name="([^"]+)"')
_DFU_UTIL_SERIAL_RE = re.compile(r'serial="([^"]+)"')
_LSUSB_ENTRY_RE = re.compile(r"ID\s+([0-9a-fA-F]{4}:[0-9a-fA-F]{4})\s+(.+)$")
_DFU_HINT_RE = re.compile(r"\b(dfu|bootloader)\b", re.IGNORECASE)
_RP2_BOOT_HINT_RE = re.compile(r"\brp2\s+boot\b", re.IGNORECASE)
_STM32_DFU_HINT_RE = re.compile(r"\bstm device in dfu mode\b", re.IGNORECASE)
_USB_ID_RE = re.compile(r"^[0-9a-fA-F]{4}:[0-9a-fA-F]{4}$")
_CAN_UUID_RE = re.compile(r"^(?:(?P<interface>[A-Za-z0-9_-]+):)?(?P<uuid>[0-9a-fA-F]{12})$")
_KATAPULT_QUERY_UUID_RE = re.compile(
    r"Detected UUID:\s*([0-9a-fA-F]{12})(?:,\s*Application:\s*([^,]+))?",
    re.IGNORECASE,
)

# In-memory cache for device scan results.  Key: (target, resolved_checkout_path).
# Each entry: {"candidates": list[dict], "timestamp": float}.
_DEVICE_SCAN_CACHE: dict[tuple[str, str], dict[str, Any]] = {}
_DEVICE_SCAN_CACHE_TTL = 30  # seconds


def _require_supported_target(target: str) -> str:
    normalized = target.strip().lower()
    if normalized not in _SUPPORTED_TARGETS:
        raise ValueError(f"Unsupported flash target: {target}")
    return normalized


def _target_display_name(target: str) -> str:
    return _TARGET_DISPLAY_NAMES[_require_supported_target(target)]


def _target_settings_key(target: str) -> str:
    return _TARGET_SETTINGS_KEYS[_require_supported_target(target)]


def _target_env_var(target: str) -> str:
    return _TARGET_ENV_VARS[_require_supported_target(target)]


def _target_required_files(target: str) -> tuple[tuple[str, ...], ...]:
    return _TARGET_REQUIRED_FILES[_require_supported_target(target)]


def _target_default_paths(target: str) -> list[str]:
    user = getpass.getuser()
    return [path.format(user=user) for path in _TARGET_DEFAULT_PATHS[_require_supported_target(target)]]


def _candidate_checkout_paths(target: str, requested_path: str | None = None) -> list[Path]:
    normalized_target = _require_supported_target(target)
    settings = load_settings()
    values = [
        requested_path,
        settings.get(_target_settings_key(normalized_target)),
        os.environ.get(_target_env_var(normalized_target)),
        *_target_default_paths(normalized_target),
    ]

    result: list[Path] = []
    seen: set[str] = set()
    for value in values:
        if not value:
            continue
        normalized = os.path.expanduser(str(value)).strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(Path(normalized))
    return result


def _is_flash_target_checkout(target: str, path: Path) -> bool:
    if not path.is_dir():
        return False
    for parts in _target_required_files(target):
        if not path.joinpath(*parts).is_file():
            return False
    return True


def _persist_checkout_path(target: str, path: Path) -> None:
    settings = load_settings()
    settings_key = _target_settings_key(target)
    value = str(path)
    if settings.get(settings_key) == value:
        return
    settings[settings_key] = value
    save_settings(settings)


def resolve_flash_target_checkout(target: str, requested_path: str | None = None) -> tuple[Path | None, str | None]:
    normalized_target = _require_supported_target(target)
    candidates = _candidate_checkout_paths(normalized_target, requested_path)
    for candidate in candidates:
        if _is_flash_target_checkout(normalized_target, candidate):
            _persist_checkout_path(normalized_target, candidate)
            logger.info("resolved %s checkout: %s", normalized_target, candidate)
            return candidate, None

    display_name = _target_display_name(normalized_target)
    if requested_path:
        logger.warning("requested %s checkout not found at %s", normalized_target, requested_path)
        return None, (
            f"{display_name} checkout not found at {requested_path}. "
            "Expected Makefile, src/Kconfig, and lib/kconfiglib/kconfiglib.py."
        )

    attempted = ", ".join(str(path) for path in candidates) or "no candidate paths"
    logger.warning("%s checkout not found; attempted: %s", normalized_target, attempted)
    return None, (
        f"{display_name} is not installed on this SBC or its checkout could not be auto-detected. "
        f"Checked: {attempted}."
    )


@functools.lru_cache(maxsize=8)
def _load_kconfiglib_module(module_path: str):
    spec = importlib.util.spec_from_file_location("kwc_target_kconfiglib", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load kconfiglib from {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@contextmanager
def _temporary_env(name: str, value: str):
    previous = os.environ.get(name)
    os.environ[name] = value
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = previous


# Parsed Kconfig trees are expensive (Kconfig(...) walks the whole source
# tree). Cache the parsed tree per (target, checkout, src/Kconfig mtime), but
# NEVER the loaded config state: every request reloads .config fresh so cached
# trees cannot leak mutations from a previous request's assignment preview.
_KCONFIG_TREE_CACHE: dict[tuple[str, str, float], tuple[Any, Any, Path]] = {}
_KCONFIG_TREE_LOCK = threading.Lock()
_KCONFIG_TREE_CACHE_MAX = 8


def _kconfig_src_mtime(checkout_path: Path) -> float:
    try:
        return (checkout_path / "src" / "Kconfig").stat().st_mtime
    except OSError:
        return 0.0


def _invalidate_kconfig_tree_cache(target: str, checkout_path: Path) -> None:
    """Drop cached trees for a checkout (called after .config writes)."""
    prefix = (target, str(checkout_path))
    with _KCONFIG_TREE_LOCK:
        for key in [key for key in _KCONFIG_TREE_CACHE if key[:2] == prefix]:
            del _KCONFIG_TREE_CACHE[key]


def _load_target_kconfig_state(target: str, checkout_path: Path):
    normalized_target = _require_supported_target(target)
    cache_key = (normalized_target, str(checkout_path), _kconfig_src_mtime(checkout_path))

    with _KCONFIG_TREE_LOCK:
        cached = _KCONFIG_TREE_CACHE.get(cache_key)
        if cached is not None:
            kconfiglib, kconf, config_path = cached
        else:
            kconfiglib = _load_kconfiglib_module(str(checkout_path / "lib" / "kconfiglib" / "kconfiglib.py"))
            config_path = checkout_path / ".config"
            with _temporary_env("srctree", str(checkout_path)):
                kconf = kconfiglib.Kconfig(str(checkout_path / "src" / "Kconfig"))
            if len(_KCONFIG_TREE_CACHE) >= _KCONFIG_TREE_CACHE_MAX:
                _KCONFIG_TREE_CACHE.clear()
            _KCONFIG_TREE_CACHE[cache_key] = (kconfiglib, kconf, config_path)

    # Always reload config state fresh: the cached tree is shared and a prior
    # request may have mutated it via assignment previews. This also picks up
    # .config edits made outside the app. When no .config exists, reset the
    # tree to defaults so nothing leaks across requests.
    with _temporary_env("srctree", str(checkout_path)):
        if config_path.is_file():
            kconf.load_config(str(config_path))
        else:
            kconf.unset_values()
    return kconfiglib, kconf, config_path


def _prompt_text(kconfiglib, node) -> str | None:
    if not node.prompt:
        return None
    text, condition = node.prompt
    if condition is not None and not kconfiglib.expr_value(condition):
        return None
    return text


def _symbol_type_name(kconfiglib, symbol) -> str | None:
    mapping = {
        kconfiglib.BOOL: "bool",
        kconfiglib.TRISTATE: "tristate",
        kconfiglib.STRING: "string",
        kconfiglib.INT: "int",
        kconfiglib.HEX: "hex",
    }
    return mapping.get(symbol.orig_type)


def _menu_path(kconfiglib, node) -> list[str]:
    path: list[str] = []
    current = node.parent
    while current is not None:
        prompt = _prompt_text(kconfiglib, current)
        if prompt and (
            current.item is kconfiglib.MENU
            or current.item is kconfiglib.COMMENT
            or getattr(current, "is_menuconfig", False)
            or isinstance(current.item, kconfiglib.Choice)
        ):
            path.append(prompt)
        current = current.parent
    path.reverse()
    return path


def _serialize_assignable(symbol) -> list[str]:
    assignable = getattr(symbol, "assignable", ()) or ()
    values = []
    for value in assignable:
        name = _TRISTATE_VALUE_NAMES.get(value)
        if name is not None:
            values.append(name)
    return values


def _truncate_help(help_text: str, limit: int) -> str:
    if limit <= 0 or len(help_text) <= limit:
        return help_text
    return help_text[:limit].rstrip() + "…"


def _serialize_symbol_field(kconfiglib, node, help_limit: int = 0) -> dict[str, Any] | None:
    symbol = node.item
    if not isinstance(symbol, kconfiglib.Symbol):
        return None
    if symbol.choice is not None:
        return None
    prompt = _prompt_text(kconfiglib, node)
    if not prompt or not symbol.name:
        return None
    kind = _symbol_type_name(kconfiglib, symbol)
    if kind is None:
        return None
    return {
        "id": symbol.name,
        "kind": kind,
        "symbol": symbol.name,
        "prompt": prompt,
        "value": symbol.str_value,
        "help": _truncate_help(node.help or "", help_limit),
        "menu_path": _menu_path(kconfiglib, node),
        "assignable": _serialize_assignable(symbol),
    }


def _serialize_choice_field(kconfiglib, node, help_limit: int = 0) -> dict[str, Any] | None:
    choice = node.item
    if not isinstance(choice, kconfiglib.Choice):
        return None

    prompt = _prompt_text(kconfiglib, node)
    if not prompt:
        return None

    options = []
    child = node.list
    while child is not None:
        child_prompt = _prompt_text(kconfiglib, child)
        child_symbol = child.item
        if child_prompt and isinstance(child_symbol, kconfiglib.Symbol) and child_symbol.name:
            options.append({
                "symbol": child_symbol.name,
                "prompt": child_prompt,
                "selected": choice.selection is child_symbol,
            })
        child = child.next

    if not options:
        return None

    selected = choice.selection.name if choice.selection is not None else ""
    return {
        "id": f"choice:{node.filename}:{node.linenr}",
        "kind": "choice",
        "symbol": None,
        "prompt": prompt,
        "value": selected,
        "help": _truncate_help(node.help or "", help_limit),
        "menu_path": _menu_path(kconfiglib, node),
        "assignable": [option["symbol"] for option in options],
        "options": options,
    }


def _serialize_kconfig_fields(kconfiglib, kconf, help_limit: int = 0) -> list[dict[str, Any]]:
    fields: list[dict[str, Any]] = []
    for node in kconf.node_iter():
        item = node.item
        field: dict[str, Any] | None = None
        if isinstance(item, kconfiglib.Choice):
            field = _serialize_choice_field(kconfiglib, node, help_limit)
        elif isinstance(item, kconfiglib.Symbol):
            field = _serialize_symbol_field(kconfiglib, node, help_limit)
        if field is not None:
            fields.append(field)
    return fields


def _normalize_assignment_value(kconfiglib, symbol, raw_value: str) -> str:
    kind = _symbol_type_name(kconfiglib, symbol)
    value = str(raw_value).strip()
    if kind == "bool":
        return "y" if value.lower() in {"1", "true", "yes", "on", "y"} else "n"
    if kind == "tristate":
        lowered = value.lower()
        if lowered in {"m", "module"}:
            return "m"
        return "y" if lowered in {"1", "true", "yes", "on", "y"} else "n"
    return value


def _assignment_priority(symbol_name: str, kind: str | None) -> tuple[int, str]:
    if symbol_name == "LOW_LEVEL_OPTIONS":
        return (0, symbol_name)
    if kind in {"bool", "tristate"}:
        return (1, symbol_name)
    return (2, symbol_name)


def _assignment_to_config_line(kconfiglib, symbol_name: str, symbol, raw_value: str) -> str:
    kind = _symbol_type_name(kconfiglib, symbol)
    normalized = _normalize_assignment_value(kconfiglib, symbol, raw_value)

    if kind in {"bool", "tristate"}:
        if normalized == "n":
            return f"# CONFIG_{symbol_name} is not set"
        return f"CONFIG_{symbol_name}={normalized}"
    if kind == "string":
        return f"CONFIG_{symbol_name}={json.dumps(normalized)}"
    return f"CONFIG_{symbol_name}={normalized}"


def _apply_assignments_to_kconfig(kconfiglib, kconf, assignments: list[tuple[str, str]]) -> list[str]:
    if not assignments:
        return []

    issues: list[str] = []
    deduped: dict[str, str] = {}
    for symbol_name, raw_value in assignments:
        deduped[symbol_name] = raw_value

    lines: list[tuple[tuple[int, str], str]] = []
    for symbol_name, raw_value in deduped.items():
        symbol = kconf.syms.get(symbol_name)
        if symbol is None:
            issues.append(f"Unknown symbol: {symbol_name}")
            continue
        kind = _symbol_type_name(kconfiglib, symbol)
        lines.append((
            _assignment_priority(symbol_name, kind),
            _assignment_to_config_line(kconfiglib, symbol_name, symbol, raw_value),
        ))

    if not lines:
        return issues

    with tempfile.NamedTemporaryFile("w", delete=False, encoding="utf-8", newline="\n") as fh:
        for _, line in sorted(lines, key=lambda item: item[0]):
            fh.write(line)
            fh.write("\n")
        temp_path = fh.name

    try:
        kconf.load_config(temp_path)
    finally:
        try:
            os.unlink(temp_path)
        except OSError:
            pass

    return issues


def _current_symbol_value(kconf, symbol_name: str) -> str:
    symbol = kconf.syms.get(symbol_name)
    if symbol is None:
        return "n"
    return getattr(symbol, "str_value", "n")


def _enabled_machine_symbols(kconf) -> set[str]:
    candidates = (
        "MACH_RPXXXX",
        "MACH_ATSAM",
        "MACH_ATSAMD",
        "MACH_AVR",
        "MACH_LPC176X",
        "MACH_STM32",
    )
    return {symbol_name for symbol_name in candidates if _current_symbol_value(kconf, symbol_name) == "y"}


def _append_flash_device_candidate(
    candidates: list[dict[str, str]],
    seen_values: set[str],
    value: str,
    label: str,
    *,
    transport: str | None = None,
    interface: str | None = None,
    preferred_flash_method: str | None = None,
) -> None:
    normalized_value = value.strip()
    if not normalized_value or normalized_value in seen_values:
        return
    seen_values.add(normalized_value)
    candidate = {
        "value": normalized_value,
        "label": label.strip() or normalized_value,
    }
    if transport:
        candidate["transport"] = transport
    if interface:
        candidate["interface"] = interface.strip()
    if preferred_flash_method:
        candidate["preferred_flash_method"] = preferred_flash_method
    candidates.append(candidate)


def _first_device_candidate(candidates: list[dict[str, str]], transport: str | None = None) -> str:
    for candidate in candidates:
        if transport is not None and candidate.get("transport") != transport:
            continue
        value = candidate.get("value", "").strip()
        if value:
            return value
    return ""


def _parse_can_flash_device(value: str, default_interface: str = "can0") -> tuple[str, str] | None:
    match = _CAN_UUID_RE.fullmatch(value.strip())
    if match is None:
        return None
    interface = (match.group("interface") or default_interface).strip() or default_interface
    uuid = match.group("uuid").lower()
    return interface, uuid


def _is_usb_id(value: str) -> bool:
    return _USB_ID_RE.fullmatch(value.strip()) is not None


def _serial_flash_device_candidates() -> list[dict[str, str]]:
    candidates: list[dict[str, str]] = []
    seen_values: set[str] = set()
    represented_paths: set[str] = set()

    for device in list_usb_serial_devices():
        device_path = str(device.get("path", "")).strip()
        device_value = str(device.get("by_id") or device_path).strip()
        description = str(device.get("description") or Path(device_value or device_path).name).strip()
        if device_path:
            represented_paths.add(device_path)
        label = f"USB serial: {description}"
        if device_path and device_path != device_value:
            label = f"{label} ({device_path})"
        _append_flash_device_candidate(
            candidates,
            seen_values,
            device_value,
            label,
            transport="serial",
            preferred_flash_method=_FLASH_METHOD_FLASHTOOL,
        )

    for device in list_uart_devices():
        device_path = str(device.get("path", "")).strip()
        if not device_path or device_path in represented_paths:
            continue
        description = str(device.get("description") or Path(device_path).name).strip()
        _append_flash_device_candidate(
            candidates,
            seen_values,
            device_path,
            f"Serial: {description}",
            transport="serial",
            preferred_flash_method=_FLASH_METHOD_FLASHTOOL,
        )

    return candidates


def _run_optional_text_command(command: list[str], timeout: int = 5) -> str:
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (FileNotFoundError, OSError, subprocess.SubprocessError):
        return ""
    return "\n".join(chunk for chunk in (completed.stdout, completed.stderr) if chunk).strip()


def _parse_dfu_util_flash_candidates(output: str) -> list[dict[str, str]]:
    candidates: list[dict[str, str]] = []
    seen_values: set[str] = set()
    for raw_line in output.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        identifier_match = _DFU_UTIL_USB_ID_RE.search(line)
        if identifier_match is None:
            continue

        value = identifier_match.group(1).lower()
        label = f"DFU device: {value}"
        name_match = _DFU_UTIL_NAME_RE.search(line)
        serial_match = _DFU_UTIL_SERIAL_RE.search(line)
        details = []
        if name_match is not None and name_match.group(1).strip():
            details.append(name_match.group(1).strip())
        if serial_match is not None and serial_match.group(1).strip():
            details.append(f"serial {serial_match.group(1).strip()}")
        if details:
            label = f"{label} ({', '.join(details)})"

        _append_flash_device_candidate(
            candidates,
            seen_values,
            value,
            label,
            transport="usb_id",
            preferred_flash_method=_FLASH_METHOD_DFU_UTIL,
        )
    return candidates


def _parse_lsusb_flash_candidates(output: str) -> list[dict[str, str]]:
    candidates: list[dict[str, str]] = []
    seen_values: set[str] = set()
    for raw_line in output.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        match = _LSUSB_ENTRY_RE.search(line)
        if match is None:
            continue

        value = match.group(1).lower()
        description = match.group(2).strip()
        description_lower = description.lower()
        is_rp2040_boot = _RP2_BOOT_HINT_RE.search(description) is not None
        is_stm32_dfu = _STM32_DFU_HINT_RE.search(description_lower) is not None
        if description and not (is_rp2040_boot or is_stm32_dfu or _DFU_HINT_RE.search(description)):
            continue

        if is_rp2040_boot:
            label = f"RP2040 bootloader: {value}"
        elif is_stm32_dfu:
            label = f"STM32 DFU device: {value}"
        else:
            label = f"USB DFU candidate: {value}"
        if description:
            label = f"{label} ({description})"
        _append_flash_device_candidate(
            candidates,
            seen_values,
            value,
            label,
            transport="usb_id",
            preferred_flash_method=_FLASH_METHOD_MAKE_FLASH if is_rp2040_boot else _FLASH_METHOD_DFU_UTIL,
        )
    return candidates


def _dfu_candidates_from_lsusb() -> list[dict[str, str]]:
    return [
        candidate
        for candidate in _parse_lsusb_flash_candidates(_run_optional_text_command(["lsusb"]))
        if _RP2_BOOT_HINT_RE.search(candidate.get("label", "")) is None
    ]


def _rp2040_usb_flash_device_candidates() -> list[dict[str, str]]:
    return [
        candidate
        for candidate in _parse_lsusb_flash_candidates(_run_optional_text_command(["lsusb"]))
        if _RP2_BOOT_HINT_RE.search(candidate.get("label", "")) is not None
    ]


def _dfu_flash_device_candidates() -> list[dict[str, str]]:
    candidates = _parse_dfu_util_flash_candidates(_run_optional_text_command(["dfu-util", "-l"]))
    if candidates:
        return candidates
    return _dfu_candidates_from_lsusb()


def _katapult_flashtool_path(target: str, checkout_path: Path) -> Path | None:
    normalized_target = _require_supported_target(target)
    if normalized_target == "katapult":
        candidate = checkout_path / "scripts" / "flashtool.py"
        return candidate if candidate.is_file() else None

    katapult_path, _ = resolve_flash_target_checkout("katapult")
    if katapult_path is None:
        return None
    candidate = katapult_path / "scripts" / "flashtool.py"
    return candidate if candidate.is_file() else None


def _katapult_can_flash_device_candidates(script_path: Path, interface: str = "can0") -> list[dict[str, str]]:
    output = _run_optional_text_command([
        "python3",
        str(script_path),
        "-i",
        interface,
        "-q",
    ], timeout=10)
    if not output:
        return []

    candidates: list[dict[str, str]] = []
    seen_values: set[str] = set()
    for raw_line in output.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        match = _KATAPULT_QUERY_UUID_RE.search(line)
        if match is None:
            continue
        uuid = match.group(1).lower()
        application = (match.group(2) or "Katapult").strip()
        label = f"CAN UUID: {uuid} ({interface}, {application})"
        _append_flash_device_candidate(
            candidates,
            seen_values,
            uuid,
            label,
            transport="can_uuid",
            interface=interface,
            preferred_flash_method=_FLASH_METHOD_FLASHTOOL,
        )
    return candidates


def _preferred_flash_method_for_device(
    flash_device: str,
    method_candidates: list[dict[str, Any]],
    device_candidates: list[dict[str, str]],
) -> str:
    resolved_device = flash_device.strip()
    if not resolved_device or not method_candidates:
        return ""

    supported_methods = {candidate["value"] for candidate in method_candidates}
    exact_candidate = next(
        (candidate for candidate in device_candidates if candidate.get("value", "").strip() == resolved_device),
        None,
    )
    if exact_candidate is not None:
        preferred_method = str(exact_candidate.get("preferred_flash_method") or "").strip()
        if preferred_method in supported_methods:
            return preferred_method

    if _parse_can_flash_device(resolved_device) is not None and _FLASH_METHOD_FLASHTOOL in supported_methods:
        return _FLASH_METHOD_FLASHTOOL

    if resolved_device.startswith("/dev/"):
        if _FLASH_METHOD_FLASHTOOL in supported_methods:
            return _FLASH_METHOD_FLASHTOOL
        if _FLASH_METHOD_MAKE_FLASH in supported_methods:
            return _FLASH_METHOD_MAKE_FLASH

    if resolved_device == "first" and _FLASH_METHOD_MAKE_FLASH in supported_methods:
        return _FLASH_METHOD_MAKE_FLASH

    if _is_usb_id(resolved_device):
        if _FLASH_METHOD_DFU_UTIL in supported_methods:
            return _FLASH_METHOD_DFU_UTIL
        if _FLASH_METHOD_MAKE_FLASH in supported_methods:
            return _FLASH_METHOD_MAKE_FLASH

    if _FLASH_METHOD_MAKE_FLASH in supported_methods:
        return _FLASH_METHOD_MAKE_FLASH
    return method_candidates[0]["value"]


def _flash_device_candidates(target: str, kconf, katapult_script_path: Path | None) -> list[dict[str, str]]:
    """Return the static (config-driven) flash device candidates for a target.

    Slow device discovery (USB DFU, serial ports, CAN UUIDs) is performed
    separately via ``scan_flash_target_devices`` so it never blocks the initial
    state load.
    """
    normalized_target = _require_supported_target(target)
    machine_symbols = _enabled_machine_symbols(kconf)
    candidates: list[dict[str, str]] = []
    seen_values: set[str] = set()

    if normalized_target in {"klipper", "katapult"} and "MACH_RPXXXX" in machine_symbols:
        _append_flash_device_candidate(
            candidates,
            seen_values,
            "first",
            "Auto-detect the first RP2040 mass-storage target",
            transport="mass_storage",
        )

    return candidates


def _klipper_flash_capabilities(kconf) -> dict[str, Any]:
    if _current_symbol_value(kconf, "MACH_RPXXXX") == "y":
        return {
            "supported": True,
            "reason": None,
            "device_required": True,
            "device_placeholder": "first or /dev/serial/by-id/...",
            "default_device": "first",
            "help": "Runs `make flash NOSUDO=1 FLASH_DEVICE=...`. RP2040 builds commonly use `first`.",
        }

    supported_symbols = (
        "MACH_ATSAM",
        "MACH_ATSAMD",
        "MACH_AVR",
        "MACH_LPC176X",
        "MACH_STM32",
    )
    if any(_current_symbol_value(kconf, symbol_name) == "y" for symbol_name in supported_symbols):
        return {
            "supported": True,
            "reason": None,
            "device_required": True,
            "device_placeholder": "/dev/serial/by-id/... or USB VID:PID",
            "default_device": "",
            "help": "Runs `make flash NOSUDO=1 FLASH_DEVICE=...`. Some boards still require a manual SD-card or programmer workflow instead.",
        }

    return {
        "supported": False,
        "reason": "The current Klipper target does not expose a usable `make flash` workflow. Build the artifact and follow the board-specific flashing instructions instead.",
        "device_required": False,
        "device_placeholder": "",
        "default_device": "",
        "help": "Build the artifact and use your board's documented flashing process.",
    }


def _katapult_flash_capabilities(kconf) -> dict[str, Any]:
    if _current_symbol_value(kconf, "MACH_STM32") == "y":
        return {
            "supported": True,
            "reason": None,
            "device_required": True,
            "device_placeholder": "USB VID:PID for dfu-util, e.g. 0483:df11",
            "default_device": "",
            "help": "Runs `make flash NOSUDO=1 FLASH_DEVICE=...` using Katapult's STM32 DFU flow or a serial flashtool target when a serial device path is selected.",
        }
    if _current_symbol_value(kconf, "MACH_RPXXXX") == "y":
        return {
            "supported": True,
            "reason": None,
            "device_required": False,
            "device_placeholder": "",
            "default_device": "",
            "help": "Runs `make flash NOSUDO=1` using Katapult's rp2040_flash helper.",
        }
    return {
        "supported": False,
        "reason": "Katapult's built-in `make flash` support is currently available for STM32 DFU and RP2040/RP235x targets.",
        "device_required": False,
        "device_placeholder": "",
        "default_device": "",
        "help": "Build the Katapult artifact and flash it with your board's documented manual method if `make flash` is unavailable.",
    }


def _flash_capabilities(target: str, kconf) -> dict[str, Any]:
    normalized_target = _require_supported_target(target)
    if normalized_target == "klipper":
        return _klipper_flash_capabilities(kconf)
    return _katapult_flash_capabilities(kconf)


def _dfu_util_flash_capabilities(kconf, device_candidates: list[dict[str, str]]) -> dict[str, Any]:
    if _current_symbol_value(kconf, "MACH_STM32") != "y":
        return {
            "supported": False,
            "reason": "dfu-util is only available for STM32 DFU targets.",
            "device_required": True,
            "device_placeholder": "USB VID:PID, e.g. 0483:df11",
            "default_device": "",
            "help": "Direct dfu-util flashing is only applicable to STM32 targets in DFU mode.",
        }

    default_device = _first_device_candidate(device_candidates, "usb_id")
    return {
        "supported": True,
        "reason": None,
        "device_required": True,
        "device_placeholder": "USB VID:PID, e.g. 0483:df11",
        "default_device": default_device,
        "help": "Runs the resolved `dfu-util` command for the active target using the selected USB VID:PID.",
    }


def _flashtool_flash_capabilities(
    kconf,
    katapult_script_path: Path | None,
    device_candidates: list[dict[str, str]],
) -> dict[str, Any]:
    supported_symbols = {"MACH_RPXXXX", "MACH_ATSAM", "MACH_ATSAMD", "MACH_LPC176X", "MACH_STM32"}
    if katapult_script_path is None:
        return {
            "supported": False,
            "reason": "Katapult is not installed on this SBC, so flashtool.py is unavailable.",
            "device_required": True,
            "device_placeholder": "/dev/serial/by-id/... or can0:<uuid>",
            "default_device": "",
            "help": "Install Katapult on this SBC to use flashtool.py flashing.",
        }
    if not (_enabled_machine_symbols(kconf) & supported_symbols):
        return {
            "supported": False,
            "reason": "flashtool.py is intended for Katapult-capable USB serial or CAN workflows.",
            "device_required": True,
            "device_placeholder": "/dev/serial/by-id/... or can0:<uuid>",
            "default_device": "",
            "help": "Use flashtool.py with a serial device path or a CAN UUID on can0.",
        }

    default_device = _first_device_candidate(device_candidates, "can_uuid") or _first_device_candidate(device_candidates, "serial")
    return {
        "supported": True,
        "reason": None,
        "device_required": True,
        "device_placeholder": "/dev/serial/by-id/... or can0:<uuid>",
        "default_device": default_device,
        "help": "Runs `python3 .../katapult/scripts/flashtool.py` with `-d` for serial devices or `-i can0 -u <uuid>` for CAN devices.",
    }


def _flash_method_candidates(
    target: str,
    kconf,
    device_candidates: list[dict[str, str]],
    katapult_script_path: Path | None,
) -> list[dict[str, Any]]:
    make_capabilities = _flash_capabilities(target, kconf)
    dfu_capabilities = _dfu_util_flash_capabilities(kconf, device_candidates)
    flashtool_capabilities = _flashtool_flash_capabilities(kconf, katapult_script_path, device_candidates)

    candidates: list[dict[str, Any]] = []
    if make_capabilities["supported"]:
        candidates.append({
            "value": _FLASH_METHOD_MAKE_FLASH,
            "label": "make flash",
            "description": "Use the target Makefile's configured flash workflow.",
            **make_capabilities,
        })
    if dfu_capabilities["supported"]:
        candidates.append({
            "value": _FLASH_METHOD_DFU_UTIL,
            "label": "dfu-util",
            "description": "Run dfu-util directly for STM32 DFU targets.",
            **dfu_capabilities,
        })
    if flashtool_capabilities["supported"]:
        candidates.append({
            "value": _FLASH_METHOD_FLASHTOOL,
            "label": "flashtool.py",
            "description": "Run Katapult's flashtool over serial or CAN.",
            **flashtool_capabilities,
        })
    return candidates


def _default_flash_method(method_candidates: list[dict[str, Any]], device_candidates: list[dict[str, str]]) -> str:
    if not method_candidates:
        return ""

    for candidate in device_candidates:
        preferred_method = _preferred_flash_method_for_device(
            candidate.get("value", ""),
            method_candidates,
            device_candidates,
        )
        if preferred_method:
            return preferred_method

    values = {candidate["value"] for candidate in method_candidates}
    if _FLASH_METHOD_MAKE_FLASH in values:
        return _FLASH_METHOD_MAKE_FLASH
    return method_candidates[0]["value"]


def _flash_reason(method_candidates: list[dict[str, Any]], make_capabilities: dict[str, Any]) -> str | None:
    if method_candidates:
        return None
    return make_capabilities.get("reason") or "No supported flash methods are available for the current target."


def _empty_flash_target_state(target: str, requested_path: str | None, error: str | None) -> dict[str, Any]:
    normalized_target = _require_supported_target(target)
    return {
        "target": normalized_target,
        "display_name": _target_display_name(normalized_target),
        "available": False,
        "error": error,
        "checkout_path": requested_path or "",
        "config_path": "",
        "out_path": "",
        "config_exists": False,
        "fields": [],
        "artifacts": [],
        "primary_artifact": None,
        "flash_supported": False,
        "flash_reason": error,
        "flash_device_required": False,
        "flash_device_placeholder": "",
        "default_flash_device": "",
        "flash_device_candidates": [],
        "flash_method_candidates": [],
        "default_flash_method": "",
        "flash_help": "",
    }


def _is_flash_target_artifact(target: str, path: Path) -> bool:
    normalized_target = _require_supported_target(target)
    if not path.is_file():
        return False
    if path.name in _TARGET_ARTIFACT_PRIORITY[normalized_target]:
        return True
    if normalized_target == "klipper":
        return path.name.startswith("klipper.") and path.suffix in {".bin", ".hex", ".uf2", ".elf"}
    return path.name.startswith(("katapult.", "canboot.", "deployer.")) and path.suffix in {".bin", ".uf2", ".elf"}


def list_flash_target_artifacts(target: str, checkout_path: str | Path) -> list[dict[str, Any]]:
    normalized_target = _require_supported_target(target)
    root = Path(checkout_path)
    out_dir = root / "out"
    if not out_dir.is_dir():
        return []

    artifacts = []
    for artifact in out_dir.iterdir():
        if not _is_flash_target_artifact(normalized_target, artifact):
            continue
        stat = artifact.stat()
        artifacts.append({
            "name": artifact.name,
            "path": str(artifact),
            "size": stat.st_size,
            "modified": stat.st_mtime,
        })

    artifacts.sort(
        key=lambda item: (
            _TARGET_ARTIFACT_PRIORITY[normalized_target].get(item["name"], 100),
            -item["modified"],
            item["name"],
        ),
    )
    return artifacts


def pick_primary_flash_target_artifact(target: str, artifacts: list[dict[str, Any]]) -> dict[str, Any] | None:
    _require_supported_target(target)
    return artifacts[0] if artifacts else None


def get_flash_target_state(
    target: str,
    checkout_path: str | None = None,
    assignments: list[tuple[str, str]] | None = None,
    help_limit: int = 0,
) -> dict[str, Any]:
    normalized_target = _require_supported_target(target)
    _start = time.monotonic()
    resolved_path, error = resolve_flash_target_checkout(normalized_target, checkout_path)
    if resolved_path is None:
        return _empty_flash_target_state(normalized_target, checkout_path, error)

    kconfiglib, kconf, config_path = _load_target_kconfig_state(normalized_target, resolved_path)
    issues = _apply_assignments_to_kconfig(kconfiglib, kconf, assignments or [])
    artifacts = list_flash_target_artifacts(normalized_target, resolved_path)
    flash_capabilities = _flash_capabilities(normalized_target, kconf)
    katapult_script_path = _katapult_flashtool_path(normalized_target, resolved_path)
    flash_device_candidates = _flash_device_candidates(normalized_target, kconf, katapult_script_path)
    flash_method_candidates = _flash_method_candidates(
        normalized_target,
        kconf,
        flash_device_candidates,
        katapult_script_path,
    )
    default_flash_method = _default_flash_method(flash_method_candidates, flash_device_candidates)
    default_method_state = next(
        (candidate for candidate in flash_method_candidates if candidate["value"] == default_flash_method),
        None,
    )

    state = {
        "target": normalized_target,
        "display_name": _target_display_name(normalized_target),
        "available": True,
        "error": None,
        "checkout_path": str(resolved_path),
        "config_path": str(config_path),
        "out_path": str(resolved_path / "out"),
        "config_exists": config_path.is_file(),
        "fields": _serialize_kconfig_fields(kconfiglib, kconf, help_limit),
        "artifacts": artifacts,
        "primary_artifact": pick_primary_flash_target_artifact(normalized_target, artifacts),
        "flash_supported": bool(flash_method_candidates),
        "flash_reason": _flash_reason(flash_method_candidates, flash_capabilities),
        "flash_device_required": bool(default_method_state and default_method_state["device_required"]),
        "flash_device_placeholder": default_method_state["device_placeholder"] if default_method_state else "",
        "default_flash_device": default_method_state["default_device"] if default_method_state else "",
        "flash_device_candidates": flash_device_candidates,
        "flash_method_candidates": flash_method_candidates,
        "default_flash_method": default_flash_method,
        "flash_help": default_method_state["help"] if default_method_state else flash_capabilities["help"],
    }
    if issues:
        state["error"] = "; ".join(issues)
    logger.debug(
        "state %s: %d fields, %d artifacts, flash_supported=%s (%.0f ms)",
        normalized_target,
        len(state["fields"]),
        len(state["artifacts"]),
        state["flash_supported"],
        (time.monotonic() - _start) * 1000,
    )
    return state


def preview_flash_target_config(
    target: str,
    assignments: list[tuple[str, str]],
    checkout_path: str | None = None,
    help_limit: int = 0,
) -> dict[str, Any]:
    return get_flash_target_state(target, checkout_path, assignments, help_limit)


def save_flash_target_config(
    target: str,
    assignments: list[tuple[str, str]],
    checkout_path: str | None = None,
    help_limit: int = 0,
) -> dict[str, Any]:
    normalized_target = _require_supported_target(target)
    resolved_path, error = resolve_flash_target_checkout(normalized_target, checkout_path)
    if resolved_path is None:
        return _empty_flash_target_state(normalized_target, checkout_path, error)

    kconfiglib, kconf, config_path = _load_target_kconfig_state(normalized_target, resolved_path)
    issues = _apply_assignments_to_kconfig(kconfiglib, kconf, assignments)
    kconf.write_config(str(config_path))
    logger.info("saved %s .config to %s (%d assignments)", normalized_target, config_path, len(assignments))
    state = get_flash_target_state(normalized_target, str(resolved_path), help_limit=help_limit)
    # The tree itself is unchanged by a .config write (fresh loads pick up the
    # new file), but drop the cached entry anyway so the next request re-parses
    # from the on-disk state without any doubt.
    _invalidate_kconfig_tree_cache(normalized_target, resolved_path)
    if issues:
        state["error"] = "; ".join(issues)
    return state


def _find_kconfig_node(kconf, field_id: str):
    """Locate the menu node for a serialized field id (symbol or choice:id)."""
    if field_id.startswith("choice:"):
        parts = field_id.split(":", 2)
        if len(parts) != 3:
            return None
        _prefix, filename, linenr_text = parts
        try:
            linenr = int(linenr_text)
        except ValueError:
            return None
        for node in kconf.node_iter():
            if node.filename == filename and node.linenr == linenr:
                return node
        return None
    symbol = kconf.syms.get(field_id)
    if symbol is None:
        return None
    for node in symbol.nodes:
        if node.prompt is not None:
            return node
    return symbol.nodes[0] if symbol.nodes else None


def get_flash_field_help(target: str, field_id: str, checkout_path: str | None = None) -> dict[str, Any]:
    """Return the FULL (uncapped) help text for one menuconfig field.

    The parsed tree is cached, so this is a cheap in-memory lookup. Used by the
    frontend to lazy-load help that was truncated by ``help_limit``.
    """
    normalized_target = _require_supported_target(target)
    resolved_path, error = resolve_flash_target_checkout(normalized_target, checkout_path)
    if resolved_path is None:
        return {"field_id": field_id, "help": ""}
    _kconfiglib, kconf, _config_path = _load_target_kconfig_state(normalized_target, resolved_path)
    node = _find_kconfig_node(kconf, field_id)
    if node is None:
        return {"field_id": field_id, "help": ""}
    return {"field_id": field_id, "help": node.help or ""}


def scan_flash_target_devices(
    target: str,
    checkout_path: str | None = None,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """Run slow device discovery (USB DFU, serial, CAN) and return candidates.

    Results are cached in-process for ``_DEVICE_SCAN_CACHE_TTL`` seconds so
    repeated calls while the dialog is open are instant.  Pass
    ``force_refresh=True`` to bypass the cache (e.g. from the Refresh button).
    """
    normalized_target = _require_supported_target(target)
    resolved_path, error = resolve_flash_target_checkout(normalized_target, checkout_path)
    if resolved_path is None:
        return {"target": normalized_target, "candidates": [], "error": error, "cached": False}

    cache_key = (normalized_target, str(resolved_path))
    now = time.monotonic()
    if not force_refresh:
        cached = _DEVICE_SCAN_CACHE.get(cache_key)
        if cached is not None and now - cached["timestamp"] < _DEVICE_SCAN_CACHE_TTL:
            logger.debug("scan %s: served %d cached candidates", normalized_target, len(cached["candidates"]))
            return {
                "target": normalized_target,
                "candidates": cached["candidates"],
                "error": None,
                "cached": True,
            }

    kconfiglib, kconf, _config_path = _load_target_kconfig_state(normalized_target, resolved_path)
    machine_symbols = _enabled_machine_symbols(kconf)
    katapult_script_path = _katapult_flashtool_path(normalized_target, resolved_path)

    candidates: list[dict[str, str]] = []
    seen_values: set[str] = set()

    # RP2040 USB bootloader devices (lsusb, fast)
    if normalized_target in {"klipper", "katapult"} and "MACH_RPXXXX" in machine_symbols:
        for candidate in _rp2040_usb_flash_device_candidates():
            _append_flash_device_candidate(
                candidates, seen_values,
                candidate["value"], candidate["label"],
                transport=candidate.get("transport") or "usb_id",
                interface=candidate.get("interface"),
            )

    # STM32 DFU devices (dfu-util -l or lsusb, fast)
    if "MACH_STM32" in machine_symbols:
        for candidate in _dfu_flash_device_candidates():
            _append_flash_device_candidate(
                candidates, seen_values,
                candidate["value"], candidate["label"],
                transport=candidate.get("transport") or "usb_id",
                interface=candidate.get("interface"),
            )

    # Katapult CAN bus UUIDs (flashtool.py -q, potentially slow)
    if katapult_script_path is not None:
        for candidate in _katapult_can_flash_device_candidates(katapult_script_path):
            _append_flash_device_candidate(
                candidates, seen_values,
                candidate["value"], candidate["label"],
                transport=candidate.get("transport") or "can_uuid",
                interface=candidate.get("interface") or "can0",
                preferred_flash_method=candidate.get("preferred_flash_method"),
            )

    # Serial / UART devices (fast filesystem scan)
    if machine_symbols & {"MACH_ATSAM", "MACH_ATSAMD", "MACH_AVR", "MACH_LPC176X", "MACH_STM32"}:
        for candidate in _serial_flash_device_candidates():
            _append_flash_device_candidate(
                candidates, seen_values,
                candidate["value"], candidate["label"],
                transport=candidate.get("transport") or "serial",
                interface=candidate.get("interface"),
            )

    _DEVICE_SCAN_CACHE[cache_key] = {"candidates": candidates, "timestamp": now}
    logger.info(
        "scan %s: %d candidates (fresh, %.0f ms)",
        normalized_target,
        len(candidates),
        (time.monotonic() - now) * 1000,
    )
    return {"target": normalized_target, "candidates": candidates, "error": None, "cached": False}


def _command_log(command: list[str], completed: subprocess.CompletedProcess[str]) -> str:
    stdout = completed.stdout.strip()
    stderr = completed.stderr.strip()
    lines = [f"$ {' '.join(command)}"]
    if stdout:
        lines.append(stdout)
    if stderr:
        lines.append(stderr)
    return "\n".join(lines).strip()


def _command_result(
    target: str,
    success: bool,
    error: str | None,
    log: str,
    checkout_path: Path | str,
    flash_device: str | None = None,
    flash_method: str | None = None,
) -> dict[str, Any]:
    normalized_target = _require_supported_target(target)
    path = Path(checkout_path)
    artifacts = list_flash_target_artifacts(normalized_target, path)
    return {
        "target": normalized_target,
        "display_name": _target_display_name(normalized_target),
        "success": success,
        "error": error,
        "log": log,
        "checkout_path": str(path),
        "out_path": str(path / "out"),
        "artifacts": artifacts,
        "primary_artifact": pick_primary_flash_target_artifact(normalized_target, artifacts),
        "flash_device": flash_device or "",
        "flash_method": flash_method or "",
    }


def _build_artifact_path(target: str, checkout_path: Path) -> Path | None:
    normalized_target = _require_supported_target(target)
    artifacts = list_flash_target_artifacts(normalized_target, checkout_path)
    for artifact in artifacts:
        artifact_path = Path(artifact["path"])
        if artifact_path.suffix.lower() == ".bin" and artifact_path.is_file():
            return artifact_path
    primary_artifact = pick_primary_flash_target_artifact(normalized_target, artifacts)
    if primary_artifact is None:
        return None
    artifact_path = Path(primary_artifact["path"])
    return artifact_path if artifact_path.is_file() else None


# Direct dfu-util fallback flags, used when `make -n flash` output cannot be
# parsed into a dfu-util command. Exact flag set to be confirmed against the
# Spider (STM32F446) during Phase 7 research — tune this constant if the
# direct command needs adjusting.
_DFU_UTIL_FALLBACK_FLAGS = ["-a", "0", "-R", "-D"]


def _try_dfu_util_fallback(
    flash_device: str,
    artifact_path: Path | None,
    make_log: str,
) -> tuple[list[str] | None, str | None, str]:
    if artifact_path is None or not artifact_path.is_file():
        return None, "No flashable .bin artifact was found. Build the target before flashing with dfu-util.", make_log
    try:
        completed = subprocess.run(
            ["dfu-util", "-l"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except FileNotFoundError:
        return None, "dfu-util is not available on this SBC.", make_log
    except subprocess.TimeoutExpired:
        return None, "Timed out while listing dfu-util devices.", make_log

    device_listing = "\n".join(chunk for chunk in (completed.stdout, completed.stderr) if chunk)
    if flash_device.lower() not in device_listing.lower():
        logger.warning(
            "dfu-util fallback skipped: %s not present in `dfu-util -l` output",
            flash_device,
        )
        return None, f"dfu-util does not list {flash_device}. Enter DFU/bootloader mode and try again.", make_log

    fallback_log = make_log + ("\n\n" if make_log else "") + _command_log(["dfu-util", "-l"], completed)
    command = ["dfu-util", *_DFU_UTIL_FALLBACK_FLAGS, str(artifact_path)]
    logger.info("using direct dfu-util fallback for %s: %s", flash_device, " ".join(command))
    return command, None, fallback_log


def _resolve_dfu_util_flash_command(
    checkout_path: Path,
    flash_device: str,
    artifact_path: Path | None = None,
) -> tuple[list[str] | None, str | None, str]:
    preview_command = ["make", "-n", "flash", "NOSUDO=1", f"FLASH_DEVICE={flash_device}"]
    try:
        completed = subprocess.run(
            preview_command,
            cwd=checkout_path,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except FileNotFoundError:
        return None, "The `make` command is not available on this SBC.", ""
    except subprocess.TimeoutExpired:
        return None, "Timed out while resolving the dfu-util flash command.", ""

    log = _command_log(preview_command, completed)
    if completed.returncode != 0:
        return _try_dfu_util_fallback(flash_device, artifact_path, log)

    output = "\n".join(chunk for chunk in (completed.stdout, completed.stderr) if chunk)
    for raw_line in output.splitlines():
        line = raw_line.strip()
        if "dfu-util" not in line:
            continue
        start = line.find("dfu-util")
        if start < 0:
            continue
        try:
            tokens = shlex.split(line[start:], posix=True)
        except ValueError:
            continue
        if tokens and tokens[0] == "dfu-util":
            logger.info("resolved dfu-util command for %s: %s", flash_device, " ".join(tokens))
            return tokens, None, log

    logger.warning("dfu-util flash command could not be resolved for %s via `make -n flash`", flash_device)
    return _try_dfu_util_fallback(flash_device, artifact_path, log)


def _run_direct_flash_commands(
    target: str,
    checkout_path: Path,
    flash_command: list[str],
    timeout: int = 900,
) -> dict[str, Any]:
    return _run_commands(
        target,
        checkout_path,
        [
            ["make", "olddefconfig"],
            ["make", f"-j{max(1, os.cpu_count() or 1)}"],
            flash_command,
        ],
        timeout=timeout,
    )


def _run_commands(target: str, checkout_path: Path, commands: list[list[str]], timeout: int) -> dict[str, Any]:
    normalized_target = _require_supported_target(target)
    logs: list[str] = []
    try:
        for command in commands:
            completed = subprocess.run(
                command,
                cwd=checkout_path,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
            logs.append(_command_log(command, completed))
            if completed.returncode != 0:
                return _command_result(
                    normalized_target,
                    False,
                    f"{' '.join(command)} failed with exit code {completed.returncode}.",
                    "\n\n".join(chunk for chunk in logs if chunk),
                    checkout_path,
                )
    except FileNotFoundError:
        return _command_result(
            normalized_target,
            False,
            "The `make` command is not available on this SBC.",
            "\n\n".join(chunk for chunk in logs if chunk),
            checkout_path,
        )
    except subprocess.TimeoutExpired:
        return _command_result(
            normalized_target,
            False,
            f"{_target_display_name(normalized_target)} command timed out.",
            "\n\n".join(chunk for chunk in logs if chunk),
            checkout_path,
        )

    return _command_result(
        normalized_target,
        True,
        None,
        "\n\n".join(chunk for chunk in logs if chunk),
        checkout_path,
    )


def finalize_flash_job_result(
    raw_result: dict,
    target: str,
    kind: str,
    checkout_path: str,
    flash_device: str = "",
    flash_method: str = "",
) -> dict[str, Any]:
    """Enrich a raw job outcome into the standard command-result shape.

    Used by the streaming job status route once a job finishes, and by the
    synchronous build/flash helpers. ``kind`` is 'build' or 'flash'; build
    results are additionally checked for a produced artifact.
    """
    normalized_target = _require_supported_target(target)
    result = _command_result(
        normalized_target,
        bool(raw_result.get("success", False)),
        raw_result.get("error"),
        raw_result.get("log", ""),
        checkout_path,
        flash_device,
        flash_method,
    )
    if kind == "build" and result["success"] and result["primary_artifact"] is None:
        result["success"] = False
        result["error"] = (
            f"{_target_display_name(normalized_target)} build completed but no artifact was found in the out directory."
        )
    return result


def plan_build_flash_job(target: str, checkout_path: str | None = None) -> dict[str, Any]:
    """Resolve a build request into either an immediate result or job commands."""
    normalized_target = _require_supported_target(target)
    resolved_path, error = resolve_flash_target_checkout(normalized_target, checkout_path)
    if resolved_path is None:
        return {
            "immediate": True,
            "result": _command_result(normalized_target, False, error, "", checkout_path or "."),
            "commands": None,
            "checkout_path": None,
            "flash_device": "",
            "flash_method": "",
        }
    return {
        "immediate": False,
        "result": None,
        "commands": [
            ["make", "olddefconfig"],
            ["make", f"-j{max(1, os.cpu_count() or 1)}"],
        ],
        "checkout_path": str(resolved_path),
        "flash_device": "",
        "flash_method": "",
    }


def plan_flash_flash_job(
    target: str,
    checkout_path: str | None = None,
    flash_device: str | None = None,
    flash_method: str | None = None,
) -> dict[str, Any]:
    """Resolve a flash request into either an immediate result or job commands.

    Every validation failure returns ``immediate: True`` with the same
    command-result dict the synchronous path produced; the happy path returns
    the exact command sequence the job runner should execute.
    """
    normalized_target = _require_supported_target(target)
    resolved_path, error = resolve_flash_target_checkout(normalized_target, checkout_path)
    if resolved_path is None:
        return {
            "immediate": True,
            "result": _command_result(
                normalized_target, False, error, "", checkout_path or ".", flash_device, flash_method
            ),
            "commands": None,
            "checkout_path": None,
            "flash_device": flash_device or "",
            "flash_method": flash_method or "",
        }

    def immediate(result: dict[str, Any]) -> dict[str, Any]:
        return {
            "immediate": True,
            "result": result,
            "commands": None,
            "checkout_path": str(resolved_path),
            "flash_device": flash_device or "",
            "flash_method": flash_method or "",
        }

    state = get_flash_target_state(normalized_target, str(resolved_path))
    if not state["flash_supported"]:
        return immediate(_command_result(
            normalized_target,
            False,
            state["flash_reason"] or "Flashing is not supported for this target.",
            "",
            resolved_path,
            flash_device,
            flash_method,
        ))

    method_candidates_list = state.get("flash_method_candidates", [])
    method_candidates = {
        candidate["value"]: candidate
        for candidate in method_candidates_list
    }
    initial_device = (flash_device or "").strip() or state.get("default_flash_device", "")
    requested_method = (flash_method or "").strip()
    resolved_method = requested_method or _preferred_flash_method_for_device(
        initial_device,
        method_candidates_list,
        state.get("flash_device_candidates", []),
    ) or state.get("default_flash_method", "")
    method_state = method_candidates.get(resolved_method)
    if method_state is None:
        return immediate(_command_result(
            normalized_target,
            False,
            "A supported flash method must be selected for the current target.",
            "",
            resolved_path,
            flash_device,
            flash_method,
        ))

    resolved_device = (flash_device or "").strip() or method_state.get("default_device", "") or state.get("default_flash_device", "")
    if method_state["device_required"] and not resolved_device:
        return immediate(_command_result(
            normalized_target,
            False,
            "A flash device is required for the current target.",
            "",
            resolved_path,
            flash_device,
            resolved_method,
        ))

    make_jobs = f"-j{max(1, os.cpu_count() or 1)}"

    if resolved_method == _FLASH_METHOD_DFU_UTIL:
        if not _is_usb_id(resolved_device):
            return immediate(_command_result(
                normalized_target,
                False,
                "dfu-util requires a USB VID:PID flash device such as 0483:df11.",
                "",
                resolved_path,
                resolved_device,
                resolved_method,
            ))
        flash_command, resolve_error, resolve_log = _resolve_dfu_util_flash_command(
            resolved_path,
            resolved_device,
            _build_artifact_path(normalized_target, resolved_path),
        )
        if flash_command is None:
            return immediate(_command_result(
                normalized_target,
                False,
                resolve_error,
                resolve_log,
                resolved_path,
                resolved_device,
                resolved_method,
            ))
        commands = [
            ["make", "olddefconfig"],
            ["make", make_jobs],
            flash_command,
        ]
    elif resolved_method == _FLASH_METHOD_FLASHTOOL:
        katapult_script_path = _katapult_flashtool_path(normalized_target, resolved_path)
        if katapult_script_path is None:
            return immediate(_command_result(
                normalized_target,
                False,
                "Katapult is not installed on this SBC, so flashtool.py is unavailable.",
                "",
                resolved_path,
                resolved_device,
                resolved_method,
            ))
        artifact_path = _build_artifact_path(normalized_target, resolved_path)
        if artifact_path is None:
            return immediate(_command_result(
                normalized_target,
                False,
                "No flashable build artifact was found. Build the target before flashing with flashtool.py.",
                "",
                resolved_path,
                resolved_device,
                resolved_method,
            ))
        can_device = _parse_can_flash_device(resolved_device)
        if can_device is not None:
            interface, uuid = can_device
            flash_command = [
                "python3",
                str(katapult_script_path),
                "-i",
                interface,
                "-f",
                str(artifact_path),
                "-u",
                uuid,
            ]
        elif _is_usb_id(resolved_device):
            return immediate(_command_result(
                normalized_target,
                False,
                "flashtool.py requires a serial device path or a CAN UUID, not a USB VID:PID.",
                "",
                resolved_path,
                resolved_device,
                resolved_method,
            ))
        else:
            flash_command = [
                "python3",
                str(katapult_script_path),
                "-d",
                resolved_device,
                "-f",
                str(artifact_path),
            ]
        commands = [
            ["make", "olddefconfig"],
            ["make", make_jobs],
            flash_command,
        ]
    else:
        flash_command = ["make", "flash", "NOSUDO=1"]
        if resolved_device:
            flash_command.append(f"FLASH_DEVICE={resolved_device}")
        commands = [
            ["make", "olddefconfig"],
            flash_command,
        ]

    # Stop Klipper before flashing (it holds the USB-ACM serial / CAN node the
    # flash tools talk to) and restart it afterwards. systemctl stop is only
    # issued when the service is actually active, so hosts without a running
    # Klipper (e.g. the dev Pi) skip orchestration entirely; the restart is a
    # cleanup command, guaranteed to run even when the flash fails or cancels.
    klipper_stop = klipper_service_stop_command()
    cleanup_commands: list[list[str]] = []
    if klipper_stop is not None:
        commands.insert(0, klipper_stop)
        klipper_start = klipper_service_start_command()
        if klipper_start is not None:
            cleanup_commands.append(klipper_start)

    return {
        "immediate": False,
        "result": None,
        "commands": commands,
        "cleanup_commands": cleanup_commands,
        "checkout_path": str(resolved_path),
        "flash_device": resolved_device,
        "flash_method": resolved_method,
    }


def build_flash_target(target: str, checkout_path: str | None = None) -> dict[str, Any]:
    normalized_target = _require_supported_target(target)
    planned = plan_build_flash_job(normalized_target, checkout_path)
    if planned["immediate"]:
        return planned["result"]

    _start = time.monotonic()
    logger.info("build %s starting at %s", normalized_target, planned["checkout_path"])
    result = _run_commands(
        normalized_target,
        Path(planned["checkout_path"]),
        planned["commands"],
        timeout=900,
    )
    result = finalize_flash_job_result(
        result,
        normalized_target,
        "build",
        planned["checkout_path"],
    )
    logger.info(
        "build %s finished: success=%s artifact=%s (%.0f s)",
        normalized_target,
        result["success"],
        (result.get("primary_artifact") or {}).get("name"),
        time.monotonic() - _start,
    )
    return result


def flash_flash_target(
    target: str,
    checkout_path: str | None = None,
    flash_device: str | None = None,
    flash_method: str | None = None,
) -> dict[str, Any]:
    normalized_target = _require_supported_target(target)
    planned = plan_flash_flash_job(normalized_target, checkout_path, flash_device, flash_method)
    if planned["immediate"]:
        return planned["result"]

    _start = time.monotonic()
    logger.info(
        "flash %s requested: method=%s device=%s",
        normalized_target,
        flash_method or "(auto)",
        flash_device or "(default)",
    )
    result = _run_commands(
        normalized_target,
        Path(planned["checkout_path"]),
        planned["commands"],
        timeout=900,
    )
    result = finalize_flash_job_result(
        result,
        normalized_target,
        "flash",
        planned["checkout_path"],
        planned["flash_device"],
        planned["flash_method"],
    )
    logger.info(
        "flash %s finished: method=%s device=%s success=%s (%.0f s)",
        normalized_target,
        planned["flash_method"],
        planned["flash_device"],
        result["success"],
        time.monotonic() - _start,
    )
    return result


def get_flash_target_artifact_path(target: str, filename: str, checkout_path: str | None = None) -> Path:
    normalized_target = _require_supported_target(target)
    if not filename or Path(filename).name != filename:
        raise ValueError("Invalid artifact filename")

    resolved_path, error = resolve_flash_target_checkout(normalized_target, checkout_path)
    if resolved_path is None:
        raise FileNotFoundError(error or f"{_target_display_name(normalized_target)} checkout not found")

    artifact_path = resolved_path / "out" / filename
    if not _is_flash_target_artifact(normalized_target, artifact_path):
        raise FileNotFoundError(f"Artifact not found: {filename}")
    return artifact_path


def delete_flash_target_artifact(target: str, filename: str, checkout_path: str | None = None) -> dict[str, Any]:
    normalized_target = _require_supported_target(target)
    artifact_path = get_flash_target_artifact_path(normalized_target, filename, checkout_path)
    checkout_root = artifact_path.parent.parent
    artifact_path.unlink()
    artifacts = list_flash_target_artifacts(normalized_target, checkout_root)
    return {
        "status": "deleted",
        "target": normalized_target,
        "display_name": _target_display_name(normalized_target),
        "filename": filename,
        "checkout_path": str(checkout_root),
        "out_path": str(checkout_root / "out"),
        "artifacts": artifacts,
        "primary_artifact": pick_primary_flash_target_artifact(normalized_target, artifacts),
    }