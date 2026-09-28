"""Mechanical project-state ops for tool-mediated config editing (Phase 0).

A :class:`ProjectState` is a disposable, text-level working copy of the
user's config project (seeded from the request's ``contextFiles`` — the
app's live working state; there is NO per-conversation draft store, Sir's
decision 2026-09-12). The typed write ops of ``config_edit``/
``config_write`` are implemented here as deterministic text surgery:

- every op applies to raw file text (byte-stable for untouched lines —
  comments, blank lines, and formatting survive untouched by construction),
- the merged state is re-parsed and validated with the real validator,
- the delta-vs-baseline gate (message-free keys,
  ``ai_draft_validation.collect_new_validation_errors``) decides
  ``applied`` vs ``error``; warnings and retry-exempt codes ride along as
  non-blocking advisories.

Error results never raise: ops return structured ``{'status': 'error',
'error': ..., ...}`` dicts so the tool loop can hand them to the model as
tool results (kickback). ``patch_section`` anchor misses return the CURRENT
section text so the model can re-quote exactly (Claude Code edit-tool
pattern).
"""
from __future__ import annotations

import logging
import re
from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import PurePosixPath

from parser.config_parser import SAVE_CONFIG_BANNER_RE, parse_config
from parser.validator import validate_project_configs

from services.ai_draft_validation import (
    collect_new_validation_errors,
    is_retry_exempt,
)

RE_SECTION_HEADER = re.compile(r'^\[([^\]]+)\]\s*$')
# Param line inside a section body: key, separator (: or =). Mirrors the
# parser's param shape (column-indented).
RE_PARAM_LINE = re.compile(r'^(\s*)([A-Za-z_][A-Za-z0-9_.\-]*)\s*([:=])(.*)$')
# Commented-out param: '#'-prefixed key line (parser records these as
# is_commented_out params; the plain param regex never matches them).
RE_COMMENTED_PARAM_LINE = re.compile(r'^(\s*)#+\s*([A-Za-z_][A-Za-z0-9_.\-]*)\s*([:=])(.*)$')
# Include line, tolerating the trailing-comment shape KAMP writes:
# '[include ./KAMP/x.cfg]   # Include to enable ...'. RE_SECTION_HEADER
# anchors ']' to EOL, so with a trailing comment the line looked like
# "no include lines" and every include op failed even with the exact
# path (live KAMP trace 2026-09-20, round 2: model fell back to
# patch_section with an empty section and reported it impossible).
RE_INCLUDE_LINE = re.compile(r'^\s*\[include\s+([^\]]+)\]\s*(?:#.*)?$')


def _split_lines(text: str) -> list[str]:
    return text.split('\n')


def _save_config_start(lines: list[str]) -> int:
    """Index of the SAVE_CONFIG banner line, else len(lines).

    Mirrors config_parser._parse_save_config_sections (same regex, same
    semantics): from the '#*# <...SAVE_CONFIG...>' banner on, the file
    belongs to Klipper — it rewrites that block on every SAVE_CONFIG and
    the banner literally says DO NOT EDIT THIS BLOCK OR BELOW. No real
    section may own, span, or be inserted below this line.
    """
    for i, line in enumerate(lines):
        if SAVE_CONFIG_BANNER_RE.match(line.strip()):
            return i
    return len(lines)


def _insert_above_save_config(text: str, block_lines: list[str]) -> str:
    """Insert a section block (header + body lines) above the SAVE_CONFIG
    tail — at EOF when there is no tail. Every original line stays
    byte-identical; only the insertion point moves. (Dogfood
    2026-09-17: add_section/add_include appended at EOF, landing new
    sections BELOW the banner on SAVE_CONFIG'd printer.cfgs, where the
    next SAVE_CONFIG destroys them and the bare header breaks the
    '#*#' block parse.)"""
    if not text.strip():
        return '\n'.join(block_lines) + '\n'
    lines = _split_lines(text)
    banner = _save_config_start(lines)
    lines[banner:banner] = ['', *block_lines, '']
    return '\n'.join(lines)


def _find_section(lines: list[str], header: str) -> tuple[int, int] | None:
    """Return (header_index, body_end_index) for the first section whose
    header matches exactly, else None. body_end excludes the next header
    but includes trailing comments/blank lines owned by the section.

    Bounded by the SAVE_CONFIG banner: '#*# [probe]' lines never match
    RE_SECTION_HEADER, so an unbounded scan made the LAST real section
    own the whole tail — replace_section/delete_section on it rewrote or
    deleted the auto-generated block (same bug family as add-at-EOF)."""
    header_index = -1
    for i, line in enumerate(lines):
        match = RE_SECTION_HEADER.match(line)
        if match and match.group(1).strip() == header:
            header_index = i
            break
    if header_index == -1:
        return None
    end = _save_config_start(lines)
    for scan in range(header_index + 1, end):
        if RE_SECTION_HEADER.match(lines[scan]):
            end = scan
            break
    return header_index, end


def _include_lines(lines: list[str]) -> list[tuple[int, str]]:
    """(index, path) for every ACTIVE '[include <path>]' line in a file,
    including the trailing-comment shape KAMP writes."""
    out = []
    for idx, line in enumerate(lines):
        match = RE_INCLUDE_LINE.match(line)
        if match:
            out.append((idx, match.group(1).strip()))
    return out


def _missing_section_hint(files: dict[str, str], header: str,
                          filename: str) -> str:
    """Suffix for 'Section not found' errors: if the section exists in
    ANOTHER project file, name it. Wrong-file calls are the common cause
    in multi-file projects, and bare 'read the file first' sends models
    re-reading the SAME file — a dead loop that ends in 'the tool
    cannot do this' (live traces 2026-09-20). Resolution-aware
    (2026-09-27): a bare 'HOME' finds '[gcode_macro HOME]' in another
    file too, naming the FULL header the model should pass."""
    for other in sorted(files):
        if other == filename:
            continue
        other_lines = _split_lines(files[other])
        if _find_section(other_lines, header):
            return f" It exists in {other} — pass file='{other}'."
        resolved = _resolve_section_ref(header, other_lines)
        if resolved != header:
            return (f" It exists in {other} as '[{resolved}]' — pass "
                    f"file='{other}', section='{resolved}'.")
    return ''


def _header_name_part(header: str) -> str:
    """The instance-name part of a header: after the first space for
    family headers ('gcode_macro Level_Bed' -> 'Level_Bed'), else the
    header itself."""
    return header.split(' ', 1)[1] if ' ' in header else header


def _resolve_section_ref(requested: str, lines: list[str]) -> str:
    """Resolve a requested section reference to an actual header (live
    report 2026-09-27).

    Models habitually call config_edit with the BARE macro name
    (section='Level_Bed' for '[gcode_macro Level_Bed]'); every op then
    died on 'Section not found' and burned retry turns guessing the
    gcode_macro prefix back. Resolution: exact header wins; otherwise a
    bare (family-less) request matches the NAME PART of family headers
    — applied only when it is UNIQUE in the file. Ambiguous or absent
    returns the request unchanged so the caller's 'not found' path (and
    its cross-file hint) fires as before. Never invents a header for an
    absent name; add_section therefore still creates whatever the model
    asked for.
    """
    exact = re.compile(r'^\[([^\]]+)\]\s*$')
    headers = []
    for line in lines:
        match = exact.match(line)
        if match:
            headers.append(match.group(1).strip())
    if requested in headers:
        return requested
    if ' ' in requested:  # full-header form that simply isn't there
        return requested
    wanted = requested.casefold()
    matches = [h for h in headers if ' ' in h
               and _header_name_part(h).casefold() == wanted]
    distinct = list(dict.fromkeys(matches))
    if len(distinct) == 1:
        return distinct[0]
    return requested


