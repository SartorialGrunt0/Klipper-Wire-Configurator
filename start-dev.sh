#!/usr/bin/env bash
# Klipper Wire Configurator - Development Server Startup Script (Linux/macOS)
# Starts both backend (FastAPI) and frontend (Vite) servers in parallel

set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

# KWC only runs on the Linux printer host: off Linux the backend exits at
# startup unless KWC_FAKE_NATIVE is set (see backend/main.py). Fake-native is
# the dev override, not a deployment mode — and on Linux it is already a no-op,
# because is_native_platform() is its only consumer.
export KWC_FAKE_NATIVE=1

KWC_PORT="${KWC_PORT:-8099}"
HEALTH_URL="http://127.0.0.1:${KWC_PORT}/health"

echo ""
echo "Starting Klipper Wire Configurator..."
echo ""

# Start Backend (FastAPI on the dev port)
echo "Starting backend (FastAPI on port ${KWC_PORT})..."
if [ ! -f "$BACKEND_DIR/venv/bin/python" ]; then
    echo "Creating backend venv..."
    cd "$BACKEND_DIR"
    python3 -m venv venv
fi
cd "$BACKEND_DIR"
# piwheels fallback for 32-bit ARM: markupsafe (jinja2's dependency) has no
# official armv7l wheels and would otherwise build from source (needs Rust).
# Raspberry Pi OS configures piwheels by default; add it when missing.
if ! venv/bin/pip config list 2>/dev/null | grep -qi piwheels; then
    export PIP_EXTRA_INDEX_URL="${PIP_EXTRA_INDEX_URL:+$PIP_EXTRA_INDEX_URL }https://www.piwheels.org/simple"
fi
# Refresh Python dependencies on every start so pulls that add new
# requirements (e.g. jinja2) work without manually reinstalling.
echo "Refreshing backend Python dependencies..."
venv/bin/pip install -r requirements.txt
venv/bin/python main.py &
BACKEND_PID=$!

# Register cleanup BEFORE the first early exit: from this point on a health
# failure (or Ctrl+C during the wait) must take the backend down with it, or
# it is orphaned holding the port and the next run's health wait gets answered
# by the stale process. FRONTEND_PID is expanded at trap time, so it is
# included once the frontend exists.
trap 'echo ""; echo "Stopping servers..."; kill "$BACKEND_PID" ${FRONTEND_PID:+"$FRONTEND_PID"} 2>/dev/null || true; echo "Servers stopped."' EXIT

# Wait for the backend to actually answer. A fixed sleep only pretends to: the
# process can be dead and this script used to announce success anyway.
backend_up=0
for _ in $(seq 1 60); do
    if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
        break
    fi
    if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
        backend_up=1
        break
    fi
    sleep 1
done
if [ "$backend_up" -ne 1 ]; then
    echo "Backend did not answer ${HEALTH_URL} — check its output above." >&2
    exit 1
fi
echo "Backend is answering on ${HEALTH_URL}."

# Start Frontend (Vite on port 5173)
echo "Starting frontend (Vite on port 5173)..."
echo "Installing frontend dependencies..."
cd "$FRONTEND_DIR"
npm install
npm run dev &
FRONTEND_PID=$!

# Give frontend a moment to start
sleep 3

echo ""
echo "Backend verified on port ${KWC_PORT}; frontend launched - watch the Vite output until it serves."
echo ""
echo "Backend:  http://localhost:${KWC_PORT}"
echo "Frontend: http://localhost:5173"
echo ""

# Open browser if possible
if command -v xdg-open &>/dev/null; then
    xdg-open http://localhost:5173
elif command -v open &>/dev/null; then
    open http://localhost:5173
fi

echo "Press Ctrl+C to stop both servers."
echo ""

# Cleanup runs via the EXIT trap registered right after the backend launch.
wait
