# Klipper G-Code and Macro AI Summary

Compact grounding for chat when G-code or macro topics appear.

Primary sources: `G-Codes.md`, `Command_Templates.md`, `Config_Reference.md`, `Status_Reference.md`, `Config_Changes.md`, `Bed_Mesh.md`, `Probe_Calibrate.md`, `Delta_Calibrate.md`, `Measuring_Resonances.md`, `Resonance_Compensation.md`, `TMC_Drivers.md`, `Exclude_Object.md`, `Slicers.md`, `Using_PWM_Tools.md`.

- Use exact Klipper spellings from the docs. Extended commands are case-insensitive and use `COMMAND KEY=VALUE` syntax.
- Many commands only exist when the matching config section or module is enabled.
- Runtime calibration commands often change live state first. Use `SAVE_CONFIG` when the docs say to persist, then `RESTART` or `FIRMWARE_RESTART` as appropriate.
- Human-readable terminal output is not a stable machine API. Use `API_Server.md` for structured integrations.

## Macro rules

- Any `[gcode_macro NAME]` creates a callable command. Macro names are case-insensitive; numeric suffixes must stay at the end.
- `gcode:` indentation matters. The key stays flush-left; emitted G-code stays indented under it.
- Macros are fully rendered before the emitted commands run. State changes made by early commands are not visible to later template evaluation in the same macro.
- `params` keys arrive uppercase and as strings. `rawparams` is the original unparsed argument tail.
- For movement macros, save state with `SAVE_GCODE_STATE`, explicitly set `G90` or `G91`, give the first `G0` or `G1` an explicit `F`, then `RESTORE_GCODE_STATE`.
- Interactive tool subcommands only exist while their tool is active: `ACCEPT`, `ABORT`, `TESTZ Z=...`, `TARE`, `CALIBRATE GRAMS=...`.
- Template helpers are not terminal G-code commands: `action_respond_info(msg)`, `action_raise_error(msg)`, `action_emergency_stop(msg)`, `action_call_remote_method(method_name, ...)`, `menu.back(force, update)`, `menu.exit(force)`.

## Standard G/M/O/T commands mentioned in the docs

- Motion and positioning: `G0` or `G1` move; `G2` or `G3` arc move; `G4` dwell; `G10` retract; `G11` unretract; `G17`, `G18`, `G19` arc plane select; `G21` units-to-mm in PWM-tool examples; `G28` home; `G90` absolute coords; `G91` relative coords; `G92` set position.
- Temperature, fan, and extrusion modes: `M82`, `M83`, `M104`, `M105`, `M106`, `M107`, `M109`, `M140`, `M190`.
- Printer state and reporting: `M18`, `M73`, `M84`, `M112`, `M114`, `M115`, `M117`, `M118`, `M119`, `M204`, `M220`, `M221`, `M400`.
- Virtual SD flow: `M20`, `M21`, `M23`, `M24`, `M25`, `M26`, `M27`.
- PWM-tool docs also mention spindle-style `M3`, `M4`, `M5` for `pwm_tool` / laser / spindle workflows, not normal printer motion setup.
- Palette docs mention inline Omega codes `O1` through `O32`.
- Mentioned as common macro shims, not native Klipper built-ins: `G12`, `G29`, `G30`, `G31`, `M42`, `M80`, `M81`, `T1`.

## Core runtime and print control

- Lifecycle and status: `HELP`, `STATUS`, `RESTART`, `FIRMWARE_RESTART`, `SAVE_CONFIG`.
- Messaging and UI: `RESPOND`, `SET_DISPLAY_GROUP`, `SET_DISPLAY_TEXT`, `SET_PRINT_STATS_INFO`.
- Print state: `PAUSE`, `RESUME`, `CLEAR_PAUSE`, `CANCEL_PRINT`.
- Delayed or persistent state: `UPDATE_DELAYED_GCODE`, `SAVE_VARIABLE`.
- File and SD helpers: `SDCARD_PRINT_FILE`, `SDCARD_RESET_FILE`, `SDCARD_LOOP_BEGIN`, `SDCARD_LOOP_END`, `SDCARD_LOOP_DESIST`.
- General runtime controls: `TURN_OFF_HEATERS`, `TEMPERATURE_WAIT`, `SET_HEATER_TEMPERATURE`, `PID_CALIBRATE`, `SET_IDLE_TIMEOUT`, `SET_TEMPERATURE_FAN_TARGET`, `SET_Z_THERMAL_ADJUST`.

