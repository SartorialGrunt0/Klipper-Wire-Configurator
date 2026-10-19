# AI Chat

The KWC AI assistant answers Klipper questions and edits configs, macros, and printer-memory profiles using the bundled Klipper documentation, example configs, and your loaded project files. Nothing the assistant does touches your config until you approve each change in the approval card, and nothing reaches disk until you save. The docs MCP points to your active config file path and the installed Klipper folder. This ensures the docs referenced match your installed version of Klipper and stay up to date.

I'm still experimenting with this feature, learning new ways help the model create accurate and desired outputs. My goal is for this to be entirely reliable using only a small local model.

## Configuration

Open the chat from the toolbar, then click the settings button to configure:

- **Provider** — OpenAI, Google Gemini, Anthropic, GitHub Copilot, an OpenAI-compatible endpoint (LM Studio, Ollama, etc.), or the local default.
- **API key** — required only for cloud providers; local servers usually don't need one.
- **Model** — any model the provider exposes; the model list is fetched from your endpoint.
- **Max tokens** — cap on the assistant's reply length (default 4096).
- **Temperature** — sets the model temperature (default 0.7)
- **Tool Format** — only for openAI compatible providers, allows a native tool calling or text protocol format (default Auto)

Provider settings, conversation history, and attached config files persist locally and are restored when you reopen a saved conversation.

## How a request works, from prompt to file edit

1. **You send a message.** The app builds the request context: your message, recent conversation history, attached config files, and the current printer memory file.
2. **The backend prepares the prompt.** It adds the assistant's operating rules, the built-in tool list (Klipper docs search, example configs, validation, board detection, macro templates, and more).
3. **The model answers with tools.** Every provider — local servers included — uses native function calling, with the text `tool` protocol kept as a fallback for servers that cannot do it. The backend runs the requested tools (for example, searching the bundled docs or validating a snippet) and feeds the results back to the model: up to ten read-only tool rounds, extended to fifty when edit tools are in play (2026-10-16 large-edit rework: a 62-section request batched via `ops[]` needs ~15–25 calls; the old cap of 20 *manufactured* early exits). Runaway protection is no longer the turn cap — it is the per-request **thrash budget** (below) plus an invisible absolute ceiling of 500 executed tool calls per request, which announces nothing and only ever logs a harness-bug line.
4. **Config edits are staged, not written.** To change a file the model must call `config_edit` / `config_write`. The **server** applies each operation mechanically to a working copy of your project and validates the result, so the assistant cannot fabricate a change, silently rewrite a whole file, or mangle lines it did not touch. Invalid edits are kicked straight back to the model to fix before you ever see them.
5. **You approve each change.** Every validated edit suspends the request and opens an **Approve / Decline** card showing the exact before/after lines the server computed. Approving puts the change into your **pending changes** as unsaved (dirty) work; declining leaves your config untouched. Nothing is written to disk until you use the toolbar "Save" menu — and your printer is never restarted behind your back. If no decision is made within 90 seconds the card **auto-declines** and the assistant reports honestly that you didn't respond; declining a card you still want to change is fine — just ask again.
6. **Long tool chains show progress.** While the assistant is working through tools, a small subordinate strip under the typing dots shows what it said it was doing plus the tools it has run (deduped, collapsible). It is strictly display state — progress text is never the answer, and it disappears when the reply lands.

## Printer memory

The assistant sees your printer memory (mainboard, toolhead, expander boards, kinematics, probe, etc.) as context on every request. If it is blank, the assistant investigates your configs and the bundled examples to propose a filled-in profile. Proposals come back as a `printer-memory` code block and are shown in a review dialog — saved only when you confirm.

## How the assistant targets config edits

> **Tool-mediated editing (the only edit path).** Config edits never go
> through prose. The model calls `config_edit` / `config_write` tools and
> the **server** applies each change mechanically to a working copy of
> your project. Each op is validated against the live project the moment
> it is requested, and every validated change stops at an **Approve /
> Decline** card whose diff is computed from the text that will actually
> be applied. Config code blocks in an answer are display-only — shown
> to you, never applied. The loop nudges the model (with exact call
> shapes) if it answers an edit request without staging it. The tools:
>
> - `config_edit` — one anchored operation per call on an **existing**
>   file: `set_param`, `add_section`, `replace_section`, `delete_section`,
>   `patch_section` (replace exact lines inside any named section —
>   config params or macro gcode alike; quote `old_text` exactly as
>   `read_user_config` returned it; comment a line out = `# ` in front),
>   `comment_section` / `uncomment_section` (disable / restore a whole
>   section including its `[header]` line), `delete_file`, `add_include`,
>   `remove_include`,
>   `comment_include` (disables an include as `#[include x.cfg]` instead
>   of deleting it).
> - `config_write` — creates **new files only** (wholesale rewrites of
>   existing files are refused; whole-file regeneration is where models
>   drop comments and mangle Jinja).
> - Errors carry exact reasons and name the working alternative (the file
>   that actually holds the section, the actual include lines), so the
>   model corrects itself instead of guessing.
> - Only a hard validation ERROR refuses the change; warnings ride the
>   card as advisories. Since the 2026-09-30 unknown-param escalation
>   (`unknown_param` in a section KWC grounds against the bundled Klipper
>   snapshot is an ERROR — Klipper refuses to load such a config), a
>   hallucinated parameter in a known section is now refused at the tool
>   call instead of slipping through as an ignorable advisory.
> - File and section names resolve **case-insensitively to the project's
>   real spelling** — `Printer.cfg` → `printer.cfg`, `Gcode_Macro level_bed`
>   → `[gcode_macro Level_Bed]` — matching what the read tools have always
>   done. The resolution only ever lands on an identifier that already
>   exists, so a case variant can never be created: an `add_section` whose
>   name differs only by case is reported as the duplicate it is. Ambiguity
>   is never guessed — the error lists the candidates.

