# Klipper Wire Configurator Requirements Specification

Last reviewed: 2026-08-05

This document reflects the capabilities implemented in the current repository. It is intentionally descriptive of the shipped product state, including native-only behavior and backend capabilities that are present even when not yet exposed by the main frontend toolbar.

## Scope

Klipper Wire Configurator is a browser-based editor for Klipper configuration projects. It combines a React single-page application with a FastAPI backend to import, validate, generate, edit, export, diff, and optionally apply Klipper `.cfg` files. It also includes an AI chat workflow for documentation-grounded Klipper assistance and draft config edits. In native Linux/SBC mode it also interacts with the local filesystem, Klipper's Unix socket API, connected devices, and firmware build trees.

## Supported Operating Modes

- Browser mode: the frontend consumes the backend API for import, generation, validation, export, and editing workflows.
- Native SBC mode: the same UI enables direct file access, device discovery, layout persistence, Klipper restart/status checks, and firmware tooling when the backend is running on Linux or `KWC_FAKE_NATIVE` is enabled.
- Development mode: the frontend runs under Vite and the backend under FastAPI/Uvicorn; frontend reference assets are generated before `dev` and `build` runs.

## Capability Legend

- UI: available in the current shipped frontend.
- Native UI: available only when native mode is active.
- API: implemented in the backend, but not surfaced by the current primary UI.

## Functional Requirements

### Platform and Deployment

| ID | Requirement | Surface | Primary implementation |
| --- | --- | --- | --- |
| REQ-PLAT-01 | The application shall run as a React frontend backed by a FastAPI service. | UI | [frontend/src/main.tsx](frontend/src/main.tsx), [frontend/src/App.tsx](frontend/src/App.tsx), [backend/main.py](backend/main.py) |
| REQ-PLAT-02 | The backend shall expose a health endpoint and serve the built SPA when frontend assets are present. | UI | [backend/main.py](backend/main.py) |
| REQ-PLAT-03 | The Linux installer shall install dependencies, build the frontend, create or replace the systemd service, support uninstall, and honor the configured port via `KWC_PORT`. | Native UI | [scripts/install.sh](scripts/install.sh), [scripts/run-service.sh](scripts/run-service.sh) |

### Config Import, Parsing, Reference Data, and Generation

| ID | Requirement | Surface | Primary implementation |
| --- | --- | --- | --- |
| REQ-CONF-01 | The system shall import a single Klipper `.cfg` file, parse it into structured sections/parameters, validate it, and attempt board detection. | UI | [frontend/src/components/dialogs/ImportDialog.tsx](frontend/src/components/dialogs/ImportDialog.tsx), [backend/api/routes.py](backend/api/routes.py), [backend/parser/config_parser.py](backend/parser/config_parser.py), [backend/services/board_detector.py](backend/services/board_detector.py) |
| REQ-CONF-02 | The system shall import a multi-file project, infer the main file, collect MCU metadata, resolve include relationships, and validate the active included file set. | UI | [frontend/src/components/dialogs/ImportDialog.tsx](frontend/src/components/dialogs/ImportDialog.tsx), [backend/api/routes.py](backend/api/routes.py), [frontend/src/utils/graphBuilder.ts](frontend/src/utils/graphBuilder.ts) |
| REQ-CONF-03 | The backend parser shall preserve comments, separators, include directives, line identity, and `SAVE_CONFIG` overlays for round-trip editing. | UI | [backend/parser/config_parser.py](backend/parser/config_parser.py), [backend/parser/config_writer.py](backend/parser/config_writer.py) |
| REQ-CONF-04 | The system shall generate a new blank configuration for supported kinematics including default printer, MCU, motion, extruder, and bed sections. | UI | [frontend/src/components/dialogs/GenerateDialog.tsx](frontend/src/components/dialogs/GenerateDialog.tsx), [backend/api/routes.py](backend/api/routes.py) |
| REQ-CONF-05 | The system shall generate a configuration from bundled reference examples. | UI | [frontend/src/components/dialogs/GenerateDialog.tsx](frontend/src/components/dialogs/GenerateDialog.tsx), [backend/api/routes.py](backend/api/routes.py), [reference/config](reference/config) |
| REQ-CONF-06 | The system shall expose example listing and fuzzy search for bundled example configs. | UI | [frontend/src/services/api.ts](frontend/src/services/api.ts), [backend/api/routes.py](backend/api/routes.py), [frontend/scripts/generate-examples.js](frontend/scripts/generate-examples.js) |
| REQ-CONF-07 | The system shall expose section schema metadata and the bundled Klipper `Config_Reference.md` content to the frontend. | UI | [frontend/src/services/api.ts](frontend/src/services/api.ts), [backend/api/routes.py](backend/api/routes.py), [backend/parser/config_schema.py](backend/parser/config_schema.py) |

