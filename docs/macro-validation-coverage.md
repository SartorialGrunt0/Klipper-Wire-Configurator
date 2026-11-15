# Where macro/g-code validation lives — coverage review

Reviewed 2026-11-15 against `reference/klipper/docs/G-Codes.md` (128 documented
commands), `backend/data/gcode_commands.json` (192 entries, regenerated), the
render simulator (`backend/parser/macro_render.py`), the config validator
(`backend/parser/validator.py`) and the registry scan
(`backend/services/gcode_registry.py`).

The question this answers: **for each class of defect, which surface owns it —
the render simulator, `validate_macro`, or plain config validation — and where
are we currently blind?**

## 1. The three surfaces, and what each may claim

| Surface | Input | Contract | Consumption |
| --- | --- | --- | --- |
| Config validation (`/import`, `/parse`, `/validate`, `/validate-project`, save gate) | config text | "this TEXT is broken" — schema, required options, types, ranges, unknown sections/options, command names, section gates | errors block saves; warnings are ack-able |
| `validate_macro` | one macro section | static Jinja + the simulator on the **default invocation** | tool surface for the model |
| `simulate_macro` | macro + **declared** invocations | "this CALL fails / sends this" — per-invocation verdicts, branch coverage, state threading | tool surface only |

Two consumption laws constrain the routing (both already implemented):

- `is_sim_advisory` (`macro_render.py`): simulation findings at **warning/info**
  never reach human validation or the model's delta advisories; simulation
  **errors** pass everywhere, because a rendered command shape that Klipper
  refuses is a defect of the text at hand, not a hypothesis.
- `_scan_file_gcode_commands` is **warning-tier only** (an unknown name may be a
  third-party extra). `unknown_gcode_command` is nonetheless a pre-staging
  **kickback** code in `ai_edit_tools` (one correction round); 
  `gcode_command_section_missing` is advisory only.

## 2. Routing rule (the decision this review settles)

> **Config validation owns facts about the FILE. `validate_macro` owns the
> default invocation of the text. `simulate_macro` owns everything that depends
> on how the macro is CALLED.**

Practically:

