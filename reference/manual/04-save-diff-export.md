# Save, Diff, and Export

Once you have made changes to your configuration, you need to save, review, and export them. This section covers the complete workflow from editing to applying changes.

---

## Understanding the Workflow

![Figure 1: Save workflow overview](./figures/fig-1-workflow.svg)

The typical workflow is:

1. **Edit** — Make changes in Graph or Text View
2. **Diff** — Review changes before applying
3. **Save/Export** — Write changes to disk or download to your computer

> **Safety Net:** Changes are **staged** in memory. They do not affect your actual configuration files or your printer until you click **Save** (write to disk) or **Export** (download). This allows you to experiment freely without risk.

---

## The Diff Viewer

![Figure 2: Diff viewer with changes list](./figures/fig-4-2-diff-viewer.png)

**Click the "Diff"** button in the toolbar to open the **"Changes Since Import"** dialog.

### What You Will See

**Left sidebar — File list:**
Each file shows a badge indicating its status:
- **New** — Added since the project was loaded
- **Changed** — Modified, with a count of changed lines
- **Deleted** — Removed from the project since it was loaded
- **Unchanged** — No modifications (grey dot)

When nothing has changed: "No changes — identical to the imported version."

**Right panel — Unified diff:**
- `+` (green) — Added content
- `-` (red) — Removed content
- ` ` (grey) — Context lines (unchanged)
- `@@` (blue) — Hunk header

### Diff Navigation

![Figure 3: Diff navigation](./figures/fig-3-navigation.svg)

**Click any file in the sidebar** to see its diff.

**Pro-Tip:** Always review the diff before saving. It shows exactly what lines will be added or removed from your config files.

---

## Exporting Your Config

### Export to Computer

**Click "Export"** in the toolbar. The **"Export Configuration"** dialog shows:

**File list with checkboxes:**
- Select which files to include
- Each file shows its error/warning count; entries with issues can be expanded to list them

**Diff preview:**
- When the project has originals (opened from the Pi or previously saved), changed lines for each selected file are shown

**Format selector:**
- **Individual files (.cfg)** — download each file separately
- **ZIP archive (.zip)** — a single archive containing all selected files

**Download:**
- Click **Export N file(s)** (or **Export ZIP (N file(s))**) to save to your computer
- Exported files preserve comments, formatting, and structure

### What Gets Exported

- **All checked config files** in your project
- **Comments preserved** — Your annotations remain
- **Formatting preserved** — Indentation and spacing intact
- **Validation state** — Exported regardless of errors (warnings are noted)

---

## Saving Changes

When KWC has a config directory (after **Open from Pi** or a previous **Save**), you can write your changes back to disk.

![Figure 5: Save button states](./figures/fig-5-save-states.svg)

### The Save Button

The button color reflects the whole project's validation state:

| State | Color | Meaning |
|-------|-------|---------|
| **No changes** | Grey | Nothing to save |
| **Valid changes** | Green | Changes staged and valid — click to save |
| **Warnings** | Yellow | Changes staged with validation warnings |
| **Errors** | Red | Validation errors block saving — fix them first |

### Saving Changes

**Steps:**

1. **Click "Save"** in the toolbar
2. **The save dialog opens** showing:
   - A list of files with checkboxes, each with a badge (**new file**, **deleted**, **unchanged**, or **N lines changed**)
   - A unified diff per selected file
   - The **Apply** button — its color mirrors the toolbar Save state
3. **Click "Apply"** to write the selected files to the Pi's config directory

**Prerequisites:**
- You have **changes staged** (Save button is green or yellow)
- **No blocking errors** — if Text View contains text that cannot be parsed, Apply is blocked until you fix it

### What "Save" Does

- **Writes files** to the configured config path (default: `~/printer_data/config/`)
- **Updates include paths** — if you renamed files
- **Triggers validation** — final check before writing

**Warning:** If validation fails with errors, KWC will prevent saving.

---

## Applying Changes to a Running System

### Save and Restart Workflow

After a successful save, the dialog shows a single **Firmware Restart** button:

1. **Changes written to disk** — Files updated
2. **Click "Firmware Restart"** to send the restart to Klipper (it becomes "Restart Sent")
3. KWC **polls Klipper status** and reports the result in the dialog:
   - Recent Klipper errors are listed on failure, with the log path
   - If Moonraker reports an **active print job**, the restart is disabled until it finishes

