/**
 * The warehouse spreadsheet.
 *
 * Its own connection and its own service account, separate from Finance: they
 * are different documents owned by different teams, and credentials that can
 * write stock have no business in the accountant's cash flow.
 *
 * The sheet is the source of truth. This reads from it and appends to it; it
 * never decides anything itself.
 */
import { Injectable, Logger } from '@nestjs/common';
import { google, sheets_v4 } from 'googleapis';
import { config } from '../../../common/config';
import { ITEMS_TAB } from './tabs';

/** Raised when the connection is switched off deliberately. */
export class WarehouseSheetOffError extends Error {
  readonly sheetOff = true;
}

/** Raised when a tab's columns are not where they were. */
export class WarehouseSheetShapeError extends Error {
  readonly shapeMismatch = true;
}

@Injectable()
export class WarehouseSheetClient {
  private readonly log = new Logger('WarehouseSheet');
  private api: sheets_v4.Sheets | null = null;

  /**
   * The header row is not always row 1.
   *
   * `Creating New Item` puts its headers on row 2 and leaves row 1 blank, and
   * reading from row 1 there gives a row of empty strings and an item
   * catalogue that silently comes back with no columns.
   */
  private static readonly HEADER_ROW: Record<string, number> = {
    'Creating New Item': 2,
  };

  /**
   * Which column says whether a row holds real data.
   *
   * It has to be one a person fills in, never one the sheet computes: both
   * these tabs carry formulas copied thousands of rows past their last
   * entry, and probing one of those would report the bottom of the prepared
   * block as the end of the data.
   *
   * The ledger's A is its date — the same column the Apps Script walks up,
   * with the comment "rows below are pre-filled formulas". The catalogue's B
   * is Colour: A there is `=H{row}` and is filled all the way down.
   */
  private static readonly PROBE_COLUMN: Record<string, string> = {
    'Scarves Inventory': 'A',
    'Creating New Item': 'B',
  };

  /**
   * The first column a written row actually starts at.
   *
   * The catalogue's A is `=H{row}`, one of the formulas that computes the
   * item's code, name and group from the three typed cells. A row written
   * from A would put a blank into it and leave that item with no code at
   * all, so the write starts at B and the formulas either side are left
   * alone. The ledger is written from A as before.
   */
  private static readonly WRITE_FROM: Record<string, string> = {
    'Creating New Item': 'B',
  };

  get mode(): 'off' | 'dry' | 'live' { return config.warehouseSheets.mode; }

  get configured(): boolean {
    return !!(config.warehouseSheets.spreadsheetId
      && config.warehouseSheets.serviceAccountKey);
  }

  private client(): sheets_v4.Sheets {
    if (this.api) return this.api;
    if (!this.configured) {
      throw new WarehouseSheetOffError(
        'The warehouse spreadsheet is not configured on this server.');
    }

    /* The whole service-account JSON, base64-encoded. A PEM key is
       multi-line, and in an env file its newlines arrive as the two
       characters \ and n — the signature then fails with an error about the
       key format that sends people looking at sharing permissions instead. */
    const creds = JSON.parse(
      Buffer.from(config.warehouseSheets.serviceAccountKey, 'base64').toString('utf8'));

    const auth = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    return (this.api = google.sheets({ version: 'v4', auth }));
  }

  private get id(): string { return config.warehouseSheets.spreadsheetId; }

  /** Where a tab's headers live. */
  headerRow(tab: string): number {
    return WarehouseSheetClient.HEADER_ROW[tab] ?? 1;
  }

  /**
   * Every value in a tab, as rows of strings, headers included.
   *
   * `UNFORMATTED_VALUE` so a quantity comes back as a number rather than as
   * whatever the cell's display format made of it, and `FORMULA` is not used
   * — most of the catalogue's columns are formulas, and what matters is what
   * they currently evaluate to.
   */
  async read(tab: string, range?: string): Promise<any[][]> {
    const res = await this.client().spreadsheets.values.get({
      spreadsheetId: this.id,
      range: range ? `${tab}!${range}` : tab,
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    });
    return (res.data.values ?? []) as any[][];
  }

  /** A tab's header row, trimmed. */
  async readHeader(tab: string): Promise<string[]> {
    const row = this.headerRow(tab);
    const values = await this.read(tab, `${row}:${row}`);
    return (values[0] ?? []).map((h) => String(h ?? '').trim());
  }

  /**
   * Check a tab's columns are where this code expects them.
   *
   * Called before the first write to a tab in each process. If somebody has
   * inserted a column, a quantity would otherwise land in the warehouse
   * column and a warehouse name in the quantity column — and the sheet would
   * accept both without complaint.
   *
   * Refusing to write is the right answer: the movement stays queued, and
   * somebody looks at the sheet.
   */
  async assertShape(tab: string, expected: Record<string, number>): Promise<void> {
    const header = await this.readHeader(tab);
    const wrong: string[] = [];

    for (const [name, index] of Object.entries(expected)) {
      const found = String(header[index] ?? '').trim().toLowerCase();
      if (found !== name.trim().toLowerCase()) {
        wrong.push(`column ${colName(index)} should be "${name}" but is "${header[index] ?? ''}"`);
      }
    }

    if (wrong.length) {
      throw new WarehouseSheetShapeError(
        `The "${tab}" tab does not have the columns this expects — `
        + `${wrong.join('; ')}. Nothing was written.`);
    }
  }