## Large edits: batching, occurrence sweeps, budgets (2026-10-16 rework)

Requests like "comment out every macro" or "rename this everywhere" used to
land in a prose dump of ```` ```cfg ```` drafts instead of staged edits. The
rework fixed the machinery that manufactured that symptom:

- **`ops[]` batching.** One `config_edit` / `config_write` call carries up to
  32 operations (`MAX_OPS_PER_CALL`) in an `ops` array, each shaped exactly
  like the single-op form plus an `op` name. The server **prepares** every op
  against the working copy in order, then replays so the committed result and
  the per-op feedback come from the same engine. Feedback is **per index**:
  ops that applied stay applied, and only the failed indices bounce back with
  their exact reasons ("op 7 failed: ..."), so one bad op never voids a good
  batch. If a small model stringifies the array (JSON as a quoted string),
  `parse_maybe_stringified` recovers it instead of rejecting the call.
  Batching is always optional — single-op calls keep working unchanged.
- **Occurrence sweeps.** `search_user_configs` takes `keywords=['level_bed',
  'old_probe_home']` — several names per call — and every hit answers with a
  **REFERENCES checklist**: each occurrence with its section and line number,
  per-name counts included, in-string occurrences (`RESPOND MSG='level_bed'`)
  covered, not just section headers. The rename/"every reference" contract is
  now mechanical for the model: edit from the list, re-search, stop when the
  counts hit 0. The table serves the model's own discovery — the harness
  never grades "done" off it.
- **Thrash budget — charges waste, not work.** The old flat write cap
  charged every write attempt, so a legitimate 62-section request was
  arithmetically impossible in one prompt and "WRITE LIMIT REACHED" *taught
  the model to give up*. The budget is now inverted: it charges only waste —
  failed write attempts, reads past a 10-read grace, malformed-call
  corrections, empty re-prompts — while **successful write ops are free**
  (a state change is reviewable work, and the oscillation family the write
  cap guarded is covered deterministically by duplicate/supersede detection).
  Default 50 waste units per request (`KWC_THRASH_BUDGET` overrides; ≤0
  disables). Spending it is a **soft landing**: the directive states facts
  (what failed, what was over-read) and never claims further writes are
  blocked. Steering a request mid-flight resets the budget — the model
  didn't waste anything driving where you redirected it.
- **Completion check at the loop exit.** An edit-*intent* request that tries
  to close with confident prose while its trace shows zero staged writes
  gets **one** re-query that re-presents the request *and its own ledger*:
  per-file staged-edit counts with sampled section names, and the failed-call
  count with one-line errors. The model grades itself against facts instead
  of a vacuum (self-grading alone is the documented failure: a 12B's
  sycophancy asserts completion). Only one kick per request, like the ack
  guard; a steer re-arms it. The check skips cfg-fenced answers,
  continue-intent tails, and honest clarifying questions; the second prose
  exit closes normally. `KWC_COMPLETION_CHECK=bare|ledger` picks the A/B
  arm (default `ledger`); usage reports the kick count as
  `completionKicks`. The reply is now also stamped with a failed-call note
  when the loop gave up on any call, so "all done" cannot ride over errors.

### Engine invariants (2026-10-17, from the BULK bank autopsies)

The BULK family's first live runs traced every corruption path a small
model can drive through the draft engine. Each is now a hard rule inside
the engine (not prompt advice), and each kickback names the fix so the
model can self-correct on the next call:

- **One op, one section: no header lines in body text.** `replace_section`,
  `patch_section`, and `add_section` refuse any `[header]` line inside the
  text they write — the section's own header re-pasted *or* a foreign one.
  Klipper splits files on header lines, so a smuggled header nests or
  splices sections while per-op validation still passes; the staged file
  then refuses to load. Multiple new sections go in as separate `ops[]`
  entries.
- **A bare section TYPE never resolves onto a coincident family name.**
  The bare-name convenience (`Level_Bed` → `[gcode_macro Level_Bed]`) skips
  requests that are themselves complete section types: with
  `[tmc2209 stepper_x]` present, `section='stepper_x'` no longer lands on
  the driver section (it reports *not found* + `add_section`, instead of
  hijacking the driver or blocking the real stepper with a phantom
  "already exists").
- **Batch kickbacks carry the concrete findings.** A failed `ops[]` entry
  bounces back with its actual `newErrors` (up to 3, same lean shape as
  single-op feedback) — "failed validation" alone sent a model re-sending
  invented params for 50 rounds.
- **`add_section` accepts the header under `new_section` too** — the
  key rename ops use — because small models mix the two; the value lands
  verbatim and an explicit `section` still wins.
- **`list_hardware` overflow never truncates the member list.** With 30+
  matches, bodies are trimmed but EVERY `[header] in file` line is listed
  — the class-sweep law ("cover every listed member") is only honest if
  the enumeration is complete (a truncated page hid a macro from an
  otherwise-complete sweep).
- **changeSet rows carry the canonical header** resolved *before* the op
  applied, so a macro commented via its bare name records as
  `gcode_macro M109`, not `M109` — the review pane and trace-based
  grading see the same truth.
- **TMC driver refs are validated across every file in the session, not
  just printer.cfg's include closure** (validator F25). A staged
  `[tmc2209 x]` next to an unrelated `printer.cfg` used to validate clean
  because the edited file sat outside the closure — Klipper would hard-
  fail the boot (`Could not find config section '[x]' required by tmc
  driver`) the moment the file is included. Editor-carried files are the
  user's intended config, so binding checks and their reference
  resolution span all of them; the delta gate cancels pre-existing
  findings, so only a new write can trigger the kickback.

## Stopping, retrying, and resuming

- **Stop** — while the assistant is processing, the Send button becomes Stop. Pressing it cancels the request immediately.
- **Retry** — if a request fails (timeout, no model loaded), your message stays in the conversation and a Retry button re-sends it with full context.
- **New chat after an interruption** — you can keep the current conversation (messages, provider settings, and attached config files) or start fresh.

## Accuracy testing

`scripts/ai_chat_accuracy_test.py` is an end-to-end harness that drives the **real backend `/ai/chat` endpoint** — the same one the frontend uses — against a battery of questions with known success criteria. It exists so we can measure how well a given model actually answers Klipper questions and uses the embedded tools, and to catch regressions when the prompt, tools, or doc index change.

How it works:

- Each question starts a **fresh chat dialog** (a single user message, its own requestId), so the model cannot lean on prior conversation context.
- Every question checks two things: **answer accuracy** and **tool reliability** (does the model use the right embedded tool for the job?). For edit questions the graded artifact is the server-staged change set (`pendingEdits`), not the reply's prose — declared `edit_criteria` grade the change that will actually land.
- Every step is logged: the request payload, raw response, tool names and tool-turn count, the per-question slice of the backend's own log, the pass/fail evaluation for each criterion, and a final summary.

### Question Bank (111 questions)
| Item / Feature | Description & Details |
| :--- | :--- |
| Core Tools (Q01–Q20, minus retired Q09) | Covers docs lookups, example configs, validation, calculations, and tool-mediated edit routing. |
| Macro Authoring (MACRO-01..11) | Includes macro authoring, editing, fixing, template options, and individual `validate_macro` checks. |
| Trident Configs (TRIDENT-01..16) | Real Trident configs from `reference/Trident_backup` and backend user configs (read, edit, delete, manage), incl. cross-file edits and the `idle_timeout` multi-LED case. Files are read-only context. |
| Harness (HARNESS-01..03) | Harness self-checks: criteria that must reject a wrong staged artifact. |
| Edit Cases (MINIDIFF-01..04) | Staged-edit cases carried forward under their original qids: `level_bed` adaptive mode, `[printer] max_accel`, pin edits, tool-required `pressure_advance`. |
| Ambiguity Cases (AMBI-01..08) | Handles new-file drafts without names, hypothetical "what if" questions, batch section reads, multi-topic explain-and-edit turns, and content search for bare pin values. |
| Setup Cases (SETUP-01..05) | New-section requests with no existing home (firmware_retraction, idle_timeout, G2/G3 arcs, save_variables, respond). |
| Live Routing (LIVE-01..07) | Routes between project validator vs draft validation vs devices vs schema vs reference vs Klippy status (incl. restart-safety ordering). |
| Edit Tools (EDIT-01..06) | Tool-mediated editing (the only edit path): param edit via `config_edit`, gcode-body anchor edit, cross-file pin edit, new-file + `add_include` staging, pure Q&A must stage nothing, and commented-param uncomment keeping the `!` polarity. |
| Skill Gate (SKILL-01..05, SKILL-N01..04) | The `config-editing` skill must load before any write path (direct param, macro body, multi-part, new file + include, implicit "my prints wobble"), and must NOT load on pure Q&A, how-to, pasted-text validation, or discuss-a-draft. |
| Tool Coverage (TOOL-01..08) | One case per shipped tool: reference index, section index, board detection, rotation-distance calc, macro template, strict new-file routing, live devices, live Klippy state. |
| Rename Cases (RENAME-01..03) | Macro-section renames: the staged header must keep the `gcode_macro` family, and stale callers must be repaired. |
| Comment Cases (COMMENT-01..06) | Comment/uncomment ops: whole-section disable including the header via `comment_section`, block restore via `uncomment_section`, single-line comment/uncomment via `patch_section`, and the rename+uncomment combo. |
| Ack Guard (ACK-01/02, ACK-N01) | Mid-loop ack-guard probes (Phase 6.5.5): the same single-value edit pinned to native AND text protocol with `expect_no_ack_stall` (a promise-with-no-action rescued by the injected directive FAILS even when the staged artifact is right), plus a pure-Q&A case the guard must never touch. Run as `--questions ACK,ACK-N`. |
| Bulk Edits (BULK-01..05) | Large-edit rework (2026-10-17): comment-every-section and comment-every-macro sweeps on engine-verified synthetic fixtures (thresholds derived from the fixture inventory, never hand-counted), a Level_Bed-shaped rename sweep with in-string `RESPOND MSG=` arms, a constructive pin-map add of six sections in one request, and an honesty trap (a named-but-missing section the reply must own up to). Graded trace-only: `coverage` counts distinct non-superseded sections in the server `changeSet`, `no_fence` rejects terminal-reply ```` ```cfg ```` drafts, `single_request` bounds loop economy, `failed_named_in_reply` is the honesty floor. Run as `--questions BULK`. No baselines yet — first numbers land with the ablation arms below. |
| Optional Memory Check (MEMORY-01..03) | Adds printer-memory auto-fill checks when the `--include-memory` flag is used. |

