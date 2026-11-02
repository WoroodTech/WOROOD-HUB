/**
 * Talking to the accountant's spreadsheet.
 *
 * A service account, not an Apps Script web app. The web app would have to be
 * published as "Anyone" for a server to call it -- a publicly reachable URL
 * whose only protection is an HMAC we wrote ourselves -- and it would run with
 * the full Drive and Gmail access of whoever deployed it. A service account
 * has no endpoint at all, and knows only the one file it was shared with.
 *
 * Three modes, as for Zoho: `off` refuses, `dry` reads but never writes, and
 * `live` does both. Dry reads for real on purpose -- the Zoho client once
 * short-circuited reads too, which made a working connection look like an
 * empty organisation and cost an afternoon.
 */
import { Injectable, Logger } from '@nestjs/common';
import { google, sheets_v4 } from 'googleapis';
import { JWT } from 'google-auth-library';
import { config } from '../../../common/config';
import { CellSpan, a1 } from './row-mapping';

@Injectable()
export class SheetsClient {
  private readonly log = new Logger('Sheets');
  private api: sheets_v4.Sheets | null = null;

  get mode(): 'off' | 'dry' | 'live' { return config.sheets.mode; }

  get configured(): boolean {
    return !!config.sheets.spreadsheetId && !!config.sheets.serviceAccountKey;
  }

  /**
   * The authorised client, built once.
   *
   * The key arrives base64-encoded in one environment variable. A PEM private
   * key is multi-line, and putting it in an env file directly means its
   * newlines come back as the two characters `\` and `n` -- the signature then
   * fails with an error about the key format that sends people looking at
   * permissions instead.
   */
  private client(): sheets_v4.Sheets {
    if (this.api) return this.api;

    const raw = Buffer.from(config.sheets.serviceAccountKey, 'base64').toString('utf8');
    let credentials: { client_email: string; private_key: string };
    try {
      credentials = JSON.parse(raw);
    } catch {
      throw new Error(
        'SHEETS_SA_KEY_B64 is not base64-encoded JSON. It should be the whole '
        + 'service-account JSON file, base64-encoded: base64 -w0 key.json');
    }
    if (!credentials.client_email || !credentials.private_key) {
      throw new Error(
        'The service-account JSON has no client_email or private_key in it.');
    }

    const auth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      /* The narrowest scope that can write a cell. `drive` would also let this
         key read every file the account can see, which is the opposite of the
         point. */
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    this.api = google.sheets({ version: 'v4', auth });
    return this.api;
  }

  /**
   * Refuse anything that would reach Google, unless this is only a read.
   *
   * `off` means "do not write", the same way `dry` does for Zoho. Reads are
   * how a connection is checked before it is switched on, and blocking them
   * made the setup check fail for the one reason that was expected.
   */
  private assertUsable(readOnly = false) {
    if (this.mode === 'off' && !readOnly) {
      throw new Error('The sheet integration is switched off (SHEETS_MODE=off).');
    }
    if (!this.configured) {
      throw new Error(
        'The sheet integration is not configured: SHEETS_SPREADSHEET_ID and '
        + 'SHEETS_SA_KEY_B64 are both needed.');
    }
  }

  /**
   * Whose spreadsheet is this, and what tabs does it have?
   *
   * The first thing to run after setting the key up. It proves the key parses,
   * the account is allowed in, and the file is the one intended -- each of
   * which fails differently, and all of which otherwise fail for the first
   * time during a real write.
   */
  async describe() {
    /*
     * Deliberately NOT assertUsable().
     *
     * Checking the connection is the one thing that has to work while the
     * integration is still off — that is the whole point of switching it on
     * in stages. Refusing here meant the first setup check returned a 500
     * whose only cause was that nothing had been switched on yet, which sends
     * somebody looking at keys and sharing instead.
     */
    if (!config.sheets.spreadsheetId) {
      return this.cannot('SHEETS_SPREADSHEET_ID is not set.');
    }
    if (!config.sheets.serviceAccountKey) {
      return this.cannot('SHEETS_SA_KEY_B64 is not set.');
    }

    try {
      return await this.describeNow();
    } catch (e: any) {
      /* Google's own words, with what they usually mean beside them. Each of
         these fails differently and sends people to a different place. */
      const said = String(e?.message ?? e);
      const likely =
          /permission/i.test(said)
            ? 'The service account has not been given access. Share the spreadsheet '
              + 'with its e-mail address as an Editor.'
        : /not found|notFound/i.test(said)
            ? 'No spreadsheet has that id. Check SHEETS_SPREADSHEET_ID against the '
              + 'part of the sheet URL between /d/ and /edit.'
        : /base64|JSON|private_key|client_email/i.test(said)
            ? 'The key could not be read. SHEETS_SA_KEY_B64 should be the whole '
              + 'service-account JSON file, base64-encoded on one line.'
        : /invalid_grant|JWT|signature/i.test(said)
            ? 'Google rejected the key. It may have been revoked, or the server '
              + 'clock may be wrong.'
        : null;
      return this.cannot(said, likely);
    }
  }

