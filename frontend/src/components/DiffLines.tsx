import type { DiffLine } from '../utils/configDiff';
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
const ROW_CLASS: Record<DiffLine['type'], string> = {
  added: 'w-max min-w-full bg-green-500/15 text-green-400 px-2',
  removed: 'w-max min-w-full bg-red-500/15 text-red-400 px-2',
  header: 'w-max min-w-full bg-blue-500/10 text-blue-400 px-2',
  context: 'w-max min-w-full text-[var(--color-text-secondary)] px-2',
};

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
}

export default function DiffLines({ lines, className = '', containerRef, rowExtras }: Props) {
  return (
    <pre ref={containerRef} className={`m-0 font-mono overflow-x-auto ${className}`}>
      {lines.map((line, i) => {
        const extras = rowExtras?.(i);
        return (
          <div key={i} className={`relative ${ROW_CLASS[line.type]}`}>
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
