# Flash Post-Flash Workflow — Research Note

**Date:** 2026-08-15
**Status:** Research complete; implementation pending Clifford's inclusion call (Phase 7 of the flash-tool-hardening plan).
**Scope:** What must happen *after* a successful flash so Klipper ends up working, per flash method. Grounded in official Klipper source/docs and Katapult docs; real-hardware validation on the Voron Trident is still required for the board-specific claims marked [VERIFY].

## Per-method matrix

| Flash path | Bootloader entry | Post-flash MCU state | Klipper-side after flash |
| --- | --- | --- | --- |
| `make flash` STM32 DFU (Spider, STM32F446) | New install: **manual BT0 jumper to 3.3V + power cycle** (Voron docs); update path: `flash_usb.py` enters bootloader via 1200-baud DTR trick on the USB-ACM serial, then runs `dfu-util -d ,<VID:PID> -R -a 0 -s <app_addr>:leave -D out/klipper.bin` | Auto-resets into the app (the `:leave` DfuSe modifier exits DFU and boots the application) | `FIRMWARE_RESTART` reconnects after USB re-enumeration; no host restart needed |
| direct `dfu-util` (Spider in DFU mode) | **Manual**: BT0 jumper to 3.3V + power cycle (Voron docs); or BOOT0+RESET switch wired to the Pi (Fysetc wiki — disconnected by default) | Needs `-s <app_addr>:leave` to exit DFU; without it the MCU stays in DFU mode | `FIRMWARE_RESTART` after re-enumeration |
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

Mainboard (Spider when it runs Katapult as a USB-CAN bridge) — the README's `-r` section documents the exact pattern: bridge-mode devices **cannot be auto-detected** by flashtool (only plain USB and CANBus devices can), so bootloader entry must be requested manually with `-r`, then the upload goes through a different tool:
1. Build `klipper.bin` ("USB to CAN bus bridge", correct pins, 1Mbit).
2. `sudo service klipper stop`.
3. Force bootloader: `flashtool.py -i can0 -r -u <uuid>` (or double-press RESET on the mainboard).
4. Upload via `dfu-util` (if the board is DFU-capable) or `flashtool.py -d /dev/serial/by-id/usb-katapult_<id>` (Katapult-USB).
5. Verify mainboard still enumerates as a CAN adapter (`lsusb` + `ip a` shows can0), then `sudo service klipper start`.

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

**VALIDATED 2026-08-16 on live hardware (Klipper Expander, STM32F042, DFU mode):**
- With no `.config`, `make -n flash` emits an **avrdude** line (AVR defaults) → the dfu-util scan falls through to the fallback, confirming it is the primary direct path.
- Resolved command: `dfu-util -d ,0483:df11 -R -a 0 -s 0x8000000:leave -D out/klipper.bin` (kconf `CONFIG_FLASH_APPLICATION_ADDRESS=0x8000000` honored, not hardcoded).
- After flash: `File downloaded successfully`, then **exit 251** (`can't detach` / `Resetting USB`) because the MCU left DFU and re-enumerated. Readback `dfu-util -U` → **byte-identical** to `klipper.bin`. Board stayed in DFU because BOOT0 jumper still asserted (expected; removing it boots the app).
- Permission: `/dev/bus/usb` DFU device is `root:root`; dfu-util as the backend user fails with `LIBUSB_ERROR_ACCESS` unless the standard udev rule exists. Added `/etc/udev/rules.d/98-stm32-dfu.rules` (`SUBSYSTEM=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="df11", MODE="0666"`) on the test host.

