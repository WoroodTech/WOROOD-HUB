/**
 * Reading a date out of the warehouse ledger.
 *
 * One function, in one place, because there were four — in reports,
 * insights, costing and the dashboard — and they had drifted. A date shape
 * the sheet actually holds was accepted by some and not by others, so the
 * same row counted towards one panel and was invisible to the next.
 */
import { DateTime } from 'luxon';

/** Cairo. A movement posted at one in the morning belongs to that day here. */
export const SHEET_TZ = 'Africa/Cairo';

/** Days are counted from this date by Sheets, not from the Unix epoch. */
const SHEET_EPOCH = '1899-12-30';

/**
 * Every shape the column actually holds.
 *
 * A date typed into the sheet is a real date and comes back as a serial
 * number. But rows written as text are in the ledger too — the Apps Script
 * writes some of them, and `15 Nov 2026` matched none of the formats the
 * portal knew. Those rows parsed as null and were skipped by every filter,
 * which is why Last 30 Days came back empty while the same range worked in
 * the Apps Script, and why the activity panel showed one movement out of
 * hundreds.
 */
const FORMATS = [
  'dd/LL/yyyy', 'd/L/yyyy', 'dd/LL/yy', 'd/L/yy',
  'yyyy-LL-dd',
  'd LLL yyyy', 'dd LLL yyyy',
  'd LLLL yyyy', 'dd LLLL yyyy',
];

export function parseSheetDate(value: unknown): DateTime | null {
  /* A real date, read unformatted: days since the epoch above. */
  if (typeof value === 'number' && Number.isFinite(value)) {
    return DateTime.fromISO(SHEET_EPOCH, { zone: SHEET_TZ })
      .plus({ days: value });
  }

  const t = String(value ?? '').trim();
  if (!t) return null;

  /* A serial that arrived as a string is still a serial. */
  if (/^\d+(\.\d+)?$/.test(t)) {
    return DateTime.fromISO(SHEET_EPOCH, { zone: SHEET_TZ })
      .plus({ days: Number(t) });
  }

  for (const fmt of FORMATS) {
    const d = DateTime.fromFormat(t, fmt, { zone: SHEET_TZ });
    if (d.isValid) return d;
  }

  const iso = DateTime.fromISO(t, { zone: SHEET_TZ });
  return iso.isValid ? iso : null;
}

/**
 * A date the sheet will store as a date.
 *
 * Written as text in the day-first order Egypt uses and sent with
 * USER_ENTERED, so Sheets parses it exactly as typing it would. The serial
 * number behind a date is not used: sent raw it stays the plain number it
 * is, and the rows at the bottom of the ledger carry no date format to dress
 * it up — 11 November 2026 appeared there as `46348`, which no reader and no
 * date filter could do anything with.
 */
export function sheetDate(d: DateTime): string {
  return d.toFormat('dd/LL/yyyy');
}