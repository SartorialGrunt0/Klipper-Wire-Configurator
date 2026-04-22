export interface UniqueSectionDraft {
  sectionName: string;
  fullHeader: string;
  label: string;
}

function buildIncrementedHeader(sectionType: string, baseName: string, existingHeaders: Set<string>): UniqueSectionDraft {
  let counter = 2;
  let sectionName = `${baseName}_${counter}`;
  let fullHeader = `${sectionType} ${sectionName}`;

  while (existingHeaders.has(fullHeader)) {
    counter += 1;
    sectionName = `${baseName}_${counter}`;
    fullHeader = `${sectionType} ${sectionName}`;
  }

  return {
    sectionName,
    fullHeader,
    label: '',
  };
}

export function buildUniqueSectionDraft(
  sectionType: string,
  displayName: string,
  isNamed: boolean | undefined,
  existingHeaders: Iterable<string>,
): UniqueSectionDraft {
  const headers = new Set(existingHeaders);

  if (isNamed) {
    const defaultName = `${sectionType}_default`;
    const defaultHeader = `${sectionType} ${defaultName}`;
    if (!headers.has(defaultHeader)) {
      return {
        sectionName: defaultName,
        fullHeader: defaultHeader,
        label: `${displayName}: ${defaultName}`,
      };
    }

    const next = buildIncrementedHeader(sectionType, defaultName, headers);
    return {
      ...next,
      label: `${displayName}: ${next.sectionName}`,
    };
  }

  if (!headers.has(sectionType)) {
    return {
      sectionName: '',
      fullHeader: sectionType,
      label: displayName,
    };
  }

  const next = buildIncrementedHeader(sectionType, sectionType, headers);
  return {
    ...next,
    label: `${displayName}: ${next.sectionName}`,
  };
}