def _ambiguous_section_hint(requested: str, lines: list[str]) -> str:
    """Suffix for 'Section not found' when a BARE name matches 2+ family
    headers (live report 2026-09-27): the resolution stays off (never
    pick one silently), but the error names the candidates so the model
    retries with a full header instead of guessing prefixes."""
    if ' ' in requested:
        return ''
    wanted = requested.casefold()
    matches = []
    for line in lines:
        match = RE_SECTION_HEADER.match(line)
        if not match:
            continue
        header = match.group(1).strip()
        if (' ' in header
                and _header_name_part(header).casefold() == wanted
                and header not in matches):
            matches.append(header)
    if len(matches) < 2:
        return ''
    return (f" Multiple sections match '{requested}' — pass one of these "
            f"full headers: {', '.join('[' + h + ']' for h in matches)}.")


def _include_target_matches(target: str, path: str) -> bool:
    """True when target_file addresses include path `path`.

    Three-way match (live trace 2026-09-20, KAMP): the model habitually
    addresses '[include ./KAMP/Adaptive_Meshing.cfg]' by basename or by
    the path without './'; exact-match-only made every sensible call
    fail 'not present' and the model confabulated that the edit tools
    cannot touch include lines outside a named section at all.
    Exact -> './'-normalized -> basename (callers enforce uniqueness).
    """
    t, p = target.strip(), path.strip()
    if t == p:
        return True
    t_norm, p_norm = t.removeprefix('./'), p.removeprefix('./')
    if t_norm == p_norm:
        return True
    return PurePosixPath(t_norm).name == PurePosixPath(p_norm).name


def _find_include_target(lines: list[str], target: str,
                         in_file: str) -> tuple[int | None, str | None, dict | None]:
    """Resolve target_file to an include-line index.

    Returns (index, quoted_path, None) on a unique match (quoted_path is
    the path exactly as written in the file, for summaries), or
    (None, None, error) for no match — the error lists the file's actual
    include lines so the model can re-quote — or an ambiguous basename
    (the error lists the candidates).
    """
    matches = [(idx, path) for idx, path in _include_lines(lines)
               if _include_target_matches(target, path)]
    if len(matches) == 1:
        idx, path = matches[0]
        return idx, path, None
    if len(matches) > 1:
        listed = ', '.join(f'[include {path}]' for _, path in matches)
        return None, None, _state_error(
            f"'{target}' is ambiguous in {in_file}: it matches multiple "
            f"includes: {listed}. Pass the exact path as written.")
    present = ', '.join(f'[include {path}]' for _, path in _include_lines(lines))
    return None, None, _state_error(
        f"[include {target}] not present in {in_file}."
        + (f" Includes in {in_file}: {present}. Pass the exact path as "
           "written." if present else f" {in_file} has no include lines."))


def _section_body_text(lines: list[str], header_index: int, end: int) -> str:
    body = lines[header_index + 1:end]
    # Trim trailing blank lines for display purposes only.
    while body and not body[-1].strip():
        body.pop()
    return '\n'.join(body)


def _default_body_indent(lines: list[str], header_index: int, end: int) -> str:
    for scan in range(header_index + 1, end):
        match = RE_PARAM_LINE.match(lines[scan])
        if match and match.group(2) != '_comment_':
            # Exact indent of the section's params (Klipper bodies are
            # usually column 0; coercing '' to spaces would turn the
            # inserted line into the PREVIOUS param's continuation).
            return match.group(1)
    return '    '


class _OpError(Exception):
    """Internal control flow: an op precondition failed. Caught by
    :meth:`ProjectState._apply_raw` and converted to a structured error
    result — ops never propagate exceptions to the tool loop."""

    def __init__(self, message: str, **extra):
        super().__init__(message)
        self.message = message
        self.extra = extra

    def to_result(self) -> dict:
        result = {'status': 'error', 'error': self.message}
        result.update(self.extra)
        return result


def _state_error(message: str, **extra) -> dict:
    result = {'status': 'error', 'error': message}
    result.update(extra)
    return result


def _finding_dedupe_key(filename: str, error: dict) -> tuple:
    """Identity of one finding for delta/control cancellation.

    Message is included deliberately here (unlike _error_key's
    message-free identity): control cancellation compares the SAME
    validator run's output shape, and message text is stable within a
    single candidate-vs-control comparison.
    """
    return (filename, error.get('severity', ''), error.get('section', ''),
            error.get('param', ''), error.get('code', ''),
            error.get('message', ''))


