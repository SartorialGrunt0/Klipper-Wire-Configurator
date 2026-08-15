import type { ConfigSection } from '../types/config';

/**
 * Toggle a section's suppressed (commented-out) state while preserving
 * per-param comment state.
 *
 * Suppressing comments out every real param AND records each param's prior
 * `is_commented_out` in `suppressedParams`. Unsuppressing restores that
 * recorded state — so params the user individually commented stay commented —
 * rather than enabling everything. Sections with no recorded snapshot (e.g.
 * loaded from disk already suppressed) enable all params on unsuppress, which
 * matches the old behavior.
 *
 * `_comment_` pseudo-params (standalone comment lines) are never touched.
 */
export function toggleSectionSuppressed(
  section: ConfigSection,
  suppress: boolean,
): ConfigSection {
  if (suppress) {
    const suppressedParams: Record<string, boolean> = {};
    const params = section.params.map((p) => {
      if (p.key === '_comment_') return p;
      // Record the pre-suppress state so unsuppress can restore it.
      suppressedParams[p.key] = p.is_commented_out;
      return { ...p, is_commented_out: true };
    });
    return { ...section, is_commented_out: true, suppressedParams, params };
  }

  const prior = section.suppressedParams;
  const params = section.params.map((p) => {
    if (p.key === '_comment_') return p;
    const wasCommented = prior ? prior[p.key] : undefined;
    // Restore the recorded pre-suppress state; unknown params enable.
    return { ...p, is_commented_out: wasCommented ?? false };
  });
  const { suppressedParams: _dropped, ...rest } = section;
  return { ...rest, is_commented_out: false, params };
}
