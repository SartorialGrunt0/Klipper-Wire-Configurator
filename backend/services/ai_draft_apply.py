"""Fenced cfg-block extraction for AI chat replies (display-only since
the Phase-4 ratchet, 2026-09-22).

The full TS draft-apply/merge port that lived here (mini-diff apply,
assistantDraftMerge, jinjaBlockRepair, apply_reply_to_configs) was deleted
with the prose-draft path: config edits now go through config_edit/
config_write + the approval card. The ONLY surviving consumer is the
edit-prose nudge gate in ``api/ai_routes.py``, which uses
``extract_config_code_blocks`` to detect an inert cfg draft (display echo
vs unapplied draft) — nothing applies these blocks as edits anymore.

Mirrors ``frontend/src/utils/chatUtils.ts`` extractConfigCodeBlocks.
"""
from __future__ import annotations

import re

CONFIG_CODE_LANGUAGES = frozenset(
    ['', 'cfg', 'conf', 'ini', 'klipper', 'printercfg']
)

# A fenced ```code block: open fence, optional non-empty/backtick language,
# then the block body until the closing ```.  Mirrors /```([^\n`]*)\n([\s\S]*?)```/g.
RE_CODE_BLOCK = re.compile(r'```([^\n`]*)\n([\s\S]*?)```')

# Raw-content fallback: delete marker ``*[section]`` or a ``# file:`` hint
# anywhere in the text (multiline).  Mirrors /^\s*(?:[*]\[[^\]]+\]|[#;]\s*file\s*:)/m.
RE_CONFIG_LIKE = re.compile(r'^\s*(?:\*\[[^\]]+\]|[#;]\s*file\s*:)', re.MULTILINE)


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