@dataclass
class ProjectState:
    """Disposable text-level working copy of the user's project."""
    files: dict[str, str] = field(default_factory=dict)

    # ── seeding / validation ────────────────────────────────────────────

    @classmethod
    def from_context_files(cls, context_files: dict[str, dict]) -> "ProjectState":
        """Seed from the frontend contextFiles payload ({name: {content}})."""
        files: dict[str, str] = {}
        for filename, meta in (context_files or {}).items():
            content = (meta or {}).get('content', '')
            files[filename] = content if isinstance(content, str) else ''
        return cls(files=files)

    def _parse_all(self) -> dict:
        configs: dict = {}
        for filename, content in self.files.items():
            if not content.strip():
                continue
            try:
                configs[filename] = parse_config(content, filename)
            except Exception:
                # A malformed file still participates as raw text; ops on
                # it stay legal (the user may be mid-edit). Validation of
                # the *merged* state reports whatever the parser finds.
                # Review fix 2026-09-26: log the skip — a parser CRASH
                # (vs a config error) silently removing a file from the
                # validation basis was undiagnosable.
                logging.getLogger(__name__).warning(
                    "File parse failed | excluded from parse basis file=%s",
                    filename, exc_info=True)
                continue
        return configs

    def validate(self) -> dict[str, dict]:
        configs = self._parse_all()
        if not configs:
            return {}
        # gcode_registry=True: the deliberate wiring-in the validator
        # docstring anticipated ("until the edit-tools branch wires them
        # deliberately", 2026-09-19). Sir's live report: SET_LED_COLOR
        # hallucinated into [idle_timeout] staged silently. Registry
        # findings are warning-tier, and warnings route to ADVISORIES in
        # the delta gate — visible to the model ('applied with N
        # advisories' + Did-you-mean) and on the approval card, never
        # blocking, so a plugin command the stock registry can't see
        # can't wedge an edit. Pre-existing unknowns sit in the baseline
        # too and cancel out of the delta.
        results = validate_project_configs(configs, gcode_registry=True)
        return {name: result.to_dict() for name, result in results.items()}

    def copy(self) -> "ProjectState":
        return ProjectState(files=dict(self.files))

    # ── delta gate ───────────────────────────────────────────────────────

    def control_state_for(self, op: dict) -> "ProjectState":
        """Pre-op state projected to the CANDIDATE's file set.

        Validation is mode-dependent: the validator runs project-wide
        include checks only when the file count is >1, so CREATING a file
        in a partial context conjures 'include not found' errors in files
        the op never touched (a 1-file context suddenly reports 12 errors
        when a second file appears — EDIT-04 live run, 2026-09-13).
        Comparing candidate vs the plain baseline blames all of them on
        the op: unfixable kickbacks → oscillation.

        For create ops the control adds a placeholder for the new file so
        file-set-dependent checks fire identically in control and
        candidate and cancel out of the delta; only findings actually
        caused by the new file's CONTENT survive. Delete ops keep the
        plain pre-op control: breaking an include by deleting the
        included file IS a real, fixable error and must kick back.
        """
        control = self.copy()
        op_file = op.get('file', '')
        kind = op.get('op', '')
        if kind in ('new_file', 'write_file') and op_file and op_file not in self.files:
            # Comment-only content: _parse_all keeps it (non-blank) so the
            # file COUNTS toward the >1 project-mode threshold — the
            # include scan fires in control exactly as in candidate and
            # cancels out of the delta — while producing zero findings of
            # its own that could skew the comparison.
            control.files[op_file] = '# control placeholder\n'
        return control

    def _delta_findings(self, baseline: dict[str, dict],
                        control: "ProjectState | None" = None) -> dict:
        """Run the delta gate against a baseline validation.

        Returns ``{'new_errors': [...], 'advisories': [...]}`` where
        ``new_errors`` are NEW blocking findings that CAN be fixed by a
        re-attempt, and ``advisories`` are new warnings + new instances of
        retry-exempt codes (visible to the model, non-blocking — can't be
        regenerated away, don't loop).

        ``control`` (see :meth:`control_state_for`) validates a pre-op
        state projected to the candidate's file set; its findings are
        subtracted alongside the baseline so file-set-mode artifacts never
        reach the model.
        """
        candidate = self.validate()
        issues = collect_new_validation_errors(baseline, candidate)
        control_keys: set[tuple] = set()
        if control is not None:
            control_validation = control.validate()
            for group in collect_new_validation_errors(baseline, control_validation):
                for error in group['errors']:
                    control_keys.add(_finding_dedupe_key(group['filename'], error))
        new_errors: list[dict] = []
        advisories: list[dict] = []
        seen_keys: set[tuple] = set()
        for group in issues:
            for error in group['errors']:
                finding = {
                    'filename': group['filename'],
                    'severity': error.get('severity', ''),
                    'section': error.get('section', ''),
                    'param': error.get('param', ''),
                    'message': error.get('message', ''),
                    'code': error.get('code', ''),
                }
                # Dedupe: the validator re-derives some cross-file checks
                # per file count, so 1-file -> 2-file deltas can repeat an
                # identical finding. The model sees it once.
                dedupe_key = _finding_dedupe_key(group['filename'], error)
                if dedupe_key in seen_keys or dedupe_key in control_keys:
                    continue
                seen_keys.add(dedupe_key)
                if error.get('severity') == 'warning' or is_retry_exempt(error):
                    finding['advisory'] = True
                    advisories.append(finding)
                else:
                    new_errors.append(finding)
        return {'new_errors': new_errors, 'advisories': advisories}

    # ── op application + gate ────────────────────────────────────────────

    def apply(self, baseline_validations: dict[str, dict], op: dict) -> tuple["ProjectState", dict]:
        """Apply one op to a COPY, then run the delta gate.

        Returns ``(new_state, result)``; ``result`` is the structured tool
        result: ``{'status': 'applied'|'applied_with_advisory'|'error',
        'file', 'op', 'summary', 'newErrors', 'advisories', 'diff'}``.
        On error ``new_state`` is the unchanged copy (nothing was written).
        """
        new_state = self.copy()
        outcome = new_state._apply_raw(op)
        if outcome['status'] == 'error':
            return self.copy(), outcome
        findings = new_state._delta_findings(baseline_validations,
                                             control=self.control_state_for(op))
        base_text = self.files.get(outcome['file'], '')
        after_text = new_state.files.get(outcome['file'], '')
        result = {
            'status': 'applied' if not findings['new_errors'] else 'error',
            'file': outcome['file'],
            'op': op.get('op', ''),
            'summary': outcome.get('summary', ''),
            'newErrors': findings['new_errors'],
            'advisories': findings['advisories'],
            'diff': {'file': outcome['file'], 'before': base_text, 'after': after_text},
        }
        # rename_section carries structured from/to through the raw outcome
        # for the chat layer's post-rename directive (see _op_rename_section).
        for k in ('renamed_from', 'renamed_to'):
            if k in outcome:
                result[k] = outcome[k]
        if result['status'] == 'error':
            # Validation failure = kickback: the state copy is discarded by
            # the caller (we hand back the UNCHANGED state). Add the kick-
            # back display fields the loop formats (REPAIR-01 lean shape).
            result['error'] = 'The change failed validation after merging. Fix and re-attempt.'
            result['status'] = 'error'
            return self.copy(), result
        if findings['advisories']:
            result['status'] = 'applied_with_advisory'
        return new_state, result

    def apply_no_gate(self, op: dict) -> tuple["ProjectState", dict]:
        """Apply without validation (unit-test/REPL helper; routes use
        :meth:`apply`)."""
        new_state = self.copy()
        outcome = new_state._apply_raw(op)
        if outcome['status'] == 'error':
            return self.copy(), outcome
        outcome.setdefault('newErrors', [])
        outcome.setdefault('advisories', [])
        return new_state, outcome

    # ── raw text surgery ─────────────────────────────────────────────────

    def _apply_raw(self, op: dict) -> dict:
        kind = op.get('op', '')
        handler = {
            'set_param': self._op_set_param,
            'add_section': self._op_add_section,
            'replace_section': self._op_replace_section,
            'delete_section': self._op_delete_section,
            'rename_section': self._op_rename_section,
            'patch_section': self._op_patch_section,
            'comment_section': self._op_comment_section,
            'uncomment_section': self._op_uncomment_section,
            'new_file': self._op_new_file,
            'delete_file': self._op_delete_file,
            'add_include': self._op_add_include,
            'remove_include': self._op_remove_include,
            'comment_include': self._op_comment_include,
        }.get(kind)
        if handler is None:
            return _state_error(
                f"Unknown op '{kind}'. Valid ops: set_param, add_section, "
                "replace_section, delete_section, rename_section, "
                "patch_section, comment_section, uncomment_section, "
                "delete_file, add_include, remove_include, comment_include "
                "— use exactly one of these, one op per call.")
        try:
            return handler(self._resolve_op_section(op))
        except _OpError as exc:  # precondition failure — structured, no raise
            return exc.to_result()
        except KeyError as exc:  # missing required arg — structured, no raise
            return _state_error(f"Missing required argument for {kind}: {exc.args[0]}")

    def _resolve_op_section(self, op: dict) -> dict:
        """Rewrite op['section'] to the actual header it refers to (live
        report 2026-09-27, see :func:`_resolve_section_ref`). Applied
        centrally so EVERY section op — set_param, patch_section, rename,
        delete, replace, and add_section's duplicate check — resolves a
        bare macro name identically; per-handler fixing left the loop's
        second guesses scattered. No-op when file/section are missing or
        the name doesn't resolve (the handler's own error paths, incl.
        the cross-file and ambiguity hints, then fire unchanged)."""
        section = (op.get('section') or '').strip().strip('[]').strip()
        filename = op.get('file')
        if not section or ' ' in section or filename not in self.files:
            return op
        resolved = _resolve_section_ref(section, _split_lines(self.files[filename]))
        if resolved == section:
            return op
        new_op = dict(op)
        new_op['section'] = resolved
        return new_op

    def _require_file(self, filename: str | None) -> str:
        if not filename:
            raise _OpError(
                'Missing required argument: file (the project file to '
                "edit, e.g. 'printer.cfg')")
        if filename not in self.files:
            known = ', '.join(sorted(self.files)) or '(none)'
            raise _OpError(f"File '{filename}' is not in the project. Known files: {known}.")
        return filename

    @staticmethod
    def _require_header(op: dict) -> str:
        section = (op.get('section') or '').strip()
        if not section:
            raise _OpError(
                'Missing required argument: section (section header '
                "without brackets, e.g. 'idle_timeout')")
        header = section.strip('[]').strip()
        # Include-shaped section (live KAMP trace family 2026-09-20):
        # models pass section='include' or 'include ./x.cfg' to
        # set_param/replace_section/delete_section as their second guess
        # at editing an include line. The generic 'section not found'
        # reads as a capability gap; name the include ops instead.
        if header == 'include' or header.startswith('include '):
            raise _OpError(
                "'[include ...]' lines are not a section — to disable one "
                "use op='comment_include' (keeps it as '#[include ...]'), "
                "to delete it op='remove_include'; both take "
                "target_file=<path inside the include brackets>.")
        return header

    # -- set_param ---------------------------------------------------------

    def _op_set_param(self, op: dict) -> dict:
        filename = self._require_file(op.get('file'))
        header = self._require_header(op)
        key = (op.get('key') or '').strip()
        if not key:
            return _state_error(
                'Missing required argument: key — set_param needs '
                'file, op, section, key, value (value is ONE LINE; multi-line '
                'bodies use replace_section)')
        if 'value' not in op:
            return _state_error(
                "Missing required argument: value — set_param needs "
                "file, op, section, key, value (the new value goes in the "
                "'value' field; if you put it in 'new_text' instead, resend "
                "with value). Multi-line bodies use replace_section")
        value = str(op['value'])

        lines = _split_lines(self.files[filename])
        found = _find_section(lines, header)
        if found is None:
            return _state_error(
                f"Section '[{header}]' not found in {filename}."
                + _ambiguous_section_hint(header, lines)
                + _missing_section_hint(self.files, header, filename)
                + " Read the file first or use add_section for a new section."
            )
        header_index, end = found
        body_indent = _default_body_indent(lines, header_index, end)

        active_matches = []
        commented_matches = []
        for scan in range(header_index + 1, end):
            match = RE_PARAM_LINE.match(lines[scan])
            if match and match.group(2) == key:
                active_matches.append((scan, match))
                continue
            cmatch = RE_COMMENTED_PARAM_LINE.match(lines[scan])
            if cmatch and cmatch.group(2) == key:
                commented_matches.append((scan, cmatch))

        if active_matches:
            scan, match = active_matches[0]
            indent, sep = match.group(1), match.group(3)
            rest = match.group(4)
            trailing = _extract_trailing_comment(rest)
            value_lines = value.split('\n')
            rendered = [f"{indent}{key}{sep} {value_lines[0]}{trailing}"]
            cont_indent = indent + '    '
            for extra in value_lines[1:]:
                rendered.append(f"{cont_indent}{extra}" if extra else '')
            lines[scan:scan + 1] = rendered
            self.files[filename] = '\n'.join(lines)
            return {'status': 'ok', 'file': filename,
                    'summary': f"set [{header}] {key} = {value_lines[0]}"}

        if commented_matches:
            # A commented-only param is set by uncommenting the line IN
            # PLACE (2026-09-20: the old refusal forced a prose ask-before-
            # edit dance; the approval-card diff is the confirmation now —
            # the user sees the red commented line turn green). Inserting
            # a fresh active line instead would leave a duplicate dormant
            # key behind, so rewrite the commented line itself.
            scan, cmatch = commented_matches[0]
            indent = cmatch.group(1)
            value_lines = value.split('\n')
            rendered = [f"{indent}{key}: {value_lines[0]}"]
            for extra in value_lines[1:]:
                rendered.append(f"{indent}    {extra}" if extra else '')
            lines[scan:scan + 1] = rendered
            self.files[filename] = '\n'.join(lines)
            return {'status': 'ok', 'file': filename,
                    'summary': f"set [{header}] {key} = {value_lines[0]} "
                    "(this uncommented the parameter — it was commented "
                    "out before)"}

        # Insert: after the last real param line of the section body,
        # before trailing comments/blanks.
        insert_at = header_index + 1
        for scan in range(header_index + 1, end):
            match = RE_PARAM_LINE.match(lines[scan])
            if match and not lines[scan].lstrip().startswith('#'):
                insert_at = scan + 1
        value_lines = value.split('\n')
        rendered = [f"{body_indent}{key}: {value_lines[0]}"]
        for extra in value_lines[1:]:
            rendered.append(f"{body_indent}    {extra}" if extra else '')
        lines[insert_at:insert_at] = rendered
        self.files[filename] = '\n'.join(lines)
        return {'status': 'ok', 'file': filename,
                'summary': f"added [{header}] {key} = {value_lines[0]}"}

    # -- sections ----------------------------------------------------------

    @staticmethod
    def _top_level_keys(body_lines: list[str]) -> set[str]:
        """Param keys at the body's BASE indent (active lines only).

        Key lines sit at the body's base indent — which varies by file
        style ('timeout: 300' vs '    timeout: 300') — while multi-line
        value continuations are always indented deeper, so the base is
        the MINIMUM indent among param-looking lines. Comments/blank
        lines are ignored, so moving a param into a comment counts as a
        drop and warns. Best-effort heuristic for a warning path;
        sloppy mixed-indent files may under-report, never over-block."""
        matches = []
        for line in body_lines:
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            match = RE_PARAM_LINE.match(line)
            if match:
                matches.append((len(match.group(1)), match.group(2)))
        if not matches:
            return set()
        base = min(indent for indent, _ in matches)
        return {key for indent, key in matches if indent == base}

    def _op_add_section(self, op: dict) -> dict:
        filename = self._require_file(op.get('file'))
        header = self._require_header(op)
        body = op.get('text')
        if body is None:
            return _state_error(
                f"add_section needs the section body in 'text' "
                f"(no empty sections -- [{header}] with no parameters does "
                "nothing)."
            )
        if not isinstance(body, str):
            return _state_error('Argument text must be a string')
        if _find_section(self.files[filename].split('\n'), header) is not None:
            return _state_error(
                f"Section '[{header}]' already exists in {filename}. "
                "Use replace_section or set_param to change it."
            )
        # Reject a header line duplicated inside the model-authored body.
        for line in body.split('\n'):
            match = RE_SECTION_HEADER.match(line)
            if match and match.group(1).strip() == header:
                return _state_error(
                    f"Argument text must be the section BODY only (no '[{header}]' header line)."
                )
        block = [f'[{header}]']
        if body.strip():
            block.extend(body.strip('\n').split('\n'))
        self.files[filename] = _insert_above_save_config(
            self.files[filename], block)
        return {'status': 'ok', 'file': filename, 'summary': f"added section [{header}] to {filename}"}

    def _op_replace_section(self, op: dict) -> dict:
        filename = self._require_file(op.get('file'))
        header = self._require_header(op)
        body = op.get('text')
        if body is None:
            # A missing 'text' used to default to '' -- a SILENT SECTION
            # WIPE (fullbank edit-tools run 2026-09-14: gemma passed
            # patch-style old_text/new_text with op=replace_section; the
            # handler read only 'text', replaced the body with nothing,
            # and an empty section validates clean, so the corruption
            # reached staging). Emptying a section IS a legitimate
            # move -- but only when the caller says so explicitly.
            return _state_error(
                f"replace_section needs the full new body of [{header}] in "
                "'text' (pass text: \"\" to intentionally empty it). To edit "
                "part of the body, use op=patch_section with old_text/new_text."
            )
        if not isinstance(body, str):
            return _state_error('Argument text must be a string')
        lines = _split_lines(self.files[filename])
        found = _find_section(lines, header)
        if found is None:
            return _state_error(
                f"Section '[{header}]' not found in {filename}."
                + _ambiguous_section_hint(header, lines)
                + _missing_section_hint(self.files, header, filename)
                + " Read the file first."
            )
        header_index, end = found
        # Keep the section's trailing blank-line gutter before the next header.
        tail: list[str] = []
        scan = end
        while scan - 1 > header_index and not lines[scan - 1].strip():
            tail.insert(0, lines[scan - 1])
            scan -= 1
        inner_end = scan
        body_stripped = body.strip('\n')
        for line in body_stripped.split('\n'):
            match = RE_SECTION_HEADER.match(line)
            if match and match.group(1).strip() != header:
                return _state_error(
                    f"Argument text must contain only the body of [{header}] "
                    f"(found foreign header '[{match.group(1).strip()}]')."
                )
        # A text that OPENS with the section's own header (models habitually
        # include it) is the body-plus-header shape, not body-only. Strip
        # one leading header line -- without this, keeping the header in the
        # body duplicates '[header]' in the file, and the FIRST duplicate
        # swallows the section at validate time, so the real content
        # silently disappears (r2 TRIDENT-15: staged [idle_timeout] read
        # back empty and validation stayed silent).
        if new_body_pre := body_stripped:
            first = RE_SECTION_HEADER.match(new_body_pre.split('\n')[0])
            if first and first.group(1).strip() == header:
                rest_lines = new_body_pre.split('\n')[1:]
                body_stripped = '\n'.join(rest_lines).strip('\n')
        new_body = body_stripped.split('\n') if body_stripped else []
        # (2026-09-20: the comment-boundary refusal was removed — comment
        # status flips are applied as-told and surface in the approval-
        # card diff, which is the user's confirmation.)
        old_body_lines = lines[header_index + 1:inner_end]
        lines[header_index + 1:inner_end] = new_body
        self.files[filename] = '\n'.join(lines)
        summary = f"replaced body of [{header}] in {filename}"
        # Dropped-parameter warning (tnf-s1 r2 2026-09-19): replace_section
        # owns the ENTIRE body, so a model that writes a partial body (the
        # gcode: block alone) silently wipes every other param it had
        # staged or that existed — timeout: 300 vanished right after
        # set_param had staged it, with zero feedback. Semantics stay
        # as-told; the success output now names what disappeared so the
        # model can resend a full body on the next turn (intentional
        # deletions: the user just sees it in the diff anyway).
        old_top = self._top_level_keys(old_body_lines)
        new_top = self._top_level_keys(new_body)
        lost = sorted(old_top - new_top)
        if lost:
            summary += (
                f" — WARNING: {[k for k in lost]} existed in the previous "
                f"body and is GONE from your replacement. If unintentional, "
                f"resend replace_section with the FULL new body including "
                f"them.")
        return {'status': 'ok', 'file': filename, 'summary': summary}

    def _op_delete_section(self, op: dict) -> dict:
        filename = self._require_file(op.get('file'))
        header = self._require_header(op)
        lines = _split_lines(self.files[filename])
        found = _find_section(lines, header)
        if found is None:
            return _state_error(
                f"Section '[{header}]' not found in {filename}."
                + _ambiguous_section_hint(header, lines)
                + _missing_section_hint(self.files, header, filename))
        header_index, end = found
        while end > header_index + 1 and not lines[end - 1].strip():
            end -= 1
        del lines[header_index:end]
        # Collapse any double blank line left at the splice point.
        self.files[filename] = re.sub(r'\n{3,}', '\n\n', '\n'.join(lines))
        return {'status': 'ok', 'file': filename, 'summary': f"deleted section [{header}] from {filename}"}

    def _op_rename_section(self, op: dict) -> dict:
        """Rewrite a section's HEADER line, body untouched (byte-stable).

        Rename requests (macro or section) previously required the model
        to improvise delete+re-add — two approval cards, re-typed body
        (dropped params, mangled indentation), and a dangling-reference
        window between the cards. This op is the single-call path: only
        the header line changes, so the body survives exactly as-is and
        the whole rename rides ONE card.

        Family-prefix inheritance (live report 2026-09-26): asked to
        "rename the gcode macro Level_Bed to level_bed1", the model sends
        new_section='level_bed1' — the NAME only, not a header — and the
        op happily wrote '[level_bed1]', a section Klipper knows nothing
        about. A Klipper header is 'family' or 'family name' (the family
        is the first token, e.g. 'gcode_macro' in 'gcode_macro Level_Bed').
        So when new_section carries no space (no family of its own) and
        the SOURCE header has one, the source family is prefixed to the
        new name; the user's casing for the name part is preserved
        exactly as typed. A full header in new_section is honored
        verbatim (family switches included) — pass the full header to
        override. Headers without a family stay bare: no family is ever
        invented.
        """
        filename = self._require_file(op.get('file'))
        header = self._require_header(op)
        new_raw = (op.get('new_section') or '').strip()
        if not new_raw:
            return _state_error(
                "Missing required argument: new_section — the new header "
                "without brackets, e.g. 'gcode_macro PRINT_START'")
        new_header = new_raw.strip('[]').strip()
        if not new_header:
            return _state_error(
                f"new_section '{new_raw}' is not a section header")
        # Inherit the source header's family for a bare new name (see
        # docstring). Everything below — include guard, no-op, duplicate
        # lookup, written header, summary — works on this FINAL header.
        inherited_family = False
        if ' ' not in new_header and ' ' in header:
            new_header = f"{header.split(' ', 1)[0]} {new_header}"
            inherited_family = True
        if new_header == 'include' or new_header.startswith('include '):
            return _state_error(
                "Cannot rename a section to '[include ...]' — include "
                "lines are managed with add_include / remove_include / "
                "comment_include.")
        if new_header == header:
            return _state_error(
                f"Section '[{header}]' is already named '[{new_header}]'.")
        lines = _split_lines(self.files[filename])
        found = _find_section(lines, header)
        if found is None:
            return _state_error(
                f"Section '[{header}]' not found in {filename}."
                + _ambiguous_section_hint(header, lines)
                + _missing_section_hint(self.files, header, filename))
        if _find_section(lines, new_header) is not None:
            return _state_error(
                f"Section '[{new_header}]' already exists in {filename} — "
                "rename would create a duplicate. Delete or rename that "
                "section first, or use replace_section on it instead.")
        header_index, _end = found
        # RE_SECTION_HEADER anchors ']' to EOL, so a matched header line
        # carries no trailing comment — replacing the whole line is safe.
        lines[header_index] = f'[{new_header}]'
        self.files[filename] = '\n'.join(lines)
        summary = (f"renamed section '[{header}]' to '[{new_header}]' "
                   f"in {filename}")
        if inherited_family:
            # Tells the model what header it actually created, so the
            # next turn reasons about the real section name.
            summary += ' (inherited family prefix from the original section)'
        return {'status': 'ok', 'file': filename, 'summary': summary,
                # Structured keys for the chat layer: a macro rename
                # leaves STALE CALLERS behind (unknown_gcode advisories);
                # ai_edit_tools uses these to append the fix-them
                # directive without parsing prose.
                'renamed_from': header, 'renamed_to': new_header}

    # -- patch_section -----------------------------------------------------

    # -- comment_section / uncomment_section -------------------------------

    @staticmethod
    def _find_commented_section(lines: list[str],
                                header: str) -> tuple[int, int] | None:
        """(header_index, end) for a '#'-prefixed section header whose
        inner name matches `header` (e.g. '#[gcode_macro T3]' matches
        'gcode_macro T3'). Symmetric with _find_section: the block runs
        to the next ACTIVE or commented header, bounded by SAVE_CONFIG.

        Needed because RE_SECTION_HEADER never matches commented headers,
        so uncomment requests looked 'impossible' to every section op
        (Clifford's comment/uncomment toolset request, 2026-09-28)."""
        re_commented = re.compile(r'^\s*#+\s*\[([^\]]+)\]\s*$')
        header_index = -1
        for i, line in enumerate(lines):
            match = re_commented.match(line)
            if match and match.group(1).strip() == header:
                header_index = i
                break
        if header_index == -1:
            return None
        end = _save_config_start(lines)
        for scan in range(header_index + 1, end):
            if RE_SECTION_HEADER.match(lines[scan]) \
                    or re_commented.match(lines[scan]):
                end = scan
                break
        return header_index, end

    def _op_comment_section(self, op: dict) -> dict:
        """Disable a whole section: '#' the [header] line and every
        non-blank body line in ONE staged card (2026-09-28 toolset gap:
        patch_section could only comment the BODY, leaving an active
        header over a dead block, and the [header] line itself was out
        of reach — Klipper still parses '[foo]' + commented body as a
        (zero-param, usually invalid) section).

        Blank lines stay blank. Lines that are already comments gain a
        second '#' — that is intentional: uncomment_section reverses
        exactly one '#' level, so a comment/uncomment round trip is
        lossless."""
        filename = self._require_file(op.get('file'))
        header = self._require_header(op)
        lines = _split_lines(self.files[filename])
        found = _find_section(lines, header)
        if found is None:
            commented = self._find_commented_section(lines, header)
            if commented is not None:
                return _state_error(
                    f"Section '[{header}]' in {filename} is ALREADY "
                    "commented out. To restore it use "
                    "op='uncomment_section'.")
            return _state_error(
                f"Section '[{header}]' not found in {filename}."
                + _ambiguous_section_hint(header, lines)
                + _missing_section_hint(self.files, header, filename))
        header_index, end = found
        # Boundary clamp: _find_section's end stops only at ACTIVE headers,
        # so a dormant '#[other]' block directly below would get swallowed
        # and double-#'-d (and uncomment_section's own boundary scan would
        # then strand it). Never touch another section's commented block.
        re_other_commented = re.compile(r'^#\s*\[([^\]]+)\]')
        for scan in range(header_index + 1, end):
            m = re_other_commented.match(lines[scan])
            if m and m.group(1).strip() != header:
                end = scan
                break
        count = 0
        for scan in range(header_index, end):
            if lines[scan].strip():
                lines[scan] = '#' + lines[scan]
                count += 1
        self.files[filename] = '\n'.join(lines)
        return {'status': 'ok', 'file': filename,
                'summary': f"commented out section '[{header}]' in "
                           f"{filename} ({count} lines, header included)"}

    def _op_uncomment_section(self, op: dict) -> dict:
        """Re-enable a commented-out section: strip ONE leading '#' from
        the '#[header]' line and each non-blank body line (mirrors
        comment_section exactly). A body line that was a plain comment
        before the block was commented ('## old note') correctly becomes
        '# old note' again. Refuses when the block contains no commented
        content to strip and the section is already active."""
        filename = self._require_file(op.get('file'))
        header = self._require_header(op)
        lines = _split_lines(self.files[filename])
        found = self._find_commented_section(lines, header)
        if found is None:
            active = _find_section(lines, header)
            if active is not None:
                return _state_error(
                    f"Section '[{header}]' in {filename} is not "
                    "commented out — it is already active.")
            return _state_error(
                f"No commented-out section '[{header}]' found in "
                f"{filename}." + _missing_section_hint(self.files, header,
                                                       filename))
        header_index, end = found
        # Strip EXACTLY one leading '#' (no space-eating): comment_section
        # prepends bare '#', so '#    G28' must restore to '    G28' with
        # its original indent, and '## old note' to '# old note'. Eating
        # an optional space here shifted every restored line one column
        # left (round-trip lossiness caught by unit test, 2026-09-28).
        re_strip = re.compile(r'^(\s*)#(.*)$')
        count = 0
        for scan in range(header_index, end):
            if not lines[scan].strip():
                continue
            match = re_strip.match(lines[scan])
            if match:
                lines[scan] = match.group(1) + match.group(2)
                count += 1
        # Guard: a section whose header lost its '#' but whose body had
        # no commented content would silently keep dead params; the
        # re-parse below cannot happen here, so assert the header is now
        # a plain header line.
        if not RE_SECTION_HEADER.match(lines[header_index]):
            return _state_error(
                f"uncomment_section could not restore '[{header}]' in "
                f"{filename} — the header line is not a section header "
                "after stripping '#'.")
        self.files[filename] = '\n'.join(lines)
        return {'status': 'ok', 'file': filename,
                'summary': f"uncommented section '[{header}]' in "
                           f"{filename} ({count} lines restored)"}

    @staticmethod
    def _commented_top_level_keys(body_lines: list[str]) -> set[str]:
        """Param keys present ONLY in '#'-commented form at the body's
        base indent — the shape a deliberate comment-out produces."""
        matches = []
        for line in body_lines:
            if not line.strip() or not line.lstrip().startswith('#'):
                continue
            match = RE_COMMENTED_PARAM_LINE.match(line)
            if match:
                matches.append((len(match.group(1)), match.group(2)))
        if not matches:
            return set()
        base = min(indent for indent, _ in matches)
        return {key for indent, key in matches if indent == base}

    @staticmethod
    def _drop_warning(old_body_lines: list[str],
                      new_body_lines: list[str]) -> str:
        """Suffix naming top-level params that a patch/replace removed.

        Same hazard as the replace_section warning (tnf-s1 r2): models
        ANCHOR patches on an existing param line (often the only body
        line, e.g. 'timeout: 1800' in [idle_timeout]) and forget to
        re-include it in new_text when their intent was to ADD lines —
        the string replace then silently deletes the anchor. Applied-as-
        told semantics stay; the success output makes the loss visible
        so the next turn can fix it. (Sir's live diff report 2026-09-19:
        approval gate showed patch_section dropping timeout: 1800.)

        Comment-out exemption (2026-09-28): keys that survive the edit in
        '#'-commented form are DISABLED, not lost — the text is still on
        the card and the red/green diff shows it. Without this exemption
        every deliberate comment via patch_section screamed 'key is GONE,
        resend', pushing models to undo correct edits. A key commented
        at a DEEPER indent than the body base is still treated as lost
        (buried in a multi-line value = the original hazard)."""
        lost = sorted(ProjectState._top_level_keys(old_body_lines)
                      - ProjectState._top_level_keys(new_body_lines)
                      - ProjectState._commented_top_level_keys(new_body_lines))
        if not lost:
            return ''
        return (
            f" — WARNING: {[k for k in lost]} existed in the section "
            f"before this edit and is GONE from the result. If you meant "
            f"to ADD lines rather than delete them, include the quoted "
            f"anchor lines inside new_text and resend.")

    def _op_patch_section(self, op: dict) -> dict:
        filename = self._require_file(op.get('file'))
        # Include-line misroute (live KAMP trace 2026-09-20): models
        # delete/comment top-of-file '[include ...]' lines by calling
        # patch_section with an empty section — which has no named section
        # to anchor on. A generic 'missing section' error reads as "the
        # tools can't do this"; name the right op instead. Fires ONLY
        # on an empty section: an old_text that merely contains
        # '[include' inside a real named section stays patchable (macro
        # text quoting that string is legal).
        old_probe = op.get('old_text') or ''
        if not (op.get('section') or '').strip() and isinstance(old_probe, str) \
                and '[include' in old_probe:
            return _state_error(
                "patch_section edits inside a named section; '[include ...]' "
                "lines live outside sections. To disable an include line "
                "use op='comment_include' (keeps it as '#[include ...]'), "
                "to delete it use op='remove_include' — both take "
                "target_file=<path inside the include brackets>. One op "
                "per include line.")
        header = self._require_header(op)
        old_text = op.get('old_text')
        new_text = op.get('new_text')
        if not isinstance(old_text, str) or not old_text:
            return _state_error('Missing required argument: old_text (quote lines exactly as read returned them)')
        if not isinstance(new_text, str):
            return _state_error('Missing required argument: new_text')

        lines = _split_lines(self.files[filename])
        found = _find_section(lines, header)
        if found is None:
            return _state_error(
                f"Section '[{header}]' not found in {filename}."
                + _ambiguous_section_hint(header, lines)
                + _missing_section_hint(self.files, header, filename)
                + " Read the file first."
            )
        # No-op guard (live report 2026-09-26): a rename attempt landed as
        # patch_section with old_text == new_text; the string replace
        # "succeeded" and the op reported 'patched [...]' while the file
        # stayed byte-identical — a FALSE success the model relayed to
        # the user ("patched [controller_fan _stepper_fan]" for a rename
        # that never happened). A patch that changes nothing must say so,
        # and name the real tool for the most common no-op shape.
        if old_text == new_text:
            return _state_error(
                f"patch_section made NO change: old_text and new_text are "
                f"identical. To rename the section itself use "
                f"op='rename_section' with new_section=<new header>; "
                f"otherwise quote the lines you actually want to change."
            )
        header_index, end = found
        section_lines = lines[header_index + 1:end]
        section_text = '\n'.join(section_lines)
        # (2026-09-20: the comment-boundary refusals — anchoring inside a
        # commented param line, and '#' status crossings between
        # old_text/new_text — were removed. Comment flips and dormant-
        # text edits are applied as-told; the approval-card diff shows
        # the red commented line turning green, and the user's approval
        # is the confirmation. The old two-step refusal pushed the model
        # into prose asks with no tool call, which read as a broken
        # edit flow.)
        occurrences = _count_substring_occurrences(section_text, old_text)
        if occurrences == 1:
            patched = section_text.replace(old_text, new_text, 1)
        elif occurrences > 1:
            return _state_error(
                f"old_text matches {occurrences} places in [{header}] — quote MORE "
                "context lines so the target is unique.",
                sectionText=section_text,
            )
        else:
            # Indent-tolerant line-anchored fallback: the model's quote
            # matched modulo leading whitespace (one round-trip cheaper).
            match_range = _find_indent_tolerant(section_lines, old_text)
            if match_range is None:
                return _state_error(
                    f"old_text not found in [{header}] of {filename}. The section's "
                    "CURRENT text follows — quote lines exactly as they appear here:\n"
                    f"---\n{section_text}\n---",
                    sectionText=section_text,
                )
            start, stop = match_range
            new_lines = _reindent_like(new_text, section_lines[start])
            lines[header_index + 1 + start:header_index + 1 + stop] = new_lines
            self.files[filename] = '\n'.join(lines)
            found2 = _find_section(lines, header)
            new_body = lines[found2[0] + 1:found2[1]] if found2 else []
            return {'status': 'ok', 'file': filename,
                    'summary': f"patched [{header}] in {filename}"
                    + self._drop_warning(section_lines, new_body)}
        patched_lines = patched.split('\n')
        lines[header_index + 1:end] = patched_lines
        self.files[filename] = '\n'.join(lines)
        return {'status': 'ok', 'file': filename,
                'summary': f"patched [{header}] in {filename}"
                + self._drop_warning(section_lines, patched_lines)}

    # -- files & includes ---------------------------------------------------

    def _op_new_file(self, op: dict) -> dict:
        filename = (op.get('file') or '').strip()
        if not filename:
            return _state_error('Missing required argument: file')
        if filename in self.files:
            return _state_error(
                f"File '{filename}' already exists. config_write creates NEW files only; "
                "edit existing files with set_param/patch_section/replace_section."
            )
        content = op.get('content', '')
        if not isinstance(content, str):
            return _state_error('Argument content must be a string')
        self.files[filename] = content if content.endswith('\n') or not content else content + '\n'
        return {'status': 'ok', 'file': filename, 'summary': f"created new file {filename}"}

    def _op_delete_file(self, op: dict) -> dict:
        filename = self._require_file(op.get('file'))
        if filename.lower() == 'printer.cfg':
            return _state_error("printer.cfg is the root config and cannot be deleted.")
        # Dangling-include guard (audit 2026-09-20): deleting an included
        # file left '[include <file>]' behind in the includer, and the
        # validator does NOT flag dangling includes — the staged config
        # would not even start Klipper, with nothing naming the cause.
        # Match by basename: includes are relative paths and the project
        # store keys files by name.
        for other in sorted(self.files):
            if other == filename:
                continue
            for _, path in _include_lines(_split_lines(self.files[other])):
                if path == filename or PurePosixPath(path).name == filename:
                    return _state_error(
                        f"Cannot delete {filename}: it is still included "
                        f"([include {path}] in {other}). Remove the "
                        "include first: config_edit op='remove_include', "
                        f"file='{other}', target_file='{path}' (or "
                        "op='comment_include' to keep the line disabled).")
        del self.files[filename]
        return {'status': 'ok', 'file': filename, 'summary': f"deleted file {filename}"}

    def _op_add_include(self, op: dict) -> dict:
        target = (op.get('target_file') or '').strip()
        if not target:
            return _state_error('Missing required argument: target_file')
        in_file = self._require_file(op.get('file') or 'printer.cfg')
        if target == in_file:
            # Klipper resolves includes into one namespace; a file
            # including itself is a circular load error the validator
            # does NOT flag (live 9b r2 finding: model passed
            # target_file=printer.cfg and the op accepted it).
            return _state_error(
                f"A file cannot include itself ({in_file}). Include the NEW "
                f"file's name (e.g. target_file='park_macros.cfg'), not the "
                f"file the include line is written into."
            )
        lines = _split_lines(self.files[in_file])
        header = f"include {target}"
        # Duplicate guard: './x' and 'x' resolve to the SAME file in
        # Klipper (includes are config-dir relative), so an exact-string
        # check let a double-load slip past when the existing line was
        # e.g. '[include ./KAMP/x.cfg]' (KAMP writes that shape).
        # Basename is NOT folded here: same-named files in different
        # dirs are genuinely distinct for an add.
        target_norm = target.removeprefix('./')
        for _, path in _include_lines(lines):
            if path == target or path.removeprefix('./') == target_norm:
                return _state_error(
                    f"[include {path}] already present in {in_file}.")
        # Placement convention (Sir dogfood 2026-09-25): the old code
        # reused the SECTION inserter (EOF / above-banner), dropping the
        # line at the very bottom of printer.cfg. Klipper convention puts
        # includes at the top, together.
        banner = _save_config_start(lines)
        active_includes = [t for t in _include_lines(lines) if t[0] < banner]
        if not self.files[in_file].strip():
            # Empty/whitespace-only file: replace the (empty) line list.
            # Review fix 2026-09-26: this branch used to write
            # self.files directly, but the join at the end of the method
            # rebuilt the text from the PRE-edit `lines` and silently
            # reverted the include while still reporting status 'ok'.
            lines = [f'[{header}]']
        elif active_includes:
            # Join the existing block: directly after the last include.
            idx = active_includes[-1][0] + 1
            lines[idx:idx] = [f'[{header}]']
        else:
            # No includes yet: top of file, after any leading
            # header comments/blank lines, before the first real
            # section — and never at/below the SAVE_CONFIG banner.
            idx = 0
            while idx < banner:
                stripped = lines[idx].strip()
                if stripped and not stripped.startswith('#'):
                    break
                idx += 1
            lines[idx:idx] = [f'[{header}]', '']
        self.files[in_file] = '\n'.join(lines)
        return {'status': 'ok', 'file': in_file, 'summary': f"added [include {target}] to {in_file}"}

    def _op_comment_include(self, op: dict) -> dict:
        """Disable an include WITHOUT deleting it: [include x.cfg] ->
        #[include x.cfg]. The comment-out idiom Klipper users ask for
        ('stop loading sensorless.cfg') -- delete would destroy the line
        and its re-enable hint (fullbank ON run 2026-09-14 TRIDENT-04:
        with no op for this the model honestly reported the gap)."""
        target = (op.get('target_file') or '').strip()
        if not target:
            return _state_error('Missing required argument: target_file')
        in_file = self._require_file(op.get('file') or 'printer.cfg')
        if target == in_file:
            return _state_error(
                f"A file cannot include (or comment) itself ({in_file}). "
                f"Pass the INCLUDED file's name in target_file.")
        lines = _split_lines(self.files[in_file])
        idx, path, err = _find_include_target(lines, target, in_file)
        if err is not None:
            # A commented-out '#[include x.cfg]' is invisible to the
            # resolver (it scans active headers only) — report it as
            # already commented rather than 'not present'.
            for line in lines:
                stripped = line.strip()
                if stripped.startswith('#') and _include_target_matches(
                        target, stripped.lstrip('#').strip()
                        .removeprefix('[').removesuffix(']')
                        .removeprefix('include ').strip()):
                    return _state_error(
                        f"[include {target}] is already commented out in "
                        f"{in_file}.")
            return err
        assert idx is not None and path is not None
        lines[idx] = '#' + lines[idx].lstrip()
        self.files[in_file] = '\n'.join(lines)
        return {'status': 'ok', 'file': in_file,
                'summary': f"commented out [include {path}] in {in_file}"}

    def _op_remove_include(self, op: dict) -> dict:
        target = (op.get('target_file') or '').strip()
        if not target:
            return _state_error('Missing required argument: target_file')
        in_file = self._require_file(op.get('file') or 'printer.cfg')
        if target == in_file:
            return _state_error(
                f"A file cannot include (or un-include) itself ({in_file}). "
                f"Pass the INCLUDED file's name in target_file.")
        lines = _split_lines(self.files[in_file])
        idx, path, err = _find_include_target(lines, target, in_file)
        if err is not None:
            return err
        assert idx is not None and path is not None
        # Delete via the resolver index: _find_section uses the
        # EOL-anchored header regex and misses the trailing-comment
        # shape ('[include x] # ...'), so it could not locate a line the
        # resolver just found. Drop the line plus its trailing blanks.
        end = idx + 1
        while end < len(lines) and not lines[end].strip():
            end += 1
        del lines[idx:end]
        self.files[in_file] = re.sub(r'\n{3,}', '\n\n', '\n'.join(lines))
        return {'status': 'ok', 'file': in_file,
                'summary': f"removed [include {path}] from {in_file}"}


