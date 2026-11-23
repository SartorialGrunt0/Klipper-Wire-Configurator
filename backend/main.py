"""Klipper Wire Configurator - Backend Application"""
import os
from contextlib import asynccontextmanager
from pathlib import Path
import socket
import time
import ipaddress
from fastapi import FastAPI, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from api.routes import router
from api.native_routes import router as native_router
from api.ai_routes import router as ai_router
from api.printer_memory_routes import router as printer_memory_router
from api.macro_log_routes import router as macro_log_router
from mcp_server import McpServer, get_index
from services import api_keys
from services import path_containment
from services.mainsail_sidebar import self_heal_sidebar
from services.native_services import is_native_platform, OFF_HOST_WARNING
from fastapi.responses import JSONResponse


def _warn_off_host() -> None:
    """Boot-anywhere contract: warn once, never refuse.

    KWC's product surface is the Linux printer host, but every native
    service degrades defensively off-host — empty device lists from the
    missing /sys/class/net and dev globs, 503 from the missing Klipper
    socket, no firmware checkouts — so a non-Linux boot is a legitimate
    dev run. What was retired is the old dual browser/native MODE, and
    with it any need for an override variable: this one warning is the
    ONLY platform decision in the process, and no router is gated on it
    (locked by tests/test_no_platform_guards.py). Runs before any router
    is mounted.
    """
    if not is_native_platform():
        print(f"[startup] Warning: {OFF_HOST_WARNING}")


_warn_off_host()


@asynccontextmanager
async def _app_lifespan(app: FastAPI):
    """Re-assert the Mainsail sidebar entry on every service start.

    Moonraker's update_manager never runs install.sh on update (git_repo
    type = git pull + pip + managed_services restart), so the sidebar link
    — which lives in the Moonraker config dir, outside the repo — can only
    self-repair here. Best-effort: self_heal_sidebar never raises.
    """
    status = self_heal_sidebar()
    if status in ("added", "updated"):
        print(f"[startup] Mainsail sidebar entry {status}.")
    yield


app = FastAPI(title="Klipper Wire Configurator", version="1.0.0", lifespan=_app_lifespan)

# allow_credentials=False: KWC has no cookie auth, and wildcard+credentials
# is both invalid CORS and an invitation for foreign pages to ride the
# user's session (security-work 3.4).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── DNS-rebinding Host guard (security-work 3.3) ────────────────────
# Loopback trust survives a shared LAN but NOT DNS rebinding: a rebound
# drive-by request ARRIVES as loopback with an attacker Host header. So
# state-changing requests must additionally name THIS machine. ON
# regardless of any key.

_MUTATING_METHODS = {"POST", "PUT", "DELETE", "PATCH"}
_LOCAL_HOSTS_TTL_S = 60.0
_local_hosts_cache: tuple[float, set] = (0.0, set())


def _extra_allowed() -> set:
    return {h.strip().lower()
            for h in os.environ.get("KWC_ALLOWED_HOSTS", "").split(",")
            if h.strip()}


def _interface_addresses() -> set:
    """IPs currently configured on this machine's interfaces.

    The Host guard's notion of "this machine" must be the LIVE interface
    table, not the hostname's name resolution: cloud-image and Debian
    /etc/hosts files routinely map the hostname to 127.0.1.1 only, so
    gethostbyname_ex() misses every LAN address and legitimate LAN-IP
    POSTs were rejected (dogfood bug, 2026-11-23).
    """
    values = set()
    # Linux/macOS/BSD: libc getifaddrs via ctypes — every IPv4 on every
    # interface, correct on 32- and 64-bit (the SIOCGIFADDR ioctl recipe
    # silently drops secondary interfaces; dogfooded 2026-11-23).
    try:
        import array
        import ctypes
        import ctypes.util

        class _ifaddrs(ctypes.Structure):
            pass
        _ifaddrs._fields_ = [  # noqa: SLF001 (self-referential layout)
            ('ifa_next', ctypes.POINTER(_ifaddrs)),
            ('ifa_name', ctypes.c_char_p),
            ('ifa_flags', ctypes.c_uint),
            ('ifa_addr', ctypes.POINTER(ctypes.c_ubyte)),
            ('ifa_netmask', ctypes.POINTER(ctypes.c_ubyte)),
        ]
        libc = ctypes.CDLL(ctypes.util.find_library('c') or 'libc.so.6')
        head = ctypes.POINTER(_ifaddrs)()
        if libc.getifaddrs(ctypes.byref(head)) == 0:
            try:
                ptr = head
                while ptr:
                    addr = ptr.contents.ifa_addr
                    if addr:
                        family = ctypes.cast(
                            addr, ctypes.POINTER(ctypes.c_ushort)).contents.value
                        if family == socket.AF_INET:
                            # sockaddr_in: [0:2]=family [2:4]=port [4:8]=IPv4
                            octets = bytes(addr[i] for i in range(4, 8))
                            ip = socket.inet_ntoa(octets)
                            if ip != '0.0.0.0':
                                values.add(ip)
                    ptr = ptr.contents.ifa_next
            finally:
                libc.freeifaddrs(head)
    except (OSError, ValueError, AttributeError):
        pass
    # Any platform: the source address the routing table picks for the
    # default route (UDP connect sends nothing). Covers the primary NIC
    # where the ioctl path is unavailable (e.g. Windows dev boxes).
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(('192.0.2.1', 1))  # TEST-NET, no traffic
            values.add(probe.getsockname()[0])
        finally:
            probe.close()
    except OSError:
        pass
    return values


