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
EDIT_NUDGE_TEXT = """Call the tool NOW (do not read files again first -- the section text you
need is already in this conversation), or -- if the change is not safe or
not possible -- explain why to the user and ask.
Reply with EXACTLY this fence format (a fenced json block is NOT a tool
call and will be ignored):
```tool
{"name": "config_edit", "arguments": {"file": "<file.cfg>", "op": "set_param", "section": "<section>", "key": "<param>", "value": "<new value>"}}
```
Other argument shapes:
patch a macro body: {"name": "config_edit", "arguments": {"file": "<file.cfg>", "op": "patch_gcode", "section": "gcode_macro NAME", "old_text": "<line copied verbatim>", "new_text": "<replacement>"}}
include a file: {"name": "config_edit", "arguments": {"file": "<file.cfg>", "op": "add_include", "target_file": "new.cfg"}}
create a NEW file only: {"name": "config_write", "arguments": {"file": "new.cfg", "content": "<full file text>"}}
set_param value must be ONE LINE — multi-line values (e.g. gcode:) are dropped by some tool-call channels and must go through replace_section or patch_gcode."""

EDIT_NUDGE_TEXT_NATIVE = """Call the tool NOW using your tool-calling interface (do not read \
files again first -- the section text you need is already in this \
conversation), or -- if the change is not safe or not possible -- explain \
why to the user and ask.
Argument shapes for the edit tools:
set_param: {"file": "<file.cfg>", "op": "set_param", "section": "<section>", "key": "<param>", "value": "<new value>"}
value must be ONE LINE; for multi-line params (gcode:) use replace_section
patch a macro body: {"file": "<file.cfg>", "op": "patch_gcode", "section": "gcode_macro NAME", "old_text": "<line copied verbatim>", "new_text": "<replacement>"}
include a file: {"file": "<file.cfg>", "op": "add_include", "target_file": "<new.cfg>"}
create a NEW file only: {"file": "<new.cfg>", "content": "<full file text>"}"""

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
        "delete_file, add_include, remove_include, comment_include "
        "(disable an include line as '#[include ...]' -- use this instead of "
        "remove_include when the user wants the file to stop loading but the "
        "line kept for later re-enable). Existing files CANNOT be "
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
                    "add_include", "remove_include", "comment_include",
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
                "description": (
                    "New parameter value (set_param only) — ONE LINE. "
                    "Multi-line values (gcode:, a list) get DROPPED by "
                    "some tool-call channels: write them with "
                    "replace_section or patch_gcode instead"
                ),
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
                "description": ("File to include/un-include/comment-out "
                                "(add_include / remove_include / comment_include)"),
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
        # Ops approved+committed during THIS request (in order), replayed
        # over a refreshed context on later approve re-validations.
        self.committed_ops: list[dict] = []
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
        # True once a commented-parameter refusal fired THIS request.
        # User confirmation can only arrive as a NEW user message (new
        # EditSession), so an allow_comment_change=true arriving later in
        # the SAME request is provably model-self-granted — the exact
        # live r4b EDIT-06 shape (refusal -> immediate retry with the
        # flag set). Every later allow_comment_change op is refused as a
        # self-grant until the user speaks.
        self.comment_refused = False
        # Identical FAILED call repeats (TRIDENT-15 r1 2026-09-19: gemma
        # repeated one arg-channel-lost set_param 17x, burning the whole
        # turn budget). The lean kickback says "correct your arguments"
        # but a model stuck in a template loop re-sends the same bytes;
        # the 2nd identical failure escalates to an unmistakable stop-
        # and-change-strategy directive, and the 4th hard-stops (no
        # apply attempt). Key: (name, canonical args) -> failure count.
        self._identical_failures: dict[str, int] = {}
        self._last_file: str | None = None

    def has_files(self) -> bool:
        return bool(self.state.files)

    @staticmethod
    def tool_call_to_op(name: str, args: dict) -> dict | None:
        """Map a model-facing tool call to the internal ProjectState op.

        Shared by execute() (auto-approve path) and prepare() (approval
        path) so the two can never drift.
        """
        if name == "config_write":
            return {
                "op": "new_file",
                "file": str(args.get("file", "")),
                "content": str(args.get("content", "")),
            }
        if name == "config_edit":
            op: dict = {"op": str(args.get("op", ""))}
            for arg_key in ("file", "section", "key", "text",
                            "old_text", "new_text", "target_file"):
                if arg_key in args and args[arg_key] is not None:
                    op[arg_key] = str(args[arg_key])
            if "value" in args and args["value"] is not None:
                op["value"] = str(args["value"])
            if args.get("allow_comment_change"):
                op["allow_comment_change"] = True
            return op
        return None

    @staticmethod
    def _op_target(op: dict) -> tuple | None:
        """Identity of what an op OVERWRITES, for the same-request
        duplicate guard. Only set_param qualifies: two legit patch_gcode
        hunks in one macro body must stay possible, config_write on an
        existing file already errors elsewhere. None = no guard."""
        if op.get("op") == "set_param":
            return ("set_param", op.get("file"), op.get("section"),
                    op.get("key"))
        return None

    def _duplicate_of_committed(self, op: dict) -> dict | None:
        """If this op re-overwrites a target already committed THIS
        request, return the committed result; else None.

        Gate-mode evidence (live smoke 2026-09-14): after the user
        APPROVED set_param max_accel=3200, the cfg-block nudge's example
        call (same key!) was copied by the model verbatim with a
        hallucinated value — opening a second approval card for a target
        the user had already decided. Each bogus card taxes the human 90s
        (auto-decline window). A repeat on an identical target within one
        request is mechanically detectable; block it with an honest
        kickback instead of opening another card."""
        target = self._op_target(op)
        if target is None:
            return None
        for entry in reversed(self.committed_ops):
            if self._op_target(entry.get("raw_op") or {}) == target:
                return entry
        return None

    @staticmethod
    def _call_key(name: str, args: dict) -> str:
        try:
            canon = json.dumps(args, sort_keys=True, ensure_ascii=False)
        except (TypeError, ValueError):
            canon = repr(sorted(str(a) for a in args.items()))
        return f"{name}\u0000{canon}"

    def _note_failure(self, name: str, args: dict) -> int:
        """Count a FAILED call; returns how many times THIS exact call
        has now failed (1 = first)."""
        key = self._call_key(name, args)
        self._identical_failures[key] = \
            self._identical_failures.get(key, 0) + 1
        return self._identical_failures[key]

    def _repeat_directive(self, name: str, count: int) -> str:
        if count == 1:
            return ""
        if count == 2:
            return (
                "\n\nThis is the SECOND IDENTICAL failed call — the exact "
                "same tool and arguments. Whatever failed will fail "
                "again: do NOT repeat it. Read the section with "
                "read_user_config, then re-issue with genuinely "
                "different arguments (correct op / section / key / "
                "value). If an argument you meant to send is missing "
                "from the call you just made, your argument channel "
                "dropped it — re-send the full call."
            )
        return (
            f"\n\nThis identical call has failed {count} times. It is "
            "BLOCKED: stop retrying it and change strategy — use a "
            "different op (e.g. replace_section instead of set_param), "
            "or tell the user exactly what you could not apply and "
            "why. Never tell the user a blocked change was staged."
        )

    def _repetition_blocked(self, name: str, args: dict) -> str | None:
        """Hard-stop text once the SAME call has failed 3+ times (the
        next repeat is refused WITHOUT touching state); None to allow."""
        if self._identical_failures.get(
                self._call_key(name, args), 0) >= 3:
            return (
                f"{name} BLOCKED — this identical call already failed 3 "
                "times and was not changed. Stop retrying: try a "
                "different op/shape, or explain to the user what could "
                "not be applied. No change is staged."
            )
        return None

    def _duplicate_kickback(self, dup: dict) -> str:
        prev = dup.get("result", {})
        return (
            "DUPLICATE TARGET — this exact parameter was already applied "
            f"and staged in this request ({prev.get('summary', 'previous change')}). "
            "Do not re-edit the same parameter. If the user wants a "
            "different value, tell them the current staged value and ask; "
            "a NEW value requires a NEW user message."
        )

    def _self_grant_kickback(self, name: str) -> str:
        return (
            f"{name} BLOCKED — SELF-GRANT. A commented-parameter refusal "
            "already fired earlier in THIS request. The user cannot have "
            "confirmed anything between two tool calls inside one request, "
            "so allow_comment_change=true here is model self-granted, which "
            "is never valid. Do NOT retry with the flag. Explain the "
            "commented-out parameter to the user and ASK; only a NEW user "
            "message confirming the change authorizes a later request to "
            "run it with allow_comment_change=true."
        )

    def execute(self, tool_call: dict) -> tuple[str, dict | None]:
        """Run one write tool call (auto-approve path). Returns
        (lean content, details-or-None).

        ``details`` (UI payload, never sent to the model) is set on
        success: ``{file, op, summary, newText, diff}`` shaped for the
        current draft UI + the approval card.
        """
        name = tool_call.get("name", "")
        args = tool_call.get("arguments", {}) or {}
        self.edit_attempts += 1

        op = self.tool_call_to_op(name, args)
        if op is None:
            return f"Unknown write tool: {name}", None

        blocked = self._repetition_blocked(name, args)
        if blocked is not None:
            self.last_write_outcome = "correctable"
            return blocked, None

        dup = self._duplicate_of_committed(op)
        if dup is not None:
            # user_gated: unlocking requires a NEW user message, never a
            # nudge-prompted retry (see _duplicate_of_committed evidence).
            self.last_write_outcome = "user_gated"
            return self._duplicate_kickback(dup), None

        if op.get("allow_comment_change") and self.comment_refused:
            self.last_write_outcome = "user_gated"
            return self._self_grant_kickback(name), None

        new_state, result = self.state.apply(self.baseline, op)
        if result["status"] == "error":
            # ANY commented-parameter refusal is user-gated (r9 finding:
            # classifying the patch_gcode boundary refusal as
            # 'correctable' disarmed the shield set by the earlier
            # set_param refusal, and the "call the tool NOW" nudge read
            # to the model as the user's permission -- it self-granted
            # allow_comment_change). No retry without the user satisfies
            # these. Correctable = anchor miss, bad/missing args,
            # unknown section/op, self-include.
            gated = (
                bool(result.get("commentedParams"))
                or "exists but is commented out"
                in str(result.get("error", "")))
            if gated:
                self.comment_refused = True
            self.last_write_outcome = (
                "user_gated" if gated else "correctable")
            count = self._note_failure(name, args)
            return (_lean_error_content(name, result)
                    + self._repeat_directive(name, count)), None

        self.commit(new_state, name, result, raw_op=op)
        return _lean_success_content(name, result), self._details_for(name, result)

    def prepare(
        self, tool_call: dict,
    ) -> tuple[str, dict, "ProjectState"] | tuple[str, None, None]:
        """Validate one write call WITHOUT staging it (approval path).

        Returns ``(lean_error, None, None)`` when the call is invalid —
        identical kickback to execute()'s error branch (plan law: a call
        with new validation errors never produces a card). On valid,
        returns ``(success_content, result, preview_state)`` where the
        caller creates an ApprovalRequest over ``result`` and only calls
        ``commit()`` after the user approves.
        """
        name = tool_call.get("name", "")
        args = tool_call.get("arguments", {}) or {}
        self.edit_attempts += 1

        op = self.tool_call_to_op(name, args)
        if op is None:
            return f"Unknown write tool: {name}", None, None

        dup = self._duplicate_of_committed(op)
        if dup is not None:
            # Same guard as execute(); a DUPLICATE TARGET never becomes
            # an approval card — the user already decided this target.
            self.last_write_outcome = "user_gated"
            return self._duplicate_kickback(dup), None, None

        if op.get("allow_comment_change") and self.comment_refused:
            # Same self-grant lock as execute(): no card for a flag the
            # model cannot legitimately have earned mid-request.
            self.last_write_outcome = "user_gated"
            return self._self_grant_kickback(name), None, None

        new_state, result = self.state.apply(self.baseline, op)
        if result["status"] == "error":
            gated = (
                bool(result.get("commentedParams"))
                or "exists but is commented out"
                in str(result.get("error", "")))
            if gated:
                self.comment_refused = True
            self.last_write_outcome = (
                "user_gated" if gated else "correctable")
            count = self._note_failure(name, args)
            return (_lean_error_content(name, result)
                    + self._repeat_directive(name, count)), None, None

        return _lean_success_content(name, result), result, new_state

    def commit(self, new_state: "ProjectState", name: str, result: dict,
               raw_op: dict | None = None) -> None:
        """Stage a prepared/validated op into the session (single recorder
        of committed_ops — used by the auto-approve path AND the decision
        endpoint's approve path; nothing else mutates session state)."""
        self.state = new_state
        self.last_write_outcome = "success"
        file_name = result.get("file", "")
        details = self._details_for(name, result)
        # Stacked edits to the same file replace its staged entry so the
        # draft UI shows the cumulative result, not intermediate states.
        self.pending_edits = [
            e for e in self.pending_edits if e["file"] != file_name
        ]
        self.pending_edits.append(details)
        self._last_file = file_name
        self.committed_ops.append(
            {"name": name, "op": result.get("op", name),
             "raw_op": dict(raw_op) if raw_op else {},
             "result": result})

    def revalidate_and_commit(
        self, op: dict, context_files: dict | None,
    ) -> dict:
        """Approve-path re-validation (plan: a manual edit during the
        pending window can invalidate an anchor or create a new error).

        With fresh ``context_files``, rebuild the working state from the
        frontend's latest content, REPLAY this request's previously
        approved ops (they are staged server-side, not yet in the
        editor), then re-apply ``op`` through the full delta gate. Any
        replay or re-application failure returns an error result and
        changes nothing — the decision endpoint reports it as
        ``invalidated`` so the card re-renders honestly.
        """
        name = "config_write" if op.get("op") == "new_file" else "config_edit"
        if not context_files:
            # No refresh info: validate against the current session state.
            new_state, result = self.state.apply(self.baseline, op)
            if result["status"] == "error":
                return result
            self.commit(new_state, name, result, raw_op=op)
            result["details"] = self._details_for(name, result)
            return result

        try:
            replay = ProjectState.from_context_files(context_files)
        except Exception as exc:  # malformed refresh payload
            return {"status": "error", "error": f"Invalid context refresh: {exc}"}
        replay_baseline = replay.validate()
        for prior in self.committed_ops:
            replay, prior_result = replay.apply(replay_baseline, prior["raw_op"])
            if prior_result["status"] == "error":
                return {
                    "status": "error",
                    "error": (
                        "config changed since this proposal — an earlier "
                        "approved edit no longer applies "
                        f"({prior_result.get('error', 'anchor lost')})"
                    ),
                    "newErrors": prior_result.get("newErrors", []),
                }
        new_state, result = replay.apply(replay_baseline, op)
        if result["status"] == "error":
            result.setdefault("error", "config changed since this proposal")
            return result
        # Success: adopt the refreshed baseline and rebuild the staged set
        # from the FULL committed chain (prior ops replayed above + this
        # one). In gate mode nothing else stages edits, so pending_edits
        # derives purely from committed ops — last edit per file wins,
        # mirroring commit()'s stacking rule.
        chain = self.committed_ops + [{"name": name, "raw_op": dict(op),
                                       "op": result.get("op", name)}]
        self.state = replay
        self.baseline = replay_baseline
        staged: dict[str, dict] = {}
        cur = self.state
        for entry in chain:
            nxt, res = cur.apply_no_gate(entry["raw_op"])
            if res["status"] == "error":  # defensive; replayed above
                continue
            cur = nxt
            staged[res.get("file", "")] = {
                "file": res.get("file", ""),
                "op": res.get("op", entry["op"]),
                "summary": res.get("summary", ""),
                "newText": cur.files.get(res.get("file", ""), ""),
                "advisories": res.get("advisories", []),
                "diff": res.get("diff"),
            }
        self.state = cur
        self.committed_ops = chain
        self.pending_edits = list(staged.values())
        self._last_file = result.get("file", "")
        self.last_write_outcome = "success"
        result["details"] = staged.get(result.get("file", ""),
                                       self._details_for(name, result))
        return result

    def _details_for(self, name: str, result: dict) -> dict:
        return {
            "file": result.get("file", ""),
            "op": result.get("op", name),
            "summary": result.get("summary", ""),
            "newText": self.state.files.get(result.get("file", ""), ""),
            "advisories": result.get("advisories", []),
            "diff": result.get("diff"),
        }

    def pending_edits_payload(self) -> list[dict]:
        """Client-facing staged edits (the UI consumes these; diffs stay
        out of chat tool-call records to keep responses lean)."""
        return [
            {k: e.get(k) for k in ("file", "op", "summary", "newText", "advisories")}
            for e in self.pending_edits
        ]

    def has_inert_draft(self, blocks: list[str]) -> bool:
        """True when a ```cfg block contains config substance that is NOT
        yet in the working state — the inert-draft shape the prose nudge
        exists to correct.

        Purely structural (intent law): every non-comment line of the
        block is matched against the stripped lines of ALL project files,
        including changes committed THIS request (execute/commit advance
        self.state). After an approved write, models habitually re-quote
        the staged section in a ```cfg block to SHOW it (live native-mode
        traces 2026-09-17: post-approve nudge gaslit gemma into "which
        parameter would you like to change?" right after it staged the
        only parameter). A block that only re-quotes current project text
        is a display echo, not an inert draft. A block with even one line
        absent from the project (new param, new value, mini-diff '+'
        line) is still a draft and still gets nudged — the r5 multi-part
        give-up protection is preserved. Comment lines ('#' — including
        the '# file:' hint) carry no config substance and are ignored;
        '*[section]' delete markers never match project text, so delete
        drafts keep nudging.
        """
        project_lines: set[str] = set()
        for text in self.state.files.values():
            for line in text.splitlines():
                stripped = line.strip()
                if stripped:
                    project_lines.add(stripped)
        for block in blocks:
            for raw in block.splitlines():
                stripped = raw.strip()
                if not stripped:
                    continue
                if stripped.startswith("#"):
                    # A comment line is a draft in exactly one shape: it
                    # is NOT in the project but its comment-stripped body
                    # IS -- i.e. "comment this line out" rendered as
                    # prose (live r4b TRIDENT-04: the model drafted
                    # '#[include sensorless.cfg]' and the old skip-all-
                    # '#' rule called it an echo, shipping an inert
                    # draft with no nudge). A '# file:' hint or a genuine
                    # project comment matches neither leg and stays
                    # skipped.
                    if stripped in project_lines:
                        continue
                    body = stripped.lstrip("#").strip()
                    if body and body in project_lines:
                        return True
                    continue
                if stripped.startswith("+"):
                    # Mini-diff '+' line: the NEW value — echo iff the
                    # post-'+' content is in the project (staged).
                    if stripped[1:].strip() not in project_lines:
                        return True
                elif stripped.startswith("-"):
                    # Mini-diff '-' line: the OLD value. Absent from the
                    # project = display of an applied change (the old line
                    # is gone) -> echo. Still present = deletion was never
                    # applied -> inert draft.
                    if stripped[1:].strip() in project_lines:
                        return True
                elif stripped not in project_lines:
                    return True
        return False