### Graph Workspace

| ID | Requirement | Surface | Primary implementation |
| --- | --- | --- | --- |
| REQ-GRAPH-01 | The UI shall render a graph workspace backed by React Flow and represent the loaded project as hardware nodes, child nodes, and routed edges. | UI | [frontend/src/App.tsx](frontend/src/App.tsx), [frontend/src/stores/graphStore.ts](frontend/src/stores/graphStore.ts), [frontend/src/utils/graphBuilder.ts](frontend/src/utils/graphBuilder.ts) |
| REQ-GRAPH-02 | The graph shall support SBC, mainboard, expander, toolhead, config file, probe, accelerometer, and generic hardware containers. | UI | [frontend/src/components/AddMenu.tsx](frontend/src/components/AddMenu.tsx), [frontend/src/components/nodes/HardwareNode.tsx](frontend/src/components/nodes/HardwareNode.tsx) |
| REQ-GRAPH-03 | The graph shall support adding sub-components and feature nodes grouped around the hardware model, including steppers, drivers, extruders, heaters, fans, sensors, probes, LEDs, displays, servos, pins, bed-leveling, homing, resonance, and G-code features. | UI | [frontend/src/components/AddMenu.tsx](frontend/src/components/AddMenu.tsx), [frontend/src/utils/graphBuilder.ts](frontend/src/utils/graphBuilder.ts) |
| REQ-GRAPH-04 | The graph shall support communication edges (USB, CAN bus, UART) and configuration/include edges between hardware nodes. | UI | [frontend/src/stores/graphStore.ts](frontend/src/stores/graphStore.ts), [frontend/src/components/edges](frontend/src/components/edges), [frontend/src/utils/edgeRouting.ts](frontend/src/utils/edgeRouting.ts) |
| REQ-GRAPH-05 | The graph shall support drag, reparent, grouping, collapse/expand, auto-arrange, node duplication/removal, and undo/redo of graph-plus-config snapshots. | UI | [frontend/src/App.tsx](frontend/src/App.tsx), [frontend/src/stores/graphStore.ts](frontend/src/stores/graphStore.ts), [frontend/src/components/nodes/NodeActions.tsx](frontend/src/components/nodes/NodeActions.tsx) |
| REQ-GRAPH-06 | Validation state shall be propagated onto nodes, groups, and hardware containers so that graph elements visibly reflect errors and warnings. | UI | [frontend/src/App.tsx](frontend/src/App.tsx), [frontend/src/components/nodes/WarningBadge.tsx](frontend/src/components/nodes/WarningBadge.tsx), [frontend/src/utils/validationStatus.ts](frontend/src/utils/validationStatus.ts) |

### Settings and Text Editing

