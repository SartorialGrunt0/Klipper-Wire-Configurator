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
tool results (kickback). ``patch_gcode`` anchor misses return the CURRENT
section text so the model can re-quote exactly (Claude Code edit-tool
pattern).
"""
from __future__ import annotations

import re
from copy import deepcopy
from dataclasses import dataclass, field

from parser.config_parser import parse_config
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


def _split_lines(text: str) -> list[str]:
    return text.split('\n')


def _find_section(lines: list[str], header: str) -> tuple[int, int] | None:
    """Return (header_index, body_end_index) for the first section whose
    header matches exactly, else None. body_end excludes the next header
    but includes trailing comments/blank lines owned by the section."""
    header_index = -1
    for i, line in enumerate(lines):
        match = RE_SECTION_HEADER.match(line)
        if match and match.group(1).strip() == header:
            header_index = i
            break
    if header_index == -1:
        return None
    end = len(lines)
    for scan in range(header_index + 1, len(lines)):
        if RE_SECTION_HEADER.match(lines[scan]):
            end = scan
            break
    return header_index, end


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
                continue
        return configs

    def validate(self) -> dict[str, dict]:
        configs = self._parse_all()
        if not configs:
            return {}
        results = validate_project_configs(configs, gcode_registry=False)
        return {name: result.to_dict() for name, result in results.items()}

    def copy(self) -> "ProjectState":
        return ProjectState(files=dict(self.files))

    # ── delta gate ───────────────────────────────────────────────────────

    def _delta_findings(self, baseline: dict[str, dict]) -> dict:
        """Run the delta gate against a baseline validation.

        Returns ``{'new_errors': [...], 'advisories': [...]}`` where
        ``new_errors`` are NEW blocking findings that CAN be fixed by a
        re-attempt, and ``advisories`` are new warnings + new instances of
        retry-exempt codes (visible to the model, non-blocking — can't be
        regenerated away, don't loop).
        """
        candidate = self.validate()
        issues = collect_new_validation_errors(baseline, candidate)
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
                dedupe_key = (finding['filename'], finding['severity'],
                              finding['section'], finding['param'],
                              finding['code'], finding['message'])
                if dedupe_key in seen_keys:
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
        findings = new_state._delta_findings(baseline_validations)
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
            'patch_gcode': self._op_patch_gcode,
            'new_file': self._op_new_file,
            'delete_file': self._op_delete_file,
            'add_include': self._op_add_include,
            'remove_include': self._op_remove_include,
        }.get(kind)
        if handler is None:
            return _state_error(f"Unknown op '{kind}'.")
        try:
            return handler(op)
        except _OpError as exc:  # precondition failure — structured, no raise
            return exc.to_result()
        except KeyError as exc:  # missing required arg — structured, no raise
            return _state_error(f"Missing required argument for {kind}: {exc.args[0]}")

    def _require_file(self, filename: str | None) -> str:
        if not filename:
            raise _OpError('Missing required argument: file')
        if filename not in self.files:
            known = ', '.join(sorted(self.files)) or '(none)'
            raise _OpError(f"File '{filename}' is not in the project. Known files: {known}.")
        return filename

    @staticmethod
    def _require_header(op: dict) -> str:
        section = (op.get('section') or '').strip()
        if not section:
            raise _OpError('Missing required argument: section')
        return section.strip('[]').strip()

    # -- set_param ---------------------------------------------------------

    def _op_set_param(self, op: dict) -> dict:
        filename = self._require_file(op.get('file'))
        header = self._require_header(op)
        key = (op.get('key') or '').strip()
        if not key:
            return _state_error('Missing required argument: key')
        if 'value' not in op:
            return _state_error('Missing required argument: value')
        value = str(op['value'])

        lines = _split_lines(self.files[filename])
        found = _find_section(lines, header)
        if found is None:
            return _state_error(
                f"Section '[{header}]' not found in {filename}. Read the file first "
                "or use add_section for a new section."
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
            return _state_error(
                f"Parameter '{key}' in [{header}] exists but is commented out. "
                "Ask the user, or uncomment explicitly before setting it."
            )

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

    def _op_add_section(self, op: dict) -> dict:
        filename = self._require_file(op.get('file'))
        header = self._require_header(op)
        body = op.get('text', '')
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
        text = self.files[filename].rstrip('\n')
        self.files[filename] = f"{text}\n\n[{header}]\n{body.strip()}\n" if body.strip() else f"{text}\n\n[{header}]\n"
        return {'status': 'ok', 'file': filename, 'summary': f"added section [{header}] to {filename}"}

    def _op_replace_section(self, op: dict) -> dict:
        filename = self._require_file(op.get('file'))
        header = self._require_header(op)
        body = op.get('text', '')
        if not isinstance(body, str):
            return _state_error('Argument text must be a string')
        lines = _split_lines(self.files[filename])
        found = _find_section(lines, header)
        if found is None:
            return _state_error(
                f"Section '[{header}]' not found in {filename}. Read the file first."
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
        new_body = body_stripped.split('\n') if body_stripped else []
        lines[header_index + 1:inner_end] = new_body
        self.files[filename] = '\n'.join(lines)
        return {'status': 'ok', 'file': filename, 'summary': f"replaced body of [{header}] in {filename}"}

    def _op_delete_section(self, op: dict) -> dict:
        filename = self._require_file(op.get('file'))
        header = self._require_header(op)
        lines = _split_lines(self.files[filename])
        found = _find_section(lines, header)
        if found is None:
            return _state_error(f"Section '[{header}]' not found in {filename}.")
        header_index, end = found
        while end > header_index + 1 and not lines[end - 1].strip():
            end -= 1
        del lines[header_index:end]
        # Collapse any double blank line left at the splice point.
        self.files[filename] = re.sub(r'\n{3,}', '\n\n', '\n'.join(lines))
        return {'status': 'ok', 'file': filename, 'summary': f"deleted section [{header}] from {filename}"}

    # -- patch_gcode -------------------------------------------------------

    def _op_patch_gcode(self, op: dict) -> dict:
        filename = self._require_file(op.get('file'))
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
                f"Section '[{header}]' not found in {filename}. Read the file first."
            )
        header_index, end = found
        section_lines = lines[header_index + 1:end]
        section_text = '\n'.join(section_lines)

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
            return {'status': 'ok', 'file': filename,
                    'summary': f"patched [{header}] in {filename}"}
        patched_lines = patched.split('\n')
        lines[header_index + 1:end] = patched_lines
        self.files[filename] = '\n'.join(lines)
        return {'status': 'ok', 'file': filename,
                'summary': f"patched [{header}] in {filename}"}

    # -- files & includes ---------------------------------------------------

    def _op_new_file(self, op: dict) -> dict:
        filename = (op.get('file') or '').strip()
        if not filename:
            return _state_error('Missing required argument: file')
        if filename in self.files:
            return _state_error(
                f"File '{filename}' already exists. config_write creates NEW files only; "
                "edit existing files with set_param/patch_gcode/replace_section."
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
        del self.files[filename]
        return {'status': 'ok', 'file': filename, 'summary': f"deleted file {filename}"}

    def _op_add_include(self, op: dict) -> dict:
        target = (op.get('target_file') or '').strip()
        if not target:
            return _state_error('Missing required argument: target_file')
        in_file = self._require_file(op.get('file') or 'printer.cfg')
        lines = _split_lines(self.files[in_file])
        header = f"include {target}"
        for line in lines:
            match = RE_SECTION_HEADER.match(line)
            if match and match.group(1).strip() == header:
                return _state_error(f"[{header}] already present in {in_file}.")
        text = self.files[in_file].rstrip('\n')
        self.files[in_file] = f"{text}\n\n[{header}]\n" if text else f"[{header}]\n"
        return {'status': 'ok', 'file': in_file, 'summary': f"added [include {target}] to {in_file}"}

    def _op_remove_include(self, op: dict) -> dict:
        target = (op.get('target_file') or '').strip()
        if not target:
            return _state_error('Missing required argument: target_file')
        in_file = self._require_file(op.get('file') or 'printer.cfg')
        lines = _split_lines(self.files[in_file])
        header = f"include {target}"
        found = _find_section(lines, header)
        if found is None:
            return _state_error(f"[{header}] not present in {in_file}.")
        header_index, end = found
        while end > header_index + 1 and not lines[end - 1].strip():
            end -= 1
        del lines[header_index:end]
        self.files[in_file] = re.sub(r'\n{3,}', '\n\n', '\n'.join(lines))
        return {'status': 'ok', 'file': in_file, 'summary': f"removed [include {target}] from {in_file}"}


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
