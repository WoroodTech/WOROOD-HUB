/**
 * Bringing the spreadsheet's history into the portal.
 *
 * Three steps, deliberately separate, because the middle one is where a
 * migration is either verified or merely hoped for:
 *
 *   **read**     — load a sheet export into staging and resolve every
 *                  reference to a department and a person. Writes nothing to
 *                  the live tables. Repeatable: the same file read twice
 *                  produces the same staging rows.
 *   **check**    — report everything wrong with the batch at once, as a list
 *                  somebody can work through. Not the first error: a run that
 *                  reports one problem at a time takes as many runs as there
 *                  are problems.
 *   **promote**  — write the valid rows into the live tables.
 *
 * Only `promote` touches anything real, and it refuses a batch with problems
 * unless they have been looked at and the force flag set.
 *
 * Two things this must never do, and the reasons they are stated rather than
 * assumed:
 *
 * Nothing is written back to the spreadsheet. It stays the record of what the
 * old system held, and a migration that edits its own source cannot be re-run
 * against it.
 *
 * No migrated payment is posted to Zoho. Those entries are already in the
 * accounts -- the old app put them there -- so their queue rows are created
 * SUPERSEDED. A migration that re-posts a year of payments would double every
 * figure in the books, and it would do it quietly.
 */
import { Injectable, Logger, BadRequestException, ForbiddenException } from '@nestjs/common';
import { Principal, can } from '../../../common/auth';
import { one, query, tx } from '../../../common/db';

const MANAGE = 'finance.request.manage';

/** A row as the sheet holds it, by column name. */
export interface SheetRequestRow {
  id: string;                 // column J
  tab?: string;
  dueDate?: string;           // A
  type?: string;              // B
  description?: string;       // C
  requestedAmount?: string;   // D
  requestedBy?: string;       // E
  paidTotal?: string;         // F
  status?: string;            // H
  lastPaymentDate?: string;   // I
  createdAt?: string;         // K
  paymentMethod?: string;     // L
  paymentDetails?: string;    // M
  moreDetails?: string;       // N
  requesterLogin?: string;    // O
  approvedBy?: string;        // R
  vendor?: string;            // S
  source?: string;            // T
}

export interface ImportProblem {
  row: number;
  legacyId: string;
  /** A stable name for the kind of problem, so a report can group by it. */
  kind: string;
  /** The same thing in words, with the offending value in it. */
  what: string;
}

@Injectable()
export class FinanceImportService {
  private readonly log = new Logger('FinanceImport');

  private assert(p: Principal) {
    if (!can(p, MANAGE)) {
      throw new ForbiddenException('Only Finance can run the migration.');
    }
  }

