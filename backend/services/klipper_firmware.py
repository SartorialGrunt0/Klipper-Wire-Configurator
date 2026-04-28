"""Helpers for exposing Klipper menuconfig and firmware builds to the native UI."""
from __future__ import annotations

import functools
import getpass
import importlib.util
import os
import subprocess
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from services.native_services import load_settings, save_settings

_ARTIFACT_PRIORITY = {
    "klipper.uf2": 0,
    "klipper.bin": 1,
    "klipper.elf.hex": 2,
    "ar100.bin": 3,
    "pru0.elf": 4,
    "pru1.elf": 5,
}

_TRISTATE_VALUE_NAMES = {
    0: "n",
    1: "m",
    2: "y",
}


def _candidate_klipper_paths(requested_path: str | None = None) -> list[Path]:
    settings = load_settings()
    user = getpass.getuser()
    values = [
        requested_path,
        settings.get("klipper_path"),
        os.environ.get("KWC_KLIPPER_PATH"),
        "~/klipper",
        f"/home/{user}/klipper",
        "/home/pi/klipper",
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


def _is_klipper_checkout(path: Path) -> bool:
    return (
        path.is_dir()
        and (path / "Makefile").is_file()
        and (path / "src" / "Kconfig").is_file()
        and (path / "lib" / "kconfiglib" / "kconfiglib.py").is_file()
    )


def resolve_klipper_checkout(requested_path: str | None = None) -> tuple[Path | None, str | None]:
    candidates = _candidate_klipper_paths(requested_path)
    for candidate in candidates:
        if _is_klipper_checkout(candidate):
            _persist_klipper_path(candidate)
            return candidate, None

    if requested_path:
        return None, (
            f"Klipper checkout not found at {requested_path}. "
            "Expected Makefile, src/Kconfig, and lib/kconfiglib/kconfiglib.py."
        )

    attempted = ", ".join(str(path) for path in candidates) or "no candidate paths"
    return None, (
        "Klipper is not installed on this SBC or its checkout could not be auto-detected. "
        f"Checked: {attempted}."
    )


def _persist_klipper_path(path: Path) -> None:
    settings = load_settings()
    value = str(path)
    if settings.get("klipper_path") == value:
        return
    settings["klipper_path"] = value
    save_settings(settings)


@functools.lru_cache(maxsize=4)
def _load_kconfiglib_module(module_path: str):
    spec = importlib.util.spec_from_file_location("kwc_klipper_kconfiglib", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load Klipper kconfiglib from {module_path}")
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


def _load_kconfig_state(klipper_path: Path):
    kconfiglib = _load_kconfiglib_module(str(klipper_path / "lib" / "kconfiglib" / "kconfiglib.py"))
    config_path = klipper_path / ".config"
    with _temporary_env("srctree", str(klipper_path)):
        kconf = kconfiglib.Kconfig(str(klipper_path / "src" / "Kconfig"))
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


def _is_firmware_artifact(path: Path) -> bool:
    if not path.is_file():
        return False
    if path.name in _ARTIFACT_PRIORITY:
        return True
    return path.name.startswith("klipper.") and path.suffix in {".bin", ".hex", ".uf2"}


def list_klipper_firmware_artifacts(klipper_path: str | Path) -> list[dict[str, Any]]:
    root = Path(klipper_path)
    out_dir = root / "out"
    if not out_dir.is_dir():
        return []

    artifacts = []
    for artifact in out_dir.iterdir():
        if not _is_firmware_artifact(artifact):
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
            _ARTIFACT_PRIORITY.get(item["name"], 100),
            -item["modified"],
            item["name"],
        ),
    )
    return artifacts


def pick_primary_klipper_firmware_artifact(artifacts: list[dict[str, Any]]) -> dict[str, Any] | None:
    return artifacts[0] if artifacts else None


def get_klipper_firmware_state(klipper_path: str | None = None) -> dict[str, Any]:
    resolved_path, error = resolve_klipper_checkout(klipper_path)
    if resolved_path is None:
        return {
            "available": False,
            "error": error,
            "klipper_path": klipper_path or "~/klipper",
            "config_path": "",
            "out_path": "",
            "config_exists": False,
            "fields": [],
            "artifacts": [],
            "primary_artifact": None,
        }

    try:
        kconfiglib, kconf, config_path = _load_kconfig_state(resolved_path)
    except Exception as exc:  # kconfiglib raises many types; catch broadly
        return {
            "available": False,
            "error": f"Failed to load Klipper build config: {exc}",
            "klipper_path": str(resolved_path),
            "config_path": "",
            "out_path": str(resolved_path / "out"),
            "config_exists": False,
            "fields": [],
            "artifacts": list_klipper_firmware_artifacts(resolved_path),
            "primary_artifact": None,
        }
    artifacts = list_klipper_firmware_artifacts(resolved_path)
    return {
        "available": True,
        "error": None,
        "klipper_path": str(resolved_path),
        "config_path": str(config_path),
        "out_path": str(resolved_path / "out"),
        "config_exists": config_path.is_file(),
        "fields": _serialize_kconfig_fields(kconfiglib, kconf),
        "artifacts": artifacts,
        "primary_artifact": pick_primary_klipper_firmware_artifact(artifacts),
    }


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


