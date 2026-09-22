"""Delta validation for the tool-mediated write path (op-engine gate).

The prose-repair half of this module (REPAIR-01 feedback builders, Jinja
closer derivation, retry-exempt give-up, full-rewrite shadow suppression)
was deleted with the server-side draft validation path in the Phase-4
ratchet (2026-09-22). What survives is the delta machinery the write
engine needs: candidate errors minus baseline multiset, so pre-existing
user-config errors never block a staged edit.

- delta semantics: candidate errors minus baseline multiset,
- retry-exempt codes (``project_duplicate``, ``shared_pin``): warnings the
  write loop must not keep kicking back over.
"""
from __future__ import annotations

# Retry-exempt codes (the TS twin draftValidation.ts was deleted with the
# prose path in the Phase-4 ratchet, 2026-09-22).
RETRY_EXEMPT_CODES = frozenset({"project_duplicate", "shared_pin"})


def _error_key(filename: str, error: dict) -> str:
    # Message-free identity (Phase 0 fix, tool-mediated-editing plan):
    # an edit that changes a pre-existing error's MESSAGE text (same
    # file/severity/section/param/code — e.g. the offending value quoted
    # in the message) must stay subtracted in the delta. Message text is
    # display-only here. `code` distinguishes same-location error classes;
    # `extra` is the ack discriminator (command name on gcode findings),
    # included so removing one unknown command from a macro does not read
    # as "new" for the remaining ones and vice versa.
    return "::".join(
        [
            filename,
            error.get("severity", ""),
            error.get("section", ""),
            error.get("param", ""),
            error.get("code", ""),
            error.get("extra", ""),
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
