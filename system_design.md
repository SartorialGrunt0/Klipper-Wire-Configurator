# System Design

Last reviewed: 2026-08-05

This document is the repository-level source of truth for where the application's major features live, how data flows between the frontend and backend, and where to start when changing a specific behavior.

## 1. Runtime Topology

The application is built from four main layers:

1. Frontend SPA: React 19 + Zustand + React Flow under [frontend/src](frontend/src).
2. API/backend: FastAPI routes and service logic under [backend](backend).
3. Reference corpus and generated assets: bundled reference configs/docs under [reference](reference) and generated frontend copies under [frontend/public/reference](frontend/public/reference).
4. Persistent local state: project saves under [backend/projects](backend/projects) and native app state under `~/.config/klipper-wire-configurator` for layout, settings, and acknowledged warnings.

At a high level the runtime path is:

```text
React UI -> frontend/src/services/api.ts -> FastAPI routes -> parser/services -> JSON/text response
        -> Zustand stores (configStore/nativeStore/graphStore/macroDesignerStore/aiStore) -> rendered UI
```

## 2. Boot and Initialization

### Frontend boot

- [frontend/src/main.tsx](frontend/src/main.tsx) mounts the SPA.
- [frontend/src/App.tsx](frontend/src/App.tsx) is the main composition root.
- On mount, `App.tsx` loads schema metadata through [frontend/src/services/api.ts](frontend/src/services/api.ts) and stores it in [frontend/src/stores/configStore.ts](frontend/src/stores/configStore.ts).
- On mount, `App.tsx` also checks native status through [frontend/src/stores/nativeStore.ts](frontend/src/stores/nativeStore.ts).

### Native startup path

When native mode is true:

1. `App.tsx` lists `.cfg` files from the configured path.
2. `App.tsx` filters out known non-Klipper and backup files.
3. `App.tsx` reads the selected files through `readNativeConfigFiles` in [frontend/src/services/api.ts](frontend/src/services/api.ts).
4. Responses are loaded into `configStore`.
5. The graph is rebuilt from parsed project data through [frontend/src/utils/graphBuilder.ts](frontend/src/utils/graphBuilder.ts).
6. Saved layout and macro designer state are loaded through the native layout API and merged onto the newly built graph.

### Production boot

- [backend/main.py](backend/main.py) creates the FastAPI app, mounts `/api` and `/api/native`, and serves built frontend assets from `frontend/dist` when available.
- [scripts/install.sh](scripts/install.sh) installs dependencies, runs the frontend build, creates the systemd unit, and checks `http://localhost:${KWC_PORT}/health`.

## 3. Core Data Contracts

These types are the main contracts that move across the app.

| Contract | Purpose | Defined in |
| --- | --- | --- |
| `ConfigParam`, `ConfigSection`, `ConfigFile` | Parsed config model shared by backend and frontend. | [backend/parser/config_parser.py](backend/parser/config_parser.py), [frontend/src/types/config.ts](frontend/src/types/config.ts) |
| `ValidationResult` | Error/warning payload rendered by graph, settings, and text UI. | [backend/parser/validator.py](backend/parser/validator.py), [frontend/src/types/config.ts](frontend/src/types/config.ts) |
| `SectionSchema` | Metadata for UI form rendering and validation context. | [backend/parser/config_schema.py](backend/parser/config_schema.py), [frontend/src/types/config.ts](frontend/src/types/config.ts) |
| API request models such as `ConfigUpdate`, `ProjectSave`, `GenerateRequest` | Backend request/response payloads. | [backend/models/config_models.py](backend/models/config_models.py) |
| Graph node/edge models | UI representation of hardware, features, grouping, and connection state. | [frontend/src/types/graph.ts](frontend/src/types/graph.ts), [frontend/src/stores/graphStore.ts](frontend/src/stores/graphStore.ts) |
| Macro designer state | Draft macros, no-go zones, dock position, and rotation. | [frontend/src/types/macroDesigner.ts](frontend/src/types/macroDesigner.ts), [frontend/src/stores/macroDesignerStore.ts](frontend/src/stores/macroDesignerStore.ts) |
| AI chat request/state models | Provider settings, chat history, per-request `maxTokens`, stop signaling via `requestId`, and request/response payloads. | [backend/api/ai_routes.py](backend/api/ai_routes.py), [frontend/src/services/api.ts](frontend/src/services/api.ts), [frontend/src/stores/aiStore.ts](frontend/src/stores/aiStore.ts), [frontend/src/types/ai.ts](frontend/src/types/ai.ts) |

