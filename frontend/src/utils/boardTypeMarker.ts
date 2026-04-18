import type { ConfigSection, HardwareType } from '../types/config';

const BOARD_TYPE_MARKER_RE = /^\s*#\s*kwc:\s*board_type\s*=\s*(sbc|mainboard|expander|toolhead|probe|accelerometer|other)\s*$/i;

export function getBoardTypeMarker(comments: string[] | undefined): HardwareType | null {
  if (!comments) return null;
  for (const comment of comments) {
    const match = comment.match(BOARD_TYPE_MARKER_RE);
    if (match) {
      return match[1].toLowerCase() as HardwareType;
    }
  }
  return null;
}

export function buildBoardTypeMarker(hardwareType: HardwareType): string {
  return `# kwc: board_type=${hardwareType}`;
}

export function applyBoardTypeMarkerToSection<T extends { header_comments?: string[] }>(
  section: T,
  hardwareType: HardwareType,
): T {
  const nextComments = (section.header_comments || []).filter(
    (comment) => !BOARD_TYPE_MARKER_RE.test(comment),
  );
  nextComments.push(buildBoardTypeMarker(hardwareType));
  return {
    ...section,
    header_comments: nextComments,
  };
}

export function applyBoardTypeMarkerToMcuSections(
  sections: ConfigSection[],
  hardwareType: HardwareType,
  mcuName = '',
): ConfigSection[] {
  const expectedHeader = mcuName ? `mcu ${mcuName}` : 'mcu';
  return sections.map((section) => {
    if (section.section_type !== 'mcu') return section;
    if (section.full_header !== expectedHeader) return section;
    return applyBoardTypeMarkerToSection(section, hardwareType);
  });
}
