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
| Either-of / exactly-one choice (`SET_FAN_SPEED`, `TEMPERATURE_WAIT`) | simulator | error | refused on every call, and the rule is a literal in the handler |
| Numeric **bounds** (`minval`/`maxval`/`above`/`below`) | simulator, **literal limits only** | error | 78 bound sites in the handlers: every literal limit is recorded (70 params carry a bound), the 10 config-derived limit sides are left out — do not guess |
| Param-dependent values, undeclared printer state, branches | `simulate_macro` only | info | an invocation question, not a text question |
| State transitions, "does it remember", branch coverage | `simulate_macro` (`runs=N`) | info/verdict | needs consecutive calls |
| Physical outcome (fan actually spins, hotend reaches target) | **nobody** | — | not checkable without execution; the tool reports "commanded, not observed" |

## 3. Coverage today

Registry: **192 commands**; **127 documented** commands (`G-Codes.md` `####`
headers, de-quoted; every one registered, **0 documented-but-unregistered**).
Parameter metadata: **233 entries artifact-wide, 206 on documented commands**
(173 typed, 67 required, 58 with a bound). Two earlier counts were wrong and are
superseded: "128 documented / 189 param entries" used a looser header match that
picked prose words out of backticks, and "123 documented" dropped the four
backtick-quoted `EXCLUDE_OBJECT` headings (the audit in §7 reconciles both).

