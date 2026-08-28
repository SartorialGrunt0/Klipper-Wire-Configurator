/* Phase 4 save-flow validation gate — pure selection logic.

   Given the project validation map and the files selected in the save
   dialog, produce the findings that gate the save: errors + warnings
   (never info), scoped to the selection, with parse-error files reported
   separately as `blocked` (the existing hard block consumes that; a
   parse failure is a data-loss guard, a different failure class than a
   Klipper-startup finding).

   Pure + deterministic (stable ordering: errors before warnings, then
   file → line) so the dialog render never depends on Map/Set iteration
   order.
*/
import type { ValidationResult } from '@/types/config';

export interface SaveGateFinding {
  file: string;
  code?: string;
  section: string;
  param: string;
  message: string;
  line_number: number;
}

export interface SaveGateIssues {
  errors: SaveGateFinding[];
  warnings: SaveGateFinding[];
  hasErrors: boolean;
  hasWarnings: boolean;
  /** Selected files whose editor text can't be parsed — the save is
   *  hard-blocked on these (existing ApplyDialog behavior); their
   *  last-good findings are not shown in the gate lists. */
  blocked: string[];
}

export interface BulkAckIdentity {
  file: string;
  code: string;
  section: string;
  param: string;
  /** Client sends '' — the backend derives the discriminator
   *  server-side (finding_identity) so suppression always matches. */
  extra: string;
}

/** Map one warning finding to the payload for the bulk-ack endpoint. */
export function warningToBulkAck(finding: SaveGateFinding): BulkAckIdentity {
  return {
    file: finding.file,
    code: finding.code ?? '',
    section: finding.section,
    param: finding.param,
    extra: '',
  };
}

export function selectSaveGateIssues(
  validation: Record<string, ValidationResult>,
  selectedFiles: string[],
  textParseErrors: Record<string, string> = {},
): SaveGateIssues {
  const blocked = selectedFiles.filter((file) => Boolean(textParseErrors[file]));
  const blockedSet = new Set(blocked);

  const errors: SaveGateFinding[] = [];
  const warnings: SaveGateFinding[] = [];

  for (const file of selectedFiles) {
    if (blockedSet.has(file)) continue; // hard block supersedes findings
    const result = validation[file];
    if (!result) continue;
    for (const e of result.errors) {
      if (e.severity === 'info') continue; // info never gates the save
      const finding: SaveGateFinding = {
        file,
        code: e.code,
        section: e.section,
        param: e.param,
        message: e.message,
        line_number: e.line_number,
      };
      if (e.severity === 'error') errors.push(finding);
      else warnings.push(finding);
    }
  }

  const byFileThenLine = (a: SaveGateFinding, b: SaveGateFinding): number =>
    a.file.localeCompare(b.file) || a.line_number - b.line_number;
  errors.sort(byFileThenLine);
  warnings.sort(byFileThenLine);

  return {
    errors,
    warnings,
    hasErrors: errors.length > 0,
    hasWarnings: warnings.length > 0,
    blocked,
  };
}
