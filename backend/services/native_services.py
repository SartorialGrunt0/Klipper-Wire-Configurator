"""Native Raspberry Pi services — device detection, config file I/O, layout persistence."""
from __future__ import annotations

import getpass
import glob
import os
import json
import re
import platform
import socket
import subprocess
import httpx
from pathlib import Path
from typing import Any, TypedDict
from urllib.parse import quote, unquote

# Regex for extracting CAN bus UUIDs from canbus_query.py output
_CANBUS_UUID_RE = re.compile(r"canbus_uuid=([0-9a-fA-F]+)")
_KLIPPY_SECTION_RE = re.compile(r"section ['\"]?([^'\"]+)['\"]?", re.IGNORECASE)
_KLIPPY_OPTION_RE = re.compile(r"option ['\"]?([^'\"]+)['\"]?", re.IGNORECASE)


# ── Platform detection ──────────────────────────────────────────


def is_native_platform() -> bool:
    """Return True when running on Linux (Raspberry Pi / SBC).

    The environment variable `KWC_FAKE_NATIVE` may be set to a truthy
    value (1/true/yes/on) to force native mode for development runs.
    """
    fake = os.environ.get("KWC_FAKE_NATIVE")
    if fake and str(fake).lower() in ("1", "true", "yes", "on"):
        return True
    return platform.system() == "Linux"


# ── Device detection ────────────────────────────────────────────


class DeviceInfo(TypedDict):
    path: str
    description: str
    by_id: str  # symlink under /dev/serial/by-id (USB only)


def list_usb_serial_devices() -> list[DeviceInfo]:
    """List USB serial devices via /dev/serial/by-id/."""
    by_id_dir = Path("/dev/serial/by-id")
    devices: list[DeviceInfo] = []
    if not by_id_dir.is_dir():
        return devices
    for link in sorted(by_id_dir.iterdir()):
        try:
            real = link.resolve()
            devices.append({
                "path": str(real),
                "description": link.name,
                "by_id": str(link),
            })
        except OSError:
            continue
    return devices


def list_can_interfaces() -> list[dict]:
    """List CAN network interfaces."""
    interfaces: list[dict] = []
    net_dir = Path("/sys/class/net")
    if not net_dir.is_dir():
        return interfaces
    for iface in sorted(net_dir.iterdir()):
        type_file = iface / "type"
        try:
            iface_type = type_file.read_text().strip()
            # ARPHRD_CAN = 280
            if iface_type == "280":
                operstate_file = iface / "operstate"
                state = "unknown"
                if operstate_file.exists():
                    state = operstate_file.read_text().strip()
                # Try to get bitrate
                bitrate = None
                try:
                    result = subprocess.run(
                        ["ip", "-details", "link", "show", iface.name],
                        capture_output=True, text=True, timeout=5,
                    )
                    for line in result.stdout.splitlines():
                        if "bitrate" in line:
                            parts = line.split()
                            idx = parts.index("bitrate") + 1
                            if idx < len(parts):
                                bitrate = int(parts[idx])
                except (subprocess.SubprocessError, ValueError, IndexError):
                    pass
                interfaces.append({
                    "name": iface.name,
                    "state": state,
                    "bitrate": bitrate,
                })
        except (OSError, ValueError):
            continue
    return interfaces


def list_uart_devices() -> list[DeviceInfo]:
    """List UART/serial devices (/dev/ttyAMA*, /dev/ttyS*, /dev/ttyUSB*)."""
    patterns = ["/dev/ttyAMA*", "/dev/ttyS*", "/dev/ttyUSB*", "/dev/ttyACM*"]
    seen: set[str] = set()
    devices: list[DeviceInfo] = []
    for pattern in patterns:
        for path_str in sorted(glob.glob(pattern)):
            path = Path(path_str)
            real = str(path.resolve())
            if real in seen:
                continue
            seen.add(real)
            devices.append({
                "path": path_str,
                "description": path.name,
                "by_id": "",
            })
    return devices


def get_all_devices() -> dict:
    """Return all detected devices grouped by type."""
    return {
        "usb_serial": list_usb_serial_devices(),
        "can": list_can_interfaces(),
        "uart": list_uart_devices(),
    }


