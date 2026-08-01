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

1. **You send a message.** The app builds the request context: your message, recent conversation history, the active config file (plus any files you mention or attach), current printer memory, and targeted instructions for which files to edit.
2. **The backend prepares the prompt.** It adds the assistant's operating rules, the built-in tool list (Klipper docs search, example configs, validation, board detection, macro templates, and more), and a task anchor that keeps the model focused on your latest message even in long conversations.
3. **The model answers with tools.** Cloud providers use native function calling; local servers use a text `tool` block protocol. The backend runs the requested tools (for example, searching the bundled docs or validating a snippet) and feeds the results back to the model, up to five tool rounds. If the model calls no tool, the backend injects a documentation search automatically so answers stay grounded.
4. **The reply is validated.** Config sections and printer-memory proposals are checked; if something is invalid, the assistant is asked to fix it (up to a few attempts) before you ever see it.
5. **Config changes become a reviewable draft.** If the reply contains `cfg` blocks, the app merges them with your current project and shows a per-file preview with every changed, added, or deleted section highlighted.
6. **You review and apply.** Accept the draft to apply the edits to your project; a file the assistant proposes to create appears as a new file. Nothing is written to disk or applied to your printer without your explicit approval.

## How the assistant targets config edits

The assistant communicates file changes as `cfg` code blocks using a simple protocol the app understands:

- `# file: filename.cfg` — the first line of a block names the file the sections belong to; use one block per file.
- `*[section_name]` on its own line — delete that section entirely.
- `#[section_name]` as a header — keep the section but commented out (disabled).
- A `# file:` hint naming a file that does not exist yet — create a new config file.

Only changed, new, or deleted sections are returned — never your whole file unless you ask for it. The app parses, merges, and validates these blocks against your real project, so what you preview is exactly what the merge will produce.

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
- The 45-question bank covers: **Q01–Q20** core tools (docs lookups, example configs, validation, calculations, draft-block protocol), **MACRO-01..11** (macro authoring, editing, fixing, template options, and the individual `validate_macro` checks), and **TRIDENT-01..14** (the real Trident configs from `reference/Trident_backup` and the real backend user configs — read, edit, delete, manage, and fix the actual `printer.cfg`, `aux_fan.cfg`, and `PIS.cfg` via the draft-block protocol; the files are attached as read-only context and never modified). An optional `--include-memory` flag adds MEMORY-01..03 printer-memory auto-fill checks.
- Every step is logged: the request payload, raw response, tool names and tool-turn count, the per-question slice of the backend's own log, the pass/fail evaluation for each criterion, and a final summary. The script is stdlib-only — no third-party dependencies.

### Results on local models (45-question bank)

Tested on the local llama.cpp/LM Studio server with the same settings as day-to-day use (`--max-tokens 4096 --temperature 0.7`):

| Model | PASS | Rate |
| --- | --- | --- |
| gemma-4-12b | 42/45 | 93% |
| qwen3.5-4b | 38–39/45 | 84–87% |
| gemma-4-e2b | 29–31/45 | 64–69% |

What that looks like in practice:

- **gemma-4-12b** is the strongest local model and the current recommendation. Its only failures were in the hardest real-file category (multi-step draft-protocol edits like "add + modify + delete in one file, preserve the rest").
- **qwen3.5-4b** is surprisingly good for a 4B model — roughly 85% on the full bank — and is a solid choice when you want something lighter than 12B. It stumbles most on the tricky real-file edits: commenting out a section include (TRIDENT-04) and combining add/modify/delete in one file while preserving everything else (TRIDENT-13).
- **gemma-4-e2b** (the smallest we benchmarked, ~2B class) is noticeably weaker at ~64–69%. It more often reaches for the wrong tool (frequently `search_klipper_docs` instead of the specific tool the task needs), and it fails most of the macro-validation and draft-protocol edit cases. It is fine for casual documentation Q&A but not reliable for edit workflows.

Run-to-run variance of a few points is normal (the model gets a fresh dialog per question, and tool calls are nondeterministic), which is why the table shows ranges for the small models.

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
- Cloud providers need an API key: pass `--api-key`, set `KWC_TEST_API_KEY`, or answer the interactive prompt (never echoed; keys are redacted to `***` in logs).
- Useful flags: `--questions 1-5,8` (subset), `--list-questions` (print the question bank, no API calls), `--include-memory` (printer-memory auto-fill tests; the backend's printer memory is backed up, blanked to trigger auto-fill, and restored afterward).
- Reports land in `reports/ai-chat-accuracy/<output-dir>/` as both a human-readable `.log` and a machine-readable `.json`.
