# KWC Manual Screenshot Capture Guide

This document lists all 43 screenshots needed for the embedded user manual.

## Preparation

1. **Start KWC**: Ensure KWC is running
   ```bash
   # If using dev server
   cd ~/Klipper-Wire-Configurator/frontend
   npm run dev
   
   # Or if using production build
   # Access at http://localhost:8099 or your Pi's IP
   ```

2. **Open a sample config**: Have a printer config loaded with:
   - At least one stepper motor
   - One endstop
   - One heater
   - A simple macro (like `PRINT_START`)

3. **Recommended screenshot dimensions**: 
   - Width: 1280px (or your window width)
   - Height: Capture full dialog/panel when open
   - Format: PNG
   - Save to: `reference/manual/figures/`

---

## Section 01: Getting Started (3 figures)

### Figure 1: Toolbar Layout
**File**: `fig-1-toolbar.png`
**When**: KWC home page, no dialog open
**What to show**:
- Full toolbar with all buttons visible
- Graph, Text, Save, Diff, Export buttons
- Status bar at bottom

### Figure 2: Graph Workspace with Hardware Nodes
**File**: `fig-2-graph-layout.png`
**When**: Graph View with a config loaded
**What to show**:
- At least 3 hardware nodes (e.g., mainboard, stepper, heater)
- Connections/edges between nodes
- Node grouping visual

### Figure 3: Text Editor with TOC
**File**: `fig-3-text-editor.png`
**When**: Text View with a multi-file config
**What to show**:
- Code editor with syntax highlighting
- Section TOC panel on left
- Reference viewer panel on right

---

## Section 02: Graph UI (6 figures)

### Figure 1: Graph Workspace Layout
**File**: `fig-1-graph-layout.png`
**When**: Empty graph or with minimal nodes
**What to show**:
- Full workspace area
- Toolbar at top
- Add button visible
- Zoom/pan controls

### Figure 2: Communication Edges
**File**: `fig-2-edges.png`
**When**: Multiple hardware nodes connected
**What to show**:
- Different edge types (USB, CAN, UART)
- Color coding if applicable
- Edge labels

### Figure 3: Selected Node with Settings Panel
**File**: `fig-3-selection.png`
**When**: A node is selected
**What to show**:
- Highlighted/selected node
- Settings panel open on right
- Parameter fields visible

### Figure 4: Add Menu
**File**: `fig-4-add-menu.png`
**When**: Add menu is open
**What to show**:
- Full add menu dropdown
- Categories (Motors, Endstops, Heaters, etc.)
- Search bar in menu

### Figure 5: Grouped Nodes
**File**: `fig-5-groups.png`
**When**: Nodes are grouped
**What to show**:
- Multiple nodes inside a group boundary
- Group label/header
- Collapsed/expanded group state

### Figure 6: Settings Panel for Stepper
**File**: `fig-6-settings.png`
**When**: A stepper node's settings are open
**What to show**:
- Full parameter table
- Editable fields
- Validation badges if any

---

## Section 03: Text UI (7 figures)

### Figure 1: Toolbar with Text View Button
**File**: `fig-1-text-view-button.png`
**When**: Toolbar visible, highlighting Text View button
**What to show**:
- Text View button clearly visible
- Other toolbar buttons for context

### Figure 2: Text Editor with TOC and Reference Viewer
**File**: `fig-2-editor-layout.png`
**When**: Text View fully open with panels
**What to show**:
- Three-panel layout (TOC, Editor, Reference)
- File content with syntax highlighting
- All panels visible

### Figure 3: Section TOC
**File**: `fig-3-toc.png`
**When**: TOC panel is expanded
**What to show**:
- Hierarchical section list
- Current section highlighted
- Expand/collapse indicators

### Figure 4: Reference Viewer
**File**: `fig-4-reference.png`
**When**: Reference viewer shows a section
**What to show**:
- Reference documentation panel
- Klipper section reference
- Example configuration

### Figure 5: Validation Error in Editor
**File**: `fig-5-validation.png`
**When**: Config has validation errors
**What to show**:
- Red error badge or marker
- Error tooltip or inline message
- Affected code line

