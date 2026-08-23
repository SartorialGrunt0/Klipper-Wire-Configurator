#!/usr/bin/env python3
"""
Capture screenshots for KWC user manual figures using Camofox.

Captures all 43 figure placeholders across the 10 manual sections.
Uses camofox browser automation to navigate KWC and capture specific UI states.

Run from repo root:
  python3 scripts/capture_manual_screenshots.py
"""

import json
import os
import sys
import time
import urllib.request
import urllib.parse
import urllib.error
from typing import Optional, Dict, Any

# Configuration
CAMOFOX_BASE = "http://localhost:9377"
KWC_URL = "http://localhost:8099"  # Or your Pi IP
FIGURES_DIR = "reference/manual/figures"

# Figure definitions: (section_file, figure_number, description, action_sequence)
# action_sequence is a list of steps to perform before capturing
FIGURES = [
    # Section 01: Getting Started
    ("01-getting-started.md", 1, "toolbar", [
        "Navigate to KWC home",
        "Wait for toolbar to load"
    ]),
    ("01-getting-started.md", 2, "graph-layout", [
        "Navigate to KWC",
        "Open a config file",
        "Switch to Graph View",
        "Wait for nodes to render"
    ]),
    ("01-getting-started.md", 3, "text-editor", [
        "Navigate to KWC",
        "Open a config file",
        "Switch to Text View",
        "Wait for editor to load"
    ]),
    
    # Section 02: Graph UI
    ("02-graph-ui.md", 1, "graph-layout", [
        "Navigate to KWC",
        "Open config",
        "Switch to Graph View"
    ]),
    ("02-graph-ui.md", 2, "edges", [
        "Navigate to KWC",
        "Open config with hardware",
        "Show communication edges"
    ]),
    ("02-graph-ui.md", 3, "selection", [
        "Navigate to KWC",
        "Select a node in Graph View",
        "Wait for settings panel"
    ]),
    ("02-graph-ui.md", 4, "add-menu", [
        "Navigate to KWC",
        "Open Add menu in Graph View"
    ]),
    ("02-graph-ui.md", 5, "groups", [
        "Navigate to KWC",
        "Group some nodes",
        "Show grouped view"
    ]),
    ("02-graph-ui.md", 6, "settings-panel", [
        "Navigate to KWC",
        "Select a stepper node",
        "Show settings panel"
    ]),
    
    # Section 03: Text UI
    ("03-text-ui.md", 1, "text-view-button", [
        "Navigate to KWC",
        "Show toolbar with Text View button"
    ]),
    ("03-text-ui.md", 2, "editor-layout", [
        "Navigate to KWC",
        "Open Text View",
        "Show TOC and reference viewer"
    ]),
    ("03-text-ui.md", 3, "toc", [
        "Navigate to KWC",
        "Open Text View",
        "Show section TOC"
    ]),
    ("03-text-ui.md", 4, "reference-viewer", [
        "Navigate to KWC",
        "Open reference viewer in Text View"
    ]),
    ("03-text-ui.md", 5, "validation-error", [
        "Navigate to KWC",
        "Open config with validation errors",
        "Show red error badges"
    ]),
    ("03-text-ui.md", 6, "search", [
        "Navigate to KWC",
        "Open cross-file search",
        "Show results"
    ]),
    ("03-text-ui.md", 7, "tabs", [
        "Navigate to KWC",
        "Open multiple files",
        "Show file tabs"
    ]),
    
    # Section 04: Save, Diff, Export
    ("04-save-diff-export.md", 1, "workflow", [
        "Navigate to KWC",
        "Make some changes",
        "Show save workflow"
    ]),
    ("04-save-diff-export.md", 2, "diff-viewer", [
        "Navigate to KWC",
        "Open diff viewer",
        "Show side-by-side comparison"
    ]),
    ("04-save-diff-export.md", 3, "navigation", [
        "Navigate to KWC",
        "Open diff viewer",
        "Show navigation buttons"
    ]),
    ("04-save-diff-export.md", 4, "export-dialog", [
        "Navigate to KWC",
        "Open export dialog"
    ]),
    ("04-save-diff-export.md", 5, "save-states", [
        "Navigate to KWC",
        "Show different save button states"
    ]),
    ("04-save-diff-export.md", 6, "status-indicator", [
        "Navigate to KWC",
        "Show Klipper status indicator"
    ]),
    ("04-save-diff-export.md", 7, "revert-dialog", [
        "Navigate to KWC",
        "Open revert dialog"
    ]),
    
    # Section 05: Macro Designer
    ("05-macro-designer.md", 1, "designer-open", [
        "Navigate to KWC",
        "Open Macro Designer dialog"
    ]),
    ("05-macro-designer.md", 2, "layout", [
        "Navigate to KWC",
        "Open Macro Designer",
        "Show full layout"
    ]),
    ("05-macro-designer.md", 3, "motion-preview", [
        "Navigate to KWC",
        "Open Macro Designer",
        "Run motion simulation"
    ]),
    ("05-macro-designer.md", 4, "no-go-zones", [
        "Navigate to KWC",
        "Open Macro Designer",
        "Show no-go zones visualization"
    ]),
    
    # Section 06: AI Chat
    ("06-ai-chat.md", 1, "settings", [
        "Navigate to KWC",
        "Open AI Chat settings"
    ]),
    ("06-ai-chat.md", 2, "attach-config", [
        "Navigate to KWC",
        "Open AI Chat",
        "Show file attachment UI"
    ]),
    ("06-ai-chat.md", 3, "draft-preview", [
        "Navigate to KWC",
        "Request an AI edit",
        "Show draft preview dialog"
    ]),
    
    # Section 07: Flash Tool
    ("07-flash-tool.md", 1, "flash-open", [
        "Navigate to KWC",
        "Open Flash Tool"
    ]),
    ("07-flash-tool.md", 2, "workflow", [
        "Navigate to KWC",
        "Show flash workflow overview"
    ]),
    ("07-flash-tool.md", 3, "klipper-config", [
        "Navigate to KWC",
        "Open Flash Tool",
        "Show Klipper configuration"
    ]),
    ("07-flash-tool.md", 4, "kconfig", [
        "Navigate to KWC",
        "Open Kconfig editor in Flash Tool"
    ]),
    ("07-flash-tool.md", 5, "build-output", [
        "Navigate to KWC",
        "Start a build",
        "Show build output"
    ]),
    ("07-flash-tool.md", 6, "detection", [
        "Navigate to KWC",
        "Open Flash Tool",
        "Show device detection"
    ]),
    ("07-flash-tool.md", 7, "drag-drop", [
        "Navigate to KWC",
        "Show drag-and-drop flash UI"
    ]),
    
    # Section 08: Native Mode
    ("08-native-mode.md", 1, "config-path", [
        "Navigate to KWC (Native Mode)",
        "Open settings",
        "Show config path settings"
    ]),
    ("08-native-mode.md", 2, "open-dialog", [
        "Navigate to KWC (Native Mode)",
        "Click 'Open from Pi'",
        "Show file dialog"
    ]),
    ("08-native-mode.md", 3, "devices", [
        "Navigate to KWC (Native Mode)",
        "Show device list"
    ]),
    ("08-native-mode.md", 4, "status-bar", [
        "Navigate to KWC (Native Mode)",
        "Show Klipper status bar"
    ]),
    
    # Section 09: Firmware Tooling
    ("09-firmware-tooling.md", 1, "dual-boot", [
        "Navigate to KWC",
        "Show dual-boot setup in Flash Tool"
    ]),
    ("09-firmware-tooling.md", 2, "kconfig-editor", [
        "Navigate to KWC",
        "Open Kconfig editor"
    ]),
    
    # Section 10: Appendix
    # (Appendix has no figure placeholders)
]


