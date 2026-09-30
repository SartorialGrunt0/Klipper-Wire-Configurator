import type { PendingConfigEdit } from '../services/api';

export interface ApprovedApplyPlan {
  upserts: Array<{ file: string; newText: string }>;
  deletes: string[];
}

/**
 * Mechanical apply-plan for the staged edits an approved approval card
 * produces (backend tool-mediated writes). The backend already collapses
 * to last-edit-per-file, but this dedupes defensively: a later edit for
 * the same file wins, and a delete_file op wins over any earlier upsert.
 * newText is the FULL post-apply file text (backend truth), never model
 * prose — consumers parse it and write it straight to the config store.
 */
export function planApprovedEditApply(edits: PendingConfigEdit[]): ApprovedApplyPlan {
  const byFile = new Map<string, PendingConfigEdit>();
  for (const edit of edits ?? []) {
    if (edit && typeof edit.file === 'string' && edit.file) byFile.set(edit.file, edit);
  }
  const upserts: ApprovedApplyPlan['upserts'] = [];
  const deletes: string[] = [];
  for (const [file, edit] of byFile) {
    if (edit.op === 'delete_file') {
      deletes.push(file);
    } else if (typeof edit.newText === 'string') {
      upserts.push({ file, newText: edit.newText });
    }
  }
  return { upserts, deletes };
}
