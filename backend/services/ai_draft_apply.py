"""Backend port of the KWC AI-draft apply/merge pipeline.

Mirrors the following TypeScript modules (frontend) line for line where the
semantics matter:

- frontend/src/utils/chatUtils.ts
    extractConfigCodeBlocks, extractAssistantFileHint, CONFIG_CODE_LANGUAGES,
    ASSISTANT_FILE_HINT_RE, rewriteConfigEqualsSeparators,
    extractMentionedConfigFilenames, resolveAssistantTargetFile
- frontend/src/utils/miniDiff.ts
    isMiniDiffBlock, applyMiniDiffBlock, stripMiniDiffMarkers
- frontend/src/utils/jinjaBlockRepair.ts
    repairUnclosedJinjaInConfigText (+ its section/body handlers)
- frontend/src/utils/assistantDraftMerge.ts
    preprocessDeleteMarkers, mergeAssistantSectionsIntoConfig
- frontend/src/hooks/useAssistantDraft.ts
    buildAssistantDraftTargetConfigs + prepareAssistantDraftPreview
    (the top-level ``apply_reply_to_configs`` convenience below)

The backend uses the parser/writer from ``parser.config_parser`` /
``parser.config_writer`` so the server can validate the merged result and do a
single deterministic Jinja-repair pass.  Everything is pure stdlib plus the
backend ``parser`` package.  Only ASCII whitespace is treated as comment/body
content, matching the JS regexes.
"""
from __future__ import annotations

import os
import re
import sys

# Make the backend ``parser`` package importable regardless of the current
# working directory (repo root vs. backend root).  Existing backend modules
# import ``from parser.config_parser import ...``; this bootstrap keeps that
# style working when the module is loaded as ``backend.services.ai_draft_apply``
# from the repo root (e.g. during import checks or tests).
_BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_ROOT not in sys.path:
    sys.path.insert(0, _BACKEND_ROOT)

from parser.config_parser import (  # noqa: E402
    ConfigFile,
    ConfigParam,
    ConfigSection,
    parse_config,
)
from parser.config_writer import smart_export  # noqa: E402


# ── chatUtils: constants used by several functions ──────────────────────

CONFIG_CODE_LANGUAGES = frozenset(
    ['', 'cfg', 'conf', 'ini', 'klipper', 'printercfg']
)
ASSISTANT_FILE_HINT_RE = re.compile(r'^[#;]\s*file\s*:\s*(.+?)\s*$', re.IGNORECASE)

# A fenced ```code block: open fence, optional non-empty/backtick language,
# then the block body until the closing ```.  Mirrors /```([^\n`]*)\n([\s\S]*?)```/g.
RE_CODE_BLOCK = re.compile(r'```([^\n`]*)\n([\s\S]*?)```')

# Raw-content fallback: delete marker ``*[section]`` or a ``# file:`` hint
# anywhere in the text (multiline).  Mirrors /^\s*(?:[*]\[[^\]]+\]|[#;]\s*file\s*:)/m.
RE_CONFIG_LIKE = re.compile(r'^\s*(?:\*\[[^\]]+\]|[#;]\s*file\s*:)', re.MULTILINE)

# ``name = value`` param assignment inside a cfg block (optional leading
# indent and an optional ``#`` comment prefix).
RE_EQUALS_PARAM = re.compile(
    r'^(\s*)(#?\s*[A-Za-z0-9_][A-Za-z0-9_-]*)\s*=\s*(.*)$'
)


# ── chatUtils: extractConfigCodeBlocks ──────────────────────────────────

def extract_config_code_blocks(content: str) -> list[str]:
    """Return fenced code blocks whose language is a Klipper config language.

    Mirrors ``extractConfigCodeBlocks``:
    - blocks whose language (lowercased) is in ``CONFIG_CODE_LANGUAGES`` are
      returned first, in order;
    - if none of those exist, the first block fenced with *any* other language
      is returned;
    - if there are no fenced blocks at all but the raw text contains a
      ``*[section]`` delete marker or a ``# file:`` hint, the whole ``content``
      is returned;
    - otherwise an empty list is returned.
    """
    config_blocks: list[str] = []
    fallback_blocks: list[str] = []

    for match in RE_CODE_BLOCK.finditer(content):
        language = match.group(1).strip().lower()
        block = match.group(2).strip()
        if not block:
            continue
        if language in CONFIG_CODE_LANGUAGES:
            config_blocks.append(block)
        else:
            fallback_blocks.append(block)

    if config_blocks:
        return config_blocks
    if fallback_blocks:
        return [fallback_blocks[0]]

    if RE_CONFIG_LIKE.search(content):
        return [content]

    return []


# ── chatUtils: extractAssistantFileHint ─────────────────────────────────

def extract_assistant_file_hint(
    block: str, loaded_filenames: list[str]
) -> tuple[str, str | None]:
    """Strip a leading ``# file: <name>`` hint line from a cfg block.

    Returns ``(config_text_without_hint_line, file_hint_or_None)``.  The lookup
    maps each loaded filename to its exact name and bare basename (case
    insensitive) so a hint such as ``printer.cfg`` matches ``config/printer.cfg``.
    """
    available_by_lower: dict[str, str] = {}
    for filename in loaded_filenames:
        lower = filename.lower()
        available_by_lower.setdefault(lower, filename)
        base = re.sub(r'^.*[\\/]', '', filename).lower()
        if base and base != lower:
            available_by_lower.setdefault(base, filename)

    lines = re.split(r'\r?\n', block)
    file_hint: str | None = None
    file_hint_line_index = -1

    for index, line in enumerate(lines):
        trimmed = line.strip()
        if not trimmed:
            continue
        hint_match = ASSISTANT_FILE_HINT_RE.match(trimmed)
        if hint_match:
            raw_name = hint_match.group(1).strip()
            file_hint = available_by_lower.get(raw_name.lower(), raw_name)
            file_hint_line_index = index
            break

    if file_hint_line_index == -1:
        return block, file_hint

    config_text = '\n'.join(
        line for idx, line in enumerate(lines) if idx != file_hint_line_index
    ).strip()
    return config_text, file_hint


