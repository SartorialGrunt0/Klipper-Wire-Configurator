"""MCP-scoped API keys (security-work 3.1).

Keys gate the MCP HTTP endpoint only — never the app (decision D1).
They are stored PLAINTEXT in api_keys.json (owner-only, 0600) inside the
layout dir, deliberately: a key's whole job is to be re-copyable into an
external client's config (Claude Desktop, Pi Agent, VS Code) — at CREATE
time, when it is shown exactly once — and a hash would break that job;
the blast radius of a leak is the MCP tool list, not KWC. What IS
guaranteed: no list response ever carries a key value (metadata + prefix
only), and — since PR #48 review D-2 — NO route serves an existing value
at all: reveal was removed; a lost key is rotated with `replace` and the
fresh value is shown once.

Moonraker's api_key_file is the precedent for this exact posture
(plaintext file, constant-time-compared on every authed request).
"""
from __future__ import annotations

import hmac
import json
import logging
import os
import secrets
import stat
import threading
from datetime import datetime, time, timezone
from pathlib import Path
from typing import Any

from services import native_services

logger = logging.getLogger(__name__)

LAST_USED_STAMP_INTERVAL_S = 3600

# Serializes every read-modify-write over the one JSON file, so a delete
# can never be resurrected by an in-flight last-used stamp (PR #48 L-01).
_LOCK = threading.RLock()
# Set when an EXISTING store file fails to parse: the gate must treat a
# corrupt store as "keys exist" (deny), never as "no keys" (open).
_store_broken = False


def _keys_file() -> Path:
    # Indirection through the settings file's dir keeps KWC_LAYOUT_DIR and
    # every settings-path test-patch working for keys too.
    return Path(native_services._settings_file()).parent / "api_keys.json"


def _read() -> list[dict]:
    """The stored rows; [] when no file exists (first run).

    A corrupt/truncated/unreadable EXISTING file is remembered via
    _store_broken and reads as empty here — has_any() turns that into
    'gate ON' so the failure mode is a loud 401, never a silently open
    endpoint (PR #48 A-02). A missing file is genuinely 'no keys'.
    """
    global _store_broken
    path = _keys_file()
    if not path.exists():
        # A missing file is genuinely 'no keys' — and it is the
        # documented RECOVERY path for a corrupt store, so the delete
        # must also CLEAR any broken flag. (Reset only lives on the
        # successful-read tail, which a delete skips — the gate would
        # stay denied until some later read happened to clear it.)
        if _store_broken:
            _store_broken = False
        return []
    try:
        text = path.read_text(encoding="utf-8")
        if not text.strip():
            # An EMPTY file is a half-write (crash/ENOSPC between
            # truncate and write) — exactly the corruption A-02 says
            # must not read as 'no keys'. Empty != absent: absent means
            # the operator deleted it (documented open path).
            raise ValueError("store is empty")
        data = json.loads(text)
        if not isinstance(data, list):
            # A JSON object where rows must be is corruption, not 'no
            # keys' (PR #48 A-02): same fail-closed path as a parse error.
            raise ValueError("store is not a JSON list")
    except (OSError, ValueError):
        if not _store_broken:
            _store_broken = True
            logger.error(
                "api_keys.json exists but cannot be read/parsed — the MCP "
                "gate stays CLOSED until the file is fixed or deleted. "
                "Deleting it reverts the endpoint to open (documented "
                "recovery path).")
        return []
    if _store_broken:
        _store_broken = False
    return data


