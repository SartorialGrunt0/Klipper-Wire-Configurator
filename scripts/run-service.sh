#!/usr/bin/env bash
# Start script for the klipper-wire-configurator systemd service.
#
# For an update_manager-driven update this is the ONLY code path that runs
# after a `git pull`: Moonraker's git_repo handler pulls the repo, updates pip
# requirements and restarts the managed service. Its `install_script` option is
# parsed for package names, never executed, and `enable_node_updates` requires
# package-lock.json at the repository root (ours lives in frontend/), so the
# frontend bundle is rebuilt here, on service start.
#
# Every step of that rebuild is deliberately best-effort: the app must start
# even when the rebuild cannot. Field failure 2026-10-01 — an unguarded
# rebuild hit V8's default heap ceiling on a Pi Zero 2 W, the unit
# crash-looped, and KWC stayed down for hours until install.sh was re-run by
# hand. A stale or missing bundle is a far better outcome than a dead service.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
BACKEND_DIR="$ROOT_DIR/backend"
DIST_DIR="$FRONTEND_DIR/dist"
STAGING_DIR="$FRONTEND_DIR/dist.next"
PREVIOUS_DIR="$FRONTEND_DIR/dist.previous"
BUILD_LOCK="$FRONTEND_DIR/.kwc-build.lock"
# Overridable so the low-memory guard can be exercised without a small host.
MEMINFO_FILE="${KWC_MEMINFO_FILE:-/proc/meminfo}"

log()  { echo "[kwc] $*"; }
warn() { echo "[kwc] WARNING: $*" >&2; }

needs_npm_install() {
    [ ! -d "$FRONTEND_DIR/node_modules" ] || [ "$FRONTEND_DIR/package-lock.json" -nt "$FRONTEND_DIR/node_modules" ]
}

has_newer_sources() {
    local target="$1"

    if [ ! -e "$target" ]; then
        return 0
    fi

    for path in \
        "$FRONTEND_DIR/index.html" \
        "$FRONTEND_DIR/package.json" \
        "$FRONTEND_DIR/package-lock.json" \
        "$FRONTEND_DIR/tsconfig.json" \
        "$FRONTEND_DIR/vite.config.ts"; do
        if [ -e "$path" ] && [ "$path" -nt "$target" ]; then
            return 0
        fi
    done

    for dir in "$FRONTEND_DIR/src" "$FRONTEND_DIR/public" "$FRONTEND_DIR/scripts"; do
        if [ -d "$dir" ] && find "$dir" -type f -newer "$target" -print -quit | grep -q .; then
            return 0
        fi
    done

    return 1
}

# Node's default V8 old-space limit is derived from physical memory and, on
# 32-bit ARM, is far too small for this bundle (~123 MB observed on a 424 MB
# Pi Zero 2 W). The process aborts at that self-imposed ceiling long before
# the system's swap is used — a heap limit is invisible to swap. On hosts with
# less than 2 GB of RAM+swap, size the heap to ~half of that total so npm and
# Vite page into swap instead of aborting.
#
# This mirrors the guard in scripts/install.sh — keep the two in sync.
apply_node_heap_guard() {
    local total_mem_mb node_heap_mb
    total_mem_mb="$(awk '/MemTotal/ {m=$2} /SwapTotal/ {s=$2} END {printf "%d", (m+s)/1024}' "$MEMINFO_FILE" 2>/dev/null || echo 0)"
    if [ "${total_mem_mb:-0}" -lt 2048 ]; then
        node_heap_mb=$(( total_mem_mb / 2 ))
        [ "$node_heap_mb" -lt 384 ] && node_heap_mb=384
        export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$node_heap_mb"
        log "Low-memory device (${total_mem_mb} MB RAM+swap): Node heap raised to ${node_heap_mb} MB."
    fi
}

# Serialize rebuilds. install.sh takes the same lock: the installer's build
# and this one can otherwise run at the same time and OOM each other on a
# small host (observed 2026-10-01). Falls back to an unlocked build rather
# than failing when flock is unavailable.
with_build_lock() {
    if ! command -v flock >/dev/null 2>&1; then
        "$@"
        return $?
    fi

    local lock_fd rc=0
    # No 2>/dev/null here: `exec` with only redirections applies them to the
    # SHELL, so silencing it would swallow every later diagnostic. A failure
    # prints bash's own error and falls through to an unlocked build.
    if ! exec {lock_fd}>>"$BUILD_LOCK"; then
        warn "Could not open the build lock at $BUILD_LOCK; building without it."
        "$@"
        return $?
    fi
    flock "$lock_fd"
    "$@" || rc=$?
    flock -u "$lock_fd" 2>/dev/null || true
    exec {lock_fd}>&-
    return "$rc"
}

