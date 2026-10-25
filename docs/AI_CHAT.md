# AI Chat

The KWC AI assistant answers Klipper questions and edits your configs,
macros, and printer-memory profile from inside the configurator. It reads the
bundled Klipper documentation (matched to your installed Klipper version),
example configs, and your loaded project; it changes your files only through
typed edit operations that the **server** applies and validates mechanically;
and nothing reaches disk until you save.

What it can do:

- **Answer Klipper questions** grounded in the bundled docs, the Config
  Reference, your own configs, and live Klipper state.
- **Edit configs safely** — parameter changes, section surgery, macro-body
  patches, renames, comment/uncomment sweeps, file moves, include management
  — as an honest change set you review after the reply with Keep/Undo.
- **Handle large requests** — "comment out every macro", "rename this
  everywhere", "add these six sections from my pin map" — via batched ops and
  occurrence sweeps instead of prose dumps.
- **Draft and validate macros** against Klipper's Jinja rules.
- **Fill in your printer memory** profile when it's blank.
- **Diagnose a failed firmware restart** after a save (see
  [Interactions](#interactions)).

Everything is model-agnostic by design: the harness validates, kicks back,
and reports, so accuracy comes from the machinery around the model, not from
hoping the model is careful.

---

## Table of Contents

1. [Configuration](#configuration)
2. [Models](#models)
3. [Interactions](#interactions)
   - [The top bar](#the-top-bar)
   - [The text view and how edits are shown](#the-text-view-and-how-edits-are-shown)
   - [Failed firmware restart analysis](#failed-firmware-restart-analysis)
4. [Design](#design)
   - [Request lifecycle](#request-lifecycle)
   - [Tools](#tools)
   - [Edit operations](#edit-operations)
   - [Validation and kickbacks](#validation-and-kickbacks)
   - [Budgets and loop control](#budgets-and-loop-control)
   - [Honesty guards](#honesty-guards)
5. [Appendix](#appendix)
   - [Accuracy testing](#accuracy-testing)
   - [Question bank](#question-bank-111-questions)
   - [Current model results](#current-model-results)
   - [Known failure families](#known-failure-families)
   - [Running the harness](#running-the-harness)
   - [Historical results](#historical-results)

---

## Configuration

Everything lives in the chat dialog: press **AI Chat** in the toolbar (or the
chat fold button on the text view) and open **Settings** inside the dialog.
The panel shows the same fields inline whenever no model is configured yet,
so the first-run path is identical.

| Setting | What it does |
| --- | --- |
| **Provider** | ChatGPT (OpenAI), Google (Gemini), Anthropic (Claude), GitHub Copilot, or **OpenAI Compatible** for local servers (llama.cpp, LM Studio, Ollama, llama-swap) and any OpenAI-style endpoint. |
| **API URL** | OpenAI Compatible only — the full chat-completions URL, e.g. `http://localhost:11434/v1/chat/completions`. |
| **API Key** | Required for cloud providers only; marked optional for local servers. Stored only in your browser. |
| **Model** | The model list is fetched live from your endpoint with a refresh button; you can also type a model name directly. |
| **Tool Format** | OpenAI Compatible only — `Auto` (default), `native` (OpenAI function calling), or `text` (the ```tool fence protocol, a fallback for servers that advertise tools but emit template garbage). |
| **Max Tokens** | Cap on the assistant's reply length (default 4096; 8192 recommended for edit-heavy use). |
| **Temperature** | Sampling temperature (default 0.7). |

Settings, conversation history, and attached config references persist
locally and are restored when you reopen a saved conversation
(**New Chat** starts fresh; the history dialog lists saved conversations).

The docs MCP points at your active config path and the installed Klipper
folder, so the reference material always matches the firmware you actually
run — the installed repo is used when present, a bundled copy otherwise, and
KWC-authored docs load alongside either way.

---

## Models

Three recommendations, ranked by measured accuracy on the 111-question
accuracy bank (harness described in the [Appendix](#accuracy-testing),
native tool protocol, temperature 1.0 as the recent full-bank runs use it).
Ranges span multiple full-bank runs; ±3 on a single run is this bank's noise
level, so ranges are more honest than any single headline number.

| # | Model | Accuracy (111-Q bank) | VRAM pairing | Why it's recommended |
| --- | --- | --- | --- | --- |
| 1 | **Qwen3.8 27B** | **97–99%** (108–110) | 16–24 GB | The accuracy ceiling for local use. Best tool discipline, the only model that reliably honors "don't touch my files", and the strongest bulk-edit performer (5/5 on the BULK sweep family across repeat runs). Slower per turn; occasionally over-clarifies when a premise contradicts your real config — which is safe behavior, not a stall. |
| 2 | **Gemma4 12B (QAT)** | **92–95%** (102–106) | 8–12 GB | Best accuracy per VRAM byte and the harness's reference model — most of KWC's AI behavior was developed against it. Excellent edit routing and macro/Jinja syntax; weaker than the 27B on ambiguous multi-file sweeps and on resisting drafts-when-told-not-to. |
| 3 | **Qwen3.5 4B** | **87–95%** (97–105) | < 8 GB | Proof the harness works: a 4B model scoring high-80s to mid-90s on real Klipper edits is entirely a product of the tool machinery. Expect more mid-edit kickbacks to re-read files and occasional missed references on big sweeps; run it at 8192 max tokens. |

**Honorable mentions** (solid, not currently quantified on the bank):

- **Qwen3.6 35B-A3B** — MoE with a small active footprint; near-27B answers
  with 4B-class speed on the older 106-question bank.
- **Qwen3.8 Flash Next** — reasoning-family model; strong answers, but the
  longest wall-clock per question of anything tested.
- **Gemma4 E4B** — the efficient variant; the best model that fits tiny GPUs,
  just behind the Qwen3.5 4B on families requiring precise tool choice.

If your hardware fits two of the three, run the bank on both with your own
configs — per-model behavior varies with fixture, temperature, and prompt
build, and the bank exists precisely so you don't have to guess.

---

## Interactions

### The top bar

The **AI Chat** button on the toolbar opens the assistant as a dialog, and it
doubles as a status light while the chat is *not* in front of you:

- **Green** — a reply landed, or an edit set is waiting for your review.
- **Red** — the last request failed (retry is offered in the dialog).
- **Neutral** — idle, or the chat is visible (the moment you open it, the
  attention signal clears).

The same signal appears on the text view's chat fold button, so the docked
panel behaves identically. While a request is in flight, a small strip under
the typing dots shows the assistant's own step narration plus a deduped
checklist of the tools it has run — strictly display state; it disappears
when the reply lands. Pressing **Stop** (the Send button while busy) cancels
immediately, and if a request fails your message stays in the conversation
with a **Retry** that re-sends it with full context.

You can also **steer mid-flight**: typing while a request is running doesn't
queue a new turn — it injects your words into the *current* loop at the next
tool boundary, discards the reply the model had produced, and re-queries with
your steer included. Change your mind halfway through a bulk edit and the
model changes course.

### The text view and how edits are shown

The chat can dock as a third column beside the text editor (the fold button
on the editor's edge). Both the toolbar dialog and the docked panel write the
same change set, and both feed the same review surface. The governing rule:
**blocking approval is only for irreversible actions** (disk writes,
firmware restarts). Everything the assistant edits is a reversible in-memory
staging, so you review it **after** the reply instead of being interrupted
card-by-card:

- **In the chat transcript**, each edit gets a compact row —
  `file / [section]  +N −N` — that unfolds to that operation's own mini-diff.
  Rows are a record, not a control surface; if a later edit supersedes one,
  the old row stays visible and is marked superseded. Honest history.
- **In the editor**, unreviewed AI changes render as **green runs** (lines
  the assistant added, in place) and **red ghost runs** (lines it removed,
  still displayed, never present in the saved text). A floating **Keep /
  Undo** pair sits on each run, and runs split at section headers so one stop
  equals one section. **Keep** folds the change into your working text
  (nothing moves — it just stops being highlighted); **Undo** replays the
  remaining kept edits from the pre-request baseline, so a dropped edit can
  never leave a half-applied mess. If you hand-edit while a change is
  unreviewed, your text wins and any edit that no longer applies is reported
  as stale rather than forced.
- **The change-set bar** docks at the bottom of the chat: "N unreviewed",
  **Undo all** / **Keep all**, and an expandable per-file list with per-file
  and per-run Keep/Undo. It is a to-do list, not a receipt — its `+N/−N`
  counters show only the undecided remainder, decided rows stay attached to
  their reply, and when nothing is left undecided the bar disappears.
- **Nothing touches disk** until you use the toolbar **Save** menu, and your
  printer is never restarted behind your back. The Save dialog warns while
  changes are still unreviewed.

### Failed firmware restart analysis

If you save to Klipper and the FIRMWARE_RESTART fails, the apply dialog shows
the failure and offers **AI Analyze**. One press builds a diagnosis prompt
from the live evidence — the restart error, recent klippy.log lines, the
section the error names, and your current config — and sends it to the chat,
which replies with the minimal fix staged as a normal reviewable edit.

---

## Design

### Request lifecycle

1. **You send a message.** The app builds the request context: your message,
   recent history, attached file/section references (via `@`-mention or the
   text view), your loaded project, and the printer memory profile.
2. **The backend prepares the prompt.** Operating rules plus the built-in
   tool list go in; all providers — local servers included — get native
   function calling by default. The text-fence protocol is kept as a
   fallback extractor: a model that ignores the tools array still works.
3. **The model works with tools.** The backend executes each requested tool
   and feeds results back in a multi-round loop. The loop closes when the
   **model says it is done** — loop-exit "completion guards" (an echo
   kickback and a fresh-context judge) were measured across three-arm
   full-bank cycles and deleted: they reshuffled failures instead of
   removing them (see [Appendix](#current-model-results)). Runaway control
   is the thrash budget below, not an opinion about when the model is done.
4. **Edits are applied mechanically.** The model *requests* changes via
   `config_edit` / `config_write`; the server applies each op to a working
   copy and validates it the same instant. The assistant cannot fabricate a
   change, silently rewrite a whole file, or mangle lines it didn't touch —
   and config blocks pasted in an answer are display-only, never applied.
5. **You review after the fact.** Keep/Undo as described above; Save remains
   the only path to disk.

### Tools

The model sees three layers: MCP tools, one chat-layer tool, and the
conditional edit tools. Names below are the real tool identifiers —
the set grows over releases, so re-derive from
`McpServer._list_tools()` + `ai_routes._build_native_tools()` rather than
trusting any count.

**Documentation & reference lookup** — the assistant grounds answers, never
guesses parameters:

| Tool | Purpose |
| --- | --- |
| `search_klipper_docs` / `read_klipper_doc` / `list_klipper_docs` | Full-text search and reads over the bundled (or installed) Klipper documentation, KWC-authored docs included. |
| `list_config_reference_sections` / `get_config_reference_section` | The Config_Reference section index and any single section's full parameter list. |
| `get_section_schema` | Machine-readable parameter spec per section type — what's required, what's legal, with types. |
| `search_example_configs` / `read_example_config` | Bundled example configs by board, printer, or feature. |

**Your project (read)**:

| Tool | Purpose |
| --- | --- |
| `search_user_configs` | Search your loaded configs; accepts several `keywords` per call and answers with a **REFERENCES checklist** — every occurrence with file, section, and line, per-name counts, in-string occurrences (`RESPOND MSG='level_bed'`) included. The rename/"everywhere" contract is mechanical: edit from the list, re-search, stop at 0. |
| `list_user_configs` / `list_user_config_sections` / `read_user_config` | Inventory and reads; reads are what edit anchors must quote verbatim. |
| `list_hardware` | Class sweeps over your project — "all macros", "all drivers", "all heaters" — with member-complete listings (never truncated to a page). |

**Validation & compute**:

| Tool | Purpose |
| --- | --- |
| `validate_klipper_config` | Validate a draft snippet you haven't staged. |
| `validate_config_project` | Validate your whole loaded project (the save-gate engine). |
| `validate_macro` | Check a `gcode_macro` against Klipper's Jinja rules — unbalanced blocks, unknown commands, missing homing. |
| `generate_macro_template` | Structured templates (PAUSE/PRINT_START/etc.) with include-flags. |
| `detect_board` | Identify the likely board from a config snippet or pin layout. |
| `calculate_rotation_distance` | Steps/mm math for belts and leadscrews. |
| `list_connected_devices` / `get_klippy_status` | Real serial/CAN devices; live Klipper state (ready / startup error / shutdown) — used before edits that depend on whether the printer is even up. |

**The edit layer is skill-gated**: write tools are advertised only after the
model calls `load_skill(name='config-editing')`, which injects the edit
protocol, op shapes, and laws for that session. The gate is model-triggered
by design — no UI toggle, no intent classifier — and a matching
`printer-memory` skill guards profile writes.

### Edit operations

`config_write` creates **new files only** (whole-file rewrites of existing
files are refused — wholesale regeneration is exactly where models drop
comments and mangle Jinja). `config_edit` performs one anchored operation
per call, thirteen ops:

| Op | Effect |
| --- | --- |
| `set_param` | Set/add a parameter in a section. |
| `add_section` / `replace_section` / `delete_section` | Section lifecycle; replace takes the full new body. |
| `move_section` | Move one section body **byte-exact** into another file (created if absent) and remove it from the source in the same op. |
| `rename_section` | Rename a section header (keeps the family; `gcode_macro Foo` → `gcode_macro Bar`). |
| `patch_section` | Replace exact lines inside any named section — config params *or* macro gcode. `old_text` is quoted verbatim from `read_user_config`; comment a line = prefix `'# '`, uncomment = the reverse. |
| `comment_section` / `uncomment_section` | Disable/restore a whole section including its `[header]` line. |
| `add_include` / `remove_include` / `comment_include` | Include-line management; comment keeps the line as `#[include x.cfg]` for re-enable. Works on any include line, including top-of-file ones with trailing comments. |
| `delete_file` | Delete a project file — refused while another file still includes it. |

Engine invariants that keep small models from corrupting configs (each one
is enforced in the op engine, not asked in the prompt, and each refusal
names the fix):

- **Text surgery, never re-render.** Ops edit the text; untouched lines stay
  byte-stable. A writer round-trip would churn your formatting.
- **One op, one section.** No `[header]` line may hide inside body text —
  the section's own header or a foreign one. Multiple new sections go in as
  separate ops.
- **Names resolve to reality.** Files and sections resolve
  case-insensitively to the project's real spelling, and only ever onto an
  identifier that already exists — a case-variant `add_section` is reported
  as the duplicate it is. Bare names (`Level_Bed` →
  `[gcode_macro Level_Bed]`) never hijack a coincident section type.
  Ambiguity is never guessed: the error lists the candidates.
- **The SAVE_CONFIG banner is a hard boundary** — the saved-settings block
  at the end of printer.cfg can't be targeted or spliced by any op.
- **Batching is optional**: one call may carry `ops[]` with up to 32
  operations. Every op is prepared against the working copy in order; good
  ops stay applied and **only failed indices bounce back** with their exact
  reasons, so one bad op never voids a good batch. A stringified array is
  parsed and recovered, not rejected.

### Validation and kickbacks

Every write validates as a **delta against the baseline**: pre-existing
problems in your config never block an edit, only *new* findings count.

- A **new error** refuses the write and kicks it back to the model, unstaged,
  with the concrete findings — the model corrects and continues; you never
  see the broken attempt. Since the unknown-param escalation, a hallucinated
  parameter in a section KWC grounds against the bundled Klipper snapshot is
  an error at the tool call, not an ignorable advisory.
- **Warnings ride along as advisories** on the change record — they never
  block a Keep. One exception, by design: a hallucinated gcode command
  (`unknown_gcode_command`) kicks back once, unstaged — invalid commands are
  never routed to a human to notice.
- **Kickback doctrine**: every error either moves the model one step closer
  or names the working alternative. Wrong file? "It exists in Y — pass
  file=Y." Missing include? The error enumerates the file's actual include
  lines so the model can re-quote. An error that only negates invites
  confabulation; these don't.
- Deterministic anti-oscillation: a second write to the same target in one
  request gets a DUPLICATE TARGET kickback; identical *failed* calls escalate
  to a directive and then a block. A mid-flight **steer** resets these (your
  redirect isn't the model flip-flopping).
- Repair feedback after a validation failure follows the measured shape:
  never quote the broken reply (models copy it byte-identically), lean
  context only (affected section + exact error + one imperative), and
  retry-exempt findings the model can't fix by regenerating end honestly
  instead of burning attempts.

### Budgets and loop control

The old flat write cap punished *work* — a legitimate 62-section request was
arithmetically impossible and "WRITE LIMIT REACHED" *taught models to give
up*. The current design charges waste only:

- **Thrash budget** (default 50 units, `KWC_THRASH_BUDGET`): failed write
  attempts, reads past a grace allowance, malformed-call corrections, and
  empty re-prompts spend it; **successful write ops are free** (they're
  reviewable work). Spending it triggers a **soft landing** — the directive
  states facts (what failed, what was over-read) and never claims further
  writes are blocked. Steering resets it.
- Turn caps of 10 (read-only) / 50 (edit-capable) plus an invisible absolute
  ceiling of 500 executed tool calls per request that announces nothing and
  only ever logs a harness-bug line.
- A malformed tool call is never executed and never quoted back: mechanical
  recovery is attempted first (fenced calls, smart quotes, python-call
  shapes), then one format-correction re-prompt, then the empty-reply
  backstop. Truncated calls fail closed, not open into wrong arguments.

### Honesty guards

The failure mode that matters most in an editing assistant is not a wrong
edit (the diff catches that) — it's a **claim the trace doesn't support**.
The harness never parses prose to judge intent, but it stamps the reply with
what actually happened:

- **Trace-truth notes** — if the loop gave up on any call, or claimed work
  with nothing staged, the reply is stamped with the failed-call facts, so
  "all done" can't ride over errors.
- **Realized-change reporting** — successful edit results report the change
  that *landed* (mini-diff for small ops, `+A/−R` counts with removed lines
  verbatim for big ones), so the model reviewing its own work sees reality,
  not its intention. This measurably closed staged-content gaps on the bulk
  families.
- **Declines are human acts** — a declined or timed-out decision reads as
  "the user chose not to apply", never as a system error, and the model is
  directed to end with a direct question instead of ruminating.

---

## Appendix

### Accuracy testing

`scripts/ai_chat_accuracy_test.py` is an end-to-end harness that drives the
**real backend `/ai/chat` endpoint** — the same one the frontend uses —
against a battery of questions with known success criteria. It exists so
model choice, prompt changes, and tool changes are measured, not argued.

Design laws earned the hard way:

- Each question is a **fresh chat** (single user message, own requestId) —
  no leaning on prior context.
- Every question grades two things: **answer accuracy** and **tool
  reliability** (right tool for the job). For edit questions the graded
  artifact is the **server-staged change set**, never the reply's prose —
  a model that *describes* the correct edit and stages nothing must fail,
  and a model that stages it correctly must pass whatever its summary says.
  (`PASS_NO_TOOL` marks a correct answer that skipped the expected tool.)
- Criteria kinds include staged header/param (Klipper's own case rules:
  alias names case-insensitive, section type tokens exact), staged regex,
  `any_of` arms, bulk `coverage` (distinct non-superseded sections),
  `no_fence` (rejects terminal ```cfg drafts), `single_request`, and a
  `failed_named_in_reply` honesty floor.
- **±3 on a full run is noise** on this bank; model-behaviour claims require
  consistent directional movement across ~3 reruns. Every mechanism ever
  shipped or deleted (completion guards, judge payloads, budgets) went
  through same-tip A/B arms on the full bank.
- Bank edits are rare and surgical: a criteria fix must show its intended
  verdict flips and zero collateral damage offline
  (`scripts/validate_criteria_offline.py`) before the bank changes, and only
  the touched qids need re-running.

### Question bank (111 questions)

| Family | Coverage |
| :--- | :--- |
| Core Tools (Q01–Q20, minus retired Q09) | Docs lookups, example configs, validation, calculations, edit routing. |
| Macro Authoring (MACRO-01..11) | Authoring, editing, fixing, templates, `validate_macro` checks. |
| Trident Configs (TRIDENT-01..16) | Real Trident configs (read/edit/delete/manage, cross-file edits, the `idle_timeout` multi-LED case). Read-only context. |
| Harness (HARNESS-01..03) | Self-checks: criteria that must reject a wrong staged artifact. |
| Edit Cases (MINIDIFF-01..04) | Staged-edit cases: `level_bed` adaptive mode, `max_accel`, pin edits, `pressure_advance`. |
| Ambiguity (AMBI-01..08) | Unnamed new files, hypotheticals, batch reads, explain-and-edit turns, bare-pin search. |
| Setup (SETUP-01..05) | New sections with no existing home (firmware_retraction, idle_timeout, arcs, save_variables, respond). |
| Live Routing (LIVE-01..07) | Routes between project validator / draft validation / devices / schema / reference / Klippy status. |
| Edit Tools (EDIT-01..06) | `config_edit` param edit, anchored gcode edit, cross-file pin edit, new file + `add_include`, pure Q&A stages nothing, `!` polarity kept on uncomment. |
| Skill Gate (SKILL-01..05, N01..04) | `config-editing` must load before any write path — and must NOT load on Q&A, how-to, pasted-text validation, or discuss-a-draft. |
| Tool Coverage (TOOL-01..08) | One case per shipped tool. |
| Rename (RENAME-01..03) | Header keeps the `gcode_macro` family; stale callers repaired. |
| Comment (COMMENT-01..06) | Whole-section comment/uncomment, single-line via `patch_section`, rename+uncomment combo. |
| Ack Guard (ACK-01/02, ACK-N01) | Promise-with-no-action rescued; pure Q&A never nudged. Native and text protocol pinned. |
| Bulk Edits (BULK-01..05) | Comment-every-section / comment-every-macro sweeps, rename sweep with in-string arms, six-section constructive add, honesty trap. Graded trace-only. |
| Memory (MEMORY-01..03) | Printer-memory auto-fill (opt-in `--include-memory`). |

### Current model results

All rows are the **current** bank (111 questions) at temperature 1.0, native
protocol, edit tools on, against the same backend. Ranges span the full-bank
runs closest to the shipped build; single-run deltas inside the range are
noise, not ranking.

| Model | Runs (PASS/111) | Band | Notes |
| --- | --- | --- | --- |
| Qwen3.8 27B | 109 / 110 / 108 | 97–99% | Three-arm full bank (2026-10-23); earlier same-build runs reached 111/111 once and never scored below 103 through the large-edit rework. Current-tip spot re-runs recovered every miss (6/6, plus BULK 5/5 twice and 3/5 once across three runs) — effectively at or above the band on today's build. |
| Gemma4 12B (QAT) | 102 / 104 / 104 | 92–95% | Same 2026-10-23 bank; current-tip spot re-run recovered 8 of its 14 union-misses. Persistent single gap: COMMENT-06 fails on every model and arm (see below). |
| Qwen3.5 4B | 97 | 87–95% | Full bank 2026-10-24 (87% this run); 8 of its 14 misses recovered immediately on a same-evening spot re-run, placing its true band ~87–95%. Its six consistent misses: MACRO-01, MINIDIFF-01, COMMENT-06, SKILL-02, SKILL-N04, ACK-02. |

Guard-arm evidence: the loop-exit completion guard A/B (off / echo-kickback
/ fresh-context judge, same tip, full bank) produced a ±1 spread with
**disjoint fail sets** on the 27B and mere failure-reshuffling on the 12B —
the guards were removed (2026-10-23) and the loop now trusts the model's own
"done" with honesty stamping as the backstop. Full forensics:
[AI_CHAT_TEST_HISTORY.md](AI_CHAT_TEST_HISTORY.md).

### Known failure families

Patterns that recur across models (useful for calibrating expectations, and
the map for future reliability work):

- **Staged-but-not-what-was-asked** — picking a blunter op (`replace_section`
  where anchored `patch_section` was needed) and missing a line. The dominant
  failure mode on smaller models; mostly closed by realized-change reporting.
- **COMMENT-06-class tool gaps** — rename + uncomment in one flow fails on
  every model and arm; this is TOOL capability, not loop guardianship, and is
  where further work goes.
- **Skill false-positives** — "draft it but don't touch my files" still
  tempts most models to load the edit skill; staging anyway is rarer. The
  review surface (Keep/Undo) is the real defense, not the gate.
- **Decision stalls** — an ambiguous premise (e.g. the named section already
  exists) can produce offer-two-options-and-ask closes instead of a staged
  edit. Safe, scored as a miss; more common on 27B.
- **Runaway loops on reasoning models** — historically repeated near-identical
  reads until timeout; controlled now by the thrash budget and repeat-call
  directives rather than a tight cap.
- **Variance law** — across 106 questions × 7 models on the older bank: 61
  passed on all 7, 45 were mixed, 0 failed on all 7. Re-baseline after any
  prompt or tool change, and require three runs before believing a
  model-behaviour difference.

### Running the harness

From the repo root, with the backend running on the port the harness is told
about:

```bash
python3 scripts/ai_chat_accuracy_test.py \
    --provider openai-compatible --api-url http://192.168.1.135:8080/v1/chat/completions \
    --model gemma-4-12b --max-tokens 8192 --temperature 1.0 \
    --tool-protocol native --edit-tools on \
    --base-url http://localhost:8099 \
    --output-dir reports/ai-chat-accuracy/<run-name>
```

- Pass `--max-tokens` and `--temperature` explicitly — unattended runs die
  on the interactive prompt otherwise.
- `--tool-protocol native` is correct for current llama.cpp servers (probe
  an endpoint before assuming otherwise); `auto` falls back to the text
  protocol per URL scheme.
- Subsets by qid: `--questions EDIT-01..06`, `--questions TRIDENT,AMBI-0*`,
  `--questions BULK`; `--question TEXT --check TEXT` for one ad-hoc case;
  `--list-questions` prints the bank (indices drift as it grows — search by
  qid, never hand-count).
- Cloud providers need `--api-key` or `KWC_TEST_API_KEY` (never logged).
- Reports land in `reports/ai-chat-accuracy/<run-name>/` as a human `.log`
  and a machine `.json` (per-question tool trace, backend-log slice,
  per-criterion verdicts, usage).
- **Staleness check before any bank run**: a healthy backend port does not
  mean current code — compare the process start time against the last
  commit; a backend older than the last source edit silently invalidates the
  whole run.

### Historical results

Older-bank numbers (55/62/94/106-question generations), the full harness
false-negative audit rounds, the R1 realized-change A/B, and the
judge/kickback experiment forensics moved verbatim to
[AI_CHAT_TEST_HISTORY.md](AI_CHAT_TEST_HISTORY.md). Treat the old
per-model tables there as historical baseline snapshots from superseded
prompt builds — do not compare them against current numbers.
