/**
 * Shared category chip for the example/reference/template pickers
 * (GenerateDialog, TextEditor reference search, AddMenu hardware picker).
 * These sites previously spoke three dialects — tint-by-category rounded
 * pills, a flat-blue rounded label, and an uppercase outlined pill — all
 * rendering the same `category` field. One dialect now: rounded-full tint
 * with generic → blue, example → green, sample/kit/other → neutral gray.
 *
 * No shrink-0 in the base: GenerateDialog's original chip was not shrink-
 * proof, and this recipe must not add layout behavior at sites that never
 * had it; the two call sites that did pass it via className.
 */
const CATEGORY_TONE: Record<string, string> = {
  generic: 'bg-blue-500/20 text-blue-400',
  example: 'bg-green-500/20 text-green-400',
};
const DEFAULT_TONE = 'bg-gray-500/20 text-gray-400';

/** hasOwnProperty guard: a category literally named 'constructor'/'toString'
 *  must not resolve to an inherited Object.prototype member. */
function toneFor(category: string): string {
  return Object.prototype.hasOwnProperty.call(CATEGORY_TONE, category)
    ? CATEGORY_TONE[category]
    : DEFAULT_TONE;
}

export const CategoryChip = ({ category, className = '' }: { category: string; className?: string }) => (
  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${toneFor(category)} ${className}`}>
    {category}
  </span>
);
