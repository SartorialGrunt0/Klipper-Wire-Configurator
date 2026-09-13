"""config_edit / config_write tool layer for the AI chat loop (Phase 1).

Request-scoped write tools over :class:`services.ai_draft_project.ProjectState`.
The session lives for ONE chat request (no per-conversation draft store —
Sir 2026-09-12): each request seeds the live working state from its
``contextFiles`` payload, stacks multiple write calls within the loop, and
returns the staged changes as ``pendingEdits`` for the CURRENT draft UI.
Disk is never touched here; the save menu remains the only path to disk.

content/details split (pi pattern): the model-facing tool result is LEAN
(status + summary + exact new errors + current section text on anchor
miss); the full diff payload rides in ``details`` for the UI only. Nothing
here re-quotes the model's previous content (REPAIR-01 discipline).

Phase 1 scope: no approval gate yet — validated edits accumulate into
pendingEdits; ``KWC_EDIT_TOOLS`` off means these tools are not advertised
and never routed.
"""
from __future__ import annotations

import json

from services.ai_draft_project import ProjectState

# Nudge appended (as a user turn) when an edit request is answered in
# prose. Live Gate-1 traces (qwen3.5-9b, r7) showed the failure mode is
# argument-shape amnesia: the model re-reads files, drafts a ```cfg
# block, gets told "use the tool", and re-reads again. The nudge
# therefore answers the question it is implicitly asking (what exactly
# do the arguments look like?) instead of only scolding.
_EDIT_NUDGE_TEXT = """You described changes but did not call config_edit or config_write. Config blocks written in prose are display-only and are NEVER applied. Call the tool NOW with the arguments below (do not read files again first -- the section text you need is already in this conversation), or -- if the change is not safe or not possible -- explain why to the user and ask.
Exact call shapes:
config_edit (set a parameter): {"file": "printer.cfg", "op": "set_param", "section": "printer", "key": "max_accel", "value": "12000"}
config_edit (edit a macro body): {"file": "printer.cfg", "op": "patch_gcode", "section": "gcode_macro NAME", "old_text": "<line copied verbatim>", "new_text": "<replacement>"}
config_edit (include a file): {"file": "printer.cfg", "op": "add_include", "target_file": "new.cfg"}
config_write (create a NEW file only): {"file": "new.cfg", "content": "<full file text>"}"""

EDIT_TOOL_NAMES = frozenset({"config_edit", "config_write"})

CONFIG_EDIT_SPEC = {
    "name": "config_edit",
    "description": (
        "Apply one mechanical edit operation to the user's config project. "
        "The change is validated against the live project and either staged "
        "for the user's review or rejected with exact validation errors. "
        "One operation per call; call again for more edits. Ops: set_param "
        "(upsert key=value in a section), add_section (new section with "
        "text body), replace_section (rewrite a section's body), "
        "delete_section, patch_gcode (replace old_text with new_text "
        "inside a section — quote lines exactly as read returned them), "
        "delete_file, add_include, remove_include. Existing files CANNOT be "
        "rewritten wholesale — use the targeted ops; config_write creates "
        "new files. Never call this for questions — only to change the "
        "user's config."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "file": {
                "type": "string",
                "description": "Target config filename, e.g. 'printer.cfg'",
            },
            "op": {
                "type": "string",
                "enum": [
                    "set_param", "add_section", "replace_section",
                    "delete_section", "patch_gcode", "delete_file",
                    "add_include", "remove_include",
                ],
                "description": "The operation to apply",
            },
            "section": {
                "type": "string",
                "description": "Section header for section ops, e.g. 'bed_mesh' or 'gcode_macro PRINT_START' (brackets optional)",
            },
            "key": {
                "type": "string",
                "description": "Parameter name (set_param only)",
            },
            "value": {
                "type": "string",
                "description": "New parameter value (set_param only). Multi-line values use newlines with continuation indentation.",
            },
            "text": {
                "type": "string",
                "description": "Section body text (add_section / replace_section) — body only, no [header] line",
            },
            "old_text": {
                "type": "string",
                "description": "Exact lines to replace (patch_gcode) — copy verbatim from the file content you read",
            },
            "new_text": {
                "type": "string",
                "description": "Replacement lines (patch_gcode); empty string deletes the matched lines",
            },
            "allow_comment_change": {
                "type": "boolean",
                "description": (
                    "patch_gcode only: set true ONLY when the user explicitly "
                    "asked to uncomment or comment out the named parameter(s); "
                    "the tool refuses comment-status changes without it"
                ),
            },
            "target_file": {
                "type": "string",
                "description": "File to include/un-include (add_include / remove_include)",
            },
        },
        "required": ["file", "op"],
    },
}

