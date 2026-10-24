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

The write tools are the ONLY edit path (product behavior since the
Phase-6 flag removal, 2026-09-24): a request is edit-capable whenever an
EditSession arms (contextFiles or the user-config mirror seed), and the
harness ``editTools=False`` override is the only way to run read-only.
"""
from __future__ import annotations

import difflib
import json
import re
from collections import OrderedDict

from services.ai_draft_project import ProjectState


_TRAILING_COMMENT_RE = re.compile(r"\s+#.*$")


def _echo_norm(line: str) -> str:
    """Normalize one stripped line for DISPLAY-ECHO matching only.

    Cosmetic formatting differences between a project line and the same
    line re-quoted by a model ('a: 1  # tag' shown as 'a: 1', single vs
    doubled space after ':') must not turn a recap into an inert draft.
    Used ONLY by has_inert_draft(); nothing structural (state, diffs,
    validation) ever sees normalized text.
    """
    line = _TRAILING_COMMENT_RE.sub("", line)
    return re.sub(r"\s+", " ", line).strip()

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
patch any exact lines in a named section (config params OR macro gcode): {"name": "config_edit", "arguments": {"file": "<file.cfg>", "op": "patch_section", "section": "<section or gcode_macro NAME>", "old_text": "<line copied verbatim>", "new_text": "<replacement>"}} — new_text REPLACES old_text: repeat the anchor lines inside new_text when adding lines; comment out a line: new_text = '# ' + the line; uncomment a line: old_text = the '#'-prefixed line, new_text = without the '#'
comment out or restore a WHOLE section (header + body): {"name": "config_edit", "arguments": {"file": "<file.cfg>", "op": "comment_section", "section": "<section>"}} / {"op": "uncomment_section", "section": "<section>"}
rename a section or macro: {"name": "config_edit", "arguments": {"file": "<file.cfg>", "op": "rename_section", "section": "<current header>", "new_section": "<new header>"}} — the body is kept exactly; never rename by delete_section + add_section
move a section into another file: {"name": "config_edit", "arguments": {"file": "<file.cfg>", "op": "move_section", "section": "<section>", "to_file": "<target.cfg>"}} — the body is carried exactly and removed from the source in the same op; to_file is created if new; never move by delete_section + add_section
delete a whole file: {"name": "config_edit", "arguments": {"file": "<file.cfg>", "op": "delete_file"}} — remove its [include] line first if it has one
include a file: {"name": "config_edit", "arguments": {"file": "<file.cfg>", "op": "add_include", "target_file": "new.cfg"}}
remove or comment out an include: {"name": "config_edit", "arguments": {"file": "<file.cfg>", "op": "comment_include", "target_file": "<path as written in the include line>"}} — comment_include keeps the line as '#[include ...]', remove_include deletes it; these ops work on ANY include line, including ones at the top of a file outside any section
create a NEW file only: {"name": "config_write", "arguments": {"file": "new.cfg", "content": "<full file text>"}}
batch many changes to one file in ONE call: {"name": "config_edit", "arguments": {"file": "<file.cfg>", "ops": [{"op": "set_param", "section": "<section>", "key": "<param>", "value": "<new value>"}, {"op": "add_section", "section": "<name>", "text": "<body>"}]}} — applied in order; if one entry fails the others still apply and the result names the failed index
set_param value must be ONE LINE — multi-line values (e.g. gcode:) are dropped by some tool-call channels and must go through replace_section or patch_section."""

EDIT_NUDGE_TEXT_NATIVE = """Call the tool NOW using your tool-calling interface (do not read \
files again first -- the section text you need is already in this \
conversation), or -- if the change is not safe or not possible -- explain \
why to the user and ask.
Argument shapes for the edit tools:
set_param: {"file": "<file.cfg>", "op": "set_param", "section": "<section>", "key": "<param>", "value": "<new value>"}
value must be ONE LINE; for multi-line params (gcode:) use replace_section
patch any exact lines in a named section (config params OR macro gcode): {"file": "<file.cfg>", "op": "patch_section", "section": "<section or gcode_macro NAME>", "old_text": "<line copied verbatim>", "new_text": "<replacement>"} — new_text REPLACES old_text: repeat the anchor lines inside new_text when adding lines; comment out a line: new_text = '# ' + the line; uncomment a line: old_text = the '#'-prefixed line, new_text = without the '#'
comment out or restore a WHOLE section (header + body): {"file": "<file.cfg>", "op": "comment_section", "section": "<section>"} / {"op": "uncomment_section", "section": "<section>"}
rename a section or macro: {"file": "<file.cfg>", "op": "rename_section", "section": "<current header>", "new_section": "<new header>"} — the body is kept exactly; never rename by delete_section + add_section
move a section into another file: {"file": "<file.cfg>", "op": "move_section", "section": "<section>", "to_file": "<target.cfg>"} — the body is carried exactly and removed from the source in the same op; to_file is created if new; never move by delete_section + add_section
delete a whole file: {"file": "<file.cfg>", "op": "delete_file"} — remove its [include] line first if it has one
include a file: {"file": "<file.cfg>", "op": "add_include", "target_file": "<new.cfg>"}
remove or comment out an include: {"file": "<file.cfg>", "op": "comment_include", "target_file": "<path as written in the include line>"} — comment_include keeps the line as '#[include ...]', remove_include deletes it; these ops work on ANY include line, including ones at the top of a file outside any section
create a NEW file only: {"file": "<new.cfg>", "content": "<full file text>"}
batch many changes to one file in ONE call: {"file": "<file.cfg>", "ops": [{"op": "set_param", "section": "<section>", "key": "<param>", "value": "<new value>"}, {"op": "add_section", "section": "<name>", "text": "<body>"}]} — applied in order; if one entry fails the others still apply and the result names the failed index"""

EDIT_TOOL_NAMES = frozenset({"config_edit", "config_write"})


def parse_maybe_stringified(value):
    """Zed's `deserialize_maybe_stringified` pattern: small models emit
    array-typed tool args as a JSON STRING — ``"ops": "[{\\"op\\": ...}]"``.
    One relaxed parse attempt when a bracket-looking string arrives;
    anything that is not a JSON list passes through UNCHANGED (fail-open:
    a weird string in a value field stays a value). Applied at the single
    chokepoint every protocol's arguments funnel through
    (:meth:`EditSession.tool_call_to_op`), so the native and text paths
    get the recovery identically and cannot drift.
    """
    if isinstance(value, str):
        candidate = value.strip()
        if candidate.startswith("["):
            try:
                parsed = json.loads(candidate, strict=False)
            except (json.JSONDecodeError, ValueError):
                return value
            if isinstance(parsed, list):
                return parsed
    return value

CONFIG_EDIT_SPEC = {
    "name": "config_edit",
    "description": (
        "Apply one mechanical edit operation to the user's config project. "
        "The change is validated against the live project and either staged "
        "for the user's review or rejected with exact validation errors. "
        "One operation per call; call again for more edits. Ops: set_param "
        "(upsert key=value in a section), add_section (new section with "
        "text body), replace_section (rewrite a section's body), "
        "delete_section, rename_section (rename a section header, e.g. a "
        "macro — the body is kept exactly; needs new_section), "
        "move_section (move a section into another file, creating it if "
        "needed — the body is carried exactly and removed from the source "
        "in the same op; needs to_file; never move by delete+add), "
        "patch_section (replace old_text with new_text "
        "inside ANY named section — config params or macro gcode alike; "
        "quote lines exactly as read returned them), "
        "comment_section (disable a whole section: '#' the [header] line "
        "AND its body in one op), uncomment_section (restore a "
        "commented-out section written as '#[header]' + '#'-prefixed "
        "body), "
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
                    "delete_section", "move_section", "rename_section",
                    "patch_section",
                    "comment_section", "uncomment_section",
                    "delete_file",
                    "add_include", "remove_include", "comment_include",
                ],
                "description": ("The operation to apply (single-op call). "
                                "Omit it when passing an ops[] batch."),
            },
            "section": {
                "type": "string",
                "description": "Section header for section ops, e.g. 'bed_mesh' or 'gcode_macro PRINT_START' (brackets optional). A bare macro name like 'PRINT_START' also works when unique in the file.",
            },
            "new_section": {
                "type": "string",
                "description": "New section header for rename_section (brackets optional), e.g. 'gcode_macro BED_MESH_CALIBRATE'",
            },
            "to_file": {
                "type": "string",
                "description": (
                    "Destination file for move_section, e.g. 'fans.cfg' — "
                    "created if it does not exist (then needs an [include]). "
                    "The section body is carried exactly and removed from "
                    "file in the same op; never move by delete+add."
                ),
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
                    "replace_section or patch_section instead"
                ),
            },
            "text": {
                "type": "string",
                "description": (
                    "Section body text (add_section / replace_section) — "
                    "body only, no [header] line. For replace_section this "
                    "REPLACES THE ENTIRE BODY: include every parameter you "
                    "want to keep (the result warns if keys disappear)"
                ),
            },
            "old_text": {
                "type": "string",
                "description": "Exact lines to replace (patch_section) — copy verbatim from the file content you read",
            },
            "new_text": {
                "type": "string",
                "description": (
                    "Replacement lines (patch_section); empty string deletes "
                    "the matched lines. new_text REPLACES old_text "
                    "entirely: to ADD lines while keeping the quoted "
                    "anchor, repeat the anchor lines inside new_text"
                ),
            },
            "target_file": {
                "type": "string",
                "description": ("File to include/un-include/comment-out "
                                "(add_include / remove_include / comment_include)"),
            },
            "ops": {
                "type": "array",
                "description": (
                    "Batch: list of operation objects, applied SEQUENTIALLY "
                    "in ONE call — each op sees the state the previous one "
                    "left. Each entry uses the same fields as a single-op "
                    "call: {\"op\": ..., \"section\": ..., \"key\": ..., "
                    "\"value\": ..., \"text\": ..., \"old_text\": ..., "
                    "\"new_text\": ..., \"new_section\": ..., "
                    "\"to_file\": ..., \"target_file\": ...} (file applies "
                    "to every entry). "
                    "When changing multiple separate locations in one file, "
                    "use ONE call with multiple entries in ops[] instead of "
                    "multiple calls. If one op fails the rest still apply; "
                    "the result lists failed ops by index. NEVER abbreviate "
                    "or elide body content in text/new_text — send it "
                    "complete or use a narrower op."
                ),
            },
        },
        # 'op' XOR 'ops' is validated at runtime (one clear kickback names
        # the shape) instead of required[]: JSON Schema can't express the
        # XOR portably, and required=['file','op'] would reject a valid
        # ops-only batch on strict providers.
        "required": ["file"],
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
  anchors, keys, and current values are exact. Batch the reads:
  sections=['a','b'] fetches several sections and files=['a.cfg','b.cfg']
  several whole files in ONE call. For "every reference"/rename jobs,
  search_user_configs returns a per-file REFERENCES checklist (section +
  line per occurrence) — work through the list, then re-search until the
  counts read 0.
- NEVER ask the user which file to edit or wait for confirmation of the
  target — the answer is discoverable with tools. Call list_user_configs
  to see the project's files and search_user_configs to find where a
  section or macro lives, then edit that file. When the request gives no
  file and discovery shows no clearer home, edit printer.cfg; for a brand
  new section with no existing home, add it to printer.cfg.
- Staging is the DEFAULT action, not the question. Your change lands on
  an approve card where the user confirms or declines it — that card IS
  the confirmation, so stage first; NEVER replace a possible edit with
  "would you like me to..." or "tell me the filename and I will...".
