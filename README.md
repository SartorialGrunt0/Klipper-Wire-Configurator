# Klipper Wire Configurator

Klipper Wire Configurator is a web-based tool for inspecting, creating, and editing Klipper `printer.cfg` files with an intuitive graphical interface. It simplifies configuration management by providing visual tools to view connections, add components from the official reference, validate settings in real-time, and apply changes directly to your printer. The software runs locally on your SBC and is completely free and open-source under the GPL3 license.

Special thanks to the Klipper, Mainsail, Moonraker, Fluidd, and other teams whose work was heavily referenced for this project.

## Table of contents

- [Features](#features)
- [AI Chat](#ai-chat)
- [Installing](#installing/uninstalling)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Features

### Visual Tools

- View your printer's hardware as interactive cards and wires—MCUs, steppers, heaters, probes, and more.
- Add any Klipper component directly from the official Config Reference documentation.
- Import example configurations organized by board type (Mainboard, Toolhead, Probe, Expander) with fuzzy search.
- Delete, modify, or reposition components using drag-and-drop interactions.
- Auto-detect and manage USB, UART, and CAN communcations with ID detection.

### Configuration Management

- See validation warnings and errors in real-time as you edit to catch mistakes before they cause runtime failures.
- Review a side-by-side diff of your changes before exporting or applying them to your printer.
- Save and apply configuration updates directly, then manually restart Klipper when ready.
- Edit files in Text View with multi-file fuzzy search, per-line error highlighting, and traditional config management.

### Advanced Features

- Create, manage, and simulate macros that reflects your printer configuration.
- Add an AI assistant that references official Klipper documentation, Config Reference excerpts, and your current config with explicit review and approval before applying.
- Build, download, and flash Katapult adn klipper firmware directly from the UI.

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

### Configuration

Open the chat from the toolbar, then click the settings button to configure:

- **Provider** — OpenAI, Google Gemini, Anthropic, GitHub Copilot, an OpenAI-compatible endpoint (LM Studio, Ollama, etc.), or the local default.
- **API key** — required only for cloud providers; local servers usually don't need one.
- **Model** — any model the provider exposes; the model list is fetched from your endpoint.
- **Max tokens** — cap on the assistant's reply length (default 4096).

Provider settings, conversation history, and attached config files persist locally and are restored when you reopen a saved conversation.

### How a request works, from prompt to file edit

1. **You send a message.** The app builds the request context: your message, recent conversation history, the active config file (plus any files you mention or attach), current printer memory, and targeted instructions for which files to edit.
2. **The backend prepares the prompt.** It adds the assistant's operating rules, the built-in tool list (Klipper docs search, example configs, validation, board detection, macro templates, and more), and a task anchor that keeps the model focused on your latest message even in long conversations.
3. **The model answers with tools.** Cloud providers use native function calling; local servers use a text `tool` block protocol. The backend runs the requested tools (for example, searching the bundled docs or validating a snippet) and feeds the results back to the model, up to five tool rounds. If the model calls no tool, the backend injects a documentation search automatically so answers stay grounded.
4. **The reply is validated.** Config sections and printer-memory proposals are checked; if something is invalid, the assistant is asked to fix it (up to a few attempts) before you ever see it.
5. **Config changes become a reviewable draft.** If the reply contains `cfg` blocks, the app merges them with your current project and shows a per-file preview with every changed, added, or deleted section highlighted.
6. **You review and apply.** Accept the draft to apply the edits to your project; a file the assistant proposes to create appears as a new file. Nothing is written to disk or applied to your printer without your explicit approval.

### How the assistant targets config edits

The assistant communicates file changes as `cfg` code blocks using a simple protocol the app understands:

- `# file: filename.cfg` — the first line of a block names the file the sections belong to; use one block per file.
- `*[section_name]` on its own line — delete that section entirely.
- `#[section_name]` as a header — keep the section but commented out (disabled).
- A `# file:` hint naming a file that does not exist yet — create a new config file.

Only changed, new, or deleted sections are returned — never your whole file unless you ask for it. The app parses, merges, and validates these blocks against your real project, so what you preview is exactly what the merge will produce.

### Printer memory

The assistant sees your printer memory (mainboard, toolhead, expander boards, kinematics, probe, etc.) as context on every request. If it is blank, the assistant investigates your configs and the bundled examples to propose a filled-in profile. Proposals come back as a `printer-memory` code block and are shown in a review dialog — saved only when you confirm.

### Stopping, retrying, and resuming

- **Stop** — while the assistant is processing, the Send button becomes Stop. Pressing it cancels the request immediately.
- **Retry** — if a request fails (timeout, no model loaded), your message stays in the conversation and a Retry button re-sends it with full context.
- **New chat after an interruption** — you can keep the current conversation (messages, provider settings, and attached config files) or start fresh.

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
