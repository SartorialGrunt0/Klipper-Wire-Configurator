# Functional Test Plan

Last reviewed: 2026-05-14

This plan verifies the requirements captured in [requirements-specifications](requirements-specifications). It separates strict automated suites, informational automation that produces diagnostics without hard assertions, and manual scenarios that still require a running UI or real hardware.

## Execution Model

- Automated assertion suites: pass/fail checks driven by `pytest`.
- Informational automation: existing scripts in `tests/` that emit diagnostics but do not currently fail on content drift.
- Manual scenarios: UI and hardware flows that are not covered by the existing automated suite.

## Automation Entry Point

Run [scripts/run_functional_tests.py](scripts/run_functional_tests.py). By default it writes timestamped results into `reports/functional-test-results/`, which is intentionally git-ignored.

Example:

```bash
python scripts/run_functional_tests.py
```

## Automated Coverage Matrix

| Test ID | Requirement IDs | Purpose | Automation type | Evidence source |
| --- | --- | --- | --- | --- |
| FTA-001 | REQ-CONF-03, REQ-EDIT-05, REQ-VAL-01, REQ-VAL-02, REQ-VAL-03, REQ-OUT-01 | Validate parser, validator, save-config handling, cross-file validation, shared-pin allowances, and warning acknowledgement behavior. | Strict pass/fail | [tests/test_delta_validation.py](tests/test_delta_validation.py), [tests/test_warning_acknowledgments.py](tests/test_warning_acknowledgments.py), [tests/test_save_config_handling.py](tests/test_save_config_handling.py) |
| FTA-002 | REQ-FW-01, REQ-FW-02, REQ-FW-03, REQ-FW-04, REQ-NATIVE-06 | Validate firmware and flash-target API contract forwarding, artifact selection, and flash-device candidate logic. | Strict pass/fail | [tests/test_native_firmware_routes.py](tests/test_native_firmware_routes.py), [tests/test_flash_target_routes.py](tests/test_flash_target_routes.py), [tests/test_flash_target_service.py](tests/test_flash_target_service.py), [tests/test_klipper_firmware_service.py](tests/test_klipper_firmware_service.py) |
| FTA-003 | REQ-AI-02, REQ-AI-03, REQ-AI-04 | Validate AI model listing, provider key gating, docs-grounded prompt preparation, and LM Studio MCP fallback metadata on the backend proxy. | Strict pass/fail | [tests/test_ai_chat_routes.py](tests/test_ai_chat_routes.py) |
| FTI-001 | REQ-CONF-01, REQ-CONF-02, REQ-CONF-03, REQ-OUT-01 | Exercise corpus-wide parse/export round-tripping across bundled reference configs and backups. | Informational automation | [tests/test_roundtrip.py](tests/test_roundtrip.py) |
| FTI-002 | REQ-CONF-03, REQ-EDIT-04, REQ-OUT-01, REQ-OUT-02 | Exercise the parse -> API model -> smart export path against the Trident backup sample and report diff counts. | Informational automation | [tests/test_diff_roundtrip.py](tests/test_diff_roundtrip.py) |

## Manual Functional Scenarios

### FTM-001 Generate a new configuration

Requirements: REQ-CONF-04, REQ-CONF-05, REQ-CONF-06, REQ-GRAPH-01

Preconditions:
1. Start the backend and frontend or open the production build.
2. Ensure no unsaved data is required.

Procedure:
1. Open the Generate dialog.
2. Generate a blank config for a supported kinematics type.
3. Repeat with an example config selected through the search UI.

Expected result:
1. The workspace is replaced with the generated config.
2. Validation status is shown for the generated file.
3. The graph view renders nodes for the generated content.

### FTM-002 Import and inspect a project through the UI

Requirements: REQ-CONF-01, REQ-CONF-02, REQ-CONF-07, REQ-GRAPH-01, REQ-GRAPH-06

Preconditions:
1. Have one single-file config and one multi-file project available.

Procedure:
1. Import a single `.cfg` file.
2. Import a multi-file project directory.
3. Inspect validation results, detected board data, and graph topology.

Expected result:
1. The import summary identifies main file and MCU relationships.
2. Validation issues are visible in the graph and the imported files are loaded into state.

### FTM-003 Edit from the graph and settings panel

Requirements: REQ-GRAPH-02, REQ-GRAPH-03, REQ-GRAPH-04, REQ-GRAPH-05, REQ-EDIT-01