  /**
   * Add a row at the end of a tab.
   *
   * Written with USER_ENTERED so a date arrives as a date — see the note on
   * the write itself. Nothing written here is a code with leading zeros: the
   * catalogue's codes are formulas the sheet computes, and the three cells
   * this sends it are plain words. `safe()` guards the one real risk, a
   * value beginning `=` becoming a live formula.
   */
  async append(tab: string, row: any[]): Promise<{ tab: string; rowNumber: number }> {
    if (this.mode === 'off') {
      throw new WarehouseSheetOffError(
        'The warehouse spreadsheet connection is switched off on this server.');
    }
    if (this.mode === 'dry') {
      /*
       * Refused, not faked.
       *
       * The Finance queue used to return a stub id in dry mode and mark the
       * event posted; five real payments were lost that way before anybody
       * noticed. Throwing leaves the movement queued, and switching the
       * connection on is all it takes to send it.
       */
      this.log.log(`[dry] append to ${tab}: ${JSON.stringify(row).slice(0, 300)}`);
      throw new WarehouseSheetOffError(
        'The warehouse sheet is in dry mode, so this was not written. '
        + 'It stays queued and goes out when WAREHOUSE_SHEETS_MODE=live.');
    }

    /*
     * Written onto the first free row, not appended to the tab.
     *
     * `values.append` asks the API to find the end of "the table", and the
     * API counts a cell holding a formula as filled. Both of these tabs are
     * prepared far below their real data — the ledger's balance column is
     * copied down to about row 61,000 and the catalogue's coding columns to
     * about row 3,500 — so the end of the table is tens of thousands of rows
     * past the last real entry. Receiving wrote at row 61,023 with nothing
     * between it and row 36,000, and every new item landed on row 3 and
     * overwrote the one already there.
     *
     * The Apps Script never had this problem because it does not ask: it
     * walks up column A for the last row carrying a date, with the comment
     * "rows below are pre-filled formulas". This is that, generalised to a
     * probe column per tab.
     */
    const at = (await this.lastDataRow(tab)) + 1;
    const from = WarehouseSheetClient.WRITE_FROM[tab] ?? 'A';

    /* Trimmed to match where the write starts, so column B's value does not
       land in C. The caller builds the row by its own column indexes, which
       are counted from A. */
    const skip = from.charCodeAt(0) - 65;
    const values = (skip ? row.slice(skip) : row)
      /*
       * `null`, not `''`, for a cell this row does not set.
       *
       * The catalogue's E to H are the formulas that compute the item's
       * code; writing `''` into them would wipe all four and leave the item
       * with none. The API skips a null and leaves the cell exactly as it
       * was, so a row can reach past those formulas to column I without
       * destroying them on the way.
       */
      .map((v) => (v === '' || v === undefined ? null : v));

    await this.client().spreadsheets.values.update({
      spreadsheetId: this.id,
      range: `${tab}!${from}${at}`,
      /*
       * Parsed, as the Apps Script's own writes are.
       *
       * RAW stores a date as whatever it was handed — a serial number stayed
       * the number `46348` in a column with no date format this far down,
       * which no reader and no date filter could use. USER_ENTERED reads
       * `11/11/2026` as the date it is, the same way typing it would.
       *
       * Everything else written here is a name, a code or a quantity, none
       * of which USER_ENTERED changes. `safe()` already puts a leading
       * apostrophe in front of anything that would otherwise be taken for a
       * formula.
       */
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [values] },
    });

    return { tab, rowNumber: at };
  }

  /**
   * The last row of this tab carrying real data, ignoring the formulas
   * pre-filled beneath it.
   *
   * Probed on the column that is typed rather than computed: the ledger's
   * date, the catalogue's colour. A formula column would answer with the
   * bottom of the prepared block, which is the whole problem.
   */
  private async lastDataRow(tab: string): Promise<number> {
    const probe = WarehouseSheetClient.PROBE_COLUMN[tab] ?? 'A';
    const header = this.headerRow(tab);

    const col = await this.read(tab, `${probe}${header}:${probe}`);

    /* Walk up from the bottom: the first row with something in it wins. The
       read returns evaluated values, so a formula producing "" reads as
       empty here and is skipped, which is exactly what is wanted. */
    let last = header;
    for (let i = col.length - 1; i >= 0; i--) {
      const v = col[i]?.[0];
      if (v !== undefined && v !== null && String(v).trim() !== '') {
        last = header + i;
        break;
      }
    }
    return last;
  }


  /** Overwrite one range. Used for corrections, never for appends. */
  async write(tab: string, range: string, values: any[][]): Promise<void> {
    if (this.mode !== 'live') {
      throw new WarehouseSheetOffError(
        'The warehouse sheet is not in live mode, so nothing was written.');
    }
    await this.client().spreadsheets.values.update({
      spreadsheetId: this.id,
      range: `${tab}!${range}`,
      valueInputOption: 'RAW',
      requestBody: { values },
    });
  }

  /**
   * A value that cannot become a formula.
   *
   * Anything a person typed goes through this before it reaches a cell. The
   * sheet treats a leading `=`, `+`, `-` or `@` as the start of a formula, so
   * a note reading `=IMPORTRANGE(...)` would run for whoever opens the sheet
   * next, with their access, not the writer's.
   *
   * `--` is let through: the catalogue uses it to mean "none", and it is the
   * one leading-dash value that is deliberate.
   */
  static safe(value: unknown): string {
    const s = String(value ?? '').trim();
    if (!s) return '';
    if (s === '--') return s;
    return /^[=+@]/.test(s) || /^-(?!-)/.test(s) ? `'${s}` : s;
  }
}

/** 0 → A, 25 → Z, 26 → AA. For telling somebody which column moved. */
function colName(index: number): string {
  let n = index, out = '';
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1; }
  while (n >= 0);
  return out;
}