def _local_host_values() -> set:
    global _local_hosts_cache
    now = time.monotonic()
    if now - _local_hosts_cache[0] < _LOCAL_HOSTS_TTL_S and _local_hosts_cache[1]:
        return _local_hosts_cache[1]
    values = {"localhost", "::1", "127.0.0.1"}
    values |= _interface_addresses()
    try:
        name = socket.gethostname().lower()
        values.add(name)
        values.add(name + ".local")  # mDNS alias of THIS name only
        infos = socket.gethostbyname_ex(name)
        values.update(v.lower() for v in (infos[0], *infos[1], *infos[2])
                      if isinstance(v, str))
    except OSError:
        pass
    _local_hosts_cache = (now, values)
    return values


def _host_is_local(host_header: str, local_values: set) -> bool:
    h = (host_header or "").strip().lower()
    if h.startswith("["):
        end = h.find("]")
        h = h[:end] if end != -1 else h
    elif ":" in h and h.rsplit(":", 1)[1].isdigit():
        h = h.rsplit(":", 1)[0]
    h = h.strip("[]")
    try:
        if ipaddress.ip_address(h).is_loopback:
            return True
    except ValueError:
        pass
    # A plain STRING-prefix loopback test is the DNS-rebinding bypass this
    # clause used to be (127.attacker.example A-records to the LAN IP and
    # 'startswith("127.")' let it through). Loopback is decided by IP
    # parse; everything else must EXACTLY match a real local value.
    return h in local_values


def _host_guard_blocks(method: str, client_host, host_header: str,
                       local_values: set) -> bool:
    if method.upper() not in _MUTATING_METHODS:
        return False
    if client_host is None:
        return False
    try:
        ipaddress.ip_address(str(client_host))
    except ValueError:
        # Not a real socket address (in-process harness) — not a threat.
        return False
    host = (host_header or "").split(",")[0]
    return not _host_is_local(host, local_values | _extra_allowed())


@app.middleware("http")
async def host_guard_middleware(request: Request, call_next):
    client_host = request.client.host if request.client else None
    if _host_guard_blocks(request.method, client_host,
                          request.headers.get("host", ""),
                          _local_host_values()):
        return JSONResponse(status_code=403, content={"detail":
            "Host header does not name this machine (DNS-rebinding "
            "guard). Reaching KWC through a name or proxy? Add it to "
            "KWC_ALLOWED_HOSTS."})
    return await call_next(request)

# ── Shared MCP server instance (embedded, zero extra RAM) ──
mcp_server = McpServer()


@app.post("/api/mcp")
async def mcp_endpoint(request: dict, authorization: str = Header(default=None)):
    """MCP JSON-RPC endpoint for the /ai/chat proxy and external HTTP clients.

    Allows the AI chat proxy to call MCP tools without spawning a subprocess.
    External MCP clients that support HTTP transport (e.g. pi, some VS Code
    extensions) can also connect here.

    For stdio-based MCP clients (Claude Desktop, etc.):
        python -m backend.mcp_server

    Gate (security-work D1): with ZERO keys defined this behaves exactly
    as before; with >=1 key, HTTP callers must authenticate with
    `Authorization: Bearer <key>` — the header the MCP authorization spec
    prescribes, so spec-following clients work with zero configuration.
    The AI chat never passes through here (in-process shared instance).
    """
    bearer_token = None
    if authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() == "bearer" and value.strip():
            bearer_token = value.strip()
    if api_keys.has_any() and api_keys.validate(bearer_token) is None:
        return JSONResponse(status_code=401, content={"error": {
            "code": -32001,
            "message": "MCP access requires an 'Authorization: Bearer <key>' "
                       "header. Create a key in KWC (gear menu > Security > "
                       "Manage Keys).",
        }})
    result = mcp_server.handle_jsonrpc(request)
    if result is None:
        return JSONResponse(content={}, status_code=202)
    return result


@app.get("/api/mcp/health")
async def mcp_health():
    """MCP server health check — returns index stats."""
    index = get_index()
    return {
        "status": "ok",
        "documents_indexed": index.get_doc_count(),
        "server": "klipper-wire-configurator",
        "protocol": "2024-11-05",
    }


app.include_router(router, prefix="/api")
app.include_router(native_router, prefix="/api/native")
app.include_router(ai_router)
app.include_router(printer_memory_router, prefix="/api")
app.include_router(macro_log_router, prefix="/api")

PROJECTS_DIR = Path(os.environ.get("KWC_PROJECTS_DIR", "./projects"))
PROJECTS_DIR.mkdir(parents=True, exist_ok=True)

REFERENCE_DIR = Path(__file__).parent.parent / "reference"

# Serve built frontend in production
FRONTEND_DIST = Path(__file__).parent.parent / "frontend" / "dist"


@app.get("/health")
async def health():
    return {"status": "ok"}


if FRONTEND_DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        """Serve the SPA index.html for all non-API routes.

        The naive join (`FRONTEND_DIST / full_path`) is an arbitrary file
        read: percent-encoded %2e%2e segments survive routing and decode
        here into '..' (PR #48 review A-01, live-probed serving
        /etc/passwd and the API-key store). Contain to the dist dir;
        anything else falls back to index.html exactly like a normal
        SPA route.
        """
        if full_path:
            try:
                candidate = path_containment.resolve_within_roots(
                    full_path, [FRONTEND_DIST])
            except ValueError:
                return FileResponse(FRONTEND_DIST / "index.html")
            if candidate.is_file():
                return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("KWC_PORT", "8099"))
    # Reload is opt-in (KWC_RELOAD=1). The uvicorn reloader spawns a second
    # process that can split incoming requests across two in-memory states
    # (e.g. the AI chat stop registry), so it is disabled by default.
    reload = os.environ.get("KWC_RELOAD", "0") == "1"
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=reload)
