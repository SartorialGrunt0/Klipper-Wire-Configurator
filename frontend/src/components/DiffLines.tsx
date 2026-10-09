import type { DiffLine } from '../utils/configDiff';
import { documentLineNumbers } from '../utils/configDiff';
import type React from 'react';

/**
 * The mini-diff rows, in one place.
 *
 * The approval card and the text view's pending-change pane BOTH render
 * through this component on purpose: the pane must show the same diff the card
 * shows, not a lookalike that can drift away from it. Keep the row chrome here
 * and nowhere else, and pass only the surrounding chrome (font size, scrolling,
 * max height) through `className`.
 *
 * `w-max min-w-full` keeps a row's tint spanning the visible width while still
 * growing for a long line, so the colour reads as a row band rather than as
 * text highlighting. Header rows (`@@ … @@`) deliberately carry no +/- mark.
 */
/**
 * Tint/colour per row type. Padding lives OUTSIDE this table: with the
 * gutter on, the row must have no left padding at all — the sticky gutter
 * span carries its own `pl-2` and pins flush to the left edge, so the
 * green/red band never peeks out to the LEFT of the numbers (Cliff,
 * 2026-10-09: the 8px row padding read as a coloured box around each number).
 */
const ROW_CLASS: Record<DiffLine['type'], string> = {
  added: 'w-max min-w-full bg-green-500/15 text-green-400',
  removed: 'w-max min-w-full bg-red-500/15 text-red-400',
  header: 'w-max min-w-full bg-blue-500/10 text-blue-400',
  context: 'w-max min-w-full text-[var(--color-text-secondary)]',
};

const ROW_PADDING = {
  numbered: 'pr-2',
  plain: 'px-2',
} as const;

const ROW_MARK: Record<DiffLine['type'], string> = {
  added: '+',
  removed: '-',
  header: ' ',
  context: ' ',
};

interface Props {
  lines: DiffLine[];
  /** Layout only — never colours. Those belong to `ROW_CLASS`. */
  className?: string;
  /**
   * The scrolling element, so a caller can bring a specific row into view
   * (the pending-change pane lands on the first changed row). An explicit prop
   * rather than `forwardRef`: the rows are a list, and only some callers need
   * to scroll it.
   */
  containerRef?: React.Ref<HTMLPreElement>;
  /**
   * Row-anchored affordances (the review pane's per-change Keep/Undo), rendered
   * right-aligned INSIDE the row so an action sits next to the edit it acts on.
   *
   * Rows are `w-max min-w-full` — they grow with a long line — so on a line
   * wider than the pane the extras land at that row's right edge rather than
   * the pane's. Fine for config files, and the alternative (positioning against
   * the scroller) would need a measurement pass on every scroll.
   *
   * The extras are a FLOATING layer (`z-10`): they ride on top of the row's
   * tint and may overhang the row's height, so the decision reads as sitting
   * over the red/green band rather than being a notch cut out of it. The verbs
   * are the app's one Keep/Undo (`EditDecisionPair`); the pane frames them in
   * its own boxed, filled container.
   */
  rowExtras?: (rowIndex: number) => React.ReactNode;
  /**
   * Draw the editor's running line-number gutter down the rows.
   *
   * The pane takes the place of the buffer while a review is open, so the
   * numbers the reader was just looking at must not vanish with it — and they
   * must look like the SAME gutter, not a lookalike: the editor draws its
   * numbers at `text-sm` in the secondary text colour, right-aligned in a
   * 3rem column with a `border-r` and the panel background (`TextEditor`'s
   * `lineNumbersRef` block). By default numbers count the document the diff's
   * AFTER side describes — the text the buffer holds — and a removed row,
   * which is not in that document, shows a blank. The number is `sticky
   * left-0` so it stays put while a long line scrolls sideways under it.
   */
  lineNumbers?: boolean;
  /**
   * Explicit per-row gutter numbers, overriding the AFTER-side count (with
   * `lineNumbers`). The review mirror passes one (Sir, 2026-10-08): a
   * replacement run's red row carries the number the old line held in the
   * frame, its green row the number the new line holds in the live text —
   * two moments of the file's life, each numbered in its own space, which
   * is exactly the reading of "line 555 deleted, line 556 added".
   */
  rowNumbers?: (number | null)[];
}

export default function DiffLines({
  lines, className = '', containerRef, rowExtras, lineNumbers = false, rowNumbers,
}: Props) {
  const numbers = lineNumbers ? (rowNumbers ?? documentLineNumbers(lines)) : null;
  return (
    <pre ref={containerRef} className={`m-0 font-mono overflow-x-auto ${className}`}>
      {lines.map((line, i) => {
        const extras = rowExtras?.(i);
        return (
          <div key={i} className={`relative ${ROW_CLASS[line.type]} ${numbers ? ROW_PADDING.numbered : ROW_PADDING.plain}`}>
            {numbers && (
              <span
                aria-hidden
                className="sticky left-0 mr-2 inline-block w-12 shrink-0 border-r border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] pl-2 pr-2 text-right align-top text-[var(--color-text-secondary)]"
              >
                {numbers[i] ?? ''}
              </span>
            )}
            <span className="select-none opacity-50 mr-1.5">{ROW_MARK[line.type]}</span>
            {line.content || '\u00A0'}
            {extras && (
              <span className="absolute inset-y-0 right-2 z-10 flex items-center gap-1">
                {extras}
              </span>
            )}
          </div>
        );
      })}
    </pre>
  );
}
