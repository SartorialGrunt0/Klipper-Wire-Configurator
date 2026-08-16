# Flash Post-Flash Workflow — Research Note

**Date:** 2026-08-15
**Status:** Research complete; implementation pending Clifford's inclusion call (Phase 7 of the flash-tool-hardening plan).
**Scope:** What must happen *after* a successful flash so Klipper ends up working, per flash method. Grounded in official Klipper source/docs and Katapult docs; real-hardware validation on the Voron Trident is still required for the board-specific claims marked [VERIFY].

## Per-method matrix

| Flash path | Bootloader entry | Post-flash MCU state | Klipper-side after flash |
| --- | --- | --- | --- |
| `make flash` STM32 DFU (Spider, STM32F407) | `scripts/flash_usb.py` enters bootloader (1200-baud DTR trick on the USB-ACM serial, or accepts a device already in DFU); then runs `dfu-util -d ,<VID:PID> -R -a 0 -s <app_addr>:leave -D out/klipper.bin` | Auto-resets into the app (the `:leave` DfuSe modifier exits DFU and boots the application) | `FIRMWARE_RESTART` reconnects after USB re-enumeration; no host restart needed |
| direct `dfu-util` (Spider in DFU mode) | **Manual**: BOOT0+RESET (or a Pi-wired switch; Fysetc wiki says the switch is *disconnected by default*) | Needs `-s <app_addr>:leave` to exit DFU; without it the MCU stays in DFU mode | `FIRMWARE_RESTART` after re-enumeration |
| `flashtool.py -d` serial | Auto for USB-serial devices (flashtool commands the device into the bootloader); **UART devices cannot be auto-entered** — manual entry required | Resets into app; the by-id path switches to `usb-katapult-*` during the bootloader phase, then returns to the Klipper-mode path after flash — stable for the same board | `FIRMWARE_RESTART`; check serial path only if the physical board changed |
| `flashtool.py -i can0 -u` CAN (EBBCan over Katapult) | **Requires klipper stopped first**, then `flashtool.py -i can0 -r -u <uuid>` (bootloader entry; prints "Flash success" but flashes nothing); manual fallback = double-press RESET | Resets into app; **CAN UUID is derived from the factory chip identifier and is stable across Katapult↔Klipper flashes** | restart klipper service, then `FIRMWARE_RESTART`; `canbus_uuid` edit only if a different board is installed |
| `make flash` RP2040 (PIS/Hotkey) | USB bootrom (`picoboot`, device `2e8a:0003`; rp2350 `2e8a:000f`), or manual BOOTSEL + UF2 copy | MCU resets into the app automatically | `FIRMWARE_RESTART` |

## Findings that change implementation

### 1. CAN UUID is stable across reflashes
Klipper's CANBUS docs assign each MCU a UUID "based on the factory chip identifier." Reflashing the same physical board (Katapult ↔ Klipper, or Klipper → new Klipper) does **not** change the UUID. Community "no UUID after flashing" reports are almost always one of:
- klippy already configured/grabbed the node — `canbus_query.py` only reports *uninitialized* devices (Esoterical confirms: "Once a UUID has been 'grabbed' by klipper-on-pi then it won't show up to a query. This is normal." And klippy only grabs `Application: Klipper` UUIDs, not Katapult-mode ones);
- the new firmware was built without CAN enabled;
- the board never actually entered the bootloader;
- wrong CAN pins/speed in the firmware, bad wiring/termination (120Ω each end → 60Ω measured), or the Pi's `can0` in BUS-OFF state (recover with `ip link set can0 down/up`).

**Implication:** the post-flash config check for CAN should warn only when the UUID observed after flashing differs from the UUID recorded before flashing (i.e., a different physical board), not after every flash. Sources: `docs/CANBUS.md` in the Klipper tree, Esoterical troubleshooting/no_uuid.

### 1b. Canonical CAN update flow (Esoterical, Voron community standard)
Toolhead (EBBCan) — exactly as documented:
1. Build `klipper.bin` (CAN bus, 1Mbit, correct pins) — KWC's build step.
2. `sudo service klipper stop`.
3. Force bootloader: `python3 ~/katapult/scripts/flashtool.py -i can0 -r -u <uuid>` — prints "Flash success" but **flashes nothing**; it only reboots into Katapult. If no UUID (hung board): double-press RESET.
4. Verify: `flashtool.py -i can0 -q` → "Application: Katapult".
5. Flash: `python3 ~/katapult/scripts/flashtool.py -i can0 -f ~/klipper/out/klipper.bin -u <uuid>`.
6. Verify: `flashtool.py -i can0 -q` → same UUID, "Application: Klipper".
7. `sudo service klipper start`, then `FIRMWARE_RESTART` and confirm no errors.