Procedure:
1. Add hardware, sub-component, and feature nodes from the Add menu.
2. Create communication and configuration edges.
3. Drag/reparent child nodes, group compatible nodes, collapse/expand hardware, and run auto-arrange.
4. Modify parameters in the settings panel.
5. Use undo and redo.

Expected result:
1. Graph changes update the underlying config model.
2. Validation state updates after edits.
3. Undo/redo restores both graph layout and config-backed state.

### FTM-004 Edit in text view and sync back to the graph

Requirements: REQ-EDIT-02, REQ-EDIT-03, REQ-EDIT-04, REQ-EDIT-05

Procedure:
1. Switch to text view.
2. Use search, section navigation, and the reference viewer.
3. Rename, copy, add, and delete config files.
4. Modify text in the active file and apply changes.
5. Trigger and acknowledge an unknown-section warning if available.

Expected result:
1. Live validation markers appear while typing.
2. Applying text rebuilds the graph from parsed config state.
3. File-level operations update the loaded project and active file selection.

### FTM-005 Review diffs and export artifacts

Requirements: REQ-OUT-01, REQ-OUT-02

Procedure:
1. Make a change to one or more loaded config files.
2. Open the Diff dialog.
3. Open the Export dialog and export both individual files and ZIP format.

Expected result:
1. Diff output matches the modified config text.
2. Exported files download with expected filenames and content.

### FTM-006 Open, apply, and revert directly on a native SBC

Requirements: REQ-NATIVE-01, REQ-NATIVE-02, REQ-NATIVE-03, REQ-NATIVE-04, REQ-NATIVE-05, REQ-NATIVE-06, REQ-NATIVE-07

Preconditions:
1. Run the backend on a Linux SBC or enable `KWC_FAKE_NATIVE` for development.
2. Point the config path at a test Klipper config directory.

Procedure:
1. Open configs from the Pi.
2. Confirm the native device lists and CAN UUID query.
3. Modify a file and use Apply.
4. Trigger firmware restart and inspect reported status.
5. Use Revert and confirm disk state is reloaded.
6. Reload the app and verify layout restoration.

Expected result:
1. Native routes read and write the configured directory.
2. Restart/status feedback is surfaced in the UI.
3. Layout persists between reloads.

### FTM-007 Firmware build and flash workflow

Requirements: REQ-FW-01, REQ-FW-02, REQ-FW-03, REQ-FW-04

Preconditions:
1. Native mode is active.
2. Local Klipper and/or Katapult checkouts are available.
3. Target hardware or a safe test environment is available.

Procedure:
1. Open the Firmware dialog.
2. Load state for Klipper and Katapult.
3. Preview and save configuration assignments.
4. Build a target.
5. Download the artifact and, if appropriate, perform a flash operation.

Expected result:
1. Field values, flash-device candidates, and artifacts are shown.
2. Build and flash command results are surfaced with logs and artifact metadata.

### FTM-008 Macro designer workflow

Requirements: REQ-MACRO-01, REQ-MACRO-02, REQ-MACRO-03

Procedure:
1. Open the Macro Designer.
2. Create, edit, duplicate, and delete drafts.
3. Add or edit no-go zones.
4. Run a simulation path.
5. Reload the app and verify persisted macro designer state.

Expected result:
1. Drafts and zones persist locally.
2. Simulation feedback responds to macro content and bounds.
3. Native layout saves include macro designer payloads.

### FTM-009 AI chat grounding and draft-apply workflow

Requirements: REQ-AI-01, REQ-AI-05

Preconditions:
1. Load a single-file or multi-file config project in the UI.
2. Configure at least one AI provider or local server endpoint.

Procedure:
1. Open AI Chat from the toolbar.
2. Verify provider settings, switch between a hosted and local provider if available, and save the configuration.
3. Ask a documentation-grounded Klipper question that references a specific section or parameter.
4. Attach at least one local config file or reference one or more loaded config files by name.
5. Request a config edit that targets the active file and, for multi-file projects, a second named file.
6. Review the draft preview and apply the suggested changes.

Expected result:
1. Provider settings and message history persist across closing and reopening the dialog.
2. The response arrives through the proxy or returns a clear provider error without corrupting the stored conversation history.
3. Draft preview groups changes by target file before apply.
4. Applied changes preserve untouched comments and unrelated section content while rebuilding graph/config state from the accepted draft.

## Result Interpretation

- A passing automated run means the strict backend/service regression suite, including AI chat backend routing, is currently green.
- Informational suites should be reviewed for drift trends even when they do not fail the run.
- Manual scenarios remain required before release because the current automated suite does not exercise browser interaction fidelity, AI draft-apply UX, external provider connectivity, or physical hardware behavior.