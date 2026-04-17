# Klipper Wire Configurator

Visually wire Klipper components in a graphical interface to inspect, create, and modify `printer.cfg` files.

## Prerequisites

- Python 3.10+
- Node.js 18+ and npm

## Quick start (recommended)

From the repository root:

### Linux / macOS

```bash
chmod +x ./start-dev.sh
./start-dev.sh
```

### Windows (PowerShell)

```powershell
./start-dev.ps1
```

### Windows (Command Prompt)

```bat
start-dev.bat
```

After startup:

- Frontend: http://localhost:5173
- Backend: http://localhost:8099

## Manual setup and run

Use this if you prefer running backend and frontend in separate terminals.

### 1) Backend (FastAPI)

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python main.py
```

Windows PowerShell equivalent:

```powershell
cd backend
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
python main.py
```

### 2) Frontend (Vite)

In a second terminal, from the repository root:

```bash
cd frontend
npm install
npm run dev
```

## Build for production

From the repository root:

```bash
cd frontend
npm install
npm run build
```

Then run backend from the repository root (it serves `frontend/dist` when present):

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python main.py
```

## Validation commands

From the repository root:

```bash
python3 test_roundtrip.py
python3 test_diff_roundtrip.py
cd frontend
npm install
npm run build
```

## Notes

- API health endpoint: `GET /health` (http://localhost:8099/health)
- Backend API routes are mounted under `/api`.