### Baselines (pre-fix)

Full 106-question bank on `improvement/ai-chat-edit-refactor` @ `9c6bdf4`, native
tool protocol, `--max-tokens 8192 --temperature 0.7`, edit tools on, one model per
run (runs under `reports/ai-chat-accuracy/bank106-r1-*`). These numbers still
carry the four round-1 harness false negatives and the four round-2 ones:

| Model | Host | PASS | Rate | Errored |
| --- | --- | --- | --- | --- |
| gemma-4-12b | CachyPC | 97/106 | 92% | 0 |
| qwen3.6-35B-A3B | Thor | 97/106 | 92% | 0 |
| gemma-4-26B-A4B | Thor | 97/106 | 92% | 1 |
| gemma-4-e4b | CachyPC | 91/106 | 86% | 0 |
| qwen3.5-4b | CachyPC | 90/106 | 85% | 0 |
| qwen3.8-27B | Thor | 89/106 | 84% | 12 |
| qwen3.5-9b | CachyPC | 86/106 | 81% | 0 |

Errored = per-request failure (provider 5xx or the 600 s timeout), not a model
miss. Errored qids were re-run where possible; `qwen3.8-27B` kept 12 timeouts
(its 600 s loops), so its row is understated — 3 of its misses are `COMMENT` and
1 is `RENAME`, families where the shortfall is infra, not quality. `gemma-4-26B-A4B`
has one genuine repeat-timeout (`AMBI-02`).

