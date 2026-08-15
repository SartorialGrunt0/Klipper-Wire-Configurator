"""API routes for native Raspberry Pi features."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from parser.config_parser import parse_config
from parser.config_writer import smart_export
from parser.validator import validate_project_configs
from services.board_detector import detect_board_from_config
from services.native_services import (
    delete_flash_profile,
    firmware_restart_klipper,
    get_all_devices,
    get_default_config_path,
    get_klippy_log_excerpt,
    is_native_platform,
    list_flash_profiles,
    list_config_files,
    load_flash_profile,
    query_canbus_uuids,
    read_config_file,
    write_config_file,
    save_layout,
    load_layout,
    delete_layout,
    load_settings,
    save_flash_profile,
    query_klipper_status,
    save_settings,
)
from services.klipper_firmware import (
    build_klipper_firmware,
    flash_klipper_firmware,
    get_klipper_firmware_artifact_path,
    get_klipper_firmware_state,
    preview_klipper_menuconfig,
    save_klipper_menuconfig,
)
from services.flash_targets import (
    build_flash_target,
    delete_flash_target_artifact,
    flash_flash_target,
    get_flash_target_artifact_path,
    get_flash_target_state,
    preview_flash_target_config,
    save_flash_target_config,
    scan_flash_target_devices,
)

router = APIRouter()


# ── Status ──────────────────────────────────────────────────────


@router.get("/status")
async def native_status():
    """Report whether native (Pi) features are available."""
    settings = load_settings() if is_native_platform() else {}
    return {
        "native": is_native_platform(),
        "config_path": settings.get("config_path", get_default_config_path()),
    }


# ── Devices ─────────────────────────────────────────────────────


@router.get("/devices")
async def list_devices():
    """List available serial, CAN, and UART devices."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Device detection is only available on the Raspberry Pi")
    return get_all_devices()


@router.get("/canbus-uuids")
async def get_canbus_uuids(interface: str = "can0"):
    """Query CAN bus UUIDs on a given interface."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="CAN bus query is only available on the Raspberry Pi")
    return query_canbus_uuids(interface)


# ── Config path settings ───────────────────────────────────────


class ConfigPathUpdate(BaseModel):
    config_path: str


@router.get("/settings")
async def get_settings():
    """Get native settings (config path, etc.)."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Native settings only available on Pi")
    return load_settings()


@router.put("/settings")
async def update_settings(data: ConfigPathUpdate):
    """Update native settings."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Native settings only available on Pi")
    settings = load_settings()
    settings["config_path"] = data.config_path
    save_settings(settings)
    return settings


# ── Config files from Pi ────────────────────────────────────────


@router.get("/config-files")
async def get_config_files(path: str | None = None):
    """List .cfg files in the config directory."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Only available on Pi")
    config_path = path or load_settings().get("config_path", get_default_config_path())
    files = list_config_files(config_path)
    return {"config_path": config_path, "files": files}