CONFIG_WRITE_SPEC = {
    "name": "config_write",
    "description": (
        "Create a NEW config file with the given content and stage it for "
        "the user's review. Only new files — existing files must be changed "
        "with config_edit operations. After creating a file, add an "
        "[include <file>] with config_edit op=add_include when it must load."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "file": {
                "type": "string",
                "description": "New file's name, e.g. 'macros_extrude.cfg'",
            },
            "content": {
                "type": "string",
                "description": "Full content of the new file",
            },
        },
        "required": ["file", "content"],
    },
}

EDIT_TOOL_SPECS = [CONFIG_EDIT_SPEC, CONFIG_WRITE_SPEC]

# Edit-protocol section added to the system prompt ONLY when the write
# tools are advertised (replaced by load_skill gating in Phase 3).
EDIT_PROTOCOL_PROMPT = """# Editing the User's Config

To change the user's config files you MUST call config_edit or
config_write. Config code blocks in your prose are display-only and are
never applied — for an edit request, do NOT answer with a ```cfg block or a
description of the change; make the tool call instead.

Rules:
- Read before you edit: read_user_config the file or section first so
  anchors, keys, and current values are exact.
- One config_edit operation per call; chain calls for multi-part changes.
- When config_edit returns validation errors, read them, adjust, and
  retry with a CORRECTED change — never repeat the same failed call. On a
  patch_gcode anchor miss the result includes the section's current text;
  quote lines exactly as they appear there.
- Warnings returned as advisories do not block the change; mention them
  to the user when relevant.
- Commented-out parameters are NOT active config: editing or deleting
  their text changes NOTHING and must never be reported as enabling or
  updating the parameter. If an op is refused for touching one, explain
  the situation and ASK; never set allow_comment_change=true on your own
  judgment — only after the user's own reply confirms it.
- Applied changes are STAGED for the user's review, not saved. Never tell
  the user a change is saved or active until they approve and save it."""


def _lean_error_content(name: str, result: dict) -> str:
    """Model-facing failure text (REPAIR-01 shape: lean, exact errors,
    imperative next step; section text only when it enables re-quoting)."""
    lines = [f"{name} FAILED: {result.get('error', 'Unknown error')}"]
    new_errors = result.get("newErrors") or []
    if new_errors:
        lines.append("New validation errors introduced by this change:")
        for err in new_errors[:8]:
            where = f"[{err.get('section', '')}] {err.get('param', '')}".rstrip()
            lines.append(f"- {where}: {err.get('message', '')}")
        lines.append(
            "Fix the change and call again with corrected arguments. Do not "
            "repeat the same op and values. Read the affected section with "
            "read_user_config if unsure of the current content."
        )
    if result.get("sectionText"):
        lines.append("")
        lines.append("Current section text (quote from this verbatim):")
        lines.append(f"---\n{result['sectionText']}\n---")
    return "\n".join(lines)


def _lean_success_content(name: str, result: dict) -> str:
    status = result.get("status", "applied")
    head = f"{name} applied — {result.get('summary', '')}"
    advisories = result.get("advisories") or []
    if status == "applied_with_advisory" and advisories:
        head += f" with {len(advisories)} advisory" + ("s" if len(advisories) != 1 else "")
        for adv in advisories[:6]:
            where = f"[{adv.get('section', '')}] {adv.get('param', '')}".rstrip()
            head += f"\n- advisory ({adv.get('severity', 'warning')}) {where}: {adv.get('message', '')}"
        head += "\nAdvisories do not block the staged change."
    head += "\nChange is STAGED for the user's review (not saved)."
    return head


