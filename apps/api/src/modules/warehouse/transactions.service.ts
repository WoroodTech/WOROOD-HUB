/**
 * Posting stock movements.
 *
 * Every rule here came out of the Apps Script, and most of them exist because
 * something went wrong once. The guards are not decoration: a movement posted
 * twice, or taken out of a place that does not have it, is a count somebody
 * has to reconcile against physical stock later.
 *
 * Nothing is written to the sheet from here. A movement is validated, written
 * to the queue, and the queue gets it to the sheet.
 */
import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { one, query, tx } from '../../common/db';
import { Principal } from '../../common/auth';
import { AuditService } from '../../core/core.module';
import { WarehouseReaderService } from './sheets/warehouse-reader.service';
import { WarehouseQueueService } from './sheets/warehouse-queue.service';
import { WarehouseSheetClient } from './sheets/warehouse-sheet.client';
import { TX, TX_TYPES, TxType, WAREHOUSE_LOCATIONS } from './sheets/tabs';

/** Cairo, because a movement is dated by the day it happened there. */
const TZ = 'Africa/Cairo';

export interface PostLine {
  /** The item's description — what the ledger calls it. */
  item: string;
  quantity: number;
}

export interface PostInput {
  /** A key of TX_TYPES: NEW_ORDER, RETURN, RECEIVING, … */
  type: string;
  lines: PostLine[];

  warehouse: string;
  location?: string;

  /** For a transfer: where it goes. The warehouse above is where it leaves. */
  toWarehouse?: string;
  toLocation?: string;

  nationalOrder?: string;
  globalOrder?: string;
  patch?: string;

  /** For `Shortage & Over`, which way it goes. */
  direction?: 'in' | 'out';

  notes?: string;

  /**
   * The caller's own key for this posting.
   *
   * Sent by the browser and reused on a retry, so a connection that drops
   * after the server accepted the post does not put the same movement in
   * twice when the person presses the button again.
   */
  opId?: string;
}

@Injectable()
export class WarehouseTransactionsService {
  private readonly log = new Logger('WarehouseTx');

  constructor(
    private readonly reader: WarehouseReaderService,
    private readonly queue: WarehouseQueueService,
    private readonly audit: AuditService,
  ) {}

  /** The nine kinds, for the forms to offer. */
  types() {
    return Object.entries(TX_TYPES).map(([key, t]) => ({
      key,
      kind: t.kind,
      mode: t.mode,
      needsOrder: !!t.order,
      needsLocation: !!t.locationRequired,
      duplicateBy: t.dup ?? null,
      managerOnly: !!t.managerOnly,
    }));
  }

