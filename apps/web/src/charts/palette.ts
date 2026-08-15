/**
 * The WOROOD chart palette.
 *
 * Warm, editorial, Egyptian: terracotta, Nile teal, lapis, berry, saffron, palm,
 * amethyst, crimson. Every value was generated in OKLCH and then *validated* with
 * the data-viz validator rather than eyeballed:
 *
 *   light (surface #fffcf7)  adjacent 8: CVD ΔE 9.5, normal ΔE 20.1 -- pass
 *                            all-pairs 4: CVD ΔE 6.2 (floor band -> the donut
 *                            legend and its 2px slice gaps are the mandatory
 *                            secondary encoding), normal ΔE 16.8 -- pass
 *   dark  (surface #171412)  adjacent 8: CVD ΔE 12.8, normal ΔE 19.9 -- pass
 *                            all-pairs 4: CVD ΔE 12.9, normal ΔE 19.9 -- pass
 *
 * Slot 5 (saffron) sits at 2.47:1 on the light surface: the relief rule applies,
 * so every chart that can reach slot 5 ships visible labels or a table view.
 *
 * Hues are assigned in fixed slot order and never cycled: colour follows the
 * entity, not its rank.
 */

export const SERIES_LIGHT = [
  '#cb5a1a', // 1 terracotta
  '#0e9a94', // 2 Nile teal
  '#4158bd', // 3 lapis
  '#af4387', // 4 berry
  '#d29922', // 5 saffron
  '#5a7f2b', // 6 palm
  '#8656b7', // 7 amethyst
  '#b02a2d', // 8 crimson
] as const;

export const SERIES_DARK = [
  '#e06d33', '#04a9a3', '#516bd2', '#a73b7f',
  '#be8806', '#476e00', '#aa76e1', '#c74b47',
] as const;

/** Ordinal ramp (funnel steps, tiers): one hue, light -> dark, ΔL >= 0.06. */
export const ORDINAL_LIGHT = ['#f69f77', '#ed7940', '#cd632e', '#ab5124', '#89401b'];
export const ORDINAL_DARK = ['#f38652', '#df6c32', '#c05c2a', '#a24d22', '#853e1a'];

/** Status colours are reserved and never themed; always shipped with a label. */
export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const;

const media = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null;

export function isDark(): boolean {
  const stamped = typeof document !== 'undefined'
    ? document.documentElement.getAttribute('data-theme')
    : null;
  if (stamped === 'dark') return true;
  if (stamped === 'light') return false;
  return !!media?.matches;
}

/** Categorical colour for slot `i` (0-based). Never cycles past slot 8: the
 *  callers fold the tail into "Other" before they get here. */
export function seriesColor(i: number): string {
  const ramp = isDark() ? SERIES_DARK : SERIES_LIGHT;
  return ramp[Math.min(i, ramp.length - 1)];
}

export function ordinalColor(i: number, total: number): string {
  const ramp = isDark() ? ORDINAL_DARK : ORDINAL_LIGHT;
  if (total <= 1) return ramp[0];
  const idx = Math.round((i / (total - 1)) * (ramp.length - 1));
  return ramp[idx];
}

/** Chart chrome, read from the same tokens the stylesheet uses. */
export const chrome = () => (isDark()
  ? { grid: '#2e2823', axis: '#3d352e', ink: '#f6f0e6', muted: '#a2988c', surface: '#171412' }
  : { grid: '#ece3d5', axis: '#d9cfbe', ink: '#1b1613', muted: '#7d7367', surface: '#fffcf7' });

/** Eight is the cap. Anything past it folds into a single neutral "Other". */
export const MAX_SERIES = 8;
export const OTHER_COLOR = () => (isDark() ? '#6f665c' : '#8b8175');
