/**
 * Expiry presets for the MCP API key create row. The backend stores a plain
 * ISO date (expires_at); the UI offers relative presets instead of a raw
 * date picker, so the conversion to "YYYY-MM-DD" happens here (pure, tested).
 */
export type ExpiryPreset = 'never' | '30d' | '90d' | '6mo' | '1y';

export const EXPIRY_PRESETS: { value: ExpiryPreset; label: string }[] = [
  { value: 'never', label: 'Never' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '6mo', label: '6 months' },
  { value: '1y', label: '1 year' },
];

const PRESET_DAYS: Record<Exclude<ExpiryPreset, 'never'>, number> = {
  '30d': 30,
  '90d': 90,
  '6mo': 183,
  '1y': 365,
};

/** ISO date (YYYY-MM-DD) the preset lands on, counted from `from`; 'never' → null. */
export function expiryFromPreset(preset: ExpiryPreset, from: Date = new Date()): string | null {
  if (preset === 'never') return null;
  return new Date(from.getTime() + PRESET_DAYS[preset] * 86_400_000).toISOString().slice(0, 10);
}
