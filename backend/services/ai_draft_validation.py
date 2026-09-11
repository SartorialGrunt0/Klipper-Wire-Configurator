"""Server-side merged-result validation for AI chat replies (#1).

Port of the validated frontend logic in
``frontend/src/utils/draftValidation.ts`` (REPAIR-01 wording is measured —
encode, don't re-derive; see kwc-ai-chat-pipeline skill):

- delta semantics: candidate errors minus baseline multiset (pre-existing
  user-config errors never block a draft),
- retry-exempt codes (``project_duplicate``, ``shared_pin``): the model
  can't fix these by regenerating,
- REPAIR-01 feedback shape: never quote the previous reply, lean context
  only, exact validator error + imperative fix, Jinja closer commands
  derived from the Klippy "innermost block" message.

Used by ``chat_proxy`` when KWC_SERVER_DRAFT_VALIDATION is enabled: the
backend applies the reply (ai_draft_apply), validates the MERGED result,
and issues at most ONE lean repair query.
"""
from __future__ import annotations

import re

# Mirror of RETRY_EXEMPT_CODES in draftValidation.ts.
RETRY_EXEMPT_CODES = frozenset({"project_duplicate", "shared_pin"})

_JINJA_INNERMOST_BLOCK_RE = re.compile(
    r"The innermost block that needs to be closed is '([a-z_]+)'", re.IGNORECASE
)
_JINJA_CLOSER_BY_OPENER = {
    "if": "endif",
    "for": "endfor",
    "while": "endwhile",
    "raw": "endraw",
    "macro": "endmacro",
    "block": "endblock",
    "filter": "endfilter",
    "call": "endcall",
    "with": "endwith",
}


def _error_key(filename: str, error: dict) -> str:
    return "::".join(
        [
            filename,
            error.get("severity", ""),
            error.get("section", ""),
            error.get("param", ""),
            error.get("message", ""),
        ]
    )


def _is_blocking(error: dict) -> bool:
    return error.get("severity") in ("error", "warning")


def is_retry_exempt(error: dict) -> bool:
    return bool(error.get("code")) and error["code"] in RETRY_EXEMPT_CODES


def collect_new_validation_errors(
    baseline_validations: dict[str, dict],
    candidate_validations: dict[str, dict],
) -> list[dict]:
    """Mirror of collectNewValidationErrors: candidate minus baseline multiset.

    Returns ``[{"filename": str, "errors": [error-dict, ...]}, ...]`` sorted
    by filename, exactly like the TS grouped-issue list.
    """
    baseline_counts: dict[str, int] = {}
    for filename, result in baseline_validations.items():
        for error in result.get("errors", []):
            if not _is_blocking(error):
                continue
            key = _error_key(filename, error)
            baseline_counts[key] = baseline_counts.get(key, 0) + 1

    blocking_by_file: dict[str, list[dict]] = {}
    for filename in sorted(candidate_validations):
        result = candidate_validations[filename]
        for error in result.get("errors", []):
            if not _is_blocking(error):
                continue
            key = _error_key(filename, error)
            remaining = baseline_counts.get(key, 0)
            if remaining > 0:
                baseline_counts[key] = remaining - 1
                continue
            blocking_by_file.setdefault(filename, []).append(error)

    return [{"filename": f, "errors": errs} for f, errs in blocking_by_file.items()]


def has_only_retry_exempt_issues(blocking_issues: list[dict]) -> bool:
    issues = [e for group in blocking_issues for e in group["errors"]]
    return bool(issues) and all(is_retry_exempt(e) for e in issues)


def suppress_errors_shadowed_by_full_rewrite(blocking_issues: list[dict]) -> list[dict]:
    """Mirror of suppressValidationErrorsShadowedByFullRewrite: when the
    full-rewrite guard flags a section, drop other errors for the same
    file+section — they are guard artifacts and fight its directive."""
    guard_keys = set()
    for group in blocking_issues:
        for error in group["errors"]:
            if error.get("code") == "macro_full_rewrite":
                guard_keys.add(f"{group['filename']}::{error.get('section', '')}")
    if not guard_keys:
        return blocking_issues
    out = []
    for group in blocking_issues:
        kept = [
            e for e in group["errors"]
            if f"{group['filename']}::{e.get('section', '')}" in guard_keys
            or e.get("code") == "macro_full_rewrite"
        ]
        if kept:
            out.append({"filename": group["filename"], "errors": kept})
    return out


def derive_jinja_repair_commands(blocking_issues: list[dict]) -> list[str]:
    """Mirror of deriveJinjaRepairCommands (validated wording)."""
    commands: list[str] = []
    seen = set()
    for group in blocking_issues:
        for error in group["errors"]:
            if error.get("code") != "macro_jinja_unterminated":
                continue
            match = _JINJA_INNERMOST_BLOCK_RE.search(error.get("message", ""))
            if not match:
                continue
            closer = _JINJA_CLOSER_BY_OPENER.get(match.group(1).lower())
            if not closer:
                continue
            section = f"[{error['section']}]" if error.get("section") else ""
            key = f"{section}:{closer}"
            if key in seen:
                continue
            seen.add(key)
            commands.append(
                f"The innermost open Jinja block in {section or 'the macro'} is "
                f"'{match.group(1)}' — append {{% {closer} %}} at the end of its gcode body."
            )
    return commands


def format_validation_issues(blocking_issues: list[dict], failure_reason: str | None) -> str:
    lines: list[str] = []
    if failure_reason:
        lines.append(f"- {failure_reason}")
    for group in blocking_issues:
        lines.append(f"File: {group['filename']}")
        for error in group["errors"]:
            section = error.get("section", "")
            param = error.get("param", "")
            location = f"[{section}] {param}" if param else f"[{section}]"
            lines.append(f"- {location}: {error.get('message', '')}")
    return "\n".join(lines)


def build_validation_feedback(
    blocking_issues: list[dict],
    failure_reason: str | None,
    allow_explanation_only: bool = False,
) -> str:
    """Mirror of buildAssistantDraftValidationFeedback — REPAIR-01 shape.

    NOTE: unlike the frontend version this never receives the invalid
    content; nothing quotes the previous reply by construction.
    """
    formatted = format_validation_issues(blocking_issues, failure_reason) or (
        "- The previous reply did not include a complete applicable cfg draft."
    )
    repair_commands = derive_jinja_repair_commands(blocking_issues)
    parts = [
        "Your cfg changes failed validation after merging into the current project.",
        "Return a corrected replacement reply that fixes every problem below and still satisfies the user request.",
        'If you return config changes, return only changed content inside fenced cfg code blocks and keep any required "# file: <filename>" hint. To edit an existing section use a mini-diff (section header plus only the changed lines, "-" removed / "+" added with original indentation); unchanged lines are preserved automatically. To add a new section, write it in full.',
        "Do NOT copy or repeat your previous reply. Emit a fresh mini-diff with ONLY the corrected lines.",
        "If you need the current content of any affected section, fetch it yourself with read_user_config (filename=..., section=...) instead of reconstructing it from memory.",
        (
            "If the remaining problems are duplicate sections or reused pins and you cannot resolve them safely from the current config, do not return another invalid cfg block. Instead, clearly explain the conflict, mention the exact section or pin involved, and say what must change before a valid config can be produced."
            if allow_explanation_only
            else "Do not ask the user to apply manual fixes for these validation issues."
        ),
        "",
        "Validation problems to fix:",
        formatted,
    ]
    if repair_commands:
        parts.extend(["", "Direct fixes:"] + [f"- {c}" for c in repair_commands])
    return "\n".join(parts)
