/**
 * The daily cash-flow forecast: how much each kind of spending needs, per day.
 *
 * This is the screen Finance actually looks at, and it is a direct translation
 * of one spreadsheet formula. The original, from the legacy source:
 *
 *   SUMPRODUCT( <type filter> * (A<>"") * (A<=day) *
 *               ( D * (((I>=day) + (I="")) > 0)
 *               + G * ((I<day) * (I<>"")) ) )
 *
 * where A is the due date, D the requested amount, G the remaining, and I the
 * last payment date. In words: a request counts from its due date onwards; it
 * contributes its **full amount** while it is unpaid or was last paid on or
 * after the day being asked about, and only its **remaining** once a payment
 * has happened before that day.
 *
 * ---
 *
 * There is a defect in that, and it is the reason this service computes the
 * answer twice.
 *
 * The sheet keeps only the *last* payment date, because a row cannot hold a
 * list. So a request paid 1,000 on the 5th and 2,000 on the 20th looks, on the
 * 10th, like a request last paid on the 20th -- which is after the 10th, so
 * the formula counts the **full 3,000** even though 1,000 had already gone
 * out. The forecast overstates every day between two part payments.
 *
 * Here each payment is a row with its own date, so the true figure is
 * computable. But the sheet's numbers are the ones Finance has been working
 * from, and a migration that silently changes them is a migration nobody can
 * check.
 *
 * So both are produced:
 *
 *   `accurate` — uses the real payment dates. **The default.**
 *   `legacy`   — reproduces the sheet exactly, last-payment-date and all.
 *
 * `accurate` is the default because the other one is wrong, and a forecast
 * that overstates makes a company hold cash it does not need. `legacy` stays
 * because the migration has to be checked against figures Finance already
 * has, and because somebody comparing the two should be able to.
 *
 * The screen says which is which in words rather than in jargon, and says so
 * on every view -- a number that quietly changed meaning is worse than one
 * that was always wrong.
 */
import { Injectable } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { Principal, can } from '../../common/auth';
import { query } from '../../common/db';

const REPORT = 'finance.report.view';
const MANAGE = 'finance.request.manage';

/**
 * The columns of the cash flow, and which requests feed each.
 *
 * Taken from the legacy LCF_MAP. Two of them are the Purchases department
 * split by type, and the rest are whole departments. Note what is absent:
 * there is no "other" column, so a department not listed here does not appear
 * in the forecast at all -- Office, Workshop and Warehouse reach it only after
 * Purchases has priced their requests, through the Purchases columns.
 */
export const CASH_FLOW_COLUMNS: {
  key: string; label: string; labelAr: string;
  departmentCode: string;
  /** Only this type, or everything except it. */
  type?: string; exceptType?: string;
}[] = [
  { key: 'vendorspayments', label: 'Vendors Payments', labelAr: 'مدفوعات الموردين',
    departmentCode: 'PUR', exceptType: 'Petty Cash' },
  { key: 'pettycash', label: 'Petty Cash', labelAr: 'النثرية',
    departmentCode: 'PUR', type: 'Petty Cash' },
  { key: 'marketingexp', label: 'Marketing Exp.', labelAr: 'مصاريف التسويق',
    departmentCode: 'MKT' },
  { key: 'p.rexpenses', label: 'P.R Expenses/Event', labelAr: 'مصاريف العلاقات العامة',
    departmentCode: 'PRX' },
  { key: 'techexpenses', label: 'Tech Expenses', labelAr: 'مصاريف التقنية',
    departmentCode: 'TEC' },
  { key: 'customersupport', label: 'Customer Support Exp.', labelAr: 'مصاريف خدمة العملاء',
    departmentCode: 'CSP' },
  { key: 'hrexpenses', label: 'HR Expenses', labelAr: 'مصاريف الموارد البشرية',
    departmentCode: 'HRX' },
];

export type CashFlowMethod = 'legacy' | 'accurate';

