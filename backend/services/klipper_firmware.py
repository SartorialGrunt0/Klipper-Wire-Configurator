"""Klipper-specific compatibility wrappers for the shared flash target service."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from services.flash_targets import (
    _load_target_kconfig_state,
    build_flash_target,
    flash_flash_target,
    get_flash_target_state,
    list_flash_target_artifacts,
    pick_primary_flash_target_artifact,
    preview_flash_target_config,
    resolve_flash_target_checkout,
    save_flash_target_config,
)


def _legacy_state_keys(state: dict[str, Any]) -> dict[str, Any]:
    result = dict(state)
    result["klipper_path"] = result.pop("checkout_path", "")
    return result


def _legacy_result_keys(result: dict[str, Any]) -> dict[str, Any]:
    mapped = dict(result)
    mapped["klipper_path"] = mapped.pop("checkout_path", "")
    return mapped


def resolve_klipper_checkout(requested_path: str | None = None) -> tuple[Path | None, str | None]:
    return resolve_flash_target_checkout("klipper", requested_path)


def _load_kconfig_state(klipper_path: Path):
    return _load_target_kconfig_state("klipper", klipper_path)


def list_klipper_firmware_artifacts(klipper_path: str | Path) -> list[dict[str, Any]]:
    return list_flash_target_artifacts("klipper", klipper_path)


def pick_primary_klipper_firmware_artifact(artifacts: list[dict[str, Any]]) -> dict[str, Any] | None:
    return pick_primary_flash_target_artifact("klipper", artifacts)


def get_klipper_firmware_state(klipper_path: str | None = None) -> dict[str, Any]:
    return _legacy_state_keys(get_flash_target_state("klipper", klipper_path))


def preview_klipper_menuconfig(assignments: list[tuple[str, str]], klipper_path: str | None = None) -> dict[str, Any]:
    return _legacy_state_keys(preview_flash_target_config("klipper", assignments, klipper_path))


def save_klipper_menuconfig(assignments: list[tuple[str, str]], klipper_path: str | None = None) -> dict[str, Any]:
    return _legacy_state_keys(save_flash_target_config("klipper", assignments, klipper_path))


def build_klipper_firmware(klipper_path: str | None = None) -> dict[str, Any]:
    return _legacy_result_keys(build_flash_target("klipper", klipper_path))


def flash_klipper_firmware(klipper_path: str | None = None, flash_device: str | None = None) -> dict[str, Any]:
    return _legacy_result_keys(flash_flash_target("klipper", klipper_path, flash_device))


def get_klipper_firmware_artifact_path(filename: str, klipper_path: str | None = None) -> Path:
    if not filename or Path(filename).name != filename:
        raise ValueError("Invalid artifact filename")

    resolved_path, error = resolve_klipper_checkout(klipper_path)
    if resolved_path is None:
        raise FileNotFoundError(error or "Klipper checkout not found")

    artifact_path = resolved_path / "out" / filename
    if artifact_path.name not in {artifact["name"] for artifact in list_klipper_firmware_artifacts(resolved_path)}:
        raise FileNotFoundError(f"Firmware artifact not found: {filename}")
    return artifact_path