class EditSession:
    """Request-scoped edit session: live state + baseline + staged edits."""

    def __init__(self, context_files: dict[str, dict]) -> None:
        self.state = ProjectState.from_context_files(context_files)
        self.baseline = self.state.validate()
        self.pending_edits: list[dict] = []
        self.edit_attempts = 0
        # Classification of the most recent write-tool outcome:
        #   None         — no write call yet this request
        #   'success'    — staged (partial success counts; see 'correctable')
        #   'user_gated' — commented-param refusal: explain-and-ask IS the
        #                  finished move; a nudge would force the change
        #   'correctable'— anchor miss / bad args / op misuse: the model
        #                  must retry with corrected arguments; giving up
        #                  on those must not stand (r4 EDIT-01) — and a
        #                  give-up on the SECOND half of a multi-part
        #                  change must not hide behind the staged first
        #                  half either (r5 EDIT-04).
        self.last_write_outcome: str | None = None
        self._last_file: str | None = None

    def has_files(self) -> bool:
        return bool(self.state.files)

    def execute(self, tool_call: dict) -> tuple[str, dict | None]:
        """Run one write tool call. Returns (lean content, details-or-None).

        ``details`` (UI payload, never sent to the model) is set on
        success: ``{file, op, summary, newText, diff}`` shaped for the
        current draft UI + future approval card.
        """
        name = tool_call.get("name", "")
        args = tool_call.get("arguments", {}) or {}
        self.edit_attempts += 1

        if name == "config_write":
            op = {
                "op": "new_file",
                "file": str(args.get("file", "")),
                "content": str(args.get("content", "")),
            }
        elif name == "config_edit":
            op = {"op": str(args.get("op", ""))}
            for arg_key in ("file", "section", "key", "text",
                            "old_text", "new_text", "target_file"):
                if arg_key in args and args[arg_key] is not None:
                    op[arg_key] = str(args[arg_key])
            if "value" in args and args["value"] is not None:
                op["value"] = str(args["value"])
            if args.get("allow_comment_change"):
                op["allow_comment_change"] = True
        else:
            return f"Unknown write tool: {name}", None

        new_state, result = self.state.apply(self.baseline, op)
        if result["status"] == "error":
            # ONLY the set_param commented-param refusal is user-gated:
            # no alternate op satisfies the request without the user's OK.
            # Boundary/dormant/anchor refusals are CORRECTABLE (right
            # tool, wrong op/args) — a give-up after one gets nudged.
            self.last_write_outcome = (
                "user_gated" if "exists but is commented out"
                in str(result.get("error", "")) else "correctable")
            return _lean_error_content(name, result), None

        self.state = new_state
        self.last_write_outcome = "success"
        file_name = result.get("file", "")
        details = {
            "file": file_name,
            "op": result.get("op", name),
            "summary": result.get("summary", ""),
            "newText": self.state.files.get(file_name, ""),
            "advisories": result.get("advisories", []),
            "diff": result.get("diff"),
        }
        # Stacked edits to the same file replace its staged entry so the
        # draft UI shows the cumulative result, not intermediate states.
        self.pending_edits = [
            e for e in self.pending_edits if e["file"] != file_name
        ]
        self.pending_edits.append(details)
        self._last_file = file_name
        return _lean_success_content(name, result), details

    def pending_edits_payload(self) -> list[dict]:
        """Client-facing staged edits (the UI consumes these; diffs stay
        out of chat tool-call records to keep responses lean)."""
        return [
            {k: e.get(k) for k in ("file", "op", "summary", "newText", "advisories")}
            for e in self.pending_edits
        ]


def edit_tool_details_from_content(result_text: str) -> bool:
    """Heuristic for logs/tests: whether a result line was a success."""
    return result_text.startswith("config_edit applied") or result_text.startswith(
        "config_write applied"
    )


def format_edit_attempt_log(session: EditSession) -> str:
    return json.dumps({
        "editAttempts": session.edit_attempts,
        "stagedFiles": [e["file"] for e in session.pending_edits],
    })