# ── chatUtils: rewriteConfigEqualsSeparators ────────────────────────────

def rewrite_config_equals_separators(content: str) -> str:
    """Rewrite ``key = value`` param assignments to ``key: value`` inside cfg blocks.

    Only touches lines inside fenced blocks whose language is a config
    language, and only lines that look like a Klipper param assignment.
    """

    def _rewrite_block(whole: str, language: str, block: str) -> str:
        if language.strip().lower() not in CONFIG_CODE_LANGUAGES:
            return whole
        rewritten = '\n'.join(
            RE_EQUALS_PARAM.sub(
                lambda m: f"{m.group(1)}{m.group(2)}: {m.group(3)}",
                line,
            )
            for line in re.split(r'\r?\n', block)
        )
        return f'```{language}\n{rewritten}```'

    return RE_CODE_BLOCK.sub(_rewrite_block, content)


# ── chatUtils: filename helpers used by target resolution ───────────────

def _basename(filename: str) -> str:
    """Strip any path prefix, returning just the basename (JS basename())."""
    return re.split(r'[\\/]', filename)[-1]


def _escape_regex(value: str) -> str:
    return re.escape(value)


def extract_mentioned_config_filenames(
    texts: list[str], available_filenames: list[str]
) -> list[str]:
    """Return the available filenames mentioned (case-insensitively) in texts."""
    matches: list[str] = []
    for filename in available_filenames:
        pattern = re.compile(
            rf'(^|[^A-Za-z0-9_.-]){_escape_regex(filename)}(?=$|[^A-Za-z0-9_.-])',
            re.IGNORECASE,
        )
        if any(pattern.search(text) for text in texts):
            matches.append(filename)
    return matches


def _score_assistant_target_file(
    config: ConfigFile, assistant_sections: list[ConfigSection]
) -> tuple[int, int]:
    full_headers = {section.full_header for section in config.sections}
    section_types = {section.section_type for section in config.sections}
    exact_matches = 0
    section_type_matches = 0
    for section in assistant_sections:
        if section.full_header in full_headers:
            exact_matches += 1
            continue
        if section.section_type in section_types:
            section_type_matches += 1
    return exact_matches, section_type_matches


def _resolve_filename(
    hint: str, config_files: dict[str, ConfigFile]
) -> str | None:
    if hint in config_files:
        return hint
    hint_base = _basename(hint).lower()
    for key in config_files:
        if _basename(key).lower() == hint_base:
            return key
    return None


def resolve_assistant_target_file(
    assistant_config: ConfigFile,
    config_files: dict[str, ConfigFile],
    active_file: str,
    hinted_filenames: list[str],
) -> str | None:
    """Resolve which loaded config file the assistant's sections target.

    Mirrors ``resolveAssistantTargetFile``.
    """
    available_filenames = list(config_files.keys())
    unique_hints = list(dict.fromkeys(hinted_filenames))

    if len(unique_hints) == 1:
        resolved = _resolve_filename(unique_hints[0], config_files)
        return resolved if resolved is not None else unique_hints[0]

    if not available_filenames:
        return None

    existing_hints: list[str] = []
    for filename in unique_hints:
        resolved = _resolve_filename(filename, config_files)
        if resolved is not None:
            existing_hints.append(resolved)

    if len(existing_hints) == 1:
        return existing_hints[0]

    if len(existing_hints) > 1:
        scored: list[tuple[str, int, int]] = []
        for filename in existing_hints:
            exact, s_type = _score_assistant_target_file(
                config_files[filename], assistant_config.sections
            )
            scored.append((filename, exact, s_type))
        scored.sort(key=lambda item: (-item[1], -item[2]))
        return scored[0][0]

    scores: list[tuple[str, int, int, int]] = []
    for filename in available_filenames:
        exact, s_type = _score_assistant_target_file(
            config_files[filename], assistant_config.sections
        )
        active = 1 if filename == active_file else 0
        scores.append((filename, exact, s_type, active))
    scores.sort(key=lambda item: (-item[1], -item[2], -item[3], item[0]))

    best = scores[0]
    if best[1] > 0 or best[2] > 0:
        return best[0]
    if active_file in config_files:
        return active_file
    return available_filenames[0] if available_filenames else None


# ── assistantDraftMerge: delete-marker preprocessing ────────────────────

DELETE_SECTION_TYPE = 'delete_section'
# /^\*\[([^\]]+)\]\s*$/gm
DELETE_MARKER_RE = re.compile(r'^\*\[([^\]]+)\]\s*$', re.MULTILINE)


def preprocess_delete_markers(text: str) -> str:
    """Convert ``*[section_name]`` lines into ``[delete_section]`` blocks."""
    return DELETE_MARKER_RE.sub(
        lambda m: f'[delete_section]\nsection: {m.group(1).strip()}', text
    )


# ── assistantDraftMerge: section/param clones ───────────────────────────

def _clone_param(param: ConfigParam) -> ConfigParam:
    return ConfigParam(
        key=param.key,
        value=param.value,
        comment=param.comment,
        is_commented_out=param.is_commented_out,
        line_number=param.line_number,
        separator=param.separator,
        raw_comment_suffix=param.raw_comment_suffix,
        raw_line=param.raw_line,
    )