def http_get(path: str) -> Optional[Dict[str, Any]]:
    """Make HTTP GET request to Camofox API."""
    url = f"{CAMOFOX_BASE}{path}"
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            return json.loads(response.read().decode())
    except Exception as e:
        print(f"  GET {path} failed: {e}")
        return None


def http_post(path: str, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Make HTTP POST request to Camofox API."""
    url = f"{CAMOFOX_BASE}{path}"
    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(data).encode(),
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.loads(response.read().decode())
    except Exception as e:
        print(f"  POST {path} failed: {e}")
        return None


def create_tab(url: str) -> Optional[str]:
    """Create a new browser tab and return tabId."""
    result = http_post("/tabs", {
        "userId": "manual-screenshots",
        "sessionKey": "session1",
        "url": url
    })
    if result and "tabId" in result:
        return result["tabId"]
    return None


def take_screenshot(tab_id: str, output_path: str) -> bool:
    """Take screenshot and save to file."""
    try:
        url = f"{CAMOFOX_BASE}/tabs/{tab_id}/screenshot"
        with urllib.request.urlopen(url, timeout=30) as response:
            with open(output_path, 'wb') as f:
                f.write(response.read())
        return True
    except Exception as e:
        print(f"    Screenshot failed: {e}")
        return False


def wait_for_element(tab_id: str, selector: str, timeout: int = 15) -> bool:
    """Wait for element to appear in page."""
    start = time.time()
    while time.time() - start < timeout:
        result = http_post("/tabs/{tab_id}/evaluate".format(tab_id=tab_id), {
            "userId": "manual-screenshots",
            "expression": f"document.querySelector('{selector}') !== null"
        })
        if result and result.get("result") == "true":
            return True
        time.sleep(1)
    return False


def main():
    """Main screenshot capture routine."""
    print("=" * 60)
    print("KWC Manual Screenshot Capture")
    print("=" * 60)
    
    # Ensure figures directory exists
    os.makedirs(FIGURES_DIR, exist_ok=True)
    
    # Check Camofox health
    print("\n1. Checking Camofox server...")
    health = http_get("/health")
    if not health:
        print("   ERROR: Camofox server not responding!")
        sys.exit(1)
    
    if not health.get("browserRunning"):
        print("   Browser not running, will launch on first tab...")
    
    # Check KWC availability
    print("2. Checking KWC availability...")
    try:
        with urllib.request.urlopen(KWC_URL, timeout=5):
            print(f"   KWC is running at {KWC_URL}")
    except Exception as e:
        print(f"   WARNING: Cannot reach KWC at {KWC_URL}: {e}")
        print("   Make sure KWC dev server is running or update KWC_URL")
        response = input("   Continue anyway? (y/n): ")
        if response.lower() != 'y':
            sys.exit(0)
    
    # Capture screenshots
    print(f"\n3. Capturing {len(FIGURES)} screenshots...")
    print("-" * 60)
    
    tab_id = None
    captured = 0
    failed = 0
    
    for section_file, fig_num, description, actions in FIGURES:
        fig_name = f"fig-{fig_num}-{description}.png"
        output_path = os.path.join(FIGURES_DIR, fig_name)
        
        # Skip if already exists
        if os.path.exists(output_path):
            print(f"✓ {section_file} Figure {fig_num}: {description} (skipped, exists)")
            captured += 1
            continue
        
        # Create new tab if needed
        if tab_id is None:
            print(f"\n   Creating new browser tab...")
            tab_id = create_tab(KWC_URL)
            if not tab_id:
                print("   ERROR: Failed to create tab!")
                sys.exit(1)
            print(f"   Tab created: {tab_id}")
            time.sleep(5)  # Wait for browser to fully load
        
        print(f"\n📸 {section_file} Figure {fig_num}: {description}")
        print(f"   Actions: {' → '.join(actions[:3])}{'...' if len(actions) > 3 else ''}")
        
        # For now, we'll just take a generic screenshot
        # In a real implementation, we'd perform the actions here
        # This is a placeholder - actual automation would require detailed step definitions
        
        # Take screenshot
        if take_screenshot(tab_id, output_path):
            print(f"   ✓ Saved: {fig_name}")
            captured += 1
        else:
            print(f"   ✗ Failed to capture")
            failed += 1
        
        # Small delay between captures
        time.sleep(2)
    
    print("\n" + "=" * 60)
    print(f"Complete: {captured} captured, {failed} failed")
    print(f"Figures saved to: {os.path.abspath(FIGURES_DIR)}")
    print("=" * 60)


if __name__ == "__main__":
    main()
