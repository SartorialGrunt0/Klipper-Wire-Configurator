#!/usr/bin/env python3
"""
Generate SVG placeholder figures for KWC user manual.
Creates professional wireframe placeholders when real screenshots aren't available.

Run: python3 scripts/generate_figure_placeholders.py
"""

import os
from pathlib import Path

FIGURES_DIR = "reference/manual/figures"

# Figure metadata
FIGURES = [
    # Section 01
    ("01-getting-started.md", 1, "toolbar", "KWC Toolbar Layout", "Show the main toolbar with Import, Open, Export, AI Chat, Flash, Component, Macro, and Text View buttons"),
    ("01-getting-started.md", 2, "graph-layout", "Graph Workspace", "Show Graph View with hardware nodes (mainboard, stepper, heater) connected by edges"),
    ("01-getting-started.md", 3, "text-editor", "Text Editor Interface", "Show Text View with code editor, section TOC panel, and reference viewer"),
    # Section 02
    ("02-graph-ui.md", 1, "graph-layout", "Graph Workspace Layout", "Empty graph workspace showing toolbar, zoom controls, add button, and mini map"),
    ("02-graph-ui.md", 2, "edges", "Communication Edges", "Show different edge types: USB (solid), CAN (dashed), UART (dotted) between hardware nodes"),
    ("02-graph-ui.md", 3, "selection", "Selected Node with Panel", "A hardware node selected with settings panel open on the right showing parameters"),
    ("02-graph-ui.md", 4, "add-menu", "Add Menu", "Dropdown menu showing categories: Motors, Endstops, Heaters, Sensors, etc."),
    ("02-graph-ui.md", 5, "groups", "Grouped Nodes", "Multiple nodes inside a colored group boundary with group header"),
    ("02-graph-ui.md", 6, "settings-panel", "Stepper Settings Panel", "Detailed parameter table for a stepper motor with editable fields"),
    # Section 03
    ("03-text-ui.md", 1, "text-view-button", "Text View Button", "Toolbar highlighting the Text View button among other toolbar buttons"),
    ("03-text-ui.md", 2, "editor-layout", "Three-Panel Editor Layout", "Left: TOC panel, Center: Code editor with syntax highlighting, Right: Reference viewer"),
    ("03-text-ui.md", 3, "toc", "Section Table of Contents", "Hierarchical list of config sections with expand/collapse indicators"),
    ("03-text-ui.md", 4, "reference-viewer", "Klipper Reference Viewer", "Documentation panel showing a Klipper section reference with examples"),
    ("03-text-ui.md", 5, "validation-error", "Validation Error Badge", "Code line with red error badge and tooltip showing error message"),
    ("03-text-ui.md", 6, "search-results", "Cross-File Search", "Search dialog with results list spanning multiple config files"),
    ("03-text-ui.md", 7, "file-tabs", "File Tabs Bar", "Multiple open file tabs with active tab highlighted and close buttons"),
    # Section 04
    ("04-save-diff-export.md", 1, "save-workflow", "Save Workflow Overview", "Modified files indicator and save button with pending changes badge"),
    ("04-save-diff-export.md", 2, "diff-viewer", "Side-by-Side Diff", "Two-pane diff view showing added (green) and removed (red) lines"),
    ("04-save-diff-export.md", 3, "diff-navigation", "Diff Navigation Controls", "Next/Previous change buttons with change counter (e.g., '3/10')"),
    ("04-save-diff-export.md", 4, "export-dialog", "Export Dialog", "File selection checkboxes, format options, and export button"),
    ("04-save-diff-export.md", 5, "save-states", "Save Button States", "Three states: Available (blue), In Progress (spinner), Disabled (gray)"),
    ("04-save-diff-export.md", 6, "status-indicator", "Klipper Status Bar", "Status bar showing Klipper state: Ready/Printing/Error with click indicator"),
    ("04-save-diff-export.md", 7, "revert-dialog", "Revert Confirmation", "Warning dialog with file list and Revert/Cancel buttons"),
    # Section 05
    ("05-macro-designer.md", 1, "designer-open", "Macro Designer Dialog", "Full Macro Designer dialog with macro list, editor, and preview panel"),
    ("05-macro-designer.md", 2, "designer-layout", "Designer Three-Pane Layout", "Left: Macro list, Center: G-code editor, Bottom: Motion preview"),
    ("05-macro-designer.md", 3, "motion-preview", "Motion Simulation", "3D preview with printer outline and motion path lines (green/red)"),
    ("05-macro-designer.md", 4, "no-go-zones", "No-Go Zones Visualization", "Preview area with shaded no-go zones and warning indicators"),
    # Section 06
    ("06-ai-chat.md", 1, "ai-settings", "AI Chat Settings Panel", "Provider dropdown, model selection, API key field, and save button"),
    ("06-ai-chat.md", 2, "attach-files", "File Attachment in Chat", "Chat input with attachment button and selected files list"),
    ("06-ai-chat.md", 3, "draft-preview", "AI Draft Preview Dialog", "Side-by-side diff of suggested changes with Accept/Reject/Edit buttons"),
    # Section 07
    ("07-flash-tool.md", 1, "flash-tool-open", "Flash Tool Dialog", "Flash Tool with device list, Build/Flash tabs, and status indicators"),
    ("07-flash-tool.md", 2, "flash-workflow", "Flash Workflow Steps", "Step-by-step visual with current step highlighted and progress bar"),
    ("07-flash-tool.md", 3, "klipper-config", "Klipper Configuration Tab", "Klipper source path, build options, and profile selection"),
    ("07-flash-tool.md", 4, "kconfig-editor", "Kconfig Editor Interface", "Tree view of build options with checkboxes and search field"),
    ("07-flash-tool.md", 5, "build-output", "Build Console Output", "Console showing build progress, messages, and success/failure"),
    ("07-flash-tool.md", 6, "device-detection", "Detected Devices List", "USB/CAN/UART devices with paths, types, and selection radios"),
    ("07-flash-tool.md", 7, "drag-drop-flash", "Drag-and-Drop Flash Area", "Drop zone with file icon, instructions, and browse button"),
    # Section 08
    ("08-native-mode.md", 1, "config-path", "Config Directory Settings", "Path input field with browse button and alternative paths note"),
    ("08-native-mode.md", 2, "open-from-pi", "Open from Pi Dialog", "File browser showing .cfg files with sizes and timestamps"),
    ("08-native-mode.md", 3, "devices-list", "Native Mode Device List", "USB, CAN, and UART devices with paths and connection types"),
    ("08-native-mode.md", 4, "klipper-status", "Klipper Status Bar", "Status indicator showing Klipper state with error summary"),
    # Section 09
    ("09-firmware-tooling.md", 1, "dual-boot", "Katapult Dual-Boot Setup", "Bootloader selection and dual-boot configuration UI"),
    ("09-firmware-tooling.md", 2, "kconfig-advanced", "Advanced Kconfig Editor", "Custom Kconfig options tree with apply and build buttons"),
]


