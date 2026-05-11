import type { ConfigFile, ConfigSection } from '../types/config';

export interface AssistantDraftChange {
  id: string;
  fullHeader: string;
  mode: 'update' | 'add';
}

function buildAssistantDraftChangeId(section: ConfigSection, assistantSectionIndex: number): string {
  return `${assistantSectionIndex}:${section.full_header}`;
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
    const changeId = buildAssistantDraftChangeId(assistantSection, assistantSectionIndex);
    const shouldApply = selectedIdSet == null || selectedIdSet.has(changeId);

    const existingIndex = sectionIndex.get(assistantSection.full_header)?.[seenCount];
    if (existingIndex != null) {
      changes.push({ id: changeId, fullHeader: assistantSection.full_header, mode: 'update' });
      lastAnchorIndex = existingIndex;
      if (!shouldApply) {
        return;
      }

      const existingSection = baseSections[existingIndex];
      replacements.set(existingIndex, {
        ...assistantSection,
        line_number: existingSection?.line_number ?? assistantSection.line_number,
      });
      return;
    }

    changes.push({ id: changeId, fullHeader: assistantSection.full_header, mode: 'add' });
    if (!shouldApply) {
      return;
    }

    const anchoredSections = insertsByAnchor.get(lastAnchorIndex) ?? [];
    anchoredSections.push(assistantSection);
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