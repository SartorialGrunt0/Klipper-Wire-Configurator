/**
 * The few glyphs the shell shares between surfaces.
 *
 * They live here rather than inline in each component because they carry a
 * MEANING, not decoration: the chat bubble marks "the AI chat lives here" in
 * the toolbar button, in the text view's fold toggle and in the panel's own
 * header, and those three must not drift into three different drawings of the
 * same thing (Cliff, 2026-10-04). Sizing stays a prop so each surface keeps
 * its own density.
 */

/** The AI chat: one speech bubble, tail bottom-left. */
export function ChatBubbleIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The file tree / the document itself: a page with a folded corner. */
export function FileTreeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M9.5 1.5h-5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M9.5 1.5V5H13" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Printer memory: an OPEN book — two pages meeting at a spine.
 *
 * A closed book's cover and spine collapse into two near-parallel lines at
 * 14px and read as a rectangle (Cliff, 2026-10-04: "doesn't look like a
 * book"). The open book is the shape everyone already reads as one, and the
 * centre spine is a single unambiguous stroke.
 */
export function BookIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 3.4C6.9 2.5 5.4 2 3.4 2a.6.6 0 0 0-.6.6v8.6c0 .33.27.6.6.6 1.9 0 3.3.5 4.6 1.6 1.3-1.1 2.7-1.6 4.6-1.6a.6.6 0 0 0 .6-.6V2.6a.6.6 0 0 0-.6-.6C10.6 2 9.1 2.5 8 3.4Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M8 3.4v10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