# ── Approval gate (Phase 2) ────────────────────────────────────────────
#
# Plan law: the gate NEVER approves-routes on failure — a call with new
# validation errors kicks back immediately (Phase 1 behavior), no card
# exists. Only a validated write suspends. Implementation is in-request
# (plan §97): the chat request stays open, the decision POST resolves an
# asyncio.Future, timeout auto-declines with an honest reason. No parked
# state, no serialized replay.

import asyncio
import os as _os
import uuid as _uuid

APPROVAL_TIMEOUT_SECONDS = float(_os.environ.get("KWC_EDIT_APPROVAL_TIMEOUT", "90"))

# approvalId -> ApprovalRequest. One pending approval per chat request at
# a time is enforced by the CALLER (chat_proxy serializes cards), not here
# — the registry is a dumb mailbox so the decision endpoint can stay
# stateless w.r.t. sessions.
_pending_approvals: dict[str, "ApprovalRequest"] = {}


class ApprovalRequest:
    """One suspended validated write awaiting the user's decision.

    Lives for the lifetime of the chat request that created it (in-request
    suspension, plan §97): the loop awaits :meth:`wait_or_stop`; the
    decision endpoint calls :meth:`decide`, which re-validates an approve
    against the frontend's latest files BEFORE committing and resolving
    the future. A declined/invalidated op is never committed.
    """

    def __init__(self, name: str, op: dict, result: dict,
                 session: "EditSession", request_id: str | None) -> None:
        self.approval_id = _uuid.uuid4().hex
        self.name = name
        self.op = op
        self.result = result        # prepared result (validated at prepare)
        self.session = session
        self.request_id = request_id
        self.resolved = False       # guards double-decision (double-click)
        # The loop running the chat request that owns this suspension.
        # Decisions may arrive on a DIFFERENT loop (TestClient per-request
        # portals; anything multi-loop), so set_result must be scheduled
        # threadsafe onto the owning loop — a cross-loop set_result never
        # wakes the waiter.
        self.loop = asyncio.get_running_loop()
        self.future: asyncio.Future = self.loop.create_future()
        self.created_at = asyncio.get_running_loop().time()

    def _settle(self, payload: dict) -> None:
        if not self.future.done():
            self.future.set_result(payload)

    def card_payload(self) -> dict:
        """What the frontend polls and renders as the approval card.
        ``timeoutSeconds`` is SECONDS REMAINING (backend clock is the
        single source of truth; the frontend countdown just displays it)."""
        elapsed = self.loop.time() - self.created_at
        return {
            "approvalId": self.approval_id,
            "file": self.result.get("file", ""),
            "op": self.result.get("op", self.name),
            "summary": self.result.get("summary", ""),
            "diff": self.result.get("diff"),
            "advisories": self.result.get("advisories", []),
            "timeoutSeconds": max(0.0, round(APPROVAL_TIMEOUT_SECONDS - elapsed, 1)),
        }

    def decide(self, decision: str, reason: str = "",
               context_files: dict | None = None) -> dict:
        """Resolve from the decision endpoint.

        Returns an endpoint-facing dict: ``{'status': 'ok'}`` when the
        decision was recorded (and, for approve, committed), or
        ``{'status': 'already_decided'|'not_found'}``, or
        ``{'status': 'invalidated', ...}`` when an approve could not be
        re-applied cleanly to the latest state — the card re-renders and
        the user can still decline.
        """
        if self.resolved:
            return {"status": "already_decided"}
        if decision == "approve":
            outcome = self.session.revalidate_and_commit(self.op, context_files)
            if outcome["status"] != "applied":
                # Decision NOT accepted (plan): config moved under the
                # card. Loop keeps waiting; the card shows the reason.
                return {
                    "status": "invalidated",
                    "reason": outcome.get("error", "config changed since this proposal"),
                    "newErrors": outcome.get("newErrors", []),
                }
            self.resolved = True
            payload = {"decision": "approved",
                       "summary": outcome.get("summary", self.result.get("summary", "")),
                       "details": outcome["details"], "reason": ""}
        else:
            self.resolved = True
            payload = {"decision": "declined", "reason": reason}
        try:
            self.loop.call_soon_threadsafe(self._settle, payload)
        except RuntimeError:
            # Owning loop already gone (chat request aborted/closed):
            # nothing left to wake; the suspension dies with the request.
            pass
        return {"status": "ok"}

    async def wait_or_stop(self, timeout: float,
                           stop_event: "asyncio.Event | None") -> dict:
        """Await the decision; auto-decline honestly on timeout, and wake
        promptly when the user aborts the chat request.

        Poll-based by deliberate choice: ``asyncio.wait`` over a shielded
        future + stop task was proven NOT to resume in the real request
        context (TestClient anyio-portal repro, 2026-09-14) while plain
        polling on the owning loop resumed correctly. A 50ms tick over a
        <=90s window is negligible load and immune to shield/wait quirks.
        """
        import time as _time

        end = _time.monotonic() + timeout
        while True:
            if self.future.done():
                return self.future.result()
            if stop_event is not None and stop_event.is_set():
                return {"decision": "declined",
                        "reason": "user cancelled the request"}
            remaining = end - _time.monotonic()
            if remaining <= 0:
                # Final re-check: a decision landing between the last
                # poll and timeout expiry already COMMITTED — it must
                # win, or the commit orphans (loop says 'timeout',
                # state says 'approved').
                if self.future.done():
                    return self.future.result()
                return {"decision": "timeout", "reason": ""}
            await asyncio.sleep(min(0.05, remaining))