Mainboard (Spider when it runs Katapult as a USB-CAN bridge) — same shape but the bootloader entry + flash go over USB serial:
1. Build `klipper.bin` ("USB to CAN bus bridge", correct pins, 1Mbit).
2. `sudo service klipper stop`.
3. Force bootloader: `flashtool.py -i can0 -r -u <uuid>` (or double-press RESET on the mainboard).
4. Verify: `ls /dev/serial/by-id` shows `usb-katapult-...`.
5. Flash: `python3 ~/katapult/scripts/flashtool.py -f ~/klipper/out/klipper.bin -d /dev/serial/by-id/usb-katapult_<id>`.
6. Verify mainboard still enumerates as a CAN adapter (`lsusb` + `ip a` shows can0), then `sudo service klipper start`.

Implementation implication: KWC's flashtool CAN/serial job currently runs a single command sequence. The canonical flow needs (a) klipper service stop before step 3, (b) an explicit `-r` bootloader-entry command that returns "Flash success" but is not the flash, (c) a `-q` verify between entry and flash, and (d) klipper service start + `FIRMWARE_RESTART` after. Whether the `-r` + verify steps belong inside the automated job or as pre-flight guidance is a Phase 7 design decision.

### 2. The 5.5 dfu-util fallback flags are wrong for STM32 (bug found by research)
Klipper's own STM32F4 flash path (from `scripts/flash_usb.py` + `src/stm32/Makefile`) is:

```bash
dfu-util -d ,<VID:PID> -R -a 0 -s <CONFIG_FLASH_APPLICATION_ADDRESS>:leave -D out/klipper.bin
```

`-R` alone issues USB reset signalling (dfu-util man page) but on the STM32 ROM bootloader the device re-enters DFU mode unless the DfuSe `:leave` modifier is present in the `-s` address. The current KWC constant:

```python
_DFU_UTIL_FALLBACK_FLAGS = ["-a", "0", "-R", "-D"]   # wrong for STM32
```

would flash the Spider but leave it stuck in DFU mode. Fix: build flags dynamically from the already-parsed kconf symbol `CONFIG_FLASH_APPLICATION_ADDRESS`:

```python
app_addr = _current_symbol_value(kconf, "CONFIG_FLASH_APPLICATION_ADDRESS") or "0x08000000"
_DFU_UTIL_FALLBACK_FLAGS = ["-a", "0", "-R", "-s", f"{app_addr}:leave", "-D"]
```

Extra note: on a real Klipper checkout `make -n flash` prints a `flash_usb.py` invocation, **not** a literal `dfu-util` token, so the current `_resolve_dfu_util_flash_command` "dfu-util" scan usually falls through to this fallback — the fallback flags are effectively the primary direct-dfu-util path. [VERIFY against a live Klipper checkout on the Pi]

### 3. Klippy stop requirements per method
- **CAN `flashtool.py -i can0 -u`:** **required, not optional.** The canonical Esoterical CANBus guide (Voron community standard) makes `sudo service klipper stop` Step 2 of the update flow for both toolhead and mainboard. The bootloader-entry command (`flashtool.py -i can0 -r -u <uuid>`) and the actual flash (`-f`) are run with klipper stopped; then `sudo service klipper start` + `FIRMWARE_RESTART`. This means KWC's CAN flash path needs to orchestrate the klipper service stop/start around the job (via sudo service or Moonraker service control — KWC is in `moonraker.asvc`), or surface it as a hard pre-flight requirement. [IMPLEMENTATION NOTE]
- **USB DFU (`make flash`/direct dfu-util):** klippy does **not** need to stop — DFU is a separate USB interface from the serial port klippy holds. (Klipper's `flash_usb.py` does use the USB-ACM serial for the 1200-baud DTR bootloader-entry trick, which can contend with klippy's open handle; in practice flashing works with klippy running, but the DTR trick may need a retry.) [VERIFY]
- **Serial `flashtool.py -d`:** klippy holds the serial device → stop Klipper (or accept the flash may fail on port contention). Esoterical's mainboard flow stops klipper first here too.

### 4. Safety: heaters in DFU mode
Klipper's `Bootloader_Entry.md` warns that on some boards (e.g., Octopus Pro v1) entering DFU mode "can cause undesired actions (such as powering the heater while in DFU mode). It is recommended to disconnect heaters." Surface this once for the Spider DFU path. [VERIFY Spider-specific behavior on the Trident]

