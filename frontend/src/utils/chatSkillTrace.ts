import type { ChatMessage } from '../stores/aiStore';

const EDIT_SKILL = 'config-editing';

/** True once load_skill(config-editing) actually ran in this conversation's
 *  stored tool trace. Mirrors the backend `_load_skill_active` semantics:
 *  empty-name load_skill counts as the edit skill; printer-memory never does. */
export function hasEditSkillLoad(messages: ChatMessage[]): boolean {
  return messages.some((m) =>
    (m.toolCalls ?? []).some((c) => {
      if (c.name !== 'load_skill') return false;
      try {
        const args = JSON.parse(c.arguments) as { name?: unknown };
        const name = String(args?.name ?? '');
        return name === '' || name === EDIT_SKILL;
      } catch {
        return true; // unparseable args on a load_skill call: treat as edit load
      }
    }),
  );
}