| ID | Requirement | Surface | Primary implementation |
| --- | --- | --- | --- |
| REQ-EDIT-01 | Selecting graph elements shall open a schema-driven settings panel for editing section parameters, pin assignments, and node metadata. | UI | [frontend/src/components/SettingsPanel.tsx](frontend/src/components/SettingsPanel.tsx), [frontend/src/stores/configStore.ts](frontend/src/stores/configStore.ts), [backend/parser/config_schema.py](backend/parser/config_schema.py) |
| REQ-EDIT-02 | The text editor shall display the active config file as exported backend text and support live validation, cross-file search, a section/parameter table of contents, and a reference viewer. | UI | [frontend/src/components/TextEditor.tsx](frontend/src/components/TextEditor.tsx), [frontend/src/services/api.ts](frontend/src/services/api.ts) |
| REQ-EDIT-03 | The text editor shall support file-level operations including add blank config, add from example, rename, copy, delete, and switching between files in the loaded project. | UI | [frontend/src/components/TextEditor.tsx](frontend/src/components/TextEditor.tsx), [frontend/src/stores/configStore.ts](frontend/src/stores/configStore.ts) |
| REQ-EDIT-04 | Applying text edits shall reparse the changed file through the backend, update config state, and rebuild the graph from the parsed project model. | UI | [frontend/src/components/TextEditor.tsx](frontend/src/components/TextEditor.tsx), [frontend/src/utils/graphBuilder.ts](frontend/src/utils/graphBuilder.ts), [backend/api/routes.py](backend/api/routes.py) |
| REQ-EDIT-05 | Unknown-section warnings shall be acknowledgeable so the validator can suppress accepted custom/plugin sections on later parses. | UI | [frontend/src/components/TextEditor.tsx](frontend/src/components/TextEditor.tsx), [backend/api/routes.py](backend/api/routes.py), [backend/services/warning_acknowledgments.py](backend/services/warning_acknowledgments.py) |

### AI Assistance

