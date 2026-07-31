import type { ConfigFile, ConfigParam, ConfigSection } from '../types/config';

export interface AssistantDraftChange {
  id: string;
  filename: string;
  fullHeader: string;
  mode: 'update' | 'add' | 'delete';
}

function buildAssistantDraftChangeId(
  filename: string,
  section: ConfigSection,
  assistantSectionIndex: number,
): string {
  return `${filename}:${assistantSectionIndex}:${section.full_header}`;
}

function buildSectionIndex(sections: ConfigSection[]): Map<string, number[]> {
  const sectionIndex = new Map<string, number[]>();

  sections.forEach((section, index) => {
    const existing = sectionIndex.get(section.full_header);
    if (existing) {
      existing.push(index);
      return;
    }
    sectionIndex.set(section.full_header, [index]);
  });

  return sectionIndex;
}

function collectIncludes(sections: ConfigSection[]): string[] {
  return sections
    .filter((section) => section.section_type === 'include')
    .map((section) => section.section_name);
}

function cloneParam(param: ConfigParam): ConfigParam {
  return { ...param };
}

function cloneSection(section: ConfigSection): ConfigSection {
  return {
    ...section,
    header_comments: [...section.header_comments],
    trailing_comments: [...(section.trailing_comments ?? [])],
    params: section.params.map((param) => cloneParam(param)),
  };
}

/**
 * Special section type used by the AI to signal "delete this entire section."
 *
 * The AI outputs `*[section_name]` inside a cfg block. Before parsing,
 * the frontend preprocesses this into:
 *
 *   [delete_section]
 *   section: section_name
 *
 * The `delete_section` type is not a real Klipper section — it's a meta-
 * instruction that tells the merge logic to remove the named section.
 * The `*` symbol keeps deletion visually distinct from `#[header]`
 * (which means "comment out / disable").
 */
const DELETE_SECTION_TYPE = 'delete_section';

/**
 * Regex to match `*[section_name]` deletion markers inside raw cfg block text.
 */
export const DELETE_MARKER_RE = /^\*\[([^\]]+)\]\s*$/m;

/**
 * Preprocess raw cfg block text, converting `*[section_name]` lines into
 * `[delete_section]\nsection: section_name` blocks for parsing.
 */
export function preprocessDeleteMarkers(text: string): string {
  return text.replace(DELETE_MARKER_RE, (_match, sectionName: string) => {
    return `[delete_section]\nsection: ${sectionName.trim()}`;
  });
}

/**
 * Detect whether a section from the assistant represents a deletion signal.
 *
 * A delete section has `section_type === "delete_section"` with a `section`
 * param naming the target to remove.
 */
function isDeleteSection(section: ConfigSection): boolean {
  if (section.section_type !== DELETE_SECTION_TYPE) {
    return false;
  }
  const targetParam = section.params.find((p) => p.key === 'section');
  return targetParam != null && targetParam.value.trim().length > 0;
}

/**
 * Get the target section name from a delete_section entry.
 */
function getDeleteTarget(section: ConfigSection): string | null {
  const targetParam = section.params.find((p) => p.key === 'section');
  return targetParam?.value.trim() ?? null;
}


function pickMatchingParamIndex(
  params: ConfigParam[],
  key: string,
  isCommentedOut: boolean,
  usedIndexes: Set<number>,
): number | null {
  const exactStateMatch = params.findIndex(
    (param, index) => !usedIndexes.has(index) && param.key === key && param.is_commented_out === isCommentedOut,
  );
  if (exactStateMatch !== -1) {
    return exactStateMatch;
  }

  const activeMatch = params.findIndex(
    (param, index) => !usedIndexes.has(index) && param.key === key && !param.is_commented_out,
  );
  if (activeMatch !== -1) {
    return activeMatch;
  }

  const fallbackMatch = params.findIndex(
    (param, index) => !usedIndexes.has(index) && param.key === key,
  );
  return fallbackMatch === -1 ? null : fallbackMatch;
}