def _write(keys: list[dict]) -> None:
    """Atomic, owner-only write: temp file created 0600, then os.replace.

    write_text-then-chmod left a world-readable window on every create
    (umask 022 → 0644) and a swallowed chmod failure stranded the file at
    0644 forever (PR #48 A-05). Creating with the final mode removes both
    the window and the trust in chmod.
    """
    path = _keys_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp.{os.getpid()}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
                 stat.S_IRUSR | stat.S_IWUSR)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(keys, fh, indent=2)
        os.replace(tmp, path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise
    # The temp file was CREATED 0600; a umask-ignored or chmodless
    # filesystem (the no-inline-platform-checks law: the MODE is the
    # OS truth, no platform predicate) may still leave it open —
    # re-apply and, if the bits persist, say so loudly, never silently.
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        try:
            os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
            mode = stat.S_IMODE(path.stat().st_mode)
        except OSError:
            pass
    if mode & 0o077:
        logger.warning(
            "api_keys.json is group/world-readable (mode %s) and the "
            "chmod fix failed — plaintext keys on this filesystem are "
            "readable by other users (NFS/FAT/SMB homes?).", oct(mode))


def _normalize_expiry(value: Any) -> str | None:
    """Store one comparable representation of an expiry input.

    Everything becomes a NAIVE-UTC iso string (the whole module compares
    naive UTC): aware inputs are converted, date-only inputs mean END of
    that day (a typed deadline, not a surprise morning expiry — PR #48
    L-04). Anything fromisoformat can't parse is refused at create time,
    so _is_expired never has to guess (L-03's create-side half).
    """
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    raw = str(value).strip()
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        raise ValueError(
            f"Invalid expires_at '{value}' (use an ISO date, "
            "e.g. 2027-01-31)")
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    elif len(raw) == 10:  # date-only: inclusive through 23:59:59.999999
        # End of day means the HOST-LOCAL day the typer read off their
        # calendar — a UTC-8 host used to kill the key at 16:00 local
        # (CI runners are UTC, so the suite never saw it). Anchor local
        # end-of-day, then land it in naive UTC like everything else.
        local_tz = datetime.now().astimezone().tzinfo
        parsed = (datetime.combine(parsed.date(), time.max, tzinfo=local_tz)
                  .astimezone(timezone.utc).replace(tzinfo=None))
    return parsed.isoformat()


# Pre-#48 name kept alive for callers/tests that imported it.
_parse_expiry = _normalize_expiry


def _is_expired(entry: dict, now: datetime) -> bool:
    """Total function (PR #48 L-03): every stored shape yields a verdict,
    and an unparseable stamp fails CLOSED (expired) with a warning — the
    permissive direction is wrong for a revocation control."""
    raw = entry.get("expires_at")
    if not raw:
        return False
    try:
        parsed = datetime.fromisoformat(str(raw))
    except ValueError:
        logger.warning("api key %s has an unparseable expires_at (%r) — "
                       "treating it as EXPIRED.", entry.get("id"), raw)
        return True
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed <= now


def _now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def create_key(name: str = "", expires_at: Any = None) -> dict:
    """Create one key. The returned dict carries the FULL key value — the
    ONLY place a value is ever served (reveal was removed, PR #48 D-2;
    rotate a lost key with replace_key instead)."""
    entry = {
        "id": secrets.token_hex(8),
        "name": str(name or "").strip(),
        "key": f"kwc_{secrets.token_hex(16)}",
        "created_at": _now_utc().isoformat(timespec="seconds"),
        "expires_at": _normalize_expiry(expires_at),
        "last_used_at": None,
    }
    with _LOCK:
        keys = _read()
        keys.append(entry)
        _write(keys)
    return dict(entry)


def replace_key(id: str) -> dict | None:
    """Rotate an existing row's value IN PLACE (same id, name, created,
    expiry; last-used resets). Returns the entry WITH THE NEW VALUE —
    served once, exactly like create. None when no such key."""
    with _LOCK:
        keys = _read()
        for entry in keys:
            if entry.get("id") == id:
                entry["key"] = f"kwc_{secrets.token_hex(16)}"
                entry["last_used_at"] = None
                _write(keys)
                return dict(entry)
    return None


def list_key_metadata() -> list[dict]:
    """Display rows: never the key value, only a short prefix."""
    now = _now_utc()
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


def delete_key(id: str) -> bool:
    with _LOCK:
        keys = _read()
        remaining = [e for e in keys if e.get("id") != id]
        if len(remaining) == len(keys):
            return False
        _write(remaining)
    return True


def has_any() -> bool:
    """The MCP gate's activation condition (and, later, the edit-tool
    registration prerequisite from the parked MCP-write note). A corrupt
    store counts as 'keys exist': the honest failure of a broken auth
    file is DENY, not open (PR #48 A-02).

    READ FIRST, then decide: `_store_broken or bool(_read())` looks
    identical but short-circuits — it samples the flag BEFORE the read
    that discovers (and clears) it, so the first call after a
    corruption event answered 'no keys' = gate OPEN (regression found
    by this PR's own pin)."""
    rows = _read()                      # updates _store_broken as it reads
    return _store_broken or bool(rows)


def validate(raw: str | None) -> dict | None:
    """The active key matching `raw`, or None. Constant-time comparison
    (hmac.compare_digest — the module docstring always promised it, now
    the code does it too, PR #48 A-06); expired keys never validate; a
    broken stamp write can never 500 the auth path (L-02)."""
    if not raw or not isinstance(raw, str):
        return None
    candidate = raw.strip()
    now = _now_utc()
    with _LOCK:
        keys = _read()
        for entry in keys:
            stored = entry.get("key")
            if not isinstance(stored, str) or not hmac.compare_digest(
                    stored, candidate):
                continue
            if _is_expired(entry, now):
                return None
            try:
                _maybe_stamp(entry, keys, now)
            except OSError:
                logger.warning("last-used stamp write failed for key %s",
                               entry.get("id"), exc_info=True)
            return dict(entry)
    return None


def _maybe_stamp(entry: dict, keys: list[dict], now: datetime) -> None:
    raw = entry.get("last_used_at")
    last: datetime | None
    try:
        last = datetime.fromisoformat(str(raw)) if raw else None
    except ValueError:
        last = None
    if last is not None:
        if last.tzinfo is not None:
            last = last.astimezone(timezone.utc).replace(tzinfo=None)
        if (now - last).total_seconds() < LAST_USED_STAMP_INTERVAL_S:
            return  # throttled: no write amplification per MCP call
    # The write below is WHOLESALE (this call's snapshot), so a key
    # deleted while this validation was in flight would be resurrected
    # by the stamp (PR #48 A-L01). last_used is cosmetic metadata — if
    # the row no longer exists on disk, skip the write, never rewrite
    # the store from a stale snapshot.
    if not any(k.get("id") == entry.get("id") for k in _read()):
        return
    entry["last_used_at"] = now.isoformat(timespec="seconds")
    _write(keys)
