/**
 * Take what is on screen away as a spreadsheet.
 *
 * Every table the Apps Script shows on Reconciliation, Planning and the
 * rolls Report has an "Export Excel (CSV)" button beside Print, and the
 * portal had neither: a warehouse manager who wanted to sort the numbers
 * their own way, or send them to somebody without a login, had to retype
 * them.
 *
 * Built here rather than on the server because the file is exactly what the
 * reader is looking at — the range they chose, the filter they set, the
 * columns in front of them. A server-side export is a second definition of
 * the same report, and the two drift.
 */
import { Icon } from './Icon';

export interface CsvColumn<Row> {
  /** The column heading, as it reads on screen. */
  header: string;
  /** What to put in the cell. Returned as-is; numbers stay numbers. */
  value: (row: Row) => string | number | null | undefined;
}

/**
 * One field, quoted only where it has to be.
 *
 * Excel splits on a comma, ends a record at a newline, and reads a double
 * quote as the end of a quoted field — so a note saying `50 m, grade "A"`
 * would otherwise land in three cells across two rows. Quoting everything
 * would also work and would make the file unreadable in a text editor.
 */
function field(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (!/[",\n\r]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv<Row>(rows: Row[], columns: CsvColumn<Row>[]): string {
  const lines = [columns.map((c) => field(c.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => field(c.value(row))).join(','));
  }
  /* CRLF: Excel on Windows treats a bare newline inside a quoted field and
     a record separator as the same thing otherwise. */
  return lines.join('\r\n');
}

export function ExportCsv<Row>({ rows, columns, name, label }: {
  rows: Row[];
  columns: CsvColumn<Row>[];
  /** Used as the file name; the date is added so two exports do not collide. */
  name: string;
  label?: string;
}) {
  const save = () => {
    const csv = toCsv(rows, columns);
    /*
     * A byte-order mark, so Excel reads it as UTF-8.
     *
     * Without it Excel guesses the local code page, and every Arabic item
     * name in the file arrives as mojibake — which is most of them.
     */
    const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    /* The object stays alive until it is revoked, and a warehouse report is
       not small. */
    URL.revokeObjectURL(url);
  };

  return (
    <button type="button" className="btn btn--ghost btn--sm no-print"
            disabled={!rows.length}
            title={rows.length ? undefined : 'Nothing to export yet'}
            onClick={save}>
      <Icon name="download" size={14} /> {label ?? 'Export Excel (CSV)'}
    </button>
  );
}