function mergeAssistantParams(existingParams: ConfigParam[], assistantParams: ConfigParam[]): ConfigParam[] {
  // Phase 1: Match AI params to existing params using the same
  // priority logic as the original code (exact state match first,
  // then active, then any). Each AI param matches at most ONE
  // existing param so we don't force-uncomment #serial lines.
  //
  // unlinkedAiKeys: AI param keys that didn't match any existing
  //   param — these are new params or key renames (e.g. typo fixes)
  //   and will be appended at the end.
  // matchedExistingIndexes: indexes of existing params that were
  //   matched by an AI param and should be updated in place.
  // aiKeysPresentInExisting: AI param keys that matched at least
  //   one existing param — used to decide which existing params
  //   to keep vs. exclude.
  const unlinkedAiKeys = new Set(
    assistantParams
      .filter((p) => p.key !== '_comment_')
      .map((p) => p.key),
  );
  const matchedExistingIndexes = new Set<number>();

  for (const aiParam of assistantParams) {
    if (aiParam.key === '_comment_') {
      continue;
    }

    const matchIndex = pickMatchingParamIndex(
      existingParams,
      aiParam.key,
      aiParam.is_commented_out,
      matchedExistingIndexes,
    );

    if (matchIndex !== null) {
      matchedExistingIndexes.add(matchIndex);
      unlinkedAiKeys.delete(aiParam.key);
    }
  }

  // Phase 2: Walk existing params in order.
  // - Comments (_comment_) are always preserved in place.
  // - Matched params are updated with AI values, but preserve the
  //   existing param's is_commented_out state so #comment lines
  //   stay commented.
  // - Unmatched existing params whose key IS present in the AI's
  //   output are kept unchanged (the AI mentioned this key but
  //   didn't match THIS specific instance — e.g. duplicate lines).
  // - Unmatched existing params whose key is NOT in the AI's
  //   output are excluded (the AI intentionally removed them).
  const aiKeySet = new Set(
    assistantParams
      .filter((p) => p.key !== '_comment_')
      .map((p) => p.key),
  );
  const result: ConfigParam[] = [];
  const usedAiKeys = new Set<string>();

  existingParams.forEach((existingParam, index) => {
    if (existingParam.key === '_comment_') {
      result.push(cloneParam(existingParam));
      return;
    }

    if (matchedExistingIndexes.has(index)) {
      // This existing param was matched by an AI param — merge values
      const aiParams = assistantParams.filter(
        (p) => p.key === existingParam.key && p.key !== '_comment_',
      );
      // Use the last matching AI param (same as Map.set behavior)
      const aiParam = aiParams[aiParams.length - 1];
      if (aiParam) {
        const clonedAi = cloneParam(aiParam);
        result.push({
          ...cloneParam(existingParam),
          ...clonedAi,
          is_commented_out: existingParam.is_commented_out, // preserve comment state
          comment: clonedAi.comment || existingParam.comment,
          separator: clonedAi.separator ?? existingParam.separator,
        });
        usedAiKeys.add(existingParam.key);
        return;
      }
    }

    if (aiKeySet.has(existingParam.key)) {
      // AI mentioned this key but matched a different instance —
      // keep this existing param unchanged.
      result.push(cloneParam(existingParam));
      return;
    }

    // Unmatched existing param whose key is NOT in the AI's output —
    // excluded (AI intentionally removed it).
    // This handles typo fixes (baude→baud), param renames, deletions.
  });

  // Phase 3: Append unlinked AI params (new params / key renames).
  // Track pushed keys to prevent duplicates.
  for (const param of assistantParams) {
    if (param.key === '_comment_') {
      continue;
    }
    if (!usedAiKeys.has(param.key) && unlinkedAiKeys.has(param.key)) {
      result.push(cloneParam(param));
      usedAiKeys.add(param.key);
    }
  }

  // Phase 4: Append AI comments/blank lines that aren't duplicates
  // of existing comments or other AI comments.
  const pushedCommentValues = new Set<string>();
  for (const param of assistantParams) {
    if (param.key !== '_comment_') {
      continue;
    }
    if (pushedCommentValues.has(param.value)) {
      continue;
    }
    const inExisting = existingParams.some(
      (ep) => ep.key === '_comment_' && ep.value === param.value,
    );
    if (!inExisting) {
      result.push(cloneParam(param));
      pushedCommentValues.add(param.value);
    }
  }

  return result;
}

function mergeAssistantSection(existingSection: ConfigSection, assistantSection: ConfigSection): ConfigSection {
  return {
    ...cloneSection(existingSection),
    ...cloneSection(assistantSection),
    line_number: existingSection.line_number ?? assistantSection.line_number,
    is_commented_out: assistantSection.is_commented_out ?? existingSection.is_commented_out,
    header_comments: existingSection.header_comments.length > 0
      ? [...existingSection.header_comments]
      : [...assistantSection.header_comments],
    trailing_comments: (existingSection.trailing_comments?.length ?? 0) > 0
      ? [...(existingSection.trailing_comments ?? [])]
      : [...(assistantSection.trailing_comments ?? [])],
    params: mergeAssistantParams(existingSection.params, assistantSection.params),
  };
}

