import { DateTime } from 'luxon';

/**
 * Turning a request into a row of the accountant's Log tab.
 *
 * Pure, and separate from everything that talks to Google, because this is
 * where a mistake is expensive and invisible: a value in the wrong column does
 * not fail, it lands quietly in a column the accountant's formulas read, and
 * the first anybody knows is that a total is wrong.
 *
 * The column order is the sheet's, not ours. It was read from the live
 * workbook rather than from the Apps Script, because what the sheet actually
 * holds is the only thing that matters here.
 */

/** Which tab a department's requests are logged in. */
export const TAB_FOR_DEPARTMENT: Record<string, string> = {
  MKT: 'Marketing Log',
  PUR: 'Purchases Log',
  TECH: 'Tech Log',
  HR: 'HR Log',
  PR: 'P.R Log',
  CS: 'Customer Support Log',
  /* The three lite departments do not have tabs of their own. Their requests
     are routed through Purchases and logged there, with column T naming the
     department they actually came from -- which is exactly what the Apps
     Script does, and why column T exists at all. */
  OFC: 'Purchases Log',
  WRK: 'Purchases Log',
  WHS: 'Purchases Log',
};

/**
 * The columns, in the sheet's order.
 *
 * `null` marks the one column that is not a value: G holds
 * `=MAX(0,D2-F2)`, and writing a number there would replace the formula with
 * a constant for that row.
 *
 * It is not left alone, though. The formula does not extend itself down the
 * sheet -- every filled row carries its own copy, written when the row was
 * added, and a row added without one leaves Remaining permanently blank.
 * Because the formula names its own row, it can only be built once the row
 * number is known, which is at write time rather than here.
 */
export const COLUMNS = [
  'dueDate',          // A
  'type',             // B
  'description',      // C
  'requestedAmount',  // D
  'requestedBy',      // E
  'paidTotal',        // F
  null,               // G — Remaining, a formula. Never written.
  'status',           // H
  'lastPaymentDate',  // I
  'id',               // J — the reference; how a row is found again
  'createdAt',        // K
  'paymentMethod',    // L
  'paymentDetails',   // M
  'moreDetails',      // N
  'requesterLogin',   // O
  'files',            // P
  'receipts',         // Q
  'approvedByRoute',  // R
  'vendor',           // S — Purchases Log only
  'source',           // T — Purchases Log only
] as const;

/** The ID column, zero-based: J. */
export const ID_COLUMN_INDEX = 9;

/** The Remaining column, zero-based: G. */
export const FORMULA_COLUMN_INDEX = 6;

/**
 * The Remaining formula for one row.
 *
 * Written rather than inherited: Sheets does not extend a formula into a row
 * that an API call created, so a row added without this shows nothing in
 * Remaining while every row above it shows a number. The accountant reads
 * that column.
 */
export function remainingFormula(rowNumber: number): string {
  return `=MAX(0,D${rowNumber}-F${rowNumber})`;
}

/**
 * How a value should be sent to Sheets.
 *
 * `USER_ENTERED` parses a value as though somebody had typed it, which is what
 * makes dates sort and amounts add up. It is also what turns an InstaPay
 * number like `01001234567` into `1001234567` -- the leading zero is read as
 * an insignificant digit and dropped, and the number in the sheet is then
 * wrong by a character nobody notices.
 *
 * So the two columns that carry account identifiers are sent `RAW`, and the
 * write is split into two calls. The alternative -- sending everything RAW --
 * would store dates as text, and the accountant's formulas would stop seeing
 * them as dates.
 */
export const RAW_COLUMNS = new Set(['paymentDetails', 'id']);

export interface SheetRequest {
  reference: string;
  dueDate: string | null;
  type: string | null;
  description: string | null;
  requestedAmount: number | null;
  requesterName: string | null;
  requesterLogin: string | null;
  paidTotal: number;
  lastPaymentDate: string | null;
  statusLabel: string;
  createdAt: string;
  paymentMethod: string | null;
  paymentDetails: string | null;
  moreDetails: string | null;
  fileNames: string[];
  receiptNames: string[];
  approvedByRoute: string | null;
  vendorName: string | null;
  /** The department a lite-department request really came from. */
  source: string | null;
}

/*
 * Cairo, named rather than left to the server.
 *
 * An EC2 instance runs in UTC, so formatting with the process's own clock
 * would write every timestamp two or three hours before the one the Apps
 * Script wrote for the same moment -- and a request submitted at 1am Cairo
 * would be dated the previous day. Nothing would fail; the sheet would just
 * disagree with itself across the migration.
 */
const TZ = 'Africa/Cairo';

