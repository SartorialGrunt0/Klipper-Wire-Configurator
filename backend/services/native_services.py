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
from pathlib import Path
from typing import Any, TypedDict


# ── Platform detection ──────────────────────────────────────────


def is_native_platform() -> bool:
    """Return True when running on Linux (Raspberry Pi / SBC)."""
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


# ── Config file I/O ────────────────────────────────────────────


def get_default_config_path() -> str:
    """Return the default Klipper config directory."""
    user = getpass.getuser()
    return f"/home/{user}/printer_data/config"


def list_config_files(config_dir: str) -> list[dict]:
    """List .cfg files in the given directory."""
    path = Path(config_dir)
    if not path.is_dir():
        return []
    files = []
    for f in sorted(path.iterdir()):
        if f.is_file() and f.suffix == ".cfg":
            files.append({
                "name": f.name,
                "path": str(f),
                "size": f.stat().st_size,
                "modified": f.stat().st_mtime,
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
    }

    if state != "ready":
        recent_errors, log_path = _get_recent_klippy_errors()
        payload["recent_errors"] = recent_errors
        payload["log_path"] = log_path

    return payload