# Swap a freshly built staging bundle into place, checking EVERY step.
#
# This runs inside `if ! ...`, where bash suspends errexit for the whole call
# (Shell Functions, POSIX: "if a compound command or shell function executes
# in a context where -e is being ignored, none of the commands executed
# within ... will be affected by the -e setting"). An unchecked `mv` therefore
# fails silently and control falls through to the success path — observed
# 2026-10-01: every rename was denied, the log still said "Frontend bundle
# updated." and the caller returned 0 with dist/ holding the old bundle and
# the new one stranded in dist.next.
#
# Two renames cannot be atomic, so dist/ is never left absent: if the second
# rename fails, the first is undone.
#
# Kept byte-identical in scripts/install.sh and scripts/run-service.sh —
# change both or neither.
swap_staged_bundle() {
    local dir="${1:?frontend directory required}"
    local dist="$dir/dist" staging="$dir/dist.next" previous="$dir/dist.previous"

    # Only clear the old rollback copy when there is a USABLE current bundle to
    # take its place. In the torn-swap state (dist absent) the bundle in
    # dist.previous is the ONLY usable copy, and deleting it here would destroy
    # the last good bundle before the new one is secured.
    #
    # The test is `dist/index.html`, not `dist`, matching
    # restore_previous_bundle_if_needed. An empty or corrupt dist/ is not a
    # bundle worth preserving, but discarding it must not cost us dist.previous.
    if [ -f "$dist/index.html" ]; then
        if [ -e "$previous" ] && ! rm -rf "$previous"; then
            warn "Could not clear $previous; keeping the current bundle."
            return 1
        fi
        if ! mv "$dist" "$previous"; then
            warn "Could not move the current bundle aside; keeping it in place."
            return 1
        fi
    elif [ -e "$dist" ]; then
        # dist/ exists but holds no bundle: discard it — otherwise the final
        # `mv` below would nest dist.next inside it — while leaving
        # dist.previous, which may be the only good copy, alone.
        if ! rm -rf "$dist"; then
            warn "Could not clear the unusable $dist; keeping the current bundle."
            return 1
        fi
    fi
    if ! mv "$staging" "$dist"; then
        warn "Could not put the new bundle in place; restoring the previous one."
        if [ -e "$previous" ]; then
            mv "$previous" "$dist" 2>/dev/null || \
                warn "Could not restore $previous — it is still there for a manual move."
        fi
        return 1
    fi
    return 0
}

# A bundle sitting in dist.previous is still perfectly good: an interrupted
# swap, or a failed build after the old bundle was moved aside, leaves the UI
# dead while a usable bundle is on disk. Put it back rather than serve nothing.
#
# Kept byte-identical in scripts/install.sh and scripts/run-service.sh —
# change both or neither.
restore_previous_bundle_if_needed() {
    local dir="${1:?frontend directory required}"
    local dist="$dir/dist" previous="$dir/dist.previous"

    if [ ! -f "$dist/index.html" ] && [ -f "$previous/index.html" ]; then
        warn "No bundle in $dist; restoring the previous one from $previous."
        rm -rf "$dist"
        if mv "$previous" "$dist"; then
            return 0
        fi
        warn "Could not restore the previous bundle; the web UI will be unavailable."
    fi
    return 0
}

# Build into a staging directory and swap it into place. Vite empties its
# output directory first, so building straight into dist/ would leave a
# running server serving a half-written bundle, and a build that dies part-way
# would destroy the last good one. The swap keeps dist/ wholly old or wholly
# new, and leaves the previous bundle in dist.previous for a manual rollback.
build_frontend() {
    rm -rf "$STAGING_DIR"
    if ! ( cd "$FRONTEND_DIR" && npm run build -- --outDir "$STAGING_DIR" ); then
        warn "Frontend build failed; keeping the current bundle."
        rm -rf "$STAGING_DIR"
        return 1
    fi
    if [ ! -f "$STAGING_DIR/index.html" ]; then
        warn "Frontend build produced no index.html; keeping the current bundle."
        rm -rf "$STAGING_DIR"
        return 1
    fi
    swap_staged_bundle "$FRONTEND_DIR" || return 1
    log "Frontend bundle updated."
    return 0
}

# Runs under the build lock; re-checks what needs doing once the lock is held
# so a build that just finished elsewhere is not repeated.
_ensure_frontend_build_locked() {
    if needs_npm_install; then
        log "Installing frontend dependencies..."
        if ! ( cd "$FRONTEND_DIR" && npm ci ); then
            warn "npm ci failed."
            return 1
        fi
    fi

    if has_newer_sources "$DIST_DIR/index.html"; then
        log "Building frontend bundle..."
        build_frontend || return 1
    fi

    return 0
}

ensure_frontend_build() {
    apply_node_heap_guard
    local rc=0
    with_build_lock _ensure_frontend_build_locked || rc=$?
    # A failed or interrupted swap can leave the only usable bundle in
    # dist.previous; put it back rather than start with no UI at all.
    restore_previous_bundle_if_needed "$FRONTEND_DIR"
    return "$rc"
}

if ! ensure_frontend_build; then
    if [ -f "$DIST_DIR/index.html" ]; then
        warn "Frontend rebuild failed — starting on the existing bundle in $DIST_DIR."
    else
        warn "Frontend rebuild failed and no bundle exists in $DIST_DIR — the web UI will be unavailable until a build succeeds."
    fi
    warn "Rebuild manually with: cd $FRONTEND_DIR && npm ci && npm run build"
fi

cd "$BACKEND_DIR"
exec "$ROOT_DIR/venv/bin/uvicorn" main:app --host 0.0.0.0 --port "${KWC_PORT:-8099}"
