# Security

KWC runs on the printer it configures, on a home/LAN network. This document
records the threat model, the hardening that has been implemented, and —
just as important — the protections that were deliberately **not** built,
and the trigger that would change that decision.

## Threat model: trusted LAN

KWC's security posture matches Moonraker's, the software it sits beside:
the machine it runs on and the local network are treated as **trusted**.
A process or user on the printer host is already inside the
filesystem-permission boundary (KWC's config files are readable by any
user that can read Moonraker's), and a LAN peer that can reach port 8099
can reach Moonraker's port 7125 just as easily — where the default
install is fully unauthenticated and can write `printer.cfg` and run
gcode.

There is deliberately **no app-wide login, no user accounts, and no
TLS**. KWC adds no new exposure class over Moonraker; the marginal
surface (burning AI-provider credits through the chat) was judged
against the same baseline. This mirrors the ecosystem: Moonraker and
OctoPrint ship LAN-trust by default and treat host filesystem access,
not a login, as the game-over line.

**Trigger to revisit everything in this section:** KWC becomes reachable
beyond the user's own devices or network (cloud relay, tunnel,
multi-tenant host). Until then, proposals for JWT/TLS/user-accounts are
out of scope by design, not oversight.

## What is authenticated: the MCP endpoint

The one HTTP surface with a key gate is the MCP JSON-RPC endpoint
(`POST /api/mcp`), because it is designed to be called by *external*
agents (Claude Desktop, scripts, editors) rather than the browser UI:

- **Zero keys defined → open.** The endpoint behaves exactly as it
  always has. The keys feature is opt-in.
- **One or more keys → `Authorization: Bearer <key>` required** for that one route
  (the MCP authorization-spec header, so spec-following clients need no custom
  header config). The 401 names the fix (gear menu → Security → Manage Keys).

The KWC web app never authenticates: its AI chat calls the same MCP
server **in-process**, not over HTTP, so creating a key can never lock
out the local UI. Stdio MCP (`python -m backend.mcp_server`) runs as
the same user and is not gated — filesystem permissions are its
boundary.

Keys are generated **server-side** (Manage Keys dialog triggers it),
stored **plaintext** in `api_keys.json` (mode `0600`) beside the
settings file — hashing them would defeat their job (copying into an
external client's config), and Moonraker's `api_key_file` is the same
posture. A key's value is served **exactly once**, in its Create or
Replace response, and is **never re-displayable**: no route serves an
existing value anymore (PR #48 review retired the reveal route for
exactly that reason). Lost a key? **Replace** rotates it in place and
shows the fresh value once. List responses carry name, expiry,
last-used, and a short prefix only. Expiry is opt-in per key (default:
never); a date-only expiry means END of that day; an expired key stops
validating and shows as expired. If the store file is corrupt the gate
DENIES (fail-closed), never silently opens.

## Implemented hardening

| Area | Behavior |
| --- | --- |
| Provider API keys | Never sent to the browser. `GET /ai/state` and `/ai/history` return `hasApiKey: *** + a `server-stored` sentinel; the value is resolved server-side at call time — and the stored key is attached ONLY to the URL it was saved for, so no request can steer it to another endpoint (PR #48). |
| Moonraker token | Stored server-side only (masked in settings responses), `settings.json` written owner-only `0600`. Env override: `KWC_MOONRAKER_API_KEY`. |
| Print state honesty | A Moonraker that ANSWERS but can't be read (401, empty status, 403/5xx, non-JSON body) reports `print_state: "unknown"` — never a fake "not printing". A Moonraker that is network-unreachable keeps the not-printing answer, which is the honest reply on standalone installs. |
| Path containment | Request-supplied paths (`/api/native/config-files`, read, `apply` — writes AND deletes) are resolved (symlinks followed) and must land inside the configured config dir, plus any `KWC_EXTRA_CONFIG_DIRS`; the root itself is validated absolute on save, so it is not client-steerable. Config-file reads follow the Klipper include-closure, which for parity follows in-dir symlinks Klipper itself would follow. Firmware checkout trees must pass a real-project Makefile signature check before anything in them is loaded or built. The SPA static route resolves inside `frontend/dist` only. |
| DNS-rebinding guard | State-changing requests (POST/PUT/PATCH/DELETE) must carry a `Host` naming this machine: an exact match of a loopback IP, a real interface address, the hostname, `<hostname>.local`, or `KWC_ALLOWED_HOSTS`. Name-prefix tricks (`127.attacker.example`) are rejected (PR #48). GET routes neither persist nor mutate. ON regardless of keys — this guard also protects the Manage Keys routes. |
| CORS | `allow_credentials=False` with wildcard origins — KWC has no cookie auth to ride, and the routes that could matter cross-origin are behind the Host guard, which a foreign page cannot satisfy. |

## Environment variables

| Variable | Effect |
| --- | --- |
| `KWC_MOONRAKER_API_KEY` | Overrides the stored Moonraker token for print-state queries. |
| `KWC_EXTRA_CONFIG_DIRS` | `os.pathsep`-separated extra roots allowed by path containment (for split config layouts). |
| `KWC_ALLOWED_HOSTS` | Comma-separated extra `Host` values accepted by the rebinding guard (reverse-proxy setups). |

## Recovery

Lost or leaked MCP keys are managed from the app itself — open KWC
locally (or over an SSH tunnel: `ssh -L 8099:localhost:8099 pi@printer`)
and **Replace** (rotate) or delete the row in Manage Keys. Deleting
`api_keys.json` reverts the MCP endpoint to its open (keyless) state —
note that only DELETING the file does that; a corrupt file closes the
gate rather than opening it.
This follows the ecosystem convention that the host filesystem is the
recovery door, not a backdoor flag.
