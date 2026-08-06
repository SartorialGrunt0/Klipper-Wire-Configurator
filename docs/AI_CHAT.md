# AI Chat

The KWC AI assistant answers Klipper questions and drafts config changes, macros, and printer-memory updates using the bundled Klipper documentation, example configs, and your loaded project files. Nothing the assistant produces touches your config until you review and approve it in the draft preview dialog.

## Configuration

Open the chat from the toolbar, then click the settings button to configure:

- **Provider** — OpenAI, Google Gemini, Anthropic, GitHub Copilot, an OpenAI-compatible endpoint (LM Studio, Ollama, etc.), or the local default.
- **API key** — required only for cloud providers; local servers usually don't need one.
- **Model** — any model the provider exposes; the model list is fetched from your endpoint.
- **Max tokens** — cap on the assistant's reply length (default 4096).

Provider settings, conversation history, and attached config files persist locally and are restored when you reopen a saved conversation.

## How a request works, from prompt to file edit

1. **You send a message.** The app builds the request context: your message, recent conversation history, the active config file (plus any files you mention or attach), and current printer memory. File targeting itself is carried by the backend system prompt's `# file:` / mini-diff edit protocol; the frontend's optional targeted file-editing instructions are gated behind a build flag (`VITE_KWC_HANDHOLDING=1`) and off by default.
2. **The backend prepares the prompt.** It adds the assistant's operating rules, the built-in tool list (Klipper docs search, example configs, validation, board detection, macro templates, and more), and a task anchor that keeps the model focused on your latest message even in long conversations.
3. **The model answers with tools.** Cloud providers use native function calling; local servers use a text `tool` block protocol. The backend runs the requested tools (for example, searching the bundled docs or validating a snippet) and feeds the results back to the model, up to ten tool rounds. If the model calls no tool, the backend injects a documentation search automatically so answers stay grounded.
4. **The reply is validated.** Config sections and printer-memory proposals are checked; if something is invalid, the assistant is asked to fix it (up to a few attempts) before you ever see it.
5. **Config changes become a reviewable draft.** If the reply contains `cfg` blocks, the app merges them with your current project and shows a per-file preview with every changed, added, or deleted section highlighted.
6. **You review and apply.** Accept the draft to apply the edits to your project; a file the assistant proposes to create appears as a new file. Nothing is written to disk or applied to your printer without your explicit approval.

## How the assistant targets config edits

The assistant communicates file changes as `cfg` code blocks using a simple protocol the app understands:

- `# file: filename.cfg` — the first line of a block names the file the sections belong to; use one block per file.
- **Mini-diffs for edits** — to change an existing section, the assistant returns the section header followed by only the lines that change: removed lines prefixed with `-`, added lines with `+`, keeping original indentation. Unchanged lines are never repeated (reproducing them causes the app to reject the reply as a full rewrite and retry), so Jinja guards like `{% if %}/{% endif %}`, G-codes, and comments are preserved automatically.
- `*[section_name]` on its own line — delete that section entirely.
- `#[section_name]` as a header — keep the section but commented out (disabled).
- A `# file:` hint naming a file that does not exist yet — create a new config file.
- A pure addition needs no `-` line; a pure deletion needs no `+` line.

Only changed, new, or deleted content is returned — never your whole file unless you ask for it. The app parses, merges, and validates these blocks against your real project, so what you preview is exactly what the merge will produce.

## Printer memory

The assistant sees your printer memory (mainboard, toolhead, expander boards, kinematics, probe, etc.) as context on every request. If it is blank, the assistant investigates your configs and the bundled examples to propose a filled-in profile. Proposals come back as a `printer-memory` code block and are shown in a review dialog — saved only when you confirm.

## Stopping, retrying, and resuming

- **Stop** — while the assistant is processing, the Send button becomes Stop. Pressing it cancels the request immediately.
- **Retry** — if a request fails (timeout, no model loaded), your message stays in the conversation and a Retry button re-sends it with full context.
- **New chat after an interruption** — you can keep the current conversation (messages, provider settings, and attached config files) or start fresh.

## Accuracy testing

`scripts/ai_chat_accuracy_test.py` is an end-to-end harness that drives the **real backend `/ai/chat` endpoint** — the same one the frontend uses — against a battery of questions with known success criteria. It exists so we can measure how well a given model actually answers Klipper questions and uses the embedded tools, and to catch regressions when the prompt, tools, or doc index change.

How it works:

