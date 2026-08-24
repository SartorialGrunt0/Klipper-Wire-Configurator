# Text UI

The **Text View** gives you direct access to the raw Klipper configuration files. Use this when you prefer editing plain text, need fine-grained control, or want to see the exact output.

---

## Opening Text View

![Figure 1: Toolbar with Text View button](./figures/fig-1-text-view-button.svg)

**Click the "Text View"** button in the toolbar (next to "Graph View").

When activated:
- The graph disappears
- A text editor opens with your config file
- The toolbar remains accessible

---

## Editor Layout

![Figure 2: Text editor with TOC and reference viewer](./figures/fig-3-text-editor.png)

The editor consists of three main areas:

### Files Sidebar (Left)

![Figure 3: File list sidebar](./figures/fig-3-toc.svg)

- **File list** — Every `.cfg` file in the project as a row, with red/yellow dots for validation errors/warnings
- **Add Configuration** (+ button) — Create a new file: **Blank config** (name it) or **From Reference** (search example configs)
- **Collapse** — Hide the sidebar to give the editor more room

### Main Editor Pane (Center)

- **Live text editing** — Type directly into the editor
- **Line numbers** — Shown on the left
- **Validation markers** — Errors and warnings underlined
- **Editor toolbar** — Search all files, Configuration Reference, and other editor actions

### Sections Sidebar (Right)

The section table of contents shows all sections in the currently open file:

- **Click a section** — Jump to that section in the editor
- **Active section** — Highlighted as you scroll
- **Validation status** — Sections with errors show a red dot, warnings a yellow dot
- **Collapse** — Hide the sidebar to give the editor more room

### Configuration Reference (Dialog)

![Figure 4: Configuration Reference dialog](./figures/fig-4-reference.svg)

The reference viewer is a **modal dialog** opened from the editor toolbar's **Configuration Reference** button — it is not a sidebar. It searches the bundled Klipper documentation (no internet required):

1. Open the dialog from the editor toolbar
2. Search for a section or keyword (e.g., `bed_mesh`, `stepper_x`)
3. Read the matching documentation and copy example parameters

---

## Editing Config Text

### Basic Editing

**Add a section:**
```
[gcode_macro MY_MACRO]
gcode:
    M117 Hello!
```

**Add a parameter:**
```
[stepper_x]
step_pin: PB0
dir_pin: PB1
enable_pin: !PB2
rotation_distance: 40  # Primary parameter for stepper movement
microsteps: 16          # Number of microsteps per full step
```

**Edit a value:**
- Click the value
- Type the new value
- Validation runs immediately

### Live Sync

Changes in Text View automatically sync to Graph View. The editor debounces input at 800ms, then parses your text and updates the graph model. If parsing fails, the editor **holds the last-good model**, shows a banner, and **Save/Apply are blocked until the parse error is fixed**. This means you can edit freely in Text View and always see a valid result in the graph.

### Keyboard Shortcuts

There are no keyboard shortcuts in the editor itself. `Escape` closes the search panel, and `Enter` confirms dialogs.

### Validation Feedback

![Figure 5: Validation error in editor](./figures/fig-5-validation.svg)

**Errors** appear as red underlines:
- **Hover** — See the error message

**Warnings** appear as yellow underlines:
- **Hover** — See the warning message
- **May still work** but not recommended

**Example:**
```
[temperature_sensor my_sensor]
microcontroller: wrong_value  # ← Red underline: "Invalid MCU name"
```

**Live validation** runs as you type, updating markers instantly.

### Search All Files

![Figure 6: Cross-file search results](./figures/fig-6-search.svg)

**When working with multi-file projects:**

1. **Click Search** in the editor toolbar — opens the "Search all files…" panel
2. **Enter your search term** (section name, parameter, value)
3. **Results show** matches across all project files
4. **Click a result** — Opens that file at the matching location

Press `Escape` to close the search panel.

**Example searches:**
- `probe` — Find all probe-related sections
- `step_pin` — Find all pin assignments
- `G28` — Find all places where homing is called

---

## File Operations

### Adding a New File

1. **Click the "Add Configuration"** (+) button in the Files sidebar header
2. **Choose:**
   - **Blank config** — start with an empty file (enter its name)
   - **From Reference** — search the bundled example configs and start from one

### File Context Menu

**Right-click a file** in the left Files sidebar:

- **Rename** — Opens a rename dialog; `[include]` references across the project update automatically. (Disabled for `printer.cfg`.)
- **Duplicate** — Creates a copy of the file with a new name.
- **Delete** — Removes the file after a confirmation dialog. (Disabled for `printer.cfg`.)

### Deleting a File

1. **Right-click the file** in the Files sidebar
2. **Select "Delete"**
3. **Confirm** in the dialog

---

## Switching Between Files

![Figure 7: File list](./figures/fig-7-tabs.svg)

**When your project has multiple files:**

- Files appear as **rows in the left Files sidebar** — not tabs
- **Click a file** — Opens it in the editor
- **Active file** — Highlighted; its error/warning dot is shown next to it

There are no keyboard shortcuts for switching files.

---

## Working with the Configuration Reference

The Configuration Reference is a dialog over the editor (see [Configuration Reference (Dialog)](#configuration-reference-dialog) above). The bundled docs include:

- **Clickable headings** — Jump to subsections
- **Cross-references** — Links to related sections
- **Examples** — Sample configurations
- **Parameter tables** — Lists all parameters with descriptions

---

## Best Practices

### When to Use Text View

✅ **Use Text View when:**
- You need precise control over formatting
- You are copying sections from documentation
- You want to see the exact output
- You are comfortable with Klipper syntax
- You need to edit many parameters quickly

❌ **Use Graph View when:**
- You are learning Klipper structure
- You want visual confirmation of connections
- You need to add hardware components
- You prefer form-based editing

### Workflow Integration

**Recommended approach:**

1. **Start with Graph View** — Add and organize components
2. **Switch to Text View** — Fine-tune parameters
3. **Validate** — Check for errors in both views
4. **Switch back and forth** — Use each view's strengths

**Example:**
- Graph View: Add a stepper motor and connect it
- Text View: Fine-tune `rotation_distance` and `microsteps`
- Graph View: Verify the stepper appears correctly in the toolhead

---

## Troubleshooting

### Text Does Not Update After Graph Edit

**Problem:** You edited a node in Graph View but the text did not change.

**Solution:**
1. **Check for errors** — Validation errors may block the update
2. **Re-import** — If the file was modified externally, re-import it

### Editor Seems Unresponsive

**Problem:** The editor stops responding to input.

**Solution:**
1. **Check validation** — Large configs may take time to process
2. **Restart the app** — As a last resort

---

## Appendix: Editor Configuration

### Supported Encodings

- UTF-8 (default)
- ASCII
- Latin-1 (legacy)

### Line Ending Handling

- LF (Unix/Linux) — Recommended
- CRLF (Windows) — Auto-detected and preserved
- CR (classic Mac) — Converted to LF

### Auto-Save

- **Not automatic** — KWC does not auto-save
- **Staged changes** — Edits are held in memory
- **Save/Export** — Required to persist changes

---
