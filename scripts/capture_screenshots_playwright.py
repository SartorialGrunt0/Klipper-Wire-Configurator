#!/usr/bin/env python3
"""
Capture screenshots for KWC user manual using Playwright directly.
Bypasses Camofox server issues by using Playwright headless browser directly.

Run: python3 scripts/capture_screenshots_playwright.py
"""

import asyncio
import os
import sys
from pathlib import Path

# Check if playwright is available
try:
    from playwright.async_api import async_playwright
except ImportError:
    print("ERROR: Playwright not installed. Install with: pip install playwright")
    print("Then run: playwright install firefox")
    sys.exit(1)

# Configuration
KWC_URL = "http://localhost:8099"
FIGURES_DIR = "reference/manual/figures"

# Figure definitions
FIGURES = [
    # Section 01
    ("01-getting-started.md", 1, "toolbar", "Home page"),
    ("01-getting-started.md", 2, "graph-layout", "Graph View"),
    ("01-getting-started.md", 3, "text-editor", "Text View"),
    # Section 02
    ("02-graph-ui.md", 1, "graph-layout", "Graph workspace"),
    ("02-graph-ui.md", 2, "edges", "Communication edges"),
    ("02-graph-ui.md", 3, "selection", "Selected node"),
    ("02-graph-ui.md", 4, "add-menu", "Add menu"),
    ("02-graph-ui.md", 5, "groups", "Grouped nodes"),
    ("02-graph-ui.md", 6, "settings-panel", "Stepper settings"),
    # Section 03
    ("03-text-ui.md", 1, "text-view-button", "Text view button"),
    ("03-text-ui.md", 2, "editor-layout", "Editor layout"),
    ("03-text-ui.md", 3, "toc", "Section TOC"),
    ("03-text-ui.md", 4, "reference-viewer", "Reference viewer"),
    ("03-text-ui.md", 5, "validation-error", "Validation error"),
    ("03-text-ui.md", 6, "search", "Cross-file search"),
    ("03-text-ui.md", 7, "tabs", "File tabs"),
    # Section 04
    ("04-save-diff-export.md", 1, "workflow", "Save workflow"),
    ("04-save-diff-export.md", 2, "diff-viewer", "Diff viewer"),
    ("04-save-diff-export.md", 3, "navigation", "Diff navigation"),
    ("04-save-diff-export.md", 4, "export-dialog", "Export dialog"),
    ("04-save-diff-export.md", 5, "save-states", "Save button states"),
    ("04-save-diff-export.md", 6, "status-indicator", "Status indicator"),
    ("04-save-diff-export.md", 7, "revert-dialog", "Revert dialog"),
    # Section 05
    ("05-macro-designer.md", 1, "designer-open", "Macro Designer open"),
    ("05-macro-designer.md", 2, "layout", "Designer layout"),
    ("05-macro-designer.md", 3, "motion-preview", "Motion preview"),
    ("05-macro-designer.md", 4, "no-go-zones", "No-go zones"),
    # Section 06
    ("06-ai-chat.md", 1, "settings", "AI Chat settings"),
    ("06-ai-chat.md", 2, "attach-config", "Attach config"),
    ("06-ai-chat.md", 3, "draft-preview", "Draft preview"),
    # Section 07
    ("07-flash-tool.md", 1, "flash-open", "Flash Tool open"),
    ("07-flash-tool.md", 2, "workflow", "Flash workflow"),
    ("07-flash-tool.md", 3, "klipper-config", "Klipper config"),
    ("07-flash-tool.md", 4, "kconfig", "Kconfig editor"),
    ("07-flash-tool.md", 5, "build-output", "Build output"),
    ("07-flash-tool.md", 6, "detection", "Device detection"),
    ("07-flash-tool.md", 7, "drag-drop", "Drag-drop flash"),
    # Section 08
    ("08-native-mode.md", 1, "config-path", "Config path settings"),
    ("08-native-mode.md", 2, "open-dialog", "Open from Pi"),
    ("08-native-mode.md", 3, "devices", "Device list"),
    ("08-native-mode.md", 4, "status-bar", "Status bar"),
    # Section 09
    ("09-firmware-tooling.md", 1, "dual-boot", "Dual-boot setup"),
    ("09-firmware-tooling.md", 2, "kconfig-editor", "Kconfig editor"),
]


async def capture_screenshot(page, filename: str, wait_for: str = "body"):
    """Capture a screenshot of the current page."""
    try:
        # Wait for element to ensure page is loaded
        if wait_for:
            await page.wait_for_selector(wait_for, timeout=5000)
        
        # Wait a bit more for React to settle
        await asyncio.sleep(1)
        
        # Capture screenshot
        path = os.path.join(FIGURES_DIR, filename)
        await page.screenshot(path=path, full_page=False, type="png", quality=90)
        
        size = os.path.getsize(path)
        print(f"✓ Saved: {filename} ({size:,} bytes)")
        return True
    except Exception as e:
        print(f"✗ Failed to capture {filename}: {e}")
        return False


async def main():
    """Main screenshot capture routine."""
    print("=" * 70)
    print("KWC Manual Screenshot Capture (Playwright)")
    print("=" * 70)
    
    # Ensure output directory exists
    os.makedirs(FIGURES_DIR, exist_ok=True)
    
    # Check if KWC is running
    print("\nChecking KWC availability...")
    import urllib.request
    try:
        with urllib.request.urlopen(KWC_URL, timeout=5):
            print(f"✓ KWC is running at {KWC_URL}")
    except Exception as e:
        print(f"✗ Cannot reach KWC at {KWC_URL}: {e}")
        print("  Make sure KWC dev server is running: cd frontend && npm run dev")
        sys.exit(1)
    
    # Launch browser
    print("\nLaunching headless browser...")
    async with async_playwright() as p:
        browser = await p.firefox.launch(headless=True)
        context = await browser.new_context(
            viewport={"width": 1280, "height": 800}
        )
        page = await context.new_page()
        
        print("Browser ready. Starting capture...")
        print("-" * 70)
        
        captured = 0
        failed = 0
        
        for section_file, fig_num, description, action in FIGURES:
            fig_name = f"fig-{fig_num}-{description}.png"
            
            # Skip if already exists
            output_path = os.path.join(FIGURES_DIR, fig_name)
            if os.path.exists(output_path):
                print(f"⊘ Skipped: {fig_name} (exists)")
                captured += 1
                continue
            
            print(f"\n📸 {section_file} Figure {fig_num}: {description}")
            print(f"   Action: {action}")
            
            # Navigate to KWC
            try:
                await page.goto(KWC_URL, wait_until="networkidle", timeout=30000)
                print(f"   ✓ Navigated to {KWC_URL}")
            except Exception as e:
                print(f"   ✗ Navigation failed: {e}")
                failed += 1
                continue
            
            # For now, just capture the home page
            # In a real implementation, we'd perform specific actions for each figure
            if await capture_screenshot(page, fig_name):
                captured += 1
            else:
                failed += 1
        
        print("\n" + "=" * 70)
        print(f"Complete: {captured} captured, {failed} failed")
        print(f"Figures saved to: {os.path.abspath(FIGURES_DIR)}")
        print("=" * 70)
        
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