def create_approval(name: str, op: dict, result: dict,
                    session: "EditSession",
                    request_id: str | None = None) -> ApprovalRequest:
    req = ApprovalRequest(name, op, result, session, request_id)
    _pending_approvals[req.approval_id] = req
    return req


def get_approval(approval_id: str) -> ApprovalRequest | None:
    return _pending_approvals.get(approval_id)


def find_approval_for_request(request_id: str) -> ApprovalRequest | None:
    for ar in _pending_approvals.values():
        if ar.request_id == request_id and not ar.resolved:
            return ar
    return None


def remove_approval(approval_id: str) -> None:
    _pending_approvals.pop(approval_id, None)


def format_approval_result(name: str, decision: dict) -> tuple[str, dict | None]:
    """Lean model-facing tool result for a resolved approval.

    Returns (content, edit_details-or-None). edit_details is set ONLY on
    approval (the staged-edit stack must not carry an unapproved change).
    """
    kind = decision.get("decision")
    if kind == "approved":
        return (
            f"{name} applied — {decision.get('summary', '')}\n"
            "The user APPROVED this change. It is staged for their review "
            "(not saved until they use the save menu).",
            decision.get("details"),
        )
    if kind == "timeout":
        return (
            f"{name} DECLINED — the user did not respond within "
            f"{int(APPROVAL_TIMEOUT_SECONDS)} seconds. Do not silently "
            "retry the same change; ask the user what they would like.",
            None,
        )
    reason = decision.get("reason") or "no reason given"
    return (
        f"{name} DECLINED by the user ({reason}). Do not silently retry "
        "the same change. Ask the user how they would like to proceed.",
        None,
    )


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
