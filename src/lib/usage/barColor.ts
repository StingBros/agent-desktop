// PURE bar-color helper for the persistent footer. Maps a 0..100 "fill" percent
// to a status color token by how FULL it is: a fuller bar is closer to its limit
// and so escalates green -> yellow -> red. Framework-free (no Svelte/Tauri), so
// it is unit-tested in barColor.test.ts. Thresholds live here as the single
// tweakable source of truth, shared by the limit bars and the context bar.

/** A fill at or above this percent is YELLOW (caution) — the default (limit bars). */
export const BAR_YELLOW_AT = 50;
/** A fill at or above this percent is RED (abort) — the default (limit bars). */
export const BAR_RED_AT = 80;

/** Context-bar thresholds — deliberately more aggressive than the limit bars, so a
 *  filling context window warns early: YELLOW above 25%, RED above 30%. */
export const CONTEXT_YELLOW_AT = 25;
export const CONTEXT_RED_AT = 30;

/**
 * The CSS color (a design-token `var(...)`) for a fill percent: green below
 * `yellowAt`, yellow up to `redAt`, red at/above it. A null or non-finite percent
 * (unknown) renders as the neutral track color. Thresholds default to the limit-bar
 * values (`BAR_YELLOW_AT` / `BAR_RED_AT`); the context bar passes its own.
 */
export function barColor(
  pct: number | null,
  yellowAt: number = BAR_YELLOW_AT,
  redAt: number = BAR_RED_AT
): string {
  if (pct === null || !Number.isFinite(pct)) return 'var(--space-600)';
  if (pct >= redAt) return 'var(--abort-500)';
  if (pct >= yellowAt) return 'var(--caution-500)';
  return 'var(--nominal-500)';
}

/**
 * The color for the CONTEXT bar's fill/percent — `barColor` with the context
 * thresholds (yellow >25%, red >30%), so a filling context window escalates far
 * sooner than the account limit bars. Kept as its own helper so both the context
 * bar's percent text and its `StatusBar` fill share one source of truth.
 */
export function contextColor(pct: number | null): string {
  return barColor(pct, CONTEXT_YELLOW_AT, CONTEXT_RED_AT);
}