## Macro-state and motion-state helpers

- Macro and parser state: `SET_GCODE_VARIABLE`, `SAVE_GCODE_STATE`, `RESTORE_GCODE_STATE`.
- Position and offsets: `GET_POSITION`, `SET_GCODE_OFFSET`, `SET_VELOCITY_LIMIT`.
- Diagnostic motion tools: `STEPPER_BUZZ`, `FORCE_MOVE`, `SET_KINEMATIC_POSITION`, `MANUAL_STEPPER`, `SET_STEPPER_ENABLE`, `SET_STEPPER_CARRIAGES`.
- Multi-carriage and skew helpers: `SET_DUAL_CARRIAGE`, `SAVE_DUAL_CARRIAGE_STATE`, `RESTORE_DUAL_CARRIAGE_STATE`, `GET_CURRENT_SKEW`, `SET_SKEW`, `CALC_MEASURED_SKEW`, `SKEW_PROFILE`.
- Runtime tuning tools: `TUNING_TOWER`, `SET_INPUT_SHAPER`.

## Probing, leveling, and geometric calibration

- Probe core: `PROBE`, `QUERY_PROBE`, `PROBE_ACCURACY`, `PROBE_CALIBRATE`, `Z_OFFSET_APPLY_PROBE`.
- Manual probing tools: `MANUAL_PROBE`, `Z_ENDSTOP_CALIBRATE`, `Z_OFFSET_APPLY_ENDSTOP`, plus active-tool subcommands `ACCEPT`, `ABORT`, `TESTZ`.
- Bed mesh calibration: `BED_MESH_CALIBRATE` supports `PROFILE=<name>`, `METHOD=manual|automatic|scan|rapid_scan`, probe overrides, and mesh args such as `MESH_MIN`, `MESH_MAX`, `PROBE_COUNT`, `MESH_RADIUS`, `MESH_ORIGIN`, `ROUND_PROBE_COUNT`, `MESH_PPS`, `ALGORITHM`, `ADAPTIVE`, and `ADAPTIVE_MARGIN`; the mesh becomes active immediately, is stored to the named profile or `default`, and non-manual methods auto-adjust XY for probe offsets.
- Bed mesh runtime helpers: `BED_MESH_PROFILE SAVE|LOAD|REMOVE`, `BED_MESH_OUTPUT PGP=1`, `BED_MESH_MAP`, `BED_MESH_CLEAR`, `BED_MESH_OFFSET X/Y/ZFADE`, `BED_SCREWS_ADJUST`, `SCREWS_TILT_CALCULATE`.
- Gantry / tilt / delta / twist: `BED_TILT_CALIBRATE`, `DELTA_CALIBRATE`, `DELTA_ANALYZE`, `QUAD_GANTRY_LEVEL`, `Z_TILT_ADJUST`, `AXIS_TWIST_COMPENSATION_CALIBRATE`, `ENDSTOP_PHASE_CALIBRATE`.
- Probe-device-specific tools: `BLTOUCH_DEBUG`, `BLTOUCH_STORE`, `QUERY_ENDSTOPS`, `PROBE_EDDY_CURRENT_CALIBRATE`, `LDC_CALIBRATE_DRIVE_CURRENT`, `LOAD_CELL_DIAGNOSTIC`, `LOAD_CELL_CALIBRATE`, `LOAD_CELL_TARE`, `LOAD_CELL_READ`, `LOAD_CELL_TEST_TAP`, `TEMPERATURE_PROBE_ENABLE`, `TEMPERATURE_PROBE_CALIBRATE`, `TEMPERATURE_PROBE_NEXT`, `TEMPERATURE_PROBE_COMPLETE`, `ABORT`.
- Common probing overrides mentioned across the docs: `HORIZONTAL_MOVE_Z`, `PROBE_SPEED`, `LIFT_SPEED`, `SAMPLES`, `SAMPLE_RETRACT_DIST`, `SAMPLES_TOLERANCE`, `SAMPLES_TOLERANCE_RETRIES`, `SAMPLES_RESULT`, and eddy or load-cell-specific `METHOD=scan|rapid_scan|tap` or force/filter overrides.
- Context notes: `BED_MESH_PROFILE SAVE=<name>` or `REMOVE=<name>` is only persisted after `SAVE_CONFIG`; every `BED_MESH_CALIBRATE` refreshes the `default` profile; `BED_MESH_PROFILE LOAD=default` belongs in `START_PRINT` or a `[delayed_gcode]` only if you are not recalibrating there; `BED_MESH_OUTPUT PGP=1` prints generated tool-adjusted and probe points; `BED_MESH_CLEAR` clears internal mesh state; `BED_MESH_OFFSET ZFADE=<value>` compensates for a `SET_GCODE_OFFSET Z=...` during mesh fade and does not add direct Z correction; `SCREWS_TILT_CALCULATE` explicitly requires `G28` first; `Z_OFFSET_APPLY_*` turns live babystepping into persisted config data only after `SAVE_CONFIG`.

