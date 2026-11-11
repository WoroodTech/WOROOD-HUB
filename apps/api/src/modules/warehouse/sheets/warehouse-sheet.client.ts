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
   * `RAW`, deliberately. `USER_ENTERED` would let the sheet interpret what it
   * is given: a value beginning `=` becomes a live formula, and an item code
   * like `0012` loses its leading zeros by being read as a number. Dates are
   * sent as text in the sheet's own format for the same reason.
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

    const res = await this.client().spreadsheets.values.append({
      spreadsheetId: this.id,
      range: tab,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });

    /* "'Scarves Inventory'!A4521:Z4521" — the row it landed on, so a ledger
       entry here can be traced to a line in the sheet. */
    const updated = res.data.updates?.updatedRange ?? '';
    const m = updated.match(/![A-Z]+(\d+)/);
    return { tab, rowNumber: m ? Number(m[1]) : 0 };
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