  /**
   * Read an export into staging.
   *
   * Every row is kept whether it is valid or not, with its problems attached.
   * Throwing away the bad ones would mean the count of what was in the file no
   * longer matches the count of what arrived, and that difference is the first
   * thing anybody checking a migration wants to see.
   */
  async read(p: Principal, sourceName: string, rows: SheetRequestRow[]) {
    this.assert(p);
    if (!rows?.length) throw new BadRequestException('The file has no rows in it.');

    const batch = await one<any>(
      `INSERT INTO fin_import_batches (kind, source_name, rows_read, created_by_id)
       VALUES ('requests',$1,$2,$3) RETURNING *`, [sourceName, rows.length, p.id]);

    /* Looked up once rather than per row: a six-thousand-row sheet would
       otherwise be six thousand round trips to resolve nine departments. */
    const departments = new Map<string, string>();
    for (const d of await query<any>(
      `SELECT f.code, f.page_key, f.department_id, d.name
         FROM fin_departments f JOIN core_departments d ON d.id = f.department_id`)) {
      departments.set(d.code.toLowerCase(), d.department_id);
      departments.set(d.page_key.toLowerCase(), d.department_id);
      departments.set(String(d.name).toLowerCase(), d.department_id);
    }

    const people = new Map<string, string>();
    for (const u of await query<any>(
      `SELECT id, email, full_name FROM core_users WHERE deleted_at IS NULL`)) {
      if (u.email) people.set(String(u.email).toLowerCase(), u.id);
      if (u.full_name) people.set(String(u.full_name).toLowerCase(), u.id);
    }

    const problems: ImportProblem[] = [];
    /* Things worth knowing that do not stop a row. Kept apart from problems so
       "42 rows cannot be imported" never includes rows that can. */
    const warnings: ImportProblem[] = [];
    let valid = 0;
    const seen = new Set<string>();

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      /* Each problem carries a stable kind as well as its wording. The report
         groups by kind, and a message with the offending value in it would
         never group -- three rows with three bad dates would read as three
         different problems instead of one thing to fix. */
      const rowProblems: { kind: string; what: string }[] = [];
      const note = (kind: string, what: string) => rowProblems.push({ kind, what });
      const legacyId = String(r.id ?? '').trim();

      if (!legacyId) note('no-identifier', 'no identifier in column J');
      /* A duplicate within one file is a copy-paste in the export, and
         promoting both would create two requests for one piece of spending. */
      else if (seen.has(legacyId)) {
        note('duplicate-identifier', 'this identifier appears twice in the file');
      }
      seen.add(legacyId);

      const departmentId = this.resolveDepartment(r, departments);
      if (!departmentId) {
        note('unknown-department',
          `no department matches "${r.tab ?? r.source ?? '(blank)'}"`);
      }

      /*
       * Somebody with no portal account does NOT stop the row.
       *
       * A request made in 2024 by somebody who left in 2025 is a fact that
       * happened, and refusing to carry it across would lose real history to
       * satisfy a foreign key. The name the sheet recorded comes across
       * instead, and the request shows it.
       *
       * Reported as a warning so the count is visible -- if three hundred rows
       * have no account, that is worth knowing before promoting, even though
       * none of them is an error.
       */
      const requesterId = this.resolvePerson(r, people);
      const legacyRequestedBy = String(
        r.requesterLogin ?? r.requestedBy ?? '').trim();
      if (!requesterId && !legacyRequestedBy) {
        /* No account AND no name is different: nothing identifies who asked,
           and that is a broken row rather than a departed colleague. */
        note('no-requester', 'neither a portal account nor a name for who asked');
      } else if (!requesterId) {
        warnings.push({ row: i + 2, legacyId, kind: 'former-colleague',
          what: `"${legacyRequestedBy}" has no portal account; the name will be kept` });
      }

      if (!this.looksLikeDate(r.dueDate)) {
        note('bad-due-date', `due date "${r.dueDate}" is not a date`);
      }

      const amount = this.toNumber(r.requestedAmount);
      if (amount === null) {
        note('bad-amount', `amount "${r.requestedAmount}" is not a number`);
      }

      const paid = this.toNumber(r.paidTotal) ?? 0;
      /* The sheet can hold this; the portal's constraints cannot, and finding
         out at promotion time means a failed transaction instead of a line in
         a report. */
      if (amount !== null && paid > amount + 0.005) {
        note('overpaid', `more has been paid (${paid}) than was asked for (${amount})`);
      }

      const isValid = rowProblems.length === 0;
      if (isValid) valid++;
      else for (const w of rowProblems) problems.push({ row: i + 2, legacyId, ...w });

      await query(
        `INSERT INTO fin_import_requests
           (batch_id, legacy_id, legacy_tab, raw, department_id, requester_id,
            valid, problems)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (legacy_id, batch_id) DO NOTHING`,
        [batch.id, legacyId || `row-${i + 2}`, r.tab ?? null, JSON.stringify(r),
         departmentId, requesterId, isValid, JSON.stringify(rowProblems)]);
    }

    await query(
      `UPDATE fin_import_batches SET rows_valid=$2, problems=$3 WHERE id=$1`,
      [batch.id, valid, JSON.stringify(problems.slice(0, 500))]);

    this.log.log(
      `read ${rows.length} row(s) from ${sourceName}: ${valid} ready, `
      + `${rows.length - valid} with problems`);

