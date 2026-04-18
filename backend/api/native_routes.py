"""API routes for native Raspberry Pi features."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from parser.config_parser import parse_config
from parser.config_writer import smart_export
from parser.validator import validate_config
from services.board_detector import detect_board_from_config
from services.native_services import (
    firmware_restart_klipper,
    get_all_devices,
    get_default_config_path,
    is_native_platform,
    list_config_files,
    query_canbus_uuids,
    read_config_file,
    write_config_file,
    save_layout,
    load_layout,
    delete_layout,
    load_settings,
    query_klipper_status,
    save_settings,
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

    results = {}
    configs = {}
    for fn in filenames:
        file_path = base / fn
        if not file_path.exists():
            continue
        text = read_config_file(str(file_path))
        config = parse_config(text, fn)
        validation = validate_config(config, is_multi_file=len(filenames) > 1)
        board_info = detect_board_from_config(config)
        configs[fn] = config
        results[fn] = {
            "config": config.to_dict(),
            "validation": validation.to_dict(),
            "board_info": board_info,
            "raw_text": text,
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

    if errors and not written:
        raise HTTPException(status_code=500, detail="Failed to write files: " + "; ".join(errors))

    result = {"status": "applied", "files": written, "config_path": config_path}
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