## Resonance, accelerometers, and angle sensors

- Resonance and shaper workflows: `MEASURE_AXES_NOISE`, `TEST_RESONANCES`, `SHAPER_CALIBRATE`, `SET_INPUT_SHAPER`.
- Accelerometer tools: `ACCELEROMETER_MEASURE`, `ACCELEROMETER_QUERY`, `ACCELEROMETER_DEBUG_READ`, `ACCELEROMETER_DEBUG_WRITE`.
- Angle sensor tools: `ANGLE_CALIBRATE`, `ANGLE_CHIP_CALIBRATE`, `ANGLE_DEBUG_READ`, `ANGLE_DEBUG_WRITE`.
- Context notes: these tools are measurement and calibration workflows, not routine print commands; `SHAPER_CALIBRATE` and some sensor calibrations typically lead into `SAVE_CONFIG`.

## Extruder, filament, heaters, IO, and drivers

- Extruder and pressure control: `ACTIVATE_EXTRUDER`, `SET_PRESSURE_ADVANCE`, `SET_EXTRUDER_ROTATION_DISTANCE`, `SYNC_EXTRUDER_MOTION`, `SET_RETRACTION`, `GET_RETRACTION`.
- Filament sensors and width tools: `QUERY_FILAMENT_SENSOR`, `SET_FILAMENT_SENSOR`, `QUERY_FILAMENT_WIDTH`, `QUERY_RAW_FILAMENT_WIDTH`, `RESET_FILAMENT_WIDTH_SENSOR`, `ENABLE_FILAMENT_WIDTH_SENSOR`, `DISABLE_FILAMENT_WIDTH_SENSOR`, `ENABLE_FILAMENT_WIDTH_LOG`, `DISABLE_FILAMENT_WIDTH_LOG`.
- Fans, servo, pins, LEDs, and misc IO: `SET_FAN_SPEED`, `SET_SERVO`, `SET_PIN`, `SET_LED`, `SET_LED_TEMPLATE`, `SET_DIGIPOT`, `QUERY_ADC`.
- Specialized tools and accessories: `PALETTE_CONNECT`, `PALETTE_DISCONNECT`, `PALETTE_CLEAR`, `PALETTE_CUT`, `PALETTE_SMART_LOAD`, `SET_SMART_EFFECTOR`, `RESET_SMART_EFFECTOR`.
- TMC driver tools: `DUMP_TMC`, `INIT_TMC`, `SET_TMC_CURRENT`, `SET_TMC_FIELD`.

## Object control and exclusion

- Object-aware print control: `EXCLUDE_OBJECT`, `EXCLUDE_OBJECT_DEFINE`, `EXCLUDE_OBJECT_START`, `EXCLUDE_OBJECT_END`.
- Context note: these commands are meaningful when slicer or macro workflows define per-object boundaries.

## Deprecated and example-only names mentioned in the docs

- Deprecated names in `Config_Changes.md`: `SET_EXTRUDER_STEP_DISTANCE` was replaced by `SET_EXTRUDER_ROTATION_DISTANCE`; `SYNC_STEPPER_TO_EXTRUDER` was replaced by `SYNC_EXTRUDER_MOTION`.
- Example macro names in the docs are not built-ins unless the user's config defines them. Examples include `START_PRINT`, `END_PRINT`, `T0`, `T1`, `blink_led`, `MOVE_UP`, `load_filament`, and similar names created by `[gcode_macro ...]` sections.

Use this summary for compact grounding. For exact parameters, defaults, units, or module gates, defer to `G-Codes.md`, `Command_Templates.md`, and the matching workflow guide.