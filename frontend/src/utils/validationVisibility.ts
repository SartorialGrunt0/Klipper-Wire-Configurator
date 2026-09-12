/* Severity-visibility filter for config-validation findings — pure logic.

   The backend (and therefore the MCP tools) always produce FULL findings;
   this layer decides what the config UI renders. Every UI surface —
   editor gutter + issue list, file dots, section card, save/export gate,
   save button color, graph node dots — must filter through here so no two
   surfaces ever disagree about what is visible.

   Master-off semantics: NO findings are visible anywhere (the store also
   stops calling the validation endpoints). Per-severity toggles hide just
   that tier. Parse-failure state (textParseErrors) is a data-loss guard,
   NOT a validation finding, and is deliberately never filtered here.
*/
import type { ValidationError, ValidationResult } from '../types/config';

export interface SeverityVisibility {
  enabled: boolean;
  showError: boolean;
  showWarning: boolean;
  showInfo: boolean;
}

export const ALL_VISIBLE: SeverityVisibility = {
  enabled: true,
  showError: true,
  showWarning: true,
  showInfo: true,
};

/** True when one finding of `severity` should be shown in the UI. */
export function severityVisible(
  severity: ValidationError['severity'],
  settings: SeverityVisibility,
): boolean {
  if (!settings.enabled) return false;
  if (severity === 'error') return settings.showError;
  if (severity === 'warning') return settings.showWarning;
  return settings.showInfo;
}

/** Filter one file's findings array down to what the UI should render. */
export function filterFindings<T extends { severity: ValidationError['severity'] }>(
  findings: readonly T[],
  settings: SeverityVisibility,
): T[] {
  if (!settings.enabled) return [];
  return findings.filter((f) => severityVisible(f.severity, settings));
}

/** Filter the whole project validation map. Master-off returns an empty
 *  map so every consumer (save button, gate, dots) reads a clean project. */
export function filterValidationMap(
  validation: Record<string, ValidationResult>,
  settings: SeverityVisibility,
): Record<string, ValidationResult> {
  if (!settings.enabled) return {};
  if (settings.showError && settings.showWarning && settings.showInfo) {
    return validation;
  }
  const out: Record<string, ValidationResult> = {};
  for (const [file, result] of Object.entries(validation)) {
    const errors = filterFindings(result.errors, settings);
    out[file] = {
      ...result,
      errors,
      has_errors: errors.some((e) => e.severity === 'error'),
      has_warnings: errors.some((e) => e.severity === 'warning'),
    };
  }
  return out;
}

/** Graph-UI colored dots exist to surface error/warning findings. When
 *  validation is off — or both of those tiers are hidden — the dots are
 *  removed entirely (a green "valid" dot over hidden findings would lie). */
export function validationDotsVisible(settings: SeverityVisibility): boolean {
  return settings.enabled && (settings.showError || settings.showWarning);
}