| ID | Requirement | Surface | Primary implementation |
| --- | --- | --- | --- |
| REQ-AI-01 | The UI shall expose an AI Chat dialog from the toolbar, persist provider settings and conversation history in local storage, and support provider presets for OpenAI, Google Gemini, Anthropic, GitHub Copilot, and OpenAI-compatible endpoints (which covers local servers such as LM Studio and Ollama). | UI | [frontend/src/components/Toolbar.tsx](frontend/src/components/Toolbar.tsx), [frontend/src/components/dialogs/ChatDialog.tsx](frontend/src/components/dialogs/ChatDialog.tsx), [frontend/src/stores/aiStore.ts](frontend/src/stores/aiStore.ts), [frontend/src/utils/chatProviders.ts](frontend/src/utils/chatProviders.ts), [frontend/src/types/ai.ts](frontend/src/types/ai.ts) |
| REQ-AI-02 | The frontend shall proxy AI chat requests through `/ai/chat` and stop requests through `/ai/chat/stop`, list local models by calling the provider's `/v1/models` endpoint directly, require API keys only for non-local providers, and honor a per-request `maxTokens` setting configured in the chat settings panel. | UI | [frontend/src/services/api.ts](frontend/src/services/api.ts), [frontend/src/components/dialogs/ChatSettingsPanel.tsx](frontend/src/components/dialogs/ChatSettingsPanel.tsx), [backend/api/ai_routes.py](backend/api/ai_routes.py), [frontend/src/stores/aiStore.ts](frontend/src/stores/aiStore.ts) |
| REQ-AI-03 | The chat proxy shall prepend fixed system guidance, embedded tool descriptions, current printer memory, and frontend-supplied config context, and shall append a trailing task anchor that points the model at the user's latest message. When the model makes no tool call on the first pass, the proxy shall inject an automatic documentation search so provider responses are grounded in the bundled Klipper docs. | UI | [backend/api/ai_routes.py](backend/api/ai_routes.py), [reference/reference_docs/klipper_docs](reference/reference_docs/klipper_docs), [backend/mcp_server.py](backend/mcp_server.py) |
| REQ-AI-04 | Local OpenAI-compatible servers (LM Studio, Ollama, and similar) shall connect through the OpenAI-compatible provider preset, which requires no API key, derives the chat URL from a configured host/port, and uses the text-based ```` ```tool ```` JSON-block protocol for tool access instead of native function calling. | UI | [frontend/src/utils/chatProviders.ts](frontend/src/utils/chatProviders.ts), [backend/api/ai_routes.py](backend/api/ai_routes.py), [frontend/src/components/dialogs/ChatDialog.tsx](frontend/src/components/dialogs/ChatDialog.tsx), [frontend/src/types/ai.ts](frontend/src/types/ai.ts) |
| REQ-AI-05 | The AI chat workflow shall allow attaching loaded or local config files as context, target assistant cfg edits to specific files via `# file:` hints or filename mentions, preview multi-file draft changes, merge changed sections without replacing untouched content, and rebuild project graph/config state after apply. Drafts may also propose brand-new config files, which are previewed as additions and created on accept. | UI | [frontend/src/components/dialogs/ChatDialog.tsx](frontend/src/components/dialogs/ChatDialog.tsx), [frontend/src/components/dialogs/AiDraftPreviewDialog.tsx](frontend/src/components/dialogs/AiDraftPreviewDialog.tsx), [frontend/src/hooks/useAssistantDraft.ts](frontend/src/hooks/useAssistantDraft.ts), [frontend/src/utils/assistantDraftMerge.ts](frontend/src/utils/assistantDraftMerge.ts), [frontend/src/utils/graphBuilder.ts](frontend/src/utils/graphBuilder.ts) |
| REQ-AI-06 | The backend shall expose embedded Klipper documentation/config tools to the model via native function calling (OpenAI `tool_calls` / Anthropic `tool_use`) for cloud providers and a text-based ```` ```tool ```` JSON-block protocol for local/OpenAI-compatible providers, execute tool calls in a loop capped at ten turns, and fall back to an automatic documentation search when the model makes no tool call on the first pass. A per-request `toolProtocol` override may force the native or text protocol for local servers (harness A/B use). | UI | [backend/api/ai_routes.py](backend/api/ai_routes.py), [backend/mcp_server.py](backend/mcp_server.py) |
| REQ-AI-07 | A running chat request shall be cancellable: the frontend aborts its fetch and posts to `/ai/chat/stop` with the request's `requestId`, and the backend races the in-flight provider query against a stop event so the request returns `{"stopped": true}` promptly instead of waiting for the provider to finish. | UI | [backend/api/ai_routes.py](backend/api/ai_routes.py), [frontend/src/services/api.ts](frontend/src/services/api.ts), [frontend/src/components/dialogs/ChatDialog.tsx](frontend/src/components/dialogs/ChatDialog.tsx), [frontend/src/components/dialogs/ChatInputBar.tsx](frontend/src/components/dialogs/ChatInputBar.tsx) |
| REQ-AI-08 | The chat shall manage printer memory: current memory is injected as context, a blank memory triggers an auto-fill investigation prompt, the model may propose updates in a fenced `printer-memory` JSON code block restricted to seven allowed fields, and the user reviews the proposal in a dialog before it is saved. | UI | [backend/api/ai_routes.py](backend/api/ai_routes.py), [frontend/src/utils/printerMemory.ts](frontend/src/utils/printerMemory.ts), [frontend/src/utils/replyValidation.ts](frontend/src/utils/replyValidation.ts), [frontend/src/components/dialogs/PrinterMemoryDialog.tsx](frontend/src/components/dialogs/PrinterMemoryDialog.tsx) |
| REQ-AI-09 | Assistant replies shall pass through a unified validation pipeline (config-draft validator plus printer-memory validator) that requests fixes and re-requests up to a per-validator attempt limit, converts unresolvable issues into advisory warnings, and passes first-pass replies that need no validation through unchanged. | UI | [frontend/src/utils/replyValidation.ts](frontend/src/utils/replyValidation.ts), [frontend/src/utils/draftValidation.ts](frontend/src/utils/draftValidation.ts), [frontend/src/hooks/useAssistantDraft.ts](frontend/src/hooks/useAssistantDraft.ts) |
| REQ-AI-10 | Failed chat requests shall preserve the user's message in history and expose a Retry action; interrupted conversations shall offer the user a choice to carry conversation context (messages, provider settings, and attached config files) into a new chat or start fresh. Saved conversations shall restore messages, provider settings, and attached config files when loaded. | UI | [frontend/src/components/dialogs/ChatDialog.tsx](frontend/src/components/dialogs/ChatDialog.tsx), [frontend/src/stores/chatHistoryStore.ts](frontend/src/stores/chatHistoryStore.ts), [frontend/src/services/api.ts](frontend/src/services/api.ts) |

### Validation, Diff, and Export

| ID | Requirement | Surface | Primary implementation |
| --- | --- | --- | --- |
| REQ-VAL-01 | The validator shall detect missing required parameters, invalid types, unknown sections/parameters, duplicate singleton sections, missing dependencies, and invalid MCU communication definitions. | UI | [backend/parser/validator.py](backend/parser/validator.py), [backend/parser/config_schema.py](backend/parser/config_schema.py) |
| REQ-VAL-02 | Multi-file validation shall consider only files reachable from the active main config and shall distinguish cross-file hard errors from softer reused sub-component/feature warnings. | UI | [backend/parser/validator.py](backend/parser/validator.py), [backend/api/routes.py](backend/api/routes.py) |
| REQ-VAL-03 | Pin validation shall support shared-pin exceptions already encoded by the validator and settings panel logic, including shared TMC UART pins and some shared bus wiring patterns. | UI | [backend/parser/validator.py](backend/parser/validator.py), [frontend/src/components/SettingsPanel.tsx](frontend/src/components/SettingsPanel.tsx) |
| REQ-OUT-01 | The backend shall export a single config or multi-file project as `.cfg` text while preserving as much original formatting as possible. | UI | [frontend/src/components/dialogs/ExportDialog.tsx](frontend/src/components/dialogs/ExportDialog.tsx), [backend/api/routes.py](backend/api/routes.py), [backend/parser/config_writer.py](backend/parser/config_writer.py) |
| REQ-OUT-02 | The frontend shall present diff views between original and current config text before export or apply workflows. | UI | [frontend/src/components/dialogs/DiffDialog.tsx](frontend/src/components/dialogs/DiffDialog.tsx), [frontend/src/components/dialogs/ExportDialog.tsx](frontend/src/components/dialogs/ExportDialog.tsx), [frontend/src/components/dialogs/ApplyDialog.tsx](frontend/src/components/dialogs/ApplyDialog.tsx) |

### Native SBC Integration

| ID | Requirement | Surface | Primary implementation |
| --- | --- | --- | --- |
| REQ-NATIVE-01 | The backend shall detect native mode and expose the active config directory setting to the frontend. | Native UI | [frontend/src/stores/nativeStore.ts](frontend/src/stores/nativeStore.ts), [backend/api/native_routes.py](backend/api/native_routes.py), [backend/services/native_services.py](backend/services/native_services.py) |
| REQ-NATIVE-02 | In native mode the UI shall be able to list and open `.cfg` files directly from the SBC config directory. | Native UI | [frontend/src/components/dialogs/OpenFromPiDialog.tsx](frontend/src/components/dialogs/OpenFromPiDialog.tsx), [backend/api/native_routes.py](backend/api/native_routes.py), [backend/services/native_services.py](backend/services/native_services.py) |
| REQ-NATIVE-03 | In native mode the backend shall list USB serial, UART, and CAN devices and support CAN UUID queries. | Native UI | [frontend/src/stores/nativeStore.ts](frontend/src/stores/nativeStore.ts), [backend/api/native_routes.py](backend/api/native_routes.py), [backend/services/native_services.py](backend/services/native_services.py) |
| REQ-NATIVE-04 | In native mode the UI shall be able to apply selected config files back to disk and then request a Klipper firmware restart. | Native UI | [frontend/src/components/dialogs/ApplyDialog.tsx](frontend/src/components/dialogs/ApplyDialog.tsx), [backend/api/native_routes.py](backend/api/native_routes.py), [backend/services/native_services.py](backend/services/native_services.py) |
| REQ-NATIVE-05 | The UI shall support revert by reloading original imported text in browser mode and by re-reading disk state in native mode. | UI / Native UI | [frontend/src/components/dialogs/RevertDialog.tsx](frontend/src/components/dialogs/RevertDialog.tsx), [frontend/src/stores/configStore.ts](frontend/src/stores/configStore.ts) |
| REQ-NATIVE-06 | The backend shall expose Klipper state and recent log errors through the Unix socket API when native mode is active. | Native UI | [backend/api/native_routes.py](backend/api/native_routes.py), [backend/services/native_services.py](backend/services/native_services.py) |
| REQ-NATIVE-07 | The native backend shall persist UI layout and settings under the application state directory and restore them on reload. | Native UI | [frontend/src/App.tsx](frontend/src/App.tsx), [frontend/src/services/api.ts](frontend/src/services/api.ts), [backend/api/native_routes.py](backend/api/native_routes.py), [backend/services/native_services.py](backend/services/native_services.py) |

### Firmware Tooling

| ID | Requirement | Surface | Primary implementation |
| --- | --- | --- | --- |
| REQ-FW-01 | The UI shall expose firmware tooling for both Klipper and Katapult targets when native mode is active. | Native UI | [frontend/src/components/dialogs/FirmwareDialog.tsx](frontend/src/components/dialogs/FirmwareDialog.tsx), [backend/api/native_routes.py](backend/api/native_routes.py) |
| REQ-FW-02 | The backend shall load current Kconfig state, expose editable fields, preview changes, and persist target `.config` assignments. | Native UI | [backend/api/native_routes.py](backend/api/native_routes.py), [backend/services/flash_targets.py](backend/services/flash_targets.py), [backend/services/klipper_firmware.py](backend/services/klipper_firmware.py) |
| REQ-FW-03 | The backend shall build flash targets, run target-specific flash commands, and expose generated artifacts for download. | Native UI | [backend/api/native_routes.py](backend/api/native_routes.py), [backend/services/flash_targets.py](backend/services/flash_targets.py), [backend/services/klipper_firmware.py](backend/services/klipper_firmware.py) |
| REQ-FW-04 | The firmware workflow shall surface flash-device candidates such as USB serial, UART, DFU VID:PID, and RP2040 mass-storage shortcuts when the target supports them. | Native UI | [backend/services/flash_targets.py](backend/services/flash_targets.py), [frontend/src/components/dialogs/FirmwareDialog.tsx](frontend/src/components/dialogs/FirmwareDialog.tsx) |

### Macro Designer

| ID | Requirement | Surface | Primary implementation |
| --- | --- | --- | --- |
| REQ-MACRO-01 | The UI shall provide a macro designer for creating, updating, duplicating, and deleting macro drafts and no-go zones. | UI | [frontend/src/components/dialogs/MacroDesignerDialog.tsx](frontend/src/components/dialogs/MacroDesignerDialog.tsx), [frontend/src/stores/macroDesignerStore.ts](frontend/src/stores/macroDesignerStore.ts) |
| REQ-MACRO-02 | The macro designer shall derive macros from loaded config files, normalize macro content for config output, and simulate motion/toolhead state. | UI | [frontend/src/components/dialogs/MacroDesignerDialog.tsx](frontend/src/components/dialogs/MacroDesignerDialog.tsx), [frontend/src/utils/macroDesigner.ts](frontend/src/utils/macroDesigner.ts), [frontend/src/utils/gcodeSimulator.ts](frontend/src/utils/gcodeSimulator.ts) |
| REQ-MACRO-03 | Macro designer state shall persist in local storage and, in native mode, be included in saved layout payloads. | UI / Native UI | [frontend/src/stores/macroDesignerStore.ts](frontend/src/stores/macroDesignerStore.ts), [frontend/src/App.tsx](frontend/src/App.tsx), [backend/api/native_routes.py](backend/api/native_routes.py) |

### Backend-only Project Persistence

| ID | Requirement | Surface | Primary implementation |
| --- | --- | --- | --- |
| REQ-API-01 | The backend shall support save/list/load project endpoints for config files plus graph layout, even though the current primary frontend does not call them. | API | [backend/api/routes.py](backend/api/routes.py), [backend/models/config_models.py](backend/models/config_models.py), [backend/projects](backend/projects) |

## Non-Functional and Operational Constraints

- The parser/exporter path is the single source of truth for config text fidelity. Both the graph workspace and the text editor ultimately round-trip through backend parsing and export logic.
- Native filesystem, device, Klipper socket, and firmware features are gated by native mode and return HTTP 501 outside that environment.
- The frontend auto-generates reference assets before `dev` and `build` so example search and static schema fallbacks remain available.
- The current repository does not implement authentication, authorization, or multi-user collaboration.

## Current Gaps and Notes

- Project save/load endpoints exist in the backend but are not currently wired to the main toolbar or startup workflow.
- Automated test coverage is strongest for parser, validator, save-config, firmware route/service behavior, and AI chat backend routing. Browser-level AI draft-apply flows (including new-file creation and saved-conversation restore), other UI interaction paths, and physical hardware flashing still require manual functional verification.