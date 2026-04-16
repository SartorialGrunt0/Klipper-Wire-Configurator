#!/usr/bin/env bash
# Klipper Wire Configurator - Development Server Startup Script (Linux/macOS)
# Starts both backend (FastAPI) and frontend (Vite) servers in parallel

set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

echo ""
echo "Starting Klipper Wire Configurator..."
echo ""

# Start Backend (FastAPI on port 8099)
echo "Starting backend (FastAPI on port 8099)..."
if [ ! -f "$BACKEND_DIR/venv/bin/python" ]; then
    echo "Creating backend venv..."
    cd "$BACKEND_DIR"
    python3 -m venv venv
    venv/bin/pip install -r requirements.txt
fi
cd "$BACKEND_DIR"
venv/bin/python main.py &
BACKEND_PID=$!

# Give backend a moment to start
sleep 2

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
echo "Both servers started successfully!"
echo ""
echo "Backend:  http://localhost:8099"
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

# Wait and clean up on exit
trap "echo ''; echo 'Stopping servers...'; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; echo 'Servers stopped.'" EXIT
wait