def generate_svg(title: str, description: str, index: int, total: int) -> str:
    """Generate an SVG placeholder for a figure."""
    
    # Colors
    bg_color = "#f8f9fa"
    border_color = "#dee2e6"
    text_color = "#495057"
    accent_color = "#0d6efd"
    light_accent = "#e7f1ff"
    
    svg = f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
  <!-- Background -->
  <rect width="800" height="600" fill="{bg_color}"/>
  
  <!-- Border -->
  <rect x="20" y="20" width="760" height="560" fill="white" stroke="{border_color}" stroke-width="2" rx="8"/>
  
  <!-- Header -->
  <rect x="40" y="40" width="720" height="60" fill="{light_accent}" rx="4"/>
  <text x="80" y="80" font-family="Arial, sans-serif" font-size="24" font-weight="bold" fill="{accent_color}">
    Figure {index} of {total}
  </text>
  
  <!-- Title -->
  <text x="80" y="130" font-family="Arial, sans-serif" font-size="28" font-weight="bold" fill="{text_color}">
    {title}
  </text>
  
  <!-- Placeholder box -->
  <rect x="100" y="170" width="600" height="300" fill="white" stroke="{border_color}" stroke-width="2" stroke-dasharray="8,4" rx="4"/>
  
  <!-- Placeholder text -->
  <text x="400" y="300" font-family="Arial, sans-serif" font-size="20" text-anchor="middle" fill="#adb5bd">
    [Screenshot Placeholder]
  </text>
  <text x="400" y="340" font-family="Arial, sans-serif" font-size="16" text-anchor="middle" fill="#adb5bd">
    Replace with actual UI capture
  </text>
  
  <!-- Description -->
  <text x="80" y="520" font-family="Arial, sans-serif" font-size="16" fill="{text_color}">
    <tspan x="80" dy="0">What this figure should show:</tspan>
    <tspan x="80" dy="25">{description}</tspan>
  </text>
  
  <!-- Footer -->
  <text x="780" y="580" font-family="Arial, sans-serif" font-size="12" text-anchor="end" fill="#6c757d">
    KWC User Manual
  </text>
</svg>'''
    
    return svg


def main():
    """Generate all figure placeholders."""
    print("=" * 70)
    print("Generating KWC Manual Figure Placeholders")
    print("=" * 70)
    
    # Ensure output directory exists
    os.makedirs(FIGURES_DIR, exist_ok=True)
    
    total_figures = len(FIGURES)
    generated = 0
    
    for i, (section_file, fig_num, description, title, detail) in enumerate(FIGURES, 1):
        filename = f"fig-{fig_num}-{description}.svg"
        output_path = os.path.join(FIGURES_DIR, filename)
        
        # Generate SVG
        svg_content = generate_svg(title, detail, i, total_figures)
        
        # Write file
        with open(output_path, 'w') as f:
            f.write(svg_content)
        
        print(f"✓ Generated: {filename}")
        generated += 1
    
    print("\n" + "=" * 70)
    print(f"Generated {generated} placeholder figures")
    print(f"Saved to: {os.path.abspath(FIGURES_DIR)}")
    print("\nNext steps:")
    print("1. Replace .svg files with real screenshots (.png)")
    print("2. Use the capture guide: reference/manual/SCREENSHOT_CAPTURE_GUIDE.md")
    print("=" * 70)


if __name__ == "__main__":
    main()