| Defect class | Owner | Severity | Why |
| --- | --- | --- | --- |
| Unknown section/option, bad value type/range in config, unresolved include | config validation | error | Klipper refuses to start |
| Unknown command name, command whose section is missing | config validation (registry scan) | warning (+ kickback for names) | may be a plugin module; name is still likely wrong |
| Jinja syntax, unbalanced tags, `{{ }}` under Klipper delimiters | `validate_macro` | error | text defect, no invocation needed |
| Required param missing / unparseable type / non-literal `SET_GCODE_VARIABLE VALUE` | simulator (both surfaces share the engine) | error | the rendered line is refused by Klipper on every call |
| Enum param outside its membership set (`RESPOND TYPE=`) | simulator | error | same: refused on every call |
| Mux target names hardware the project does not define (`FAN=fan`) | simulator (needs the project's section inventory) | warning | run-time refusal, but absence is only decidable from the loaded files |
| Numeric **bounds** (`minval`/`maxval`) | simulator, literal bounds only | error | 63 sites, most config-dependent → undecidable statically; do not guess |
| Param-dependent values, undeclared printer state, branches | `simulate_macro` only | info | an invocation question, not a text question |
| State transitions, "does it remember", branch coverage | `simulate_macro` (`runs=N`) | info/verdict | needs consecutive calls |
| Physical outcome (fan actually spins, hotend reaches target) | **nobody** | — | not checkable without execution; the tool reports "commanded, not observed" |

## 3. Coverage today

Registry: **192 commands**, 128 documented, **0 documented-but-unregistered**
(after this review's fixes). Parameter metadata exists for 189 params on
documented commands (152 typed, 70 required).

**Mux targets** (commands that resolve a key against the config's objects):
41 documented mux commands. **16 are target-resolved** (v1):
`SET_FAN_SPEED, SET_LED, SET_LED_TEMPLATE, SET_PIN, SET_SERVO,
SET_HEATER_TEMPERATURE, SET_TEMPERATURE_FAN_TARGET, TEMPERATURE_PROBE_CALIBRATE,
TEMPERATURE_PROBE_ENABLE, QUERY_BUTTON, UPDATE_DELAYED_GCODE, LOAD_CELL_*,
SET_FILAMENT_SENSOR, QUERY_FILAMENT_SENSOR, SET_DIGIPOT`.
**25 deferred**, grouped by what blocks them:
- `STEPPER` (8): `MANUAL_STEPPER` → `[manual_stepper X]`, `FORCE_MOVE` →
  `stepper_x/z1/extruder`, `DUMP_TMC` → the tmc section — three object spaces.
- `CHIP` (10): adxl345 / angle / ldc1612 / probe_eddy_current.
- `EXTRUDER` (4): `kinematics/extruder.py` registers a `None` key for a single
  extruder and enumerates `extruder1+` otherwise.
- `SENSOR` (`TEMPERATURE_WAIT`): values are FULL section names
  (`temperature_sensor chamber`), space included.
- `DISPLAY` (`SET_DISPLAY_GROUP`), `MACRO` (`SET_GCODE_VARIABLE` — already
  enforced by its own shape check).

**Enum params**: 2 covered (`RESPOND TYPE`, `SET_DUAL_CARRIAGE MODE`) — the only
params whose membership test *raises*.

**Bounds**: 0 covered, by design (see §5).

## 4. Two registry defects found and fixed by this review

1. **`extras/display/` was never scanned.** The extractor globbed
   `extras/*.py`; `display.py` lives in a subpackage, so `SET_DISPLAY_GROUP`
   was absent from the registry. Consequence on the human surface:
   `'SET_DISPLAY_GROUP' is not a Klipper command. Did you mean: SET_DISPLAY_TEXT?`
   — a false warning on a line Klipper accepts — and, because
   `unknown_gcode_command` is a kickback code, the model was told to fix
   working code.
2. **Mux keys registered with a `None` value were marked required.**
   `gcode.py::_cmd_mux` reads the key with a default when `None` was
   registered, so the key is optional. The registry demanded it and the
   simulator false-**ERRORed** two canonical spellings:
   `SET_PRESSURE_ADVANCE ADVANCE=0.05` (the single-extruder form used by
   essentially every START macro) and `SET_DISPLAY_GROUP GROUP=printing`.

Both are pinned by tests in `tests/test_gcode_registry_extract.py`. After the
fixes the display line produces the *true* warning instead: "needs a
`[display]` section".

## 5. Remaining gaps, prioritized

### P0 — false ERROR on the human save gate: `{rawparams}` splat

Klipper's own samples (`reference/config/Probe/sample-bigtreetech-eddy*.cfg`)
and the user's `mainsail.cfg` / `Knomi.cfg` pass parameters through with
`{rawparams}`. When no invocation is declared the splat renders as the UNKNOWN
sentinel, and a required-param check then concludes "missing":

```
Rendered command 'PROBE_EDDY_CURRENT_CALIBRATE' is missing required parameter CHIP
```

6 such errors across the corpus (2 distinct files, 3 copies). It is the same
epistemic mistake the 3.1 invocation model already forbids for named params: an
unknown splat means the params are *undecidable*, not absent. Fix: when the
rendered line carries an unknown marker in param position, downgrade
"missing required" to param-dependent **info**. Risk: low — it only affects
lines that already contain `<unknown>`.

### P1 — parameter metadata gaps (23 documented commands)

The registry has no params for commands whose handler reads them indirectly or
builds names dynamically, so *every* param check is blind to them. Real cases:

- `SET_GCODE_OFFSET` (`X/Y/Z/X_ADJUST/…/MOVE/MOVE_SPEED`) — `MOVE` is an int
  with bounds 0–2, the rest floats.
- `SAVE_GCODE_STATE` / `RESTORE_GCODE_STATE` (`NAME`, `MOVE`, `MOVE_SPEED`).
- `SET_LED_TEMPLATE TEMPLATE=` — read inside led.py's template helper.
- `PROBE` / `PROBE_ACCURACY` / `PROBE_CALIBRATE` / `MANUAL_PROBE` /
  `Z_ENDSTOP_CALIBRATE` (param-helper indirection).
- `BED_MESH_PROFILE` (`LOAD/SAVE/REMOVE/NAME`) — profile *existence* is stateful,
  so only the shape is checkable.
- `SET_INPUT_SHAPER`, `SHAPER_CALIBRATE`, `TEST_RESONANCES` — names built per
  axis (`'SHAPER_FREQ_' + axis`) and from a chip list.

Fix direction: teach the extractor two patterns (per-axis name concatenation and
the `param_helper` object), and add a manual-override table for the rest —
the generator already has a `MANUAL_EXTRAS` seam. Risk: moderate (generator
change), value: high — it unblocks bounds/enum checks for the most-used commands.

### P2 — either-of / at-least-one rules

`SET_FAN_SPEED` requires `SPEED` **or** `TEMPLATE` (fan_generic.py:34 raises
otherwise). The registry models params one at a time, so a bare
`SET_FAN_SPEED FAN=Aux_Fan` passes today. Fix: a small source-derived table
like `_PARAM_ENUMS` (`_PARAM_EITHER_OF`). Risk: low.

### P3 — literal-only numeric bounds

`SET_LED RED/GREEN/BLUE/WHITE` are `get_float(..., minval=0., maxval=1.)` —
literals, decidable, and a common mistake (`RED=255`). Config-dependent bounds
(`SET_PIN VALUE` → pin scale, `SET_LED INDEX` → chain length) must stay out.
Risk: low if restricted to literal bounds.

### P4 — mux families v2 (`STEPPER`, `CHIP`, `TEMPERATURE_WAIT SENSOR`)

Each needs a per-command object map rather than a key-family rule. Lower value
for macro authoring than P0–P3 (these commands rarely appear in user macros),
but `SET_TMC_CURRENT STEPPER=` typos are a real class on TMC-heavy configs.

## 6. Explicit non-goals

- **Execution semantics**: heating, motion, `G4` waits, macro recursion.
- **Stateful existence**: bed-mesh profile names, gcode-state names,
  `SAVE_VARIABLE` names — existence depends on prior runtime behavior.
- **Bound values that come from config** (pin scales, LED chain lengths):
  decidable in principle from the project's sections, but that is a
  config-validation job with full option parsing, not a render-time guess.

## 7. Numbers used above (reproducible)

- Corpus sweep: 871 `.cfg` files, 827 macro bodies, per-directory project
  sections. After this review: 0 enum errors, 3 mux warnings — all three the
  same genuine defect (`Hotkey.cfg` M301 does `SET_PIN PIN=beeper` with no
  `[output_pin beeper]` in that project) — and 6 `{rawparams}` false errors
  (P0).
- Simulator tests: `tests/test_simulate_macro_tool.py`,
  `tests/test_macro_render*.py`; registry: `tests/test_gcode_registry_extract.py`,
  `tests/test_gcode_registry_service.py`.
