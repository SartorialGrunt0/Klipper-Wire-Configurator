import type { ConfigFile, ConfigParam, ConfigSection } from '../types/config';

export interface AssistantDraftChange {
  id: string;
  filename: string;
  fullHeader: string;
  mode: 'update' | 'add';
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
  const mergedParams = existingParams.map((param) => cloneParam(param));
  const usedIndexes = new Set<number>();
  let insertIndex = mergedParams.length;

  assistantParams.forEach((assistantParam) => {
    const nextParam = cloneParam(assistantParam);

    if (assistantParam.key === '_comment_') {
      mergedParams.splice(insertIndex, 0, nextParam);
      insertIndex += 1;
      return;
    }

    const matchingIndex = pickMatchingParamIndex(
      mergedParams,
      assistantParam.key,
      assistantParam.is_commented_out,
      usedIndexes,
    );

    if (matchingIndex != null) {
      const existingParam = mergedParams[matchingIndex];
      mergedParams[matchingIndex] = {
        ...existingParam,
        ...nextParam,
        comment: nextParam.comment || existingParam.comment,
        separator: nextParam.separator ?? existingParam.separator,
      };
      usedIndexes.add(matchingIndex);
      insertIndex = matchingIndex + 1;
      return;
    }

    mergedParams.splice(insertIndex, 0, nextParam);
    insertIndex += 1;
  });

  return mergedParams;
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
  const changes: AssistantDraftChange[] = [];
  let lastAnchorIndex = baseSections.length > 0 ? baseSections.length - 1 : -1;

  assistantSections.forEach((assistantSection, assistantSectionIndex) => {
    const seenCount = seenHeaders.get(assistantSection.full_header) ?? 0;
    seenHeaders.set(assistantSection.full_header, seenCount + 1);
    const changeId = buildAssistantDraftChangeId(baseConfig.filename, assistantSection, assistantSectionIndex);
    const shouldApply = selectedIdSet == null || selectedIdSet.has(changeId);

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

  baseSections.forEach((section, index) => {
    mergedSections.push(replacements.get(index) ?? section);
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