### Figure 6: Cross-file Search Results
**File**: `fig-6-search.png`
**When**: Search dialog with results
**What to show**:
- Search input field
- Results list across files
- Match highlighting

### Figure 7: File Tabs
**File**: `fig-7-tabs.png`
**When**: Multiple files are open
**What to show**:
- File tab bar
- Multiple tabs visible
- Active tab highlighted
- Close buttons on tabs

---

## Section 04: Save, Diff, Export (7 figures)

### Figure 1: Save Workflow Overview
**File**: `fig-1-workflow.png`
**When**: After making changes, before saving
**What to show**:
- Modified files indicator
- Save button state
- Any pending changes badge

### Figure 2: Diff Viewer with Side-by-Side Comparison
**File**: `fig-2-diff-viewer.png`
**When**: Diff viewer is open
**What to show**:
- Two-pane comparison view
- Added lines (green)
- Removed lines (red)
- Unchanged lines (gray)

### Figure 3: Diff Navigation Buttons
**File**: `fig-3-navigation.png`
**When**: Diff viewer with navigation visible
**What to show**:
- Next/Previous change buttons
- Change counter (e.g., "3/10")
- Full diff toggle

### Figure 4: Export Dialog
**File**: `fig-4-export-dialog.png`
**When**: Export dialog is open
**What to show**:
- File selection checkboxes
- Export format options
- Export button
- Destination path

### Figure 5: Save Button States
**File**: `fig-5-save-states.png`
**When**: Show different save states
**What to show**:
- Consider capturing 3 states:
  1. Save available (blue button)
  2. Save in progress (spinner)
  3. Save disabled (gray)

### Figure 6: Klipper Status Indicator
**File**: `fig-6-status.png`
**When**: Status bar with Klipper state
**What to show**:
- Klipper status (Ready/Printing/Error)
- Click to expand indicator
- Recent errors if any

### Figure 7: Revert Dialog
**File**: `fig-7-revert.png`
**When**: Revert confirmation dialog
**What to show**:
- Warning message
- File list to revert
- Revert/Cancel buttons

---

## Section 05: Macro Designer (4 figures)

### Figure 1: Macro Designer Dialog
**File**: `fig-1-designer-open.png`
**When**: Macro Designer first opens
**What to show**:
- Full dialog window
- Macro list on left
- Editor in center
- Preview at bottom

### Figure 2: Designer Layout
**File**: `fig-2-layout.png`
**When**: Macro with content loaded
**What to show**:
- All three panes visible
- Macro list with entries
- Editor with G-code
- Preview panel

### Figure 3: Motion Preview
**File**: `fig-3-motion-preview.png`
**When**: Motion simulation is running
**What to show**:
- 3D preview area
- Printer outline
- Motion path (green/red lines)
- Position indicators

### Figure 4: No-Go Zones
**File**: `fig-4-no-go-zones.png`
**When**: No-go zones are configured
**What to show**:
- Preview with shaded zones
- Warning indicators
- Zone boundaries

---

## Section 06: AI Chat (3 figures)

### Figure 1: AI Chat Settings
**File**: `fig-1-settings.png`
**When**: AI Chat settings panel is open
**What to show**:
- Provider dropdown
- Model selection
- API key field
- Save button

### Figure 2: Attaching Config Files
**File**: `fig-2-attach-config.png`
**When**: File attachment in chat
**What to show**:
- Chat input area
- Attachment button
- Selected files list
- File icons

### Figure 3: Draft Preview Dialog
**File**: `fig-3-draft-preview.png`
**When**: AI suggests changes
**What to show**:
- Draft preview panel
- Diff highlighting
- Accept/Reject/Edit buttons
- Side-by-side view

---

## Section 07: Flash Tool (7 figures)

### Figure 1: Flash Tool Dialog
**File**: `fig-1-flash-open.png`
**When**: Flash Tool first opens
**What to show**:
- Full dialog
- Device list
- Build/Flash tabs
- Status indicators

### Figure 2: Flash Workflow
**File**: `fig-2-workflow.png`
**When**: Showing workflow steps
**What to show**:
- Step-by-step visual
- Current step highlighted
- Progress indicator

