"""API routes for native (printer-host) features."""
from __future__ import annotations

import glob
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from parser.config_parser import parse_config
from parser.config_writer import smart_export
from parser.validator import validate_project_configs
from services import api_keys, path_containment
from services.board_detector import detect_board_from_config
from services.native_services import (
    delete_flash_profile,
    firmware_restart_klipper,
    get_all_devices,
    get_default_config_path,
    get_klippy_log_excerpt,
    list_flash_profiles,
    list_config_files,
    load_flash_profile,
    load_native_project,
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
from services.flash_jobs import FlashJobRunner
from services.flash_targets import (
    delete_flash_target_artifact,
    finalize_flash_job_result,
    get_flash_field_help,
    get_flash_target_artifact_path,
    get_flash_target_state,
    plan_build_flash_job,
    plan_flash_flash_job,
    preview_flash_target_config,
    save_flash_target_config,
    scan_flash_target_devices,
    set_flash_target_checkout_path,
)

flash_job_runner = FlashJobRunner()

router = APIRouter()


# ── Status ──────────────────────────────────────────────────────


@router.get("/status")
async def native_status():
    """Report the active config directory.

    There is no mode to branch on: the backend boots on every OS and warns
    off a Linux printer host (``main._warn_off_host``); off-host these
    native reads simply find nothing.
    """
    settings = load_settings()
    return {"config_path": str(settings.get("config_path") or "").strip()
            or get_default_config_path()}


# ── Devices ─────────────────────────────────────────────────────


@router.get("/devices")
def list_devices():
    """List available serial, CAN, and UART devices."""
    return get_all_devices()


@router.get("/canbus-uuids")
def get_canbus_uuids(interface: str = "can0"):
    """Query CAN bus UUIDs on a given interface."""
    return query_canbus_uuids(interface)


# ── Config path settings ───────────────────────────────────────


class ConfigPathUpdate(BaseModel):
    # None = leave the stored path untouched — a token-only save must not
    # be able to repoint the config root with the store's startup default
    # (PR #48 L-01). Clients that do send it get it validated.
    config_path: str | None = None
    # None = leave the stored token untouched (old clients keep working);
    # '' = explicit clear.
    moonraker_api_key: str | None = None


def _masked_settings(settings: dict) -> dict:
    """The Moonraker token is never served — callers get moonraker_key_set.
    (Same masking law as the AI provider key; no new cleartext route.)"""
    masked = dict(settings)
    token = masked.pop("moonraker_api_key", None)
    masked["moonraker_key_set"] = bool(isinstance(token, str) and token.strip())
    return masked


@router.get("/settings")
async def get_settings():
    """Get native settings (config path, etc.), token masked."""
    return _masked_settings(load_settings())


@router.put("/settings")
async def update_settings(data: ConfigPathUpdate):
    """Update native settings."""
    settings = load_settings()
    if data.config_path is not None:
        # The containment roots come FROM this value — an unvalidated one
        # re-opens every hole containment closed (PR #48 B-02/B-05: PUT
        # config_path '/' then GET config-files?path=/etc listed /etc).
        raw = str(data.config_path).strip()
        candidate = Path(raw).expanduser()
        if not raw or not candidate.is_absolute() or str(candidate) == os.sep:
            # '/' is absolute but it is not a SANDBOX — it was the exact
            # value that re-armed the config-files exfil (PR #48 B-02).
            raise HTTPException(
                status_code=400,
                detail="config_path must be a non-empty absolute path "
                       "other than the filesystem root")
        settings["config_path"] = str(candidate)
    if data.moonraker_api_key is not None:
        settings["moonraker_api_key"] = data.moonraker_api_key
    save_settings(settings)
    return _masked_settings(settings)


# ── MCP API keys (Manage Keys) ─────────────────────────────────
# These keys gate the MCP HTTP endpoint ONLY (decision D1) — never the
# app. A value appears ONLY in its create/replace response (reveal was
# removed, PR #48 D-2); the list is metadata. Lost a key? Replace
# rotates it in place; recovery needs no other door.


class ApiKeyCreate(BaseModel):
    name: str = ""
    # None = never expires (the default on purpose: expiry is opt-in so a
    # forgotten date can't lock out a fleet agent by surprise).
    expires_at: str | None = None


@router.get("/api-keys")
async def list_api_keys():
    return {"keys": api_keys.list_key_metadata()}


@router.post("/api-keys")
async def create_api_key(data: ApiKeyCreate):
    try:
        return api_keys.create_key(name=data.name, expires_at=data.expires_at)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/api-keys/{key_id}/replace")
async def replace_api_key(key_id: str):
    """Rotate a lost/compromised key IN PLACE: same row (name, expiry),
    fresh value, shown once — the replacement for the removed reveal
    route (PR #48 D-2: no route serves an EXISTING value anymore)."""
    entry = api_keys.replace_key(key_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="No such key")
    return entry


@router.delete("/api-keys/{key_id}")
async def delete_api_key(key_id: str):
    if not api_keys.delete_key(key_id):
        raise HTTPException(status_code=404, detail="No such key")
    return {"status": "deleted"}


# ── Config files from the host ──────────────────────────────────


def _stored_config_root() -> str:
    """The settings config_path as the containment root sees it.

    An EMPTY stored value must not collapse the roots to the process
    cwd — that exposed the backend checkout (venv listing, source tree)
    through config-files/apply (PR #48 B-05). PUT validates and can no
    longer save ''; this is the read-side guarantee for legacy or
    hand-edited settings.json files."""
    raw = str(load_settings().get("config_path") or "").strip()
    return raw or get_default_config_path()


def _contained(raw_path: str) -> str:
    """Resolve a request-supplied path inside the allowed config roots.

    Roots = settings config_path + KWC_EXTRA_CONFIG_DIRS. A ValueError
    (symlink or literal escape) arrives as a 400 that names the escape
    hatch — legitimate symlinked installs learn the fix instead of
    reading outside the sandbox.
    """
    roots = path_containment.config_roots(_stored_config_root())
    try:
        return str(path_containment.resolve_within_roots(raw_path, roots))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/config-files")
async def get_config_files(path: str | None = None):
    """List .cfg files in the config directory."""
    if path:
        config_path = _contained(path)
    else:
        config_path = _stored_config_root()
    files = list_config_files(config_path)
    return {"config_path": config_path, "files": files}


@router.post("/config-files/read")
def read_config_files(data: dict):
    """Read and parse one or more config files from the host."""
    raw_path = data.get("config_path")
    if raw_path:
        config_path = _contained(raw_path)
    else:
        config_path = _stored_config_root()
    filenames: list[str] = data.get("filenames", [])

    if not filenames:
        raise HTTPException(status_code=400, detail="No filenames provided")

    base = Path(config_path)
    # Read + on-disk include-closure expansion lives in the shared service
    # loader (also used by the MCP validate_config_project tool), so the
    # V2.6.0 symlink-closure semantics can't fork between surfaces:
    # list_config_files hides files whose symlink target escapes the config
    # root (traversal guard), but Klipper follows include symlinks wherever
    # they point at load (configfile.py _resolve_include). Third-party
    # configs (KAMP, moonraker-obico, mainsail macros) are commonly symlinked
    # INTO the config dir from elsewhere, so a native project must load them
    # or every such include becomes a false "missing include" error on a
    # config Klipper loads fine.
    try:
        configs, raw_texts, _skipped = load_native_project(base, filenames)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    board_infos = {fn: detect_board_from_config(cfg) for fn, cfg in configs.items()}

    validations = validate_project_configs(configs)
    results = {
        filename: {
            "config": config.to_dict(),
            "validation": validations[filename].human_to_dict(),
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
def apply_config(data: ApplyRequest):
    """Write config files back to the host filesystem."""
    if data.config_path:
        config_path = _contained(data.config_path)
    else:
        config_path = _stored_config_root()
    base = Path(config_path)

    if not base.is_dir():
        raise HTTPException(status_code=400, detail=f"Config directory does not exist: {config_path}")
    base_resolved = base.resolve(strict=False)

    # Validate the DELETE list BEFORE the write loop: a mixed request
    # that wrote files and then 400'd on one escaping delete left the
    # writes applied (round-2). All-or-nothing on containment.
    for rel_path in data.deleted:
        if not path_containment.within(
                base_resolved, (base / rel_path).resolve(strict=False)):
            raise HTTPException(
                status_code=400,
                detail=f"File '{rel_path}' resolves outside the config "
                       "directory (symlink escape)")

    written = []
    errors = []
    for filename, content in data.files.items():
        # Validate path is safe (no traversal, don't resolve symlinks)
        if '..' in filename or filename.startswith('/'):
            raise HTTPException(status_code=400, detail=f"Invalid filename: {filename}")
        # A pre-existing symlink inside the config dir must not turn the
        # write into a primitive against its outside target.
        if not path_containment.within(
                base_resolved, (base / filename).resolve(strict=False)):
            raise HTTPException(
                status_code=400,
                detail=f"File '{filename}' resolves outside the config "
                       "directory (symlink escape)")
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
        # The write branch above refuses symlink escapes; the delete
        # branch must too — (base/filename).unlink() through an in-root
        # symlinked directory deletes OUTSIDE the root (PR #48 B-04).
        if not path_containment.within(
                base_resolved, (base / filename).resolve(strict=False)):
            raise HTTPException(
                status_code=400,
                detail=f"File '{filename}' resolves outside the config "
                       "directory (symlink escape)")
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
def klipper_firmware_restart():
    """Send FIRMWARE_RESTART to Klipper via its Unix socket API."""
    try:
        return firmware_restart_klipper()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/klipper/status")
def klipper_status():
    """Get current Klipper state and recent log errors when not ready."""
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
def klipper_log_excerpt(data: KlippyLogExcerptRequest):
    """Get a targeted klippy.log excerpt for a restart failure analysis request."""
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
    help_limit: int = 0


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
    overwrite: bool = False


def _validated_target(target: str) -> str:
    normalized = target.strip().lower()
    if normalized not in {"klipper", "katapult"}:
        raise HTTPException(status_code=404, detail=f"Unsupported flash target: {target}")
    return normalized


class FlashCheckoutPathUpdate(BaseModel):
    checkout_path: str | None = None


@router.put("/flash/{target}/checkout-path")
def set_flash_checkout_path(target: str, data: FlashCheckoutPathUpdate):
    """Register a custom checkout directory (validated by identity
    before it is stored; empty clears back to auto-detection).
    Request-supplied checkout_path fields on OTHER routes are inert —
    this is the only sanctioned writer (PR #48 round-4)."""
    return set_flash_target_checkout_path(
        _validated_target(target), data.checkout_path)


@router.get("/flash/{target}")
def flash_target_state(target: str, checkout_path: str | None = None, help_limit: int = 0):
    """Return menuconfig fields and artifacts for a local flash target checkout."""
    return get_flash_target_state(_validated_target(target), checkout_path, help_limit=help_limit)


@router.get("/flash/{target}/field-help")
def flash_field_help(target: str, field_id: str, checkout_path: str | None = None):
    """Return the full help text for one menuconfig field (symbol or choice id).

    The frontend lazy-loads this when a field's help was truncated by
    ``help_limit`` on the main state payloads.
    """
    return get_flash_field_help(_validated_target(target), field_id, checkout_path)


@router.get("/flash/{target}/scan-devices")
def scan_flash_target_devices_api(
    target: str,
    checkout_path: str | None = None,
    force_refresh: bool = False,
):
    """Scan for connected flash devices (USB DFU, serial, CAN UUIDs).

    This runs slow hardware discovery asynchronously so the main state load is
    not blocked.  Results are cached for 30 seconds; pass ``force_refresh=true``
    to bypass the cache.
    """
    return scan_flash_target_devices(_validated_target(target), checkout_path, force_refresh)



@router.post("/flash/{target}/preview")
def preview_flash_target(target: str, data: FlashTargetConfigUpdate):
    """Preview menuconfig changes without persisting the target's .config file."""
    assignments = [(item.symbol, item.value) for item in data.assignments]
    return preview_flash_target_config(_validated_target(target), assignments, data.checkout_path, help_limit=data.help_limit)


@router.put("/flash/{target}/config")
def save_flash_target(target: str, data: FlashTargetConfigUpdate):
    """Persist menuconfig selections to the target's active .config file."""
    assignments = [(item.symbol, item.value) for item in data.assignments]
    return save_flash_target_config(_validated_target(target), assignments, data.checkout_path, help_limit=data.help_limit)


@router.post("/flash/{target}/build")
def build_flash_target_api(target: str, data: FlashTargetCommandRequest):
    """Start a `make olddefconfig` + `make` job for a local flash target checkout."""
    normalized = _validated_target(target)
    planned = plan_build_flash_job(normalized, data.checkout_path)
    if planned["immediate"]:
        return planned["result"]
    try:
        job_id = flash_job_runner.start(
            normalized,
            "build",
            planned["commands"],
            planned["checkout_path"],
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"job_id": job_id, "running": True, "target": normalized, "kind": "build"}


@router.post("/flash/{target}/flash")
def flash_target_api(target: str, data: FlashTargetCommandRequest):
    """Start the selected flash-method job for a local flash target checkout."""
    normalized = _validated_target(target)
    planned = plan_flash_flash_job(
        normalized,
        data.checkout_path,
        data.flash_device,
        data.flash_method,
    )
    if planned["immediate"]:
        return planned["result"]
    try:
        job_id = flash_job_runner.start(
            normalized,
            "flash",
            planned["commands"],
            planned["checkout_path"],
            planned["flash_device"],
            planned["flash_method"],
            planned.get("cleanup_commands"),
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"job_id": job_id, "running": True, "target": normalized, "kind": "flash"}


@router.get("/flash/{target}/jobs/{job_id}")
def flash_job_status_api(target: str, job_id: str):
    """Return live output for a build/flash job; the final result when done."""
    try:
        status = flash_job_runner.status(job_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Flash job not found") from None
    result = None
    if not status["running"] and status["raw_result"] is not None:
        result = finalize_flash_job_result(
            status["raw_result"],
            status["target"],
            status["kind"],
            status["checkout_path"],
            status["flash_device"],
            status["flash_method"],
        )
    return {
        "job_id": job_id,
        "running": status["running"],
        "target": status["target"],
        "kind": status["kind"],
        "log_tail": status["log_tail"],
        "result": result,
    }


@router.post("/flash/{target}/jobs/{job_id}/cancel")
def flash_job_cancel_api(target: str, job_id: str):
    """Cancel a running build/flash job."""
    if not flash_job_runner.cancel(job_id):
        raise HTTPException(status_code=409, detail="Flash job is not running.")
    return {"job_id": job_id, "cancelled": True}


@router.get("/flash/{target}/artifacts/{filename}")
def download_flash_target_artifact(target: str, filename: str, checkout_path: str | None = None):
    """Download a generated build artifact from a target's out directory."""
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
def delete_saved_flash_target_artifact(target: str, filename: str, checkout_path: str | None = None):
    """Delete a generated build artifact from a target's out directory."""
    try:
        return delete_flash_target_artifact(_validated_target(target), filename, checkout_path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/flash/{target}/profiles")
async def list_saved_flash_profiles(target: str):
    """List saved flash profiles for a target."""
    try:
        return {"profiles": list_flash_profiles(_validated_target(target))}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/flash/{target}/profiles/{name}")
async def load_saved_flash_profile_api(target: str, name: str):
    """Load a saved flash profile for a target."""
    try:
        return load_flash_profile(_validated_target(target), name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/flash/{target}/profiles")
async def save_flash_profile_api(target: str, data: FlashProfileSaveRequest):
    """Save a named flash profile for a target."""
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
            overwrite=data.overwrite,
        )
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/flash/{target}/profiles/{name}")
async def delete_saved_flash_profile_api(target: str, name: str):
    """Delete a saved flash profile for a target."""
    try:
        deleted = delete_flash_profile(_validated_target(target), name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Flash profile not found: {name}")
    return {"status": "deleted", "name": name}


@router.get("/firmware")
def klipper_firmware_state(klipper_path: str | None = None):
    """Return Klipper menuconfig options and current firmware artifacts."""
    return get_klipper_firmware_state(klipper_path)


@router.put("/firmware")
def update_klipper_firmware_config(data: FirmwareConfigUpdate):
    """Persist menuconfig selections to Klipper's active .config file."""
    assignments = [(item.symbol, item.value) for item in data.assignments]
    return save_klipper_menuconfig(assignments, data.klipper_path)


@router.post("/firmware/preview")
def preview_klipper_firmware_config(data: FirmwareConfigUpdate):
    """Preview Klipper menuconfig changes without writing `.config`."""
    assignments = [(item.symbol, item.value) for item in data.assignments]
    return preview_klipper_menuconfig(assignments, data.klipper_path)


@router.post("/firmware/build")
def build_klipper_firmware_api(data: FirmwareBuildRequest):
    """Run Klipper's firmware build using the active local checkout."""
    return build_klipper_firmware(data.klipper_path)


@router.post("/firmware/flash")
def flash_klipper_firmware_api(data: FlashTargetCommandRequest):
    """Run the selected flash method in the active Klipper checkout."""
    return flash_klipper_firmware(data.checkout_path, data.flash_device, data.flash_method)


@router.get("/firmware/artifacts/{filename}")
async def download_klipper_firmware_artifact(filename: str, klipper_path: str | None = None):
    """Download a generated firmware artifact from Klipper's out directory."""
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