@router.post("/config-files/read")
async def read_config_files(data: dict):
    """Read and parse one or more config files from the Pi."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Only available on Pi")

    config_path = data.get("config_path") or load_settings().get("config_path", get_default_config_path())
    filenames: list[str] = data.get("filenames", [])

    if not filenames:
        raise HTTPException(status_code=400, detail="No filenames provided")

    base = Path(config_path)
    # Validate all paths are under the config directory (don't resolve symlinks)
    for fn in filenames:
        if '..' in fn or fn.startswith('/'):
            raise HTTPException(status_code=400, detail=f"Invalid filename: {fn}")
        candidate = base / fn
        # Check the un-resolved path is under base
        try:
            candidate.relative_to(base)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid filename: {fn}")

    configs = {}
    raw_texts = {}
    board_infos = {}
    for fn in filenames:
        file_path = base / fn
        if not file_path.exists():
            continue
        text = read_config_file(str(file_path))
        config = parse_config(text, fn)
        configs[fn] = config
        raw_texts[fn] = text
        board_infos[fn] = detect_board_from_config(config)

    validations = validate_project_configs(configs)
    results = {
        filename: {
            "config": config.to_dict(),
            "validation": validations[filename].to_dict(),
            "board_info": board_infos[filename],
            "raw_text": raw_texts[filename],
        }
        for filename, config in configs.items()
    }

    # Discover MCUs
    mcus = []
    for filename, config in configs.items():
        for sec in config.sections:
            if sec.section_type == "mcu":
                mcus.append({
                    "name": sec.section_name or "",
                    "file": filename,
                    "params": {p.key: p.value for p in sec.params if not p.is_commented_out},
                })

    # Detect main file
    main_file = "printer.cfg" if "printer.cfg" in configs else None
    if not main_file and configs:
        main_file = max(configs.keys(), key=lambda fn: len(configs[fn].includes))

    # Resolve includes
    resolved_includes = []
    if main_file and main_file in configs:
        for inc in configs[main_file].includes:
            inc_basename = inc.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
            matched = inc_basename in configs
            resolved_includes.append({
                "path": inc,
                "resolved": matched,
                "filename": inc_basename if matched else None,
            })

    return {
        "files": results,
        "project": {
            "main_file": main_file,
            "mcus": mcus,
            "includes": resolved_includes,
            "file_count": len(results),
        },
    }


# ── Apply changes to active config ─────────────────────────────


class ApplyRequest(BaseModel):
    config_path: str | None = None
    files: dict[str, str]  # filename → config text
    deleted: list[str] = []  # filenames to remove from the config dir


@router.post("/apply")
async def apply_config(data: ApplyRequest):
    """Write config files back to the Pi filesystem."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Only available on Pi")

    config_path = data.config_path or load_settings().get("config_path", get_default_config_path())
    base = Path(config_path)

    if not base.is_dir():
        raise HTTPException(status_code=400, detail=f"Config directory does not exist: {config_path}")

    written = []
    errors = []
    for filename, content in data.files.items():
        # Validate path is safe (no traversal, don't resolve symlinks)
        if '..' in filename or filename.startswith('/'):
            raise HTTPException(status_code=400, detail=f"Invalid filename: {filename}")
        try:
            write_config_file(str(base / filename), content)
            written.append(filename)
        except PermissionError:
            errors.append(f"Permission denied: {filename}")
        except OSError as e:
            errors.append(f"{filename}: {e}")

    removed = []
    for filename in data.deleted:
        if '..' in filename or filename.startswith('/'):
            raise HTTPException(status_code=400, detail=f"Invalid filename: {filename}")
        target = base / filename
        try:
            if target.is_file():
                target.unlink()
                removed.append(filename)
        except PermissionError:
            errors.append(f"Permission denied: {filename}")
        except OSError as e:
            errors.append(f"{filename}: {e}")

    if errors and not written and not removed:
        raise HTTPException(status_code=500, detail="Failed to write files: " + "; ".join(errors))

    result = {"status": "applied", "files": written, "removed": removed, "config_path": config_path}
    if errors:
        result["warnings"] = errors
    return result


# ── Klipper control ───────────────────────────────────────────


@router.post("/klipper/firmware-restart")
async def klipper_firmware_restart():
    """Send FIRMWARE_RESTART to Klipper via its Unix socket API."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Only available on Pi")
    try:
        return firmware_restart_klipper()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/klipper/status")
async def klipper_status():
    """Get current Klipper state and recent log errors when not ready."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Only available on Pi")
    try:
        return query_klipper_status()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


class KlippyLogExcerptRequest(BaseModel):
    section_name: str | None = None
    error_text: str | None = None
    context_lines: int = 40