@Injectable()
export class CashFlowService {
  /**
   * The forecast for one month.
   *
   * One query rather than one per day: the days are generated in SQL and
   * joined against the requests, so a month of seven columns is a single pass
   * instead of two hundred round trips.
   */
  async forMonth(p: Principal, month: string, method: CashFlowMethod = 'accurate') {
    if (!can(p, REPORT) && !can(p, MANAGE)) {
      throw new ForbiddenException('You cannot see the cash flow.');
    }
    if (!/^\d{4}-\d{2}$/.test(month)) {
      throw new ForbiddenException('Give the month as YYYY-MM.');
    }

    const rows = await query<any>(
      `
      WITH days AS (
        SELECT generate_series(
          ($1 || '-01')::date,
          (($1 || '-01')::date + interval '1 month - 1 day')::date,
          interval '1 day')::date AS day
      ),
      /* Every approved request, with what it asked for, what has been paid,
         and the two different answers to "when was it last paid". */
      live AS (
        SELECT r.id, r.due_date, r.type,
               f.code AS department_code,
               COALESCE(r.requested_amount, 0) AS asked,
               COALESCE(sum(pm.amount), 0) AS paid,
               max(pm.paid_at)::date AS last_paid
          FROM fin_requests r
          JOIN fin_departments f
            ON f.department_id = COALESCE(r.charged_to_department_id, r.department_id)
          LEFT JOIN fin_payments pm ON pm.request_id = r.id
         WHERE r.deleted_at IS NULL
           AND r.approval_state = 'APPROVED'
           AND r.due_date IS NOT NULL
         GROUP BY r.id, f.code
      ),
      /* How much had been paid by the end of each day. Only needed for the
         accurate method; the legacy one cannot ask this question because the
         sheet does not keep the dates. */
      paid_by AS (
        SELECT l.id, d.day, COALESCE(sum(pm.amount), 0) AS paid_to_date
          FROM live l
          CROSS JOIN days d
          LEFT JOIN fin_payments pm
            ON pm.request_id = l.id AND pm.paid_at::date <= d.day
         GROUP BY l.id, d.day
      )
      SELECT d.day, l.department_code, l.type,
             /* The legacy term, exactly as the spreadsheet computes it: the
                full amount while unpaid or last paid on/after this day, the
                remaining once a payment happened before it. */
             CASE
               WHEN l.last_paid IS NULL OR l.last_paid >= d.day THEN l.asked
               ELSE GREATEST(l.asked - l.paid, 0)
             END AS legacy_amount,
             /* The same question answered with the real dates: what was still
                owing at the end of this day. */
             GREATEST(l.asked - pb.paid_to_date, 0) AS accurate_amount
        FROM days d
        JOIN live l ON l.due_date <= d.day
        JOIN paid_by pb ON pb.id = l.id AND pb.day = d.day
      `, [month]);

    /* Shaped in TypeScript rather than SQL: the column definitions carry a
       type filter and an exception, and expressing those as SQL would mean
       generating a CASE per column for no gain. */
    /*
     * Every day of the month, whether or not anything is owed on it.
     *
     * Built before the rows are read rather than from them: a month with no
     * spending in it used to come back as an empty list, so the screen showed
     * nothing at all instead of a quiet month. A forecast of zero is an
     * answer; a blank page is not one.
     */
    const days = new Map<string, Record<string, number>>();
    const first = new Date(`${month}-01T12:00:00Z`);
    for (let d = new Date(first); d.getUTCMonth() === first.getUTCMonth();
         d.setUTCDate(d.getUTCDate() + 1)) {
      days.set(d.toISOString().slice(0, 10),
        Object.fromEntries(CASH_FLOW_COLUMNS.map((c) => [c.key, 0])));
    }

    for (const r of rows) {
      const day = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day);
      const into = days.get(day);
      if (!into) continue;
      const amount = Number(
        method === 'accurate' ? r.accurate_amount : r.legacy_amount);

      for (const col of CASH_FLOW_COLUMNS) {
        if (col.departmentCode !== r.department_code) continue;
        if (col.type && r.type !== col.type) continue;
        if (col.exceptType && r.type === col.exceptType) continue;
        into[col.key] += amount;
      }
    }

    const out = [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, columns]) => ({
        day,
        columns,
        total: Object.values(columns).reduce((n, v) => n + v, 0),
      }));

    return {
      month,
      method,
      columns: CASH_FLOW_COLUMNS.map((c) => ({
        key: c.key, label: c.label, labelAr: c.labelAr,
      })),
      days: out,
    };
  }

  /**
   * Both methods, side by side, with the days where they differ.
   *
   * The screen for the conversation with Finance: here is what the sheet says,
   * here is what the real payment dates say, and here is exactly where they
   * part company. A difference on no day means the migration can be checked
   * against the sheet figure for figure; a difference somewhere means a
   * request was paid in instalments, and the accurate column is the right one.
   */
  async compare(p: Principal, month: string) {
    const [legacy, accurate] = await Promise.all([
      this.forMonth(p, month, 'legacy'),
      this.forMonth(p, month, 'accurate'),
    ]);

    const byDay = new Map(accurate.days.map((d) => [d.day, d]));
    const differences = legacy.days
      .map((l) => {
        const a = byDay.get(l.day);
        if (!a) return null;
        const delta = l.total - a.total;
        /* Half a piastre: floating point on money that is stored as numeric,
           not a tolerance for real disagreement. */
        return Math.abs(delta) < 0.005 ? null : {
          day: l.day,
          legacy: l.total,
          accurate: a.total,
          /* Always positive in practice: the sheet overstates, because it
             treats an earlier part payment as not yet having happened. */
          overstatedBy: delta,
        };
      })
      .filter(Boolean);

    return {
      month,
      legacyTotal: legacy.days.reduce((n, d) => n + d.total, 0),
      accurateTotal: accurate.days.reduce((n, d) => n + d.total, 0),
      daysThatDiffer: differences.length,
      differences,
    };
  }
}