def query_canbus_uuids(interface: str = "can0") -> dict:
    """Query CAN bus for device UUIDs using Klipper's canbus_query.py.

    First checks if the CAN interface exists and is up, then runs the query script.
    Returns a dict with 'uuids' list and optional 'error' message.
    """
    result: dict = {"uuids": [], "interface": interface, "error": None}

    # Check if interface exists using ip command
    try:
        check = subprocess.run(
            ["ip", "-s", "-d", "link", "show", interface],
            capture_output=True, text=True, timeout=5,
        )
        if check.returncode != 0 or "does not exist" in check.stderr:
            result["error"] = f"CAN interface '{interface}' does not exist. " \
                              f"Ensure the CAN interface is configured and up."
            return result
    except (subprocess.SubprocessError, OSError) as exc:
        result["error"] = f"Failed to check CAN interface: {exc}"
        return result

    # Find the canbus_query.py script
    user = getpass.getuser()
    script_candidates = [
        Path(f"/home/{user}/klipper/scripts/canbus_query.py"),
        Path("/home/pi/klipper/scripts/canbus_query.py"),
    ]
    klippy_env_candidates = [
        Path(f"/home/{user}/klippy-env/bin/python"),
        Path("/home/pi/klippy-env/bin/python"),
    ]

    script_path = None
    for candidate in script_candidates:
        if candidate.is_file():
            script_path = candidate
            break

    python_path = None
    for candidate in klippy_env_candidates:
        if candidate.is_file():
            python_path = candidate
            break

    if not script_path:
        result["error"] = "Klipper canbus_query.py script not found. " \
                          "Ensure Klipper is installed."
        return result

    if not python_path:
        # Fall back to system python
        python_path = Path("python3")

    # Run the canbus query
    try:
        query = subprocess.run(
            [str(python_path), str(script_path), interface],
            capture_output=True, text=True, timeout=10,
        )
        # Parse output for UUIDs — format: "Found canbus_uuid=XXXXXXXXXXXX, Application: Klipper"
        for line in query.stdout.splitlines():
            match = _CANBUS_UUID_RE.search(line)
            if match:
                result["uuids"].append(match.group(1))
        if query.returncode != 0 and not result["uuids"]:
            stderr_msg = query.stderr.strip()
            if stderr_msg:
                result["error"] = f"CAN bus query failed: {stderr_msg}"
            else:
                result["error"] = "CAN bus query returned no devices."
    except subprocess.TimeoutExpired:
        result["error"] = "CAN bus query timed out. Check that the CAN interface is active."
    except (subprocess.SubprocessError, OSError) as exc:
        result["error"] = f"Failed to run CAN bus query: {exc}"

    return result


# ── Config file I/O ────────────────────────────────────────────


def get_default_config_path() -> str:
    """Return the default Klipper config directory."""
    user = getpass.getuser()
    return f"/home/{user}/printer_data/config"


# Klipper's SAVE_CONFIG writes timestamped backups (printer-YYYYMMDD_HHMMSS.cfg)
# into the config dir. KWC treats those as noise: they must never appear in
# config listings, get auto-opened, or be offered to the AI as editable files.
# The pattern is deliberately narrow — 8-digit date + underscore + digits —
# so example configs named printer-<model>-<year>.cfg never match.
_BACKUP_CONFIG_RE = re.compile(r"^printer-\d{8}_\d+\.cfg$", re.IGNORECASE)


def is_backup_config_file(name: str) -> bool:
    """Return True when ``name`` is a Klipper SAVE_CONFIG backup file.

    Applies to the basename so paths like ``backups/printer-20250810_142619.cfg``
    are matched the same as the bare filename.
    """
    return bool(_BACKUP_CONFIG_RE.match(Path(name).name))


def list_config_files(config_dir: str) -> list[dict]:
    """List .cfg files in the given directory and its subdirectories.

    Follows symlinks for the root directory itself but skips any discovered
    file whose resolved path escapes the resolved config directory root,
    preventing symlink-based directory traversal.
    """
    path = Path(config_dir)
    if not path.is_dir():
        return []
    resolved_base = path.resolve()
    files = []
    for f in sorted(path.rglob("*.cfg")):
        if not f.is_file():
            continue
        rel = f.relative_to(path)
        # Klipper SAVE_CONFIG backups (printer-YYYYMMDD_HHMMSS.cfg) are noise —
        # exclude them from listings so no UI or AI surface ever offers them.
        if is_backup_config_file(rel.as_posix()):
            continue
        # Guard against symlinks inside the config dir pointing outside it.
        # Resolve once and reuse for both the containment check and stat calls.
        resolved_f = f.resolve()
        try:
            resolved_f.relative_to(resolved_base)
        except ValueError:
            continue
        stat = resolved_f.stat()
        files.append({
            "name": rel.as_posix(),
            "path": str(f),
            "size": stat.st_size,
            "modified": stat.st_mtime,
        })
    return files


