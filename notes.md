# Notes

This file keeps the extra operational and development details that were removed from the main README.

## Moonraker update_manager

If you want Moonraker to track this app and offer updates in Mainsail or Fluidd, add the following section to `moonraker.conf`:

```ini
[update_manager klipper-wire-configurator]
type: git_repo
channel: dev
path: ~/Klipper-Wire-Configurator
origin: https://github.com/SartorialGrunt0/Klipper-Wire-Configurator.git
primary_branch: main
virtualenv: ~/Klipper-Wire-Configurator/venv
requirements: backend/requirements.txt
managed_services: klipper-wire-configurator
info_tags:
	desc=Klipper Wire Configurator
```

If your installation actually lives at `~/klipper-wire-configurator`, use that exact lower-case path everywhere instead.

Klipper Wire Configurator installs a systemd service at `/etc/systemd/system/klipper-wire-configurator.service`, running as your Linux user. Moonraker can restart that service through `managed_services` after updates.

Moonraker also needs permission to restart the service. Add this line to your `moonraker.asvc` allow-list file, which is typically located at `~/printer_data/moonraker.asvc`:

```text
klipper-wire-configurator
```

Then restart Moonraker.

Once the system service is installed and Moonraker has been restarted, Mainsail's Service Control menu can list `klipper-wire-configurator` and send start, stop, and restart actions through Moonraker.

Moonraker's `git_repo` updater does not run this repository's installer script. It pulls the repo, updates Python requirements from `backend/requirements.txt`, and restarts the configured managed service.

The installed service starts through `scripts/run-service.sh`. On every service start it checks whether frontend dependencies need reinstalling and whether the frontend bundle needs rebuilding, then launches uvicorn. That makes a Moonraker-triggered service restart sufficient for normal application updates.

If you installed Klipper Wire Configurator before the system-service migration was added, rerun the installer once manually:

```bash
cd ~/Klipper-Wire-Configurator
bash scripts/install.sh
```

## Development shortcuts

From the repository root:

### Linux / macOS

```bash
chmod +x ./start-dev.sh
./start-dev.sh
```

### Windows PowerShell

```powershell
./start-dev.ps1
```

### Windows Command Prompt

```bat
start-dev.bat
```

After startup:

- Frontend: http://localhost:5173
- Backend: http://localhost:8099

## Windows backend setup

If you want to run backend and frontend in separate terminals on Windows PowerShell:

```powershell
cd backend
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
python main.py
```

## Manual build and deploy

Build the frontend bundle:

```bash
cd frontend
npm install
npm run build
```

From the repository root, the backend serves `frontend/dist` when present:

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

## API notes

- Health endpoint: `GET /health` at `http://localhost:8099/health`
- Backend API routes are mounted under `/api`