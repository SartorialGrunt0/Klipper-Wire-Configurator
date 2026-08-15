import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import * as api from '../../services/api';
import { extractHeadings, slugifyHeading } from '../../utils/referenceDoc';

const LIVE_REFERENCE_URL = 'https://raw.githubusercontent.com/Klipper3d/klipper/master/docs/Config_Reference.md';
const LOCAL_REFERENCE_URL = '/reference/docs/Config_Reference.md';
const FETCH_TIMEOUT_MS = 10_000;

type ReferenceSource = 'live' | 'mirror';

interface ConfigReferenceDialogProps {
  onClose: () => void;
}

// ── rehype plugin: deterministic anchor ids for h1-h4 ───────────────────
// Uses the same slug + dedupe scheme as extractHeadings() (the TOC builder),
// so TOC links and rendered heading ids always match — including under
// StrictMode's double render, since this is pure and stateless.

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function hastText(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastText).join('');
}

function walkAssignHeadingIds(node: HastNode, used: Map<string, number>): void {
  if (node.type === 'element' && node.tagName && /^h[1-4]$/.test(node.tagName)) {
    const base = slugifyHeading(hastText(node));
    const count = (used.get(base) || 0) + 1;
    used.set(base, count);
    node.properties = { ...(node.properties ?? {}), id: count === 1 ? base : `${base}-${count}` };
  }
  for (const child of node.children ?? []) {
    walkAssignHeadingIds(child, used);
  }
}

const headingIdsPlugin = () => (tree: unknown) => {
  walkAssignHeadingIds(tree as HastNode, new Map());
};

