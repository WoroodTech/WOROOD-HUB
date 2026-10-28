/**
 * Draft purchase orders.
 *
 * When Purchases pays a supplier rather than handing out petty cash, a draft
 * purchase order goes into Zoho Books first and the payment is recorded as an
 * advance against it. The draft is what the supplier is shown and what the
 * accounts later match the money to.
 *
 * Draft, never approved: approving one is a decision for whoever runs the
 * accounts, taken in Zoho where purchase orders already have an approval chain
 * of their own. Nothing here approves anything.
 */
import {
  BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { Principal, can } from '../../../common/auth';
import { one, query } from '../../../common/db';
import { ZohoBooksClient } from './books-client';

const PURCHASES = 'finance.purchases.decide';
const MANAGE = 'finance.request.manage';

/** The legacy form's ceiling, and a sensible one. */
const MAX_LINES = 40;

export interface PurchaseOrderLine {
  name: string;
  quantity: number;
  rate: number;
}

@Injectable()
export class PurchaseOrdersService {
  private readonly log = new Logger('PurchaseOrders');

  constructor(private readonly books: ZohoBooksClient) {}

  /**
   * The supplier's next reference number.
   *
   * Taken from the supplier's own latest bill and incremented, preserving any
   * zero padding -- so a supplier numbering INV-0042 gets INV-0043 rather than
   * INV-43. Zero padding matters because it is the supplier's own sequence and
   * they will notice.
   *
   * Extracted as a pure function so the arithmetic can be checked without
   * calling Zoho; the legacy version is a line of regular expressions inside a
   * larger function and nobody could say with confidence what it did.
   */
  static nextReference(references: string[]): string {
    const numbered = references
      .map((s) => String(s ?? '').trim())
      .filter((s) => /\d+$/.test(s));
    if (!numbered.length) return '';

    /* The prefix of the first one decides the series. A supplier with two
       different numbering schemes is a question for a person, not something to
       guess at. */
    const first = /^(.*?)(\d+)$/.exec(numbered[0]);
    if (!first) return '';
    const prefix = first[1];

    let highest = -1;
    let width = 0;
    for (const s of numbered) {
      const m = /^(.*?)(\d+)$/.exec(s);
      if (!m || m[1] !== prefix) continue;
      const n = Number(m[2]);
      if (n > highest) { highest = n; width = m[2].length; }
    }
    if (highest < 0) return '';

    const next = String(highest + 1);
    return prefix + (next.length < width ? '0'.repeat(width - next.length) : '') + next;
  }

  /** Ask Zoho what this supplier's next reference should be. */
  async suggestReference(p: Principal, vendorId: string): Promise<{ reference: string }> {
    this.assertPurchases(p);
    const bills = await this.books.listAll('/bills', 'bills',
      { vendor_id: vendorId, sort_column: 'date', sort_order: 'D' });
    const refs = bills.map((b: any) => b.reference_number).filter(Boolean);
    return { reference: PurchaseOrdersService.nextReference(refs) };
  }

  /** Suppliers, from the cache. */
  async vendors(p: Principal) {
    this.assertPurchases(p);
    const rows = await query<any>(
      `SELECT vendor_id, vendor_name, company_name FROM fin_zoho_vendors
        WHERE active ORDER BY vendor_name`);
    return rows.map((v) => ({
      id: v.vendor_id, name: v.vendor_name, companyName: v.company_name,
    }));
  }

  /** Refresh the supplier cache. Read-only against Zoho. */
  async syncVendors(p: Principal) {
    if (!can(p, MANAGE)) throw new ForbiddenException('Only Finance can do that.');

    const contacts = await this.books.listAll('/contacts', 'contacts',
      { contact_type: 'vendor', filter_by: 'Status.Active' });

    const seen: string[] = [];
    for (const c of contacts) {
      await query(
        `INSERT INTO fin_zoho_vendors
           (vendor_id, vendor_name, company_name, email, active, synced_at)
         VALUES ($1,$2,$3,$4,true,now())
         ON CONFLICT (vendor_id) DO UPDATE SET
           vendor_name = EXCLUDED.vendor_name,
           company_name = EXCLUDED.company_name,
           email = EXCLUDED.email,
           active = true, synced_at = now()`,
        [c.contact_id, c.contact_name ?? c.company_name ?? 'Unnamed',
         c.company_name ?? null, c.email ?? null]);
      seen.push(c.contact_id);
    }
    if (seen.length) {
      await query(
        `UPDATE fin_zoho_vendors SET active = false
          WHERE active AND vendor_id <> ALL($1::text[])`, [seen]);
    }
    /* Same reasoning as the accounts: an organisation with suppliers always
       returns some, so none means the question was wrong rather than the
       answer being empty. */
    if (!seen.length) {
      throw new Error(
        'Zoho returned no suppliers at all. Run GET /api/v1/finance/zoho/diagnose '
        + 'to see what each endpoint actually answered.');
    }
    this.log.log(`synced ${seen.length} supplier(s)`);
    return { vendors: seen.length };
  }

  /**
   * Create the draft in Zoho and remember it.
   *
   * The reference is recomputed here even if the page sent one: the supplier's
   * own numbering has to stay continuous, and the page's copy is however old
   * the form has been open. The legacy app does the same, and for the same
   * reason.
   */
  async draft(p: Principal, requestId: string, dto: {
    vendorId: string; vendorName: string;
    lines: PurchaseOrderLine[]; reference?: string;
  }) {
    this.assertPurchases(p);

    const r = await one<any>(
      `SELECT * FROM fin_requests WHERE id=$1 AND deleted_at IS NULL`, [requestId]);
    if (!r) throw new NotFoundException('No such request.');
    if (r.type !== 'Vendors Payments') {
      throw new BadRequestException(
        'A purchase order is only for a vendor payment.');
    }

    const lines = (dto.lines ?? []).filter((l) => l?.name?.trim() && l.quantity > 0);
    if (!lines.length) throw new BadRequestException('Add at least one line.');
    if (lines.length > MAX_LINES) {
      throw new BadRequestException(`A purchase order can carry up to ${MAX_LINES} lines.`);
    }

    const existing = await one<any>(
      `SELECT id, status FROM fin_purchase_orders WHERE request_id=$1`, [requestId]);
    if (existing && existing.status === 'DRAFTED') {
      throw new BadRequestException('This request already has a purchase order.');
    }

    /* Zoho's answer wins over whatever the form is holding. */
    const suggested = await this.suggestReference(p, dto.vendorId)
      .then((x) => x.reference)
      .catch(() => '');
    const reference = suggested || dto.reference || '';

    const total = lines.reduce((n, l) => n + l.quantity * l.rate, 0);

    const row = existing
      ? await one<any>(
          `UPDATE fin_purchase_orders
              SET vendor_zoho_id=$2, vendor_name=$3, reference=$4, lines=$5,
                  total=$6, status='PENDING', error=NULL
            WHERE id=$1 RETURNING *`,
          [existing.id, dto.vendorId, dto.vendorName, reference,
           JSON.stringify(lines), total])
      : await one<any>(
          `INSERT INTO fin_purchase_orders
             (request_id, vendor_zoho_id, vendor_name, reference, lines, total,
              created_by_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [requestId, dto.vendorId, dto.vendorName, reference,
           JSON.stringify(lines), total, p.id]);

    try {
      const out = await this.books.call('POST', '/purchaseorders', {
        body: {
          vendor_id: dto.vendorId,
          reference_number: reference || undefined,
          /* Draft, always. Approving a purchase order is a decision taken in
             Zoho, where that approval chain lives. */
          status: 'draft',
          line_items: lines.map((l) => ({
            name: l.name.slice(0, 200),
            quantity: l.quantity,
            rate: l.rate,
          })),
        },
      });

      const poId = out?.purchaseorder?.purchaseorder_id ?? out?.purchaseorder_id ?? null;
      if (!poId) throw new Error('Zoho accepted the order but returned no id');

      await query(
        `UPDATE fin_purchase_orders
            SET status='DRAFTED', zoho_po_id=$2, zoho_po_number=$3, posted_at=now()
          WHERE id=$1`,
        [row.id, String(poId),
         out?.purchaseorder?.purchaseorder_number ?? null]);

      /* The payment that goes out later carries this reference, which is what
         lets the two be matched in Zoho. */
      await query(
        `UPDATE fin_requests SET purchase_order_reference=$2, vendor_name=$3,
                                 vendor_zoho_id=$4 WHERE id=$1`,
        [requestId, reference || null, dto.vendorName, dto.vendorId]);

      return this.view({ ...row, status: 'DRAFTED', zoho_po_id: poId });
    } catch (e: any) {
      /* Recorded as failed rather than thrown away, so the lines somebody
         typed survive and the attempt can be repeated without retyping them.
         The legacy app loses the form on a failure. */
      await query(
        `UPDATE fin_purchase_orders SET status='FAILED', error=$2 WHERE id=$1`,
        [row.id, String(e?.message ?? e).slice(0, 2000)]);
      throw new BadRequestException(
        `Zoho would not create the purchase order: ${e?.message ?? e}`);
    }
  }

  async forRequest(p: Principal, requestId: string) {
    const row = await one<any>(
      `SELECT * FROM fin_purchase_orders WHERE request_id=$1`, [requestId]);
    return row ? this.view(row) : null;
  }

  private view(row: any) {
    return {
      id: row.id,
      requestId: row.request_id,
      vendorId: row.vendor_zoho_id,
      vendorName: row.vendor_name,
      reference: row.reference,
      lines: row.lines ?? [],
      total: row.total === null || row.total === undefined ? null : Number(row.total),
      status: row.status,
      zohoPoId: row.zoho_po_id,
      zohoPoNumber: row.zoho_po_number,
      error: row.error,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    };
  }

  private assertPurchases(p: Principal) {
    if (!can(p, PURCHASES) && !can(p, MANAGE)) {
      throw new ForbiddenException('Only Purchases can work with purchase orders.');
    }
  }
}