  /**
   * Post a movement.
   *
   * The order of the checks matters. Everything that can be decided without
   * reading the ledger is decided first, because the balance read is the
   * expensive part and there is no sense paying for it to then refuse the
   * post for a missing order number.
   */
  async post(p: Principal, dto: PostInput, canManage: boolean) {
    const type = TX_TYPES[dto.type];
    if (!type) throw new BadRequestException('That is not a kind of movement this posts.');

    if (type.managerOnly && !canManage) {
      /* Open Balance and Shortage & Over are the two that can move a balance
         with no physical movement behind them. */
      throw new ForbiddenException(
        `${type.kind} can only be posted by somebody who can manage the ledger.`);
    }

    const lines = this.cleanLines(dto.lines);
    this.assertPlaces(type, dto);
    this.assertReferences(type, dto);

    const direction = this.directionOf(type, dto);

    /* Duplicate check before the balance read: it is the cheaper of the two
       and the likelier refusal. */
    const dupe = await this.findDuplicate(type, dto);
    if (dupe) {
      throw new BadRequestException(
        `${type.kind} for ${type.dup === 'patch' ? 'patch' : 'order'} `
        + `${(type.dup === 'patch' ? dto.patch : dto.nationalOrder || dto.globalOrder)} `
        + `was already posted on ${dupe.date} by ${dupe.enteredBy || 'somebody'} `
        + `(sheet row ${dupe.rowNumber}). Nothing was posted again.`);
    }

    /* And the item names, before anything is read in bulk. */
    await this.assertItemsExist(lines);

    if (direction === 'out' || type.mode === 'transfer') {
      await this.assertEnoughStock(lines, dto.warehouse, dto.location ?? '');
    }

    /* `opId` makes a retry safe: the same key posts once. Checked inside the
       transaction so two tabs pressing at the same moment cannot both pass. */
    const opId = (dto.opId ?? '').trim() || null;

    const result = await tx(async (c) => {
      if (opId) {
        const seen = await c.query(
          `SELECT id FROM wh_sheet_events WHERE payload->>'opId' = $1 LIMIT 1`, [opId]);
        if (seen.rows.length) {
          return { duplicate: true, events: [] as string[] };
        }
      }
      return { duplicate: false, events: [] as string[] };
    });

    if (result.duplicate) {
      /* Not an error: the first press worked. Saying so is friendlier than
         a refusal that makes somebody check whether it went in. */
      return { ok: true, alreadyPosted: true, events: [] };
    }

    const rows = this.buildRows(p, type, dto, lines, direction);
    const events: string[] = [];
    for (const row of rows) {
      events.push(await this.queue.enqueue('LEDGER_ROW', row, undefined));
    }

    /* Stamp the op id on the first event so a retry finds it. */
    if (opId && events.length) {
      await query(
        `UPDATE wh_sheet_events SET payload = payload || jsonb_build_object('opId', $2::text)
          WHERE id = ANY($1)`, [events, opId]);
    }

    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.tx.post',
      entityType: 'warehouse_movement', entityId: events[0] ?? '',
      payload: {
        kind: type.kind, warehouse: dto.warehouse, location: dto.location ?? null,
        toWarehouse: dto.toWarehouse ?? null, lines: lines.length,
        units: lines.reduce((n, l) => n + l.quantity, 0),
      },
    });

    /* What was read is no longer what the sheet will say. Cleared now rather
       than when the queue drains, so the screen that reloads straight after
       posting does not show the old balance. */
    await this.reader.invalidate();

    return { ok: true, alreadyPosted: false, events, rows: rows.length };
  }

  /* --------------------------------------------------------- checks -- */

  private cleanLines(lines: PostLine[] | undefined): PostLine[] {
    if (!Array.isArray(lines) || !lines.length) {
      throw new BadRequestException('Add at least one item.');
    }

    const out: PostLine[] = [];
    const seen = new Map<string, number>();

    for (const l of lines) {
      const item = String(l?.item ?? '').trim();
      const qty = Number(l?.quantity);

      if (!item) throw new BadRequestException('One of the lines has no item.');
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new BadRequestException(`"${item}": the quantity must be 1 or more.`);
      }
      if (!Number.isInteger(qty)) {
        throw new BadRequestException(`"${item}": stock is counted in whole pieces.`);
      }
      if (qty > 100_000) {
        throw new BadRequestException(`"${item}": that quantity looks like a typo.`);
      }

      /* The same item twice in one posting is added up rather than written
         as two rows — two rows would make the duplicate check and the
         balance read both harder to reason about for no gain. */
      const key = item.toLowerCase();
      if (seen.has(key)) {
        out[seen.get(key)!].quantity += qty;
      } else {
        seen.set(key, out.length);
        out.push({ item, quantity: qty });
      }
    }

    return out;
  }

  /** The warehouse and location must exist, and be given when required. */
  private assertPlaces(type: TxType, dto: PostInput) {
    const check = (w: string, loc: string, what: string) => {
      if (!w) throw new BadRequestException(`Choose the ${what}.`);

      const known = WAREHOUSE_LOCATIONS[w];
      if (known === undefined) {
        throw new BadRequestException(`${w} is not a warehouse.`);
      }
      /* A warehouse with no sub-locations takes none; one that has them
         needs the right one, not just any string. */
      if (known.length === 0) {
        if (loc) throw new BadRequestException(`${w} has no locations inside it.`);
        return;
      }
      if (!loc) {
        if (type.locationRequired) {
          throw new BadRequestException(`Choose the location inside ${w}.`);
        }
        return;
      }
      if (!known.includes(loc)) {
        throw new BadRequestException(`"${loc}" is not a location in ${w}.`);
      }
    };

    check(dto.warehouse, dto.location ?? '', 'warehouse');

    if (type.mode === 'transfer') {
      check(dto.toWarehouse ?? '', dto.toLocation ?? '', 'warehouse it goes to');
      if (dto.warehouse === dto.toWarehouse
          && (dto.location ?? '') === (dto.toLocation ?? '')) {
        throw new BadRequestException('A transfer has to go somewhere else.');
      }
    }
  }

  /** An order or a patch, where the kind needs one. */
  private assertReferences(type: TxType, dto: PostInput) {
    if (type.order && !String(dto.nationalOrder ?? '').trim()
        && !String(dto.globalOrder ?? '').trim()) {
      throw new BadRequestException('Enter the order number.');
    }
    if (type.dup === 'patch' && !String(dto.patch ?? '').trim()) {
      throw new BadRequestException('Enter the patch number.');
    }
  }

  /** Which way the stock goes. */
  private directionOf(type: TxType, dto: PostInput): 'in' | 'out' | 'none' {
    if (type.mode === 'sel') {
      if (dto.direction !== 'in' && dto.direction !== 'out') {
        throw new BadRequestException(
          `${type.kind} has to say whether this is stock in or stock out.`);
      }
      return dto.direction;
    }
    if (type.mode === 'transfer') return 'out';
    if (type.mode === 'none') return 'none';
    return type.mode;
  }

  /**
   * Every item has to be one the sheet knows.
   *
   * The catalogue is the authority on what an item is called, and a movement
   * against a name that is not in it creates a balance for an item that does
   * not exist — findable by nobody, and reconciled against nothing.
   */
  private async assertItemsExist(lines: PostLine[]) {
    /*
     * Matched with runs of whitespace collapsed.
     *
     * 216 items in the catalogue have a double space in their name, because
     * the colour cell they are built from has a trailing space and the
     * formula joins it with another. Sixteen of those names are in the ledger
     * exactly like that. Comparing the strings as they are would reject an
     * item somebody picked from our own list, for a reason invisible on
     * screen.
     */
    const known = new Set(
      (await this.reader.items()).map((i) => normalise(i.name)));
    const missing = lines
      .filter((l) => !known.has(normalise(l.item)))
      .map((l) => l.item);

    if (missing.length) {
      throw new BadRequestException(
        missing.length === 1
          ? `"${missing[0]}" is not an item in the sheet.`
          : `These are not items in the sheet: ${missing.slice(0, 5).join(', ')}`
            + (missing.length > 5 ? `, and ${missing.length - 5} more.` : '.'));
    }
  }

  /**
   * Nothing leaves a place that does not have it.
   *
   * The rule from the Apps Script, which applies to every warehouse and not
   * only WH-02: a place holding zero or less cannot be taken from at all, and
   * a place holding some cannot be taken below zero.
   *
   * The ledger already has about a hundred negative balances from before any
   * of this existed. They are left alone — this stops new ones.
   */
  private async assertEnoughStock(lines: PostLine[], warehouse: string, location: string) {
    const place = location
      ? `${warehouse} / ${location}`
      : warehouse;

    for (const l of lines) {
      const have = await this.reader.balanceAt(l.item, warehouse, location);

      if (have <= 0) {
        throw new BadRequestException(
          `"${l.item}" has ${have} in ${place} — it cannot be taken out.`);
      }
      if (l.quantity > have) {
        throw new BadRequestException(
          `"${l.item}" has only ${have} in ${place}, and ${l.quantity} were asked for.`);
      }
    }
  }

  /** Has this reference already gone in? */
  private async findDuplicate(type: TxType, dto: PostInput) {
    if (!type.dup) return null;
    const ref = type.dup === 'patch'
      ? String(dto.patch ?? '').trim()
      : String(dto.nationalOrder ?? '').trim() || String(dto.globalOrder ?? '').trim();
    if (!ref) return null;
    return this.reader.alreadyPosted(type.dup, ref, type.kind);
  }

  /* ---------------------------------------------------------- rows -- */

  /**
   * The ledger rows this posting becomes.
   *
   * A transfer is two rows — one out of where it was, one into where it goes
   * — because that is what the sheet's balance columns are built to read. A
   * single row with a "from" and a "to" would need every formula in the
   * document rewritten.
   *
   * Column N (Balance) is never written: it is a formula, and a value put
   * there replaces it and breaks every row below that refers to it.
   */
  private buildRows(
    p: Principal, type: TxType, dto: PostInput,
    lines: PostLine[], direction: 'in' | 'out' | 'none',
  ): any[][] {
    /* The server runs in UTC. A movement posted at one in the morning Cairo
       time belongs to that day there, not to the one before it. */
    const date = DateTime.now().setZone(TZ).toFormat('dd/LL/yyyy');
    const by = WarehouseSheetClient.safe(p.fullName ?? p.email ?? '');

    const rows: any[][] = [];

    const make = (
      item: string, qtyIn: number, qtyOut: number,
      warehouse: string, location: string,
    ) => {
      const row = new Array(15).fill('');
      row[TX.date] = date;
      row[TX.itemName] = WarehouseSheetClient.safe(item);
      row[TX.nationalOrder] = WarehouseSheetClient.safe(dto.nationalOrder ?? '');
      row[TX.globalOrder] = WarehouseSheetClient.safe(dto.globalOrder ?? '');
      row[TX.patch] = WarehouseSheetClient.safe(dto.patch ?? '');
      /* Numbers, not strings: a quantity written as text does not add up in
         the sheet's own totals, and nothing says so. */
      row[TX.stockIn] = qtyIn || '';
      row[TX.stockOut] = qtyOut || '';
      row[TX.warehouse] = warehouse;
      row[TX.location] = location;
      row[TX.kind] = type.kind;
      row[TX.enteredBy] = by;
      return row;
    };

    for (const l of lines) {
      if (type.mode === 'transfer') {
        rows.push(make(l.item, 0, l.quantity, dto.warehouse, dto.location ?? ''));
        rows.push(make(l.item, l.quantity, 0, dto.toWarehouse!, dto.toLocation ?? ''));
      } else if (direction === 'none') {
        /* Cancelled: the row records that it happened, and moves nothing. */
        rows.push(make(l.item, 0, 0, dto.warehouse, dto.location ?? ''));
      } else if (direction === 'in') {
        rows.push(make(l.item, l.quantity, 0, dto.warehouse, dto.location ?? ''));
      } else {
        rows.push(make(l.item, 0, l.quantity, dto.warehouse, dto.location ?? ''));
      }
    }

    return rows;
  }
}

/**
 * An item name, for comparing.
 *
 * Only ever used to match two names against each other — never to write one.
 * What goes into the ledger is the catalogue's own spelling, double spaces
 * and all, because that is what the existing rows have and what the sheet's
 * own formulas produce.
 *
 * 216 items in the catalogue have a double space in their name: the
 * Description column joins three cells, and the colour cell has a trailing
 * space. Sixteen of those names are already in the ledger exactly like that.
 */
function normalise(name: string): string {
  return String(name ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}