def _clone_section(section: ConfigSection) -> ConfigSection:
    return ConfigSection(
        section_type=section.section_type,
        section_name=section.section_name,
        full_header=section.full_header,
        params=[_clone_param(p) for p in section.params],
        header_comments=list(section.header_comments),
        line_number=section.line_number,
        trailing_comments=list(section.trailing_comments),
        trailing_blank_lines=section.trailing_blank_lines,
        is_commented_out=section.is_commented_out,
    )


# ── assistantDraftMerge: section index ──────────────────────────────────

def _build_section_index(sections: list[ConfigSection]) -> dict[str, list[int]]:
    section_index: dict[str, list[int]] = {}
    for index, section in enumerate(sections):
        section_index.setdefault(section.full_header, []).append(index)
    return section_index


def _collect_includes(sections: list[ConfigSection]) -> list[str]:
    return [s.section_name for s in sections if s.section_type == 'include']


def _is_delete_section(section: ConfigSection) -> bool:
    if section.section_type != DELETE_SECTION_TYPE:
        return False
    for p in section.params:
        if p.key == 'section' and p.value.strip():
            return True
    return False


def _get_delete_target(section: ConfigSection) -> str | None:
    for p in section.params:
        if p.key == 'section':
            return p.value.strip()
    return None


# ── assistantDraftMerge: param merge ────────────────────────────────────

def _pick_matching_param_index(
    params: list[ConfigParam],
    key: str,
    is_commented_out: bool,
    used_indexes: dict[int, int],
) -> int | None:
    for index, param in enumerate(params):
        if index not in used_indexes and param.key == key \
                and param.is_commented_out == is_commented_out:
            return index
    for index, param in enumerate(params):
        if index not in used_indexes and param.key == key \
                and not param.is_commented_out:
            return index
    for index, param in enumerate(params):
        if index not in used_indexes and param.key == key:
            return index
    return None


def _merge_assistant_params(
    existing_params: list[ConfigParam], assistant_params: list[ConfigParam]
) -> list[ConfigParam]:
    unlinked_ai_keys = {
        p.key for p in assistant_params if p.key != '_comment_'
    }
    matched_existing_indexes: dict[int, int] = {}

    for ai_index, ai_param in enumerate(assistant_params):
        if ai_param.key == '_comment_':
            continue
        match_index = _pick_matching_param_index(
            existing_params, ai_param.key, ai_param.is_commented_out,
            matched_existing_indexes,
        )
        if match_index is not None:
            matched_existing_indexes[match_index] = ai_index
            unlinked_ai_keys.discard(ai_param.key)

    ai_key_set = {p.key for p in assistant_params if p.key != '_comment_'}
    result: list[ConfigParam] = []
    used_ai_keys: set[str] = set()

    for existing_index, existing_param in enumerate(existing_params):
        if existing_param.key == '_comment_':
            result.append(_clone_param(existing_param))
            continue

        matched_ai_index = matched_existing_indexes.get(existing_index)
        if matched_ai_index is not None:
            ai_param = assistant_params[matched_ai_index]
            if ai_param is not None:
                cloned_ai = _clone_param(ai_param)
                merged = _clone_param(existing_param)
                merged.key = cloned_ai.key
                merged.value = cloned_ai.value
                merged.line_number = cloned_ai.line_number
                merged.raw_comment_suffix = cloned_ai.raw_comment_suffix
                merged.raw_line = cloned_ai.raw_line
                merged.is_commented_out = existing_param.is_commented_out
                merged.comment = cloned_ai.comment or existing_param.comment
                merged.separator = (
                    cloned_ai.separator
                    if cloned_ai.separator is not None
                    else existing_param.separator
                )
                result.append(merged)
                used_ai_keys.add(existing_param.key)
                continue

        if existing_param.key in ai_key_set:
            result.append(_clone_param(existing_param))
            continue

        # Unmatched existing param whose key is not in the AI's output:
        # excluded (the AI intentionally removed it).

    # Append unlinked AI params (new params / key renames).
    for param in assistant_params:
        if param.key == '_comment_':
            continue
        if param.key not in used_ai_keys and param.key in unlinked_ai_keys:
            result.append(_clone_param(param))
            used_ai_keys.add(param.key)

    # Append AI comments/blank lines that aren't duplicates.
    pushed_comment_values: set[str] = set()
    for param in assistant_params:
        if param.key != '_comment_':
            continue
        if param.value in pushed_comment_values:
            continue
        in_existing = any(
            ep.key == '_comment_' and ep.value == param.value
            for ep in existing_params
        )
        if not in_existing:
            result.append(_clone_param(param))
            pushed_comment_values.add(param.value)

    return result


# ── assistantDraftMerge: section merge ──────────────────────────────────

def _merge_assistant_section(
    existing_section: ConfigSection, assistant_section: ConfigSection
) -> ConfigSection:
    return ConfigSection(
        section_type=assistant_section.section_type,
        section_name=assistant_section.section_name,
        full_header=assistant_section.full_header,
        # TS: existing ?? assistant (existing is always present)
        line_number=existing_section.line_number,
        # TS: assistant ?? existing (assistant is always present)
        is_commented_out=assistant_section.is_commented_out,
        header_comments=(
            list(existing_section.header_comments)
            if len(existing_section.header_comments) > 0
            else list(assistant_section.header_comments)
        ),
        trailing_comments=(
            list(existing_section.trailing_comments)
            if len(existing_section.trailing_comments) > 0
            else list(assistant_section.trailing_comments)
        ),
        trailing_blank_lines=assistant_section.trailing_blank_lines,
        params=_merge_assistant_params(
            existing_section.params, assistant_section.params
        ),
    )