@router.post("/klipper/log-excerpt")
async def klipper_log_excerpt(data: KlippyLogExcerptRequest):
    """Get a targeted klippy.log excerpt for a restart failure analysis request."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Only available on Pi")
    try:
        return get_klippy_log_excerpt(
            section_name=data.section_name,
            error_text=data.error_text,
            context_lines=data.context_lines,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


class FirmwareAssignment(BaseModel):
    symbol: str
    value: str


class FirmwareConfigUpdate(BaseModel):
    klipper_path: str | None = None
    assignments: list[FirmwareAssignment] = []


class FirmwareBuildRequest(BaseModel):
    klipper_path: str | None = None


class FlashTargetConfigUpdate(BaseModel):
    checkout_path: str | None = None
    assignments: list[FirmwareAssignment] = []


class FlashTargetCommandRequest(BaseModel):
    checkout_path: str | None = None
    flash_device: str | None = None
    flash_method: str | None = None


class FlashProfileSaveRequest(BaseModel):
    name: str
    checkout_path: str | None = None
    flash_device: str | None = None
    flash_method: str | None = None
    assignments: list[FirmwareAssignment] = []


def _validated_target(target: str) -> str:
    normalized = target.strip().lower()
    if normalized not in {"klipper", "katapult"}:
        raise HTTPException(status_code=404, detail=f"Unsupported flash target: {target}")
    return normalized


@router.get("/flash/{target}")
async def flash_target_state(target: str, checkout_path: str | None = None):
    """Return menuconfig fields and artifacts for a local flash target checkout."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Only available on Pi")
    return get_flash_target_state(_validated_target(target), checkout_path)


@router.get("/flash/{target}/scan-devices")
async def scan_flash_target_devices_api(
    target: str,
    checkout_path: str | None = None,
    force_refresh: bool = False,
):
    """Scan for connected flash devices (USB DFU, serial, CAN UUIDs).

    This runs slow hardware discovery asynchronously so the main state load is
    not blocked.  Results are cached for 30 seconds; pass ``force_refresh=true``
    to bypass the cache.
    """
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Only available on Pi")
    return scan_flash_target_devices(_validated_target(target), checkout_path, force_refresh)



@router.post("/flash/{target}/preview")
async def preview_flash_target(target: str, data: FlashTargetConfigUpdate):
    """Preview menuconfig changes without persisting the target's .config file."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Only available on Pi")
    assignments = [(item.symbol, item.value) for item in data.assignments]
    return preview_flash_target_config(_validated_target(target), assignments, data.checkout_path)


@router.put("/flash/{target}/config")
async def save_flash_target(target: str, data: FlashTargetConfigUpdate):
    """Persist menuconfig selections to the target's active .config file."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Only available on Pi")
    assignments = [(item.symbol, item.value) for item in data.assignments]
    return save_flash_target_config(_validated_target(target), assignments, data.checkout_path)


@router.post("/flash/{target}/build")
async def build_flash_target_api(target: str, data: FlashTargetCommandRequest):
    """Run `make olddefconfig` and `make` for a local flash target checkout."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Only available on Pi")
    return build_flash_target(_validated_target(target), data.checkout_path)


@router.post("/flash/{target}/flash")
async def flash_target_api(target: str, data: FlashTargetCommandRequest):
    """Run the selected flash method for a local flash target checkout."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Only available on Pi")
    return flash_flash_target(_validated_target(target), data.checkout_path, data.flash_device, data.flash_method)