### Figure 3: Klipper Configuration
**File**: `fig-3-klipper-config.png`
**When**: Klipper config tab
**What to show**:
- Klipper source path
- Build options
- Profile selection

### Figure 4: Kconfig Editor
**File**: `fig-4-kconfig.png`
**When**: Kconfig editor is open
**What to show**:
- Tree view of options
- Checkboxes for features
- Search/filter field

### Figure 5: Build Output
**File**: `fig-5-build-output.png`
**When**: Build is in progress or complete
**What to show**:
- Console output
- Progress bar
- Success/error message
- Firmware path

### Figure 6: Flash Device Detection
**File**: `fig-6-detection.png`
**When**: Devices are detected
**What to show**:
- Device list with paths
- Board types detected
- Select radio buttons
- Connection type icons

### Figure 7: Drag-and-Drop Flash
**File**: `fig-7-drag-drop.png`
**When**: Drag-drop area is visible
**What to show**:
- Drop zone
- File icon
- Instructions text
- Browse button

---

## Section 08: Native Mode (4 figures)

### Figure 1: Config Path Settings
**File**: `fig-1-config-path.png`
**When**: Settings → Config Directory
**What to show**:
- Path input field
- Current path
- Browse button
- Alternative paths note

### Figure 2: Open from Pi Dialog
**File**: `fig-2-open-dialog.png`
**When**: "Open from Pi" dialog
**What to show**:
- File list
- File sizes/timestamps
- Multi-select capability
- Open button

### Figure 3: Device List
**File**: `fig-3-devices.png`
**When**: Devices tab in Native Mode
**What to show**:
- USB devices
- CAN devices
- UART devices
- Device paths and IDs

### Figure 4: Klipper Status Bar
**File**: `fig-4-status.png`
**When**: Status bar with Klipper info
**What to show**:
- Klipper state (Ready/Printing/Error)
- Click for details indicator
- Recent errors summary

---

## Section 09: Firmware Tooling (2 figures)

### Figure 1: Dual-Boot Setup
**File**: `fig-1-dual-boot.png`
**When**: Showing Katapult dual-boot
**What to show**:
- Bootloader selection
- Dual-boot configuration
- Firmware paths

### Figure 2: Kconfig Editor
**File**: `fig-2-kconfig-editor.png`
**When**: Advanced Kconfig editing
**What to show**:
- Custom options
- Kconfig tree
- Apply/Build buttons

---

## Capture Tips

### Best Practices
1. **Clean UI**: Close unnecessary tabs/windows
2. **Consistent theme**: Use light or dark mode consistently
3. **No personal data**: Remove API keys, private paths
4. **High contrast**: Ensure text is readable
5. **Full context**: Show enough UI to understand the feature

### What to Avoid
- ❌ Screenshot notifications or system bars
- ❌ Personal config values (use placeholders)
- ❌ Blurry or zoomed-in shots
- ❌ Incomplete dialogs (cut-off buttons)

### File Naming
Format: `fig-{number}-{short-description}.png`
- Use lowercase
- Hyphens for spaces
- Short but descriptive (2-4 words)

### Quality Checklist
- [ ] Image is clear and readable
- [ ] All relevant UI elements visible
- [ ] No sensitive information
- [ ] Correct file naming
- [ ] Saved in `reference/manual/figures/`

---

## Post-Capture

After capturing all screenshots:

1. **Verify** each figure against its placeholder in the markdown
2. **Check** file sizes (should be reasonable, < 500KB each)
3. **Test** that markdown links work:
   ```bash
   cd reference/manual
   grep "fig-" *.md | wc -l  # Should show 43 references
   ```
4. **Update** any figure captions if needed

---

## Automation Notes

For automated capture using Camofox, see:
- `scripts/capture_manual_screenshots.py` (placeholder)
- Camofox skill documentation

Given the complexity of UI state automation, manual capture is recommended for first pass.

---

*Last updated: 2026-08-22*
*Total figures: 43*
*Sections covered: 9 (Section 10 has no figures)*