def _build_assistant_draft_change_id(
    filename: str, section: ConfigSection, assistant_section_index: int
) -> str:
    return f'{filename}:{assistant_section_index}:{section.full_header}'


def merge_assistant_sections(
    base_config: ConfigFile,
    assistant_config: ConfigFile,
    selected_ids: list[str] | None = None,
) -> dict:
    """Merge the assistant's sections into the base config.

    Mirrors ``mergeAssistantSectionsIntoConfig``, returning
    ``{'merged_config': ConfigFile, 'changes': list[dict]}`` where each change
    is ``{'id': str, 'filename': str, 'fullHeader': str, 'mode': str}`` with
    ``mode`` in ``{'update', 'add', 'delete'}`` and ids built as
    ``f"{filename}:{index}:{full_header}"``.
    """
    base_sections = list(base_config.sections or [])
    assistant_sections = list(assistant_config.sections or [])
    section_index = _build_section_index(base_sections)
    replacements: dict[int, ConfigSection] = {}
    inserts_by_anchor: dict[int, list[ConfigSection]] = {}
    seen_headers: dict[str, int] = {}
    selected_id_set = (
        None if selected_ids is None else set(selected_ids)
    )
    deleted_indexes: set[int] = set()
    changes: list[dict] = []
    last_anchor_index = len(base_sections) - 1 if base_sections else -1

    for assistant_section_index, assistant_section in enumerate(assistant_sections):
        seen_count = seen_headers.get(assistant_section.full_header, 0)
        seen_headers[assistant_section.full_header] = seen_count + 1
        change_id = _build_assistant_draft_change_id(
            base_config.filename, assistant_section, assistant_section_index
        )
        should_apply = selected_id_set is None or change_id in selected_id_set

        if _is_delete_section(assistant_section):
            target_name = _get_delete_target(assistant_section)
            if target_name:
                target_indexes = section_index.get(target_name)
                existing_index = target_indexes[0] if target_indexes else None
                changes.append({
                    'id': change_id,
                    'filename': base_config.filename,
                    'fullHeader': target_name,
                    'mode': 'delete',
                })
                if existing_index is not None:
                    if should_apply:
                        deleted_indexes.add(existing_index)
                continue
            continue

        target_indexes = section_index.get(assistant_section.full_header)
        existing_index = (
            target_indexes[seen_count]
            if target_indexes is not None and seen_count < len(target_indexes)
            else None
        )
        if existing_index is not None:
            changes.append({
                'id': change_id,
                'filename': base_config.filename,
                'fullHeader': assistant_section.full_header,
                'mode': 'update',
            })
            last_anchor_index = existing_index
            if not should_apply:
                continue
            existing_section = base_sections[existing_index]
            replacements[existing_index] = _merge_assistant_section(
                existing_section, assistant_section
            )
            continue

        changes.append({
            'id': change_id,
            'filename': base_config.filename,
            'fullHeader': assistant_section.full_header,
            'mode': 'add',
        })
        if not should_apply:
            continue
        inserts_by_anchor.setdefault(last_anchor_index, []).append(
            _clone_section(assistant_section)
        )

    merged_sections: list[ConfigSection] = []
    leading_sections = inserts_by_anchor.get(-1)
    if leading_sections:
        merged_sections.extend(leading_sections)

    pending_deleted_comments: list[str] = []

    for index, section in enumerate(base_sections):
        if index in deleted_indexes:
            if section.header_comments:
                pending_deleted_comments.extend(section.header_comments)
            anchored_sections = inserts_by_anchor.get(index)
            if anchored_sections:
                merged_sections.extend(anchored_sections)
            continue

        merged_section = (
            replacements.get(index) if index in replacements
            else _clone_section(section)
        )

        if pending_deleted_comments:
            merged_section.header_comments = (
                list(pending_deleted_comments)
                + list(merged_section.header_comments)
            )
            pending_deleted_comments = []

        merged_sections.append(merged_section)
        anchored_sections = inserts_by_anchor.get(index)
        if anchored_sections:
            merged_sections.extend(anchored_sections)

    merged_config = ConfigFile(
        filename=base_config.filename,
        sections=merged_sections,
        includes=_collect_includes(merged_sections),
        header_comments=(
            list(base_config.header_comments)
            if len(base_config.header_comments) > 0
            else list(assistant_config.header_comments)
        ),
        raw_text=base_config.raw_text,
    )

    return {'merged_config': merged_config, 'changes': changes}


# ── miniDiff: regexes and helpers ───────────────────────────────────────

RE_MINI_DIFF_REMOVAL = re.compile(r'^\s*-(.*)$')
RE_MINI_DIFF_ADDITION = re.compile(r'^\s*\+(.*)$')
# /^\s*(\[[^\]]+\])\s*$/
RE_SECTION_HEADER = re.compile(r'^\s*(\[[^\]]+\])\s*$')
# jinjaBlockRepair's SECTION_HEADER_RE captures the INNER name (no brackets).
# /^\s*\[([^\]]+)\]\s*$/
RE_SECTION_HEADER_INNER = re.compile(r'^\s*\[([^\]]+)\]\s*$')
# /^\s*\*\[[^\]]+\]\s*$/
RE_DELETE_MARKER = re.compile(r'^\s*\*\[[^\]]+\]\s*$')
# /^(\w[\w]*)\s*[:=]/
RE_PARAM_LINE = re.compile(r'^(\w[\w]*)\s*[:=]')


def _param_key(line: str) -> str | None:
    """Param key of a `key: value` / `key= value` line, else None.

    G-code command lines (`SET_LED LED=x`, `G28`), jinja tags, and comments
    never match — the mini-diff key-tolerant fallback relies on that to keep
    stale gcode removals falling back instead of key-matching."""
    match = RE_PARAM_LINE.match(line)
    return match.group(1) if match else None