/** The sheet's own date format: what a person typing into it would write. */
function sheetDate(iso: string | null): string {
  if (!iso) return '';
  const d = DateTime.fromISO(iso, { zone: 'utc' }).setZone(TZ);
  /* No Z and no offset, so Sheets parses it in the spreadsheet's own
     timezone instead of reading it as UTC. */
  return d.isValid ? d.toFormat('yyyy-LL-dd') : '';
}

/** Date and time, for the Created At column, which records a moment. */
function sheetDateTime(iso: string): string {
  const d = DateTime.fromISO(iso, { zone: 'utc' }).setZone(TZ);
  return d.isValid ? d.toFormat('yyyy-LL-dd HH:mm:ss') : '';
}

/**
 * One row, as cell values in the sheet's column order.
 *
 * Returns the full width every time, with empty strings where a column does
 * not apply, so a short row can never shift later values left into the wrong
 * columns.
 */
export function toRow(r: SheetRequest, tab: string): (string | number | null)[] {
  const isPurchases = tab === 'Purchases Log';

  const byKey: Record<string, string | number> = {
    dueDate: sheetDate(r.dueDate),
    type: r.type ?? '',
    description: r.description ?? '',
    /* Unpriced requests exist -- a Purchases-routed one carries no amount
       until Purchases prices it -- and an empty cell is the honest
       representation. A zero would be added up as a zero-cost request. */
    requestedAmount: r.requestedAmount === null ? '' : r.requestedAmount,
    requestedBy: r.requesterName ?? '',
    paidTotal: r.paidTotal,
    status: r.statusLabel,
    lastPaymentDate: sheetDate(r.lastPaymentDate),
    id: r.reference,
    createdAt: sheetDateTime(r.createdAt),
    paymentMethod: r.paymentMethod ?? '',
    paymentDetails: r.paymentDetails ?? '',
    moreDetails: r.moreDetails ?? '',
    requesterLogin: r.requesterLogin ?? '',
    /* Names rather than links: a portal attachment is behind a signed URL
       that expires within the hour, so a link in the sheet would be dead
       before anybody clicked it. The name is enough to find the file in the
       request. */
    files: r.fileNames.join(', '),
    receipts: r.receiptNames.join(', '),
    approvedByRoute: r.approvedByRoute ?? '',
    vendor: isPurchases ? (r.vendorName ?? '') : '',
    source: isPurchases ? (r.source ?? '') : '',
  };

  return COLUMNS.map((key) => (key === null ? null : byKey[key] ?? ''));
}

/**
 * The runs of cells that can be written together, skipping the formula.
 *
 * A row is not one range: column G has to be stepped over, and the two RAW
 * columns need a different parse mode from the rest. Returning the spans makes
 * both constraints explicit rather than leaving them to be remembered at the
 * call site.
 */
export interface CellSpan {
  /** Zero-based, inclusive. */
  start: number;
  values: (string | number)[];
  mode: 'RAW' | 'USER_ENTERED';
}

export function spansFor(
  row: (string | number | null)[],
  /** Needed for the Remaining formula, which names its own row. */
  rowNumber?: number,
): CellSpan[] {
  const spans: CellSpan[] = [];
  let current: CellSpan | null = null;

  row.forEach((value, i) => {
    const key = COLUMNS[i];

    /*
     * The formula column. Given a row number it is written as its own span,
     * USER_ENTERED so Sheets stores a formula rather than the text of one.
     * Without a row number it is skipped, which is what the tests that only
     * check the value row want.
     */
    if (key === null) {
      if (rowNumber) {
        spans.push({ start: i, values: [remainingFormula(rowNumber)],
                     mode: 'USER_ENTERED' });
      }
      current = null;
      return;
    }

    if (value === null) { current = null; return; }

    const mode: CellSpan['mode'] = RAW_COLUMNS.has(key) ? 'RAW' : 'USER_ENTERED';
    if (current && current.start + current.values.length === i && current.mode === mode) {
      current.values.push(value);
    } else {
      current = { start: i, values: [value], mode };
      spans.push(current);
    }
  });

  return spans;
}

/** `A1`-style range for a span on a given row (1-based row number). */
export function a1(tab: string, rowNumber: number, span: CellSpan): string {
  const col = (i: number) => {
    let s = '';
    for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) {
      s = String.fromCharCode(65 + (n % 26)) + s;
    }
    return s;
  };
  const from = col(span.start);
  const to = col(span.start + span.values.length - 1);
  /* The tab name is quoted because the real ones contain dots and spaces --
     `P.R Log` is not a valid unquoted range reference. */
  return `'${tab.replace(/'/g, "''")}'!${from}${rowNumber}:${to}${rowNumber}`;
}