### Updated (post-fix)

Eight harness false negatives were corrected across two rounds (2026-09-28 →
09-29, see below), plus one premise-conflict question reworded (`SETUP-02`). The
bank edits touched **nine qids and nothing else**, so re-running those nine on a
model settles its whole score: every other qid's verdict is unaffected by
construction. Runs: `bank106-r2-spotfix-*`.

| Model | Host | Baseline | Updated | Evidence |
| --- | --- | --- | --- | --- |
| gemma-4-12b | CachyPC | 97/106 | **102/106** | **full bank re-run** — measured |
| gemma-4-26B-A4B | Thor | 97/106 | **102/106** | 9-qid spot (+5) |
| qwen3.6-35B-A3B | Thor | 97/106 | **100/106** | 9-qid spot (+3) |
| qwen3.5-4b | CachyPC | 90/106 | **95/106** | 9-qid spot (+5; `Q19` recovered from a provider 500) |
| gemma-4-e4b | CachyPC | 91/106 | **93/106** | 9-qid spot (+3, −1: `SETUP-02`) |
| qwen3.8-27B | Thor | 89/106 | **93/106** | 9-qid spot (+4; 3 were infra ERRORs, 9 timeouts still unmeasured) |
| qwen3.5-9b | CachyPC | 86/106 | **88/106** | 9-qid spot (+3, −1: `MACRO-01`) |

`gemma-4-12b` was re-run on the **full** bank to check the method: 102/106, 0
errored, exactly the spot projection. Its seven flips up are `MACRO-01`,
`TRIDENT-10`, `AMBI-07`, `SETUP-05`, `COMMENT-03` (the fixes) plus `COMMENT-02`
and `SKILL-N01` (variance — neither was edited either round); the two down
(`MACRO-03`, `AMBI-02`) are variance on untouched qids. Its four remaining
non-passes are `MACRO-03` (fixed the macro correctly but staged it into a NEW
`fix_me.cfg` + include — the criterion's `any_of` covers staging into
printer.cfg or a display block, not a third file), `AMBI-02` (the registry
kickback refused the new file and the model went on to stage 12 section
**deletions** in printer.cfg — partial, and destructive in effect if approved),
`SKILL-N04` (the open nudge question) and `ACK-N01` (conditional pass, no tool
needed).

Per-defect flips across all seven models: `COMMENT-03` +5, `SETUP-05` +5,
`TRIDENT-10` +4, `MACRO-01` +3, `Q19` +3, `Q04` +2, `TOOL-05` +2, `AMBI-07` +1,
`SETUP-02` +1 (against one regression each on `SETUP-02` and `MACRO-01`).
`±1` on a single run is noise on this bank — only consistent, directional
movement is evidence.