def _normalize_line(line: str) -> str:
    """Strip CR and trailing whitespace only (JS normalizeLine)."""
    return line.rstrip()


def _leading_whitespace(line: str) -> str:
    """Leading spaces/tabs of a line (cosmetic in Klipper configs)."""
    match = re.match(r'^[ \t]*', line)
    return match.group(0) if match else ''


def _is_gcode_body_key(key: str) -> bool:
    return key == 'gcode' or key.endswith('_gcode')


def _last_section_param_key(section_lines: list[str]) -> str | None:
    for index in range(len(section_lines) - 1, -1, -1):
        line = section_lines[index]
        if line.strip() == '' or line.startswith('#'):
            continue
        if line.startswith('['):
            break
        param_match = RE_PARAM_LINE.match(line)
        if param_match:
            return param_match.group(1)
    return None


def _section_has_gcode_body(section_lines: list[str]) -> bool:
    key = _last_section_param_key(section_lines)
    return key is not None and _is_gcode_body_key(key)


def _section_content_end(
    base_lines: list[str], header_index: int, end_index: int
) -> int:
    """Trim the trailing column-0 comment block that belongs to the next section."""
    last = end_index - 1
    while last > header_index and base_lines[last].strip() == '':
        last -= 1
    if last <= header_index:
        return end_index
    if not base_lines[last].startswith('#'):
        return end_index
    if _section_has_gcode_body(base_lines[header_index:end_index]):
        return end_index
    start = last
    while start > header_index and base_lines[start].startswith('#'):
        start -= 1
    return start + 1


def is_mini_diff_block(text: str) -> bool:
    """True when the block looks like a mini-diff edit of an existing section."""
    lines = re.split(r'\r?\n', text)
    has_header = False
    has_marker = False
    for line in lines:
        if RE_DELETE_MARKER.search(line):
            return False
        if RE_SECTION_HEADER.search(line):
            has_header = True
            continue
        if RE_MINI_DIFF_REMOVAL.search(line) or RE_MINI_DIFF_ADDITION.search(line):
            has_marker = True
    return has_header and has_marker


def strip_mini_diff_markers(text: str) -> str:
    """Strip the ``-``/``+`` mini-diff markers from a block, producing plain text."""
    out: list[str] = []
    for line in re.split(r'\r?\n', text):
        marker = re.match(r'^(\s*)[-+](.*)$', line)
        if not marker:
            out.append(line)
            continue
        content = marker.group(2)
        trimmed = content.lstrip()
        out.append(trimmed if RE_PARAM_LINE.match(trimmed) else content)
    return '\n'.join(out)


def _extract_section_ops(
    lines: list[str], header_index: int
) -> list[dict]:
    ops: list[dict] = []
    current: dict | None = None

    for index in range(header_index + 1, len(lines)):
        line = lines[index]
        if RE_SECTION_HEADER.search(line):
            break

        removal_match = RE_MINI_DIFF_REMOVAL.match(line)
        if removal_match:
            current = {'removal': removal_match.group(1), 'additions': []}
            ops.append(current)
            continue

        addition_match = RE_MINI_DIFF_ADDITION.match(line)
        if addition_match:
            if current is not None:
                current['additions'].append(addition_match.group(1))
            else:
                current = {
                    'removal': None,
                    'additions': [addition_match.group(1)],
                }
                ops.append(current)
            continue

    return ops


def _find_base_index(base: list[str], used: set[int], predicate) -> int:
    for index, line in enumerate(base):
        if index not in used and predicate(line):
            return index
    return -1


def _apply_ops_to_section(
    section_lines: list[str], ops: list[dict]
) -> list[str] | None:
    base = [_normalize_line(line) for line in section_lines]
    used: set[int] = set()
    op_to_index: dict[int, int] = {}
    op_to_indent: dict[int, str] = {}
    append_additions: list[str] = []

    for op_index, op in enumerate(ops):
        if op['removal'] is None:
            append_additions.extend(op['additions'])
            continue

        normalized_removal = _normalize_line(op['removal'])
        stripped_removal = normalized_removal.lstrip()

        match_index = _find_base_index(
            base, used, lambda line: line == normalized_removal
        )
        if match_index == -1:
            match_index = _find_base_index(
                base, used, lambda line: line.lstrip() == stripped_removal
            )
        if match_index == -1 and stripped_removal.strip() != '':
            # Key-tolerant fallback for PARAM-SHAPED removals: models
            # routinely emit a stale old value (e.g. `-probe_count: 7,7`
            # against a section that already reads `3,3`). When the removed
            # line is `key: value`/`key= value` shaped and the KEY exists in
            # the base section, the intent is unambiguous — trust the key
            # over the value. Without this the whole block aborts, the
            # strip+full-section-write fallback keeps BOTH sides of every
            # -/+ pair, and first-wins parsing silently selects the OLD
            # value while dropping untouched section params (2026-09-09
            # HARNESS-03 finding; the stated-requirement audit caught the
            # corruption it caused). G-code lines are not param-shaped and
            # never key-match — stale gcode content still falls back.
            removal_key = _param_key(stripped_removal)
            if removal_key is not None:
                match_index = _find_base_index(
                    base, used,
                    lambda line: _param_key(line.lstrip()) == removal_key,
                )
        if match_index == -1 and _section_has_gcode_body(section_lines) \
                and stripped_removal.strip() != '':
            no_comment_removal = stripped_removal.split('#')[0].rstrip()
            if no_comment_removal != '':
                match_index = _find_base_index(
                    base, used,
                    lambda line: (
                        line.lstrip().split('#')[0].rstrip()
                        == no_comment_removal
                    ),
                )

        if match_index == -1:
            return None

        used.add(match_index)
        op_to_index[op_index] = match_index
        op_to_indent[op_index] = _leading_whitespace(base[match_index])

    result: list[str] = []
    last_non_empty_index = -1

    for index in range(len(section_lines)):
        matched_op_index = -1
        for op_index, base_index in op_to_index.items():
            if base_index == index:
                matched_op_index = op_index
                break

        if matched_op_index != -1:
            op = ops[matched_op_index]
            base_indent = op_to_indent.get(matched_op_index, '')
            diff_indent = _leading_whitespace(op['removal'] or '')
            additions: list[str] = []
            for addition in op['additions']:
                relative_indent = (
                    len(_leading_whitespace(addition)) - len(diff_indent)
                )
                pad = ' ' * relative_indent if relative_indent > 0 else ''
                additions.append(
                    base_indent + pad + _normalize_line(addition).lstrip()
                )
            result.extend(additions)
            for a in range(len(additions)):
                if additions[a].strip() != '':
                    last_non_empty_index = len(result) - 1
            continue

        result.append(section_lines[index])
        if section_lines[index].strip() != '':
            last_non_empty_index = len(result) - 1

    if append_additions:
        is_gcode_body = _section_has_gcode_body(section_lines)
        normalized_additions: list[str] = []
        for addition in append_additions:
            line = _normalize_line(addition)
            normalized_additions.append(line if is_gcode_body else line.lstrip())
        result[last_non_empty_index + 1:last_non_empty_index + 1] = (
            normalized_additions
        )

    return result