### 5. Spider-specific facts (Fysetc wiki)
- Fysetc ships an SD-card bootloader as the documented primary flash method (`Bootloader_FYSETC_SPIDER.hex`, 32k / 64k variants).
- BOOT0 and RESET pins are broken out and **can** be wired to the Pi's GPIO "through the switch (disconnected by default)" for entering programming mode from the Pi — i.e., DFU entry *might* be automatable on Clifford's machine if he wired it. Open question.
- Klipper's own `flash_stm32f4` treats `start == 0x8004000` as the HID-bootloader case; everything else uses DFU with `:leave`.

### 6. RP2040 (PIS/Hotkey)
`make flash` uses the USB bootrom via `picoboot` (`2e8a:0003`), or manual BOOTSEL + copy `klipper.uf2`. The MCU resets into the app automatically — no `:leave` equivalent, no power-cycle requirement.

## Open questions for Clifford

1. How do you actually flash the Spider today — SD card (Fysetc bootloader), DFU via BOOT0+RESET, or Katapult? Decides which method paths are primary for Trident validation.
2. Is the Spider's BOOT0/RESET switch wired to the Pi's GPIO? If yes, DFU entry could be automated.
3. Does the EBBCan toolhead run Katapult, and is the `canbus_uuid` constant across your reflashes?
4. OK to surface the "disconnect heaters before DFU" warning for the Spider?
5. Apply the dfu-util `:leave` flag correction now (one line + test) or bundle with the Phase 7 feature decision?

## Sources

- Klipper `scripts/flash_usb.py` (master) — flash path per MCU type incl. `flash_stm32f4`, `flash_rp2040`
- Klipper `src/stm32/Makefile` (master) — `flash:` rule → `flash_usb.py -t $(CONFIG_MCU) -d "$(FLASH_DEVICE)" -s "$(CONFIG_FLASH_APPLICATION_ADDRESS)"`
- Klipper `docs/Bootloader_Entry.md` — bootloader request methods (1200-baud DTR, serial string, CAN admin message), STM32 DFU heater warning
- Klipper `docs/Bootloaders.md` — STM32F4 section (ROM bootloader via USB DFU; some boards can't enter DFU; HID bootloader alternative)
- Klipper `docs/CANBUS.md` — UUID derivation from chip identifier; `canbus_query.py` only reports uninitialized devices
- Klipper `docs/FAQ.md` — stable `/dev/serial/by-id/...` names; `FIRMWARE_RESTART` usage
- dfu-util man page — `-R` (USB reset signalling), `-e` (detach), `-s ADDRESS[:LENGTH][:MODIFIERS]` with `:leave`
- Katapult README (Arksine/katapult) — flashtool auto bootloader entry for USB/CAN; UART + USB-to-CAN-bridge cannot be auto-entered
- katapult issue #114 (EBB42) + Esoterical CANBus guide — stop Klipper to release CAN bus device before flashing
- **Esoterical CANBus guide** (canbus.esoterical.online) — canonical update flows: `toolhead_klipper_updating.html`, `mainboard_klipper_updating.html`, `katapult_updating.html`, `troubleshooting/no_uuid.html`. Confirms: klipper stop is a required step for CAN flashes; `flashtool.py -r` is the bootloader-entry command (prints "Flash success" but flashes nothing); double-press RESET is the manual fallback; UUID grab/query semantics; BUS-OFF recovery; `usb-katapult-*` vs Klipper-mode serial paths
- Fysetc Spider wiki + FYSETC-SPIDER repo `bootloader/README.md` — SD-card bootloader, BOOT0/RESET switch wiring
- Klipper discourse 13151 — "no UUID after flashing klipper" root causes

## Verification checklist (real Trident — Clifford must accept the risk first)

Per method: record pre-flash identity → flash → confirm MCU state → recommended post-step → `query_klipper_status` green.

- [ ] `make flash` DFU path: `dfu-util` command shown by `make -n flash`; confirm `:leave` present; confirm app boots after flash (no manual power cycle)
- [ ] Direct dfu-util with corrected flags: exit DFU, app boots, `FIRMWARE_RESTART` reconnects
- [ ] flashtool CAN: klipper stopped first; `-r` bootloader entry + `-q` verify; UUID unchanged across flash; `service klipper start` + `FIRMWARE_RESTART` suffices
- [ ] flashtool serial: by-id path switches to `usb-katapult-*` during flash and returns after; klipper stopped first
- [ ] RP2040: app boots after picoboot/UF2; `FIRMWARE_RESTART` suffices
- [ ] Klipper restart via KWC socket (`gcode/firmware_restart`) returns green state
