# Running KWC on Raspberry Pi

This document covers running KWC directly on a Raspberry Pi, including Klipper connection status, serial device paths, and configuration details.

---

## Klipper Connection Status

There is no persistent status bar in KWC. Klipper status is reported **inside the Save dialog after a restart attempt**: the dialog polls the Klipper API and shows the state (Ready, Starting, Printing, Error, Stopped) along with recent Klipper error lines and the log path when something goes wrong.

To check status from the shell:

```bash
systemctl status klipper
journalctl -u klipper -n 20
```

---

## Serial Device Paths

When connecting to Klipper, KWC uses the standard Klipper socket paths:

- **Unix domain socket:** `~/printer_data/comms/klippy.sock`
- **Serial by ID:** `/dev/serial/by-id/` (look for your device, e.g., `usb-12345678-if00`)

### Finding Your Serial ID

```bash
ls -la /dev/serial/by-id/
```

This shows all serial devices with their persistent IDs. Use these paths rather than `/dev/ttyACM0` since those can change between reboots.

---

## Klipper Configuration Paths

Standard Klipper/Moonraker paths:

| Path | Purpose |
|------|---------|
| `~/printer_data/config/` | Active config directory |
| `~/printer_data/logs/` | Klipper logs |
| `~/klipper/` | Klipper source tree |
| `~/katapult/` | Katapult source tree |
| `~/printer_data/database/` | Moonraker database |

---

## Backups

KWC does not create its own backup directories. Klipper's `SAVE_CONFIG` command writes timestamped copies of the config into the config directory:

```
~/printer_data/config/
├── printer.cfg
├── printer-20260822_143000.cfg   ← SAVE_CONFIG backup
├── macros.cfg
└── ...
```

To restore:

```bash
cp ~/printer_data/config/printer-20260822_143000.cfg ~/printer_data/config/printer.cfg
sudo systemctl restart klipper
```

---

## UART Configuration on Raspberry Pi

To enable UART on a Raspberry Pi for serial communication with boards:

1. Edit `/boot/config.txt`:

```
enable_uart=1
```

2. Reboot the Pi.

Do not use SPI overlay settings for UART configuration — they are for different hardware.

---

## Troubleshooting

### KWC Cannot Connect to Klipper

**Check:**
1. **Is Klipper running?** `systemctl status klipper`
2. **Is the socket accessible?** `ls -la ~/printer_data/comms/klippy.sock`
3. **User permissions** — Your user should be in the `dialout` group: `sudo usermod -aG dialout $USER`
4. **Moonraker** — Ensure Moonraker is running and configured with the correct `config_path`

### Config Not Loading from Pi

**Check:**
1. **Config directory exists** — Default is `~/printer_data/config/`
2. **Files are readable** — Check permissions on `.cfg` files
3. **No custom paths** — If you use a non-standard config path, set it in settings

---