def apply_mini_diff_block(block_text: str, base_file_text: str) -> dict:
    """Apply a mini-diff cfg block against the current text of its target file.

    Returns ``{'applied': bool, 'text': str}``.  On success ``text`` contains
    only the edited sections materialized in full; on failure ``applied`` is
    ``False`` and ``text`` is the original block (caller falls back to a full
    section write).
    """
    if not is_mini_diff_block(block_text):
        return {'applied': False, 'text': block_text}

    block_lines = re.split(r'\r?\n', block_text)
    base_lines = re.split(r'\r?\n', base_file_text)
    output_sections: list[str] = []
    any_failed = False

    for block_index in range(len(block_lines)):
        header_match = RE_SECTION_HEADER.match(block_lines[block_index])
        if not header_match:
            continue
        header = header_match.group(1)

        ops = _extract_section_ops(block_lines, block_index)
        if not ops:
            continue

        header_index = -1
        for bi, base_line in enumerate(base_lines):
            base_match = RE_SECTION_HEADER.match(base_line)
            if base_match and base_match.group(1) == header:
                header_index = bi
                break
        if header_index == -1:
            any_failed = True
            continue

        end_index = len(base_lines)
        for scan in range(header_index + 1, len(base_lines)):
            if RE_SECTION_HEADER.match(base_lines[scan]):
                end_index = scan
                break

        section_lines = base_lines[
            header_index:_section_content_end(base_lines, header_index, end_index)
        ]
        reconstructed = _apply_ops_to_section(section_lines, ops)
        if reconstructed is None:
            any_failed = True
            continue

        output_sections.append('\n'.join(reconstructed))

    if any_failed or not output_sections:
        return {'applied': False, 'text': block_text}
    return {'applied': True, 'text': '\n\n'.join(output_sections)}


# ── jinjaBlockRepair: constants and helpers ─────────────────────────────

JINJA_CLOSER_BY_OPENER: dict[str, str] = {
    'if': 'endif',
    'for': 'endfor',
    'while': 'endwhile',
    'raw': 'endraw',
    'macro': 'endmacro',
    'block': 'endblock',
    'filter': 'endfilter',
    'call': 'endcall',
    'with': 'endwith',
}
JINJA_OPENERS = set(JINJA_CLOSER_BY_OPENER.keys())

# /{%\s*([a-zA-Z_]+)/g
RE_JINJA_TAG = re.compile(r'{%\s*([a-zA-Z_]+)')
# /^\s*gcode\s*[:=]\s*(#.*)?$/
RE_GCODE_PARAM = re.compile(r'^\s*gcode\s*[:=]\s*(#.*)?$')
# /^\s*[A-Za-z0-9_][A-Za-z0-9_.-]*\s*[:=]/
RE_PARAM_KEY = re.compile(r'^\s*[A-Za-z0-9_][A-Za-z0-9_.-]*\s*[:=]')

MACRO_SECTION_PREFIXES = ['gcode_macro ', 'delayed_gcode ']


def _jinja_leading_whitespace(line: str) -> str:
    match = re.match(r'^\s*', line)
    return match.group(0) if match else ''


def strip_inline_comment(line: str) -> str:
    """Mirror Klipper's config parsing for one line (``_strip_inline_comments``)."""
    hash_pos = line.find('#')
    if hash_pos >= 0:
        line = line[:hash_pos]
    semi_match = re.search(r'(^|\s);', line)
    if semi_match:
        line = line[:semi_match.start() + len(semi_match.group(1)) + 1]
    return line


def find_unclosed_jinja_blocks_detailed(body: str) -> list[dict]:
    """Return blocks still open at EOF, in open order, each ``{'opener','indent'}``."""
    stack: list[dict] = []
    for raw_line in body.split('\n'):
        line = strip_inline_comment(raw_line)
        for match in RE_JINJA_TAG.finditer(line):
            tag = match.group(1)
            if stack and stack[-1]['opener'] == 'raw':
                if tag == 'endraw':
                    stack.pop()
                continue
            if tag in JINJA_OPENERS:
                stack.append({
                    'opener': tag,
                    'indent': _jinja_leading_whitespace(line),
                })
            elif tag == 'elif' or tag == 'else':
                pass
            elif tag.startswith('end'):
                opener = tag[3:]
                if stack and stack[-1]['opener'] == opener:
                    stack.pop()
    return stack


