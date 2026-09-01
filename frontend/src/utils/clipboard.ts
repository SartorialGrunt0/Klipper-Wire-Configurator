/**
 * Copy text to the clipboard with a fallback for non-secure contexts.
 *
 * The modern `navigator.clipboard.writeText` API is only available in
 * secure contexts (https, or http on localhost). KWC is frequently served
 * over plain HTTP on the LAN (Vite dev server binds all interfaces; the
 * built app is served over http from the Pi), where `navigator.clipboard`
 * is `undefined` and every copy button silently fails.
 *
 * Falls back to the legacy hidden-textarea + `document.execCommand('copy')`
 * technique, which works in any context.
 *
 * Returns true on success, false on failure — never throws, so callers can
 * branch on the result without try/catch.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path — the Clipboard API can still reject
      // (permissions, focus, browser policy) even when present.
    }
  }
  return legacyCopyText(text);
}

function legacyCopyText(text: string): boolean {
  // No DOM (SSR/test runner) — nothing to copy to.
  if (typeof document === 'undefined') return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  // Keep the element off-screen and non-focusable.
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}
