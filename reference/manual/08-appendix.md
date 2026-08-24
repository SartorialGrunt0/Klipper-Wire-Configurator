# Appendix

Additional reference material, troubleshooting tips, and keyboard shortcuts.

---

## Keyboard Shortcuts Reference

KWC intentionally has a small set of keyboard shortcuts. Here is everything that exists:

| Shortcut | Action | Where |
|----------|--------|-------|
| `Ctrl+Z` | Undo last change | Graph View |
| `Ctrl+Y` (or `Ctrl+Shift+Z`) | Redo last change | Graph View |
| `Delete` / `Backspace` | Delete the selected canvas item (no-go zone or dock) | Macro Designer canvas |
| `Enter` | Send message | AI Chat input |
| `Shift+Enter` | New line | AI Chat input |
| `Escape` | Close the search panel | Text View |
| `Enter` | Confirm dialogs / seed a simulation command | Dialogs, Macro Designer |

Everything else — fit view, node duplication, file switching, simulation playback — is done with on-screen buttons.

> **Note:** In the text editor and any text input, `Ctrl+Z`/`Ctrl+Y` are the browser's native undo/redo.

---

## Error Messages Reference

### Validation Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `Duplicate section` | Same section defined twice | Remove or rename duplicate |
| `Missing required parameter` | Required parameter not set | Add the missing parameter |
| `Invalid pin` | Pin already in use or invalid | Choose a different pin |
| `Unknown section` | Section not recognized | Check spelling or acknowledge warning |
| `Missing include` | Included file not found | Create the file or fix the path |
| `Pin conflicts` | Two sections use the same pin | Check your wiring and reassign the conflicting pin in Graph or Text View. |
| `Invalid MCU communication` | MCU config is incorrect | Verify the ID and serial number in your MCU section match the physical connection. |

### Flash Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `No device found` | Board not detected | Check USB connection, try different port |
| `Verification failed` | Corrupted transfer | Retry, check USB cable |
| `Build failed` | Missing dependencies | Install build tools |
| `Permission denied` | Cannot write to device | Run with sudo, fix permissions |

## File Locations

> **Note:** These paths are standard for Klipper/Moonraker installations. If you have a custom installation, these paths may vary. Check your `moonraker.conf` for the `config_path` and `log_path` settings.

### KWC Files

| File | Location | Purpose |
|------|----------|---------|
| `layout.json` | `~/.config/klipper-wire-configurator/` | Saved graph layout |
| `settings.json` | `~/.config/klipper-wire-configurator/` | KWC settings |
| `flash.log` | `backend/flash.log` (next to the backend code) | Flash operation logs |
| `flash_profiles/` | `~/.config/klipper-wire-configurator/` | Saved flash profiles |

---

**End of Manual**

*For questions or issues, open an issue at the KWC GitHub repository.*