@router.get("/flash/{target}/artifacts/{filename}")
async def download_flash_target_artifact(target: str, filename: str, checkout_path: str | None = None):
    """Download a generated build artifact from a target's out directory."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Only available on Pi")
    try:
        artifact_path = get_flash_target_artifact_path(_validated_target(target), filename, checkout_path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return FileResponse(
        artifact_path,
        media_type="application/octet-stream",
        filename=Path(artifact_path).name,
    )


@router.delete("/flash/{target}/artifacts/{filename}")
async def delete_saved_flash_target_artifact(target: str, filename: str, checkout_path: str | None = None):
    """Delete a generated build artifact from a target's out directory."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Only available on Pi")
    try:
        return delete_flash_target_artifact(_validated_target(target), filename, checkout_path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/flash/{target}/profiles")
async def list_saved_flash_profiles(target: str):
    """List saved flash profiles for a target."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Only available on Pi")
    try:
        return {"profiles": list_flash_profiles(_validated_target(target))}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/flash/{target}/profiles/{name}")
async def load_saved_flash_profile_api(target: str, name: str):
    """Load a saved flash profile for a target."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Only available on Pi")
    try:
        return load_flash_profile(_validated_target(target), name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/flash/{target}/profiles")
async def save_flash_profile_api(target: str, data: FlashProfileSaveRequest):
    """Save a named flash profile for a target."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Only available on Pi")
    try:
        return save_flash_profile(
            _validated_target(target),
            data.name,
            {
                "checkout_path": data.checkout_path,
                "flash_device": data.flash_device,
                "flash_method": data.flash_method,
                "assignments": [{"symbol": item.symbol, "value": item.value} for item in data.assignments],
            },
        )
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/flash/{target}/profiles/{name}")
async def delete_saved_flash_profile_api(target: str, name: str):
    """Delete a saved flash profile for a target."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Only available on Pi")
    try:
        deleted = delete_flash_profile(_validated_target(target), name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Flash profile not found: {name}")
    return {"status": "deleted", "name": name}


@router.get("/firmware")
async def klipper_firmware_state(klipper_path: str | None = None):
    """Return Klipper menuconfig options and current firmware artifacts."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Only available on Pi")
    return get_klipper_firmware_state(klipper_path)


@router.put("/firmware")
async def update_klipper_firmware_config(data: FirmwareConfigUpdate):
    """Persist menuconfig selections to Klipper's active .config file."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Only available on Pi")
    assignments = [(item.symbol, item.value) for item in data.assignments]
    return save_klipper_menuconfig(assignments, data.klipper_path)


@router.post("/firmware/preview")
async def preview_klipper_firmware_config(data: FirmwareConfigUpdate):
    """Preview Klipper menuconfig changes without writing `.config`."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Only available on Pi")
    assignments = [(item.symbol, item.value) for item in data.assignments]
    return preview_klipper_menuconfig(assignments, data.klipper_path)


@router.post("/firmware/build")
async def build_klipper_firmware_api(data: FirmwareBuildRequest):
    """Run Klipper's firmware build using the active local checkout."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Only available on Pi")
    return build_klipper_firmware(data.klipper_path)


@router.post("/firmware/flash")
async def flash_klipper_firmware_api(data: FlashTargetCommandRequest):
    """Run the selected flash method in the active Klipper checkout."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Only available on Pi")
    return flash_klipper_firmware(data.checkout_path, data.flash_device, data.flash_method)


@router.get("/firmware/artifacts/{filename}")
async def download_klipper_firmware_artifact(filename: str, klipper_path: str | None = None):
    """Download a generated firmware artifact from Klipper's out directory."""
    if not is_native_platform():
        raise HTTPException(status_code=501, detail="Only available on Pi")
    try:
        artifact_path = get_klipper_firmware_artifact_path(filename, klipper_path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return FileResponse(
        artifact_path,
        media_type="application/octet-stream",
        filename=Path(artifact_path).name,
    )


# ── Layout persistence ─────────────────────────────────────────


@router.get("/layout")
async def get_layout():
    """Load the persisted UI layout."""
    data = load_layout()
    if data is None:
        return {"layout": None}
    return {"layout": data}


class LayoutSave(BaseModel):
    layout: dict


@router.post("/layout")
async def save_layout_api(data: LayoutSave):
    """Save the current UI layout."""
    save_layout(data.layout)
    return {"status": "saved"}


@router.delete("/layout")
async def delete_layout_api():
    """Delete the persisted layout."""
    deleted = delete_layout()
    return {"status": "deleted" if deleted else "not_found"}