    return {
      batchId: batch.id,
      rowsRead: rows.length,
      rowsValid: valid,
      rowsWithProblems: rows.length - valid,
      /* Capped in the response, not in the database: a thousand problems is a
         file to fix, not a list to scroll. */
      problems: problems.slice(0, 100),
      truncated: problems.length > 100,
      /* Separate from problems: these rows will import. */
      warnings: warnings.slice(0, 100),
      rowsWithWarnings: warnings.length,
    };
  }

  /** What a batch looks like now, for reading before promoting. */
  async review(p: Principal, batchId: string) {
    this.assert(p);
    const batch = await one<any>(`SELECT * FROM fin_import_batches WHERE id=$1`, [batchId]);
    if (!batch) throw new BadRequestException('No such import.');

    /* Grouped by kind, not by wording: the wording carries the offending
       value, so three bad dates would otherwise read as three problems rather
       than one. */
    const byProblem = await query<any>(
      `SELECT p->>'kind' AS kind, min(p->>'what') AS example, count(*) AS n
         FROM fin_import_requests r,
              LATERAL jsonb_array_elements(r.problems) AS p
        WHERE r.batch_id=$1 AND NOT r.valid
        GROUP BY 1 ORDER BY n DESC LIMIT 20`, [batchId]);

    return {
      batchId,
      kind: batch.kind,
      source: batch.source_name,
      status: batch.status,
      rowsRead: batch.rows_read,
      rowsValid: batch.rows_valid,
      rowsPromoted: batch.rows_promoted,
      /* Grouped rather than listed: forty rows failing for one reason is one
         thing to fix, and a flat list makes it look like forty. */
      problemsByKind: byProblem.map((x) => ({
        kind: x.kind, example: x.example, rows: Number(x.n),
      })),
    };
  }

  /**
   * Write the valid rows into the live tables.
   *
   * Refuses a batch that still has problems unless `force` is set, and even
   * then promotes only the valid rows -- the invalid ones are never guessed
   * at. One transaction per request rather than one for the batch: a single
   * bad row in six thousand should not undo the other five thousand nine
   * hundred and ninety-nine.
   */
  async promote(p: Principal, batchId: string, opts: { force?: boolean } = {}) {
    this.assert(p);
    const batch = await one<any>(`SELECT * FROM fin_import_batches WHERE id=$1`, [batchId]);
    if (!batch) throw new BadRequestException('No such import.');
    if (batch.status === 'PROMOTED') {
      throw new BadRequestException('This import has already been promoted.');
    }

    const bad = Number(batch.rows_read) - Number(batch.rows_valid);
    if (bad > 0 && !opts.force) {
      throw new BadRequestException(
        `${bad} row(s) have problems. Review them first, then promote with force `
        + 'if the rest should go ahead without them.');
    }

    const staged = await query<any>(
      `SELECT * FROM fin_import_requests WHERE batch_id=$1 AND valid AND request_id IS NULL`,
      [batchId]);

    let promoted = 0;
    const failures: { legacyId: string; what: string }[] = [];

    for (const s of staged) {
      try {
        /* Whether this row actually became a request. The counter used to run
           on the transaction merely succeeding, so a row skipped by ON
           CONFLICT -- the normal case when a file is promoted twice -- was
           reported as promoted. A migration that overstates what it did is
           worse than one that fails. */
        const inserted = await tx(async (c) => {
          const raw = s.raw ?? {};
          const amount = this.toNumber(raw.requestedAmount);
          const paid = this.toNumber(raw.paidTotal) ?? 0;

          /* Migrated requests arrive already decided: they went through the
             old system's approvals and re-opening that chain here would ask
             people to approve things they approved months ago. */
          const { rows } = await c.query(
            `INSERT INTO fin_requests
               (reference, legacy_id, legacy_tab, department_id, requester_id,
                legacy_requested_by, charged_to_department_id, type, description,
                more_details, due_date, requested_amount, payment_method,
                payment_details, vendor_name, route, approval_state,
                finance_decided_by_id, finance_decided_at, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$4,$7,$8,$9,$10,$11,$12,$13,$14,'finance',
                     'APPROVED',$16,COALESCE($15::timestamptz, now()),
                     COALESCE($15::timestamptz, now()))
             ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO NOTHING
             RETURNING id`,
            [String(raw.id), String(raw.id), s.legacy_tab, s.department_id, s.requester_id,
             /* Always kept, so a request whose author later leaves still says
                who asked for it. */
             String(raw.requesterLogin ?? raw.requestedBy ?? '').trim() || null,
             raw.type || null, raw.description || '(no description)',
             raw.moreDetails || null, raw.dueDate, amount,
             raw.paymentMethod || null, raw.paymentDetails || null,
             raw.vendor || null, this.toDate(raw.createdAt),
             /*
              * Who the approval is recorded against.
              *
              * The spreadsheet does not reliably say who in Finance approved
              * what, and the requester is the wrong answer -- nobody approves
              * their own. It also cannot be left empty: an approved request
              * with no approver is a state the schema forbids, and rightly.
              *
              * So it is the person who ran the migration. They are the one
              * asserting that this history is what the old system held, and
              * legacy_id marks every such row, so nobody can mistake it for a
              * decision taken in the portal.
              */
             p.id]);

          const requestId = rows[0]?.id;
          if (!requestId) return false;   // already there from an earlier promotion

          /*
           * The payment history, as far as the sheet preserved it.
           *
           * It kept a total and the date of the LAST payment, so a request
           * paid in instalments comes across as one payment on that date. The
           * instalments are not recoverable -- they were never written down --
           * and inventing dates for them would be worse than recording the
           * one that is known.
           *
           * Marked with its legacy id so a reconciliation can tell a migrated
           * payment from one made in the portal.
           */
          if (paid > 0) {
            await c.query(
              `INSERT INTO fin_payments
                 (request_id, amount, paid_at, recorded_by_id, idempotency_key,
                  legacy_id, note)
               VALUES ($1,$2,COALESCE($3::timestamptz, now()),$4,$5,$6,$7)`,
              [requestId, paid, this.toDate(raw.lastPaymentDate), s.requester_id,
               `legacy:${raw.id}`, String(raw.id),
               'Brought across from the spreadsheet. The sheet kept only a total '
               + 'and the last payment date, so instalments are not separated.']);
          }

          await c.query(
            `UPDATE fin_import_requests SET request_id=$2 WHERE id=$1`, [s.id, requestId]);
          return true;
        });
        if (inserted) promoted++;
      } catch (e: any) {
        failures.push({ legacyId: s.legacy_id, what: String(e?.message ?? e).slice(0, 300) });
      }
    }

    /*
     * Everything brought across is already in Zoho: the old app put it there.
     * Their queue rows are created SUPERSEDED so the worker never looks at
     * them -- re-posting a year of payments would double every figure in the
     * accounts, and would do it silently.
     */
    const superseded = await query<any>(
      `INSERT INTO fin_zoho_events (kind, request_id, payment_id, payload,
                                     idempotency_key, status)
       SELECT 'EXPENSE', pm.request_id, pm.id, '{}'::jsonb,
              'migrated:' || pm.id, 'SUPERSEDED'
         FROM fin_payments pm
         JOIN fin_import_requests ir ON ir.request_id = pm.request_id
        WHERE ir.batch_id = $1 AND pm.legacy_id IS NOT NULL
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`, [batchId]);

    await query(
      `UPDATE fin_import_batches
          SET status='PROMOTED', rows_promoted=$2, promoted_at=now() WHERE id=$1`,
      [batchId, promoted]);

    this.log.log(
      `promoted ${promoted} request(s) from ${batch.source_name}; `
      + `${superseded.length} payment(s) marked as already in Zoho`);

    return {
      batchId, promoted, failed: failures.length, failures: failures.slice(0, 50),
      zohoEventsSuperseded: superseded.length,
    };
  }

  /** Throw a batch away. Staging rows stay, for reference. */
  async discard(p: Principal, batchId: string) {
    this.assert(p);
    const row = await one<any>(
      `UPDATE fin_import_batches SET status='DISCARDED'
        WHERE id=$1 AND status='PENDING' RETURNING id`, [batchId]);
    if (!row) throw new BadRequestException('Only an unpromoted import can be discarded.');
    return { discarded: true };
  }

  /* ------------------------------------------------------------ helpers -- */

  private resolveDepartment(r: SheetRequestRow, map: Map<string, string>): string | null {
    /* Source first: a lite department's request sits in the Purchases tab but
       belongs to Office, Workshop or Warehouse, and column T is the only place
       that says so. Reading the tab first would file all three as Purchases. */
    for (const candidate of [r.source, r.tab?.replace(/ Log$| Pending$/i, '')]) {
      const key = String(candidate ?? '').trim().toLowerCase();
      if (key && map.has(key)) return map.get(key)!;
    }
    return null;
  }

  private resolvePerson(r: SheetRequestRow, map: Map<string, string>): string | null {
    for (const candidate of [r.requesterLogin, r.requestedBy]) {
      const key = String(candidate ?? '').trim().toLowerCase();
      if (key && map.has(key)) return map.get(key)!;
    }
    return null;
  }

  private toNumber(v: unknown): number | null {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    const raw = String(v);

    /* The digits have to be there before the symbols are stripped. Stripping
       first turns "lots" into an empty string, and Number('') is zero -- so a
       word in an amount column became a request for nothing at all, silently,
       and passed every check after it. */
    if (!/\d/.test(raw)) return null;

    /* Sheets export thousands separators and currency symbols. */
    const n = Number(raw.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  private looksLikeDate(v: unknown): boolean {
    return !!v && !Number.isNaN(new Date(String(v)).getTime());
  }

  private toDate(v: unknown): string | null {
    if (!this.looksLikeDate(v)) return null;
    return new Date(String(v)).toISOString();
  }
}