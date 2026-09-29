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
3. **The model answers with tools.** Every provider — local servers included — uses native function calling, with the text `tool` protocol kept as a fallback for servers that cannot do it. The backend runs the requested tools (for example, searching the bundled docs or validating a snippet) and feeds the results back to the model: up to ten read-only tool rounds, extended to twenty when edit tools are in play, with a per-request write-attempt cap so a stuck edit loop lands on an honest summary instead of burning the budget.
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
> - File and section names resolve **case-insensitively to the project's
>   real spelling** — `Printer.cfg` → `printer.cfg`, `Gcode_Macro level_bed`
>   → `[gcode_macro Level_Bed]` — matching what the read tools have always
>   done. The resolution only ever lands on an identifier that already
>   exists, so a case variant can never be created: an `add_section` whose
>   name differs only by case is reported as the duplicate it is. Ambiguity
>   is never guessed — the error lists the candidates.

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

### Question Bank (106 questions)
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
| Optional Memory Check (MEMORY-01..03) | Adds printer-memory auto-fill checks when the `--include-memory` flag is used. |

### Current results

Baselines on `improvement/ai-chat-edit-refactor` @ `9c6bdf4`, **full 106-question
bank**, native tool protocol, `--max-tokens 8192 --temperature 0.7`, edit tools on,
one model per run (runs under `reports/ai-chat-accuracy/bank106-r1-*`):

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

**The table above is PRE-FIX scoring.** The four harness false negatives it
still counts were corrected on 2026-09-28 (see below) and the affected qids have
not been re-run, so the "adjusted" column is a *prediction* of the next run, not
a measured result:

| Model | raw | adjusted | credits |
| --- | --- | --- | --- |
| gemma-4-12b | 97 | 98 | AMBI-07 |
| qwen3.6-35B-A3B | 97 | 98 | Q19 |
| gemma-4-26B-A4B | 97 | 98 | AMBI-07 |
| gemma-4-e4b | 91 | 93 | MACRO-01, AMBI-07 |
| qwen3.5-4b | 90 | 91 | AMBI-07 |
| qwen3.8-27B | 89 | 89+ | (AMBI-07 errored — unknown) |
| qwen3.5-9b | 86 | 86 | — |

Family detail (raw PASS/total):

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