def find_unclosed_jinja_blocks(body: str) -> list[str]:
    return [block['opener'] for block in find_unclosed_jinja_blocks_detailed(body)]


def repair_unclosed_jinja_block(body: str) -> dict | None:
    """Append missing closers for unclosed blocks at the end of a gcode body."""
    unclosed = find_unclosed_jinja_blocks_detailed(body)
    if not unclosed:
        return None
    added: list[str] = []
    for block in reversed(unclosed):
        closer = JINJA_CLOSER_BY_OPENER.get(block['opener'])
        if not closer:
            continue
        added.append(f"{block['indent']}{{% {closer} %}}")
    if not added:
        return None
    added_text = '\n'.join(added)
    if body.endswith('\n'):
        repaired = body + added_text + '\n'
    else:
        repaired = body + '\n' + added_text
    return {'repaired': repaired, 'added': added}


def repair_unclosed_jinja_in_section_text(section_text: str) -> dict | None:
    """Repair the gcode body of one macro section's raw text."""
    lines = section_text.split('\n')
    gcode_index = -1
    for index, line in enumerate(lines):
        if RE_GCODE_PARAM.match(line):
            gcode_index = index
            break
    if gcode_index == -1:
        return None

    body_end = len(lines)
    for index in range(gcode_index + 1, len(lines)):
        line = lines[index]
        if line.strip() == '':
            continue
        if RE_SECTION_HEADER.match(line):
            body_end = index
            break
        if RE_PARAM_KEY.match(line):
            body_end = index
            break

    body = '\n'.join(lines[gcode_index + 1:body_end])
    repair = repair_unclosed_jinja_block(body)
    if repair is None:
        return None

    repaired_body_lines = repair['repaired'].split('\n')
    return {
        'text': '\n'.join(
            lines[:gcode_index + 1]
            + repaired_body_lines
            + lines[body_end:]
        ),
        'added': repair['added'],
    }


def repair_unclosed_jinja_in_config_text(config_text: str) -> dict:
    """Repair every macro section in a raw cfg block with an unclosed Jinja block.

    Returns ``{'text': str, 'repaired_sections': list[str]}`` where
    ``repaired_sections`` holds the full headers of the sections touched.
    """
    lines = config_text.split('\n')
    repaired_sections: list[str] = []
    out: list[str] = []
    section_start = -1
    current_header = ''

    def _flush_section(end_index: int) -> None:
        nonlocal section_start, current_header
        if section_start == -1:
            return
        section_lines = lines[section_start:end_index]
        header_lower = current_header.lower()
        if any(prefix in header_lower for prefix in MACRO_SECTION_PREFIXES):
            repair = repair_unclosed_jinja_in_section_text(
                '\n'.join(section_lines)
            )
            if repair:
                out.extend(repair['text'].split('\n'))
                repaired_sections.append(current_header)
                return
        out.extend(section_lines)

    for index, line in enumerate(lines):
        match = RE_SECTION_HEADER_INNER.match(line)
        if match:
            if section_start == -1:
                out.extend(lines[:index])
            else:
                _flush_section(index)
            section_start = index
            current_header = match.group(1).strip()
    _flush_section(len(lines))

    if not repaired_sections:
        return {'text': config_text, 'repaired_sections': []}
    return {'text': '\n'.join(out), 'repaired_sections': repaired_sections}


# ── configDiff: normalizeDiffText (for change detection) ────────────────

def _normalize_diff_text(text: str) -> str:
    lines = re.sub(r'\r\n?', '\n', text).split('\n')
    lines = [re.sub(r'[ \t]+$', '', line) for line in lines]
    normalized: list[str] = []
    previous_blank = False
    for line in lines:
        is_blank = len(line.strip()) == 0
        if is_blank and previous_blank:
            continue
        normalized.append(line)
        previous_blank = is_blank
    return '\n'.join(normalized)


# ── Parsing / config text helpers ───────────────────────────────────────

def parse_cfg_sections(text: str, filename: str) -> ConfigFile:
    """Parse a config string into a ``ConfigFile`` via ``parser.parse_config``."""
    return parse_config(text, filename)


def _get_config_text(
    filename: str, base_configs: dict[str, ConfigFile]
) -> str:
    """Current text of a base config (mirrors api.exportConfig/getConfigText)."""
    cfg = base_configs.get(filename)
    if cfg is None:
        return ''
    return smart_export(cfg)


def _clone_config_with_raw_text(config: ConfigFile, raw_text: str) -> ConfigFile:
    return ConfigFile(
        filename=config.filename,
        sections=list(config.sections),
        includes=list(config.includes),
        header_comments=list(config.header_comments),
        raw_text=raw_text,
    )


# ── Top-level apply pipeline ────────────────────────────────────────────

