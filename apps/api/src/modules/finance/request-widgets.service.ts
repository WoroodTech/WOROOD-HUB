/**
 * Finance requests, as dashboard widgets.
 *
 * The same machinery the Shopify dashboards use — a widget key, a range, a
 * payload shaped for the charts the portal already has — so a Requests
 * dashboard is built and arranged the same way, and nothing here needs its
 * own screen.
 *
 * What this answers, which nothing did before: how much each department is
 * spending, what Purchasing is handling, and where requests are sitting.
 */
import { Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { query } from '../../common/db';
import { Principal } from '../../common/auth';

const TZ = 'Africa/Cairo';

/** The keys this serves. Anything else is not ours. */
export const REQUEST_WIDGETS = [
  'req-kpi-raised',
  'req-kpi-open',
  'req-kpi-approved-value',
  'req-kpi-paid',
  'req-by-department',
  'req-spend-by-department',
  'req-over-time',
  'req-by-state',
  'req-by-type',
  'req-purchasing-queue',
  'req-purchasing-decided',
  'req-slowest',
] as const;

export type RequestWidgetKey = (typeof REQUEST_WIDGETS)[number];

export interface RequestRange { from: Date; to: Date; label: string }

@Injectable()
export class FinanceRequestWidgetsService {
  private readonly log = new Logger('FinanceWidgets');

  /**
   * Build one widget.
   *
   * The range is resolved by the caller, because every widget on a dashboard
   * shares it — and a widget that quietly used a different one would make
   * two numbers on the same screen disagree.
   */
  async build(key: string, range: RequestRange, p: Principal) {
    switch (key as RequestWidgetKey) {
      case 'req-kpi-raised': return this.raised(range);
      case 'req-kpi-open': return this.open(range);
      case 'req-kpi-approved-value': return this.approvedValue(range);
      case 'req-kpi-paid': return this.paid(range);
      case 'req-by-department': return this.byDepartment(range);
      case 'req-spend-by-department': return this.spendByDepartment(range);
      case 'req-over-time': return this.overTime(range);
      case 'req-by-state': return this.byState(range);
      case 'req-by-type': return this.byType(range);
      case 'req-purchasing-queue': return this.purchasingQueue(range);
      case 'req-purchasing-decided': return this.purchasingDecided(range);
      case 'req-slowest': return this.slowest(range);
      default: return null;
    }
  }

  /* ------------------------------------------------------------ KPIs -- */

  private async raised(r: RequestRange) {
    const [row] = await query<any>(
      `SELECT count(*)::int AS n, COALESCE(sum(requested_amount), 0) AS total
         FROM fin_requests
        WHERE deleted_at IS NULL AND created_at >= $1 AND created_at < $2`,
      [r.from, r.to]);

    return {
      kind: 'kpi' as const,
      value: Number(row?.n ?? 0),
      format: 'integer' as const,
      sub: `${money(row?.total)} asked for`,
    };
  }

  /**
   * Still waiting on somebody.
   *
   * Counted as it stands now, not within the range: "how many are open" is a
   * question about today, and answering it for last month would be a number
   * nobody can act on.
   */
  private async open(_r: RequestRange) {
    const [row] = await query<any>(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE approval_state = 'MANAGER_PENDING')::int AS mgr,
              count(*) FILTER (WHERE approval_state = 'PURCHASES_PENDING')::int AS pur,
              count(*) FILTER (WHERE approval_state = 'FINANCE_PENDING')::int AS fin
         FROM fin_requests
        WHERE deleted_at IS NULL
          AND approval_state IN ('MANAGER_PENDING','PURCHASES_PENDING','FINANCE_PENDING')`);

    return {
      kind: 'kpi' as const,
      value: Number(row?.n ?? 0),
      format: 'integer' as const,
      sub: `${row?.mgr ?? 0} with managers · ${row?.pur ?? 0} with purchasing`
        + ` · ${row?.fin ?? 0} with finance`,
      note: 'as things stand now, not within the range',
    };
  }

  private async approvedValue(r: RequestRange) {
    const [row] = await query<any>(
      /* There is no separate approved amount: what Finance approves is the
         amount on the request, re-priced by Purchasing where that applies. */
      `SELECT count(*)::int AS n, COALESCE(sum(requested_amount), 0) AS total
         FROM fin_requests
        WHERE deleted_at IS NULL AND approval_state = 'APPROVED'
          AND finance_decided_at >= $1 AND finance_decided_at < $2`,
      [r.from, r.to]);

    return {
      kind: 'kpi' as const,
      value: Number(row?.total ?? 0),
      format: 'currency' as const,
      sub: `across ${row?.n ?? 0} request${Number(row?.n) === 1 ? '' : 's'}`,
    };
  }

  /**
   * Money that actually went out.
   *
   * From payments, not from approved amounts. An approval is a decision; a
   * payment is the money leaving, and the two differ — part-payments, and
   * approvals that are never paid at all.
   */
  private async paid(r: RequestRange) {
    const [row] = await query<any>(
      `SELECT count(*)::int AS n, COALESCE(sum(amount), 0) AS total
         FROM fin_payments
        WHERE reversal_of_id IS NULL AND paid_at >= $1 AND paid_at < $2`,
      [r.from, r.to]);

    return {
      kind: 'kpi' as const,
      value: Number(row?.total ?? 0),
      format: 'currency' as const,
      sub: `${row?.n ?? 0} payment${Number(row?.n) === 1 ? '' : 's'}`,
    };
  }

  /* ----------------------------------------------------------- charts -- */

  private async byDepartment(r: RequestRange) {
    const rows = await query<any>(
      `SELECT d.name AS label, count(*)::int AS value
         FROM fin_requests f
         JOIN core_departments d ON d.id = f.department_id
        WHERE f.deleted_at IS NULL AND f.created_at >= $1 AND f.created_at < $2
        GROUP BY d.name ORDER BY value DESC`, [r.from, r.to]);

    return { kind: 'bar' as const, format: 'integer' as const, items: rows };
  }

  /** What each department actually spent — paid, not asked for. */
  private async spendByDepartment(r: RequestRange) {
    const rows = await query<any>(
      `SELECT d.name AS label, COALESCE(sum(pm.amount), 0)::numeric AS value
         FROM fin_payments pm
         JOIN fin_requests f ON f.id = pm.request_id
         JOIN core_departments d ON d.id = f.department_id
        WHERE pm.reversal_of_id IS NULL
          AND pm.paid_at >= $1 AND pm.paid_at < $2
        GROUP BY d.name
       HAVING sum(pm.amount) > 0
        ORDER BY value DESC`, [r.from, r.to]);

    return {
      kind: 'bar' as const,
      format: 'currency' as const,
      items: rows.map((x) => ({ label: x.label, value: Number(x.value) })),
    };
  }

  /**
   * Raised and paid, day by day.
   *
   * Two series because the gap between them is the thing worth seeing: a
   * week of requests with no payments is a queue building up.
   */
  private async overTime(r: RequestRange) {
    const grain = dayCount(r) > 62 ? 'week' : 'day';

    const raised = await query<any>(
      `SELECT date_trunc($3, created_at AT TIME ZONE $4)::date AS t,
              count(*)::int AS v
         FROM fin_requests
        WHERE deleted_at IS NULL AND created_at >= $1 AND created_at < $2
        GROUP BY 1 ORDER BY 1`, [r.from, r.to, grain, TZ]);

    const paid = await query<any>(
      `SELECT date_trunc($3, paid_at AT TIME ZONE $4)::date AS t,
              count(*)::int AS v
         FROM fin_payments
        WHERE reversal_of_id IS NULL AND paid_at >= $1 AND paid_at < $2
        GROUP BY 1 ORDER BY 1`, [r.from, r.to, grain, TZ]);

    /* Every bucket in the range, including the quiet ones — dropping them
       would make a slow fortnight look like a missing one. */
    const buckets = this.buckets(r, grain);
    const at = (rows: any[]) => {
      const m = new Map(rows.map((x) => [iso(x.t), Number(x.v)]));
      return buckets.map((t) => ({ t, v: m.get(t) ?? 0 }));
    };

    return {
      kind: 'line' as const,
      format: 'integer' as const,
      timezone: TZ,
      series: [
        { key: 'raised', label: 'Raised', points: at(raised) },
        { key: 'paid', label: 'Paid', points: at(paid) },
      ],
    };
  }

  private async byState(_r: RequestRange) {
    const rows = await query<any>(
      `SELECT approval_state AS label, count(*)::int AS value
         FROM fin_requests
        WHERE deleted_at IS NULL
          AND approval_state IN ('MANAGER_PENDING','PURCHASES_PENDING','FINANCE_PENDING')
        GROUP BY 1 ORDER BY value DESC`);

    return {
      kind: 'donut' as const,
      format: 'integer' as const,
      items: rows.map((x) => ({ label: readable(x.label), value: x.value })),
    };
  }

  private async byType(r: RequestRange) {
    const rows = await query<any>(
      `SELECT type AS label, count(*)::int AS value
         FROM fin_requests
        WHERE deleted_at IS NULL AND created_at >= $1 AND created_at < $2
        GROUP BY 1 ORDER BY value DESC`, [r.from, r.to]);

    return { kind: 'bar' as const, format: 'integer' as const, items: rows };
  }

  /* ------------------------------------------------------ purchasing -- */

  /**
   * What Purchasing is holding right now.
   *
   * The Finance manager's question, and one the module could not answer:
   * how much is sitting with Purchasing, how long it has been there, and
   * what it is worth.
   */
  private async purchasingQueue(_r: RequestRange) {
    const rows = await query<any>(
      `SELECT f.reference, f.description, f.requested_amount,
              d.name AS department,
              u.full_name AS requester,
              f.created_at,
              EXTRACT(DAY FROM now() - f.created_at)::int AS waiting_days
         FROM fin_requests f
         JOIN core_departments d ON d.id = f.department_id
         JOIN core_users u ON u.id = f.requester_id
        WHERE f.deleted_at IS NULL AND f.approval_state = 'PURCHASES_PENDING'
        ORDER BY f.created_at`);

    return {
      kind: 'table' as const,
      columns: [
        { key: 'reference', label: 'Reference', format: 'text' as const },
        { key: 'department', label: 'Department', format: 'text' as const },
        { key: 'requester', label: 'Raised by', format: 'text' as const },
        { key: 'requested_amount', label: 'Asked for', format: 'currency' as const,
          align: 'end' as const },
        { key: 'waiting_days', label: 'Days waiting', format: 'integer' as const,
          align: 'end' as const },
      ],
      rows: rows.map((x) => ({
        ...x, requested_amount: Number(x.requested_amount),
      })),
      total: rows.reduce((n, x) => n + Number(x.requested_amount), 0),
    };
  }

  /**
   * What Purchasing decided, and what it cost.
   *
   * Approved against rejected, and the money that followed — the coverage
   * the Finance manager was missing.
   */
  private async purchasingDecided(r: RequestRange) {
    const [row] = await query<any>(
      `SELECT
         count(*) FILTER (WHERE approval_state <> 'REJECTED')::int AS approved,
         count(*) FILTER (WHERE approval_state = 'REJECTED')::int AS rejected,
         COALESCE(sum(requested_amount)
           FILTER (WHERE approval_state <> 'REJECTED'), 0) AS approved_value
         FROM fin_requests
        WHERE deleted_at IS NULL AND route = 'purchases'
          AND purchases_decided_at >= $1 AND purchases_decided_at < $2`,
      [r.from, r.to]);

    const paid = await query<any>(
      `SELECT COALESCE(sum(pm.amount), 0) AS total
         FROM fin_payments pm
         JOIN fin_requests f ON f.id = pm.request_id
        WHERE pm.reversal_of_id IS NULL AND f.route = 'purchases'
          AND pm.paid_at >= $1 AND pm.paid_at < $2`, [r.from, r.to]);

    return {
      kind: 'table' as const,
      columns: [
        { key: 'label', label: 'Purchasing', format: 'text' as const },
        { key: 'value', label: '', format: 'text' as const, align: 'end' as const },
      ],
      rows: [
        { label: 'Approved', value: String(row?.approved ?? 0) },
        { label: 'Rejected', value: String(row?.rejected ?? 0) },
        { label: 'Approved value', value: money(row?.approved_value) },
        { label: 'Paid out', value: money(paid[0]?.total) },
      ],
    };
  }

  /**
   * The ones that have waited longest.
   *
   * Open requests only, oldest first — a list to act on rather than a
   * statistic about how long things take on average.
   */
  private async slowest(_r: RequestRange) {
    const rows = await query<any>(
      `SELECT f.reference, d.name AS department, f.approval_state,
              f.requested_amount,
              EXTRACT(DAY FROM now() - f.created_at)::int AS waiting_days
         FROM fin_requests f
         JOIN core_departments d ON d.id = f.department_id
        WHERE f.deleted_at IS NULL
          AND f.approval_state IN
              ('MANAGER_PENDING','PURCHASES_PENDING','FINANCE_PENDING')
        ORDER BY f.created_at
        LIMIT 15`);

    return {
      kind: 'table' as const,
      columns: [
        { key: 'reference', label: 'Reference', format: 'text' as const },
        { key: 'department', label: 'Department', format: 'text' as const },
        { key: 'approval_state', label: 'Waiting on', format: 'text' as const },
        { key: 'waiting_days', label: 'Days', format: 'integer' as const,
          align: 'end' as const },
      ],
      rows: rows.map((x) => ({
        ...x,
        approval_state: readable(x.approval_state),
        requested_amount: Number(x.requested_amount),
      })),
    };
  }

  /* --------------------------------------------------------- helpers -- */

  private buckets(r: RequestRange, grain: 'day' | 'week'): string[] {
    const out: string[] = [];
    let d = DateTime.fromJSDate(r.from, { zone: TZ }).startOf(grain);
    const end = DateTime.fromJSDate(r.to, { zone: TZ });
    while (d < end) {
      out.push(d.toISODate()!);
      d = d.plus(grain === 'day' ? { days: 1 } : { weeks: 1 });
    }
    return out;
  }
}

function dayCount(r: RequestRange): number {
  return Math.max(1, Math.round((r.to.getTime() - r.from.getTime()) / 86_400_000));
}

function iso(v: any): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

function money(v: any): string {
  return `${Number(v ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} EGP`;
}

/** `PURCHASES_PENDING` reads badly on a dashboard. */
function readable(state: string): string {
  switch (state) {
    case 'MANAGER_PENDING': return 'Manager';
    case 'PURCHASES_PENDING': return 'Purchasing';
    case 'FINANCE_PENDING': return 'Finance';
    case 'APPROVED': return 'Approved';
    case 'REJECTED': return 'Rejected';
    default: return state;
  }
}