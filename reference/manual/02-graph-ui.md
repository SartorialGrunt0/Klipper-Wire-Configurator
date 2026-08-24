# Graph UI

The **Graph View** provides a visual representation of your Klipper configuration as an interactive hardware tree. This is the default view after importing a config.

---

## Understanding the Graph Structure

![Figure 1: Graph workspace layout](./figures/fig-1-graph-layout.svg)

The graph organizes your printer's components into a hierarchical tree:

### Hardware Nodes

| Node Type | Purpose |
|-----------|---------|
| **SBC** | Your Raspberry Pi or other single-board computer |
| **Mainboard** | The printer's main controller board |
| **Toolhead** | An accessory board mounted to the containing extruders, heaters, and fans |
| **Expander** | Additional boards connected |
| **Probes** | Probes that contain an MCU |
| **Accelerometers** | Standalone Accelerometers that contain an MCU |

### Child Components

Within each hardware node, you will find:

- **Steppers** — X, Y, Z motors and extruder motors
- **Drivers** — TMC2209, TMC2208, etc. (attached to steppers)
- **Heaters** — Hotend heaters, heated bed, heatbreak
- **Fans** — Part cooling fan, hotend fan, controller fan
- **Sensors** — Thermistors, endstops, probes
- **Features** — LEDs, displays, servos, accelerometers

### Connection Types

![Figure 2: Communication edges](./figures/fig-2-edges.png)

The lines (edges) connecting nodes represent the communication and power paths between components:

- **USB Edge** — Represents a direct USB connection (e.g., SBC to mainboard).
- **UART Edge** — Represents serial communication between boards.
- **CAN Edge** — Represents CAN bus communication (common for toolhead modules).
- **Power Edge** — Represents power distribution. *Note: These are primarily conceptual and may not be explicitly rendered for all connections.*

---

## Working with the Graph

### Navigation

- **Pan** — Click and drag the background to move the view.
- **Zoom** — Use the scroll wheel to zoom in/out.
- **Fit View** — Click the **Fit View** button (bottom-left of the canvas) to center and scale all nodes.
- **Arrange** — Click the **Arrange** button (top-left of the canvas) to automatically reorganize the graph.

### Selecting Nodes

![Figure 3: Selected node with settings panel](./figures/fig-3-selection.svg)

**Click a node** to:
- See its parameters in the Settings Panel (opens on the right)
- View validation status (green/yellow/red badge)
- Use the node's **Duplicate** and **Delete** buttons

### Adding Components

![Figure 4: Add menu](./figures/fig-4-add-menu.png)

**Click the Component (+) button** in the toolbar to add a new component. The add menu has three tabs:

**Major Components** — Hardware nodes:
- SBC (automatically added on new project)
- Mainboard
- Toolhead
- Expander
- Probe
- Accelerometer
- Other

For mainboard, toolhead, expander, probe, and accelerometer, a **template picker** appears: choose **Blank {type}** for an empty section, or search and select an example config that fills the node with that example's sections.

**Sub-Components** — Parts attached to the currently selected node (or standalone if nothing is selected):
- Steppers (X, Y, Z)
- Stepper Drivers (TMC2209, TMC2208, TMC2240, etc.)
- Extruders
- Heaters (hotend, bed)
- Fans (part cooling, hotend, controller)
- Temperature Sensors (thermistors)
- Probes
- LEDs
- Displays
- Servos
- Output Pins
- Filament Sensors
- Accelerometers
- MCU (extra sections on a board)

**Features** — Klipper features that add config sections, with an optional "attach to component" picker:
- Bed Leveling (`bed_mesh`, `z_tilt`, `quad_gantry_level`, …)
- Homing (`safe_z_home`, …)
- Resonance (`input_shaper`, `resonance_tester`)
- G-Code Features (`virtual_sdcard`, `pause_resume`, `gcode_macro`, …)

**MCU name prompt:** when you add a **non-primary** board (toolhead, expander, probe, accelerometer, or an extra MCU), KWC asks for an MCU name. This name is used in section headers (e.g., `[mcu EBBCan]`) and as a pin prefix (e.g., `EBBCan:gpio13`).

### Reparenting Components

To reorganize your hardware hierarchy, you can **drag and drop** components to change their parent:

1. Click and hold the component node.
2. Drag it over the target parent node (e.g., move a stepper from the Mainboard to the Toolhead).
3. Release the mouse button. The configuration is updated instantly.