### Important design rule

The backend parser/exporter is the source of truth for config text. The graph and text editors both ultimately feed changes back through parser/export logic rather than maintaining independent serialization rules.

## 4. Frontend Architecture

### Composition root

- [frontend/src/App.tsx](frontend/src/App.tsx) owns global layout, toolbar composition, React Flow wiring, selection state, validation propagation to nodes, native startup behavior, and layout auto-save.

### API client layer

- [frontend/src/services/api.ts](frontend/src/services/api.ts) is the only frontend module that talks directly to HTTP endpoints.
- It normalizes JSON/text responses, handles stale-backend HTML detection, and exposes all standard and native API calls used by the rest of the UI.

### State stores

| Store | Responsibility | Main file |
| --- | --- | --- |
| `configStore` | Loaded config files, active file, validation, selected section, original text snapshots, dirty state, and config mutation helpers. | [frontend/src/stores/configStore.ts](frontend/src/stores/configStore.ts) |
| `graphStore` | React Flow nodes/edges, graph mutations, history, grouping, drag/reparent behavior, and graph-driven config mutations. | [frontend/src/stores/graphStore.ts](frontend/src/stores/graphStore.ts) |
| `nativeStore` | Native mode, config path, detected devices, and CAN UUID query state. | [frontend/src/stores/nativeStore.ts](frontend/src/stores/nativeStore.ts) |
| `macroDesignerStore` | Persistent macro designer drafts and UI state. | [frontend/src/stores/macroDesignerStore.ts](frontend/src/stores/macroDesignerStore.ts) |
| `aiStore` | Persistent AI provider settings, local-provider host/port state, and chat message history. | [frontend/src/stores/aiStore.ts](frontend/src/stores/aiStore.ts) |

### UI ownership map

| Feature area | Primary files |
| --- | --- |
| Toolbar and modal entry points | [frontend/src/components/Toolbar.tsx](frontend/src/components/Toolbar.tsx) |
| Graph node rendering | [frontend/src/components/nodes](frontend/src/components/nodes) |
| Graph edge rendering | [frontend/src/components/edges](frontend/src/components/edges) |
| Add hardware/features | [frontend/src/components/AddMenu.tsx](frontend/src/components/AddMenu.tsx) |
| Form editing | [frontend/src/components/SettingsPanel.tsx](frontend/src/components/SettingsPanel.tsx) |
| Text editing | [frontend/src/components/TextEditor.tsx](frontend/src/components/TextEditor.tsx) |
| Import/generate/export/diff/apply/revert | [frontend/src/components/dialogs](frontend/src/components/dialogs) |
| AI chat and assistant draft preview | [frontend/src/components/dialogs/ChatDialog.tsx](frontend/src/components/dialogs/ChatDialog.tsx), [frontend/src/components/dialogs/AiDraftPreviewDialog.tsx](frontend/src/components/dialogs/AiDraftPreviewDialog.tsx) |
| Macro designer | [frontend/src/components/dialogs/MacroDesignerDialog.tsx](frontend/src/components/dialogs/MacroDesignerDialog.tsx) |

## 5. Backend Architecture

### Application shell

- [backend/main.py](backend/main.py) configures CORS, route registration, and SPA/static hosting.

### Route layers