- When an existing section has more logic than the user's request
  mentions, preserve it: edit in place with set_param or patch_section
  instead of refusing or replacing the whole section.
- When the user QUOTES a section or macro in their message, that quote is
  the target — it is NOT always something to hunt for in their files. If
  discovery shows it does not exist yet, the request is still answerable:
  fix or complete the quoted text in your reply (display ```cfg block),
  and stage it with config_edit only when the user clearly asked to add or
  save it (then add it to printer.cfg). Never reply "not found in your
  config" to a fix-this request, and never ask where it should live.
- When changing multiple separate locations in one file, use ONE call
  with multiple entries in ops[] instead of multiple calls:
  {"file": "printer.cfg", "ops": [{"op": "set_param", "section": "...",
  "key": "...", "value": "..."}, {"op": "add_section", ...}]}. Ops apply
  in order; if one entry fails the others still apply and the result
  names the failed index — fix ONLY the failed entries and re-send them.
  NEVER abbreviate or elide body content in text/new_text — send it
  complete or use a narrower op. A single change stays a single-op call.
- When config_edit returns validation errors, read them, adjust, and
  retry with a CORRECTED change — never repeat the same failed call. On a
  patch_section anchor miss the result includes the section's current text;
  quote lines exactly as they appear there.
- To MOVE a section into another file, use ONE op per section:
  {"file": "printer.cfg", "op": "move_section", "section": "fan_generic Aux_Fan",
  "to_file": "fans.cfg"}. The server carries the body across and removes it
  from the source in the SAME op — never move by delete_section + add_section,
  which makes you retype the body (comments and commented-out blocks get
  dropped) and can leave a duplicate section, which Klipper refuses to load.
  to_file is created if it does not exist and then needs an [include]
  (add_include in a follow-up op, or in the same ops[] batch). Several
  sections = one move_section entry per section.
- Warnings returned as advisories do not block the change; mention them
  to the user when relevant. EXCEPTION: gcode the command registry flags
  as unknown comes back UNSTAGED the first time — fix the command (the
  finding names it and may suggest the right one), or re-send the call
  unchanged only if you are sure it comes from a plugin or custom module.
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
        # Rename-ordering directive (COMMENT-06 gemma r2 trace
        # 2026-09-28): renaming a macro onto a stock command name while
        # its 'rename_existing' line sits COMMENTED OUT trips the shadow
        # gate; the validator's 'add rename_existing' advice reads as
        # 'the task is impossible' to a model that sees '#rename_existing'
        # in the body — it never connects the commented line to the fix.
        # Name the exact recovery so the kickback teaches the ORDER:
        # uncomment first, then rename. (Edit-loop text only — the
        # validator's general finding stays Klipper-neutral.)
        if any(err.get("code") == "rename_existing_invalid"
               for err in new_errors):
            lines.append(
                "NOTE: if this macro already has a '#'-commented "
                "'#rename_existing:' line, uncommenting it FIRST (via "
                "patch_section: the '#'-prefixed line as old_text, the "
                "line without '#' as new_text) makes the rename pass "
                "validation — do the uncomment, then retry the rename "
                "unchanged."
            )
    if result.get("sectionText"):
        lines.append("")
        lines.append("Current section text (quote from this verbatim):")
        lines.append(f"---\n{result['sectionText']}\n---")
    return "\n".join(lines)


def _ops_result_content(name: str, results: list[dict]) -> str:
    """Model-facing batch result: applied/failed counts + per-index
    lean errors (Zed shape: 'edit at index N did not match'). Applied
    ops STAY committed — partial progress is real progress (plan law)."""
    n = len(results)
    applied = [r for r in results if r.get('ok')]
    failed = [r for r in results if not r.get('ok')]
    head = (f"{name} applied {len(applied)} of {n} ops — "
            f"{'all ops committed' if not failed else 'applied ops are committed; failed ops are not'}")
    head += "\nChanges are STAGED for the user's review (not saved)."
    # R1 context economy: a clean 26-edit batch stays lean — only ops the
    # model had to FIX (failed-then-retried) carry their realized diff,
    # so a swallowed line shows exactly where a retry already happened
    # (the engine tags those entries' 'diff'; see _batch_engine).
    for r in applied:
        block = _realized_change_block(r.get("op", ""), r.get("diff"))
        if block:
            head += (f"\nRealized for op[{r.get('idx', '?')}] "
                     f"{r.get('op', '')}"
                     + (f" [{r.get('section')}]" if r.get('section') else "")
                     + " (an op of this kind failed earlier this request):"
                     + block)
    if failed:
        head += "\nFailed ops (fix ONLY these and re-send them):"
        # BULK-05 bank autopsies (2026-10-24): a 26-op sweep where every
        # op hit the same error rendered the identical sentence 26x
        # (~2.6KB per call, and every failed op charges the waste
        # budget while the text floods the context). Identical
        # (op, section, error) failures collapse into one line naming
        # the index range; distinct failures keep their own lines.
        def _where(r: dict) -> str:
            return (f" {r.get('op', '')}"
                    + (f" [{r.get('section')}]" if r.get('section') else ""))
        groups: list[tuple[list[int], dict]] = []
        for r in failed:
            key = (r.get('op', ''), r.get('section') or '',
                   r.get('error', 'failed'))
            if groups and (groups[-1][1].get('op', ''),
                           groups[-1][1].get('section') or '',
                           groups[-1][1].get('error', 'failed')) == key:
                groups[-1][0].append(r.get('idx', 0))
            else:
                groups.append(([r.get('idx', 0)], r))
        for idxs, r in groups[:10]:
            if len(idxs) == 1:
                span = f"op[{idxs[0]}]"
            else:
                span = f"op[{idxs[0]}-{idxs[-1]}]"
            head += (f"\n- {span}{_where(r)}: {r.get('error', 'failed')}"
                     + (f" ({len(idxs)} ops)" if len(idxs) > 1 else ""))
    return head


def _advisory_lines(advisories: list) -> str:
    """Render the model-facing advisory block (' with N advisories' + one
    line each). Shared by BOTH write paths so the approval gate and the
    auto-approve arm cannot drift (2026-09-30: the gate showed none)."""
    text = f" with {len(advisories)} advisory" + ("s" if len(advisories) != 1 else "")
    for adv in advisories[:6]:
        where = f"[{adv.get('section', '')}] {adv.get('param', '')}".rstrip()
        text += (f"\n- advisory ({adv.get('severity', 'warning')}) {where}: "
                 f"{adv.get('message', '')}")
    return text


def _lean_success_content(name: str, result: dict) -> str:
    status = result.get("status", "applied")
    head = f"{name} applied — {result.get('summary', '')}"
    # R1: the summary is what the model ASKED for; the realized block is
    # what the engine DID. Eaten comment blocks and absorbed blanks hide
    # here (recognition gap) — show the diff, not the intent.
    head += _realized_change_block(result.get("op", ""), result.get("diff"))
    advisories = result.get("advisories") or []
    runtime = _runtime_section_directive(result)
    if status == "applied_with_advisory" and advisories:
        head += _advisory_lines(advisories)
        if not runtime:
            # Only while nothing in this result is runtime-blocking: next to
            # a WILL-FAIL advisory the neutral phrasing reads as "ignore me"
            # (live report 2026-09-29).
            head += "\nAdvisories do not block the staged change."
    head += "\nChange is STAGED for the user's review (not saved)."
    if runtime:
        head += "\n\n" + runtime
    stale = _stale_callers_directive(result, advisories)
    if stale:
        head += "\n\n" + stale
    incl = _include_needed_directive(result)
    if incl:
        head += "\n\n" + incl
    return head


# Advisory codes that mean the staged artifact CANNOT RUN as written.
_RUNTIME_BLOCKING_ADVISORY_CODES = frozenset({"gcode_command_section_missing"})


def _runtime_section_directive(result: dict, *, approved: bool = False) -> str:
    """Strong directive when a staged change will fail at runtime.

    Live report 2026-09-29: asked for "a macro that homes, travels in a
    100mm circle three times, then homes again", the model staged a G2/G3
    macro, received `gcode_command_section_missing` ("needs a [gcode_arcs]
    section — it will error at runtime without one"), and confidently
    ignored it — the user got a macro that cannot run and no mention of the
    missing section. The advisory alone ("do not block the change") reads
    as cosmetic; when the user's OWN request produced the dependency, adding
    the section is part of finishing the job, exactly like the stale-caller
    follow-up after a rename (2026-09-27).

    Conditional by design: other advisory classes keep the neutral tail, so
    the escalation never inflates a genuinely cosmetic warning.

    ``approved`` selects the post-approval tail (2026-09-30): on the
    product path this directive is appended AFTER the human accepted the
    edit, where "do not ask permission first — the approval card already
    gates the write" describes a step that already happened. The rest of
    the text is identical — the follow-up edit is equally mandatory either
    way.
    """
    advisories = result.get("advisories") or []
    blocking = [a for a in advisories
                if str(a.get("code", "")) in _RUNTIME_BLOCKING_ADVISORY_CODES]
    if not blocking:
        return ""
    where = list(dict.fromkeys(
        str(a.get("section", "")).strip() for a in blocking
        if str(a.get("section", "")).strip()))[:6]
    scope = f" (used in {', '.join(f'[{s}]' for s in where)})" if where else ""
    if approved:
        # Post-approval (2026-09-30): the card was ALREADY accepted, so
        # "do not ask permission first" described a finished step. Says
        # the permission fact without re-ordering what the text above
        # already ordered.
        tail = (
            "The edit above is already approved; the fix still needs its "
            "own staged config_edit call — do not leave the macro broken."
        )
    else:
        tail = (
            "Do not ask permission first — the approval card already gates "
            "the write — and do not leave the macro broken."
        )
    return (
        f"RUNTIME FAILURE{scope}: the advisories above are NOT cosmetic — "
        "the staged gcode calls a command that this configuration does not "
        "provide as written, so it WILL error as soon as the macro runs. "
        "This change is NOT finished. Resolve it now, in THIS request: "
        "stage whatever the advisory asks for with another config_edit call "
        "— add the missing section (an empty body is valid where Klipper "
        "defines defaults, e.g. [gcode_arcs] or [firmware_retraction]), "
        "and/or set the option it names (e.g. enable_force_move: true) — "
        "then tell the user both edits are staged. " + tail
    )


def _stale_callers_directive(result: dict, advisories: list) -> str:
    """Directive appended after a gcode_macro rename: the old command's
    callers are now STALE advisories.

    Live report 2026-09-27: after renaming Level_Bed, the model saw the
    unknown_gcode advisories, explained them to the user, and ASKED
    whether to update the callers — instead of just doing the obviously
    implied follow-up edits. When the user already asked for a rename,
    updating its callers is part of completing the rename, not a new
    decision. Names the stale sections and orders the fix in the same
    request.
    """
    renamed_from = str(result.get("renamed_from", ""))
    renamed_to = str(result.get("renamed_to", ""))
    if not renamed_from or " " not in renamed_from or not renamed_to:
        return ""  # not a class-header rename
    old_name = renamed_from.split(" ", 1)[1].strip()
    if not old_name:
        return ""
    stale_sections = [
        str(a.get("section", "")) for a in advisories
        if a.get("code") == "unknown_gcode_command"
        and f"'{old_name}'".casefold() in str(a.get("message", "")).casefold()
        and str(a.get("section", "")).strip().casefold() != renamed_from.casefold()
    ]
    if not stale_sections:
        return ""
    where = ", ".join(f"[{s}]" for s in list(dict.fromkeys(stale_sections))[:6])
    return (
        f"STALE CALLERS: '{old_name}' no longer exists — still called in "
        f"{where}. The user asked for the rename, so updating its callers "
        f"is part of the SAME job: fix each call with a patch_section op "
        f"(old_text quoting the call line, new_text using '{renamed_to.split(' ', 1)[1]}') "
        f"NOW, in this request. Do not ask the user whether to update "
        f"them; do not stop here."
    )


def _include_needed_directive(result: dict) -> str:
    """Directive appended after a successful config_write of a file that
    nothing includes.

    Live report 2026-10-12 (Sir): models create a new .cfg, never add the
    [include] line, and tell the user the file is live — but Klipper only
    reads files an [include] pulls into the tree, and the validator does
    NOT flag orphan files (same blind spot as dangling includes). The
    tool DESCRIPTION already says "add an [include <file>] with
    op=add_include" and demonstrably doesn't get followed; tool RESULTS
    move local models far more. Set by _op_new_file as a structured field
    (UI summaries stay clean); rendered only in the model-facing content
    paths, like the rename stale-caller directive above.
    """
    fname = str(result.get("needs_include", ""))
    if not fname:
        return ""
    return (
        f"NOT INCLUDED: '{fname}' will NOT load — no [include] line anywhere "
        "pulls it into the config tree, and Klipper ignores files it never "
        "includes. This change is NOT finished. Unless the user explicitly "
        "asked for the file to stay inactive, add the include NOW, in this "
        "request, without asking first: config_edit "
        f'{{"file": "printer.cfg", "op": "add_include", "target_file": "{fname}"}} '
        "(the user's named parent file instead of printer.cfg if different). "
        "If the file is meant to stay inactive, skip the include and say so "
        "in your reply."
    )


# ── per-request THRASH budget (large-edit rework, 2026-10-16) ─────────
# The old flat write cap charged WORK: every write attempt cost one unit,
# so a legitimate 62-section request was arithmetically impossible in one
# prompt and the "WRITE LIMIT REACHED ... no further write calls will be"
# directive MANUFACTURED the prose-fallback symptom (it taught the model to
# give up — the Hermes early-abandonment lesson). The semantics are now
# inverted: the budget charges WASTE, never work.
#
# Charged (`thrash_units`):
#   - each FAILED write attempt (+1)
#   - each read past a grace allowance (`READ_GRACE`) per request (+1 each)
#   - each malformed-call correction re-prompt (+1)
#   - each empty re-prompt (+1)
# FREE:
#   - each SUCCESSFUL write op — a state change is reviewable work, and the
#     oscillation family that a write cap used to (badly) guard is covered
#     deterministically by _duplicate_of_committed + supersede keys.
#
# `edit_attempts` survives as an INFORMATIONAL counter (successful ops still
# increment it; the response payload, confab guard, and BULK criteria read
# it) but it no longer gates anything.
#
# Hitting the thrash budget is a SOFT landing, never a stop order: the
# directive states facts (what failed, what was over-read) and keeps the
# honesty clauses, but never claims further writes are blocked — pressure
# is invisible until truly spent, and a wrong soft note is a useless hint,
# never a changed path (fail-open).
#
# `KWC_THRASH_BUDGET` overrides the default; 0 (or negative) disables it.
THRASH_BUDGET_DEFAULT = 50
# Reads are cheap for the model's understanding but expensive in context
# growth; the grace allowance covers a normal read->edit->verify loop, and
# only the overflow past it counts as thrash.
READ_GRACE = 10
# Upper bound on ops[] entries per call. Generation-limit insurance for
# small models (a 60-op JSON blob risks max_tokens truncation, and a
# truncated batch is a malformed-call round-trip), NOT a work budget —
# gemma's own BULK-01 run needs 4 calls of ~16 to cover 62 sections.
MAX_OPS_PER_CALL = 32


def thrash_budget() -> int:
    """Waste units allowed per request (<=0 = uncapped)."""
    raw = _os.environ.get("KWC_THRASH_BUDGET", "").strip()
    if not raw:
        return THRASH_BUDGET_DEFAULT
    try:
        return int(raw)
    except ValueError:
        return THRASH_BUDGET_DEFAULT




# ── Change-set display helpers (post-hoc review, 2026-10-02) ───────────
#
# The chat transcript shows ONE ROW PER EDIT, collapsed to `file / section`
# with +N / −N and an advisory badge, unfolding to the op's mini-diff. The
# rows are computed from the op's own before/after text (server truth), so
# a row can never claim something the change set does not contain.
#
# The unfold payload is a compact UNIFIED DIFF, not the before/after pair:
# a multi-edit request would otherwise ship the whole file once per edit.
# The frontend's parsePatch already reads exactly this shape.

CHANGE_SET_DIFF_CONTEXT = 3


def _unified_diff_lines(file_name: str, before: str, after: str):
    return difflib.unified_diff(
        before.splitlines(), after.splitlines(),
        fromfile=file_name, tofile=file_name,
        n=CHANGE_SET_DIFF_CONTEXT, lineterm="")


def diff_counts(before: str, after: str) -> tuple[int, int]:
    """(added, removed) line counts for one op's diff."""
    added = removed = 0
    for line in _unified_diff_lines("", before, after):
        if line.startswith("+++") or line.startswith("---"):
            continue
        if line.startswith("+"):
            added += 1
        elif line.startswith("-"):
            removed += 1
    return added, removed


def diff_text(file_name: str, before: str, after: str) -> str:
    """Compact unified diff for ONE op — what a collapsed row unfolds."""
    return "\n".join(_unified_diff_lines(file_name, before, after))


# ── realized-change reporting (R1, plan 2026-10-18) ─────────────────────
# Success results reported INTENT ("applied — {summary}") while the
# realized per-line truth rode only on the UI details record ("never
# sent to the model", _details_for). Collateral the span semantics
# produce — a swallowed trailing comment block, absorbed blanks, an
# eaten neighbour line — was invisible: recognition gap, not attention
# gap (live reports 2026-10-15). Principle: ops report the REALIZED
# change, not the intended change. Small diffs ride in full (n=1
# context); big ones collapse to counts + the removed lines verbatim,
# because the removed side is exactly where collateral hides.
REALIZED_DIFF_MAX_LINES = 12   # changed lines <= this -> full mini-diff
REALIZED_DIFF_MAX_BYTES = 2048  # appended diff bytes per call (context
                                # economy on 26-edit requests)
_REALIZED_LINE_WIDTH = 80


def _realized_change_block(op_kind: str, diff: dict | None) -> str:
    """Model-facing 'what actually happened' block for a SUCCESSFUL op.

    ``{delete_section, delete_file}`` never dump the whole block: header
    + first/last removed line + count. Anything within
    REALIZED_DIFF_MAX_LINES changed lines shows the mini-diff; larger
    changes collapse to ``+A/−R`` counts + removed lines verbatim,
    truncated to REALIZED_DIFF_MAX_BYTES. Returns '' when there is
    nothing to report (no diff record, or a no-change apply).
    """
    if not isinstance(diff, dict):
        return ""
    before = str(diff.get("before", ""))
    after = str(diff.get("after", ""))
    if before == after:
        return ""
    added, removed = diff_counts(before, after)
    if not (added or removed):
        return ""
    removed_lines = [ln[1:] for ln in _unified_diff_lines("", before, after)
                     if ln.startswith("-") and not ln.startswith("---")]
    if op_kind in ("delete_section", "delete_file"):
        # Small delete: every removed line verbatim (a swallowed
        # trailing comment/blank must be NAMEABLE, not just counted).
        # Large delete: header + boundary lines + count — never re-ship
        # a whole deleted body.
        if removed_lines and len(removed_lines) <= REALIZED_DIFF_MAX_LINES:
            shown = ", ".join(_truncate_realized(q) for q in removed_lines)
        else:
            edges = removed_lines[:1] + removed_lines[-1:]
            shown = ", ".join(_truncate_realized(q) for q in edges)
        return (f"\nRealized: −{removed} removed, +{added} added — "
                f"lines: {shown}")
    if added + removed <= REALIZED_DIFF_MAX_LINES:
        mini = difflib.unified_diff(before.splitlines(), after.splitlines(),
                                    n=1, lineterm="")
        body = "\n".join(mini)
        if body and len(body.encode("utf-8")) <= REALIZED_DIFF_MAX_BYTES:
            return f"\nRealized change:\n---\n{body}\n---"
    # Collapse: the counts plus EVERY removed line the byte budget fits.
    parts: list[str] = []
    used = 0
    for line in removed_lines:
        q = _truncate_realized(line)
        if parts and used + len(q) + 2 > REALIZED_DIFF_MAX_BYTES:
            break
        parts.append(q)
        used += len(q) + 2
    shown = ", ".join(parts) if parts else "(over byte cap)"
    return (f"\nRealized: +{added} added, −{removed} removed — "
            f"removed lines: {shown}")


def _truncate_realized(line: str) -> str:
    line = line if len(line) <= _REALIZED_LINE_WIDTH else \
        line[:_REALIZED_LINE_WIDTH - 1] + "…"
    return f"'{line}'"


def resolve_change_chain(chain, context_files: dict | None = None,
                         update_pushed: bool = True) -> dict:
    """Replay the KEPT ops of a whole CHAIN of requests, oldest first.

    Post-hoc review's single mutation (plan hard rule 4): undo is
    ``replay(kept ops, baseline)``, never a text revert — dropping a rejected
    op therefore cannot leave any of its residue behind, including residue a
    later op built on.

    The change set is a RUNNING TOTAL (Sir, 2026-10-02): sending a second
    message must not discard the first message's unreviewed edits, so one
    decision can cover edits staged by several requests. Each request's ops
    replay onto the state the previous request left, starting from the OLDEST
    request's pre-op baseline — which is what makes dropping an op from
    request 1 also drop request 2's residue that was built on it.

    ``chain`` is ``[(session, kept_ids, request_id), ...]`` in chronological
    order; ``kept_ids`` of None means "keep everything this request staged".

    Base text per file is that oldest baseline unless the client's current
    text no longer matches the last text we pushed for it — that means the
    human edited the file, and their text wins (hard rule 6). Ops whose
    anchors no longer resolve are reported in ``stale`` rather than forced.

    Returns ``{status, files: {name: {content, deleted}}, stale,
    clientEdited}``. The caller feeds ``files`` to the same apply path the
    staged edits use, so keep/undo and stage share one mutation surface.
    """
    entries = [(session, kept_ids, request_id)
               for session, kept_ids, request_id in chain if session is not None]
    if not entries:
        return {"status": "not_found"}

    current: dict[str, str] = {}
    for file_name, meta in (context_files or {}).items():
        content = (meta or {}).get("content", "")
        current[str(file_name)] = content if isinstance(content, str) else ""

    touched: list[str] = []
    owners: dict[str, list] = {}
    created: set[str] = set()
    for session, _kept, _rid in entries:
        for rec in session.edit_records:
            file_name = rec["file"]
            if not file_name:
                continue
            if file_name not in touched:
                touched.append(file_name)
            owners.setdefault(file_name, []).append(session)
            if rec["op"] == "new_file":
                created.add(file_name)

    base_files: dict[str, str] = {}
    client_edited: list[str] = []
    for file_name in touched:
        sessions = owners[file_name]
        first, newest = sessions[0], sessions[-1]
        if file_name in created and file_name not in first.baseline_files:
            # Did not exist before the chain started: the new_file op has
            # to be able to create it, so it is not seeded.
            continue
        cur = current.get(file_name)
        last_pushed = newest.pushed_files.get(file_name)
        if cur is None:
            base_files[file_name] = first.baseline_files.get(file_name, "")
        elif last_pushed is not None and cur == last_pushed:
            base_files[file_name] = first.baseline_files.get(file_name, cur)
        else:
            base_files[file_name] = cur
            client_edited.append(file_name)

    state = ProjectState(files=_replay_files(entries, current, base_files, created))
    stale: list[dict] = []
    kept_ok: set[tuple] = set()
    for session, kept_ids, request_id in entries:
        kept_set = None if kept_ids is None else {str(i) for i in kept_ids}
        for rec in session.edit_records:
            if kept_set is not None and rec["id"] not in kept_set:
                continue
            raw_op = rec.get("_raw_op") or {}
            if not raw_op:
                stale.append({"id": rec["id"], "requestId": request_id or "",
                              "file": rec["file"],
                              "reason": "no replayable operation recorded"})
                continue
            # Fresh delta baseline per op: each op is validated against the
            # state the previous one actually produced.
            new_state, result = state.apply(state.validate(), raw_op)
            if result["status"] == "error":
                stale.append({
                    "id": rec["id"],
                    "requestId": request_id or "",
                    "file": rec["file"],
                    "reason": result.get("error")
                    or "an earlier approved edit no longer applies",
                })
                continue
            state = new_state
            kept_ok.add((id(session), rec["id"]))

    files: dict[str, dict] = {}
    for file_name, text in state.files.items():
        if file_name in touched:
            files[file_name] = {"content": text, "deleted": False}
    for file_name in created:
        kept_creator = any(
            (id(session), rec["id"]) in kept_ok
            for session, _kept, _rid in entries
            for rec in session.edit_records
            if rec["op"] == "new_file" and rec["file"] == file_name)
        if not kept_creator:
            files[file_name] = {"content": "", "deleted": True}

    # Every session in the chain now knows what the client holds for the
    # files it touched, so the next decision's staleness check is honest.
    #
    # NOT for a FRAME pass (`update_pushed=False`): that call is a read-only
    # "what would the file look like without the undecided ops", and letting
    # it write back would tell the next decision the client holds a text it
    # has never seen — silently disabling the hand-edit check (hard rule 6).
    if update_pushed:
        for session, _kept, _rid in entries:
            for file_name in owners_of(session, touched, entries):
                entry = files.get(file_name)
                if entry is None:
                    continue
                if entry["deleted"]:
                    session.pushed_files.pop(file_name, None)
                else:
                    session.pushed_files[file_name] = entry["content"]
    return {"status": "ok", "files": files, "stale": stale,
            "clientEdited": client_edited}


def owners_of(session, touched, entries) -> list[str]:
    """Files this session staged edits to (its own view of the chain)."""
    owned = {rec["file"] for rec in session.edit_records if rec["file"]}
    return [name for name in touched if name in owned]


def _replay_files(entries, current: dict[str, str], base_files: dict[str, str],
                  created: set[str]) -> dict[str, str]:
    """The file set a replay VALIDATES in — the same world the ops were staged in.

    Validation is file-set dependent, and not only in the obvious way: the
    gcode-command passes re-derive cross-file, a ``rename_existing`` anywhere in
    the include closure satisfies a shadow collision everywhere, and the
    project-wide passes only run above one file. Seeding the replay with JUST
    the files the chain touched therefore judged ops in a smaller world than
    the one that accepted them, and a legitimate rename came back "failed
    validation after merging" while its follow-up ops failed on the section the
    rename never created (live report 2026-10-04: "2 changes could not be
    re-applied").

    So: every file the chain's sessions knew about, plus everything the client
    currently holds (its text is the present truth for files this chain does not
    edit), with each touched file at its REPLAY BASE so dropping an op still
    reverts it. Files a request created are left out when the chain's oldest
    baseline did not have them — the ``new_file`` op has to be able to create
    them.
    """
    files: dict[str, str] = {}
    for session, _kept, _rid in entries:
        for name, text in session.baseline_files.items():
            files.setdefault(name, text)
    files.update(current)
    files.update(base_files)
    first_baseline = entries[0][0].baseline_files
    for name in created:
        if name not in first_baseline:
            files.pop(name, None)
    return files


class EditSession:
    """Request-scoped edit session: live state + baseline + staged edits."""

    def __init__(self, context_files: dict[str, dict]) -> None:
        self.state = ProjectState.from_context_files(context_files)
        self.baseline = self.state.validate()
        # Pre-request text per file. This is the hinge of post-hoc review
        # (2026-10-02): undo == replay(kept ops, baseline), so the baseline
        # has to be captured BEFORE the first op lands. Nothing else keeps
        # it (the validation baseline above is findings, not text).
        self.baseline_files: dict[str, str] = dict(self.state.files)
        self.pending_edits: list[dict] = []
        # Chronological record of every op committed this request — the
        # chat transcript rows. A superseded record stays (the transcript
        # is honest history) but is excluded from the summary totals.
        self.edit_records: list[dict] = []
        # Last net text handed to the client per file (live staging). A
        # frontend text that no longer matches this was edited by the
        # human mid-loop, and an undo must replay onto THEIR text rather
        # than clobber it (hard rule 6).
        self.pushed_files: dict[str, str] = {}
        # Ops approved+committed during THIS request (in order), replayed
        # over a refreshed context on later approve re-validations.
        self.committed_ops: list[dict] = []
        self.edit_attempts = 0
        # ── THRASH accounting (2026-10-16, see THRASH_BUDGET_DEFAULT) ──
        # Waste actually spent this request: failed write attempts, reads
        # past READ_GRACE, malformed-correction + empty re-prompts.
        # Successful writes NEVER charge. Reset wholesale by apply_steer.
        self.thrash_units = 0
        # Read executions this request (grace is applied in charge_read();
        # repeat-dead reads never reach the session — REPEAT_READ_FEEDBACK
        # kills them in ai_routes before execution, unchanged).
        self.read_calls = 0
        # Fact source for the over-budget directive (and the Step-4
        # confab guard): per-call write failures, not units.
        self.write_failures = 0
        # R1 batch tagging: targets (op+file+section) that FAILED earlier
        # this request. A batch entry succeeding one of these is a
        # failed-then-retried op — the one batch shape whose realized
        # diff rides (plan: clean batch ops stay lean).
        self._failed_targets: set[tuple] = set()
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
        # Identical FAILED call repeats (TRIDENT-15 r1 2026-09-19: gemma
        # repeated one arg-channel-lost set_param 17x, burning the whole
        # turn budget). The lean kickback says "correct your arguments"
        # but a model stuck in a template loop re-sends the same bytes;
        # the 2nd identical failure escalates to an unmistakable stop-
        # and-change-strategy directive, and the 4th hard-stops (no
        # apply attempt). Key: (name, canonical args) -> failure count.
        self._identical_failures: dict[str, int] = {}
        # Registry-kickback ledger (Sir 2026-09-20): a write whose NEW
        # advisories include unknown_gcode_command is kicked back UNSTAGED
        # ONCE so the model gets a correction round before the user ever
        # sees a card (never route a known-invalid edit to the user).
        # A SECOND identical send passes — that is the model's honest
        # "this command is from a plugin the stock registry cannot see"
        # claim, and the advisory then rides on the card for the user.
        # Key: call key -> kick count. Deliberately NOT in
        # _identical_failures: the kick is not a call failure, and the
        # repetition BLOCK must never veto the plugin resend.
        self._registry_kicks: dict[str, int] = {}
        # Steer epoch (2026-10-02): incremented on every user steer that
        # lands mid-loop. committed_ops entries are stamped with the epoch
        # they were committed in, and the duplicate-target ledger only
        # sees the current one — a steer is permission to re-edit.
        self._steer_epoch = 0
        self._last_file: str | None = None

    def has_files(self) -> bool:
        return bool(self.state.files)

    @staticmethod
    def _single_op(name: str, args: dict) -> dict | None:
        """Map ONE model-facing arg dict (single-op shape) to the internal
        ProjectState op. Split out of tool_call_to_op when ops[] arrived —
        batch entries run through this same mapper so single and batch
        semantics can never drift."""
        if name == "config_write":
            return {
                "op": "new_file",
                "file": str(args.get("file", "")),
                "content": str(args.get("content", "")),
            }
        if name == "config_edit":
            op: dict = {"op": str(args.get("op", ""))}
            for arg_key in ("file", "section", "new_section", "to_file", "key",
                            "text", "old_text", "new_text", "target_file"):
                if arg_key in args and args[arg_key] is not None:
                    op[arg_key] = str(args[arg_key])
            if "value" in args and args["value"] is not None:
                # str() over repr() for non-str values (the old behavior);
                # a list/dict value on set_param is a model error the
                # op layer rejects, not something to silently stringify.
                val = args["value"]
                op["value"] = val if isinstance(val, str) else str(val)
            # Field-synonym normalization (live r3 TRIDENT-15 2026-09-19:
            # gemma routes both intents through its preferred field name —
            # set_param arrived with new_text='300' (no value), and
            # replace_section with new_text='<full body>' (no text)).
            # Mechanical field-equivalence between documented string
            # params; explicit value/text always wins.
            if op["op"] == "set_param" and "value" not in op \
                    and "new_text" in op:
                op["value"] = op["new_text"]
            elif op["op"] in ("add_section", "replace_section") \
                    and "text" not in op and "new_text" in op:
                op["text"] = op["new_text"]
            return op
        return None

    @staticmethod
    def tool_call_to_op(name: str, args: dict) -> dict | None:
        """Map a model-facing tool call to the internal ProjectState op.

        Shared by execute() (auto-approve path) and prepare() (approval
        path) so the two can never drift. Batch shape: an ``ops`` entry
        (list, or a stringified list — see parse_maybe_stringified) maps
        to ``{"batch": True, "file": ..., "ops": [single-op dicts]}``;
        every entry runs through _single_op with the top-level `file`
        merged in (entries may override it). None = unknown tool or an
        unusable batch shape (the caller kickbacks).
        """
        if name == "config_edit" and "ops" in args and args["ops"] is not None:
            ops_arg = parse_maybe_stringified(args["ops"])
            if not isinstance(ops_arg, list) or not ops_arg:
                return None
            file_default = str(args.get("file", "") or "")
            mapped: list[dict] = []
            for entry in ops_arg:
                if not isinstance(entry, dict):
                    return None
                entry_args = dict(entry)
                if not entry_args.get("file"):
                    entry_args["file"] = file_default
                single = EditSession._single_op(name, entry_args)
                if single is None or single.get("op") == "new_file":
                    return None
                mapped.append(single)
            return {"batch": True, "file": file_default, "ops": mapped}
        return EditSession._single_op(name, args)

    @staticmethod
    def _op_target(op: dict) -> tuple | None:
        """Identity of what an op OVERWRITES, for the same-request
        duplicate guard. Only set_param qualifies: two legit patch_section
        hunks in one macro body must stay possible, config_write on an
        existing file already errors elsewhere. None = no guard.

        Casefolded (final-pass review 2026-09-29): committed_ops stores
        the UNRESOLVED op, so 'printer' vs 'Printer' — which resolve to
        the same key — compared unequal and a re-overwrite slipped past
        the guard into a second approval card for a decided target."""
        if op.get("op") == "set_param":
            return ("set_param", *(
                str(op.get(part, "")).casefold()
                for part in ("file", "section", "key")))
        return None

    def _resolved_op_target(self, op: dict) -> tuple | None:
        """_op_target over the RESOLVED identifiers. Round-2 review
        2026-09-29: committed_ops stores the UNRESOLVED op and apply()
        resolves internally, so raw comparison missed bare-name <->
        full-header respells ('Level_Bed' vs 'gcode_macro level_bed') and
        path aliases of the same decided target. ProjectState.
        _resolve_op_section is the same resolve-only rewrite every op
        goes through (pure — returns a rewritten dict, mutates nothing);
        resolution is best-effort: anything unresolvable falls back to
        the raw spelling, same as apply() does."""
        try:
            resolved = self.state._resolve_op_section(op)
        except Exception:
            resolved = op
        return self._op_target(resolved)

    def _duplicate_of_committed(self, op: dict,
                                up_to: int | None = None) -> dict | None:
        """If this op re-overwrites a target already committed THIS
        request, return the committed result; else None.

        Gate-mode evidence (live smoke 2026-09-14): after the user
        APPROVED set_param max_accel=3200, the cfg-block nudge's example
        call (same key!) was copied by the model verbatim with a
        hallucinated value — opening a second approval card for a target
        the user had already decided. Each bogus card taxes the human 90s
        (auto-decline window). A repeat on an identical target within one
        request is mechanically detectable; block it with an honest
        kickback instead of opening another card.

        STEERING (2026-10-02): entries committed before the latest user
        steer are out of scope. "Set microsteps 32" -> the user steers to
        64 is a NEW instruction about the same target, so the guard must
        not read the model's second attempt as flip-flopping. Nothing else
        clears the ledger, so the oscillation family stays closed between
        steers.

        ``up_to`` (batch engine, 2026-10-16): only entries committed
        BEFORE index up_to count as evidence — re-writing a target the
        same batch just applied is the batch contract (sequential
        evolution), not flip-flopping.
        """
        target = self._resolved_op_target(op)
        if target is None:
            return None
        limit = (len(self.committed_ops) if up_to is None else up_to)
        for entry in reversed(self.committed_ops[:limit]):
            if entry.get("epoch", 0) != self._steer_epoch:
                continue
            if self._resolved_op_target(entry.get("raw_op") or {}) == target:
                return entry
        return None

    def apply_steer(self) -> None:
        """A user steer arrived mid-loop: clear the deterministic ledgers.

        Not intent-parsing — that a user message arrived is mechanical. It
        means the previous instruction round is over, so: the duplicate-
        target ledger reopens (the model may legitimately re-edit a target
        the user just changed), the identical-failure ledger clears (the
        same call may now be exactly what the user wants), the write
        counter resets, and the THRASH budget resets with the read count —
        otherwise steering is useless precisely when it is needed, after
        the model burned its waste driving the wrong way (Sir, 2026-10-02;
        thrash counters included 2026-10-16 since batch accounting changes
        what a "reset" covers). Bounded by the human doing the steering;
        the tool-turn budget is reset by the loop itself.
        """
        self._steer_epoch += 1
        self._identical_failures.clear()
        self._registry_kicks.clear()
        self.edit_attempts = 0
        self.thrash_units = 0
        self.read_calls = 0
        self.write_failures = 0
        self._failed_targets.clear()
        self._last_file = None

    @staticmethod
    def _call_key(name: str, args: dict) -> str:
        try:
            canon = json.dumps(args, sort_keys=True, ensure_ascii=False)
        except (TypeError, ValueError):
            canon = repr(sorted(str(a) for a in args.items()))
        return f"{name}\u0000{canon}"

    def _note_failure(self, name: str, args: dict) -> int:
        """Count a FAILED call; returns how many times THIS exact call
        has now failed (1 = first). Also tags the target as
        failed-earlier (R1): a later batch entry landing the same
        (op, file, section) is a retried op and shows its realized diff."""
        key = self._call_key(name, args)
        self._identical_failures[key] = \
            self._identical_failures.get(key, 0) + 1
        if isinstance(args, dict):
            self._note_failed_target(args)
        return self._identical_failures[key]

    @staticmethod
    def _realized_target_key(op: dict) -> tuple:
        """(op, file, section) identity for the R1 failed-then-retried
        tag. Casefolded like the duplicate guard; no resolve step —
        false-positives here only cost one extra diff block."""
        return (str(op.get("op", "")).casefold(),
                str(op.get("file", "")).casefold(),
                str(op.get("section", "")).strip().strip("[]").casefold())

    def _note_failed_target(self, op: dict) -> None:
        self._failed_targets.add(self._realized_target_key(op))

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

    def charge_waste(self, units: int = 1) -> None:
        """Charge waste units from OUTSIDE the write path (the loop calls
        this for malformed-correction and empty re-prompts — the loop
        knows those round-trips were spent; the session cannot see them).
        Fail-open by contract: this only ever moves a counter."""
        self.thrash_units = max(0, self.thrash_units + units)


    def charge_read(self) -> bool:
        """One executed read call (loop-side, after the repeat guard —
        repeat-dead reads never execute and never charge). The first
        READ_GRACE reads are free; every read past the grace is +1 waste
        unit. Returns True when the read was charged."""
        self.read_calls += 1
        if self.read_calls > READ_GRACE:
            self.thrash_units += 1
            return True
        return False

    def _over_thrash_budget(self) -> str | None:
        """Lean soft-landing directive once this request's THRASH budget
        is spent.

        Returns None while the request is still within budget. On overage
        the write call is not applied and the model gets FACTS, never a
        stop order (2026-10-16 rework): the old "no further write calls
        will be. Stop calling write tools." text is exactly what taught
        models to abandon bulk requests into prose promises (the Hermes
        early-abandonment lesson). The directive names the failure/reading
        pattern, keeps the honesty clauses, and says nothing about what
        the harness will or will not accept next — a wrong note here is a
        useless note, never a changed path.
        """
        cap = thrash_budget()
        if cap <= 0 or self.thrash_units <= cap:
            return None
        self.last_write_outcome = "budget"
        # Every charge is +1, so the correction/re-prompt units are exact
        # by subtraction — no separate counters to drift.
        over_reads = max(0, self.read_calls - READ_GRACE)
        reprompt_units = max(
            0, self.thrash_units - self.write_failures - over_reads)
        facts = []
        if self.write_failures:
            facts.append(f"{self.write_failures} failed write call"
                         + ("" if self.write_failures == 1 else "s"))
        if over_reads:
            facts.append(f"{over_reads} read past the {READ_GRACE}-read "
                         "allowance")
        if reprompt_units:
            facts.append(f"{reprompt_units} correction/re-prompt round-"
                         "trip" + ("" if reprompt_units == 1 else "s"))
        staged = len(self.pending_edits)
        staged_note = (f" {staged} file change"
                       + ("" if staged == 1 else "s")
                       + " already staged "
                       + ("remains" if staged == 1 else "remain")
                       + " awaiting the user's review."
                       if staged else "")
        return (
            "\n\nWASTE BUDGET SPENT — this call was not applied. This "
            f"request has spent its {cap}-unit allowance on wasted round-"
            f"trips: {'; '.join(facts)}.{staged_note} "
            "Rework the approach with what the tool results already in "
            "this conversation tell you. Tell the user what you changed, "
            "what you could NOT apply, and what you would try next. "
            "Never claim a change was staged unless a tool result said so."
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

    # Registry codes that earn a pre-staging kickback (Sir 2026-09-20):
    # a hallucinated command name is INVALID at runtime — Klipper errors
    # on it — so it must not reach the user's approval card without the
    # model first getting one correction round. gcode_command_section_-
    # missing stays pure advisory: fixing it means touching OTHER
    # sections, which is a decision the model shouldn't be forced into.
    _REGISTRY_KICK_CODES = frozenset({"unknown_gcode_command"})

    def _registry_kickback(self, name: str, args: dict,
                           result: dict) -> str | None:
        """One-shot kickback for writes introducing unknown gcode commands.

        Returns kickback text (change NOT staged) the FIRST time this
        exact call trips the check; None to let it through afterwards.
        The resend is the model's deliberate claim that the command is
        legit (plugin/custom module the stock registry can't see); the
        advisory then rides on the approval card as the user's safety
        net, and a second kick could only loop.

        Rename collateral (live report 2026-09-27): a rename_section of a
        gcode_macro ALWAYS strands its existing callers — the validator
        flags each old call as unknown_gcode_command. That is NOT a
        hallucination and must not earn the 'typo? fix and call again'
        kickback: it made the rename itself look invalid, and the model
        burned turns (and asked the user) instead of staging the rename
        and fixing the callers. Advisories naming the renamed-away
        command are filtered out here; any OTHER unknown command still
        earns the correction round.
        """
        renamed_old = ''
        renamed_sections: set[str] = set()
        if args.get('op') == 'rename_section':
            old_hdr = str(args.get('section', '')).strip().strip('[]')
            if ' ' in old_hdr:  # class header: a rename strands its callers
                renamed_old = old_hdr.split(' ', 1)[1].strip().casefold()
            # A rename never touches the BODY, so every advisory ON the
            # renamed section itself is pre-existing content that merely
            # changed address: the delta gate dedupes by (file, section,
            # code, ...) so the header change makes old body warnings
            # look NEW (bank trace 2026-09-27: CLEAN_NOZZLE — defined in
            # clean.cfg, called from Level_Bed's body all along — earned
            # a 'hallucinated command' kick on every rename). Both the
            # old and new header spellings belong to the same body.
            for h in (result.get('renamed_from'), result.get('renamed_to'),
                      old_hdr, str(args.get('new_section', ''))):
                h = str(h or '').strip().strip('[]').casefold()
                if h:
                    renamed_sections.add(h)
        findings = []
        for a in (result.get("advisories") or []):
            if a.get("code") not in self._REGISTRY_KICK_CODES:
                continue
            if renamed_old and f"'{renamed_old}'" in str(
                    a.get("message", "")).casefold():
                continue  # expected collateral of this very rename
            if str(a.get("section", "")).strip().strip('[]').casefold() \
                    in renamed_sections:
                continue  # body-carried advisory, just changed address
            findings.append(a)
        if not findings:
            return None
        key = self._call_key(name, args)
        count = self._registry_kicks.get(key, 0) + 1
        self._registry_kicks[key] = count
        if count > 1:
            return None
        lines = [
            f"{name} NOT STAGED — the change introduces gcode the command "
            "registry does not recognize:",
        ]
        for adv in findings[:4]:
            where = f"[{adv.get('section', '')}] {adv.get('param', '')}".rstrip()
            lines.append(f"- {where}: {adv.get('message', '')}")
        lines.append(
            "If this is a typo or hallucinated command, fix it and call "
            "again (e.g. use the suggested command). If you are CONFIDENT "
            "it comes from a plugin or custom module the stock registry "
            "cannot see, re-send the call unchanged — it will then stage "
            "with the warning shown to the user. Do not open an approval "
            "request for a command you know to be wrong."
        )
        return "\n".join(lines)

    def _batch_engine(self, name: str, batch: dict, *, commit: bool):
        """Shared per-index engine for the batch shape — execute() and
        prepare() run through the SAME loop (paths must not drift).

        Sequential application: each entry applies to the state the
        previous entry left. Continue-on-failure: a bad entry never
        aborts the rest; with commit=True applied entries COMMIT
        (partial progress = real progress, rows land); with commit=False
        the session is untouched and only the preview state advances.
        Accounting per INDEX: edit_attempts++ and the thrash charge move
        per entry; the budget is re-checked per index;
        _duplicate_of_committed re-checks per index (the call-level
        duplicate guard must not veto a legitimate in-batch target);
        _repetition_blocked stays per-CALL at the caller. Each committed
        sub-op records its OWN change-set row with the SUB-OP as
        ``raw_op`` — batch envelopes never enter committed_ops, so
        replay/undo/resolve_change_chain keep the row-per-op shape
        (PR #36 ghost family).

        Returns ``(results, cur_state, last_result)``.
        """
        file_default = batch.get("file", "")
        ops = batch.get("ops") or []
        baseline = self.baseline
        # Duplicate guard boundary: entries may legitimately re-write a
        # target THIS batch just applied (sequential evolution is the
        # contract — set 300 then 400 in one batch means final=400). Only
        # targets committed BEFORE this call are flip-flop evidence.
        dup_boundary = len(self.committed_ops)
        results: list[dict] = []
        cur = self.state
        last_result: dict | None = None
        for idx, sub in enumerate(ops):
            self.edit_attempts += 1
            # Budget re-checked per index (plan Step 2): successful ops
            # never charge, so overage mid-batch comes from accumulated
            # failures; the remaining entries stop un-attempted with a
            # factual note — never a stop-order tone, and the applied
            # rows above stay committed.
            if self._over_thrash_budget() is not None:
                for rest in range(idx, len(ops)):
                    results.append({
                        "idx": rest, "op": ops[rest].get("op", ""),
                        "section": str(ops[rest].get("section", "")),
                        "ok": False,
                        "error": "not attempted — this request's waste "
                                 "budget is spent; rework the approach "
                                 "before re-sending"})
                break
            sub_file = str(sub.get("file") or file_default)
            if not sub_file:
                self.thrash_units += 1
                self.write_failures += 1
                self.last_write_outcome = "correctable"
                results.append({"idx": idx, "op": sub.get("op", ""), "ok": False,
                                "error": "missing file — pass file= on the "
                                         "call or on the entry"})
                continue
            sub = dict(sub)
            sub["file"] = sub_file
            dup = self._duplicate_of_committed(sub, up_to=dup_boundary)
            if dup is not None:
                # Per-index duplicate: this entry's target was already
                # committed — skip it (the OTHER entries are independent).
                prev = dup.get("result", {})
                results.append({"idx": idx, "op": sub.get("op", ""),
                                "section": str(sub.get("section", "")),
                                "ok": False,
                                "error": f"target already applied and staged "
                                         f"in this request "
                                         f"({prev.get('summary', 'previous change')})"})
                continue
            new_state, result = cur.apply(baseline, sub)
            if result["status"] == "error":
                self.thrash_units += 1
                self.write_failures += 1
                self.last_write_outcome = "correctable"
                count = self._note_failure(name, {"i": idx, **sub})
                hint = _lean_error_content(name, result).splitlines()
                err = (hint[0][len(f"{name} FAILED: "):] if hint[0].startswith(f"{name} FAILED: ")
                       else hint[0]) if hint else "failed"
                # Per-index validation detail (BULK-04 bank re-run
                # 2026-10-17): the single-op path surfaces the concrete
                # newErrors ('Unknown parameter uart_pins — Klipper
                # reads no such option'), but the batch shape stripped
                # them to 'failed validation after merging' — gemma
                # re-sent the same invented params 50+ times and burned
                # the whole waste budget. A model cannot fix a finding
                # it cannot see; cap at 3 per entry so a 10-failure
                # batch stays lean.
                sub_errs = (result.get("newErrors") or [])[:3]
                if sub_errs:
                    err += "\n" + "\n".join(
                        f"  - [{e.get('section', '')}] "
                        f"{e.get('param', '')}: {e.get('message', '')}"
                        .rstrip()
                        for e in sub_errs)
                if count >= 2:
                    err += " (this exact entry already failed — do not re-send it unchanged)"
                results.append({"idx": idx, "op": sub.get("op", ""),
                                "section": str(sub.get("section", "")),
                                "ok": False, "error": err})
                continue
            kick = self._registry_kickback(name, sub, result)
            if kick is not None:
                # Unknown gcode entry: NOT staged, NOT charged (the
                # deliberate re-send is the plugin claim — same rule as
                # the single path). The correction round is re-sending
                # that entry.
                self.last_write_outcome = "correctable"
                lines = [l for l in kick.splitlines() if l.startswith("- ")]
                results.append({"idx": idx, "op": sub.get("op", ""),
                                "section": str(sub.get("section", "")),
                                "ok": False,
                                "error": "introduces gcode the command "
                                         "registry does not recognize: "
                                         + "; ".join(
                                             l[2:].strip() for l in lines[:2])})
                continue
            cur = new_state
            last_result = result
            if commit:
                self.commit(new_state, name, result, raw_op=sub)
            entry = {"idx": idx, "op": sub.get("op", ""),
                     "section": str(sub.get("section", "")),
                     "ok": True}
            # R1: this entry fixed an earlier failure on the SAME target
            # — show what it actually changed (clean entries stay lean).
            if self._realized_target_key(sub) in self._failed_targets:
                entry["diff"] = result.get("diff")
                self._failed_targets.discard(self._realized_target_key(sub))
            results.append(entry)
        return results, cur, last_result

    def _check_batch_call(self, name: str, args: dict) -> str | None:
        """Per-CALL checks for the batch shape (both paths, same call):
        whole-batch identical-retry ladder (the per-INDEX ladder lives in
        _batch_engine) + the pathological-size guard. Returns the kickback
        text or None. A rejected call is charged once as waste."""
        blocked = self._repetition_blocked(name, args)
        if blocked is not None:
            self.last_write_outcome = "correctable"
            self.thrash_units += 1
            self.write_failures += 1
            return blocked
        ops_arg = parse_maybe_stringified(args.get("ops"))
        ops = ops_arg if isinstance(ops_arg, list) else []
        if len(ops) > MAX_OPS_PER_CALL:
            # Generation-limit insurance for small models, NOT a work
            # budget (see MAX_OPS_PER_CALL). Charged as a failure (waste).
            # (tool_call_to_op already rejected a non-list/empty ops
            # before this check runs; empty never reaches here.)
            self.edit_attempts += 1
            self.thrash_units += 1
            self.write_failures += 1
            self.last_write_outcome = "correctable"
            return (f"{name} FAILED: this call carries {len(ops)} "
                    f"ops — the limit is {MAX_OPS_PER_CALL} per call; "
                    "split the work across several calls.")
        return None

    def _execute_batch(self, name: str, batch: dict, args: dict) -> tuple[str, dict | None]:
        """Run one ops[] batch call (auto-approve path): per-call checks,
        then the shared engine with commit=True. Sequential, continue-on-
        failure, per-index feedback — see _batch_engine."""
        kickback = self._check_batch_call(name, args)
        if kickback is not None:
            return kickback, None
        results, _cur, last_result = self._batch_engine(name, batch, commit=True)
        # Live-staging details: commit() already advanced session state,
        # so the details for the LAST touched file carry the CUMULATIVE
        # net text — exactly what the editor pane consumes mid-request.
        details = (self._details_for(name, last_result)
                   if last_result is not None else None)
        return _ops_result_content(name, results), details

    def _prepare_batch(self, name: str, batch: dict, args: dict):
        """Gate-mode batch: the SAME engine as execute() with
        commit=False — the session is untouched until the user decides.

        A FULLY applied batch hands an aggregated result + the preview
        state to the approval machinery (one card, one decision, one
        commit of the whole batch). A PARTIALLY applied batch does NOT
        open a card: committing "the batch" would double-apply the
        already-previewed half, so the honest kickback lists the failed
        indices and the model re-sends only those ops. The dormant-gate
        contract holds: the card is the single commit point and never
        opens over work the user has not seen whole.
        Returns ``(content, result, preview_state)`` like prepare()."""
        kickback = self._check_batch_call(name, args)
        if kickback is not None:
            return kickback, None, None
        results, cur, last_result = self._batch_engine(name, batch, commit=False)
        failed = [r for r in results if not r.get("ok")]
        applied = [r for r in results if r.get("ok")]
        if not applied or last_result is None:
            # Nothing applied: pure per-index kickback, no card.
            return _ops_result_content(name, results), None, None
        if failed:
            # Mixed batch in gate mode: NO card over partially applied
            # work (see docstring). Nothing staged; fix and re-send the
            # failed indices only.
            return (_ops_result_content(name, results)
                    + "\nNo card opened — fix the failed ops and re-send "
                      "a batch of ONLY those ops (nothing was staged)."), None, None
        # Fully applied batch: one aggregated card result + preview.
        touched = last_result.get("file", "")
        agg_result = {
            "status": last_result.get("status", "applied"),
            "file": touched,
            "op": "batch",
            "summary": f"batch: {len(applied)} changes to {touched}",
            "advisories": last_result.get("advisories", []),
            # Cumulative net diff the user reviews: difflib over the
            # whole batch's before/after — per-op diffs would each
            # re-show shared context and mislead the review surface.
            "diff": diff_text(
                touched,
                self.state.files.get(touched, ""),
                cur.files.get(touched, "")),
        }
        return _ops_result_content(name, results), agg_result, cur

    def execute(self, tool_call: dict) -> tuple[str, dict | None]:
        """Run one write tool call (auto-approve path). Returns
        (lean content, details-or-None).

        ``details`` (UI payload, never sent to the model) is set on
        success: ``{file, op, summary, newText, diff}`` shaped for the
        current draft UI + the approval card.
        """
        name = tool_call.get("name", "")
        args = tool_call.get("arguments", {}) or {}

        budget = self._over_thrash_budget()
        if budget is not None:
            self.edit_attempts += 1
            return budget, None

        op = self.tool_call_to_op(name, args)
        if op is None:
            self.edit_attempts += 1
            if "ops" in args:
                # An ops arg arrived but mapped to nothing usable.
                return (f"{name} FAILED: 'ops' must be a non-empty list of "
                        "operation objects, e.g. "
                        '[{"op": "set_param", "section": "printer", '
                        '"key": "max_accel", "value": "3000"}]. Nothing '
                        "was applied."), None
            return f"Unknown write tool: {name}", None
        if op.get("batch"):
            # Per-op accounting (plan Step 2): the batch engine increments
            # edit_attempts per INDEX — a call-level increment on top of
            # N index increments would miscount work.
            return self._execute_batch(name, op, args)

        self.edit_attempts += 1
        blocked = self._repetition_blocked(name, args)
        if blocked is not None:
            # A refused repeat is a wasted call — charge the waste.
            self.last_write_outcome = "correctable"
            self.thrash_units += 1
            self.write_failures += 1
            return blocked, None

        dup = self._duplicate_of_committed(op)
        if dup is not None:
            # user_gated: unlocking requires a NEW user message, never a
            # nudge-prompted retry (see _duplicate_of_committed evidence).
            self.last_write_outcome = "user_gated"
            return self._duplicate_kickback(dup), None

        new_state, result = self.state.apply(self.baseline, op)
        if result["status"] == "error":
            # 2026-09-20: the commented-param refusals were removed, so
            # every write error here is CORRECTABLE (anchor miss, bad/
            # missing args, unknown section/op, self-include, new
            # validation errors) — the nudge loop may push a corrected
            # retry. user_gated now only comes from explicit user
            # decisions (duplicate target, decline, timeout, stop).
            self.last_write_outcome = "correctable"
            # A failed write is the archetype of chargeable waste (the
            # success path above stays FREE — reviewable work, not thrash).
            self.thrash_units += 1
            self.write_failures += 1
            count = self._note_failure(name, args)
            lean_err = _lean_error_content(name, result)
            return (lean_err
                    + self._repeat_directive(name, count)), None

        kick = self._registry_kickback(name, args, result)
        if kick is not None:
            # Correctable: unknown gcode gets one pre-staging correction
            # round before any card/stage (Sir 2026-09-20). NOT charged:
            # the deliberate re-send is the model's plugin claim, not
            # thrash (same reasoning as the duplicate kickback).
            self.last_write_outcome = "correctable"
            return kick, None

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

        budget = self._over_thrash_budget()
        if budget is not None:
            self.edit_attempts += 1
            return budget, None, None

        op = self.tool_call_to_op(name, args)
        if op is None:
            self.edit_attempts += 1
            if "ops" in args:
                # An ops arg arrived but mapped to nothing usable — same
                # kickback as execute() (paths must not drift).
                return (f"{name} FAILED: 'ops' must be a non-empty list of "
                        "operation objects, e.g. "
                        '[{"op": "set_param", "section": "printer", '
                        '"key": "max_accel", "value": "3000"}]. Nothing '
                        "was applied."), None, None
            return f"Unknown write tool: {name}", None, None
        if op.get("batch"):
            # Per-op accounting (see execute()): batch increments
            # edit_attempts per INDEX, never a call-level +1 on top.
            return self._prepare_batch(name, op, args)

        self.edit_attempts += 1
        # Review fix 2026-09-26: execute() refuses an identical call that
        # already failed 3+ times; prepare() (the product/approval path)
        # was missing the same guard, so a looping model reached the
        # request write cap instead of the earlier strategic hard-stop.
        # Paths must not drift (class docstring).
        blocked = self._repetition_blocked(name, args)
        if blocked is not None:
            self.last_write_outcome = "correctable"
            self.thrash_units += 1
            self.write_failures += 1
            return blocked, None, None

        dup = self._duplicate_of_committed(op)
        if dup is not None:
            # Same guard as execute(); a DUPLICATE TARGET never becomes
            # an approval card — the user already decided this target.
            self.last_write_outcome = "user_gated"
            return self._duplicate_kickback(dup), None, None

        new_state, result = self.state.apply(self.baseline, op)
        if result["status"] == "error":
            # Correctable kickback (see execute() — the commented-param
            # refusals are gone, so no write error is user-gated).
            # Failed write = charged waste (paths must not drift).
            self.last_write_outcome = "correctable"
            self.thrash_units += 1
            self.write_failures += 1
            count = self._note_failure(name, args)
            lean_err = _lean_error_content(name, result)
            return (lean_err
                    + self._repeat_directive(name, count)), None, None

        kick = self._registry_kickback(name, args, result)
        if kick is not None:
            # Gate mode gets the SAME one-shot unknown-gcode kickback as
            # execute(): no card opens without the model's correction
            # round first (Sir 2026-09-20). The resend passes and the
            # advisory rides the card.
            self.last_write_outcome = "correctable"
            return kick, None, None

        return _lean_success_content(name, result), result, new_state

    def commit(self, new_state: "ProjectState", name: str, result: dict,
               raw_op: dict | None = None) -> None:
        """Stage a prepared/validated op into the session (single recorder
        of committed_ops — used by the auto-approve path AND the decision
        endpoint's approve path; nothing else mutates session state)."""
        self.state = new_state
        self.last_write_outcome = "success"
        file_name = result.get("file", "")
        # Stale-failure invalidation (COMMENT-06 gemma trace 2026-09-28):
        # rename FAILED twice (rename_existing_invalid), the model then
        # APPLIED the uncomment that made the rename valid, retried the
        # identical rename — and the 3x repetition guard BLOCKED a call
        # that now passes validation. The ladder is args-only and the
        # world moved under it. A successful write to a file changes what
        # any earlier failure against that file MEANT, so drop those
        # counters (the budget for genuine template loops is preserved:
        # without an intervening apply, nothing is cleared).
        if file_name:
            self._identical_failures = {
                k: v for k, v in self._identical_failures.items()
                if file_name not in k}
        details = self._details_for(name, result)
        # Stacked edits to the same file replace its staged entry so the
        # draft UI shows the cumulative result, not intermediate states.
        # A move_section touches TWO files (target + source), so both
        # entries are refreshed under the same rule — a stale source entry
        # would show the section still in its old home.
        src_file = str((result.get("diff_from") or {}).get("file") or "")
        touched = [file_name] + ([src_file] if src_file and src_file != file_name else [])
        # `created` must SURVIVE the per-file replacement below: five
        # move_section ops into one new file create it on the first and
        # merely edit it on the rest, so only the first carries the flag —
        # and the staged entry the UI/harness sees is the last one.
        was_created = {
            e["file"] for e in self.pending_edits if e.get("created")
        }
        self.pending_edits = [
            e for e in self.pending_edits if e["file"] not in touched
        ]
        for staged_file in touched:
            entry = dict(details)
            entry["file"] = staged_file
            entry["newText"] = self.state.files.get(staged_file, "")
            if staged_file == file_name and (result.get("created")
                                             or staged_file in was_created):
                entry["created"] = True
            if staged_file != file_name:
                entry["summary"] = (
                    f"source side: section left {staged_file}"
                    if result.get("op") == "move_section" else entry["summary"])
            self.pending_edits.append(entry)
        self._last_file = file_name
        self.committed_ops.append(
            {"name": name, "op": result.get("op", name),
             "raw_op": dict(raw_op) if raw_op else {},
             "result": result,
             "epoch": self._steer_epoch})
        # Post-hoc review (2026-10-02): one transcript record per op, and
        # the net text we just handed the client for this file.
        self._record_edit(name, result, raw_op)
        for staged_file in touched:
            self.pushed_files[staged_file] = self.state.files.get(staged_file, "")

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

        if op.get("batch"):
            # Batch envelope approve (prepare()/card path): the card was
            # built over a fully-applied PREVIEW; the decision commits
            # the SUB-OPS one per change-set row (never the envelope —
            # committed_ops shape is row-per-op for replay/undo, PR #36
            # ghost family). Re-validate each sub-op sequentially
            # against the replayed state, exactly as the engine did at
            # prepare time; any sub-op that no longer applies after the
            # user's manual edits invalidates the whole card honestly
            # (partial approve of a batch the user reviewed as ONE diff
            # would strand half a preview).
            subs = [dict(s) for s in (op.get("ops") or [])]
            file_default = str(op.get("file", "") or "")
            for sub in subs:
                sub.setdefault("file", file_default)
            if context_files:
                try:
                    replay = ProjectState.from_context_files(context_files)
                except Exception as exc:
                    return {"status": "error",
                            "error": f"Invalid context refresh: {exc}"}
                replay_baseline = replay.validate()
                for prior in self.committed_ops:
                    replay, prior_result = replay.apply(replay_baseline,
                                                        prior["raw_op"])
                    if prior_result["status"] == "error":
                        return {
                            "status": "error",
                            "error": (
                                "config changed since this proposal — an "
                                "earlier approved edit no longer applies "
                                f"({prior_result.get('error', 'anchor lost')})"
                            ),
                            "newErrors": prior_result.get("newErrors", []),
                        }
            else:
                replay, replay_baseline = self.state, self.baseline
            cur = replay
            staged_results: list[tuple[dict, "ProjectState", dict]] = []
            for sub in subs:
                nxt, res = cur.apply(replay_baseline, sub)
                if res["status"] == "error":
                    res.setdefault(
                        "error", "config changed since this proposal")
                    return res
                cur = nxt
                staged_results.append((sub, nxt, res))
            # All sub-ops re-validated: commit each as its own row.
            for sub, nxt, res in staged_results:
                self.commit(nxt, name, res, raw_op=sub)
            last_res = staged_results[-1][2]
            last_res["details"] = self._details_for(name, last_res)
            last_res["summary"] = (f"batch: {len(subs)} changes to "
                                   f"{last_res.get('file', '')}")
            return last_res

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
            {k: e.get(k) for k in ("file", "op", "summary", "newText",
                                   "advisories", "created")}
            for e in self.pending_edits
        ]

    # ── Change set: transcript records + post-hoc resolution ───────────

    @staticmethod
    def _supersede_key(op: dict) -> tuple | None:
        """Target identity for last-write-per-target collapsing.

        Mirrors :meth:`_op_target` (set_param is keyed; a body op is
        section-scoped) and NONE means "this op never supersedes".
        ``patch_section`` is deliberately in that None group: two legit
        hunks in one macro body are two changes, not a rewrite of one.
        """
        kind = str(op.get("op", ""))
        file_name = str(op.get("file", "")).casefold()
        section = str(op.get("section", "")).strip().strip("[]").casefold()
        if kind == "set_param":
            return ("set_param", file_name, section,
                    str(op.get("key", "")).casefold())
        if kind in ("replace_section", "add_section", "delete_section",
                    "comment_section", "uncomment_section", "move_section"):
            return (kind, file_name, section)
        if kind in ("rename_section", "add_include", "remove_include",
                    "comment_include"):
            return (kind, file_name, section,
                    str(op.get("target_file", "")).casefold())
        if kind in ("new_file", "delete_file"):
            return (kind, file_name)
        return None

    def _record_edit(self, name: str, result: dict,
                     raw_op: dict | None) -> None:
        """Append one transcript record for a committed op, and mark any
        earlier edit to the SAME target superseded.

        The record is what the chat renders (file/section, counts, the
        op's own unified diff) and what :meth:`resolve_change_set`
        replays, so it keeps the raw op under an underscore key that
        :meth:`change_set_payload` strips before anything ships.
        """
        op = dict(raw_op or {})
        try:
            resolved = self.state._resolve_op_section(dict(op))
        except Exception:  # pragma: no cover - defensive, resolve is pure
            resolved = op
        file_name = result.get("file", "")
        section = str(resolved.get("section", "") or "").strip().strip("[]")
        # Canonical header from the PRE-apply resolution (BULK-02 bank run
        # 2026-10-17): for comment_section the post-apply state can no
        # longer see the header it just '#'ed, so re-resolving the raw op
        # here loses the 'gcode_macro ' prefix. The engine's resolvedSection
        # is authoritative when present.
        canonical = str(result.get("resolvedSection") or "").strip().strip("[]")
        if canonical:
            section = canonical
            resolved = {**resolved, "section": canonical}
        key = (str(resolved.get("key", "") or "")
               if resolved.get("op") == "set_param" else "")
        diff = result.get("diff") or {}
        before = str(diff.get("before", ""))
        after = str(diff.get("after", ""))
        added, removed = diff_counts(before, after)
        record = {
            "id": f"e{len(self.edit_records)}",
            "file": file_name,
            "section": section,
            "key": key,
            "op": result.get("op", name),
            "summary": result.get("summary", ""),
            "added": added,
            "removed": removed,
            "diffText": diff_text(file_name, before, after),
            "advisories": list(result.get("advisories") or []),
            "superseded": False,
            "supersededBy": "",
            "_key": self._supersede_key(resolved),
            "_raw_op": op,
        }
        if record["_key"] is not None:
            for prior in self.edit_records:
                if prior["superseded"]:
                    continue
                if prior.get("_key") == record["_key"]:
                    prior["superseded"] = True
                    prior["supersededBy"] = record["id"]
        self.edit_records.append(record)
        # move_section carries the SOURCE-side diff: emit a second row so
        # the change set shows both halves of the move (and a trace-based
        # coverage criterion sees the source deletion). Target row is the
        # authoritative "section now lives here"; this one records the
        # removal. Ids stay sequential across both rows.
        diff_from = result.get("diff_from") or {}
        if diff_from:
            src_name = str(diff_from.get("file") or "")
            before_s = str(diff_from.get("before", ""))
            after_s = str(diff_from.get("after", ""))
            added_s, removed_s = diff_counts(before_s, after_s)
            self.edit_records.append({
                "id": f"e{len(self.edit_records)}",
                "file": src_name,
                "section": section,
                "key": "",
                "op": result.get("op", name),
                "summary": f"moved section [{section}] out of {src_name}",
                "added": added_s,
                "removed": removed_s,
                "diffText": diff_text(src_name, before_s, after_s),
                "advisories": [],
                "superseded": False,
                "supersededBy": "",
                "_key": None,
                "_raw_op": op,
            })

    _RECORD_KEYS = ("id", "file", "section", "key", "op", "summary",
                    "added", "removed", "diffText", "advisories",
                    "superseded", "supersededBy")

    def change_set_payload(self) -> dict:
        """The review payload: every edit in the order the model made it,
        plus the summary grouped by file and section.

        Flat chronological ``edits`` are the transcript (history — order
        carries meaning). ``files`` is the decision surface, so it is
        grouped and carries the NET totals of the surviving (non-
        superseded) set; a superseded row is still listed in ``edits``
        with ``superseded: true`` and contributes nothing to a total.
        Line numbers are deliberately absent: a change's identity is its
        file and section, never its line range.

        Each file ALSO carries ``beforeText`` — the file as it stood before
        this request's first edit to it. That is the FRAME the text view's
        pane diffs against (Sir, 2026-10-03: the pane shows the WHOLE
        document with the changed lines marked, not the neighbourhood of
        each hunk). It is the one text the client cannot derive: the
        current text it already holds (it is the buffer), the pre-review
        text only ever existed here. Shipped once per FILE per request —
        never once per edit, which is what the per-row ``diffText`` exists
        to avoid.
        """
        edits = [{k: r.get(k) for k in self._RECORD_KEYS}
                 for r in self.edit_records]
        groups: "OrderedDict[tuple, dict]" = OrderedDict()
        for rec in self.edit_records:
            if rec["superseded"]:
                continue
            group = groups.get((rec["file"], rec["section"]))
            if group is None:
                group = {"file": rec["file"], "section": rec["section"],
                         "added": 0, "removed": 0, "edits": [],
                         "advisories": {"error": 0, "warning": 0, "other": 0}}
                groups[(rec["file"], rec["section"])] = group
            group["added"] += rec["added"]
            group["removed"] += rec["removed"]
            group["edits"].append(rec["id"])
            for adv in rec["advisories"]:
                sev = str(adv.get("severity", "")).lower()
                if sev == "error":
                    group["advisories"]["error"] += 1
                elif sev == "warning":
                    group["advisories"]["warning"] += 1
                else:
                    group["advisories"]["other"] += 1
        files: "OrderedDict[str, dict]" = OrderedDict()
        for group in groups.values():
            entry = files.get(group["file"])
            if entry is None:
                entry = {"file": group["file"], "added": 0, "removed": 0,
                         "sections": [],
                         "beforeText": self.baseline_files.get(group["file"], "")}
                files[group["file"]] = entry
            entry["added"] += group["added"]
            entry["removed"] += group["removed"]
            entry["sections"].append(group)
        return {
            "edits": edits,
            "files": list(files.values()),
            "totalAdded": sum(f["added"] for f in files.values()),
            "totalRemoved": sum(f["removed"] for f in files.values()),
            "createdFiles": [r["file"] for r in self.edit_records
                             if r["op"] == "new_file" and not r["superseded"]],
        }

    def resolve_change_set(self, kept_ids, context_files: dict | None = None,
                           ) -> dict:
        """Replay ONE request's KEPT ops (see :func:`resolve_change_chain`)."""
        return resolve_change_chain([(self, kept_ids, None)], context_files)

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

        Matching is NORMALIZED on both sides (_echo_norm: trailing
        comments dropped, internal whitespace collapsed). Live
        flash-next full-bank 2026-09-23: the model stages both edits,
        then recaps them in mini-diff form ('-max_accel: 15500 #Ellis
        Tuned' / '+max_accel: 12000'); the dropped trailing comment on
        the '+' side made a display recap read as a fresh draft, the
        nudge fired on 16/61 questions, and the re-attempt hit
        DUPLICATE TARGET kickbacks. A genuinely new VALUE still never
        matches — normalization only forgives formatting, never content.
        """
        project_lines: set[str] = set()
        for text in self.state.files.values():
            for line in text.splitlines():
                stripped = line.strip()
                if stripped:
                    project_lines.add(stripped)
        project_norm = {_echo_norm(l) for l in project_lines}
        project_norm.discard("")

        def _echoed(line: str) -> bool:
            norm = _echo_norm(line)
            return bool(norm) and (line in project_lines
                                   or norm in project_norm)

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
                    if body and _echoed(body):
                        return True
                    continue
                if stripped.startswith("+"):
                    # Mini-diff '+' line: the NEW value — echo iff the
                    # post-'+' content is in the project (staged).
                    if not _echoed(stripped[1:].strip()):
                        return True
                elif stripped.startswith("-"):
                    # Mini-diff '-' line: the OLD value. Absent from the
                    # project = display of an applied change (the old line
                    # is gone) -> echo. Still present = deletion was never
                    # applied -> inert draft.
                    if _echoed(stripped[1:].strip()):
                        return True
                elif not _echoed(stripped):
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

# Decided approval ids that have been removed from _pending_approvals
# (bounded): lets the decision endpoint answer 'already_decided' instead
# of 'not_found' when a second POST races the loop's cleanup. See
# remove_approval().
_decided_approvals: "OrderedDict[str, None]" = OrderedDict()
_DECIDED_TOMBSTONES_MAX = 256


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
            # Only a hard ERROR invalidates. 'applied_with_advisory' is a
            # COMMIT (live bug 2026-09-26: every gcode_macro rename
            # invalidated on approve — the rename earns a
            # rename_existing/unknown-gcode advisory, decide() compared
            # status != 'applied', and the user saw the generic "config
            # changed since this proposal" with the config unchanged).
            # Law: advisories ride the card for the user; approval IS the
            # confirmation. prepare/execute/auto-approve all gate on
            # == "error" — decide() must not drift.
            if outcome["status"] == "error":
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
                       # The gated advisories of THIS op (2026-09-30).
                       # outcome comes from a delta-gated apply, but its
                       # ``details`` record is rebuilt through
                       # apply_no_gate (a newText helper that runs NO
                       # validation), so details['advisories'] is always
                       # empty. The model-facing result must not read the
                       # escalation's input from there. The rename fields
                       # ride along for the same reason: the post-rename
                       # stale-caller directive needs them and they are on
                       # the gated result, not on ``details``.
                       "advisories": outcome.get("advisories", []),
                       "renamed_from": outcome.get("renamed_from", ""),
                       "renamed_to": outcome.get("renamed_to", ""),
                       # Same reasoning: the post-create include directive
                       # needs it and it is on the gated result (2026-10-12).
                       "needs_include": outcome.get("needs_include", ""),
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
                # Review fix 2026-09-26: decide() commits BEFORE
                # _settle is scheduled via call_soon_threadsafe, so on
                # the multi-loop case `resolved` can be True (change
                # already committed) while the future is not yet done.
                # Return 'timeout' only when no decision was taken at
                # all; otherwise wait briefly for the settle to land.
                if self.resolved:
                    settle_deadline = _time.monotonic() + 2.0
                    while not self.future.done() and _time.monotonic() < settle_deadline:
                        await asyncio.sleep(0.05)
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
    # Tombstone (review 2026-09-29): the loop removes the entry the moment
    # its decision resolves, so a SECOND decision POST racing the request's
    # completion got 'not_found' while the same double-click a millisecond
    # earlier got 'already_decided' (flaky test_double_decision_rejected:
    # ~1/6). A decided id never becomes undecided — answer honestly from
    # the tombstone. Bounded LRU, no unbounded growth.
    _decided_approvals[approval_id] = None
    while len(_decided_approvals) > _DECIDED_TOMBSTONES_MAX:
        _decided_approvals.popitem(last=False)
    _pending_approvals.pop(approval_id, None)


def was_decided(approval_id: str) -> bool:
    """True when this id was decided and already removed from pending."""
    return approval_id in _decided_approvals


def format_approval_result(name: str, decision: dict) -> tuple[str, dict | None]:
    """Lean model-facing tool result for a resolved approval.

    Returns (content, edit_details-or-None). edit_details is set ONLY on
    approval (the staged-edit stack must not carry an unapproved change).
    """
    kind = decision.get("decision")
    if kind == "approved":
        details = decision.get("details")
        # Advisories come from the DECISION payload (the gated result of
        # the re-validated op); the details record cannot supply them —
        # see ApprovalRequest.decide(). Fall back to it only defensively.
        advisories = (decision.get("advisories")
                      or (details or {}).get("advisories") or [])
        # 2026-09-30 live bug: this result used to be the bare approval
        # sentence. prepare() builds the full advisory block AND the
        # RUNTIME FAILURE escalation, but _run_approval_gate discards that
        # content (it is only used for the kickback branch), so on the
        # PRODUCT path the model was never told anything about what it had
        # just staged — a G2/G3 CIRCLE_HOME macro came back advisory-free
        # after approval, the model closed with "macro added", and
        # [gcode_arcs] was never added. Same shape as the 09-27
        # stale-caller miss. The approved result now carries the SAME
        # advisory block and directives as _lean_success_content; only the
        # STAGED/APPROVED sentence differs, so the two write paths cannot
        # drift again.
        content = f"{name} applied — {decision.get('summary', '')}"
        # R1: same realized-change block as _lean_success_content — the
        # gate path is the PRODUCT path, so a swallowed line must be as
        # visible after approval as it is on auto-approve (drift law).
        content += _realized_change_block(
            (details or {}).get("op", ""), (details or {}).get("diff"))
        runtime = _runtime_section_directive({"advisories": advisories},
                                             approved=True)
        if advisories:
            content += _advisory_lines(advisories)
            if not runtime:
                content += "\nAdvisories do not block the staged change."
        content += (
            "\nThe user APPROVED this change. It is staged for their review "
            "(not saved until they use the save menu)."
        )
        if runtime:
            content += "\n\n" + runtime
        stale = _stale_callers_directive(
            {"renamed_from": decision.get("renamed_from", ""),
             "renamed_to": decision.get("renamed_to", "")}, advisories)
        if stale:
            content += "\n\n" + stale
        incl = _include_needed_directive(
            {"needs_include": decision.get("needs_include", "")})
        if incl:
            content += "\n\n" + incl
        return content, details
    if kind == "timeout":
        return (
            f"{name} NOT APPROVED — the user did not respond within "
            f"{int(APPROVAL_TIMEOUT_SECONDS)} seconds. The change is NOT "
            "staged. Do not retry the same change on your own; in your "
            "reply, briefly tell the user the change was not applied and "
            "ask them directly what they would like to do.",
            None,
        )
    reason = decision.get("reason")
    # The reason is user-supplied OR mechanical (request-cancel); a
    # neutral label never misquotes the human.
    reason_part = f" Reason given: {reason}." if reason else ""
    return (
        f"{name} NOT APPROVED — the user reviewed the change and chose "
        "not to apply it. The change is NOT staged and nothing was "
        "written. This is a decision by the human, not an error on your "
        f"call and not a validation failure.{reason_part} In your reply, "
        "tell the user plainly in one sentence that the change was not "
        "applied, then END WITH A DIRECT QUESTION asking how they want to "
        "proceed (different value, skip it, or something else). Do not "
        "retry the same change on your own and do not restate your "
        "earlier plan.",
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