**Validation:** KWC automatically verifies that the new parent is compatible with the component type.

### Grouping

There is no "group selected" menu — groups form automatically:

- **Create a group:** drag a node onto a sibling of the same component group (e.g., drag a second fan onto the existing fan node). The two merge into a group node holding both.
- **Ungroup:** drag a child out of the group. It leaves the group and becomes a standalone node.

![Figure 5: Grouped nodes](./figures/fig-5-groups.svg)

Grouping is for organization only (e.g., all toolhead components together); it does not change the configuration.

---

## Editing Node Parameters

### Settings Panel

![Figure 6: Settings panel for a stepper](./figures/fig-6-settings.svg)

When you select a node, the **Settings Panel** appears with:

- **Section name** — The config section header (e.g., `[stepper_x]`); editable inline (renames the node)
- **Parameters** — Editable fields with validation
- **Validation errors** — Red highlights with explanations
- **Reference link** — Quick access to Klipper documentation

### Editing Parameters

**Steps:**
1. Click a field to edit (text box, dropdown, checkbox)
2. Enter the new value
3. Validation runs immediately
4. Changes are staged (not saved until you save)

**Common parameter types:**

| Type | Examples | Description |
|------|----------|-------------|
| **Text** | `step_pin: PB0` | Standard text input for pins and labels. |
| **Number** | `rotation_distance: 40` | Numeric values for distances, speeds, etc. |
| **Boolean** | `endstop_pin: endstop_z` | True/False toggles. |
| **Dropdown** | `microsteps: 16` | Selection from a predefined list of valid options. |
| **Pin** | `step_pin: PB0` | Specialized pin input with real-time hardware validation. |

### Pin Conflict Detection

If two sections claim the same pin (e.g., two steppers with `step_pin: PB0`), the conflict surfaces as a red validation error on the affected fields and as a badge on the affected node.

### Validation Feedback

**Real-time validation** catches errors as you type:

- **Red underline** — Invalid value (e.g., pin already in use)
- **Yellow underline** — Warning (e.g., non-recommended value)
- **Badge on node** — Summary of all errors/warnings for that node

**Example:**
- You set `step_pin: PB0` on stepper_x
- You try `step_pin: PB0` on stepper_y
- KWC shows: "Pin PB0 already used by [stepper_x]"

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Z` | Undo last change |
| `Ctrl+Y` | Redo last change |

(These are the only keyboard shortcuts in the Graph View. Deleting or duplicating a node uses the node's own buttons.)

---

## Common Workflows

### Building a Printer from Scratch

1. **Start with SBC** — Automatically added on project creation
2. **Add Mainboard** — Click Component (+) → Major Components → Mainboard
3. **Connect to SBC** — Drag mainboard node under SBC (creates USB edge)
4. **Add Toolhead** — Component (+) → Major Components → Toolhead
5. **Add components** — Steppers, heaters, sensors under Toolhead
6. **Set parameters** — Click each node and configure values
7. **Validate** — Ensure no red badges appear

### Modifying an Existing Config

1. **Import the config** — Click Import
2. **Review graph** — Identify components that need changes
3. **Add missing hardware** — Use Component (+) button
4. **Edit parameters** — Click nodes and modify in Settings Panel
5. **Reparent if needed** — Drag nodes to new parent
6. **Validate** — Check for pin conflicts and errors before saving

### Troubleshooting Validation Errors

1. **Click the red badge** on a node to see the specific error message.
2. **Check the Settings Panel** to identify which parameter is failing.
3. **Read the reference link** provided in the panel for official Klipper documentation.
4. **Use the AI Chat** for specific questions (e.g., "Why is my stepper_x not validating?").
5. **Fix and verify** — Update the value and ensure the badge turns green.

---

## Appendix: Node Types Reference

### SBC Nodes

- Raspberry Pi 3B/3B+/4/5
- Odroid
- Other Linux SBCs

### Mainboard Types

- Fysetc Spider (Fysetc)
- MKS Robin (MKS)
- BigTreeTech SKR (BTT)
- Duet (Duet)
- Custom/Other

### Toolhead Configurations

- Single extruder (standard)
- Dual extruder (tandem or independent)
- IDEX (independent dual extruder)
- CoreXY (Voron style)
- Cartesian (standard)

---