| Route layer | Responsibility | File |
| --- | --- | --- |
| Standard config API | Import, parse, validate, export, generate, examples, schema, and project save/load. | [backend/api/routes.py](backend/api/routes.py) |
| Native API | Native status, filesystem access, devices, layout, Klipper control, firmware tooling. | [backend/api/native_routes.py](backend/api/native_routes.py) |
| AI chat API | Provider proxying, docs grounding, embedded MCP tools (native function calling for cloud providers, text ```` ```tool ```` protocol for local providers), stop-event signaling, and auto-search fallback. | [backend/api/ai_routes.py](backend/api/ai_routes.py) |

### Parser and validation engine

| Concern | File |
| --- | --- |
| Parse config text into structured objects | [backend/parser/config_parser.py](backend/parser/config_parser.py) |
| Export config text with comment/format preservation | [backend/parser/config_writer.py](backend/parser/config_writer.py) |
| Section and parameter schema definitions | [backend/parser/config_schema.py](backend/parser/config_schema.py) |
| Single-file and multi-file validation | [backend/parser/validator.py](backend/parser/validator.py) |

### Services

| Service area | Responsibility | File |
| --- | --- | --- |
| Board detection and example listing | Match imported configs to board types and enumerate reference examples. | [backend/services/board_detector.py](backend/services/board_detector.py) |
| Warning acknowledgements | Persist accepted unknown-section warnings. | [backend/services/warning_acknowledgments.py](backend/services/warning_acknowledgments.py) |
| Native device/filesystem/state helpers | Native platform check, config file I/O, layout/settings persistence, Klipper socket API. | [backend/services/native_services.py](backend/services/native_services.py) |
| Shared flash target engine | Kconfig state, artifact discovery, build/flash orchestration for Klipper and Katapult. | [backend/services/flash_targets.py](backend/services/flash_targets.py) |
| Klipper compatibility wrapper | Target-specific wrappers and legacy payload keys for Klipper firmware flow. | [backend/services/klipper_firmware.py](backend/services/klipper_firmware.py) |

## 6. Major Feature Flows

### 6.1 Import existing config files

Single-file import path:

1. [frontend/src/components/dialogs/ImportDialog.tsx](frontend/src/components/dialogs/ImportDialog.tsx) collects selected files (file picker, drag-drop, or folder) and shows a staged list with per-file checkboxes so files can be deselected before importing. Selected files whose names collide with already-loaded project files require an explicit overwrite confirmation.
2. [frontend/src/services/api.ts](frontend/src/services/api.ts) posts to `/api/import` or `/api/import-project`.
3. [backend/api/routes.py](backend/api/routes.py) parses files with [backend/parser/config_parser.py](backend/parser/config_parser.py), validates with [backend/parser/validator.py](backend/parser/validator.py), and detects board metadata with [backend/services/board_detector.py](backend/services/board_detector.py). **Import never writes to disk** — parsed content is returned to the frontend only; persistence happens exclusively through the Save/Apply flow.
4. The frontend writes config/validation into `configStore` as *unsaved changes* (merging into whatever is already loaded — import never clears the project) and rebuilds the graph with [frontend/src/utils/graphBuilder.ts](frontend/src/utils/graphBuilder.ts). Existing diff baselines (`originalTexts`) are preserved so Save shows import-vs-Pi; files that were never loaded before have no baseline and render as "new file".

### 6.2 Generate a blank or example config

1. [frontend/src/components/dialogs/GenerateDialog.tsx](frontend/src/components/dialogs/GenerateDialog.tsx) selects blank vs example mode.
2. The dialog calls `/api/generate` through [frontend/src/services/api.ts](frontend/src/services/api.ts).
3. [backend/api/routes.py](backend/api/routes.py) either loads a reference file or calls `_generate_blank_config`.
4. The frontend stores the generated config, exports an original-text snapshot, and builds the graph.

Note: generated single-file configs currently use `buildGraphFromConfig`, while import/open/revert flows use `buildProjectGraph`.

### 6.3 Graph editing and graph-to-config sync

1. Graph actions are dispatched through [frontend/src/stores/graphStore.ts](frontend/src/stores/graphStore.ts).
2. Many graph mutations call into [frontend/src/stores/configStore.ts](frontend/src/stores/configStore.ts) to create/remove/update sections and includes.
3. `configStore` schedules revalidation after mutations.
4. Validation state is pushed back onto nodes by [frontend/src/App.tsx](frontend/src/App.tsx).

Key maintenance point:

- Graph history snapshots include `configFiles`, not just nodes/edges. Changing history behavior usually requires touching both graph and config state logic.

### 6.4 Settings panel edits

1. Selecting a node or edge in [frontend/src/App.tsx](frontend/src/App.tsx) opens [frontend/src/components/SettingsPanel.tsx](frontend/src/components/SettingsPanel.tsx).
2. The settings panel uses schema metadata from `configStore.schemas` to choose input controls.
3. Mutations flow through `configStore` and, when needed, utility helpers like [frontend/src/utils/pinUtils.ts](frontend/src/utils/pinUtils.ts) and [frontend/src/utils/sectionNaming.ts](frontend/src/utils/sectionNaming.ts).
4. The validator result then feeds back into the panel and graph.

### 6.5 Text editor sync

1. [frontend/src/components/TextEditor.tsx](frontend/src/components/TextEditor.tsx) loads the active file as exported backend text.
2. It runs debounced live parse/validate calls through `/api/parse`.
3. Applying text changes reparses the active file and then rebuilds the graph from the updated project via [frontend/src/utils/graphBuilder.ts](frontend/src/utils/graphBuilder.ts).
4. Cross-file search works from exported text of all loaded config files, not from raw textarea state alone.

Key maintenance point:

- If text-to-graph sync looks wrong, start with [frontend/src/components/TextEditor.tsx](frontend/src/components/TextEditor.tsx), [backend/api/routes.py](backend/api/routes.py), and [frontend/src/utils/graphBuilder.ts](frontend/src/utils/graphBuilder.ts). That is the controlling path.

### 6.6 Diff, export, apply, and revert

| Workflow | Frontend entry | Backend/API path |
| --- | --- | --- |
| Diff | [frontend/src/components/dialogs/DiffDialog.tsx](frontend/src/components/dialogs/DiffDialog.tsx) | Uses exported text from [frontend/src/services/api.ts](frontend/src/services/api.ts) |
| Export | [frontend/src/components/dialogs/ExportDialog.tsx](frontend/src/components/dialogs/ExportDialog.tsx) | `/api/export` and `/api/export-project` in [backend/api/routes.py](backend/api/routes.py) |
| Apply to Pi | [frontend/src/components/dialogs/ApplyDialog.tsx](frontend/src/components/dialogs/ApplyDialog.tsx) | `/api/native/apply` and `/api/native/klipper/firmware-restart` in [backend/api/native_routes.py](backend/api/native_routes.py) |
| Revert | [frontend/src/components/dialogs/RevertDialog.tsx](frontend/src/components/dialogs/RevertDialog.tsx) | Browser mode reparses original text; native mode re-reads disk through `/api/native/config-files/read` |

### 6.7 Native mode and persistence

1. Native capability is detected in [backend/services/native_services.py](backend/services/native_services.py).
2. The frontend keeps native state in [frontend/src/stores/nativeStore.ts](frontend/src/stores/nativeStore.ts).
3. Layout and settings are stored via `/api/native/layout` and `/api/native/settings` in JSON files under the native app state directory.
4. Warning acknowledgements are stored separately by [backend/services/warning_acknowledgments.py](backend/services/warning_acknowledgments.py).

### 6.8 Firmware tooling

1. [frontend/src/components/dialogs/FirmwareDialog.tsx](frontend/src/components/dialogs/FirmwareDialog.tsx) is the only UI entry point.
2. The dialog talks to native firmware routes via [frontend/src/services/api.ts](frontend/src/services/api.ts).
3. [backend/api/native_routes.py](backend/api/native_routes.py) forwards requests to [backend/services/flash_targets.py](backend/services/flash_targets.py) or [backend/services/klipper_firmware.py](backend/services/klipper_firmware.py).
4. The service layer resolves target checkouts, loads Kconfig state, determines flash-device candidates, runs build/flash commands, and exposes artifacts.

### 6.9 Macro designer

1. [frontend/src/components/dialogs/MacroDesignerDialog.tsx](frontend/src/components/dialogs/MacroDesignerDialog.tsx) owns the UX.
2. Persistent draft/no-go state lives in [frontend/src/stores/macroDesignerStore.ts](frontend/src/stores/macroDesignerStore.ts).
3. Macro parsing/normalization helpers live in [frontend/src/utils/macroDesigner.ts](frontend/src/utils/macroDesigner.ts).
4. Motion simulation helpers live in [frontend/src/utils/gcodeSimulator.ts](frontend/src/utils/gcodeSimulator.ts).
5. Native layout saves include serialized macro designer state from `App.tsx`.

### 6.10 AI chat and assistant draft apply

1. [frontend/src/components/Toolbar.tsx](frontend/src/components/Toolbar.tsx) opens [frontend/src/components/dialogs/ChatDialog.tsx](frontend/src/components/dialogs/ChatDialog.tsx).
2. `ChatDialog.tsx` reads and persists provider settings plus message history through [frontend/src/stores/aiStore.ts](frontend/src/stores/aiStore.ts). Saved conversations (including attached config files) live in [frontend/src/stores/chatHistoryStore.ts](frontend/src/stores/chatHistoryStore.ts).
3. Before sending, `ChatDialog.tsx` builds system context from the active file, explicitly mentioned loaded files, and optional user-attached local config files (via `getConfigContexts` and `buildConfigContextMessage`), adds file-targeting instructions (gated behind the `VITE_KWC_HANDHOLDING=1` build flag, off by default), and posts through `aiChat` in [frontend/src/services/api.ts](frontend/src/services/api.ts) to `/ai/chat`. Each request carries a `requestId` and a `maxTokens` cap from the chat settings panel.
4. [backend/api/ai_routes.py](backend/api/ai_routes.py) `_prepare_messages` builds the system text: the fixed `SYSTEM_PROMPT`, the embedded tool descriptions from [backend/mcp_server.py](backend/mcp_server.py), current printer memory (plus an auto-fill investigation prompt when it is blank), and the frontend-supplied context messages. It appends a trailing task anchor system message pointing the model at the user's latest message so long conversations stay on task.
5. `chat_proxy` builds provider-specific payloads via `_build_provider_payload` (Anthropic gets a single merged `system` field, a flat `tools` list with `input_schema`, and `max_tokens`; OpenAI-compatible providers get `temperature=0.1` and `max_tokens`) and queries the provider through `_query_provider`.
6. Tool integration: cloud providers (chatgpt, google, anthropic, github) receive native function-calling tool definitions (`_build_native_tools`) and their responses are parsed from `tool_calls` / `tool_use` blocks (`_extract_native_tool_calls`). Local/OpenAI-compatible providers keep the text-based ```` ```tool ```` JSON-block protocol (`_extract_tool_calls`). Both paths execute the calls against the embedded MCP server and loop, capped at `MAX_MCP_TOOL_TURNS = 10`; follow-up messages are formatted per provider (`_build_native_tool_followup` / `_build_tool_result_message`). If the model makes no tool call on the first pass, an automatic documentation search (`_auto_search_context`) is injected as a fallback so answers stay grounded.
7. The frontend runs the returned reply through the unified validation pipeline in [frontend/src/utils/replyValidation.ts](frontend/src/utils/replyValidation.ts): the config-draft validator (built in [frontend/src/hooks/useAssistantDraft.ts](frontend/src/hooks/useAssistantDraft.ts)) checks cfg blocks, and the printer-memory validator in [frontend/src/utils/printerMemory.ts](frontend/src/utils/printerMemory.ts) checks `printer-memory` JSON blocks. Each validator feeds fix instructions back to the model and re-requests up to its attempt limit; unresolvable issues become advisory warnings instead of blocking.
8. If the assistant returns fenced `cfg` blocks, `ChatDialog.tsx` maps them to target files using `# file:` hints, filename mentions, or section matching (`buildAssistantDraftTargetConfigs` in [frontend/src/hooks/useAssistantDraft.ts](frontend/src/hooks/useAssistantDraft.ts)), then `prepareAssistantDraftPreview` builds per-file previews with [frontend/src/utils/assistantDraftMerge.ts](frontend/src/utils/assistantDraftMerge.ts). A `# file:` hint naming a file that does not exist yet creates a new-file preview against an empty base config, so every section appears as an addition and the accept flow creates the file. Accepted changes merge sections into the loaded project (update/add/delete via `*[section_name]` markers) and rebuild the project graph with [frontend/src/utils/graphBuilder.ts](frontend/src/utils/graphBuilder.ts).
9. Stopping: while a request is in flight the Send button becomes Stop. [frontend/src/components/dialogs/ChatInputBar.tsx](frontend/src/components/dialogs/ChatInputBar.tsx) aborts the client fetch and posts the `requestId` to `/ai/chat/stop`; the backend sets a registered stop event, `_query_provider` races it against the provider request, cancels the query, and returns `{"stopped": true}`. The user's message stays in history with no error banner.
10. Failures: on timeout or provider error the failed user message remains in history (no rollback) and an error banner offers Retry, which re-submits the last user message with full context. After an interrupted request, New Chat offers to carry the conversation (messages, provider settings, attached config files) forward or start fresh.

## 7. File-by-Feature Change Guide

If you need to change a specific area, start here.

| Change target | Start here | Then trace into |
| --- | --- | --- |
| App startup behavior | [frontend/src/App.tsx](frontend/src/App.tsx) | [frontend/src/services/api.ts](frontend/src/services/api.ts), [frontend/src/stores/nativeStore.ts](frontend/src/stores/nativeStore.ts) |
| Add/remove hardware or feature menu options | [frontend/src/components/AddMenu.tsx](frontend/src/components/AddMenu.tsx) | [frontend/src/utils/graphBuilder.ts](frontend/src/utils/graphBuilder.ts), [frontend/src/stores/graphStore.ts](frontend/src/stores/graphStore.ts) |
| Node visuals or interaction affordances | [frontend/src/components/nodes](frontend/src/components/nodes) | [frontend/src/stores/graphStore.ts](frontend/src/stores/graphStore.ts), [frontend/src/App.tsx](frontend/src/App.tsx) |
| Edge routing or bend behavior | [frontend/src/utils/edgeRouting.ts](frontend/src/utils/edgeRouting.ts), [frontend/src/utils/edgeBend.ts](frontend/src/utils/edgeBend.ts) | [frontend/src/components/edges](frontend/src/components/edges) |
| Schema-driven form fields | [frontend/src/components/SettingsPanel.tsx](frontend/src/components/SettingsPanel.tsx) | [backend/parser/config_schema.py](backend/parser/config_schema.py), [frontend/src/stores/configStore.ts](frontend/src/stores/configStore.ts) |
| Text editor behavior | [frontend/src/components/TextEditor.tsx](frontend/src/components/TextEditor.tsx) | [frontend/src/services/api.ts](frontend/src/services/api.ts), [frontend/src/utils/graphBuilder.ts](frontend/src/utils/graphBuilder.ts) |
| AI chat behavior or provider routing | [frontend/src/components/dialogs/ChatDialog.tsx](frontend/src/components/dialogs/ChatDialog.tsx) | [frontend/src/stores/aiStore.ts](frontend/src/stores/aiStore.ts), [frontend/src/services/api.ts](frontend/src/services/api.ts), [backend/api/ai_routes.py](backend/api/ai_routes.py), [backend/mcp_server.py](backend/mcp_server.py), [frontend/src/hooks/useAssistantDraft.ts](frontend/src/hooks/useAssistantDraft.ts), [frontend/src/utils/replyValidation.ts](frontend/src/utils/replyValidation.ts), [frontend/src/utils/assistantDraftMerge.ts](frontend/src/utils/assistantDraftMerge.ts) |
| AI prompt wording or tool guidance | [backend/api/ai_routes.py](backend/api/ai_routes.py) (`SYSTEM_PROMPT`, `_build_mcp_tool_context`, auto-fill prompt, task anchor) | [backend/mcp_server.py](backend/mcp_server.py) (tool descriptions), [frontend/src/components/dialogs/ChatDialog.tsx](frontend/src/components/dialogs/ChatDialog.tsx) (file-targeting instructions), [frontend/src/utils/draftValidation.ts](frontend/src/utils/draftValidation.ts), [frontend/src/utils/chatUtils.ts](frontend/src/utils/chatUtils.ts) |
| Import/export/diff/apply dialogs | [frontend/src/components/dialogs](frontend/src/components/dialogs) | [frontend/src/services/api.ts](frontend/src/services/api.ts), [backend/api/routes.py](backend/api/routes.py), [backend/api/native_routes.py](backend/api/native_routes.py) |
| Parser fidelity or round-trip correctness | [backend/parser/config_parser.py](backend/parser/config_parser.py), [backend/parser/config_writer.py](backend/parser/config_writer.py) | [tests/test_roundtrip.py](tests/test_roundtrip.py), [tests/test_save_config_handling.py](tests/test_save_config_handling.py), [tests/test_diff_roundtrip.py](tests/test_diff_roundtrip.py) |
| Validation rules | [backend/parser/validator.py](backend/parser/validator.py) | [backend/parser/config_schema.py](backend/parser/config_schema.py), [tests/test_delta_validation.py](tests/test_delta_validation.py), [tests/test_warning_acknowledgments.py](tests/test_warning_acknowledgments.py) |
| Native file/device behavior | [backend/services/native_services.py](backend/services/native_services.py) | [backend/api/native_routes.py](backend/api/native_routes.py), [frontend/src/stores/nativeStore.ts](frontend/src/stores/nativeStore.ts) |
| Firmware build/flash behavior | [backend/services/flash_targets.py](backend/services/flash_targets.py), [backend/services/klipper_firmware.py](backend/services/klipper_firmware.py) | [backend/api/native_routes.py](backend/api/native_routes.py), [frontend/src/components/dialogs/FirmwareDialog.tsx](frontend/src/components/dialogs/FirmwareDialog.tsx) |
| Macro designer behavior | [frontend/src/components/dialogs/MacroDesignerDialog.tsx](frontend/src/components/dialogs/MacroDesignerDialog.tsx) | [frontend/src/stores/macroDesignerStore.ts](frontend/src/stores/macroDesignerStore.ts), [frontend/src/utils/macroDesigner.ts](frontend/src/utils/macroDesigner.ts), [frontend/src/utils/gcodeSimulator.ts](frontend/src/utils/gcodeSimulator.ts) |
| Installer/service lifecycle | [scripts/install.sh](scripts/install.sh) | [scripts/run-service.sh](scripts/run-service.sh), [README.md](README.md) |

## 8. Non-Obvious Boundaries

- `buildProjectGraph` is the primary multi-file graph builder. Most import/open/revert paths end here.
- AI routes are mounted at `/ai/*` from [backend/main.py](backend/main.py), not under `/api`, so the frontend calls `/ai/chat` and `/ai/chat/stop` directly (Vite proxies `/ai` in dev). Local model listing is a frontend-only call to the provider's `/v1/models` endpoint and has no backend route.
- [frontend/src/components/dialogs/ChatDialog.tsx](frontend/src/components/dialogs/ChatDialog.tsx) is the owning surface for AI settings and draft-apply behavior; there is no separate primary AI settings dialog in the current UI.
- Assistant draft application is section-merge based rather than whole-file replacement; target file resolution comes from an explicit `# file:` hint first, then filename mentions, then section matching across loaded files. A `# file:` hint for a file that does not exist yields a new-file preview built against an empty base config.
- The cfg block protocol is a response format, not an execution channel: the model never writes files directly. `*[section_name]` deletes a section, `#[header]` comments it out, and `# file: <name>` targets a file; the frontend parses these and applies them through the normal parse/merge/export path.
- Native function calling is used only for cloud providers; local/OpenAI-compatible providers keep the text ```` ```tool ```` block protocol because local tool support varies by server. A per-request `toolProtocol` override (`auto` | `native` | `text`) exists for harness A/B runs: `native` forces OpenAI native `tool_calls` even on local llama.cpp servers (required for gpt-oss), `text` forces the text protocol everywhere. The frontend never sends it; `scripts/ai_chat_accuracy_test.py` uses it for comparisons.
- The backend does not observe client disconnects, so the Stop feature needs both a client-side fetch abort and the `/ai/chat/stop` endpoint with a shared in-process `requestId` -> stop-event registry. Uvicorn reload must stay off (or `KWC_RELOAD=1` be used deliberately) so the registry is shared by the serving process.
- A trailing system message (task anchor) points the model at the user's latest message; Anthropic's payload builder merges every system message into the top-level `system` field so the anchor survives alongside the main prompt.
- Printer memory is a backend-owned JSON file injected into every request; the model proposes updates via a fenced `printer-memory` block that the user reviews before anything is saved. A blank memory triggers an auto-fill prompt instructing the model to investigate config files and example configs.
- The current frontend does not call the backend project save/load/list API in [backend/api/routes.py](backend/api/routes.py); treat those endpoints as backend-ready, not user-visible.
- Native layout persistence and warning acknowledgement persistence are separate concerns stored in different files under the native app state directory.
- The existing `tests/test_roundtrip.py` and `tests/test_diff_roundtrip.py` files are useful diagnostics, but they are not strict assertion suites. Treat them as informational until converted.

## 9. Common Change Recipes

### Add a new Klipper section type

1. Update schema metadata in [backend/parser/config_schema.py](backend/parser/config_schema.py).
2. If it is a named section, update named-section parsing in [backend/parser/config_parser.py](backend/parser/config_parser.py).
3. Decide whether it belongs in the Add menu or a graph grouping and update [frontend/src/components/AddMenu.tsx](frontend/src/components/AddMenu.tsx) and [frontend/src/utils/graphBuilder.ts](frontend/src/utils/graphBuilder.ts).
4. Add or update validator coverage in [backend/parser/validator.py](backend/parser/validator.py) and tests under [tests](tests).

### Change how graph cards are arranged or grouped

1. Start in [frontend/src/stores/graphStore.ts](frontend/src/stores/graphStore.ts).
2. Check layout assumptions captured in [frontend/src/components/nodes](frontend/src/components/nodes) and [frontend/src/utils/graphBuilder.ts](frontend/src/utils/graphBuilder.ts).
3. Revalidate drag/reparent/grouping flows from [frontend/src/App.tsx](frontend/src/App.tsx).

### Change text-editor apply behavior

1. Start in [frontend/src/components/TextEditor.tsx](frontend/src/components/TextEditor.tsx).
2. Follow the parse/apply path into [frontend/src/services/api.ts](frontend/src/services/api.ts) and `/api/parse` in [backend/api/routes.py](backend/api/routes.py).
3. Confirm graph rebuild behavior in [frontend/src/utils/graphBuilder.ts](frontend/src/utils/graphBuilder.ts).

### Change native filesystem or Klipper control behavior

1. Start in [backend/services/native_services.py](backend/services/native_services.py).
2. Check route translation and HTTP error handling in [backend/api/native_routes.py](backend/api/native_routes.py).
3. Verify the calling UI in [frontend/src/components/dialogs/OpenFromPiDialog.tsx](frontend/src/components/dialogs/OpenFromPiDialog.tsx), [frontend/src/components/dialogs/ApplyDialog.tsx](frontend/src/components/dialogs/ApplyDialog.tsx), and [frontend/src/components/dialogs/RevertDialog.tsx](frontend/src/components/dialogs/RevertDialog.tsx).