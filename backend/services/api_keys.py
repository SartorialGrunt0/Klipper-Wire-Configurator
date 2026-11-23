"""MCP-scoped API keys (security-work 3.1).

Keys gate the MCP HTTP endpoint only — never the app (decision D1).
They are stored PLAINTEXT in api_keys.json (owner-only, 0600) inside the
layout dir, deliberately: a key's whole job is to be re-copyable into an
external client's config (Claude Desktop, Pi Agent, VS Code), and a
hash would break that job; the blast radius of a leak is the MCP tool
list, not KWC. What IS guaranteed: no list response ever carries a key
value (metadata + prefix only) — the value arrives only from an explicit
create/reveal call.

Moonraker's api_key_file is the precedent for this exact posture
(plaintext file, hmac-compared on every authed request).
"""
from __future__ import annotations

import json
import os
import secrets
import stat
from datetime import datetime
from pathlib import Path
from typing import Any

from services import native_services

LAST_USED_STAMP_INTERVAL_S = 3600


def _keys_file() -> Path:
    # Indirection through the settings file's dir keeps KWC_LAYOUT_DIR and
    # every settings-path test-patch working for keys too.
    return Path(native_services._settings_file()).parent / "api_keys.json"


def _read() -> list[dict]:
    try:
        data = json.loads(_keys_file().read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _write(keys: list[dict]) -> None:
    path = _keys_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(keys, indent=2), encoding="utf-8")
    try:
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)  # 0600, owner only
    except OSError:
        pass  # exotic filesystems: content-level guarantees still hold


def _parse_expiry(value: Any) -> str | None:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    try:
        return datetime.fromisoformat(str(value).strip()).isoformat()
    except ValueError:
        raise ValueError(
            f"Invalid expires_at '{value}' (use an ISO date, "
            "e.g. 2027-01-31)")


def _is_expired(entry: dict, now: datetime) -> bool:
    raw = entry.get("expires_at")
    if not raw:
        return False
    try:
        return datetime.fromisoformat(str(raw)) <= now
    except ValueError:
        return False


def create_key(name: str = "", expires_at: Any = None) -> dict:
    """Create one key. The returned dict carries the FULL key value —
    this call and reveal are the only two places a value is ever served."""
    entry = {
        "id": secrets.token_hex(8),
        "name": str(name or "").strip(),
        "key": f"kwc_{secrets.token_hex(16)}",
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "expires_at": _parse_expiry(expires_at),
        "last_used_at": None,
    }
    keys = _read()
    keys.append(entry)
    _write(keys)
    return dict(entry)


def list_key_metadata() -> list[dict]:
    """Display rows: never the key value, only a short prefix."""
    now = datetime.now()
    out = []
    for entry in _read():
        key = str(entry.get("key", ""))
        out.append({
            "id": entry.get("id"),
            "name": entry.get("name", ""),
            "key_prefix": key[:11] + "…",
            "created_at": entry.get("created_at"),
            "expires_at": entry.get("expires_at"),
            "expired": _is_expired(entry, now),
            "last_used_at": entry.get("last_used_at"),
        })
    return out


def get_key(id: str) -> dict | None:
    for entry in _read():
        if entry.get("id") == id:
            return dict(entry)
    return None


def delete_key(id: str) -> bool:
    keys = _read()
    remaining = [e for e in keys if e.get("id") != id]
    if len(remaining) == len(keys):
        return False
    _write(remaining)
    return True


def has_any() -> bool:
    """The MCP gate's activation condition (and, later, the edit-tool
    registration prerequisite from the parked MCP-write note)."""
    return bool(_read())


def validate(raw: str | None) -> dict | None:
    """The active key matching `raw`, or None. Exact match on purpose —
    values are high-entropy; expired keys never validate."""
    if not raw or not isinstance(raw, str):
        return None
    candidate = raw.strip()
    now = datetime.now()
    keys = _read()
    for entry in keys:
        if entry.get("key") != candidate or _is_expired(entry, now):
            continue
        _maybe_stamp(entry, keys, now)
        return dict(entry)
    return None


def _maybe_stamp(entry: dict, keys: list[dict], now: datetime) -> None:
    raw = entry.get("last_used_at")
    try:
        last = datetime.fromisoformat(str(raw)) if raw else None
    except ValueError:
        last = None
    if last is not None and (now - last).total_seconds() < LAST_USED_STAMP_INTERVAL_S:
        return  # throttled: no write amplification per MCP call
    entry["last_used_at"] = now.isoformat(timespec="seconds")
    _write(keys)
