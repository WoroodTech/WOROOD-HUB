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
  /**
   * The last suggestion for each vendor, briefly.
   *
   * The form asks for this on every render, and the answer cannot change
   * between two of them — nobody raises a purchase order in the seconds
   * while somebody else is filling one in. Two minutes is long enough to
   * cost nothing and short enough that a second person does not get a
   * number that has just been used.
   */
  /* One suggestion for the whole organisation: the series is Zoho's, not
     each supplier's. */
  private numberCache: { at: number; reference: string } | null = null;

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
  /**
   * The next purchase-order number.
   *
   * `purchaseorder_number` — the `WoR-PO-00292` on the order itself — and
   * organisation-wide, because that is the series Zoho keeps.
   *
   * Two things were wrong before. It read `reference_number`, which is the
   * separate Reference# field: usually empty, sometimes carrying the
   * supplier's own numbering, and never ours. And it narrowed to one vendor,
   * which would restart the count for every supplier when the series runs
   * across all of them.
   *
   * `created_time` rather than `date`: the order date can be backdated, and
   * the newest order is the one most recently made.
   */
  async nextPurchaseOrderNumber(p: Principal): Promise<{ reference: string }> {
    if (!can(p, PURCHASES) && !can(p, MANAGE)) {
      throw new ForbiddenException('You cannot see purchase order numbers.');
    }

    /* The form asks on every render and the answer cannot change between
       two of them. Cleared when an order is created, so the next person
       does not get a number that has just been used. */
    if (this.numberCache && Date.now() - this.numberCache.at < 120_000) {
      return { reference: this.numberCache.reference };
    }

    const res = await this.books.call('GET', '/purchaseorders', {
      query: {
        sort_column: 'created_time',
        sort_order: 'D',
        /* One page. `listAll` walks twenty-five, and between them and this
           being called on every render they spent the organisation's daily
           API allowance — which is what the "exceeded the maximum call rate
           limit" error was. */
        per_page: '25',
      },
    });

    const numbers = (res?.purchaseorders ?? [])
      .map((o: any) => o.purchaseorder_number)
      .filter(Boolean);

    const reference = PurchaseOrdersService.nextReference(numbers);
    this.numberCache = { at: Date.now(), reference };
    return { reference };
  }

  /** The old name, kept so existing callers keep working. */
  async suggestReference(p: Principal, _vendorId?: string) {
    return this.nextPurchaseOrderNumber(p);
  }

  /** Suppliers, from the cache. */
  /**
   * The supplier list.
   *
   * Readable by anybody who can decide a request, not only Purchasing:
   * Finance names a supplier when it pays one directly, and the route
   * already allows them. Gating this with `assertPurchases` meant Finance
   * passed the route guard and was refused inside — an empty list with no
   * error, which looks like no suppliers rather than no permission.
   *
   * Reading the list is not committing to an order; raising one still is.
   */
  async vendors(p: Principal) {
    if (!can(p, PURCHASES) && !can(p, MANAGE)) {
      throw new ForbiddenException('You cannot see the supplier list.');
    }
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

    /*
     * `contact_type` alone, and the activity check done here.
     *
     * Zoho's `filter_by` on contacts is one parameter covering two different
     * things: a category (Status.Customers, Status.Vendors) or a level of
     * activity (Status.Active, Status.Inactive). Sending `contact_type=vendor`
     * together with `filter_by=Status.Active` asked it to narrow by category
     * and by activity at once, and it answered with nothing — which this
     * method then reported as "Zoho returned no suppliers at all".
     *
     * Asking only for vendors and dropping the inactive ones here does not
     * depend on how those two interact.
     */
    let all: any[];
    try {
      all = await this.books.listAll('/contacts', 'contacts',
        { contact_type: 'vendor' });
    } catch (e: any) {
      /*
       * Zoho said no, and what it said is the whole answer.
       *
       * A `ZohoError` carries the status and the message Zoho sent — an
       * expired token, a missing scope, the wrong organisation. Left to
       * escape, it arrives as a bare 500 saying "Something went wrong", and
       * the only way to learn any of that is to read the server logs.
       */
      this.log.error(`vendor sync: ${e?.status ?? ''} ${e?.message ?? e}`);
      throw new BadRequestException(
        `Zoho refused the request for suppliers: ${e?.message ?? e}`);
    }

    /* `status` is 'active' or 'inactive'; anything else is a shape we do not
       know, and dropping a supplier because of an unexpected value would be
       worse than keeping one that is dormant. */
    const contacts = all.filter((c: any) => c?.status !== 'inactive');

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
      /*
       * A BadRequest, not a bare Error.
       *
       * A bare one leaves the handler with nothing to say and the caller gets
       * `{"status":500,"message":"Something went wrong"}` — which is how this
       * failure looked for as long as it took somebody to read the logs. The
       * message below is the useful part, and it should reach whoever pressed
       * the button.
       */
      throw new BadRequestException(
        `Zoho returned no suppliers. ${all.length} contact(s) came back for `
        + 'contact_type=vendor, and none survived the active check. '
        + 'GET /api/v1/finance/zoho/diagnose shows what each endpoint answered.');
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
    /* What the request was priced at, when the approval has not been
       recorded yet and the row still carries the old figure. */
    expectedTotal?: number;
  }) {
    this.assertPurchases(p);

    const r = await one<any>(
      `SELECT * FROM fin_requests WHERE id=$1 AND deleted_at IS NULL`, [requestId]);
    if (!r) throw new NotFoundException('No such request.');
    /*
     * Any request Purchasing is handling, not one type of it.
     *
     * This used to allow only `Vendors Payments`, which is the type Finance
     * uses when it pays a supplier directly. A request routed to Purchasing
     * is a different thing — Purchasing sources it, prices it, and raises
     * the order — and those were refused outright, which is why no purchase
     * order from Purchasing ever reached Zoho.
     *
     * What matters is where the request is, not what it was called.
     */
    const atPurchasing = r.approval_state === 'PURCHASES_PENDING'
      || r.route === 'purchases';
    if (!atPurchasing && r.type !== 'Vendors Payments') {
      throw new BadRequestException(
        'A purchase order belongs to a request Purchasing is handling, or to '
        + 'a vendor payment.');
    }

    const lines = (dto.lines ?? []).filter((l) => l?.name?.trim() && l.quantity > 0);
    if (!lines.length) throw new BadRequestException('Add at least one line.');
    if (lines.length > MAX_LINES) {
      throw new BadRequestException(`A purchase order can carry up to ${MAX_LINES} lines.`);
    }

    /*
     * One raiser at a time, for this request.
     *
     * Two Approve presses landing together would both read no existing order
     * and both create one in Zoho — two orders for one request, and a
     * payment that cannot say which it is an advance against. Held to the
     * end of the statement, and free when uncontended.
     */
    await query(`SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`fin-po:${requestId}`]);

    const existing = await one<any>(
      `SELECT id, status FROM fin_purchase_orders WHERE request_id=$1`, [requestId]);
    if (existing && existing.status === 'DRAFTED') {
      throw new BadRequestException('This request already has a purchase order.');
    }

    /*
     * No reference of ours.
     *
     * Zoho assigns the purchase-order number when it creates the order, and
     * that number is the reference. Asking for a suggestion here and sending
     * it was a second numbering alongside Zoho's own — and a wasted API call
     * on every approval.
     */
    this.numberCache = null;

    /*
     * Added as hundredths.
     *
     * 0.1 × 3 is 0.30000000000000004 in floating point, and this figure is
     * compared against the amount the request was priced at a few lines
     * below. A comparison that fails by a ten-thousandth of a piastre would
     * refuse a correct order.
     */
    const total = Math.round(
      lines.reduce((n, l) =>
        n + Math.round(l.quantity * 100) * Math.round(l.rate * 100), 0) / 100) / 100;

    /*
     * The order has to come to what the request was priced at.
     *
     * Finance approves a figure and pays it; an order for a different one
     * leaves the supplier owed something nobody approved, and the
     * difference only surfaces when the bill arrives. Checked here as well
     * as on the form, because the form is a convenience and this is the
     * rule.
     *
     * A pound either way is rounding on a line rate.
     */
    const priced = Number(dto.expectedTotal ?? r.requested_amount ?? 0);
    if (priced > 0 && Math.abs(total - priced) > 1) {
      throw new BadRequestException(
        `The lines come to ${total.toFixed(2)} and the request was priced at `
        + `${priced.toFixed(2)}. Put the lines right, or re-price the request `
        + 'first — an order for a different figure is money nobody approved.');
    }

    const row = existing
      ? await one<any>(
          `UPDATE fin_purchase_orders
              SET vendor_zoho_id=$2, vendor_name=$3, reference=$4, lines=$5,
                  total=$6, status='PENDING', error=NULL
            WHERE id=$1 RETURNING *`,
          /* Null until Zoho answers: the number is Zoho's to assign, and
             writing a guess here would be a reference nothing matches. */
          [existing.id, dto.vendorId, dto.vendorName, null,
           JSON.stringify(lines), total])
      : await one<any>(
          `INSERT INTO fin_purchase_orders
             (request_id, vendor_zoho_id, vendor_name, reference, lines, total,
              created_by_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [requestId, dto.vendorId, dto.vendorName, null,
           JSON.stringify(lines), total, p.id]);

    /*
     * A purchase account for the lines.
     *
     * Zoho refuses a purchase order whose line is not a stock item it knows
     * — "Purchase order cannot be created for a non-purchase item". These
     * lines are free text — a description and a price — not catalogue items,
     * so each is booked against an account instead. That is what an
     * account-based line is, and how a service or a one-off purchase goes on
     * an order without first being invented as an item.
     *
     * One expense account for the lot, chosen by name so it is stable rather
     * than depending on row order. If none is synced the order goes out
     * without one and Zoho decides — no worse than before, which is where
     * this was failing.
     */
    const purchaseAccount = await one<any>(
      `SELECT account_id FROM fin_zoho_accounts
        WHERE active AND is_expense ORDER BY account_name LIMIT 1`);
    const accountId: string | null = purchaseAccount?.account_id ?? null;

    try {
      const out = await this.books.call('POST', '/purchaseorders', {
        body: {
          vendor_id: dto.vendorId,
          /*
           * No `reference_number`.
           *
           * That field is the *supplier's* reference on the order, and
           * filling it with our next number put our numbering in a box
           * meant for theirs — while Zoho assigned the real
           * purchase-order number anyway. Zoho numbers it; we read the
           * number back below.
           */
          /* Draft, always. Approving a purchase order is a decision taken in
             Zoho, where that approval chain lives. */
          status: 'draft',
          line_items: lines.map((l) => ({
            name: l.name.slice(0, 200),
            quantity: l.quantity,
            rate: l.rate,
            /* Books the line against an account rather than a stock item,
               which is what lets a free-text line onto the order at all. */
            ...(accountId ? { account_id: accountId } : {}),
          })),
        },
      });

      const poId = out?.purchaseorder?.purchaseorder_id ?? out?.purchaseorder_id ?? null;
      if (!poId) throw new Error('Zoho accepted the order but returned no id');

      /* The number Zoho assigned — `WoR-PO-00292` — which is the reference
         the supplier and the accounts both work from. */
      const zohoNumber = out?.purchaseorder?.purchaseorder_number
        ?? out?.purchaseorder_number ?? null;

      await query(
        `UPDATE fin_purchase_orders
            SET status='DRAFTED', zoho_po_id=$2, zoho_po_number=$3,
                reference=$3, posted_at=now()
          WHERE id=$1`,
        [row.id, String(poId), zohoNumber]);

      /* The payment that goes out later carries this reference, which is what
         lets the two be matched in Zoho. */
      await query(
        `UPDATE fin_requests SET purchase_order_reference=$2, vendor_name=$3,
                                 vendor_zoho_id=$4 WHERE id=$1`,
        /* Zoho's own number, read back from its answer — the reference the
           supplier and the accounts both see. */
        [requestId, zohoNumber || null, dto.vendorName, dto.vendorId]);

      return this.view({ ...row, status: 'DRAFTED', zoho_po_id: poId });
    } catch (e: any) {
      /* Recorded as failed rather than thrown away, so the lines somebody
         typed survive and the attempt can be repeated without retyping them.
         The legacy app loses the form on a failure. */
      const text = String(e?.message ?? e);
      await query(
        `UPDATE fin_purchase_orders SET status='FAILED', error=$2 WHERE id=$1`,
        [row.id, text.slice(0, 2000)]);

      /*
       * A quota is not a refusal.
       *
       * "Zoho would not create the purchase order" reads as something wrong
       * with the order — the wrong vendor, a bad line — and sends somebody
       * to check all of it. The organisation having spent its daily calls
       * is a different thing entirely, and the order is fine: it needs
       * trying again, not fixing.
       */
      if (/rate limit|exceeded the maximum/i.test(text)) {
        throw new BadRequestException(
          'Zoho has had all the API calls it allows today, so this could not '
          + 'be sent. Nothing is wrong with the order — try again tomorrow, '
          + 'or ask whoever administers Zoho about the limit.');
      }

      throw new BadRequestException(
        `Zoho would not create the purchase order: ${text}`);
    }
  }

  /**
   * Mark the order as received, moving it from Draft to Open in Zoho.
   *
   * Purchasing's confirmation that the goods are on their way. In Zoho a
   * draft order is a working copy; issuing it ("Mark as open") is what makes
   * it a real order the vendor is held to. The portal calls this "received"
   * because that is the event it stands for at the desk.
   *
   * Does not create a bill and does not close the order: issuing is as far
   * as this goes, and the rest — billing, paying, closing — Finance does in
   * Zoho. Idempotent: an order already issued is left alone rather than
   * poked again.
   */
  async markReceived(p: Principal, requestId: string) {
    this.assertPurchases(p);

    const po = await one<any>(
      `SELECT * FROM fin_purchase_orders WHERE request_id=$1`, [requestId]);
    if (!po) throw new NotFoundException('No purchase order on this request.');
    if (po.status !== 'DRAFTED' || !po.zoho_po_id) {
      throw new BadRequestException(
        'The order is not in Zoho yet, so it cannot be marked as received.');
    }
    if (po.issued_at) return this.view(po);  // already done

    try {
      /* Zoho's own path for Draft → Open. No body; the id and the
         organisation are the whole request. */
      await this.books.call(
        'POST', `/purchaseorders/${po.zoho_po_id}/status/open`, {});
    } catch (e: any) {
      const text = String(e?.message ?? e);
      /* Already open in Zoho — somebody issued it there directly. Not an
         error: the state we wanted is the state it is in. */
      if (!/already|cannot be marked|open/i.test(text)) {
        throw new BadRequestException(
          `Zoho would not mark the order as received: ${text}`);
      }
    }

    const updated = await one<any>(
      `UPDATE fin_purchase_orders
          SET issued_at=now(), issued_by_id=$2
        WHERE id=$1 RETURNING *`, [po.id, p.id]);
    this.log.log(`${po.zoho_po_number ?? po.id} marked received by ${p.id}`);
    return this.view(updated);
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
      /* So the button knows it has been pressed, and the page can show the
         order as issued rather than draft. */
      issuedAt: row.issued_at ? new Date(row.issued_at).toISOString() : null,
      error: row.error,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    };
  }

  /**
   * Raising an order is Purchasing's step.
   *
   * They source the thing, price it, and commit to the supplier; Finance
   * pays against the order afterwards. `finance.request.manage` used to
   * pass here as well, which let Finance raise one — the wrong desk doing
   * the committing, and the reason this sat in the wrong place.
   */
  private assertPurchases(p: Principal) {
    if (!can(p, PURCHASES)) {
      throw new ForbiddenException(
        'Raising a purchase order is Purchasing\'s step. Finance records the '
        + 'payment against it afterwards.');
    }
  }
}