If you don't restart, Klipper keeps running the old configuration until you restart it manually (Moonraker, or `sudo systemctl restart klipper`).

### Checking Klipper Status

![Figure 6: Klipper status in the save dialog](./figures/fig-6-status.svg)

There is no persistent status bar in the app. Klipper status is reported **inside the save dialog after a restart attempt** (Ready, starting, or error states via the Klipper API, with recent error lines and the log path on failure).

---

## Reverting Changes

If you have made mistakes or want to try something risky, you can revert to the original state.

### Revert

1. **Click "Revert"** in the toolbar
2. **Confirm** — Revert restores the **whole project**; there is no per-file selection
3. KWC **re-reads the original files** from the config directory on the Pi (or re-parses the stored originals if there is no directory)
4. **Changes are discarded** — the config returns to the original state

The dialog offers a **"Clear Macro Designer drafts/layout"** checkbox, matching Open from Pi.

**Manual restore (SAVE_CONFIG backups):**
KWC does not create its own backup directories. Klipper's `SAVE_CONFIG` writes timestamped files like `printer-20260822_143000.cfg` into your config directory — that is where previous versions live. **Open from Pi** hides those files from its file list. To restore, copy one back:

```bash
cd ~/printer_data/config  # Or your custom config directory
ls -la printer-*.cfg      # Klipper SAVE_CONFIG backups
cp printer-20260822_143000.cfg printer.cfg
```

---

## Version Control (Best Practice)

For important configs, use Git or similar:

### Recommended Workflow

1. **Export your config** after each major change
2. **Create a Git repository** in your config directory
3. **Commit with descriptive messages:**
   ```bash
   git add printer.cfg
   git commit -m "Add bed mesh calibration"
   ```
4. **Push to remote** (GitHub, GitLab, etc.)

**Safety Hierarchy:** Klipper SAVE_CONFIG backups (instant recovery) → Git (history & collaboration) → manual downloads (archival).

### KWC and Git

KWC doesn't include built-in Git integration, but:

- **Exports are Git-ready** — Files are clean and formatted
- **Multi-file projects** — Work well with Git tracking
- **Backups** — Complementary to Git for quick recovery

---

## Troubleshooting

### "Save" Button Is Gray (No Changes Detected)

**Problem:** You made changes but the Save button is still gray.

**Possible causes:**
- You edited in Graph View but changes did not apply
- Changes were automatically reverted
- Your config files are set to read-only on the filesystem

**Solution:**
1. Check that edits are reflected in the Diff viewer
2. Check if changes appear in the Diff viewer

### "Save" Button Is Red (Validation Errors)

**Problem:** You have blocking errors preventing save.

**Solution:**
1. **Click "Diff"** to see the changes
2. **Find red badges** — These indicate errors
3. **Fix the errors** — Edit in Graph or Text View
4. **Re-check** — Save button should turn yellow

**Common blocking errors:**
- Duplicate section names
- Missing required parameters
- Invalid pin assignments
- Text that cannot be parsed in Text View

### Export Creates Empty File

**Problem:** The exported file is empty or missing content.

**Possible causes:**
- You have not loaded any config
- The export failed silently

**Solution:**
1. **Check your import** — Ensure a config is loaded
2. **Try Text View** — See if content appears there
3. **Re-export** — Sometimes a retry works

### Klipper Won't Restart After Save

**Problem:** You saved changes but Klipper will not restart.

**Check:**
1. **Klipper status** — Is it showing errors?
2. **Moonraker logs** — Check via SSH
3. **Config syntax** — Did you introduce a typo?

**Manual restart:**
```bash
sudo systemctl restart klipper
# Or via Moonraker API
curl -X POST http://localhost:7125/klippy/restart
```

---

## Appendix: File Locations

### Config Paths

| File Type | Location |
|-----------|----------|
| Active config | `~/printer_data/config/` (default) |
| Klipper SAVE_CONFIG backups | `printer-YYYYMMDD_HHMMSS.cfg` in the config directory |
| KWC state | `~/.config/klipper-wire-configurator/` |

### Computer Downloads

| File Type | Location |
|-----------|----------|
| Exported files | Your computer's Downloads folder |
| Default name | `printer.cfg` or original filename |

---