export default function ConfigReferenceDialog({ onClose }: ConfigReferenceDialogProps) {
  const [content, setContent] = useState('');
  const [source, setSource] = useState<ReferenceSource | null>(null);
  const [error, setError] = useState('');

  // Load order: live Klipper repo → backend mirror → bundled asset
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    async function load() {
      try {
        const res = await fetch(LIVE_REFERENCE_URL, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!cancelled) {
          setContent(text);
          setSource('live');
        }
        return;
      } catch {
        // live fetch failed (offline / blocked) — fall through to the mirror
      }
      try {
        const res = await api.getConfigReference();
        if (!cancelled) {
          setContent(res.content);
          setSource('mirror');
        }
        return;
      } catch {
        // fall through to the bundled asset
      }
      try {
        const res = await fetch(LOCAL_REFERENCE_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!cancelled) {
          setContent(text);
          setSource('mirror');
        }
        return;
      } catch {
        if (!cancelled) setError('Config reference could not be loaded.');
      }
    }

    void load();
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, []);

  const headings = useMemo(() => (content ? extractHeadings(content) : []), [content]);
  const tocHeadings = headings.filter((h) => h.level >= 2);

  const scrollToHeading = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="flex h-[85vh] w-[92vw] max-w-[1400px] flex-col overflow-hidden rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-bg-tertiary)] px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Configuration Reference</h2>
            {source && (
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  source === 'live'
                    ? 'bg-green-500/15 text-green-400'
                    : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]'
                }`}
              >
                {source === 'live' ? 'Live Klipper docs (master)' : 'Bundled mirror'}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-md border border-[var(--color-bg-tertiary)] px-2 py-1 text-xs text-[var(--color-text-primary)]"
          >
            Close
          </button>
        </div>

        {error && (
          <div className="flex flex-1 items-center justify-center p-6">
            <p className="text-xs text-[var(--color-error)]">{error}</p>
          </div>
        )}

        {!content && !error && (
          <div className="flex flex-1 items-center justify-center p-6">
            <p className="text-xs text-[var(--color-text-secondary)]">Loading…</p>
          </div>
        )}

        {content && (
          <div className="flex min-h-0 flex-1">
            {tocHeadings.length > 0 && (
              <nav
                className="w-60 shrink-0 overflow-y-auto border-r border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] p-2"
                aria-label="Table of contents"
              >
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
                  Contents
                </div>
                {tocHeadings.map((h) => (
                  <button
                    key={h.id}
                    onClick={() => scrollToHeading(h.id)}
                    title={h.text}
                    className={`block w-full truncate rounded px-2 py-1 text-left transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] ${
                      h.level === 2
                        ? 'text-[11px] font-semibold text-[var(--color-text-secondary)]'
                        : 'pl-6 text-[11px] text-[var(--color-text-secondary)]/80'
                    }`}
                  >
                    {h.text}
                  </button>
                ))}
              </nav>
            )}
            <div className="flex-1 overflow-auto p-4">
              <div className="mx-auto max-w-3xl text-xs leading-5 text-[var(--color-text-primary)]">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[headingIdsPlugin]}
                  components={{
                    h1: ({ node: _node, ...props }) => (
                      <h1 className="mb-3 mt-1 text-base font-bold" {...props} />
                    ),
                    h2: ({ node: _node, ...props }) => (
                      <h2 className="mb-2 mt-5 border-b border-[var(--color-bg-tertiary)] pb-1 text-sm font-semibold" {...props} />
                    ),
                    h3: ({ node: _node, ...props }) => (
                      <h3 className="mb-1.5 mt-4 text-[13px] font-semibold" {...props} />
                    ),
                    h4: ({ node: _node, ...props }) => (
                      <h4 className="mb-1 mt-3 text-xs font-semibold" {...props} />
                    ),
                    p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                    ul: ({ children }) => <ul className="mb-2 list-disc pl-5 last:mb-0">{children}</ul>,
                    ol: ({ children }) => <ol className="mb-2 list-decimal pl-5 last:mb-0">{children}</ol>,
                    li: ({ children }) => <li className="mb-1 last:mb-0">{children}</li>,
                    a: ({ href, children }) => {
                      let resolved = href;
                      // Relative links in the doc (e.g. Installation.md, ../config/example-cartesian.cfg)
                      // → point at the real repo so they aren't dead links in the viewer
                      if (href && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('#')) {
                        const clean = href.replace(/^\.\//, '');
                        if (clean.startsWith('../config/')) {
                          resolved = `https://github.com/Klipper3d/klipper/blob/master/${clean.replace(/^\.\.\//, '')}`;
                        } else {
                          resolved = `https://github.com/Klipper3d/klipper/blob/master/docs/${clean}`;
                        }
                      }
                      return (
                        <a className="text-[var(--color-accent)] underline" href={resolved} target="_blank" rel="noreferrer">
                          {children}
                        </a>
                      );
                    },
                    pre: ({ children }) => (
                      <pre className="my-3 overflow-x-auto rounded-lg border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-primary)] p-3 font-mono text-[11px] leading-5">
                        {children}
                      </pre>
                    ),
                    code: ({ className, children }) => {
                      const contentStr = String(children ?? '');
                      const isBlock = Boolean(className) || contentStr.includes('\n');
                      if (isBlock) {
                        return <code className="font-mono">{children}</code>;
                      }
                      return (
                        <code className="rounded bg-[var(--color-bg-secondary)] px-1 py-0.5 font-mono text-[11px]">
                          {children}
                        </code>
                      );
                    },
                    blockquote: ({ children }) => (
                      <blockquote className="my-2 border-l-2 border-[var(--color-bg-tertiary)] pl-3 text-[var(--color-text-secondary)]">
                        {children}
                      </blockquote>
                    ),
                    table: ({ children }) => (
                      <div className="my-2 overflow-x-auto">
                        <table className="min-w-full border-collapse text-left text-[11px]">{children}</table>
                      </div>
                    ),
                    th: ({ children }) => (
                      <th className="border border-[var(--color-bg-tertiary)] px-2 py-1 font-semibold">{children}</th>
                    ),
                    td: ({ children }) => (
                      <td className="border border-[var(--color-bg-tertiary)] px-2 py-1 align-top">{children}</td>
                    ),
                    hr: () => <hr className="my-3 border-[var(--color-bg-tertiary)]" />,
                  }}
                >
                  {content}
                </ReactMarkdown>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
