# Klipper Docs AI Summary

This file is a condensed index of the Klipper documentation most useful for configuration help, G-Code guidance, macro authoring, runtime commands, and common tuning workflows.

Use these sections for fast grounding. For exact section names, parameter names, defaults, units, and supported syntax, prefer Config_Reference.md and the cited source documents.

## Config file structure and conventions
Aliases: config, configuration, printer.cfg, include, section names, pins, save_config, restart, migration
Source docs: Config_Reference.md, Config_checks.md, FAQ.md, Config_Changes.md

- Use exact Klipper section headers and parameter names from the docs. Do not invent aliases or Marlin-style substitutes.
- Many runtime tuning commands change live state first; use SAVE_CONFIG when the docs say the result should be written back to disk, then RESTART so the saved values are reloaded cleanly.
- Configfile warnings, deprecated fields, and renamed parameters should be checked against Config_Changes.md during upgrades or when old examples stop working.
- Pin notation matters: inverted pins and pull-up or pull-down modifiers are declared in the config, not inferred by the firmware.
- When a config question is about a specific section, prefer the exact section entry from Config_Reference.md for supported options, units, and defaults.

Need more detail? Ask for the full source docs above by filename. If local markdown is unavailable, use https://www.klipper3d.org/<document_name>.html.

## Motion, homing, and stepper configuration
Aliases: motion, kinematics, homing, endstop, stepper, max_velocity, max_accel, microsteps, rotation_distance
Source docs: Config_Reference.md, Kinematics.md, Config_checks.md, Bed_Level.md, Rotation_Distance.md

- Motion setup depends on correct stepper section wiring, rotation_distance, microsteps, endstop configuration, and homing direction.
- Klipper motion behavior is shaped by kinematics, acceleration limits, velocity limits, and look-ahead; poor values can look like firmware issues when the root cause is config.
- Rotation_distance is the preferred calibration value for axis and extruder movement because it maps physical travel to one full motor rotation.
- Before tuning motion, verify endstops, motor direction, and safe travel with the validation workflow in Config_checks.md.
- Use the leveling and homing docs for procedure choices, but use Config_Reference.md when you need the exact option set for the active printer kinematics.

Need more detail? Ask for the full source docs above by filename. If local markdown is unavailable, use https://www.klipper3d.org/<document_name>.html.

## Heaters, sensors, and fans
Aliases: heater, extruder temp, bed temp, thermistor, pid, fan, heater_fan, controller_fan, temperature
Source docs: Config_Reference.md, Config_checks.md, G-Codes.md, FAQ.md

- Heater setup depends on correct sensor type, sensor pin, heater pin, control method, and safe min or max temperature limits.
- Validation should start with temperature reporting and emergency-stop behavior before any long heating test.
- Use the documented temperature commands when discussing runtime control: M104 or M109 for extruders, M140 or M190 for the bed, and M106 or M107 for fans.
- PID tuning and heater verification should follow the documented workflow so saved values reflect measured behavior instead of guesses.
- Fan behavior and tachometer support are section-specific; use Config_Reference.md for the exact supported options in fan, heater_fan, and controller_fan sections.

Need more detail? Ask for the full source docs above by filename. If local markdown is unavailable, use https://www.klipper3d.org/<document_name>.html.

## Probes, leveling, and bed mesh
Aliases: probe, probing, bltouch, bed mesh, leveling, z offset, probe_calibrate, horizontal_move_z, mesh profile
Source docs: Config_Reference.md, Probe_Calibrate.md, Bed_Level.md, Bed_Mesh.md, BLTouch.md, G-Codes.md

- Calibrate probe offsets before depending on bed mesh results. Probe X or Y alignment and probe Z offset directly affect mesh usefulness.
- Bed leveling and bed mesh solve different problems: first decide whether the printer needs manual leveling, screw adjustment, gantry alignment, probe calibration, or surface compensation.
- Common runtime commands in this area include PROBE_CALIBRATE, BED_MESH_CALIBRATE, BED_MESH_PROFILE, BED_MESH_CLEAR, and BED_MESH_OUTPUT.
- Bed mesh runtime behavior matters: `BED_MESH_CALIBRATE` makes the mesh active immediately and stores it to the named profile or `default`; `BED_MESH_PROFILE SAVE` or `REMOVE` needs `SAVE_CONFIG` to persist; `BED_MESH_PROFILE LOAD=default` is typically called from `START_PRINT` or a `[delayed_gcode]` if you are not recalibrating there; `BED_MESH_OUTPUT PGP=1` prints generated points; `BED_MESH_OFFSET ZFADE=...` compensates for tool or Z-offset changes during mesh fade.
- horizontal_move_z is a bed_mesh safety travel height used during probing or mesh traversal; adjust it conservatively when clearance is uncertain.
- BLTouch-style devices have extra wiring, mode, and clone-specific caveats, so hardware-specific advice should cite BLTouch.md and the related config section.

Need more detail? Ask for the full source docs above by filename. If local markdown is unavailable, use https://www.klipper3d.org/<document_name>.html.

## G-Code commands and runtime control
Aliases: gcode, commands, command, runtime, terminal, g28, m112, m114, m104, m109, m140, m190, set_ commands
Source docs: G-Codes.md, API_Server.md, Config_Reference.md

