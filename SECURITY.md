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

Keys are generated in the browser (Manage Keys dialog), stored
**plaintext** in `api_keys.json` (mode `0600`) beside the settings
file, and are **re-copyable forever** — that is the whole job of the
value, so hashing it would defeat the feature. Moonraker's
`api_key_file` is the same posture. A key row's value is served only
by an explicit Create or Reveal response; list responses carry name,
expiry, last-used, and a short prefix. Expiry is opt-in per key
(default: never); an expired key stops validating and shows as expired.

## Implemented hardening

| Area | Behavior |
| --- | --- |
| Provider API keys | Never sent to the browser. `GET /ai/state` and `/ai/history` return `hasApiKey: true` + a `server-stored` sentinel; the value is resolved server-side at call time. |
| Moonraker token | Stored server-side only (masked in settings responses). Env override: `KWC_MOONRAKER_API_KEY`. |
| Print state honesty | An unreachable or 401 Moonraker answers `print_state: "unknown"` — never a fake "not printing". |
| Path containment | Request-supplied paths (`/api/native/config-files`, read, `apply`) are resolved (symlinks followed) and must land inside the configured config dir, plus any `KWC_EXTRA_CONFIG_DIRS`. Writes through an in-dir symlink that escapes are refused. |
| DNS-rebinding guard | State-changing requests (POST/PUT/PATCH/DELETE) must carry a `Host` naming this machine (its IPs, hostname, `<hostname>.local`, `localhost`, or `KWC_ALLOWED_HOSTS`). Loopback trust does not survive rebinding, so this is ON regardless of keys. |
| CORS | `allow_credentials=False` with wildcard origins — KWC has no cookie auth to ride. |

## Environment variables

| Variable | Effect |
| --- | --- |
| `KWC_MOONRAKER_API_KEY` | Overrides the stored Moonraker token for print-state queries. |
| `KWC_EXTRA_CONFIG_DIRS` | `os.pathsep`-separated extra roots allowed by path containment (for split config layouts). |
| `KWC_ALLOWED_HOSTS` | Comma-separated extra `Host` values accepted by the rebinding guard (reverse-proxy setups). |

## Recovery

Lost or leaked MCP keys are managed from the app itself — open KWC
locally (or over an SSH tunnel: `ssh -L 8099:localhost:8099 pi@printer`)
and create a new key, or delete the old one, in Manage Keys. Deleting
`api_keys.json` reverts the MCP endpoint to its open (keyless) state.
This follows the ecosystem convention that the host filesystem is the
recovery door, not a backdoor flag.