  private cannot(said: string, likely?: string | null) {
    return {
      reachable: false, title: null, timeZone: null, tabs: [],
      mode: this.mode,
      spreadsheetId: config.sheets.spreadsheetId || null,
      said,
      likely: likely ?? null,
    };
  }

  private async describeNow() {
    const res = await this.client().spreadsheets.get({
      spreadsheetId: config.sheets.spreadsheetId,
      fields: 'properties(title,timeZone),sheets.properties(title,gridProperties)',
    });
    return {
      reachable: true,
      spreadsheetId: config.sheets.spreadsheetId,
      said: null,
      likely: null,
      title: res.data.properties?.title ?? null,
      /* Worth seeing: the sheet's own timezone is what a date written without
         an offset will be read in. */
      timeZone: res.data.properties?.timeZone ?? null,
      tabs: (res.data.sheets ?? []).map((s) => ({
        title: s.properties?.title ?? '',
        rows: s.properties?.gridProperties?.rowCount ?? 0,
        columns: s.properties?.gridProperties?.columnCount ?? 0,
      })),
      mode: this.mode,
    };
  }

  /** One column of a tab, as plain strings. */
  async readColumn(tab: string, columnIndex: number, limit = 5000): Promise<string[]> {
    this.assertUsable(true);
    const letter = String.fromCharCode(65 + columnIndex);
    const res = await this.client().spreadsheets.values.get({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `'${tab.replace(/'/g, "''")}'!${letter}1:${letter}${limit}`,
      /* The reference as typed, not as the sheet would display it. */
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    return (res.data.values ?? []).map((r) => String(r?.[0] ?? ''));
  }

  /** The header row, for checking the columns are still where we think. */
  async readHeader(tab: string): Promise<string[]> {
    this.assertUsable(true);
    const res = await this.client().spreadsheets.values.get({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `'${tab.replace(/'/g, "''")}'!1:1`,
    });
    return (res.data.values?.[0] ?? []).map((v) => String(v ?? '').trim());
  }

  /**
   * How many rows of a tab are in use.
   *
   * Taken from the ID column rather than from the grid size, which counts
   * blank rows the sheet keeps allocated and would put every new row a
   * thousand lines below the data.
   */
  async nextFreeRow(tab: string, idColumnIndex: number): Promise<number> {
    const ids = await this.readColumn(tab, idColumnIndex);
    let last = 0;
    ids.forEach((v, i) => { if (v.trim() !== '') last = i + 1; });
    return last + 1;
  }

  /**
   * Write the spans of one row.
   *
   * Spans rather than a single range because the row is not contiguous: the
   * Remaining column holds a formula and is stepped over, and the columns
   * carrying account numbers need RAW so a leading zero survives.
   *
   * Each parse mode is one batch call, because the mode is a property of the
   * request rather than of a range.
   */
  async writeRow(tab: string, rowNumber: number, spans: CellSpan[]): Promise<void> {
    this.assertUsable();

    if (this.mode === 'dry') {
      for (const s of spans) {
        this.log.log(
          `[dry] ${a1(tab, rowNumber, s)} (${s.mode}) = ${JSON.stringify(s.values)}`);
      }
      return;
    }

    for (const mode of ['USER_ENTERED', 'RAW'] as const) {
      const ofMode = spans.filter((s) => s.mode === mode);
      if (!ofMode.length) continue;
      await this.client().spreadsheets.values.batchUpdate({
        spreadsheetId: config.sheets.spreadsheetId,
        requestBody: {
          valueInputOption: mode,
          data: ofMode.map((s) => ({
            range: a1(tab, rowNumber, s),
            values: [s.values],
          })),
        },
      });
    }
  }
}