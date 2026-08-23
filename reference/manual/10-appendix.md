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

### Klipper Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `Unknown command` | Invalid G-code | Check macro syntax |
| `Timeout` | Printer not responding | Check Klipper status, restart |
| `Emergency stop` | Safety trigger | Check for hardware issues |
| `Config error` | Invalid configuration | Review config in KWC |

---

## Common Workflows

### First-Time Setup

1. **Install KWC** on your Pi (see Native Mode)
2. **Import your config** — File → Import
3. **Review validation** — Fix any red badges
4. **Add missing hardware** — Use Add menu
5. **Set parameters** — Configure via Graph or Text View
6. **Save and restart** — Apply changes

### Routine Maintenance

**Weekly:**
- Check validation errors
- Review Klipper logs
- Backup config files

**Monthly:**
- Update Klipper source (if needed)
- Review and clean up macros
- Check for firmware updates

### Troubleshooting a Non-Printing Printer

1. **Check Klipper status** — Is it running?
2. **Review recent errors** — Click status in KWC
3. **Validate config** — Fix any red badges
4. **Check homing** — Can you home all axes?
5. **Test movement** — Try moving each axis
6. **Check heaters** — Can you heat bed and hotend?
7. **Review logs** — Check `klippy.log` for details

---

## File Locations

> **Note:** These paths are standard for Klipper/Moonraker installations. If you have a custom installation, these paths may vary. Check your `moonraker.conf` for the `config_path` and `log_path` settings.

### Configuration Files

| File | Location | Purpose |
|------|----------|---------|
| `printer.cfg` | `~/printer_data/config/` | Main config |
| `macros.cfg` | `~/printer_data/config/` | G-code macros |
| `sensor.cfg` | `~/printer_data/config/` | Sensor definitions |
| `tuning.cfg` | `~/printer_data/config/` | PID tuning values |

### KWC Files

| File | Location | Purpose |
|------|----------|---------|
| `layout.json` | `~/.config/klipper-wire-configurator/` | Saved graph layout |
| `settings.json` | `~/.config/klipper-wire-configurator/` | KWC settings |
| `flash.log` | `~/.config/klipper-wire-configurator/` | Flash operation logs |
| `flash_profiles/` | `~/.config/klipper-wire-configurator/` | Saved flash profiles |

### Klipper Files

| File | Location | Purpose |
|------|----------|---------|
| `klippy.log` | `~/printer_data/logs/` | Klipper log |
| `moonraker.log` | `~/printer_data/logs/` | Moonraker log |
| `access.conf` | `~/printer_data/` | Access control |
| `moonraker.conf` | `~/printer_data/` | Moonraker config |

---

## Glossary

| Term | Definition |
|------|------------|
| **SBC** | Single Board Computer (e.g., Raspberry Pi) |
| **MCU** | Microcontroller Unit (e.g., STM32, AVR) |
| **CAN** | Controller Area Network (bus communication) |
| **UART** | Universal Asynchronous Receiver-Transmitter |
| **DFU** | Device Firmware Upgrade (flash protocol) |
| **PID** | Proportional-Integral-Derivative (temperature control) |
|| **G-code** | Language for controlling machines |
|| **Jinja** | Template engine for macros |
|| **JSON** | JavaScript Object Notation — Lightweight data format for layouts and settings. |
|| **Kconfig** | Configuration system for firmware builds |
|| **Katapult** | Bootloader for STM32 boards |
|| **KWC** | Klipper Wire Configurator — Visual tool for managing Klipper configurations. |
|| **Moonraker** | API server for Klipper |

---

## Resources

### Official Documentation

- **Klipper docs:** https://www.klipper3d.org/
- **Moonraker docs:** https://moonraker.readthedocs.io/
- **KWC repo:** https://github.com/SartorialGrunt0/Klipper-Wire-Configurator

### Community Resources

- **Klipper Discord:** https://discord.gg/klipper
- **Reddit r/Klipper:** https://reddit.com/r/Klipper
- **GitHub Issues:** Report bugs in KWC repo

### Useful Tools

- **KlipperScreen:** Touchscreen interface
- **OctoPrint:** Web interface for printers
- **Fluidd:** Another web interface option

---

## Troubleshooting Checklist

> **⚠️ WARNING:** Always ensure the printer is powered off and the bed is cool before making hardware changes or checking wiring.

### "My printer won't start"

- [ ] Config validates with no red badges
- [ ] All required sections are defined
- [ ] Pins are correctly assigned
- [ ] MCU communication is configured
- [ ] Klipper log shows no errors

### "KWC won't connect"

- [ ] Service is running: `sudo systemctl status klipper-wire-configurator`
- [ ] Port is open: `sudo netstat -tlnp | grep 8099`
- [ ] Firewall allows port 8099
- [ ] You're on the same network (for remote access)

### "Build fails"

- [ ] Build tools are installed
- [ ] Klipper source is up to date
- [ ] Kconfig options are valid
- [ ] Enough disk space available
- [ ] Memory is available (close other apps)

### "Flash fails"

- [ ] Board is in bootloader mode
- [ ] USB cable is good
- [ ] Correct flash method selected
- [ ] Device path is correct
- [ ] Power supply is stable

---

## Update History

### 2026-08-22

- Initial manual creation
- Getting Started section complete
- All sections drafted with placeholders
- Subagent review completed

### Future Updates

- Figure placeholders to be replaced with screenshots
- Keyboard shortcuts to be implemented
- Search functionality to be added
- Video tutorials (planned)

---

**End of Manual**

*For questions or issues, open an issue at the KWC GitHub repository.*
