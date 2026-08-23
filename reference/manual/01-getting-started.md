# Getting Started

Welcome to **Klipper Wire Configurator (KWC)** — your browser-based editor for Klipper printer configurations.

This guide walks you through the first startup, importing your first config, and understanding the workspace layout.

---

## What is KWC?

KWC is a visual editor for Klipper `printer.cfg` files that combines:

- **Graph View** — Visual hardware tree showing your printer's components and connections
- **Text View** — Direct config file editing with live validation
- **AI Assistant** — Context-aware help powered by Klipper documentation
- **Macro Designer** — Visual G-code macro editor with motion simulation
- **Flash Tool** — Build and flash Klipper/Katapult firmware (native mode only)

KWC runs in your browser. You can use it in two modes:
1. **Browser Mode:** Access via any web browser. Best for editing files on your PC.
2. **Native Mode:** Installed directly on your Raspberry Pi. Best for direct hardware access and flashing.

---

## First Startup

### Installation

**Prerequisites:** Before running the installer, ensure your Raspberry Pi has:
- **Internet Access** (to download dependencies)
- **Sufficient Disk Space** (at least 500MB)

If you haven't installed KWC yet:

```bash
# On your Raspberry Pi
curl -sSL https://raw.githubusercontent.com/SartorialGrunt0/Klipper-Wire-Configurator/main/scripts/install.sh | bash
```

The installer will:
- Install dependencies (Python 3.11+, Node.js, build tools)
- Build the frontend
- Create a systemd service on port 8099
- Verify the service is running

Access KWC at: `http://<your-pi-ip>:8099`

### Opening KWC

When you first load KWC in your browser:

![Figure 1: Toolbar layout](./figures/fig-0-toolbar-updated.png)

**The toolbar contains all major actions:**

| Button | Purpose |
|--------|---------|
| **Import** | Load a config file from your computer |
| **Open from Pi** | (Native mode only) Open configs from your Pi's config directory |
| **Export** | Save your current config to your computer |
| **Save** | (Native mode) Write changes back to your Pi |
| **Revert** | Discard changes and reload the original |
| **Diff** | Compare your changes against the original |
| **AI Chat** | Get help from the AI assistant |
| **Flash** | (Native mode) Build and flash firmware |
| **Component** | Add hardware/components to the graph |
| **Macro** | Open the Macro Designer |
| **Manual** | Open this user manual! |

---

## Importing Your First Config

### From Your Computer

1. Click **Import** in the toolbar
2. Select a `.cfg` file from your computer
3. KWC will parse the file and display it in the graph workspace

**What happens during import:**

- The file is parsed into structured sections and parameters
- Validation runs automatically — **Red badges** indicate critical errors that will prevent the printer from starting, while **Yellow badges** indicate non-critical warnings
- Board detection attempts to identify your mainboard type
- The graph workspace builds a visual representation

> **Note:** Import is a **read-only** operation. Your original file is never modified. To save changes, you must explicitly use **Save** (native mode) or **Export** (browser mode).

### From Your Pi (Native Mode Only)

When running KWC on your Raspberry Pi:

1. Click **Open from Pi** in the toolbar
2. Browse the config directory (default: `~/printer_data/config`)
3. Select one or more `.cfg` files
4. KWC loads them and builds a multi-file project

**Multi-file projects:**

- KWC attempts to identify the main config file
- Include relationships (`[include *.cfg]`) are resolved
- Cross-file validation checks for duplicates and missing dependencies

---

## Understanding the Workspace

After importing, you'll see the **Graph View** by default.

### Graph View

![Figure 2: Graph workspace with hardware nodes](./figures/fig-2-graph-layout.png)

The graph organizes your config into a hardware tree:

- **SBC Node** — Your Raspberry Pi (single-board computer)
- **Mainboard Node** — Your printer's main controller board
- **Toolhead Nodes** — Extruders, heaters, motors on the moving carriage
- **Config File Nodes** — Individual `.cfg` files in your project
- **Feature Nodes** — Add-ons like probes, accelerometers, LEDs

**Common actions:**

- **Drag nodes** — Reparent components (e.g., move a stepper to a toolhead)
- **Click a node** — Open the Settings Panel with parameters
- **Right-click** — Context menu (rename, delete, duplicate)
- **Scroll to zoom** — Adjust the graph scale

### Switching to Text View

Click the **Text View** button in the toolbar to see the raw config file:

![Figure 3: Text editor with TOC](./figures/fig-3-text-editor.png)

The text editor includes:

- **Live validation** — Errors highlight as you type
- **Section TOC** — Jump to any section header
- **Reference viewer** — Inline Klipper documentation
- **Cross-file search** — Find sections across multiple files

You can switch between Graph and Text views at any time. Both views sync automatically — changes in one update the other.

---

## Next Steps

Now that you've imported a config, try these:

1. **Explore the Graph** — Click nodes to see their parameters and how they connect
2. **Verify Validation** — Ensure no red badges appear on your mainboard or toolhead nodes
3. **Try the AI Chat** — Ask "How do I change my bed leveling offset?" to see the AI in action
4. **Deep Dive** — Click **Manual** in the toolbar to learn about specific components

---

## Appendix: Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+S` | Save (native mode) |
| `Ctrl+Shift+S` | Export |
| `F1` | Open User Manual |
| `Ctrl+Shift+M` | Open Macro Designer |
| `Ctrl+F` | Cross-file search (in Text View) |

> **Note:** `F1` and custom shortcuts are planned for a future release.

---