### 3. Klippy stop requirements per method
- **CAN `flashtool.py -i can0 -u`:** **required, not optional.** The canonical Esoterical CANBus guide (Voron community standard) makes `sudo service klipper stop` Step 2 of the update flow for both toolhead and mainboard. The bootloader-entry command (`flashtool.py -i can0 -r -u <uuid>`) and the actual flash (`-f`) are run with klipper stopped; then `sudo service klipper start` + `FIRMWARE_RESTART`. This means KWC's CAN flash path needs to orchestrate the klipper service stop/start around the job (via sudo service or Moonraker service control — KWC is in `moonraker.asvc`), or surface it as a hard pre-flight requirement. [IMPLEMENTATION NOTE]
- **`make flash` with a serial by-id `FLASH_DEVICE` (Voron's documented *update* flow for Spider/SKR Pico/Octopus):** **stop klipper first.** All three Voron build docs show the same sequence: `sudo service klipper stop` → `make flash FLASH_DEVICE=<serial id>` → `sudo service klipper start`. Reason: `flash_usb.py` pulses DTR@1200 on the USB-ACM serial device, which klippy holds open. This is the path KWC's `make flash` method resolves for an already-flashed MCU, so the stop requirement applies to the common in-app update case, not just CAN. [IMPLEMENTATION NOTE]
- **Direct `dfu-util -d ,<VID:PID>` (device already in DFU mode):** klippy does **not** need to stop — DFU is a separate USB interface from the serial port klippy holds. [VERIFY]
- **Serial `flashtool.py -d`:** klippy holds the serial device → stop Klipper (or accept the flash may fail on port contention). Esoterical's mainboard flow stops klipper first here too.

### 4. Safety: heaters in DFU mode
Klipper's `Bootloader_Entry.md` warns that on some boards (e.g., Octopus Pro v1) entering DFU mode "can cause undesired actions (such as powering the heater while in DFU mode). It is recommended to disconnect heaters." Voron's Octopus doc is blunter: "Do not leave HE0 or HE1 connected during initial flashing. There have been reports of Octopus boards turning on all heaters and fans as soon as you power up the board." Surface this warning for any STM32 DFU flash; the Octopus case is the concrete documented example. [VERIFY Spider-specific behavior on the Trident]

### 5. Spider-specific facts (Voron docs + Fysetc wiki)
- **There are multiple Spider board versions — the MCU/flash details vary.** Known versions: Spider V2.2, V2.3, V3.0 (and the original Spider); Fysetc's product pages list the V3.0 as STM32F446. The Voron docs' settings (STM32F446, 32KiB/64KiB bootloader offset, 12 MHz crystal, USB PA11/PA12) are a reference for a *specific* Spider revision — KWC must not hardcode one MCU/bootloader-offset assumption for "Spider". The user's actual menuconfig (the parsed kconf) is the ground truth for `CONFIG_FLASH_APPLICATION_ADDRESS` and `CONFIG_MCU` — the `:leave` address must come from there, not from a board-name lookup. [VERIFY which Spider revision Clifford has]
- Voron recommends USB (USB-A to USB-C between Spider and Pi); UART is possible but needs Fysetc config changes.
- **DFU entry (new install):** power off Spider → install jumper **BT0 to 3.3V** → connect USB → power on → `lsusb` to find DFU VID:PID → `make flash FLASH_DEVICE=<id>` → power off → **remove the BT0 jumper** → power on. The jumper removal step matters: leaving BT0 high keeps the MCU in the ROM bootloader (matches the `:leave` finding — the app can't boot while BOOT0/BT0 is asserted).
- **SD-card install (Fysetc's documented primary method):** rename `klipper.bin` → `firmware.bin` (must be renamed!), FAT32 (NOT exFAT), power down, insert card, power on. Post-flash confirmation: `ls /dev/serial/by-id` shows `usb-Klipper_stm32f446xx_...`.
- **Update flow (already running Klipper):** `sudo service klipper stop` → `make flash FLASH_DEVICE=<by-id serial>` → `sudo service klipper start` — no BT0 jumper needed (DTR trick), but klipper must be stopped.
- Klipper will not auto-update MCU firmware when the Pi-side Klipper updates — the docs explicitly call out that updates are manual. KWC's "flash" button is that manual step.
- Fysetc ships an SD-card bootloader (32k/64k variants); BOOT0/RESET pins exist and *can* be wired to the Pi's GPIO "through the switch (disconnected by default)". Whether Clifford's Spider DFU entry is automatable is an open question (below).

### 5b. DFU-mode flashing pattern (Voron Klipper_Expander guide — generic STM32 reference)
Voron's own DFU flashing flow for the Klipper Expander (STM32F042) documents the reusable pattern:
1. Install the boot jumper and reset the board → DFU mode.
2. `lsusb` → confirm "STM32 in DFU mode"; `dfu-util --list` → note `[xxxx:yyyy]`.
3. `make menuconfig` (do not configure `USB ids`).
4. `make clean` then `make flash FLASH_DEVICE=xxxx:yyyy`.
5. **dfu-util may print an error after a successful flash** — "caused by the controller immediately running the uploaded code and no longer appearing as a DFU device. This is not an issue, as long as the board reports a Klipper serial name." This is directly relevant to KWC's flash-result handling: a non-zero dfu-util exit after a successful download is expected behavior, not a failure — detect it by re-checking the serial/by-id for the Klipper device rather than trusting dfu-util's exit code.
6. Remove the boot jumper, press reset, confirm `/dev/serial/by-id/usb-Klipper_...`, and put that serial in `[mcu ...]`.

### 6. RP2040 (PIS/Hotkey)
`make flash` uses the USB bootrom via `picoboot` (`2e8a:0003`), or manual BOOTSEL + copy `klipper.uf2`. The MCU resets into the app automatically — no `:leave` equivalent, no power-cycle requirement.

### 7. flashtool `-q` query is single-node-only (affects KWC's device scan)
Katapult README: "A query should only be performed when a single can node is on the network. Attempting to query multiple nodes may result in transmission errors that can force a node into a 'bus off' state. When a node enters 'bus off' it becomes unresponsive. The node must be reset to recover."

KWC's CAN UUID scan (`flashtool.py -q` / canbus_query) runs while potentially multiple unassigned nodes are present (e.g., EBBCan in Katapult mode + Spider in Katapult mode simultaneously). Note that klippy only grabs `Application: Klipper` UUIDs — so any node sitting in Katapult mode (blinking status LED) is *unassigned* and answers queries, making the multi-node BUS-OFF scenario real. The scan should either (a) document this and rely on klippy-grabbed nodes being quiet, (b) skip the query when the user is mid-flash, or (c) tolerate a BUS-OFF recovery. [IMPLEMENTATION NOTE]

### 8. Katapult deployer / brick risk (KWC has a Katapult target)
The README's deployer section warns: "Overwriting your existing bootloader with an incorrectly configured build will brick your device and require a programmer to recover." A stock bootloader backup is strongly recommended before deployment. For KWC's Katapult target, flashing a *new* Katapult build over an existing Katapult should prefer the deployer path (flash `deployer.bin` through the existing bootloader) over a raw write, and the UI should warn about the brick risk. [IMPLEMENTATION NOTE]

## Open questions for Clifford

1. Which Spider revision is on the Trident (V2.2 / V2.3 / V3.0 / original)? Determines the MCU (likely STM32F446 for V2.2+/V3.0) and bootloader offset — but the parsed kconf is the real ground truth for the `:leave` address either way.
2. How do you actually flash the Spider today — SD card (Fysetc bootloader), DFU via BT0/BOOT0 jumper, or Katapult? Decides which method paths are primary for Trident validation.
3. Is the Spider's BOOT0/RESET switch wired to the Pi's GPIO? If yes, DFU entry could be automated.
4. Does the EBBCan toolhead run Katapult, and is the `canbus_uuid` constant across your reflashes?
5. OK to surface the "disconnect heaters before DFU" warning for the Spider?
6. Apply the dfu-util `:leave` flag correction now (one line + test) or bundle with the Phase 7 feature decision?

## Sources

- Klipper `scripts/flash_usb.py` (master) — flash path per MCU type incl. `flash_stm32f4`, `flash_rp2040`
- Klipper `src/stm32/Makefile` (master) — `flash:` rule → `flash_usb.py -t $(CONFIG_MCU) -d "$(FLASH_DEVICE)" -s "$(CONFIG_FLASH_APPLICATION_ADDRESS)"`
- Klipper `docs/Bootloader_Entry.md` — bootloader request methods (1200-baud DTR, serial string, CAN admin message), STM32 DFU heater warning
- Klipper `docs/Bootloaders.md` — STM32F4 section (ROM bootloader via USB DFU; some boards can't enter DFU; HID bootloader alternative)
- Klipper `docs/CANBUS.md` — UUID derivation from chip identifier; `canbus_query.py` only reports uninitialized devices
- Klipper `docs/FAQ.md` — stable `/dev/serial/by-id/...` names; `FIRMWARE_RESTART` usage
- dfu-util man page — `-R` (USB reset signalling), `-e` (detach), `-s ADDRESS[:LENGTH][:MODIFIERS]` with `:leave`
- Katapult README (Arksine/katapult) — upload flow requires `klipper` service stopped; flashtool auto bootloader entry for plain USB/CAN devices; USB-to-CAN-bridge + UART devices cannot be auto-detected (need `-r` first, then `dfu-util`/`flashtool.py -d` upload); `-q` is single-node-only (multi-node query risks BUS-OFF); deployer brick warning; `-r` prints "Flash success" but exits without uploading
- katapult issue #114 (EBB42) + Esoterical CANBus guide — stop Klipper to release CAN bus device before flashing
- **Esoterical CANBus guide** (canbus.esoterical.online) — canonical update flows: `toolhead_klipper_updating.html`, `mainboard_klipper_updating.html`, `katapult_updating.html`, `troubleshooting/no_uuid.html`. Confirms: klipper stop is a required step for CAN flashes; `flashtool.py -r` is the bootloader-entry command (prints "Flash success" but flashes nothing); double-press RESET is the manual fallback; UUID grab/query semantics; BUS-OFF recovery; `usb-katapult-*` vs Klipper-mode serial paths
- Fysetc Spider wiki + FYSETC-SPIDER repo `bootloader/README.md` — SD-card bootloader, BOOT0/RESET switch wiring; multiple Spider revisions (V2.2/V2.3/V3.0), so MCU/offset must come from the parsed kconf, not a board-name lookup
- **Voron Design build docs** (docs.vorondesign.com/build/software/) — `spider_klipper.html`, `skrPico_klipper.html`, `octopus_klipper.html`: per-board menuconfig settings (Spider = STM32F446, 32KiB/64KiB bootloader offset, 12 MHz, USB PA11/PA12); DFU new-install = BT0 jumper + power cycle + jumper removal; SD-card = rename to `firmware.bin` + FAT32; update flow = `sudo service klipper stop` → `make flash FLASH_DEVICE=<serial by-id>` → `sudo service klipper start` (all three boards); Octopus heater warning; post-flash confirm via `ls /dev/serial/by-id` showing `usb-Klipper_stm32f446xx_...` / `usb-Klipper_rp2040_...`
- **Voron Klipper_Expander guide** (VoronHardware `Klipper_Expander/Documentation/Setup_and_Flashing_Guide.md`) — generic STM32 DFU pattern: boot jumper + reset → DFU; `lsusb`/`dfu-util --list`; `make flash FLASH_DEVICE=xxxx:yyyy`; **dfu-util error after successful flash is expected** (MCU runs the code and leaves DFU) — verify via serial/by-id, not exit code; remove jumper + reset; copy `usb-Klipper_...` serial into `[mcu ...]`
- Klipper discourse 13151 — "no UUID after flashing klipper" root causes

## Verification checklist (real Trident — Clifford must accept the risk first)

Per method: record pre-flash identity → flash → confirm MCU state → recommended post-step → `query_klipper_status` green.

- [ ] `make flash` DFU path: `dfu-util` command shown by `make -n flash`; confirm `:leave` present with the correct app address (0x08008000 for 32KiB bootloader); confirm app boots after flash (no manual power cycle)
- [ ] Direct dfu-util with corrected flags: exit DFU, app boots, `FIRMWARE_RESTART` reconnects; a dfu-util non-zero exit right after "File downloaded successfully" is expected (Klipper_Expander guide) — confirm via serial/by-id instead
- [ ] Spider DFU entry: BT0 jumper + power cycle; jumper removal required for app boot
- [ ] flashtool CAN: klipper stopped first; `-r` bootloader entry + `-q` verify; UUID unchanged across flash; `service klipper start` + `FIRMWARE_RESTART` suffices
- [ ] flashtool serial: by-id path switches to `usb-katapult-*` during flash and returns after; klipper stopped first
- [ ] RP2040: app boots after picoboot/UF2; `FIRMWARE_RESTART` suffices
- [ ] Klipper restart via KWC socket (`gcode/firmware_restart`) returns green state
