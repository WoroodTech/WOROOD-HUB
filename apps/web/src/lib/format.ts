/**
 * Formatting rules for the portal. Getting these wrong is the most visible kind
 * of bug, so they live in exactly one place.
 *
 *  - money is EGP with NO decimals:            EGP 7,633,063
 *  - percents arrive already multiplied:       2.04 renders as 2.04%
 *  - every date is rendered in Africa/Cairo    with an explicit timeZone
 */

export const CAIRO = 'Africa/Cairo';

const moneyFmt = new Map<string, Intl.NumberFormat>();
function money0(currency: string): Intl.NumberFormat {
  let f = moneyFmt.get(currency);
  if (!f) {
    f = new Intl.NumberFormat('en-US', {
      style: 'currency', currency, currencyDisplay: 'code',
      minimumFractionDigits: 0, maximumFractionDigits: 0,
    });
    moneyFmt.set(currency, f);
  }
  return f;
}

/** `EGP 7,633,063` -- never a decimal, never a bare number. */
export function formatMoney(value: number, currency = 'EGP'): string {
  if (!Number.isFinite(value)) return '--';
  // Intl inserts U+00A0 between code and amount; a normal space reads better.
  return money0(currency).format(value).replace(/ /g, ' ');
}

/** `EGP 7.63M` for tiles. The full value belongs in a `title` beside it. */
export function formatMoneyShort(value: number, currency = 'EGP'): string {
  if (!Number.isFinite(value)) return '--';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${currency} ${trim(abs / 1_000_000)}M`;
  if (abs >= 10_000) return `${sign}${currency} ${trim(abs / 1_000)}K`;
  return formatMoney(value, currency);
}

/** Two decimals below 100, none above -- and only ever strip zeros that sit
 *  after a decimal point (stripping them from `300` would print `3`). */
const trim = (n: number) => {
  const s = n.toFixed(n >= 100 ? 0 : 2);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};

export const formatInteger = (value: number): string =>
  Number.isFinite(value) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value) : '--';

/** The API sends 2.04 for 2.04% -- format it, never multiply it again. */
export function formatPercent(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '--';
  return `${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0, maximumFractionDigits: digits,
  }).format(value)}%`;
}

export type ValueFormat = 'money' | 'integer' | 'percent' | 'text' | 'datetime' | 'status';

export function formatValue(
  value: number | string | null | undefined,
  format: ValueFormat,
  currency = 'EGP',
): string {
  if (value === null || value === undefined || value === '') return '--';
  switch (format) {
    case 'money': return formatMoney(Number(value), currency);
    case 'integer': return formatInteger(Number(value));
    case 'percent': return formatPercent(Number(value));
    case 'datetime': return formatDateTime(String(value));
    default: return String(value);
  }
}

export function formatValueShort(
  value: number, format: 'money' | 'integer' | 'percent', currency = 'EGP',
): string {
  if (format === 'money') return formatMoneyShort(value, currency);
  if (format === 'percent') return formatPercent(value);
  if (Math.abs(value) >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (Math.abs(value) >= 10_000) return `${trim(value / 1_000)}K`;
  return formatInteger(value);
}

/* ------------------------------------------------------------------ dates -- */

const dt = (opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: CAIRO, ...opts });

const fDateTime = dt({ day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const fDate = dt({ day: '2-digit', month: 'short', year: 'numeric' });
const fDayMonth = dt({ day: '2-digit', month: 'short' });
const fMonth = dt({ month: 'short', year: '2-digit' });
const fTime = dt({ hour: '2-digit', minute: '2-digit', hour12: false });
const fWeekday = dt({ weekday: 'short', day: '2-digit', month: 'short' });

const safe = (iso: string | null | undefined): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const formatDateTime = (iso?: string | null) => { const d = safe(iso); return d ? fDateTime.format(d) : '--'; };
export const formatDate = (iso?: string | null) => { const d = safe(iso); return d ? fDate.format(d) : '--'; };
export const formatDayMonth = (iso?: string | null) => { const d = safe(iso); return d ? fDayMonth.format(d) : '--'; };
export const formatMonth = (iso?: string | null) => { const d = safe(iso); return d ? fMonth.format(d) : '--'; };
export const formatTime = (iso?: string | null) => { const d = safe(iso); return d ? fTime.format(d) : '--'; };
export const formatWeekday = (iso?: string | null) => { const d = safe(iso); return d ? fWeekday.format(d) : '--'; };

/** "4 minutes ago" -- how old the figures on screen are. */
export function formatAge(seconds: number | null | undefined): string {
  // The API reports no age for figures it computes on the spot from the mirror,
  // rather than reading them from a snapshot -- say that, do not invent one.
  if (seconds === null || seconds === undefined) return 'read live from the mirror';
  if (seconds < 45) return 'just now';
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/** "1 h 30 m" -- for room availability. */
export function formatDuration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '--';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60), m = Math.round(minutes % 60);
  if (h >= 24) { const d = Math.floor(h / 24); return `${d} day${d === 1 ? '' : 's'}+`; }
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Percentage change between two figures, or null when there is no baseline. */
export function deltaPercent(value: number, comparedTo: number | null | undefined): number | null {
  if (comparedTo === null || comparedTo === undefined || comparedTo === 0) return null;
  if (!Number.isFinite(value) || !Number.isFinite(comparedTo)) return null;
  return ((value - comparedTo) / Math.abs(comparedTo)) * 100;
}
