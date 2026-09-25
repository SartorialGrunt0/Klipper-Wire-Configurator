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
>   `patch_gcode` (quote `old_text` exactly as `read_user_config`
>   returned it), `delete_file`, `add_include`, `remove_include`,
>   `comment_include` (disables an include as `#[include x.cfg]` instead
>   of deleting it).
> - `config_write` — creates **new files only** (wholesale rewrites of
>   existing files are refused; whole-file regeneration is where models
>   drop comments and mangle Jinja).
> - Errors carry exact reasons and name the working alternative (the file
>   that actually holds the section, the actual include lines), so the
>   model corrects itself instead of guessing.

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

### Question Bank (94 questions)
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
| Optional Memory Check (MEMORY-01..03) | Adds printer-memory auto-fill checks when the `--include-memory` flag is used. |

### Current results

Baselines on the current branch (`improvement/ai-chat-edit-refactor`,
post Phase-5), full 94-Q bank, native tool protocol, `--max-tokens 8192
--temperature 0.7`, edit tools on, one model per run (runs under
`reports/ai-chat-accuracy/`):

| Model | Host | PASS | Rate |
| --- | --- | --- | --- |
| gemma-4-12b | CachyPC | 92/94 | 98% |
| qwen3.5-4b | CachyPC | 78/94 | 83% |
| gemma-4-e4b | CachyPC | 77/94 | 82% |
| qwen3.5-9b | CachyPC | 73/94 | 78% |

Family detail (PASS/total):

| Model | Q | MACRO | TRIDENT | AMBI | MINIDIFF | SETUP | LIVE | EDIT | SKILL | TOOL |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gemma-4-12b | 19/19 | 10/10 | 15/16 | 8/8 | 4/4 | 5/5 | 7/7 | 6/6 | 8/9 | 8/8 |
| qwen3.5-4b | 19/19 | 9/10 | 10/16 | 8/8 | 3/4 | 3/5 | 5/7 | 5/6 | 6/9 | 8/8 |
| gemma-4-e4b | 16/19 | 7/10 | 13/16 | 6/8 | 3/4 | 3/5 | 7/7 | 5/6 | 7/9 | 8/8 |
| qwen3.5-9b | 16/19 | 8/10 | 12/16 | 5/8 | 3/4 | 3/5 | 6/7 | 5/6 | 8/9 | 6/8 |

Failure modes seen across the models (from their traces):

- **Staged but not what was asked** (the dominant mode) — the model picks a
  blunter operation than the case needs (`replace_section` or `set_param`
  where an anchored `patch_gcode` is required) and the staged text misses
  the required line. This is what fails `EDIT-02` / `MINIDIFF-01` (the
  `level_bed` adaptive-anchor pair) on three of the four models.
- **Nothing staged after burning the retry budget** — `TRIDENT-03`,
  `MACRO-02`, `SKILL-02` and `EDIT-02` show 6–7 edit attempts with an empty
  pending set: the model kept re-sending variations that the server
  rejected, then landed on the soft-landing summary. The write-attempt cap
  keeps this honest, but the loop is not converging for these models.
- **Wrong tool routing** — qwen3.5-9b's weakest area (6/8 on TOOL,
  5/8 on AMBI): it reaches for prose or an adjacent tool (`AMBI-06/08`
  tool-argument checks, `TOOL-04/05` use-gates) where a typed lookup was
  expected. This is why the 9b model scores *below* the 4b here.
- **Refuses to stay quiet on an edit-shaped request** — `SKILL-N04`
  (discuss-a-draft) fails on **all four** models: each loads the editing
  skill and stages something for a request that should stay a discussion.

Two cases fail on every model measured so far and are the strongest
candidates for a question-design or prompt fix rather than a model
capability gap: **TRIDENT-15** (the `idle_timeout` multi-LED case, whose
three LED sets live in three different files) and **SKILL-N04** above.

Single-run numbers with a fresh dialog per question; tool calls are
nondeterministic, so treat a few points of spread as noise and require
three runs before claiming a model-behaviour difference. Re-baseline after
any prompt or tool change.

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
