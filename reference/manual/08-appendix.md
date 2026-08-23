# Appendix

Additional reference material, troubleshooting tips, and keyboard shortcuts.

---

## Keyboard Shortcuts Reference

### Global Shortcuts

| Shortcut | Action | Notes |
|----------|--------|-------|
| `F1` | Open User Manual | Planned (not yet implemented) |
| `Ctrl+Q` | Quit KWC | Browser mode only |
| `Ctrl+,` | Open settings | Global settings dialog |

### Graph View Shortcuts

| Shortcut | Action |
|----------|--------|
| `F` | Fit all nodes to screen |
| `Delete` | Remove selected node |
| `Ctrl+D` | Duplicate selected node |
| `Ctrl+Z` | Undo last change |
| `Ctrl+Y` | Redo last change |
| `Ctrl+A` | Select all nodes |
| `Shift+Click` | Multi-select nodes |
| `Drag` | Move nodes |
| `Scroll` | Zoom in/out |

### Text View Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+F` | Cross-file search |
| `Ctrl+G` | Go to line |
| `Ctrl+/` | Toggle comment |
| `Ctrl+Space` | Autocomplete (planned) |
| `Tab` | Indent or autocomplete |
| `Ctrl+Shift+P` | Command palette (planned) |

### Chat Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Enter` | Send message |
| `Esc` | Stop generation |
| `Ctrl+L` | New chat |
| `Ctrl+H` | Open chat history |
| `Ctrl+K` | Clear input |

### Macro Designer Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+S` | Save macro |
| `Ctrl+Enter` | Run simulation |
| `Ctrl+D` | Duplicate macro |
| `Ctrl+Shift+S` | Save as template |

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
|| `Pin conflicts` | Two sections use the same pin | Check your wiring and reassign the conflicting pin in Graph or Text View. |
|| `Invalid MCU communication` | MCU config is incorrect | Verify the ID and serial number in your MCU section match the physical connection. |

### Flash Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `No device found` | Board not detected | Check USB connection, try different port |
| `Verification failed` | Corrupted transfer | Retry, check USB cable |
| `Build failed` | Missing dependencies | Install build tools |
| `Permission denied` | Can't write to device | Run with sudo, fix permissions |

## File Locations

> **Note:** These paths are standard for Klipper/Moonraker installations. If you have a custom installation, these paths may vary. Check your `moonraker.conf` for the `config_path` and `log_path` settings.

### KWC Files

| File | Location | Purpose |
|------|----------|---------|
| `layout.json` | `~/.config/klipper-wire-configurator/` | Saved graph layout |
| `settings.json` | `~/.config/klipper-wire-configurator/` | KWC settings |
| `flash.log` | `~/.config/klipper-wire-configurator/` | Flash operation logs |
| `flash_profiles/` | `~/.config/klipper-wire-configurator/` | Saved flash profiles |

---

**End of Manual**

*For questions or issues, open an issue at the KWC GitHub repository.*