- Each question starts a **fresh chat dialog** (a single user message, its own requestId), so the model cannot lean on prior conversation context.
- Every question checks two things: **answer accuracy** (does the reply contain the expected facts / code / file-edit protocol?) and **tool reliability** (does the model use the right embedded tool for the job?).
- The 55-question bank covers: **Q01–Q20** core tools (docs lookups, example configs, validation, calculations, draft-block protocol), **MACRO-01..11** (macro authoring, editing, fixing, template options, and the individual `validate_macro` checks), **TRIDENT-01..14** (the real Trident configs from `reference/Trident_backup` and the real backend user configs — read, edit, delete, manage, and fix the actual `printer.cfg`, `aux_fan.cfg`, and `PIS.cfg` via the draft-block protocol; the files are attached as read-only context and never modified), **MINIDIFF-01..04** (the mini-diff edit protocol — `level_bed` adaptive mode, `[printer] max_accel`, an `aux_fan.cfg` pin edit, and a tool-required `pressure_advance` edit), and **AMBI-01..08** (ambiguity cases — new-file drafts without an explicit name, hypothetical "what if" edits phrased as questions, batch section reads, multi-topic explain-and-edit turns, and content search for a bare pin value). An optional `--include-memory` flag adds MEMORY-01..03 printer-memory auto-fill checks.
- Every step is logged: the request payload, raw response, tool names and tool-turn count, the per-question slice of the backend's own log, the pass/fail evaluation for each criterion, and a final summary. The script is stdlib-only — no third-party dependencies.

### Results on local models (55-question bank)

Tested on the local llama.cpp/LM Studio server with the same settings as day-to-day use (`--max-tokens 4096 --temperature 0.7 --tool-protocol native`):

| Model | PASS | Rate |
| --- | --- | --- |
| gemma-4-12b | 54/55 | 98% |
| gemma-4-e4b | 48/55 | 87% |
| qwen3.5-9b | 44/55 | 80% |
| qwen3.5-4b | 42/55 | 76% |
| gemma-4-e2b | 41/55 | 75% |
| gpt-oss-20b | 30/50 | 60% |

Run dates and notes: the gemma-4-12b / gemma-4-e4b / gemma-4-e2b / qwen3.5-4b / qwen3.5-9b rows are full 55-question runs from 2026-08-05. The gpt-oss-20b row is the earlier 2026-08-03 run on the 50-question bank (not re-run; it requires `--tool-protocol native`). The qwen3.5-9b server alias now points at the DeepSeek-V4-Flash-MTP merged GGUF (`jackrong/Qwen3.5-9B-DeepSeek-V4-Flash-MTP-Q6_K`), which differs from the plain qwen3.5-9b file that scored 44/50 (88%) on 08-03 — the drop is at least partly a model-file change, not pure variance. One qwen3.5-9b question (Q01) errored with a 500 and counts as a fail.

What that looks like in practice:

- **gemma-4-12b** is the strongest local model and the current recommendation — 98% on the full bank. Its only miss (AMBI-04) is the same one as the morning run: it emitted an edit block for a hypothetical "what would happen if" question instead of just answering.
- **gemma-4-e4b** is a solid mid-size at ~87%, a few points behind 12b. Its misses are a mix of draft-protocol cases (Q17, TRIDENT-13, MINIDIFF-01) and ambiguity turns (AMBI-03/05/07).
- **qwen3.5-9b** lands ~80% on the current DeepSeek-V4-Flash-MTP merged file. It handles real-file edits well but misses several mini-diff/ambiguity cases.
- **qwen3.5-4b** is decent for a 4B model (~76%) and fine for lighter use, but it stumbles on the harder real-file and mini-diff edits (TRIDENT-02/03/04/07/08/10 and MINIDIFF-01/03/04).
- **gemma-4-e2b** (the smallest we benchmarked, ~2B class) improves to ~75% on the full bank but is still the weakest — it reaches for the wrong tool and fails most macro-validation and draft-protocol edit cases. Fine for casual documentation Q&A, not reliable for edit workflows.
- **gpt-oss-20b** lands around 60% and **requires** the native tool protocol (its text-protocol replies come back empty) — pass `--tool-protocol native` when testing it.

Run-to-run variance of a few points is normal (the model gets a fresh dialog per question, and tool calls are nondeterministic), which is why the table shows single-run numbers rather than ranges.

### Running the harness

From the repo root, with the backend running:

```bash
python3 scripts/ai_chat_accuracy_test.py \
    --provider openai-compatible --host 192.168.1.133 --port 8080 \
    --model gemma-4-12b --max-tokens 4096 --temperature 0.7 \
    --base-url http://localhost:8099 \
    --output-dir reports/ai-chat-accuracy/<model-name>
```

- Always pass `--max-tokens` and `--temperature` explicitly — unattended/background runs die on the interactive prompt otherwise.
- Tool protocol: the default `--tool-protocol auto` uses the text ```` ```tool ```` protocol for local http endpoints and native function calling for cloud https endpoints. For local llama.cpp servers, `--tool-protocol native` forces OpenAI native `tool_calls` — required for gpt-oss (text replies come back empty) and generally equal-or-better for gemma/qwen.
- Cloud providers need an API key: pass `--api-key`, set `KWC_TEST_API_KEY`, or answer the interactive prompt (never echoed; keys are redacted to `***` in logs).
- Useful flags: `--questions 1-5,8` (subset), `--list-questions` (print the question bank, no API calls), `--include-memory` (printer-memory auto-fill tests; the backend's printer memory is backed up, blanked to trigger auto-fill, and restored afterward).
- Reports land in `reports/ai-chat-accuracy/<output-dir>/` as both a human-readable `.log` and a machine-readable `.json`.
