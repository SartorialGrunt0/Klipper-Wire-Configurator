# Complete Klipper Configuration Error Catalog

*Compiled from the [Klipper3d/klipper](https://github.com/Klipper3d/klipper) source tree — every `config_error`, `configfile.error`, `pins.error`, and config-time `error()` raised during printer.cfg parsing.*

---

## LEVEL 0 — Parsing & Include Resolution (`configfile.py`)

These fire **before any module loads** — raw INI parsing and include resolution.

| Error | Trigger |
|---|---|
| `Unable to open config file <filename>` | Config file doesn't exist or can't be read |
| `Include file '<glob>' does not exist` | Explicit `[include]` path has no match (wildcards are OK — they can return empty) |
| `Recursive include of config file '<filename>'` | Circular `[include]` chain (A includes B includes A) |
| `Option '<name>' in section '<section>' must be specified` | Required option missing entirely |
| `Unable to parse option '<name>' in section '<section>'` | Wrong type (e.g. string where int/float expected) |
| `Option '<name>' in section '<section>' must have minimum of <n>` | Value below per-field `minval` |
| `Option '<name>' in section '<section>' must have maximum of <n>` | Value above per-field `maxval` |
| `Option '<name>' in section '<section>' must be above <n>` | Value ≤ `above` threshold (strictly greater) |
| `Option '<name>' in section '<section>' must be below <n>` | Value ≥ `below` threshold (strictly less) |
| `Choice '<val>' for option '<name>' in section '<section>' is not a valid choice` | Value not in the allowed set |
| `Option '<name>' in section '<section>' must have <n> elements` | List has wrong `count` |
| `Section '<name>' is not a valid config section` | Section not registered by any loaded module |
| `Option '<name>' is not valid in section '<section>'` | Option never read by the module that owns the section |

The last two are the most common "your config is wrong" errors — they fire **after all modules finish loading** and compare every key in every section against what modules actually read.

---

## LEVEL 1 — Pin Validation (`pins.py`)

| Error | Trigger |
|---|---|
| `Pin <pin> reserved for <a> - can't reserve for <b>` | Two modules both claim the same pin |
| `Alias <alias> mapped to <pin> - can't alias to <other>` | Alias already points elsewhere |
| `Invalid pin alias '<alias>'` | Alias contains `^~!:` or whitespace |
| `pin <pin> is an alias for <other>` | Conflict with existing alias mapping |
| `pin <pin> is reserved for <name>` | Used as alias but was previously reserved |
| `Unknown pin chip name '<name>'` | MCU chip name doesn't exist |
| `Invalid pin description '<val>'` | Pin string malformed (wrong chars or whitespace) |
| `pin <pin> used multiple times in config` | Same physical pin assigned to two outputs |
| `Shared pin <pin> must have same polarity` | Shared endstop pins with mismatched invert/pullup |
| `Unknown chip name '<name>'` | No resolver registered for this MCU chip |
| `Duplicate chip name '<name>'` | MCU registered twice |

---

## LEVEL 2 — MCU Configuration (`mcu.py` + `stepper.py`)

| Error | Trigger |
|---|---|
| `Multi-mcu homing not supported on multi-mcu shared axis` | Two MCUs driving the same axis — multi-MCU homing only works on dedicated axes |
| `ADC sample_count=<n> too large for MCU` | ADC `sample_count * MAX` overflows 16-bit |
| `Pin '<pin>' is not a valid pin name on mcu '<name>'` | MCU firmware doesn't recognize the pin name |
| `Pin with max duration must have start value equal to shutdown value` | Digital/PWM `max_duration` set but start ≠ shutdown values |
| `Digital pin max duration too large` | Duration ticks ≥ 2^31 |
| `PWM pin max duration too large` | Same for PWM |
| `shutdown value must be 0.0 or 1.0 on soft pwm` | Software PWM restriction |
| `PWM pin cycle time too large` | Cycle ticks ≥ 2^31 |
| `pin type <type> not supported on mcu` | Only `endstop`, `digital_out`, `pwm`, `adc` allowed |
| `Stepper dir pin must be on same mcu as step pin` | Dir & step pins on different MCUs |
| `Attempt MCU '<name>' restart failed` | Firmware restart didn't take effect |
| `MCU '<name>' error during config: <msg>` | MCU in shutdown during handshake |
| `Can not update MCU '<name>' config as it is shutdown` | MCU won't accept config commands |
| `Failed automated reset of MCU '<name>'` | Expected reset didn't happen |
| `MCU '<name>' CRC does not match config` | Config CRC mismatch after upload |
| `Unable to configure MCU '<name>'` | Config commands sent but didn't take effect |
| `Too few moves available on MCU '<name>'` | Insufficient move queue slots |
| `Too high clock speed for MCU '<name>'...` | Clock too fast for max nominal duration |
| `Internal error! MCU already configured` | Config modification after finalization |

---

## LEVEL 3 — Kinematics

### `generic_cartesian.py`

| Error | Trigger |
|---|---|
| `At least one stepper must be associated with carriage: <name>` | Rail has no steppers assigned |
| `primary_carriage = '<name>' for '<section>' is not a valid choice` | Primary carriage name doesn't exist |
| `Mismatching axes between carriage '<a>' and dual_carriage '<b>'` | Primary and dual carriage axes differ |
| `Multiple dual carriages ('<a>', '<b>') for carriage '<c>'` | More than one dual carriage for the same primary |
| `Invalid axis '<x>' for dual_carriage '<name>'` | Only X/Y allowed for dual carriages |
| `Axis '<name>' is set for multiple primary carriages` | Two carriages claim the same axis |
| `No carriage defined for axis '<name>'` | Required axis has no carriage |
| `Redefinition of carriage <name>` | Duplicate carriage name |
| `Carriage(s) <names> must be referenced by some stepper(s)` | Unreferenced carriage after stepper association |
| `Multi-mcu homing not supported on multi-mcu shared carriage <name>` | Shared carriage across MCUs |
| `Verify configured stepper(s)... does not allow independent movements` | Singular kinematics matrix |

### `kinematic_stepper.py`

| Error | Trigger |
|---|---|
| `Invalid term '<term>' in '<string>'` | Malformed `carriages` specification |
| `Invalid float '<val>'` | Coefficient parse failure |
| `Invalid '<name>' carriage referenced in '<string>'` | Carriage name doesn't exist |
| `Axis '<x>' was referenced multiple times by carriages in '<string>'` | Same axis used twice in one carriages string |
| `'<name>' must provide a valid 'carriages' configuration` | All coefficients are zero (stepper does nothing) |
| `A valid string that references at least one carriage must be provided for '<name>'` | No carriages referenced |

### `idex_modes.py`

| Error | Trigger |
|---|---|
| `At least one stepper must be associated with carriage: <name>` | Rail has no steppers |

---

## LEVEL 4 — Module Validation

### Steppers, Homing, Probing

| Error | Source |
|---|---|
| `Unknown stepper '<name>'` | `stepper_enable.py` / `force_move.py` |
| `Missing Z endstop config for safe_z_homing` | `safe_z_home.py` |
| `homing_override and safe_z_homing cannot be used simultaneously` | `safe_z_home.py` |
| `<section> requires multiple z steppers` | `z_tilt.py` |
| `<section> z_positions needs exactly <n> items` | `z_tilt.py` |
| `Need exactly 4 probe points for quad_gantry_level` | `quad_gantry_level.py` |
| `quad_gantry_level requires at least two gantry_corners` | `quad_gantry_level.py` |
| `One or more of these heaters are unknown: <names>` | `homing_heaters.py` |
| `One or more of these steppers are unknown: <names>` | `homing_heaters.py` / `controller_fan.py` |
| `Need at least <n> probe points for <name>` | `probe.py` |
| `bed_screws: Must have at least three screws` | `bed_screws.py` |
| `screws_tilt_adjust: Must have at least three screws` | `screws_tilt_adjust.py` |

### Bed Mesh (`bed_mesh.py`)

| Error | Condition |
|---|---|
| `bed_mesh: malformed '<opt>' value: <val>` | Integer list option has >2 elements |
| `Option '<opt>' in section bed_mesh must have a minimum of <n>` | Pair value too low |
| `Option '<opt>' in section bed_mesh must have a maximum of <n>` | Pair value too high |
| `bed_mesh: probe_count must be odd for round beds` | Even count on round bed |
| `bed_mesh: invalid min/max points` | max ≤ min on any axis |
| `bed_mesh: Unknown algorithm <name>` | Not `bicubic` or `lagrange` |
| `bed_mesh: cannot exceed a probe_count of 6 when using lagrange interpolation` | Lagrange with probe count > 6 |
| `bed_mesh: invalid probe_count option when using bicubic interpolation` | 3 on one axis + >6 on another |
| `bed_mesh: Existing faulty_region_<n> <a> overlaps added faulty_region_<m> <b>` | Overlapping exclusion regions |
| `bed_mesh: Added faulty_region_<n> <a> overlaps existing faulty_region_<m> <b>` | Reverse overlap |

### TMC Drivers

#### `tmc.py`

| Error | Condition |
|---|---|
| `Could not find config section '[<section>]' required by tmc driver` | Stepper section referenced by TMC driver doesn't exist |
| `tmc virtual endstop only useful as endstop` | `setup_pin` called with non-`endstop` `pin_type` |
| `Can not pullup/invert tmc virtual pin` | Virtual endstop with invert or pullup set |
| `tmc virtual endstop requires diag pin config` | No `diag_pin` configured for virtual endstop |

#### `tmc_uart.py`

| Error | Condition |
|---|---|
| `TMC mux pins must be on the same mcu` | `select_pins` on a different MCU |
| `All TMC mux instances must use identical pins` | Different pins registered for same mux |
| `Shared TMC uarts must use the same pins` | Different rx/tx on shared UART |
| `Shared TMC uarts need unique address or select_pins polarity` | Duplicate UART address on same mux |
| `TMC uart rx and tx pins must be on the same mcu` | Different MCUs for rx and tx |

#### `tmc2130.py`

| Error | Condition |
|---|---|
| `TMC SPI chain must have same length` | Inconsistent `chain_length` on shared SPI bus |
| `TMC SPI chain can not have duplicate position` | Duplicate `chain_position` |

#### `tmc2660.py`

| Error | Condition |
|---|---|
| `driver_HEND + driver_HSTRT must be <= 15` | SpreadCycle mode with HEND+HSTRT > 15 (field overflow) |

### Heaters & Sensors

| Error | Source |
|---|---|
| `Cannot load config '<file>'` | `heaters.py` / `display.py` — failed to read included file |
| `Heater <name> already registered` | `heaters.py` |
| `Unknown heater '<name>'` | `heaters.py` |
| `Unknown temperature sensor '<type>'` | `heaters.py` |
| `G-Code sensor id <id> already registered` | `heaters.py` |
| `'<name>' does not have a status.` | `temperature_combined.py` |
| `'<name>' does not report a temperature.` | `temperature_combined.py` |
| `Temperature monitor '<name>' is not supported` | `temperature_combined.py` |
| `MCU temperature not supported on <type>` | `temperature_mcu.py` — MCU type unknown |
| `Unable to open temperature file '<path>'` | `temperature_host.py` |
| `hall_filament_width_sensor: raw_dia1 and raw_dia2 must be different` | `hall_filament_width_sensor.py` |
| `hall_filament_width_sensor: max_difference must be less than default_nominal_filament_diameter` | `hall_filament_width_sensor.py` |
| `Invalid HTU21D Resolution. Valid are: <options>` | `htu21d.py` |
| `Invalid rate parameter: <n>` | `mpu9250.py` / `adxl345.py` |
| `adc_scaled only supports adc pins` | `adc_scaled.py` |
| `vref and vssa must be on same mcu` | `adc_scaled.py` |
| `Invalid polynomial in drift calibration` | `temperature_probe.py` |
| `Invalid calibration detected, curve at index <n> overlaps previous curve at temp <t>C` | `temperature_probe.py` |

### Input Shaper & Accelerometers

| Error | Source |
|---|---|
| `Unsupported shaper type: <type>` | `input_shaper.py` |
| `Input shaper parameters cannot be configured via [input_shaper] section with dual_carriage(s) enabled` | `input_shaper.py` |
| `Failed to configure shaper(s) <names> with given parameters` | `input_shaper.py` |
| `Failed to initialize shaper: <error>` | `shaper_defs.py` |
| `'<name>' is not an accelerometer` | `resonance_tester.py` |
| `Invalid axes_map parameter` | `adxl345.py` |
| `Accelerometer with name '<name>' already defined` | `adxl345.py` |
| `Default accelerometer already defined; section must include an additional name, e.g. '<name> my_name'` | `adxl345.py` |

### Displays & Menus

| Error | Source |
|---|---|
| `Section name '<name>' is not valid` | `display.py` — wrong `display_template` format |
| `Option '<opt>' in section '<name>' is not a valid literal` | `display.py` |
| `Unable to parse 'position' in section '<name>'` | `display.py` |
| `Invalid glyph line in <name>` | `display.py` |
| `Glyph <name> incorrect lines` | `display.py` |
| `Cannot load config '<file>'` | `display.py` / `menu.py` |
| `A primary [display] section must be defined in printer.cfg to use auxiliary displays` | `display/__init__.py` |
| `Section name [display display] is not valid. Please choose a different postfix.` | `display/__init__.py` |
| `Unknown menuitem '<name>'` | `menu.py` |
| `Choice '<type>' for option '<menu_items>' is not a valid choice` | `menu.py` |

### LEDs, PWM, Pins

| Error | Source |
|---|---|
| `color_order does not match chain_count` | `neopixel.py` |
| `Invalid color_order '<val>'` (not RGB/RGBW permutation) | `neopixel.py` / `pca9632.py` |
| `neopixel chain too long` (>500 elements) | `neopixel.py` |
| `Dotstar pins must be on same mcu` | `dotstar.py` |
| `No LED pin definitions found in '<section>'` | `led.py` |
| `Pin with max duration must have start value equal to shutdown value` | `pwm_tool.py` |
| `PWM pin cycle time too large` | `pwm_tool.py` / `pwm_cycle_time.py` |
| `PWM pin max duration too large` | `pwm_tool.py` |
| `shutdown value must be 0.0 or 1.0 on soft pwm` | `pwm_cycle_time.py` |
| `Frequency output must be without remainder, <mcu_freq> != <actual>` | `static_pwm_clock.py` |
| `%d steps per detent not supported` | `buttons.py` |

### Macros & G-Code

| Error | Source |
|---|---|
| `Error loading template '<name>': <error>` | `gcode_macro.py` |
| `Name of section '<name>' contains illegal whitespace` | `gcode_macro.py` |
| `G-Code macro rename of different types ('<a>' vs '<b>')` | `gcode_macro.py` |
| `Option '<opt>' in section '<name>' is not a valid literal: <error>` | `gcode_macro.py` |
| `Existing command '<name>' not found in gcode_macro rename` | `gcode_macro.py` |
| `G-Code move transform already specified` | `gcode_move.py` |
| `gcode command <cmd> already registered` | `gcode.py` |
| `Can't register '<cmd>' as it is an invalid name` | `gcode.py` |
| `mux command <cmd> <key> <val> may have only one key (<other>)` | `gcode.py` |
| `mux command <cmd> <key> <val> already registered (<existing>)` | `gcode.py` |

### Webhooks / API Server

| Error | Source |
|---|---|
| `mux endpoint <path> <key> <val> may have only one key (<other>)` | `webhooks.py` |
| `mux endpoint <path> <key> <val> already registered (<existing>)` | `webhooks.py` |

### SPI / I2C Bus (`bus.py`)

| Error | Condition |
|---|---|
| `Must specify %s on mcu '<name>'` | Required bus parameter missing and no default (bus 0) |
| `Unknown %s '<val>'` | Invalid bus number not in MCU enumeration |
| `%s: spi pins must be on same mcu` | Software SPI pins (miso/mosi/sclk) on different MCUs |
| `%s: i2c pins must be on same mcu` | Software I2C pins (scl/sda) on different MCUs |
| `Pin %s must be on mcu %s` | Bus-synchronized digital output on wrong MCU |

### Multi-pin

| Error | Source |
|---|---|
| `multi_pin %s not configured` | `multi_pin.py` |
| `Can't setup multi_pin %s twice` | `multi_pin.py` |

### Misc Hardware

| Error | Source |
|---|---|
| `Palette 2 requires [virtual_sdcard] to work, please add it to your config!` | `palette2.py` |
| `Palette 2 requires [pause_resume] to work, please add it to your config!` | `palette2.py` |
| `Invalid serial port specific for Palette 2` | `palette2.py` |
| `Delta calibrate is only for delta printers` | `delta_calibrate.py` |
| `Duplicate canbus_uuid` | `canbus_ids.py` |
| `Unknown canbus_uuid <uuid>` | `canbus_ids.py` |
| `mcp4451 address must be between 44 and 47` | `mcp4451.py` |
| `ADS1220 config error: AIN0/REFP1 and AIN3/REFN1 can't be used as a voltage reference and an input at the same time` | `ads1220.py` |
| `ADS1220 config error: SPI communication and data_ready_pin must be on the same MCU` | `ads1220.py` |
| `pwm_clock '<name>' must support and specify a 'frequency' parameter` | `ads131m0x.py` |
| `Requested sample rate <r> Hz is not available with the configured parameters` | `ads131m0x.py` |
| `<name> config error: All pins must be connected to the same MCU` | `hx71x.py` |
| `ldc1612 intb_pin must be on same mcu` | `ldc1612.py` |

### Module Loading (`klippy.py`)

| Error | Condition |
|---|---|
| `Printer object '<name>' already created` | Two config sections with the same name |
| `Unable to load module '<section>'` | No Python file exists for the section name |
| `Unable to load module '<section>'` | Module has no `load_config` or `load_config_prefix` function |
| `Unknown config object '<name>'` | Module not found via `printer.lookup_object()` |

---

## Summary

| Category | Unique Error Templates |
|---|---|
| Parsing / INI (configfile.py) | ~13 |
| Pin validation (pins.py) | ~11 |
| MCU config/connection (mcu.py + stepper.py) | ~19 |
| Kinematics | ~18 |
| TMC drivers | ~12 |
| Steppers / Homing / Probing | ~12 |
| Bed mesh | ~10 |
| Heaters / Sensors | ~17 |
| Input shaper / accelerometers | ~8 |
| Displays & menus | ~10 |
| LEDs / PWM / pins | ~10 |
| Macros & G-Code | ~10 |
| Webhooks / API | ~2 |
| SPI / I2C bus | ~5 |
| Multi-pin | ~2 |
| Misc hardware | ~13 |
| Module loading | ~4 |
| **Total** | **~200** |

Numeric `minval`/`maxval` bounds differ per field — the actual validation surface is even larger. This catalog covers every distinct **message template** that can appear as a configuration error during Klipper startup.

*Generated from [Klipper3d/klipper](https://github.com/Klipper3d/klipper) — all source files under `klippy/` examined systematically.*
