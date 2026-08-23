/**
 * User Manual Dialog - Fixed popup dialog for the embedded user guide.
 * 
 * Patterns:
 * - Modal overlay (z-[60]) similar to MacroDesignerDialog
 * - TOC sidebar + markdown content (similar to ConfigReferenceDialog)
 * - "Pop-out" button opens current section in new browser tab
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import * as api from '../../services/api';

interface ManualDialogProps {
  onClose: () => void;
}

// Rehype plugin: assign deterministic IDs to headings for anchor links
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

function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
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

// Extract headings for TOC
function extractHeadings(content: string): Array<{ level: number; text: string; id: string }> {
  const lines = content.split('\n');
  const headings: Array<{ level: number; text: string; id: string }> = [];
  const used = new Map<string, number>();

  for (const line of lines) {
    const match = line.match(/^(#{1,4})\s+(.+)$/);
    if (match) {
      const level = match[1].length;
      const text = match[2].trim();
      const base = slugifyHeading(text);
      const count = (used.get(base) || 0) + 1;
      used.set(base, count);
      const id = count === 1 ? base : `${base}-${count}`;
      headings.push({ level, text, id });
    }
  }

  return headings;
}

export default function ManualDialog({ onClose }: ManualDialogProps) {
  const [sections, setSections] = useState<string[]>([]);
  const [currentSection, setCurrentSection] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Load available sections on mount and auto-open the first section
  useEffect(() => {
    api.getManualSections()
      .then(data => {
        setSections(data.sections);
        if (data.sections.length > 0) {
          loadSection(data.sections[0]);
        }
      })
      .catch(() => setError('Could not load manual sections'));
  }, []);

  // Load section content when selected
  const loadSection = async (section: string) => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getManualSection(section);
      setContent(data.content);
      setCurrentSection(section);
    } catch (err) {
      setError(`Failed to load ${section}`);
    } finally {
      setLoading(false);
    }
  };

  // Open current section in new tab
  const openInNewTab = () => {
    if (currentSection) {
      // Backend renders the section as standalone HTML (works via Vite proxy in dev
      // and directly in production)
      const url = `${window.location.origin}/api/manual/${currentSection}`;
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  // Reset scroll to the top of the document whenever the section content changes
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0, left: 0 });
  }, [content]);

  // Previous/Next sections for the footer navigation buttons
  const sectionIdx = currentSection ? sections.indexOf(currentSection) : -1;
  const prevSection = sectionIdx > 0 ? sections[sectionIdx - 1] : null;
  const nextSection =
    sectionIdx >= 0 && sectionIdx < sections.length - 1 ? sections[sectionIdx + 1] : null;

  // Display name for a section slug (e.g. "02-graph-ui" → "02 Graph Ui")
  const sectionDisplay = (name: string) =>
    name.replace(/-/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());

  // Extract headings from content for in-document TOC
  const headings = useMemo(() => extractHeadings(content), [content]);
  const sectionHeadings = headings.filter(h => h.level >= 2);

  // Scroll to heading within dialog
  const scrollToHeading = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Get display title for current section
  const sectionTitle = currentSection 
    ? currentSection.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
    : 'User Manual';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="flex h-[85vh] w-[90vw] max-w-[1400px] flex-col overflow-hidden rounded-xl border border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-bg-tertiary)] px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">{sectionTitle}</h2>
            {currentSection && (
              <span className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                {currentSection}
              </span>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            {currentSection && (
              <button
                onClick={openInNewTab}
                className="rounded-md border border-[var(--color-bg-tertiary)] px-2 py-1 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] transition-colors"
                title="Open this section in a new browser tab"
              >
                Pop-out
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded-md border border-[var(--color-bg-tertiary)] px-2 py-1 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)] transition-colors"
            >
              Close
            </button>
          </div>
        </div>

        {/* Error state */}
        {error && !content && (
          <div className="flex flex-1 items-center justify-center p-6">
            <p className="text-xs text-[var(--color-error)]">{error}</p>
          </div>
        )}

        {/* Loading state */}
        {!content && !error && sections.length === 0 && (
          <div className="flex flex-1 items-center justify-center p-6">
            <p className="text-xs text-[var(--color-text-secondary)]">Loading manual...</p>
          </div>
        )}

        {/* Content area */}
        {content && (
          <div className="flex min-h-0 flex-1 overflow-hidden">
            {/* TOC Sidebar */}
            <nav className="w-56 shrink-0 overflow-y-auto border-r border-[var(--color-bg-tertiary)] bg-[var(--color-bg-secondary)]">
              <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
                Sections
              </div>
              <div className="space-y-0.5 px-2 pb-2">
                {sections.map((section) => (
                  <button
                    key={section}
                    onClick={() => loadSection(section)}
                    className={`block w-full truncate rounded px-2 py-1 text-left text-xs transition-colors hover:bg-[var(--color-bg-tertiary)] ${
                      currentSection === section
                        ? 'bg-[var(--color-accent)] text-[var(--color-bg-primary)]'
                        : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                    }`}
                  >
                    {section.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                  </button>
                ))}
              </div>

              {/* In-document TOC (if section loaded) */}
              {sectionHeadings.length > 0 && (
                <>
                  <div className="mt-4 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
                    In This Section
                  </div>
                  <div className="space-y-0.5 px-2 pb-2">
                    {sectionHeadings.map((h) => (
                      <button
                        key={h.id}
                        onClick={() => scrollToHeading(h.id)}
                        title={h.text}
                        className={`block w-full truncate rounded px-2 py-1 text-left text-[11px] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] ${
                          h.level === 2
                            ? 'font-medium text-[var(--color-text-secondary)]'
                            : 'pl-4 text-[var(--color-text-secondary)]/80'
                        }`}
                      >
                        {h.text}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </nav>

            {/* Markdown content */}
            <div ref={contentRef} className="flex-1 overflow-auto p-4">
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
                    a: ({ href, children }) => (
                      <a className="text-[var(--color-accent)] underline" href={href} target="_blank" rel="noreferrer">
                        {children}
                      </a>
                    ),
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
                    img: ({ src, alt }) => (
                      <figure className="my-4">
                        <img src={src} alt={alt} className="max-w-full rounded border border-[var(--color-bg-tertiary)]" />
                        {alt && <figcaption className="mt-2 text-[11px] text-[var(--color-text-secondary)]">{alt}</figcaption>}
                      </figure>
                    ),
                  }}
                >
                  {content}
                </ReactMarkdown>
              </div>
            </div>
          </div>
        )}

        {/* Previous / Next navigation */}
        {content && (
          <div className="flex shrink-0 items-center justify-between border-t border-[var(--color-bg-tertiary)] px-4 py-2.5">
            <button
              onClick={() => prevSection && loadSection(prevSection)}
              disabled={!prevSection}
              className="rounded-md border border-[var(--color-bg-tertiary)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--color-text-primary)]"
            >
              ← {prevSection ? sectionDisplay(prevSection) : 'Previous'}
            </button>
            <span className="text-[10px] text-[var(--color-text-secondary)]">
              {sectionIdx >= 0 ? `${sectionIdx + 1} of ${sections.length}` : ''}
            </span>
            <button
              onClick={() => nextSection && loadSection(nextSection)}
              disabled={!nextSection}
              className="rounded-md border border-[var(--color-bg-tertiary)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-bg-primary)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--color-text-primary)]"
            >
              {nextSection ? sectionDisplay(nextSection) : 'Next'} →
            </button>
          </div>
        )}

        {/* Empty state (no sections available) */}
        {!content && !error && sections.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
            <p className="mb-2 text-sm font-medium text-[var(--color-text-primary)]">User Manual Not Available</p>
            <p className="text-xs text-[var(--color-text-secondary)]">
              No manual sections found. Please ensure the manual is installed.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
