import type { ConfigFile, ConfigSection } from '@/types/config';

export interface ResolvedSection {
  section: ConfigSection;
  filename: string;
}

/**
 * Resolve a section by (header, file?, line?).
 *
 * When a config file is carried, that file is authoritative: search it first
 * by exact line match when a line is known, then by header alone. If the
 * carried file has no match, return null — never fall through to a
 * duplicate header in another file (that is the bug this util fixes).
 *
 * Cross-file search happens only when NO file is carried (legacy behavior),
 * preferring an exact line match when one is known.
 *
 * Returns null when nothing matches.
 */
export function resolveSection(
  configFiles: Record<string, ConfigFile>,
  header: string | null,
  configFile?: string | null,
  lineNumber?: number | null,
): ResolvedSection | null {
  if (!header) return null;

  const lineMatch = (s: ConfigSection) =>
    lineNumber == null || lineNumber === 0 || s.line_number === lineNumber;

  if (configFile) {
    const cf = configFiles[configFile];
    if (!cf) return null;
    const found = cf.sections.find((s) => s.full_header === header && lineMatch(s));
    if (found) return { section: found, filename: configFile };
    return null;
  }

  // Fallback: search across all config files (legacy behavior)
  for (const [filename, cf] of Object.entries(configFiles)) {
    const found = cf.sections.find((s) => s.full_header === header && lineMatch(s));
    if (found) return { section: found, filename };
  }
  return null;
}