**Mux targets** (commands that resolve a key against the config's objects):
**43 carry a mux key, 37 target-resolved, 6 deferred.**
- `STEPPER` (8) and `CHIP` (10) and `TEMPERATURE_WAIT SENSOR` are now resolved
  in three different object spaces (§5, P4).
- **`EXTRUDER` (4)** — `SET_PRESSURE_ADVANCE`, `SET_EXTRUDER_ROTATION_DISTANCE`,
  `SYNC_EXTRUDER_MOTION`, `ACTIVATE_EXTRUDER`: `kinematics/extruder.py`
  registers a `None` key for a single extruder and enumerates `extruder1+`
  otherwise, so the key is *optional*, not a name to check.
- **`DISPLAY`** (`SET_DISPLAY_GROUP`), **`MACRO`** (`SET_GCODE_VARIABLE` —
  already enforced by its own shape check).

**Enum params**: 2 covered (`RESPOND TYPE`, `SET_DUAL_CARRIAGE MODE`) — the only
params whose membership test *raises*.

**Either-of rules**: 2, in two modes — `SET_FAN_SPEED` exactly one of
`SPEED`/`TEMPLATE`, `TEMPERATURE_WAIT` at least one of `MINIMUM`/`MAXIMUM`.

**Bounds**: **70 params on 42 commands**, all from literal limits in the
handler source (inclusive `minval`/`maxval`, exclusive `above`/`below`). Ten
config-derived limit sites are deliberately unrecorded (§5, P3).

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

### P2 — DONE (`48d316e`): two either-of rules, not one

`SET_FAN_SPEED` is an **exactly-one** rule: fan_generic.py's test is
`(speed is None) == (template is None)`, so it raises when *both* are missing
**and** when *both* are present. `TEMPERATURE_WAIT` is an **at-least-one** rule:
heaters.py raises only when neither `MINIMUM` nor `MAXIMUM` is given. They are
different refusals, so `_PARAM_EITHER_OF` carries a mode (`"xor"` / `"or"`)
rather than one shape — collapsing them would either pass the illegal
`SPEED=… TEMPLATE=…` pair (false negative) or flag the legal
`MINIMUM=… MAXIMUM=…` pair (false positive). The check is skipped when either
member renders unknown, because supplied-ness is then undecidable.

### P3 — DONE (`48d316e`): literal ranges, 70 params, enforced from the generator

Implemented in the **generator**, not a hand table: `_literal_number` records
`minval`/`maxval`/`above`/`below` on the param entry when the limit is a numeric
literal (including `-1` — a unary minus is still a literal). That way a Klipper
regen keeps the bounds honest, and the renderer only compares what the artifact
carries. gcode.py's semantics are copied exactly: `minval`/`maxval` are
inclusive, `above`/`below` are exclusive, and the first failing check is the one
reported.

**70 params on 42 commands** gained bounds — `SET_LED RED/GREEN/BLUE/WHITE`
(0–1, the `RED=255` mistake), `SET_VELOCITY_LIMIT MINIMUM_CRUISE_RATIO`
(`below=1.`), `SET_RETRACTION`, `M204`, `CALIBRATE`, the `*_DEBUG_*` register
ranges, and more. **Ten limit sites stay out** because the limit is not a
literal: `SET_PIN VALUE` (`maxval=self.scale`), `SET_PIN CYCLE_TIME`,
`SET_LED`/`SET_LED_TEMPLATE INDEX` (`self.led_count`),
`SET_TMC_CURRENT CURRENT`/`HOLDCURRENT` (`max_cur`), `SET_DIGIPOT WIPER`,
`TEMPERATURE_WAIT MAXIMUM` (`above=min_temp`),
`TEMPERATURE_PROBE_CALIBRATE TARGET`. `SET_Z_THERMAL_ADJUST REF_TEMP`
(`minval=KELVIN_TO_CELSIUS`, a module constant) is also skipped — a module
constant is resolvable in principle, but leaving it out can only under-validate,
never raise a false error.

### P4 — DONE (`48d316e`): three object spaces, not one

The mux key name does not determine the object space; each family resolves
differently, from source:

- **CHIP** — adxl345 / angle / ldc1612 / probe_eddy_current all register
  `"CHIP", config.get_name().split()[-1]`, so the value is the *trailing* name
  (`[adxl345]` → `adxl345`, `[angle my_chip]` → `my_chip`). 10 commands.
- **STEPPER rails** — force_move and stepper_enable register per
  `mcu_stepper.get_name()` (`stepper_x`, `extruder`), tmc registers the trailing
  name, and `MANUAL_STEPPER` resolves against `[manual_stepper NAME]`. The legal
  set is the rails the project declares, derived from section headers.
- **`TEMPERATURE_WAIT SENSOR`** — heaters.py `register_sensor` uses
  `config.get_name()`, so the value is the **full section header**,
  `"temperature_sensor chamber"`, space and all. Real configs quote it (this is
  the canonical form in `Trident_backup`); the unquoted form is itself a Klipper
  parse error (`Unable to parse parameter 'chamber'`), which the renderer
  already reports as such.

Every family in the sensor space is listed, including `z_thermal_adjust`, which
also calls `register_sensor` — omitting it would report a legitimate target as
missing.

## 6. Coverage audit against G-Codes.md, and which surface owns what

Every `####` heading in `reference/klipper/docs/G-Codes.md`, audited against the
registry (2026-11-15, round 2):

- **129 headings → 127 unique commands** after de-quoting the backtick-quoted
  headings (the `EXCLUDE_OBJECT` family) and dropping one prose artifact
  (`TEMPERATURE_PROBE_COMPLETE:`).
- **127/127 are registered — zero documented-but-unregistered.** Conversely the
  registry holds **192** commands, so 65 real commands (`G0`/`G1`, `M104`/`M109`,
  the `SET_TMC_*` family) are validated even though G-Codes.md gives them no
  `####` heading. The registry is generated from handlers, not from the docs,
  and that is the right direction of dependency.
- **82/127 (64.6%) carry per-command metadata** — a param set, a mux key, or
  both. 203 params on documented commands, 60 of them with a literal bound, 38
  commands with a mux key.
- **45 carry none**, and they split cleanly rather than evenly:
  - **35 are genuinely parameter-free** — `RESTART`, `FIRMWARE_RESTART`,
    `TURN_OFF_HEATERS`, `QUERY_PROBE`, `GET_POSITION`, `BED_SCREWS_ADJUST`,
    `SAVE_CONFIG`, `CLEAR_PAUSE`, … An empty param set is the *truth* for these;
    there is nothing to validate per command, and inventing params to make the
    number look better would be the defect.
  - **10 are the P1 residue** — `PROBE`, `PROBE_CALIBRATE`, `MANUAL_PROBE`,
    `Z_ENDSTOP_CALIBRATE`, `BED_TILT_CALIBRATE`, `DELTA_CALIBRATE`,
    `QUAD_GANTRY_LEVEL`, `Z_TILT_ADJUST`, `BED_MESH_PROFILE`,
    `SET_INPUT_SHAPER` — **67 params total** the registry does not know.

### The residue is a `simulate_macro` gap, not a different surface

All 67 params guard refusals that are decidable from the **rendered line**:
`PROBE_CALIBRATE SPEED=fast` is a float parse error, `BED_TILT_CALIBRATE
RETRIES=2.5` an int error, `SET_INPUT_SHAPER SHAPER_TYPE=foo` a choice error.
They sit behind helper objects in the *source*; they sit behind nothing in the
*rendered line*. So the fix is extractor coverage (the `(module, class, method)
→ params` table described in §5), not a new check surface. The same holds for
the 10 undocumented commands (`M109`, `M190`, `G0`–`G3`, `G28`, `M23`, `M117`,
`M118`): they are gaps against G-Codes.md's headings, not against
line-decidability.

What genuinely belongs on the other surfaces:

- **`simulate_macro`** — everything decidable from one rendered line plus the
  project's section list: type, required, enum, either-of, literal bounds, mux
  target existence. **Owns all 67 residue params.**
- **`validate_macro`** — structure no single rendered line carries: Jinja
  compile, `params_*`/`variable_*` declarations, `SAVE_GCODE_STATE` /
  `RESTORE_GCODE_STATE` pairing. **Owns none of this residue.**
- **Config validation (info/warn/error)** — needs option *values*, not just
  section names: the ten config-derived bound sides in §5 (`SET_PIN VALUE` →
  `scale`, `SET_TMC_CURRENT CURRENT` → `max_cur`, `SET_LED INDEX` → chain
  length), TMC field/register names, and pin conflicts.

The practical consequence: no part of the residue should be pushed onto
`validate_macro` or the config validator as a workaround. It is one extractor
table away from being checked, and pushing it elsewhere would move a
line-decididable error to a surface that cannot see the line.

## 7. Explicit non-goals

- **Execution semantics**: heating, motion, `G4` waits, macro recursion.
- **Stateful existence**: bed-mesh profile names, gcode-state names,
  `SAVE_VARIABLE` names — existence depends on prior runtime behavior.
- **Bound values that come from config** (pin scales, LED chain lengths):
  decidable in principle from the project's sections, but that is a
  config-validation job with full option parsing, not a render-time guess.

## 8. Numbers used above (reproducible)

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
- **Round 2 (P2/P3/P4, `48d316e`)**: 872 `.cfg` files, 827 macro bodies,
  15 project directories, sections per directory. **754 macro lines invoke a
  command that now carries a literal bound or an either-of rule**
  (`SET_PIN` 188, `SET_TMC_CURRENT` 168, `G4` 87, `M104` 69, `SET_FAN_SPEED` 62,
  `SET_LED` 57, `M106` 45, `M140` 36, `SET_VELOCITY_LIMIT` 27,
  `TEMPERATURE_WAIT` 9, `M204` 6) — and produced **0 findings**, i.e. no false
  positives on any real config, with the either-of rule exercised 71 times.
  The 6 mux warnings that appear once sections are supplied are the same
  pre-existing true positive (`Hotkey.cfg` M301 → `SET_PIN PIN=beeper`, no
  `[output_pin beeper]` in that project), now seen in three copies of the file.
- **Artifact isolation check**: the regenerated registry differs from the
  previous commit by `schema_version` (3 → 4), `generated_at`, and the 70 params
  that gained bounds — **0 command-set changes, 0 non-bound param changes**.
- Simulator tests: `tests/test_simulate_macro_tool.py`,
  `tests/test_macro_render*.py`, `tests/test_macro_render_ranges_choices_mux.py`;
  registry: `tests/test_gcode_registry_extract.py`,
  `tests/test_gcode_registry_service.py`. Suite: **4234 passed**.
