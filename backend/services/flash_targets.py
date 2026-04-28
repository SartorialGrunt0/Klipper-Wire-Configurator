"""Shared Kconfig-backed build and flash helpers for local firmware targets."""
from __future__ import annotations

import functools
import getpass
import importlib.util
import json
import os
import subprocess
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from services.native_services import load_settings, save_settings

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
            return candidate, None

    display_name = _target_display_name(normalized_target)
    if requested_path:
        return None, (
            f"{display_name} checkout not found at {requested_path}. "
            "Expected Makefile, src/Kconfig, and lib/kconfiglib/kconfiglib.py."
        )

    attempted = ", ".join(str(path) for path in candidates) or "no candidate paths"
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


def _load_target_kconfig_state(target: str, checkout_path: Path):
    normalized_target = _require_supported_target(target)
    kconfiglib = _load_kconfiglib_module(str(checkout_path / "lib" / "kconfiglib" / "kconfiglib.py"))
    config_path = checkout_path / ".config"
    with _temporary_env("srctree", str(checkout_path)):
        kconf = kconfiglib.Kconfig(str(checkout_path / "src" / "Kconfig"))
        if config_path.is_file():
            kconf.load_config(str(config_path))
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


def _serialize_symbol_field(kconfiglib, node) -> dict[str, Any] | None:
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
        "help": node.help or "",
        "menu_path": _menu_path(kconfiglib, node),
        "assignable": _serialize_assignable(symbol),
    }


def _serialize_choice_field(kconfiglib, node) -> dict[str, Any] | None:
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
        "help": node.help or "",
        "menu_path": _menu_path(kconfiglib, node),
        "assignable": [option["symbol"] for option in options],
        "options": options,
    }


def _serialize_kconfig_fields(kconfiglib, kconf) -> list[dict[str, Any]]:
    fields: list[dict[str, Any]] = []
    for node in kconf.node_iter():
        item = node.item
        field: dict[str, Any] | None = None
        if isinstance(item, kconfiglib.Choice):
            field = _serialize_choice_field(kconfiglib, node)
        elif isinstance(item, kconfiglib.Symbol):
            field = _serialize_symbol_field(kconfiglib, node)
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
            "help": "Runs `make flash NOSUDO=1 FLASH_DEVICE=...` using Katapult's STM32 DFU flow.",
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
) -> dict[str, Any]:
    normalized_target = _require_supported_target(target)
    resolved_path, error = resolve_flash_target_checkout(normalized_target, checkout_path)
    if resolved_path is None:
        return _empty_flash_target_state(normalized_target, checkout_path, error)

    kconfiglib, kconf, config_path = _load_target_kconfig_state(normalized_target, resolved_path)
    issues = _apply_assignments_to_kconfig(kconfiglib, kconf, assignments or [])
    artifacts = list_flash_target_artifacts(normalized_target, resolved_path)
    flash_capabilities = _flash_capabilities(normalized_target, kconf)

    state = {
        "target": normalized_target,
        "display_name": _target_display_name(normalized_target),
        "available": True,
        "error": None,
        "checkout_path": str(resolved_path),
        "config_path": str(config_path),
        "out_path": str(resolved_path / "out"),
        "config_exists": config_path.is_file(),
        "fields": _serialize_kconfig_fields(kconfiglib, kconf),
        "artifacts": artifacts,
        "primary_artifact": pick_primary_flash_target_artifact(normalized_target, artifacts),
        "flash_supported": flash_capabilities["supported"],
        "flash_reason": flash_capabilities["reason"],
        "flash_device_required": flash_capabilities["device_required"],
        "flash_device_placeholder": flash_capabilities["device_placeholder"],
        "default_flash_device": flash_capabilities["default_device"],
        "flash_help": flash_capabilities["help"],
    }
    if issues:
        state["error"] = "; ".join(issues)
    return state


def preview_flash_target_config(
    target: str,
    assignments: list[tuple[str, str]],
    checkout_path: str | None = None,
) -> dict[str, Any]:
    return get_flash_target_state(target, checkout_path, assignments)


def save_flash_target_config(
    target: str,
    assignments: list[tuple[str, str]],
    checkout_path: str | None = None,
) -> dict[str, Any]:
    normalized_target = _require_supported_target(target)
    resolved_path, error = resolve_flash_target_checkout(normalized_target, checkout_path)
    if resolved_path is None:
        return _empty_flash_target_state(normalized_target, checkout_path, error)

    kconfiglib, kconf, config_path = _load_target_kconfig_state(normalized_target, resolved_path)
    issues = _apply_assignments_to_kconfig(kconfiglib, kconf, assignments)
    kconf.write_config(str(config_path))
    state = get_flash_target_state(normalized_target, str(resolved_path))
    if issues:
        state["error"] = "; ".join(issues)
    return state


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
    }


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


def build_flash_target(target: str, checkout_path: str | None = None) -> dict[str, Any]:
    normalized_target = _require_supported_target(target)
    resolved_path, error = resolve_flash_target_checkout(normalized_target, checkout_path)
    if resolved_path is None:
        return _command_result(normalized_target, False, error, "", checkout_path or ".")

    result = _run_commands(
        normalized_target,
        resolved_path,
        [
            ["make", "olddefconfig"],
            ["make", f"-j{max(1, os.cpu_count() or 1)}"],
        ],
        timeout=900,
    )
    if result["success"] and result["primary_artifact"] is None:
        result["success"] = False
        result["error"] = (
            f"{_target_display_name(normalized_target)} build completed but no artifact was found in the out directory."
        )
    return result


def flash_flash_target(
    target: str,
    checkout_path: str | None = None,
    flash_device: str | None = None,
) -> dict[str, Any]:
    normalized_target = _require_supported_target(target)
    resolved_path, error = resolve_flash_target_checkout(normalized_target, checkout_path)
    if resolved_path is None:
        return _command_result(normalized_target, False, error, "", checkout_path or ".", flash_device)

    state = get_flash_target_state(normalized_target, str(resolved_path))
    if not state["flash_supported"]:
        return _command_result(
            normalized_target,
            False,
            state["flash_reason"] or "Flashing is not supported for this target.",
            "",
            resolved_path,
            flash_device,
        )

    resolved_device = (flash_device or "").strip() or state.get("default_flash_device", "")
    if state["flash_device_required"] and not resolved_device:
        return _command_result(
            normalized_target,
            False,
            "A flash device is required for the current target.",
            "",
            resolved_path,
            flash_device,
        )

    flash_command = ["make", "flash", "NOSUDO=1"]
    if resolved_device:
        flash_command.append(f"FLASH_DEVICE={resolved_device}")

    result = _run_commands(
        normalized_target,
        resolved_path,
        [
            ["make", "olddefconfig"],
            flash_command,
        ],
        timeout=900,
    )
    result["flash_device"] = resolved_device
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