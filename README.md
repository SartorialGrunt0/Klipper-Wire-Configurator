# Klipper Wire Configurator

Klipper Wire Configurator is a web-based tool for inspecting, creating, and editing Klipper `printer.cfg` files with an intuitive graphical interface. It simplifies configuration management by providing visual tools to view connections, add components from the official reference, validate settings in real-time, and apply changes directly to your printer. The software runs locally on your SBC and is completely free and open-source under the GPL3 license.

Special thanks to the Klipper, Mainsail, Moonraker, Fluidd, and other teams whose work was heavily referenced for this project.

## Table of contents

- [Features](#features)
- [AI Chat](docs/AI_CHAT.md)
- [Installing](#installing/uninstalling)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Features

### Visual Tools

- View your printer's hardware as interactive cards and wires—MCUs, steppers, heaters, probes, and more.
- Add any Klipper component directly from the official Config Reference documentation.
- Import example configurations organized by board type (Mainboard, Toolhead, Probe, Expander) with fuzzy search.
- Delete, modify, or reposition components using drag-and-drop interactions.
- Auto-detect and manage USB, UART, and CAN communications with ID detection.

### Configuration Management

- See validation warnings and errors in real-time as you edit to catch mistakes before they cause runtime failures.
- Review a side-by-side diff of your changes before exporting or applying them to your printer.
- Save and apply configuration updates directly, then manually restart Klipper when ready.
- Edit files in Text View with multi-file fuzzy search, per-line error highlighting, and traditional config management.

### Advanced Features

- Create, manage, and simulate macros that reflects your printer configuration.
- Add an AI assistant that references official Klipper documentation, Config Reference excerpts, and your current config with explicit review and approval before applying ([read about it](docs/AI_CHAT.md)).
- Build, download, and flash Katapult and Klipper firmware directly from the UI.

### Graphical UI

<img src="images/Graph_UI.png" width="100%">
<div style="height: 45%;"></div>

#### Side Menu

<img src="images/Side_Menu.png" width="25%">
<div style="height: 25%;"></div>

#### Live Errors

<img src="images/Live_Errors.png" width="25%">
<div style="height: 25%;"></div>

#### Diff Checking

<img src="images/Diff_Menu.png" width="67%">
<div style="height: 67%;"></div>

### Text UI

<img src="images/Text_UI.png" width="45%">
<div style="height: 45%;"></div>

### Macro Designer

<img src="images/Macro_Designer.png" width="65%">
<div style="height: 45%;"></div>

### Firmware Flash Tool

<img src="images/Flash_Tool.png" width="65%">
<div style="height: 45%;"></div>

### AI Chat

<img src="images/AI_Chat.png" width="100%">
<div style="height: 45%;"></div>

## AI Chat

The AI assistant answers Klipper questions and drafts config changes, macros, and printer-memory updates using the bundled Klipper documentation, example configs, and your loaded project files. Nothing the assistant produces touches your config until you review and approve it in the draft preview dialog.

The full [AI Chat guide](docs/AI_CHAT.md) covers configuration, how a request flows from prompt to file edit, the draft-block file-edit protocol, printer memory, and the accuracy test results for the models we've benchmarked.

## Prerequisites

- Raspberry Pi OS or another Debian-based distribution. Must be bookworm or newer.
- Python 3.10+
- Git and internet access for the initial install.
- Klipper
- Katapult (optional)

## Installing/Uninstalling

### Install

On your Raspberry Pi:

```bash
cd ~
git clone https://github.com/SartorialGrunt0/Klipper-Wire-Configurator.git
cd Klipper-Wire-Configurator
bash scripts/install.sh
```

Note: On 32-bit Raspberry Pi OS (`armv7` / `armhf`), the installer automatically uses the distro `nodejs` package. I haven't tried 64-bit, YMMV.
A successful install ends by checking the service health and printing the installer log path under `/tmp/klipper-wire-configurator-install-*.log`.

After install, proceed to http://{your_ip_here}:8099

### Moonraker update_manager

If you want Moonraker to manage updates in Mainsail or Fluidd, add the following section to `moonraker.conf`:

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

### Mainsail sidebar link

If Mainsail is detected on the machine (its `~/mainsail` install or an `[update_manager mainsail]` entry in `moonraker.conf`), the installer adds a **KWC** entry to Mainsail's custom navigation — it writes `navi.json` into the `.theme` folder inside the Klipper config directory (`~/printer_data/config/.theme` on kiauh installs). The link opens `http://<this-host>:8099` in a new tab, positioned below Machine. Fluidd and OctoPrint have no custom-navigation support, so nothing is written for them. Re-running the installer (or `--uninstall`) adds/removes only the KWC entry, leaving any other custom navigation entries untouched.

### Uninstall

If you installed into `~/Klipper-Wire-Configurator`:

```bash
bash ~/Klipper-Wire-Configurator/scripts/install.sh --uninstall
```

## Troubleshooting

### Service checks

```bash
sudo systemctl status klipper-wire-configurator
sudo systemctl restart klipper-wire-configurator
sudo journalctl -u klipper-wire-configurator -f
```

- If the installer fails or the app does not start, review the log path printed at the end of the install. Logs are written under `/tmp/klipper-wire-configurator-install-*.log`.
- Use the exact repo directory name that exists on disk for uninstall commands, Moonraker paths, and manual installer reruns.
- If Moonraker reports `Unit klipper-wire-configurator.service not found`, rerun the installer once from the repo root to migrate older user-service installs.
- If Moonraker reports untracked files under `frontend/public/reference/` that would be overwritten, remove that directory once inside the installed repo and retry the update.
- If the Flash dialog reports that it received HTML instead of JSON, the frontend bundle is newer than the backend service. Rerun the installer or restart the `klipper-wire-configurator` service from the updated repo.

## Development

Use this when you want backend and frontend running in separate terminals.

If you want to install or update a non-`main` branch, either check out that branch first and rerun the installer from that repo, or set `KWC_GIT_REF` explicitly:

```bash
cd ~/Klipper-Wire-Configurator
git checkout your-branch
git pull --ff-only
bash scripts/install.sh
```

```bash
KWC_GIT_REF=your-branch bash scripts/install.sh
```

### Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python main.py
```

### Frontend

From the repository root in a second terminal:

```bash
cd frontend
npm install
npm run dev
```

After startup:

- Frontend: http://localhost:5173
- Backend: http://localhost:8099
