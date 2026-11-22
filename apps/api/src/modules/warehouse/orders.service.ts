/**
 * New orders: a patch of Shopify orders, posted together.
 *
 * The warehouse keeper gets a printed sheet of orders from Shopify and books
 * them against one patch. So the unit here is the patch, not the movement:
 * a reference is typed, its items come back from `sd_orders`, another order
 * is added, and the whole patch is saved at the end.
 *
 * Two things are fixed and not asked for. Stock always leaves WH-02 —
 * nothing is sold from anywhere else — and the patch number is the next one
 * after the highest already in the ledger. Both were pickers in the first
 * pass, which meant somebody could type a patch that already existed or ship
 * from a warehouse that never sells.
 */
import {
  BadRequestException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import { query } from '../../common/db';
import { Principal } from '../../common/auth';
import { AuditService } from '../../core/core.module';
import { WarehouseSheetClient } from './sheets/warehouse-sheet.client';
import { WarehouseReaderService } from './sheets/warehouse-reader.service';
import { WarehouseQueueService } from './sheets/warehouse-queue.service';
import { TX, TX_TAB } from './sheets/tabs';
import { sheetDate } from './sheets/parse-date';

const TZ = 'Africa/Cairo';

/** Everything sold leaves from here. */
export const SELLING_WAREHOUSE = 'WH-02';

export interface OrderLine {
  item: string;
  quantity: number;
  /** What WH-02 holds, so the keeper sees it against what is being taken. */
  onHand?: number;
  /** Whether the catalogue knows this item at all. */
  known?: boolean;
}

export interface PatchOrder {
  reference: string;
  /** Local or Global, which decides which order column the row carries. */
  scope: 'local' | 'global';
  lines: OrderLine[];
}

@Injectable()
export class WarehouseOrdersService {
  private readonly log = new Logger('WarehouseOrders');

  constructor(
    private readonly sheet: WarehouseSheetClient,
    private readonly reader: WarehouseReaderService,
    private readonly queue: WarehouseQueueService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The next patch number.
   *
   * The highest in the ledger plus one. Read fresh every time rather than
   * cached: a cached number is a number two people can both be given, and
   * the whole point of issuing it here is that they cannot.
   */
  async nextPatch(kind = 'NEW ORDER'): Promise<string> {
    const rows = await this.sheet.read(TX_TAB);
    let highest = 0;
    let width = 0;
    const want = kind.trim().toLowerCase();

    for (let i = 1; i < rows.length; i++) {
      const patch = String(rows[i]?.[TX.patch] ?? '').trim();
      /* Plain numbers only: `R.O 007` is a receiving serial and belongs to
         a different sequence. */
      const m = patch.match(/^(\d+)$/);
      if (!m) continue;

      /*
       * And only this kind of transaction.
       *
       * The Apps Script keeps a sequence per kind — `nextPatch_(c, kind)`
       * takes the highest number whose patch has been used by that kind and
       * adds one. Taking the highest in the whole column instead handed a
       * New Order the number a Transfer or a Return had just used, so two
       * unrelated movements shared a patch and neither could be traced from
       * it. Receiving and Quality Check are separate again: they carry
       * `R.O …` and `Q.C …`, which the plain-number test already excludes.
       */
      if (String(rows[i]?.[TX.kind] ?? '').trim().toLowerCase() !== want) {
        continue;
      }

      const n = Number(m[1]);
      if (Number.isFinite(n) && n > highest) {
        highest = n;
        width = Math.max(width, m[1].length);
      }
    }

    const next = String(highest + 1);
    /* Keep the existing padding, if the sheet uses any. */
    return width > next.length ? next.padStart(width, '0') : next;
  }

  /**
   * One Shopify order, with its lines matched to the catalogue.
   *
   * This is the point of the whole screen: the keeper types a reference and
   * the items arrive, rather than being read off a printed sheet and typed
   * back in one at a time.
   *
   * Lines the catalogue does not know are returned anyway, marked. Hiding
   * them would mean an order that looks complete and is not.
   */
  async lookup(reference: string): Promise<PatchOrder & { found: true }> {
    const ref = String(reference ?? '').trim();
    if (!ref) throw new BadRequestException('Enter the order number.');

    /* Shopify order names carry a #; people type it either way. */
    const bare = ref.replace(/^#/, '');

    /* Only what the patch needs: the order's own id, the name to show, and
       the currency that decides its market. The shop was joined in for a
       `domain` column that does not exist on `sd_shops` — nothing read it,
       and every lookup failed on the join rather than on anything real. */
    const orders = await query<any>(
      `SELECT o.id, o.name, o.currency_code
         FROM sd_orders o
        WHERE o.name = $1 OR o.name = $2
        ORDER BY o.shopify_created_at DESC
        LIMIT 1`, [ref, `#${bare}`]);

    if (!orders.length) {
      throw new NotFoundException(
        `No order called ${ref}. Check the number on the sheet — it is the `
        + 'order name as Shopify shows it.');
    }

    const order = orders[0];

    const lines = await query<any>(
      `SELECT title, COALESCE(current_quantity, quantity) AS qty
         FROM sd_order_line_items
        WHERE order_id = $1
        ORDER BY title`, [order.id]);

    if (!lines.length) {
      throw new BadRequestException(
        `${order.name} has no line items — nothing to book against a patch.`);
    }

    /*
     * What the catalogue calls each item, and what WH-02 holds of it.
     *
     * Both read the spreadsheet, which is the one part of this that can fail
     * for reasons outside the portal — a revoked key, a rate limit, a tab
     * renamed. Caught here so the screen says which, rather than turning
     * every one of them into "Something went wrong" at the top level and
     * leaving the number that was typed looking like the problem.
     */
    let items: Awaited<ReturnType<typeof this.reader.items>>;
    let balances: Awaited<ReturnType<typeof this.reader.balances>>;
    try {
      [items, balances] = await Promise.all([
        this.reader.items(), this.reader.balances(),
      ]);
    } catch (e: any) {
      throw new BadRequestException(
        `${order.name} was found, but the warehouse sheet could not be read: `
        + `${e?.message ?? 'no reason given'}`);
    }

    const byName = new Map(
      items.map((i) => [loose(i.name), i.name]));

    const onHand = new Map<string, number>();
    for (const b of balances) {
      if (b.warehouse !== SELLING_WAREHOUSE) continue;
      onHand.set(loose(b.item), (onHand.get(loose(b.item)) ?? 0) + b.balance);
    }

    /*
     * The currency says which market, and which market says which order
     * column the ledger row carries — the sheet keeps local and global
     * order numbers apart.
     */
    const scope: 'local' | 'global' = order.currency_code === 'EGP'
      ? 'local' : 'global';

    return {
      found: true,
      reference: order.name,
      scope,
      lines: lines.map((l) => {
        const matched = byName.get(loose(l.title));
        return {
          item: matched ?? String(l.title ?? '').trim(),
          quantity: Number(l.qty) || 0,
          onHand: matched ? (onHand.get(loose(matched)) ?? 0) : 0,
          known: !!matched,
        };
      }),
    };
  }

  /**
   * Post a whole patch.
   *
   * Everything is checked before anything is queued. A patch half-posted is
   * worse than one refused: the orders are on one printed sheet, and the
   * keeper has no way to tell which half went in.
   */
  async postPatch(p: Principal, dto: { orders: PatchOrder[] }) {
    const orders = (dto?.orders ?? []).filter((o) => o?.reference);
    if (!orders.length) throw new BadRequestException('Add at least one order.');

    const patch = await this.nextPatch();

    /* No reference twice on one patch. */
    const seen = new Set<string>();
    for (const o of orders) {
      const key = o.reference.trim().toLowerCase();
      if (seen.has(key)) {
        throw new BadRequestException(`${o.reference} is on this patch twice.`);
      }
      seen.add(key);
    }

    /* Nor already in the ledger from an earlier patch. */
    for (const o of orders) {
      const dupe = await this.reader.alreadyPosted('order', o.reference, 'NEW ORDER');
      if (dupe) {
        throw new BadRequestException(
          `${o.reference} was already posted on ${dupe.date} by `
          + `${dupe.enteredBy || 'somebody'} (sheet row ${dupe.rowNumber}). `
          + 'Nothing on this patch was posted.');
      }
    }

    const items = await this.reader.items();
    const known = new Set(items.map((i) => loose(i.name)));
    const balances = await this.reader.balances();

    /* What WH-02 holds, counted down as the patch is checked — several
       orders on one patch can want the same item, and each one on its own
       might fit while together they do not. */
    const remaining = new Map<string, number>();
    for (const b of balances) {
      if (b.warehouse !== SELLING_WAREHOUSE) continue;
      remaining.set(loose(b.item), (remaining.get(loose(b.item)) ?? 0) + b.balance);
    }

    for (const o of orders) {
      for (const l of o.lines ?? []) {
        const item = String(l?.item ?? '').trim();
        const qty = Number(l?.quantity);

        if (!item) throw new BadRequestException(`${o.reference} has a line with no item.`);
        if (!Number.isInteger(qty) || qty < 1) {
          throw new BadRequestException(`${o.reference}: "${item}" needs a whole quantity of 1 or more.`);
        }
        if (!known.has(loose(item))) {
          throw new BadRequestException(
            `${o.reference}: "${item}" is not an item in the sheet. `
            + 'Create it first, or take the line off this patch.');
        }

        const have = remaining.get(loose(item)) ?? 0;
        if (qty > have) {
          throw new BadRequestException(
            `"${item}": ${SELLING_WAREHOUSE} has ${have} left once the rest of `
            + `this patch is taken, and ${o.reference} wants ${qty}.`);
        }
        remaining.set(loose(item), have - qty);
      }
    }

    /* Everything checks out; now it can be written. */
    const date = sheetDate(DateTime.now().setZone(TZ));
    const by = WarehouseSheetClient.safe(p.fullName ?? p.email ?? '');
    const events: string[] = [];

    for (const o of orders) {
      for (const l of o.lines) {
        const row = new Array(15).fill('');
        row[TX.date] = date;
        row[TX.itemName] = WarehouseSheetClient.safe(l.item);
        /* Local and global order numbers live in different columns. */
        if (o.scope === 'global') {
          row[TX.globalOrder] = WarehouseSheetClient.safe(o.reference);
        } else {
          row[TX.nationalOrder] = WarehouseSheetClient.safe(o.reference);
        }
        row[TX.patch] = patch;
        row[TX.stockOut] = l.quantity;
        row[TX.warehouse] = SELLING_WAREHOUSE;
        row[TX.kind] = 'NEW ORDER';
        row[TX.enteredBy] = by;

        events.push(await this.queue.enqueue('LEDGER_ROW', row));
      }
    }

    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.orders.patch',
      entityType: 'warehouse_patch', entityId: patch,
      payload: {
        orders: orders.length,
        rows: events.length,
        pieces: orders.reduce(
          (n, o) => n + o.lines.reduce((m, l) => m + l.quantity, 0), 0),
      },
    });

    await this.reader.invalidate();

    return {
      ok: true,
      patch,
      orders: orders.length,
      rows: events.length,
      pieces: orders.reduce(
        (n, o) => n + o.lines.reduce((m, l) => m + l.quantity, 0), 0),
    };
  }

  /**
   * The printable sheet for one patch.
   *
   * Orders only: transfers and quality checks on the same patch are left
   * out, which is what the Apps Script's own template does and for the same
   * reason — the paper is a list of what was sold, and a transfer on it
   * reads as another order.
   */
  async template(patch: string) {
    const name = String(patch ?? '').trim().replace(/^#/, '');
    if (!name) throw new BadRequestException('Which patch?');

    const rows = await this.sheet.read(TX_TAB);
    const items = await this.reader.items();
    const groupOf = new Map(items.map((i) => [loose(i.name), i.group || 'Other']));

    const lines: any[] = [];
    const orders = new Set<string>();
    let entered = '';
    let date: any = '';

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] ?? [];
      if (String(r[TX.patch] ?? '').trim() !== name) continue;

      const kind = String(r[TX.kind] ?? '').trim();
      if (kind === 'Transfer' || kind === 'Quality Check') continue;

      const item = String(r[TX.itemName] ?? '').trim();
      if (!item) continue;

      const out = Number(r[TX.stockOut]) || 0;
      const inQty = Number(r[TX.stockIn]) || 0;
      const qty = out || inQty;
      if (!qty) continue;

      const ref = String(r[TX.nationalOrder] ?? '').trim()
        || String(r[TX.globalOrder] ?? '').trim();
      if (ref) orders.add(ref);

      entered ||= String(r[TX.enteredBy] ?? '').trim();
      date ||= r[TX.date] ?? '';

      lines.push({
        item, order: ref, quantity: qty, kind,
        group: groupOf.get(loose(item)) ?? 'Other',
      });
    }

    if (!lines.length) {
      return { patch: name, found: false, groups: [], orders: 0, items: 0, total: 0 };
    }

    /* Grouped by collection, as the paper is read: the person picking walks
       the shelves by group, not by order. */
    const byGroup = new Map<string, any[]>();
    for (const l of lines) {
      const g = byGroup.get(l.group) ?? [];
      g.push(l);
      byGroup.set(l.group, g);
    }

    return {
      patch: name,
      found: true,
      date,
      enteredBy: entered,
      orders: orders.size,
      items: new Set(lines.map((l) => loose(l.item))).size,
      total: lines.reduce((n, l) => n + l.quantity, 0),
      groups: [...byGroup.entries()]
        .map(([group, rows]) => ({
          group,
          total: rows.reduce((n: number, l: any) => n + l.quantity, 0),
          lines: rows.sort((a: any, b: any) => a.item.localeCompare(b.item)),
        }))
        .sort((a, b) => b.total - a.total),
    };
  }
}

/** Names are compared with their spacing collapsed; 216 have a double space. */
function loose(s: string): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}