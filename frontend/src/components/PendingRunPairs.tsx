/**
 * The inline Keep/Undo pairs on the LIVE editor (Sir, 2026-10-07).
 *
 * The edit view is the review (law 10), so its decisions ride the text:
 * one shared `EditDecisionPair` per undecided run, anchored to the run's
 * TOP line, floating over the tint (z-10, app-standard frame —
 * `ROW_PAIR_CLASS`), never a notch cut into it.
 *
 * The position is MEASURED, never computed. `buildHighlightedHtml` emits a
 * zero-width `kl-run-anchor` marker span inside the run's own line markup;
 * this layer finds each marker by its run key and positions the pair from
 * the marker's DOM rect. The vertical position therefore comes from the
 * same text layout that places the glyphs — the inline law's drift
 * guarantee survives (the forbidden pattern was font-metric arithmetic
 * OUTSIDE the text; a measured in-text marker is the text). The pair itself
 * is chrome, so it floats: it may overhang the row and is redrawn from the
 * markers on every scroll/resize/text change.
 *
 * Deliberately dumb about WHAT a run is: `TextEditor` resolves the ledger's
 * stops to keys and handlers; this component only maps key → marker → rect.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';

import EditDecisionPair from './EditDecisionPair';
import { ROW_PAIR_CLASS } from './PendingDiffPane';

export interface RunPairTarget {
  /** The ledger run key — matches the marker span's data-run-key. */
  key: string;
  /** Hover text naming the section the run belongs to. */
  title?: string;
  onKeep: () => void;
  onUndo: () => void;
}

interface PlacedPair extends RunPairTarget {
  y: number;
}

/** Gap between the pair and the editor box's right edge (Sir, 2026-10-08:
 *  the pairs hug the RIGHT edge, not the anchor column — a deletion anchor
 *  is zero-width at column 0, so a left placement sat in the middle of the
 *  red line; the right edge is where change widgets live (VS Code's law)
 *  and it never covers the run's text). */
const RIGHT_EDGE_PX = 6;

interface Props {
  /** The syntax-highlight overlay <pre> that carries the marker spans. */
  overlayRef: React.RefObject<HTMLElement | null>;
  /** The textarea — its scroll is the review's scroll. */
  textareaRef: React.RefObject<HTMLElement | null>;
  runs: readonly RunPairTarget[];
}

/** Cheap layout-change signature; identical → no re-render. X is constant
 *  (CSS right edge), so the signature tracks the measured Y only. */
function signature(pairs: readonly PlacedPair[]): string {
  return pairs.map((p) => `${p.key}:${p.y}`).join('|');
}

export default function PendingRunPairs({ overlayRef, textareaRef, runs }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<PlacedPair[]>([]);
  // The latest runs/handlers, readable from the (long-lived) scroll listener
  // without re-subscribing on every parent render.
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const sigRef = useRef('');
  const frameRef = useRef(0);

  const measure = useCallback(() => {
    const host = hostRef.current;
    const overlay = overlayRef.current;
    if (!host || !overlay) return;
    const hostRect = host.getBoundingClientRect();
    const next: PlacedPair[] = [];
    for (const run of runsRef.current) {
      // Run keys carry ':' and '+' — escape for the attribute selector.
      const escaped = typeof CSS !== 'undefined' && CSS.escape
        ? CSS.escape(run.key)
        : run.key.replace(/["\\]/g, '\\$&');
      const span = overlay.querySelector<HTMLElement>(`[data-run-key="${escaped}"]`);
      if (!span) continue;
      const rect = span.getBoundingClientRect();
      // An empty inline span measures width 0; a height of 0 means the line
      // is not laid out (hidden view), so its pair has no place to sit.
      if (rect.height === 0) continue;
      const y = rect.top - hostRect.top;
      // Off-screen runs (above the viewport or below it) render nothing —
      // they reappear with the scroll, same as the tint.
      if (y < -24 || y > hostRect.height) continue;
      // X comes from the RIGHT EDGE of the box (see RIGHT_EDGE_PX), not the
      // marker column: a deletion anchor is zero-width at column 0, so an
      // x-from-marker pair sat over the red line's text. Y is still the
      // measured marker — the drift law is vertical.
      next.push({ ...run, y: Math.round(y) });
    }
    const sig = signature(next);
    if (sig !== sigRef.current) {
      sigRef.current = sig;
      setPlaced(next);
    }
  }, [overlayRef]);

  /** Coalesce every trigger into ONE measurement per frame. */
  const schedule = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      measure();
    });
  }, [measure]);

  // Text/anchor change: measure after the overlay's new HTML is in the DOM.
  useEffect(() => {
    schedule();
    return () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
      }
    };
  }, [runs, schedule]);

  // Scroll and resize: the markers move, so the pairs follow. The overlay's
  // scrollTop is set programmatically by the editor's sync handler, which
  // fires a scroll event here too; the textarea is the source of truth.
  useEffect(() => {
    const ta = textareaRef.current;
    const overlay = overlayRef.current;
    if (!ta || !overlay) return undefined;
    ta.addEventListener('scroll', schedule, { passive: true });
    overlay.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(schedule);
      observer.observe(overlay);
    }
    return () => {
      ta.removeEventListener('scroll', schedule);
      overlay.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      observer?.disconnect();
    };
  }, [schedule, textareaRef, overlayRef]);

  return (
    // Layer host: exact overlay box, never intercepts the editor's own
    // mouse events; the pair itself opts back in.
    <div ref={hostRef} className="kl-run-pairs pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {placed.map((pair) => (
        <span
          key={pair.key}
          className={`${ROW_PAIR_CLASS} pointer-events-auto absolute`}
          style={{ right: RIGHT_EDGE_PX, top: pair.y }}
          title={pair.title}
        >
          <EditDecisionPair
            busy={false}
            size="sm"
            onUndo={pair.onUndo}
            onKeep={pair.onKeep}
          />
        </span>
      ))}
    </div>
  );
}