def apply_reply_to_configs(
    reply_content: str, base_configs: dict[str, ConfigFile]
) -> dict:
    """Build merged configs from an assistant reply, mirroring the frontend.

    Combines ``buildAssistantDraftTargetConfigs`` + ``prepareAssistantDraftPreview``
    minus the preview: returns ``{'files': {...}, 'repaired_sections': [...],
    'full_rewrite_sections': [...], 'errors': [...]}``.

    Each entry of ``files`` maps ``filename`` to ``{'merged_config': ConfigFile,
    'merged_text': str, 'changes': list[dict]}``.  ``errors`` holds
    human-readable strings for the conditions under which the TS frontend
    throws (no config block, no target file, no change, no sections).
    """
    errors: list[str] = []

    config_blocks = extract_config_code_blocks(reply_content)
    if not config_blocks:
        return {
            'files': {},
            'repaired_sections': [],
            'full_rewrite_sections': [],
            'errors': [
                'The assistant response did not include a config code block to review.'
            ],
        }

    loaded_config_filenames = list(base_configs.keys())
    # activeFile is not a parameter of the backend API; default to the first
    # loaded config file so target resolution and mini-diff base lookups behave
    # sensibly instead of binding to an empty filename.
    active_file = loaded_config_filenames[0] if loaded_config_filenames else ''

    hint_texts = [reply_content]
    mentioned_filenames = extract_mentioned_config_filenames(
        hint_texts, loaded_config_filenames
    )

    grouped_targets: dict[str, ConfigFile] = {}
    repaired_sections: list[str] = []
    full_rewrite_sections: list[dict] = []

    for config_block in config_blocks:
        config_text, file_hint = extract_assistant_file_hint(
            config_block, loaded_config_filenames
        )
        if not config_text.strip():
            continue

        assistant_parse_filename = (
            file_hint
            or (mentioned_filenames[0] if mentioned_filenames else None)
            or active_file
            or (loaded_config_filenames[0] if loaded_config_filenames else None)
            or 'printer.cfg'
        )

        draft_config_text = config_text
        block_is_mini_diff = is_mini_diff_block(draft_config_text)
        mini_diff_apply_failed = False
        if block_is_mini_diff:
            base_file_text = _get_config_text(
                assistant_parse_filename, base_configs
            )
            if base_file_text:
                applied = apply_mini_diff_block(
                    draft_config_text, base_file_text
                )
                if applied['applied']:
                    draft_config_text = applied['text']
                else:
                    mini_diff_apply_failed = True
        if mini_diff_apply_failed:
            draft_config_text = strip_mini_diff_markers(draft_config_text)

        repair_result = repair_unclosed_jinja_in_config_text(draft_config_text)
        if repair_result['repaired_sections']:
            draft_config_text = repair_result['text']
            repaired_sections.extend(repair_result['repaired_sections'])

        processed_config_text = preprocess_delete_markers(draft_config_text)
        assistant_result = parse_cfg_sections(
            processed_config_text, assistant_parse_filename
        )

        if not assistant_result.sections:
            continue

        target_file = resolve_assistant_target_file(
            assistant_result,
            base_configs,
            active_file,
            [file_hint] if file_hint else mentioned_filenames,
        )
        if not target_file:
            return {
                'files': {},
                'repaired_sections': [],
                'full_rewrite_sections': [],
                'errors': [
                    'Unable to determine which config file should receive the assistant changes.'
                ],
            }

        if not block_is_mini_diff or mini_diff_apply_failed:
            for section in assistant_result.sections:
                full_rewrite_sections.append({
                    'filename': target_file,
                    'full_header': section.full_header,
                })

        existing_target = grouped_targets.get(target_file)
        if existing_target is not None:
            grouped_targets[target_file] = ConfigFile(
                filename=existing_target.filename,
                includes=list(dict.fromkeys(
                    list(existing_target.includes) + list(assistant_result.includes)
                )),
                header_comments=(
                    list(existing_target.header_comments)
                    if len(existing_target.header_comments) > 0
                    else list(assistant_result.header_comments)
                ),
                sections=list(existing_target.sections)
                    + list(assistant_result.sections),
                raw_text=existing_target.raw_text,
            )
        else:
            grouped_targets[target_file] = ConfigFile(
                filename=target_file,
                includes=list(assistant_result.includes),
                header_comments=list(assistant_result.header_comments),
                sections=list(assistant_result.sections),
                raw_text=assistant_result.raw_text,
            )

    if not grouped_targets:
        return {
            'files': {},
            'repaired_sections': [],
            'full_rewrite_sections': [],
            'errors': [
                'The assistant response did not include any complete config sections to merge.'
            ],
        }

    files: dict[str, dict] = {}

    for target_file, assistant_config in grouped_targets.items():
        base_text = _get_config_text(target_file, base_configs)

        if not base_text:
            # New file proposed by the assistant — merge against an empty base.
            empty_base_config = ConfigFile(
                filename=target_file,
                includes=[],
                header_comments=[],
                sections=[],
                raw_text='',
            )
            merged = merge_assistant_sections(
                empty_base_config, assistant_config
            )
            merged_config = merged['merged_config']
            merged_text = smart_export(
                _clone_config_with_raw_text(merged_config, '')
            )
            files[target_file] = {
                'merged_config': merged_config,
                'merged_text': merged_text,
                'changes': merged['changes'],
            }
            continue

        base_result = parse_cfg_sections(base_text, target_file)
        base_config = ConfigFile(
            filename=target_file,
            sections=list(base_result.sections),
            includes=list(base_result.includes),
            header_comments=list(base_result.header_comments),
            raw_text=base_text,
        )

        merged = merge_assistant_sections(base_config, assistant_config)
        merged_config = merged['merged_config']
        merged_text = smart_export(
            _clone_config_with_raw_text(merged_config, base_text)
        )

        text_changed = (
            _normalize_diff_text(base_text)
            != _normalize_diff_text(merged_text)
        )
        if not text_changed and not merged['changes']:
            continue

        files[target_file] = {
            'merged_config': merged_config,
            'merged_text': merged_text,
            'changes': merged['changes'],
        }

    if not files:
        errors.append('The assistant response does not change the current draft.')

    return {
        'files': files,
        'repaired_sections': repaired_sections,
        'full_rewrite_sections': full_rewrite_sections,
        'errors': errors,
    }
