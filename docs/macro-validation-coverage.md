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

Registry: **192 commands**; **123 documented** commands (`G-Codes.md` `####`
headers; every one registered, **0 documented-but-unregistered**). Parameter
metadata: **233 entries artifact-wide, 199 on documented commands** (166 typed,
66 required). The earlier pass's "128 documented / 189 param entries" used a
looser header match that also picked prose words out of backticks.

**Mux targets** (commands that resolve a key against the config's objects):
**37 documented** mux commands, **12 target-resolved** (v1):
`SET_FAN_SPEED, SET_LED, SET_LED_TEMPLATE, SET_PIN, SET_SERVO,
SET_HEATER_TEMPERATURE, SET_TEMPERATURE_FAN_TARGET, TEMPERATURE_PROBE_CALIBRATE,
UPDATE_DELAYED_GCODE, SET_FILAMENT_SENSOR, QUERY_FILAMENT_SENSOR, SET_DIGIPOT`.
**25 deferred**, grouped by what blocks them:
- `STEPPER` (8): `DUMP_TMC, FORCE_MOVE, INIT_TMC, MANUAL_STEPPER,
  SET_STEPPER_ENABLE, SET_TMC_CURRENT, SET_TMC_FIELD, STEPPER_BUZZ` — three
  object spaces (`[manual_stepper X]`, `stepper_x/z1/extruder`, the tmc section).
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

## 5. Gaps, prioritized

### P0 — DONE (`be7e894`): `{rawparams}` was treated as absent, not undecided

Klipper's own samples (`reference/config/Probe/sample-bigtreetech-eddy*.cfg`)
and the user's `mainsail.cfg` / `Knomi.cfg` pass parameters through with
`{rawparams}`. Two independent defects produced the same false ERROR:

1. **No invocation.** The undeclared splat rendered as `''`, and the
   required-param check then concluded "missing": `Rendered command
   'PROBE_EDDY_CURRENT_CALIBRATE' is missing required parameter CHIP` — 6
   save-gate errors across the corpus, on configs Klipper accepts. This is the
   same epistemic error 3.1 forbids for `{params.X}`: an unknown *arity* means
   param-dependent, not absent. The splat line now downgrades to the existing
   `macro_param_undefined` info, and suppresses only findings that claim a
   param is **absent** — a literal defect sharing the line (`RESPOND
   {rawparams} TYPE=info`) still reports.
2. **With an invocation**, `rawparams` was hardcoded to `''`, so a forwarding
   macro always rendered as a bare call and reported the same error *even when
   the caller passed the parameter*. It is now reconstructed from the declared
   invocation (`NAME=value`, values with spaces quoted for the shlex
   tokenizer). Declared `params_*` defaults are excluded — Klipper's
   `rawparams` carries only what the caller typed. A body that assigns
   `rawparams` itself has decided it, so those keep full checking.

### P1 — DONE (`2139dad`, `67b2cee`): parameter metadata gaps

The earlier diagnosis here was **wrong**: it blamed handlers that read params
"indirectly" and pointed at a `MANUAL_EXTRAS` seam that does not exist (the
seam is `EXTRA_MANUAL`, and it holds only `FORCE_MOVE` /
`SET_KINEMATIC_POSITION`). The real causes were two extraction shapes:

1. **Loop-registered handlers** (`2139dad`). `gcode_move.py` registers its
   whole handler table as `func = getattr(self, 'cmd_' + cmd);
   register_command(cmd, func)`. The registered argument is a *local*, so the
   visitor recorded `handler=None` and every name in the loop lost its params:
   `M220`, `M221`, `SET_GCODE_OFFSET`, `M26`, `SAVE_GCODE_STATE`,
   `RESTORE_GCODE_STATE`. The `cmd_<NAME>` convention makes the handler
   derivable, and a loop that passes a *fixed* callable (gcode.py's builtin
   dispatch) still records none — pinned by a negative-control fixture.
2. **Names built from a literal loop** (`67b2cee`). `gcmd.get_float(axis)` over
   `enumerate('XYZE')`, `axis + '_ADJUST'`, and G92's comprehension
   `[gcmd.get_float(a, None) for a in 'XYZE']`. The extractor now resolves
   literal iterables and expands the bound variable, **for numeric getters
   only** — `gcmd.get(axis)` is a presence read (`G28 X Y` is canonical and
   carries no value) and `SET_SKEW`'s planes are comma-list strings, so typing
   either would fabricate "renders EMPTY" on working configs. Per-axis params
   are always individually optional.

**What remains in this class** (verified by an independent handler-by-handler
inventory, cross-checked against the artifact — not estimated): **20 commands
still read parameters the registry does not know about** — 10 documented
(`PROBE`, `PROBE_CALIBRATE`, `MANUAL_PROBE`, `Z_ENDSTOP_CALIBRATE`,
`BED_TILT_CALIBRATE`, `DELTA_CALIBRATE`, `QUAD_GANTRY_LEVEL`, `Z_TILT_ADJUST`,
`BED_MESH_PROFILE`, `SET_INPUT_SHAPER`) and 10 undocumented (`G0`, `G1`, `G2`,
`G3`, `G28`, `M23`, `M109`, `M190`, `M117`, `M118`). None of them produces a
false "missing parameter" error — `M26 S` was the only required one in the whole
gap set and it is now covered — so the cost is silent **under-validation**
(non-numeric values are never type-checked), not false positives.

Three mechanisms, in value order:

1. **`gcmd` handed to a helper object** (8 commands — the probe family). The
   handler passes `gcmd` to `ProbeParameterHelper.get_probe_params`,
   `ProbePointsHelper.start_probe`, `ManualProbeHelper.__init__` or
   `z_tilt.RetryHelper.start`, and the reads happen there. A small table of
   (module, class, method) → params closes it; every param must be optional
   because those helpers supply config-derived defaults.
2. **Intra-file delegation** (`M109` → `cmd_M104`, `M190` → `cmd_M140`, `G2`/`G3`
   → `_cmd_inner`, `SET_INPUT_SHAPER` → `update`). Merge the same-file callee's
   params, depth ≤ 3, cycle-guarded — but do **not** merge a callee that builds
   a synthetic command with `create_gcode_command`: those params belong to the
   synthesized command, not the invoked one.
3. **Raw / positional text** (`M23` filename, `M117`/`M118` message,
   `G0`/`G1` reading `get_command_parameters()` as a dict). There is no
   `NAME=value` parameter here, so params must stay **empty** — inventing a
   `FILENAME=`/`MSG=` param would mean the simulator never sees what the user
   actually writes.

Deliberate non-goals inside this residue: `G2`/`G3`'s `R` is read only to be
rejected (`gcode_arcs.py:72`); `G28`'s axes are a presence read and typing them
as numbers would fabricate "renders EMPTY" on canonical `G28 X Y` (typing them as
str is safe but buys nothing); and `G1`'s axis set is runtime-extensible
(`toolhead.get_extra_axes()`), so X/Y/Z/E is only the statically provable floor.

**Correction to the inventory that produced this list:** it claimed
`SET_INPUT_SHAPER` has no `*_Z` params in this checkout because only x and y
shapers are built. That is false — `input_shaper.py:112` constructs
`AxisInputShaper('z', config)` and `cmd_SET_INPUT_SHAPER` calls `shaper.update`
for all three, so `SHAPER_TYPE_Z`, `SHAPER_FREQ_Z` and `DAMPING_RATIO_Z` ARE
read (`'SHAPER_TYPE_' + axis`, `:31`; `'DAMPING_RATIO_' + axis`, `:35`;
`'SHAPER_FREQ_' + axis`, `:41`). Anyone closing this command must include the Z
variants. (Its names are prefix-built from an axis loop, so the P1 prefix
pattern would cover them once the handler's `shaper.update(gcmd)` delegation is
followed.)

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
  sections. **Before P0/P1:** 0 enum errors, 3 mux warnings — all three the
  same genuine defect (`Hotkey.cfg` M301 does `SET_PIN PIN=beeper` with no
  `[output_pin beeper]` in that project) — and **6 `{rawparams}` false
  errors**. **After:** 0 errors.
- Ablation, run after each fix (repo + `~/printer_data/config`): every code
  count is identical to the pre-fix baseline except the class being fixed —
  `macro_unknown_value` 206, warning `macro_param_undefined` 9,
  `macro_render_blocked` 42, `macro_render_unexplored` 7,
  `macro_rendered_g1_no_feedrate` 6. `macro_param_undefined` infos 98 → 118:
  the new splat notes on the 10 forwarding macros (+ their
  `frontend/public/reference` copies). Both registry changes left the corpus
  output **byte-identical** — new metadata with no new findings, i.e. no
  false positives introduced.
- Simulator tests: `tests/test_simulate_macro_tool.py`,
  `tests/test_macro_render*.py`; registry: `tests/test_gcode_registry_extract.py`,
  `tests/test_gcode_registry_service.py`.