- Klipper supports common standard G-Code commands plus many extended Klipper commands for configuration, calibration, and status.
- Extended Klipper commands use a command name followed by KEY=VALUE parameters and are documented by module in G-Codes.md.
- The docs list commands in uppercase, but command names are case-insensitive.
- Prefer extended Klipper commands over undocumented legacy commands when the docs already provide a named Klipper workflow.
- Human-readable terminal output is not a stable machine API; external integrations should use the API server when they need structured status or subscriptions.

Need more detail? Ask for the full source docs above by filename. If local markdown is unavailable, use https://www.klipper3d.org/<document_name>.html.

## Macros, templates, and delayed G-Code
Aliases: macro, macros, gcode_macro, jinja, template, params, rawparams, delayed_gcode, save_gcode_state, restore_gcode_state
Source docs: Command_Templates.md, Status_Reference.md, G-Codes.md

- gcode_macro names are case-insensitive, but numeric suffixes must stay at the end of the macro name.
- Indentation in gcode: blocks is significant. The gcode: key stays at the left margin and the generated G-Code lines remain indented beneath it.
- Wrap movement macros with SAVE_GCODE_STATE and RESTORE_GCODE_STATE when they depend on parsing state such as G90, G91, M82, M83, or prior G1 state.
- Macro templates use Jinja2. params values are uppercase and arrive as strings, rawparams contains the unparsed original argument string, and printer.* exposes runtime state.
- Actions, delayed_gcode, and SET_GCODE_VARIABLE are useful, but timing matters because macros are rendered first and the resulting commands execute afterward.

Need more detail? Ask for the full source docs above by filename. If local markdown is unavailable, use https://www.klipper3d.org/<document_name>.html.

## Status objects and printer introspection
Aliases: status, printer, printer state, status reference, introspection, configfile, gcode_move, toolhead, display_status
Source docs: Status_Reference.md, Command_Templates.md, API_Server.md, Config_Changes.md

- printer.<object> usually maps to a config section or module object, and objects with spaces in their section names use bracket access such as printer["generic_heater chamber"].
- Common macro-debugging objects include configfile, gcode, gcode_move, toolhead, display_status, bed_mesh, and gcode_macro variables.
- configfile.settings and configfile.config reflect the last restart state, while save_config_pending shows whether runtime updates still need to be written.
- gcode.commands can reveal what commands are currently available, and gcode_move or toolhead fields help when diagnosing coordinate or motion state.
- Status fields can change across Klipper releases, so upgrade-sensitive advice should cross-check Config_Changes.md.

Need more detail? Ask for the full source docs above by filename. If local markdown is unavailable, use https://www.klipper3d.org/<document_name>.html.

## Extruder calibration, pressure advance, and TMC drivers
Aliases: extruder, e steps, esteps, rotation distance, pressure advance, tuning tower, tmc, stealthchop, spreadcycle, motor current
Source docs: Rotation_Distance.md, Pressure_Advance.md, TMC_Drivers.md, Config_Reference.md, G-Codes.md

- Use rotation_distance instead of legacy steps_per_mm style reasoning when calibrating Klipper axis or extruder movement.
- Pressure advance compensates for extrusion lag and is typically tuned with a documented TUNING_TOWER workflow instead of guessing values from slicer profiles.
- TMC driver advice should focus on run_current, wiring, and the documented spreadCycle or stealthChop tradeoffs before assuming skipped steps are firmware bugs.
- The TMC docs explicitly caution against unnecessary hold_current changes unless there is a documented reason for them.
- Final values still belong in the relevant Config_Reference.md sections so section names, option names, and units stay exact.

Need more detail? Ask for the full source docs above by filename. If local markdown is unavailable, use https://www.klipper3d.org/<document_name>.html.

## Resonance, accelerometers, and input shaping
Aliases: resonance, input shaper, adxl345, accelerometer, ringing, shaper, resonance compensation
Source docs: Measuring_Resonances.md, Resonance_Compensation.md, G-Codes.md, Config_Reference.md

- Resonance tuning depends on correct accelerometer support, wiring, and measurement workflow before any input shaper values are trusted.
- Measuring_Resonances.md covers hardware setup and data capture, while Resonance_Compensation.md explains how the measured ringing is turned into shaper choices.
- The relevant runtime commands and measurement steps should come from the docs, especially when the printer uses external sensor hardware.
- Input shaper and resonance compensation improve motion quality, but they do not replace correct belts, frame rigidity, or sane acceleration limits.
- Keep final configuration edits grounded in the matching Config_Reference.md sections after measurements are complete.

Need more detail? Ask for the full source docs above by filename. If local markdown is unavailable, use https://www.klipper3d.org/<document_name>.html.

## Troubleshooting, migrations, API, and specialized topics
Aliases: troubleshooting, config changes, faq, api, exclude object, canbus, delta, eddy, load cell, specialized hardware
Source docs: Config_Changes.md, FAQ.md, API_Server.md, Exclude_Object.md, Config_Reference.md

- When working from old guides or sample configs, check Config_Changes.md early so renamed fields or removed options do not masquerade as parser or firmware errors.
- FAQ.md is the right first source for common serial, flashing, restart, and migration questions that are adjacent to configuration work.
- API_Server.md is the authoritative source for JSON-RPC requests, subscriptions, and structured integration behavior.
- Exclude_Object.md is relevant when the user needs object-level print cancellation or slicer-integrated object definitions.
- If the problem depends on specialized hardware or niche printer architectures, ask for the exact hardware and then pull the corresponding full source docs instead of extrapolating from generic guidance.

Need more detail? Ask for the full source docs above by filename. If local markdown is unavailable, use https://www.klipper3d.org/<document_name>.html.