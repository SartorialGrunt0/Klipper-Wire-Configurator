import type { ChatMessage } from '../stores/aiStore';

const EDIT_SKILL = 'config-editing';

/** Names of skills whose load_skill actually ran in this conversation's
 *  stored tool trace (W4-R2 — generalizes and replaces hasEditSkillLoad).
 *  Mirrors the backend `_skill_load_in_trail` semantics: empty-name
 *  load_skill counts as the edit skill; knowledge loads never imply
 *  config-editing. Drives ChatRequest.loadedSkills — the edit gate and the
 *  backend's sticky body re-injection both read it (the lean replay strips
 *  tool_calls, so this client-derived list is the follow-up turn's only
 *  evidence of a past load). */
export function loadedSkillNames(messages: ChatMessage[]): string[] {
  const names = new Set<string>();
  for (const m of messages) {
    for (const c of m.toolCalls ?? []) {
      if (c.name !== 'load_skill') continue;
      try {
        const args = JSON.parse(c.arguments) as { name?: unknown };
        const name = String(args?.name ?? '');
        names.add(name === '' ? EDIT_SKILL : name);
      } catch {
        // Unparseable args on a load_skill call: treat as edit load
        // (same fail-open as the legacy hasEditSkillLoad).
        names.add(EDIT_SKILL);
      }
    }
  }
  return [...names];
}