### R1: realized-change reporting (2026-10-18, 111-qid bank, gemma-4-12b)

Success results now report the REALIZED change, not the intended one
(`feat(ai-edit) 1774bac`): ≤12 changed lines show a mini-diff under the
summary; larger ops collapse to `+A/−R` counts with removed lines verbatim;
deletes name lines without re-shipping the block; clean batch ops stay lean
(failed-then-retried ops show their diff). Both arms run with the
loop-exit kickback DISARMED (`--completion-check off`, the new harness
default for bank runs).

Arms: baseline = `3ead333` worktree (pre-R1), R1 = tip `1774bac`;
`reports/ai-chat-accuracy/{r1base-bank111, r1-bank111}/`.

| Arm | PASS | fixed | regressed | avg turns | avg tok |
| --- | --- | --- | --- | --- | --- |
| baseline `3ead333` | 103/111 | — | — | 3.15 | 1004 |
| R1 tip | 105/111 | `BULK-02` `Q14` `Q16` `TRIDENT-15` | `AMBI-02` `MACRO-03` | 3.18 | 1066 |

Net +2 on the 110-qid overlap. The two regressions are the SAME two qids
this doc already flags as gemma's run-to-run variance (`MACRO-03` stages
into a third file; `AMBI-02` registry-kickback refusal shape) — single-run
±1 noise by the rule above, not R1-attributable. The four fixes are all
staged-content misses (a swept LED line, two staged-section gaps, BULK-02
coverage) consistent with the recognition-gap thesis: seeing the realized
diff let the model close gaps the intent summary hid. Context cost +6%
avg completion tokens, turns flat. Single-run evidence; BULK-04 still
fails in both arms (known pin-map construction issue, tracked separately).

### Guard A/B: echo kickback vs fresh-context judge (2026-10-19, gemma-4-12b)

Both arms on the SAME tip (`58c416f`), guard ARMED both arms, only the
mechanism differs: echo = the shipped kickback (worker re-answers its
own close against the ledger); judge = independent fresh-context audit
(request + ledger, no worker transcript, quote-validated `continue`,
verdict cap 2, fingerprint-unchanged skip). Harness-only selector
`completionGuard`; product default remains kickback.
`reports/ai-chat-accuracy/{guard-echo-ab, guard-judge-ab}/`.

| Arm | PASS | fixed | regressed | avg turns | avg tok | wall |
| --- | --- | --- | --- | --- | --- | --- |
| echo | 103/111 | — | — | 3.38 | 1297 | 1469 s |
| judge | 105/111 | `BULK-01` `BULK-05` `MACRO-07` | `COMMENT-04` | 3.15 | 1225 | 1540 s |

Mechanics: the judge graded 34 closes (16 `done`, 18 `continue`); the
echo kicked 30. Every continue ended at grade #1 (the cap / fingerprint
skip fired — no ping-pong seen). `BULK-01` passed after a continue +
fingerprint-flag close. Turns flat-to-down (3.38→3.15): the judge
replaces the transcript-heavy worker reclose with a ~1 KB fresh call,
so measured tokens are down ~6% while wall time is up ~5% (one extra
round on 18 continues). The lone regression (`COMMENT-04`,
rename_existing uncomment) is the bank's known ±1 single-run shape.

Caveats before crediting: single run each, same-day host; judge verdicts
that fired on eventually-PASS questions prove co-occurrence, not
causation, per-fire. The direction is right (bulk families 2/5→4/5,
zero ping-pong, cost neutral) — this is the evidence to flip the product
default per plan 2.4's gate, but only after the next bank round or a
repeat confirms it. Judge model = worker model here (gemma grading
gemma); `KWC_JUDGE_MODEL` targeting a stronger auditor is untested.

### Judge payload A/B: labels vs dump (2026-10-19, gemma-4-12b)

`completionJudgePayload: dump` adds the deterministic facts the labels
arm lacked: PROJECT INVENTORY (live section headers per file) + CURRENT
TEXT OF EDITED FILES (post-edit state, caps). Same trigger, same rules.
`reports/ai-chat-accuracy/{guard-judge-ab, judge-dump-ab}/`.

| Arm | PASS | fixed | regressed | judge fires | continue | flagged |
| --- | --- | --- | --- | --- | --- | --- |
| labels (`guard-judge-ab`) | 105/111 | — | — | 34 | 18 | 17 |
| dump (`judge-dump-ab`) | **106/111** | `COMMENT-04` `MACRO-02` | `TRIDENT-03` | 33 | **9** | 8 |