# ── helpers ─────────────────────────────────────────────────────────────

_COMMENT_MARKERS = (' #', '\t#', ' ;', '\t;')


def _extract_trailing_comment(rest: str) -> str:
    """Return the trailing comment (incl. marker) of a param value tail,
    respecting quoted strings minimally (Klipper cfg rarely quotes)."""
    for marker in _COMMENT_MARKERS:
        idx = rest.find(marker)
        if idx != -1:
            return rest[idx:]
    stripped = rest.lstrip()
    if stripped.startswith('#') or stripped.startswith(';'):
        return ' ' + stripped
    return ''


def _count_substring_occurrences(haystack: str, needle: str) -> int:
    count = 0
    start = haystack.find(needle)
    while start != -1:
        count += 1
        start = haystack.find(needle, start + len(needle))
    return count


def _find_indent_tolerant(section_lines: list[str], old_text: str) -> tuple[int, int] | None:
    """Find a contiguous run of section lines matching old_text line-by-line
    with leading-whitespace tolerance. Returns (start, stop) or None."""
    wanted = [ln.strip() for ln in old_text.split('\n')]
    # ignore a single trailing empty line from a stray newline in the arg
    while len(wanted) > 1 and wanted[-1] == '':
        wanted.pop()
    if not wanted:
        return None
    for start in range(0, len(section_lines) - len(wanted) + 1):
        ok = True
        for offset, want in enumerate(wanted):
            have = section_lines[start + offset].strip()
            if want != '#':  # bare '#' comment line must match shape
                if have != want and not (want == '' and have == ''):
                    ok = False
                    break
            if want == '' and have != '':
                ok = False
                break
        if ok:
            return start, start + len(wanted)
    return None


def _reindent_like(new_text: str, like_line: str) -> list[str]:
    indent = re.match(r'^\s*', like_line).group(0)
    out: list[str] = []
    for ln in new_text.split('\n'):
        if not ln.strip():
            out.append('')
        else:
            out.append(f"{indent}{ln.strip()}")
    return out