export function mergeAssistantSectionsIntoConfig(
  baseConfig: ConfigFile,
  assistantConfig: ConfigFile,
  selectedChangeIds?: Iterable<string>,
): { mergedConfig: ConfigFile; changes: AssistantDraftChange[] } {
  const baseSections = baseConfig.sections ?? [];
  const assistantSections = assistantConfig.sections ?? [];
  const sectionIndex = buildSectionIndex(baseSections);
  const replacements = new Map<number, ConfigSection>();
  const insertsByAnchor = new Map<number, ConfigSection[]>();
  const seenHeaders = new Map<string, number>();
  const selectedIdSet = selectedChangeIds == null ? null : new Set(selectedChangeIds);
  const deletedIndexes = new Set<number>();
  const changes: AssistantDraftChange[] = [];
  let lastAnchorIndex = baseSections.length > 0 ? baseSections.length - 1 : -1;

  assistantSections.forEach((assistantSection, assistantSectionIndex) => {
    const seenCount = seenHeaders.get(assistantSection.full_header) ?? 0;
    seenHeaders.set(assistantSection.full_header, seenCount + 1);
    const changeId = buildAssistantDraftChangeId(baseConfig.filename, assistantSection, assistantSectionIndex);
    const shouldApply = selectedIdSet == null || selectedIdSet.has(changeId);

    // Check if this assistant section signals a deletion
    if (isDeleteSection(assistantSection)) {
      const targetName = getDeleteTarget(assistantSection);
      if (targetName) {
        const existingIndex = sectionIndex.get(targetName)?.[0];
        if (existingIndex != null) {
          changes.push({
            id: changeId,
            filename: baseConfig.filename,
            fullHeader: targetName,
            mode: 'delete',
          });
          if (shouldApply) {
            deletedIndexes.add(existingIndex);
          }
          return;
        }
        // Target section not found in base config — still record the
        // proposed deletion as a change so the UI shows it (user can
        // see what the AI suggested even if it's a no-op).
        changes.push({
          id: changeId,
          filename: baseConfig.filename,
          fullHeader: targetName,
          mode: 'delete',
        });
        return;
      }
      return;
    }

    const existingIndex = sectionIndex.get(assistantSection.full_header)?.[seenCount];
    if (existingIndex != null) {
      changes.push({
        id: changeId,
        filename: baseConfig.filename,
        fullHeader: assistantSection.full_header,
        mode: 'update',
      });
      lastAnchorIndex = existingIndex;
      if (!shouldApply) {
        return;
      }

      const existingSection = baseSections[existingIndex];
      replacements.set(existingIndex, mergeAssistantSection(existingSection, assistantSection));
      return;
    }

    changes.push({
      id: changeId,
      filename: baseConfig.filename,
      fullHeader: assistantSection.full_header,
      mode: 'add',
    });
    if (!shouldApply) {
      return;
    }

    const anchoredSections = insertsByAnchor.get(lastAnchorIndex) ?? [];
    anchoredSections.push(cloneSection(assistantSection));
    insertsByAnchor.set(lastAnchorIndex, anchoredSections);
  });

  const mergedSections: ConfigSection[] = [];
  const leadingSections = insertsByAnchor.get(-1);
  if (leadingSections) {
    mergedSections.push(...leadingSections);
  }

  // Collect header_comments from deleted sections so divider banners,
  // explanatory comments, and separator lines above a deleted section
  // are preserved in the output rather than removed along with the section.
  const pendingDeletedComments: string[] = [];

  baseSections.forEach((section, index) => {
    if (deletedIndexes.has(index)) {
      // Collect the deleted section's header_comments for preservation
      if (section.header_comments?.length) {
        pendingDeletedComments.push(...section.header_comments);
      }
      // Emit any new sections that were anchored at this index
      // (e.g. replacing a deleted [probe] with a new [bltouch])
      const anchoredSections = insertsByAnchor.get(index);
      if (anchoredSections) {
        mergedSections.push(...anchoredSections);
      }
      return;
    }

    // Clone or get the merged section (must be a fresh object to mutate safely)
    const mergedSection = replacements.has(index)
      ? (replacements.get(index) as ConfigSection)
      : cloneSection(section);

    // Prepend preserved comments from any previously deleted section(s)
    if (pendingDeletedComments.length > 0) {
      mergedSection.header_comments = [
        ...pendingDeletedComments,
        ...mergedSection.header_comments,
      ];
      pendingDeletedComments.length = 0;
    }

    mergedSections.push(mergedSection);
    const anchoredSections = insertsByAnchor.get(index);
    if (anchoredSections) {
      mergedSections.push(...anchoredSections);
    }
  });

  return {
    mergedConfig: {
      ...baseConfig,
      header_comments: baseConfig.header_comments.length > 0 ? baseConfig.header_comments : assistantConfig.header_comments,
      includes: collectIncludes(mergedSections),
      sections: mergedSections,
      raw_text: baseConfig.raw_text,
    },
    changes,
  };
}