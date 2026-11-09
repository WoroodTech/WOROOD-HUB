/**
 * Handing the gateway references to the accountant.
 *
 * Incremental by design: the first export covers everything from the first of
 * November, and each one after it starts where the last stopped. A reference
 * is handed over once, and none is skipped — which is the whole point, since
 * the person on the other end is matching these against a settlement
 * statement line by line.
 */
import { Injectable, Logger } from '@nestjs/common';
import { one, query } from '../../../common/db';
import { Principal } from '../../../common/auth';
import { AuditService } from '../../../core/core.module';

/**
 * Where the first export begins.
 *
 * Finance has the earlier months already, reconciled by hand, so starting
 * from scratch would hand back thousands of rows somebody has already dealt
 * with. The first of November is where the portal's own record begins to be
 * the one they use.
 */
const FIRST_EXPORT_FROM = '2026-11-01T00:00:00+02:00';

export interface ExportRow {
  orderName: string;
  orderedAt: string;
  paymentId: string | null;
  authorization: string | null;
  gateway: string | null;
  total: number;
  currency: string;
  financialStatus: string | null;
}

@Injectable()
export class PaymentExportService {
  private readonly log = new Logger('PaymentExport');

  constructor(private readonly audit: AuditService) {}

  /** What the next export would cover, for the button to say so. */
  async preview() {
    const from = await this.nextFrom();
    const row = await one<any>(
      `SELECT count(*) AS n FROM sd_orders
        WHERE deleted_at IS NULL AND NOT test
          AND shopify_created_at >= $1`, [from]);
    const last = await one<any>(
      `SELECT exported_at, rows FROM sd_payment_exports
        ORDER BY exported_at DESC LIMIT 1`);

    return {
      from,
      waiting: Number(row?.n ?? 0),
      lastExportAt: last?.exported_at ?? null,
      lastExportRows: last ? Number(last.rows) : null,
    };
  }

  /**
   * The orders to hand over, and the mark that moves the boundary.
   *
   * The window closes at the moment the export is taken rather than at "now"
   * when each row is read: an order created while the query runs would
   * otherwise fall between this export's end and the next one's start, and
   * nothing would ever pick it up.
   */
  async take(p: Principal, format: 'csv' | 'pdf') {
    const from = await this.nextFrom();
    const to = new Date();

    const rows = await query<any>(
      `SELECT o.name, o.shopify_created_at, o.payment_id, o.payment_authorization,
              o.payment_gateway, o.total_price, o.currency_code, o.financial_status
         FROM sd_orders o
        WHERE o.deleted_at IS NULL AND NOT o.test
          AND o.shopify_created_at >= $1
          AND o.shopify_created_at < $2
        ORDER BY o.shopify_created_at`,
      [from, to]);

    const out: ExportRow[] = rows.map((r) => ({
      orderName: r.name,
      orderedAt: new Date(r.shopify_created_at).toISOString(),
      paymentId: r.payment_id,
      authorization: r.payment_authorization,
      gateway: r.payment_gateway,
      total: Number(r.total_price),
      currency: r.currency_code,
      financialStatus: r.financial_status,
    }));

    /*
     * The mark is written even when the export is empty.
     *
     * Otherwise an export taken on a quiet morning leaves the boundary where
     * it was, and the next one re-reads a window somebody has already seen
     * was empty. Recording it costs a row and keeps the sequence honest.
     */
    await query(
      `INSERT INTO sd_payment_exports (exported_by, covers_from, covers_to, rows, format)
       VALUES ($1,$2,$3,$4,$5)`,
      [p.id, from, to, out.length, format]);

    await this.audit.write({
      actorId: p.id, moduleKey: 'sales-dashboard', action: 'sales.payment.export',
      entityType: 'payment_export', entityId: `${out.length} orders`,
      payload: { from, to: to.toISOString(), rows: out.length, format },
    });

    return { rows: out, from, to: to.toISOString() };
  }

  /**
   * Where this export starts.
   *
   * The end of the last one, or the first of November if there has not been
   * one. Taken from the stored `covers_to` rather than recomputed, so a later
   * change to the starting date cannot move a boundary that has already been
   * handed over.
   */
  private async nextFrom(): Promise<string> {
    const last = await one<any>(
      `SELECT covers_to FROM sd_payment_exports ORDER BY exported_at DESC LIMIT 1`);
    return last ? new Date(last.covers_to).toISOString() : FIRST_EXPORT_FROM;
  }

  /**
   * The file.
   *
   * CSV rather than anything cleverer: it opens in the spreadsheet the
   * accountant already reconciles in, and a reference pasted from it is the
   * reference, with no formatting in the way.
   */
  toCsv(rows: ExportRow[]): string {
    const cell = (v: any) => {
      const s = v === null || v === undefined ? '' : String(v);
      /* Quoted whenever it could be misread — and a leading quote on every
         reference, because a spreadsheet otherwise turns something like
         0012345 into a number and loses the zeros. */
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const header = ['Order', 'Ordered at', 'Payment ID', 'Authorization',
                    'Gateway', 'Total', 'Currency', 'Status'];

    const lines = rows.map((r) => [
      cell(r.orderName),
      cell(r.orderedAt.slice(0, 10)),
      /* Prefixed with a tab so Excel keeps it as text: a reference like
         c148977776.1 is otherwise read as a number and rounded. */
      r.paymentId ? cell(`\t${r.paymentId}`) : '',
      r.authorization ? cell(`\t${r.authorization}`) : '',
      cell(r.gateway ?? ''),
      cell(r.total.toFixed(2)),
      cell(r.currency),
      cell(r.financialStatus ?? ''),
    ].join(','));

    /* A BOM, so Excel opens it as UTF-8 rather than mangling anything
       non-ASCII in a gateway name. */
    return '\uFEFF' + [header.join(','), ...lines].join('\r\n');
  }
}