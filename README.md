# Klipper Wire Configurator

## Introduction

Klipper Wire Configurator is a web app that helps you inspect, create, and modify Klipper `printer.cfg` files in a visual wiring interface.

## Prerequisites

- Python 3.10+
- Node.js 18+ and npm

## Installing

### Install on Raspberry Pi

On your Raspberry Pi (Raspberry Pi OS / Debian-based):

```bash
cd ~
git clone https://github.com/SartorialGrunt0/Klipper-Wire-Configurator.git
cd Klipper-Wire-Configurator
bash scripts/install.sh
```

On 32-bit Raspberry Pi OS (`armv7` / `armhf`), the installer uses the distro `nodejs` package instead of NodeSource because NodeSource does not publish that architecture.

After install, open from another device on your network:

```bash
hostname -I | awk '{print "http://" $1 ":8099"}'
```

A successful install now ends with a terminal confirmation that the service passed its health check and prints the installer log path under `/tmp/klipper-wire-configurator-install-*.log`.

Service management on Raspberry Pi:

```bash
systemctl --user status klipper-wire-configurator
systemctl --user restart klipper-wire-configurator
journalctl --user -u klipper-wire-configurator -f
```

Uninstall on Raspberry Pi:

```bash
bash ~/klipper-wire-configurator/scripts/install.sh --uninstall
```

### Moonraker update_manager

If you want Moonraker to track this app and offer updates in Mainsail or Fluidd, add the following section to `moonraker.conf`:

```ini
[update_manager klipper-wire-configurator]
type: git_repo
channel: dev
path: ~/klipper-wire-configurator
origin: https://github.com/SartorialGrunt0/Klipper-Wire-Configurator.git
primary_branch: main
virtualenv: ~/klipper-wire-configurator/venv
requirements: backend/requirements.txt
managed_services: klipper-wire-configurator
info_tags:
	desc=Klipper Wire Configurator
```

Moonraker also needs permission to restart the service. Add this line to your `moonraker.asvc` allow-list file, which is typically located at `~/printer_data/moonraker.asvc`:

```text
klipper-wire-configurator
```

Then restart Moonraker.

Moonraker will not rerun this repository's installer directly. Instead, the installed service checks whether the frontend assets are stale each time it starts. After a Moonraker-managed update, the service restart will automatically rebuild `frontend/dist` when frontend source files changed.

If you installed Klipper Wire Configurator before this behavior was added, rerun the installer once so your systemd user service picks up the new startup wrapper:

```bash
cd ~/klipper-wire-configurator
bash scripts/install.sh
```

### Local install for development (copy/paste)

From the repository root:

#### Linux / macOS

```bash
chmod +x ./start-dev.sh
./start-dev.sh
```

#### Windows (PowerShell)

```powershell
./start-dev.ps1
```

#### Windows (Command Prompt)

```bat
start-dev.bat
```

After startup:

- Frontend: http://localhost:5173
- Backend: http://localhost:8099

## Development Setup

Use this if you want backend and frontend in separate terminals.

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

## Deploying

### Build frontend bundle

```bash
cd frontend
npm install
npm run build
```

### Run backend to serve built frontend

From the repository root, backend serves `frontend/dist` when present:

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