Net +1 against labels; mechanism matters more than the count. **More
evidence made the judge more confident, not more trigger-happy**: `done`
16→24 while `continue` fell 18→9. The labels arm's over-strict class
(invisible reads graded as skipped work, e.g. Q16's "no docs search
staged") largely disappears when the auditor sees current file text.
The 9 remaining continues are now *factual* gaps (staged 0 edits vs a
delete ask — TRIDENT-03's quote names the instructed shape the ledger
contradicts).

`TRIDENT-03` (the regression) is instructive: dump judge said
`continue` (deletion asked, ledger shows 0 edits); the worker's reclose
still didn't stage the delete → delivered flagged → FAIL on
`staged_section_absent`. The labels arm got PASS by never judging.
That's honest under-delivery, flagged — the guard did its job; the
worker's reclose didn't.

Cost: dump judge payloads avg 8.4 KB (5.4–11 KB observed) vs ~1.2 KB
labels, on ~1/3 of questions — invisible against worker context.
`COMMENT-04` fixing itself is the thesis in one qid: `rename_existing`
is content, and content is exactly what the dump made gradeable.

Single runs; the net-1 stays noise-adjacent — but the verdict-mix shift
(done↑ continue↓ flagged 17→8, no ping-pong) is mechanism evidence in
the same direction as the guard A/B. Dump mode is the sharper, calmer
auditor. Next lever unchanged: `KWC_JUDGE_MODEL` on a stronger auditor.

### Family detail (baseline run, pre-fix)

| Model | Q | MACRO | TRIDENT | HARNESS | MINIDIFF | AMBI | SETUP | LIVE | EDIT | RENAME | COMMENT | SKILL | SKILL-N | TOOL | ACK | ACK-N |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gemma-4-12b | 19/19 | 9/10 | 15/16 | 2/2 | 4/4 | 7/8 | 4/5 | 7/7 | 6/6 | 3/3 | 4/6 | 5/5 | 2/4 | 8/8 | 2/2 | 0/1 |
| qwen3.6-35B-A3B | 18/19 | 10/10 | 15/16 | 2/2 | 4/4 | 8/8 | 3/5 | 6/7 | 6/6 | 3/3 | 5/6 | 4/5 | 3/4 | 8/8 | 1/2 | 1/1 |
| gemma-4-26B-A4B | 18/19 | 9/10 | 15/16 | 2/2 | 4/4 | 6/8 | 4/5 | 7/7 | 6/6 | 3/3 | 5/6 | 4/5 | 4/4 | 8/8 | 2/2 | 0/1 |
| gemma-4-e4b | 18/19 | 8/10 | 13/16 | 2/2 | 3/4 | 6/8 | 4/5 | 7/7 | 5/6 | 3/3 | 4/6 | 4/5 | 3/4 | 8/8 | 2/2 | 1/1 |
| qwen3.5-4b | 18/19 | 9/10 | 13/16 | 2/2 | 3/4 | 6/8 | 4/5 | 7/7 | 5/6 | 3/3 | 5/6 | 4/5 | 3/4 | 6/8 | 2/2 | 0/1 |
| qwen3.8-27B | 16/19 | 7/10 | 16/16 | 2/2 | 4/4 | 3/8 | 3/5 | 7/7 | 6/6 | 2/3 | 3/6 | 5/5 | 4/4 | 8/8 | 2/2 | 1/1 |
| qwen3.5-9b | 16/19 | 8/10 | 15/16 | 2/2 | 3/4 | 7/8 | 3/5 | 7/7 | 5/6 | 2/3 | 3/6 | 4/5 | 3/4 | 6/8 | 2/2 | 0/1 |

Movement against the previous 94-Q baseline, on the **94 overlapping qids** (all
four documented models re-measured on the same host, so this is apples-to-apples):

| Model | New | Old | Δ |
| --- | --- | --- | --- |
| gemma-4-12b | 88/94 | 92/94 | **−4** |
| qwen3.5-4b | 80/94 | 78/94 | +2 |
| gemma-4-e4b | 81/94 | 77/94 | +4 |
| qwen3.5-9b | 79/94 | 73/94 | **+6** |

gemma-4-12b is the only genuine regression; its losses concentrate in `SKILL-N01`
(skill false-positives 1/4 → 2/4) plus two of the harness false negatives above.
`TRIDENT-15` — previously the all-model failure — now passes on 5 of 7.

Failure modes seen across the models (from their traces):

- **Staged but not what was asked** (the dominant mode) — the model picks a
  blunter operation than the case needs (`replace_section` or `set_param`
  where an anchored `patch_section` is required) and the staged text misses
  the required line. This is what fails `EDIT-02` / `MINIDIFF-01` / `SKILL-02`
  (the `level_bed` adaptive-anchor trio) on 4 of 7 models. Verified genuine
  against Klipper's own source: `bed_mesh.py` gates adaptive mode on
  `gcmd.get_int('ADAPTIVE', 0)`, so `adaptive=true` is invalid and
  `adaptive_margin` alone does **not** enable it. Only gemma-4-12b writes the
  documented `ADAPTIVE=1`.
- **Skill gate fires on an explicit "don't change my files"** — `SKILL-N04`
  ("Draft me a PARK_X macro… Don't add it to my config"). 5 of 7 models load
  the editing skill and 4 of 7 stage an edit anyway. Traced end-to-end: the
  model writes the draft, the backend fires its edit-prose nudge, and the
  nudge's leading exception — *"Unless the user explicitly said NOT to change
  their files…"* — is honoured by only 1 of 7 (qwen3.8-27B, the only pass).
- **Over-clarification** — qwen3.8-27B alone refuses to stage on `Q14`, `Q17`
  and `MACRO-02`, because each question's premise contradicts the real Trident
  fixture (a `[bed_mesh]` already exists; `PRINT_START` is heavily customised).
  Safe behaviour, scored as a miss — a question-design question, not a bug.
- **Runaway tool loops** — qwen3.8-27B burned 21 tool calls and 108k characters
  of context on `MACRO-03`, a question about a 7-line macro, and hit the
  10-minute request ceiling. 12 of its 106 questions timed out this way; every
  other model had ≤3 request errors.
- **Registry kickback not re-sent** — `AMBI-02` / `AMBI-03`: an unknown gcode
  command (`CLEAN_NOZZLE`, `SMART_PARK` from plugins) kicks the write back
  unstaged, and the design needs an *identical* resend to pass. Most models
  narrate the rejection and stop instead.
- **Nothing staged after burning the retry budget** — the model keeps re-sending
  variations the server rejects, then lands on the soft-landing summary. The
  write-attempt cap keeps this honest, but the loop is not converging for the
  smaller models.

**Harness false negatives — FIXED 2026-09-28, awaiting re-run.** Four were
found by auditing every repeat failure against the real artifacts, and are now
corrected in the harness:

- `AMBI-07` graded the reply *prose* for a numeric assignment, so a correct
  staged edit FAILed whenever the model wrote "added to `[extruder]`". The
  explanation half stays prose; the edit half is now `staged_regex`. This
  flipped 2 false negatives to PASS **and 1 false positive to FAIL** (a model
  that explained but staged nothing used to pass).
- `MACRO-01` demanded `G1…X0` and rejected `G0`, which the bundled Klipper docs
  define as the same command ("Move (G0 or G1)").
- `Q19`'s clarifying-question regex did not match "I'll need some basic hardware
  details… paste them here".
- `COMMENT-03` asked for `max_accel` — a *required* `[printer]` parameter — to be
  commented out, which the validator correctly refuses to stage; passing needed
  an unstated two-part swap (1 of 7 managed it). Retargeted to the optional
  `max_z_velocity`.
- The rename criteria matched the macro **name** case-sensitively
  (`[gcode_macro LEVEL_BED1]`), but Klipper upper-cases the alias
  (`gcode_macro.py`: `self.alias = name.upper()`) and the command token before
  dispatch, so `Level_Bed1` and `LEVEL_BED1` are the *same* command. Those
  checks now use `staged_header` — type token exact (it resolves to a module
  filename, so `[Gcode_Macro …]` genuinely fails to load), instance name
  case-insensitive.

Two latent scoring gaps were closed at the same time: `staged_param` was
case-sensitive while `staged_regex` is not (Klipper normalises gcode param names
and config option names, so those checks are now `staged_param_ci` — section
headers deliberately stay case-sensitive), and `not_staged` was file-scoped, so
a "don't change my files" request passed when the model edited a *different*
file (`not_staged_any` closes it).

Validation and evidence: `reports/ai-chat-accuracy/bank106-r1-criteria-audit.md`;
re-check any of it offline with `scripts/validate_criteria_offline.py`.

**Harness false negatives, round 2 — FIXED 2026-09-29, awaiting re-run.** A
second pass audited the remaining non-PASS slots across all seven runs and
found four more defects (all on failures that repeat on ≥2 models), plus two
product defects the bank cannot see:

- `Q04`'s list regex accepted only `-` bullets and bare filenames, so
  `* **Config_Reference.md**` and `**\`Config_Reference.md\`**` (bold wrapping
  code) — both naming five real docs — were scored FAIL.
- `SETUP-05`'s criterion was file-scoped to `printer.cfg`, but the fixture's
  `[respond]` lives in `mainsail.cfg:61` (empty). Driving the real `EditSession`
  (`scripts/probe_setup05_respond_routes.py`) shows `add_section` in
  `printer.cfg`, `set_param` and `replace_section` in `mainsail.cfg` all stage
  cleanly, so the arm now accepts either file.
- `TRIDENT-10` asked for a **display** block ("return the corrected macro in a
  fenced cfg code block with a '# file: printer.cfg' hint line") while the
  criteria graded the staged artifact. 5 of 7 models followed the instruction
  with a perfect fix and FAILed; the prompt now asks for the edit, like every
  other artifact-graded qid.
- `TOOL-05`'s header arm graded the reply prose, but the deliverable there is
  the *tool's* return value: two models called `generate_macro_template` with
  `include_bed_mesh: true` and the tool returned the full
  `[gcode_macro PRINT_START]` body, while their prose only described it. New
  `tool_output_regex` criterion kind grades `toolCalls[].output`.
- Two questions were re-worded for premise conflicts (`SETUP-02` asks for a
  *change* now; `SETUP-05` names the target state), the same family as
  `COMMENT-03`. `Q17` / `MACRO-02` / `Q14` have the same shape and are left
  as-is pending a decision.

Offline validation (`scripts/validate_criteria_offline.py`, now with 15
negative controls): **6 new verdict flips, all intended, 0 controls wrongly
passing** — the widening did not touch a single unaffected qid. `TRIDENT-10`
and `SETUP-02` cannot be replayed (their question text changed), so they need
the live re-run.

**Round-2 spot re-run — MEASURED.** The 9 qids touched by rounds 1–2 were
re-run on all seven models (same hosts and flags, `bank106-r2-spotfix-*`, after
restarting the backend at 10:02 so it served the fixed code):

| model | before | after | Δ |
| --- | --- | --- | --- |
| gemma-4-12b | 4/9 | **9/9** | +5 |
| qwen3.5-4b | 2/9 | **7/9** | +5 |
| gemma-4-26B-A4B | 3/9 | **8/9** | +5 |
| qwen3.6-35B-A3B | 5/9 | **8/9** | +3 |
| qwen3.8-27B | 4/9 | **8/9** | +4 (3 were infra ERRORs) |
| gemma-4-e4b | 5/9 | **7/9** | +2 |
| qwen3.5-9b | 4/9 | **6/9** | +2 |
| **total** | **27/63** | **53/63** | **+26** |

No errored qids in any leg. Per-defect: `COMMENT-03` +5, `SETUP-05` +5,
`TRIDENT-10` +4, `MACRO-01` +3, `Q19` +3 (1 criteria, 2 infra), `Q04` +2,
`TOOL-05` +2, `AMBI-07` +1, `SETUP-02` +1. **These 9 qids are now measured and
the rest of the table above still is not.**

Two regressions surfaced, and one of them is a criterion contradicting the
product's own rule: `SETUP-02` — the fixture defines `[idle_timeout]` in BOTH
`printer.cfg` and `Hotkey.cfg`, and **4 of 6 models edit the `Hotkey.cfg` copy**
(one citing load order). KWC's validator agrees with them:
`severity=info, code=project_duplicate, "Section [idle_timeout] is defined
multiple times in this file — the later definition wins"`
(`scripts/probe_duplicate_idle_timeout.py`). The criterion only accepts
`printer.cfg`, so models behaving the way the app itself describes are scored
FAIL. `MACRO-01` failed qwen3.5-4b on a *parameterised* park
(`params.PARK_X|default(0)`, the idiom KWC's own `PAUSE` template uses) while
demanding a literal `X0`.

Product fixes shipped with the same work, both model-agnostic:

- **Staged work no longer reports as a failure.** When a request ends with no
  visible text, the reply used to be *"I wasn't able to generate a response.
  Please try rephrasing your question."* — which hit **11 qids in one model's
  run, every one with a validated edit waiting for review**. The fallback now
  names the staged changes ("I staged 1 change to printer.cfg for your
  review…") and keeps the old wording only when nothing was staged.
- **Orphan tool-call markup no longer reaches the bubble.** Three replies
  carried the *tail* of a native call (`<parameter=…>…</parameter>`,
  `</function>`, `</tool_call>`) that every opener-anchored cleanup regex
  missed — one of them was the entire reply. `TOOL_RESIDUE_RE` strips those
  fragments and, when nothing else survives, routes the reply into the empty
  fallback above instead of showing raw markup.

Evidence for the second round (per-qid verdicts, the probe output, and the
replay diff): `reports/ai-chat-accuracy/bank106-r1-failure-states.md`.

**Variance, not shared breakage.** Across 106 questions × 7 models: **61 pass on
all 7**, **45 are mixed**, and **0 fail on all 7**. 17 of the mixed ones fail on
exactly 1 of 7 — single-model flakiness. Only 6 fail on 5+ of 7, and of those 3
are harness defects above rather than model gaps. Treat a few points of spread as
noise and require three runs before claiming a model-behaviour difference.
Re-baseline after any prompt or tool change.

### Running the harness

From the repo root, with the backend running:

```bash
python3 scripts/ai_chat_accuracy_test.py \
    --provider openai-compatible --api-url http://192.168.1.135:8080/v1/chat/completions \
    --model gemma-4-12b --max-tokens 8192 --temperature 0.7 \
    --tool-protocol native --merge-system-messages --edit-tools on \
    --base-url http://localhost:8099 \
    --output-dir reports/ai-chat-accuracy/<run-name>
```

- Always pass `--max-tokens` and `--temperature` explicitly — unattended/background runs die on the interactive prompt otherwise.
- Tool protocol: the default `--tool-protocol auto` uses the text ```` ```tool ```` protocol for local http endpoints and native function calling for cloud https endpoints. For local llama.cpp servers, `--tool-protocol native` forces OpenAI native `tool_calls` — required for gpt-oss (text replies come back empty) and generally equal-or-better for gemma/qwen.
- `--merge-system-messages` matches the shipped request shape (single leading system message; strict chat templates need it). `--edit-tools on|off` forces the write tools visible/hidden regardless of the model class.
- Cloud providers need an API key: pass `--api-key`, set `KWC_TEST_API_KEY`, or answer the interactive prompt (never echoed; keys are redacted to `***` in logs).
- Useful flags: `--questions EDIT-01..06` or `--questions TRIDENT,AMBI-0*` (QID-based subsets; positional `1-5,8` still works but drifts as the bank grows), `--question TEXT --check TEXT` (one ad-hoc question), `--list-questions` (print the question bank, no API calls), `--include-memory` (printer-memory auto-fill tests; the backend's printer memory is backed up, blanked to trigger auto-fill, and restored afterward).
- Reports land in `reports/ai-chat-accuracy/<output-dir>/` as both a human-readable `.log` and a machine-readable `.json`.
