import type { ConfigSection, SectionSchema } from '../types/config';

export interface UniqueSectionDraft {
  sectionName: string;
  fullHeader: string;
  label: string;
}

type SectionLike = Pick<ConfigSection, 'section_type' | 'section_name' | 'full_header'>;

const EXTRUDER_SECTION_RE = /^extruder(\d+)?$/;
const STEPPER_SECTION_RE = /^stepper_([a-z]+)(\d+)?$/;
const STEPPER_DRIVER_TYPES = new Set(['tmc2209', 'tmc2208', 'tmc2130', 'tmc2240', 'tmc5160', 'tmc2660']);

function nextAvailableIndex(used: Set<number>, start = 1): number {
  let candidate = start;
  while (used.has(candidate)) {
    candidate += 1;
  }
  return candidate;
}

function buildUnnamedDraft(fullHeader: string, label: string): UniqueSectionDraft {
  return {
    sectionName: '',
    fullHeader,
    label,
  };
}

function getDriverReferenceName(section: SectionLike): string | null {
  if (STEPPER_SECTION_RE.test(section.section_type) || EXTRUDER_SECTION_RE.test(section.section_type)) {
    return section.section_type;
  }
  if ((section.section_type === 'manual_stepper' || section.section_type === 'extruder_stepper') && section.section_name) {
    return section.section_name;
  }
  return null;
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

function buildExtruderDraft(
  sectionType: string,
  displayName: string,
  existingSections: SectionLike[],
  existingHeaders: Set<string>,
): UniqueSectionDraft {
  const match = EXTRUDER_SECTION_RE.exec(sectionType);
  if (!match) {
    return buildUnnamedDraft(sectionType, displayName);
  }

  const requestedIndex = match[1] ? Number(match[1]) : 0;
  const used = new Set<number>();
  for (const section of existingSections) {
    const candidate = EXTRUDER_SECTION_RE.exec(section.section_type);
    if (!candidate) continue;
    used.add(candidate[1] ? Number(candidate[1]) : 0);
  }

  const requestedHeader = requestedIndex === 0 ? 'extruder' : `extruder${requestedIndex}`;
  const chosenIndex = existingHeaders.has(requestedHeader)
    ? nextAvailableIndex(used, 1)
    : requestedIndex;
  const fullHeader = chosenIndex === 0 ? 'extruder' : `extruder${chosenIndex}`;
  return buildUnnamedDraft(fullHeader, chosenIndex === 0 ? displayName : fullHeader);
}

function buildStepperDraft(
  sectionType: string,
  displayName: string,
  existingSections: SectionLike[],
  existingHeaders: Set<string>,
): UniqueSectionDraft {
  const match = STEPPER_SECTION_RE.exec(sectionType);
  if (!match) {
    return buildUnnamedDraft(sectionType, displayName);
  }

  const axis = match[1];
  const requestedIndex = match[2] ? Number(match[2]) : 0;
  const used = new Set<number>();
  for (const section of existingSections) {
    const candidate = STEPPER_SECTION_RE.exec(section.section_type);
    if (!candidate || candidate[1] !== axis) continue;
    used.add(candidate[2] ? Number(candidate[2]) : 0);
  }

  const requestedHeader = requestedIndex === 0 ? `stepper_${axis}` : `stepper_${axis}${requestedIndex}`;
  const chosenIndex = existingHeaders.has(requestedHeader)
    ? nextAvailableIndex(used, 1)
    : requestedIndex;
  const fullHeader = chosenIndex === 0 ? `stepper_${axis}` : `stepper_${axis}${chosenIndex}`;
  return buildUnnamedDraft(fullHeader, chosenIndex === 0 ? displayName : fullHeader);
}

function buildDriverDraft(
  sectionType: string,
  displayName: string,
  existingSections: SectionLike[],
  existingHeaders: Set<string>,
): UniqueSectionDraft {
  const candidateReferences = Array.from(
    new Set(existingSections.map((section) => getDriverReferenceName(section)).filter((name): name is string => Boolean(name))),
  );
  const usedReferences = new Set(
    existingSections
      .filter((section) => section.section_type === sectionType && section.section_name)
      .map((section) => section.section_name),
  );

  const availableReference = candidateReferences.find(
    (reference) => !usedReferences.has(reference) && !existingHeaders.has(`${sectionType} ${reference}`),
  );
  if (availableReference) {
    return {
      sectionName: availableReference,
      fullHeader: `${sectionType} ${availableReference}`,
      label: `${displayName}: ${availableReference}`,
    };
  }

  const fallbackName = `${sectionType}_default`;
  const fallbackHeader = `${sectionType} ${fallbackName}`;
  if (!existingHeaders.has(fallbackHeader)) {
    return {
      sectionName: fallbackName,
      fullHeader: fallbackHeader,
      label: `${displayName}: ${fallbackName}`,
    };
  }

  const next = buildIncrementedHeader(sectionType, fallbackName, existingHeaders);
  return {
    ...next,
    label: `${displayName}: ${next.sectionName}`,
  };
}

export function buildUniqueSectionDraft(
  sectionType: string,
  displayName: string,
  schema: Pick<SectionSchema, 'is_named' | 'component_group'> | undefined,
  existingSections: Iterable<SectionLike>,
): UniqueSectionDraft {
  const sections = Array.from(existingSections);
  const headers = new Set(sections.map((section) => section.full_header));

  if (EXTRUDER_SECTION_RE.test(sectionType)) {
    return buildExtruderDraft(sectionType, displayName, sections, headers);
  }

  if (STEPPER_SECTION_RE.test(sectionType)) {
    return buildStepperDraft(sectionType, displayName, sections, headers);
  }

  if (schema?.component_group === 'stepper_driver' || STEPPER_DRIVER_TYPES.has(sectionType)) {
    return buildDriverDraft(sectionType, displayName, sections, headers);
  }

  if (schema?.is_named) {
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