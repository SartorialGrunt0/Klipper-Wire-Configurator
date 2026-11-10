/**
 * Shared category chip for the example/reference/template pickers
 * (GenerateDialog, TextEditor reference search, AddMenu hardware picker).
 * These sites previously spoke three dialects — tint-by-category rounded
 * pills, a flat-blue rounded label, and an uppercase outlined pill — all
 * rendering the same `category` field. One dialect now: rounded-full tint
 * with generic → blue, example → green, sample/kit/other → neutral gray.
 */
const CATEGORY_TONE: Record<string, string> = {
  generic: 'bg-blue-500/20 text-blue-400',
  example: 'bg-green-500/20 text-green-400',
};
const DEFAULT_TONE = 'bg-gray-500/20 text-gray-400';

export const CategoryChip = ({ category, className = '' }: { category: string; className?: string }) => (
  <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${CATEGORY_TONE[category] ?? DEFAULT_TONE} ${className}`}>
    {category}
  </span>
);