def save_klipper_menuconfig(assignments: list[tuple[str, str]], klipper_path: str | None = None) -> dict[str, Any]:
    resolved_path, error = resolve_klipper_checkout(klipper_path)
    if resolved_path is None:
        return get_klipper_firmware_state(klipper_path)

    try:
        kconfiglib, kconf, config_path = _load_kconfig_state(resolved_path)
    except Exception as exc:  # kconfiglib raises many types; catch broadly
        state = get_klipper_firmware_state(str(resolved_path))
        state["error"] = f"Failed to load Klipper build config: {exc}"
        return state
    issues: list[str] = []

    for symbol_name, raw_value in assignments:
        symbol = kconf.syms.get(symbol_name)
        if symbol is None:
            issues.append(f"Unknown symbol: {symbol_name}")
            continue
        normalized = _normalize_assignment_value(kconfiglib, symbol, raw_value)
        if not symbol.set_value(normalized):
            issues.append(f"Unable to set {symbol_name} to {normalized}")

    kconf.write_config(str(config_path))
    state = get_klipper_firmware_state(str(resolved_path))
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


def build_klipper_firmware(klipper_path: str | None = None) -> dict[str, Any]:
    resolved_path, error = resolve_klipper_checkout(klipper_path)
    if resolved_path is None:
        return {
            "success": False,
            "error": error,
            "log": "",
            "klipper_path": klipper_path or "",
            "out_path": "",
            "artifacts": [],
            "primary_artifact": None,
        }

    commands = [
        ["make", "olddefconfig"],
        ["make", f"-j{max(1, os.cpu_count() or 1)}"],
    ]

    logs: list[str] = []
    try:
        for command in commands:
            completed = subprocess.run(
                command,
                cwd=resolved_path,
                capture_output=True,
                text=True,
                timeout=900,
                check=False,
            )
            logs.append(_command_log(command, completed))
            if completed.returncode != 0:
                artifacts = list_klipper_firmware_artifacts(resolved_path)
                return {
                    "success": False,
                    "error": f"{' '.join(command)} failed with exit code {completed.returncode}.",
                    "log": "\n\n".join(chunk for chunk in logs if chunk),
                    "klipper_path": str(resolved_path),
                    "out_path": str(resolved_path / 'out'),
                    "artifacts": artifacts,
                    "primary_artifact": pick_primary_klipper_firmware_artifact(artifacts),
                }
    except FileNotFoundError:
        return {
            "success": False,
            "error": "The `make` command is not available on this SBC.",
            "log": "",
            "klipper_path": str(resolved_path),
            "out_path": str(resolved_path / 'out'),
            "artifacts": [],
            "primary_artifact": None,
        }
    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "error": "Klipper firmware build timed out.",
            "log": "\n\n".join(chunk for chunk in logs if chunk),
            "klipper_path": str(resolved_path),
            "out_path": str(resolved_path / 'out'),
            "artifacts": list_klipper_firmware_artifacts(resolved_path),
            "primary_artifact": pick_primary_klipper_firmware_artifact(list_klipper_firmware_artifacts(resolved_path)),
        }

    artifacts = list_klipper_firmware_artifacts(resolved_path)
    primary_artifact = pick_primary_klipper_firmware_artifact(artifacts)
    if primary_artifact is None:
        return {
            "success": False,
            "error": "Klipper build completed but no firmware artifact was found in the out directory.",
            "log": "\n\n".join(chunk for chunk in logs if chunk),
            "klipper_path": str(resolved_path),
            "out_path": str(resolved_path / 'out'),
            "artifacts": artifacts,
            "primary_artifact": None,
        }

    return {
        "success": True,
        "error": None,
        "log": "\n\n".join(chunk for chunk in logs if chunk),
        "klipper_path": str(resolved_path),
        "out_path": str(resolved_path / 'out'),
        "artifacts": artifacts,
        "primary_artifact": primary_artifact,
    }


def get_klipper_firmware_artifact_path(filename: str, klipper_path: str | None = None) -> Path:
    if not filename or Path(filename).name != filename:
        raise ValueError("Invalid artifact filename")

    resolved_path, error = resolve_klipper_checkout(klipper_path)
    if resolved_path is None:
        raise FileNotFoundError(error or "Klipper checkout not found")

    artifact_path = resolved_path / "out" / filename
    if not _is_firmware_artifact(artifact_path):
        raise FileNotFoundError(f"Firmware artifact not found: {filename}")
    return artifact_path