/**
 * Shared display mapping for the background chat-status signal (aiStore
 * `chatStatus`). Two surfaces render it: the toolbar AI Chat button and the
 * text view's chat-dock fold button. The status is raised only while the
 * chat is NOT in front of the user (reply landed / edit awaiting a decision
 * / request failed while the modal is closed or the dock is folded), and
 * drops back to 'idle' the moment the chat becomes visible again.
 */

export type ChatStatus = 'idle' | 'success' | 'error' | 'awaiting';

/** True when the status carries an attention signal (anything but idle). */
export function chatStatusActive(status: ChatStatus): boolean {
  return status !== 'idle';
}

/** Tailwind classes for the small status dot on the fold button. */
export function chatStatusDotClass(status: ChatStatus): string {
  return status === 'success' || status === 'awaiting'
    ? 'bg-green-500'
    : 'bg-red-500';
}

/** Filled-button classes for the toolbar AI Chat button. */
export function chatStatusButtonClass(status: ChatStatus): string {
  return status === 'success' || status === 'awaiting'
    ? 'bg-green-600 text-white hover:bg-green-700'
    : status === 'error'
      ? 'bg-red-600 text-white hover:bg-red-700'
      : '';
}

/**
 * Tooltip for a status-bearing control. `closedLabel` is the surface's own
 * base title shown while idle ("AI Chat", "Hide the AI chat", ...).
 */
export function chatStatusTitle(status: ChatStatus, closedLabel: string): string {
  return status === 'success' ? 'AI Chat — response ready'
    : status === 'awaiting' ? 'AI Chat — an edit needs your decision'
      : status === 'error' ? 'AI Chat — last request failed'
        : closedLabel;
}