def read_config_file(file_path: str) -> str:
    """Read a config file's contents. Path must be under the allowed config dir."""
    path = Path(file_path)
    if not path.is_file():
        raise FileNotFoundError(f"Config file not found: {file_path}")
    return path.read_text(encoding="utf-8", errors="replace")


def write_config_file(file_path: str, content: str) -> None:
    """Write content to a config file."""
    path = Path(file_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


# ── Layout persistence ─────────────────────────────────────────

_LAYOUT_DIR = Path(os.environ.get(
    "KWC_LAYOUT_DIR",
    os.path.expanduser("~/.config/klipper-wire-configurator"),
))


def _layout_file() -> Path:
    _LAYOUT_DIR.mkdir(parents=True, exist_ok=True)
    return _LAYOUT_DIR / "layout.json"


def save_layout(data: dict) -> None:
    """Persist the UI layout to disk."""
    _layout_file().write_text(json.dumps(data, indent=2), encoding="utf-8")


def load_layout() -> dict | None:
    """Load the persisted UI layout, or None if none exists."""
    lf = _layout_file()
    if not lf.exists():
        return None
    try:
        return json.loads(lf.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def delete_layout() -> bool:
    """Delete the persisted layout file."""
    lf = _layout_file()
    if lf.exists():
        lf.unlink()
        return True
    return False


# ── Settings persistence ───────────────────────────────────────


def _settings_file() -> Path:
    _LAYOUT_DIR.mkdir(parents=True, exist_ok=True)
    return _LAYOUT_DIR / "settings.json"


def load_settings() -> dict:
    """Load native settings (config path, etc.)."""
    sf = _settings_file()
    defaults = {"config_path": get_default_config_path()}
    if not sf.exists():
        return defaults
    try:
        data = json.loads(sf.read_text(encoding="utf-8"))
        return {**defaults, **data}
    except (json.JSONDecodeError, OSError):
        return defaults


def save_settings(data: dict) -> None:
    """Save native settings."""
    _settings_file().write_text(json.dumps(data, indent=2), encoding="utf-8")


# ── Flash profile persistence ─────────────────────────────────


def _validated_flash_profile_target(target: str) -> str:
    normalized = str(target).strip().lower()
    if normalized not in {"klipper", "katapult"}:
        raise ValueError(f"Unsupported flash profile target: {target}")
    return normalized


def _normalize_flash_profile_name(name: str) -> str:
    normalized = str(name).strip()
    if not normalized:
        raise ValueError("Flash profile name cannot be empty")
    if len(normalized) > 120:
        raise ValueError("Flash profile name must be 120 characters or fewer")
    return normalized


def _flash_profiles_dir(target: str | None = None) -> Path:
    base = _LAYOUT_DIR / "flash_profiles"
    base.mkdir(parents=True, exist_ok=True)
    if target is None:
        return base
    target_dir = base / _validated_flash_profile_target(target)
    target_dir.mkdir(parents=True, exist_ok=True)
    return target_dir


def _flash_profile_file(target: str, name: str) -> Path:
    normalized_name = _normalize_flash_profile_name(name)
    filename = f"{quote(normalized_name, safe='')}.json"
    return _flash_profiles_dir(target) / filename


def _normalize_flash_profile_assignments(assignments: Any) -> list[dict[str, str]]:
    if not isinstance(assignments, list):
        return []

    result: list[dict[str, str]] = []
    for item in assignments:
        if not isinstance(item, dict):
            continue
        symbol = item.get("symbol")
        value = item.get("value")
        if not isinstance(symbol, str) or not isinstance(value, str):
            continue
        normalized_symbol = symbol.strip()
        if not normalized_symbol:
            continue
        result.append({
            "symbol": normalized_symbol,
            "value": value,
        })
    return result


def _flash_profile_payload(target: str, name: str, data: dict[str, Any]) -> dict[str, Any]:
    normalized_target = _validated_flash_profile_target(target)
    normalized_name = _normalize_flash_profile_name(name)
    return {
        "version": 1,
        "name": normalized_name,
        "target": normalized_target,
        "checkout_path": str(data.get("checkout_path") or ""),
        "flash_device": str(data.get("flash_device") or ""),
        "flash_method": str(data.get("flash_method") or ""),
        "assignments": _normalize_flash_profile_assignments(data.get("assignments")),
    }


def load_flash_profile(target: str, name: str) -> dict[str, Any]:
    normalized_target = _validated_flash_profile_target(target)
    profile_path = _flash_profile_file(normalized_target, name)
    if not profile_path.is_file():
        raise FileNotFoundError(f"Flash profile not found: {name}")

    try:
        raw_data = json.loads(profile_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise ValueError(f"Flash profile is invalid: {name}") from exc

    if not isinstance(raw_data, dict):
        raise ValueError(f"Flash profile is invalid: {name}")

    payload = _flash_profile_payload(normalized_target, str(raw_data.get("name") or unquote(profile_path.stem)), raw_data)
    stat = profile_path.stat()
    return {
        **payload,
        "created": stat.st_ctime,
        "modified": stat.st_mtime,
    }


def list_flash_profiles(target: str) -> list[dict[str, Any]]:
    normalized_target = _validated_flash_profile_target(target)
    profiles: list[dict[str, Any]] = []
    for profile_path in _flash_profiles_dir(normalized_target).glob("*.json"):
        try:
            payload = load_flash_profile(normalized_target, unquote(profile_path.stem))
        except (FileNotFoundError, ValueError, OSError):
            continue
        profiles.append({
            "name": payload["name"],
            "target": normalized_target,
            "checkout_path": payload["checkout_path"],
            "flash_device": payload["flash_device"],
            "flash_method": payload["flash_method"],
            "assignment_count": len(payload["assignments"]),
            "created": payload["created"],
            "modified": payload["modified"],
        })

    profiles.sort(key=lambda item: (-item["modified"], item["name"].lower()))
    return profiles


def save_flash_profile(target: str, name: str, data: dict[str, Any]) -> dict[str, Any]:
    normalized_target = _validated_flash_profile_target(target)
    payload = _flash_profile_payload(normalized_target, name, data)
    profile_path = _flash_profile_file(normalized_target, payload["name"])
    if profile_path.exists():
        raise FileExistsError(f"Flash profile already exists: {payload['name']}")
    profile_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return load_flash_profile(normalized_target, payload["name"])


def delete_flash_profile(target: str, name: str) -> bool:
    normalized_target = _validated_flash_profile_target(target)
    profile_path = _flash_profile_file(normalized_target, name)
    if not profile_path.exists():
        return False
    profile_path.unlink()
    return True


# ── Klipper API helpers ───────────────────────────────────────


def _klipper_socket_candidates() -> list[Path]:
    """Return possible Klipper API socket paths (first existing path is used)."""
    env_socket = os.environ.get("KWC_KLIPPER_SOCKET")
    candidates = [
        env_socket,
        "/tmp/klippy_uds",
        "/home/pi/printer_data/comms/klippy.sock",
        f"/home/{getpass.getuser()}/printer_data/comms/klippy.sock",
    ]
    paths: list[Path] = []
    seen: set[str] = set()
    for value in candidates:
        if not value:
            continue
        if value in seen:
            continue
        seen.add(value)
        paths.append(Path(value))
    return paths


def _send_klipper_request(method: str, params: dict[str, Any] | None = None, timeout: float = 10.0) -> dict:
    """Send a single request to Klipper's Unix socket API and return its result."""
    payload = {"id": 1, "method": method, "params": params or {}}
    frame = (json.dumps(payload, separators=(",", ":")) + "\x03").encode("utf-8")

    existing_paths = [p for p in _klipper_socket_candidates() if p.exists()]
    if not existing_paths:
        raise FileNotFoundError("Klipper API socket not found. Set KWC_KLIPPER_SOCKET if your socket path is custom.")

    last_error: Exception | None = None
    for socket_path in existing_paths:
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(timeout)
                client.connect(str(socket_path))
                client.sendall(frame)

                buffer = b""
                while True:
                    chunk = client.recv(4096)
                    if not chunk:
                        break
                    buffer += chunk
                    while b"\x03" in buffer:
                        raw, buffer = buffer.split(b"\x03", 1)
                        if not raw:
                            continue
                        response = json.loads(raw.decode("utf-8", errors="replace"))
                        if response.get("id") != payload["id"]:
                            continue
                        if "error" in response:
                            error = response["error"]
                            if isinstance(error, dict):
                                message = error.get("message", str(error))
                            else:
                                message = str(error)
                            raise RuntimeError(f"Klipper API error: {message}")
                        return {
                            "socket_path": str(socket_path),
                            "result": response.get("result", {}),
                        }
        except (OSError, TimeoutError, ValueError, RuntimeError) as exc:
            last_error = exc
            continue

    raise RuntimeError(f"Unable to communicate with Klipper API: {last_error}")


def firmware_restart_klipper() -> dict:
    """Request FIRMWARE_RESTART from Klipper via the API socket."""
    response = _send_klipper_request("gcode/firmware_restart")
    return {
        "status": "ok",
        "method": "gcode/firmware_restart",
        "socket_path": response["socket_path"],
    }


def _klippy_log_candidates() -> list[Path]:
    """Return likely klippy.log file locations."""
    env_log = os.environ.get("KWC_KLIPPY_LOG")
    user = getpass.getuser()
    candidates = [
        env_log,
        f"/home/{user}/printer_data/logs/klippy.log",
        "/home/pi/printer_data/logs/klippy.log",
        "/tmp/klippy.log",
    ]
    paths: list[Path] = []
    seen: set[str] = set()
    for value in candidates:
        if not value or value in seen:
            continue
        seen.add(value)
        paths.append(Path(value))
    return paths


def _read_log_tail(path: Path, max_bytes: int = 240_000) -> str:
    """Read the tail of a log file without loading the entire file into memory."""
    with path.open("rb") as fh:
        fh.seek(0, os.SEEK_END)
        size = fh.tell()
        start = max(0, size - max_bytes)
        fh.seek(start)
        raw = fh.read()
    return raw.decode("utf-8", errors="replace")


def _extract_recent_klippy_errors(log_text: str, max_entries: int = 12) -> list[str]:
    """Extract likely error lines from klippy.log tail."""
    patterns = [
        r"\berror\b",
        r"\bshutdown\b",
        r"\btraceback\b",
        r"\bconfig\s+error\b",
        r"\bunable\s+to\b",
        r"\bunknown\s+option\b",
        r"\bunknown\s+command\b",
    ]
    matcher = re.compile("|".join(patterns), re.IGNORECASE)

    picked: list[str] = []
    seen: set[str] = set()
    for raw_line in reversed(log_text.splitlines()):
        line = raw_line.strip()
        if not line or line in seen:
            continue
        if matcher.search(line):
            picked.append(line)
            seen.add(line)
            if len(picked) >= max_entries:
                break
    picked.reverse()
    return picked


def _get_recent_klippy_errors(max_entries: int = 12) -> tuple[list[str], str | None]:
    """Return recent log error lines and the log path used."""
    for path in _klippy_log_candidates():
        if not path.is_file():
            continue
        try:
            tail = _read_log_tail(path)
            return _extract_recent_klippy_errors(tail, max_entries=max_entries), str(path)
        except OSError:
            continue
    return [], None


def _moonraker_base_urls() -> list[str]:
    env_url = os.environ.get("KWC_MOONRAKER_URL")
    candidates = [
        env_url,
        "http://127.0.0.1:7125",
        "http://localhost:7125",
    ]
    urls: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        if not candidate:
            continue
        normalized = candidate.rstrip("/")
        if normalized in seen:
            continue
        seen.add(normalized)
        urls.append(normalized)
    return urls


def _query_moonraker_print_status(timeout: float = 2.0) -> dict[str, Any]:
    """Query Moonraker for the active print state."""
    fallback = {
        "is_printing": False,
        "print_state": None,
        "print_filename": None,
    }

    for base_url in _moonraker_base_urls():
        try:
            with httpx.Client(timeout=timeout) as client:
                response = client.get(f"{base_url}/printer/objects/query?print_stats")
                response.raise_for_status()
            payload = response.json()
            result = payload.get("result", {}) if isinstance(payload, dict) else {}
            status = result.get("status", {}) if isinstance(result, dict) else {}
            print_stats = status.get("print_stats", {}) if isinstance(status, dict) else {}
            if not isinstance(print_stats, dict):
                continue

            raw_state = print_stats.get("state")
            print_state = str(raw_state).strip().lower() if raw_state is not None else None
            filename = print_stats.get("filename")
            return {
                "is_printing": print_state in {"printing", "paused"},
                "print_state": print_state or None,
                "print_filename": str(filename).strip() or None if filename is not None else None,
            }
        except (httpx.HTTPError, ValueError, TypeError):
            continue

    return fallback


def _build_klippy_log_search_terms(section_name: str | None = None, error_text: str | None = None) -> list[str]:
    """Build a small list of useful search fragments for a klippy log excerpt."""
    terms: list[str] = []

    def add_term(value: str | None) -> None:
        if not value:
            return
        normalized = value.strip().lower()
        if not normalized or normalized in terms:
            return
        terms.append(normalized)

    add_term(section_name)
    if section_name:
        add_term(f"[{section_name}]")
        add_term(f"section '{section_name}'")

    if error_text:
        for raw_line in error_text.splitlines():
            cleaned = raw_line.strip()
            if not cleaned:
                continue
            if ":" in cleaned and cleaned.lower().startswith("restart failed"):
                cleaned = cleaned.split(":", 1)[1].strip()
            add_term(cleaned)

            option_match = _KLIPPY_OPTION_RE.search(cleaned)
            if option_match:
                option_name = option_match.group(1).strip()
                add_term(option_name)
                add_term(f"option '{option_name}'")

            section_match = _KLIPPY_SECTION_RE.search(cleaned)
            if section_match:
                matched_section = section_match.group(1).strip()
                add_term(matched_section)
                add_term(f"[{matched_section}]")
                add_term(f"section '{matched_section}'")

    return terms


def _extract_klippy_log_excerpt(
    log_text: str,
    search_terms: list[str],
    context_lines: int = 40,
    fallback_lines: int = 80,
) -> tuple[str, str | None]:
    """Return a relevant log excerpt and the matched search term, if any."""
    lines = log_text.splitlines()
    if not lines:
        return "", None

    normalized_context_lines = max(5, min(context_lines, 200))
    normalized_fallback_lines = max(normalized_context_lines, min(fallback_lines, 200))
    matched_index: int | None = None
    matched_term: str | None = None

    for index in range(len(lines) - 1, -1, -1):
        lowered = lines[index].lower()
        for term in search_terms:
            if term and term in lowered:
                matched_index = index
                matched_term = term
                break
        if matched_index is not None:
            break

    if matched_index is None:
        fallback_matcher = re.compile(
            r"\b(config\s+error|traceback|error|shutdown|unable\s+to|unknown\s+option|unknown\s+command)\b",
            re.IGNORECASE,
        )
        for index in range(len(lines) - 1, -1, -1):
            if fallback_matcher.search(lines[index]):
                matched_index = index
                break

    if matched_index is None:
        excerpt_lines = lines[-normalized_fallback_lines:]
        return "\n".join(excerpt_lines).strip(), matched_term

    start = max(0, matched_index - normalized_context_lines)
    end = min(len(lines), matched_index + normalized_context_lines + 1)
    excerpt_lines = lines[start:end]
    return "\n".join(excerpt_lines).strip(), matched_term


def get_klippy_log_excerpt(
    section_name: str | None = None,
    error_text: str | None = None,
    context_lines: int = 40,
) -> dict[str, Any]:
    """Return a targeted klippy.log excerpt for a restart failure analysis request."""
    search_terms = _build_klippy_log_search_terms(section_name, error_text)

    for path in _klippy_log_candidates():
        if not path.is_file():
            continue
        try:
            tail = _read_log_tail(path)
            excerpt, matched_on = _extract_klippy_log_excerpt(
                tail,
                search_terms,
                context_lines=context_lines,
            )
            return {
                "status": "ok",
                "log_path": str(path),
                "excerpt": excerpt,
                "matched_on": matched_on,
            }
        except OSError:
            continue

    return {
        "status": "ok",
        "log_path": None,
        "excerpt": "",
        "matched_on": None,
    }


def query_klipper_status() -> dict:
    """Query Klipper status via webhooks object and include recent log errors when not ready."""
    response = _send_klipper_request("objects/query", {"objects": {"webhooks": None}})
    result = response.get("result", {})
    status_data = result.get("status", {})
    webhooks = status_data.get("webhooks", {}) if isinstance(status_data, dict) else {}

    state = str(webhooks.get("state", "unknown")) if isinstance(webhooks, dict) else "unknown"
    state_message = str(webhooks.get("state_message", "")) if isinstance(webhooks, dict) else ""

    payload: dict[str, Any] = {
        "status": "ok",
        "socket_path": response["socket_path"],
        "state": state,
        "state_message": state_message,
        "recent_errors": [],
        "log_path": None,
        "is_printing": False,
        "print_state": None,
        "print_filename": None,
    }

    if state != "ready":
        recent_errors, log_path = _get_recent_klippy_errors()
        payload["recent_errors"] = recent_errors
        payload["log_path"] = log_path

    payload.update(_query_moonraker_print_status())

    return payload
