#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
BACKEND_DIR="$ROOT_DIR/backend"

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

ensure_frontend_build() {
    local dist_index="$FRONTEND_DIR/dist/index.html"

    if needs_npm_install; then
        echo "[kwc] Installing frontend dependencies..."
        cd "$FRONTEND_DIR"
        npm ci
    fi

    if has_newer_sources "$dist_index"; then
        echo "[kwc] Building frontend bundle..."
        cd "$FRONTEND_DIR"
        npm run build
    fi
}

ensure_frontend_build

cd "$BACKEND_DIR"
exec "$ROOT_DIR/venv/bin/uvicorn" main:app --host 0.0.0.0 --port "${KWC_PORT:-8099}"