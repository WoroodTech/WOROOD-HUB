/**
 * Reading the warehouse out of the spreadsheet.
 *
 * The ledger is thirty-odd thousand rows and grows every day, so nothing here
 * reads it per request. A read happens, the result is cached, and the cache
 * is thrown away when something is written or when it gets old enough to be
 * worth doubting.
 *
 * Everything this returns is derived from the sheet. Nothing is stored as a
 * fact of its own: if the cache is wrong, deleting the row fixes it.
 */
import { Injectable, Logger } from '@nestjs/common';
import { one, query } from '../../../common/db';
import { WarehouseSheetClient } from './warehouse-sheet.client';
import {
  ITEMS, ITEMS_SHAPE, ITEMS_TAB, KEYS, KEYS_TAB,
  TX, TX_SHAPE, TX_TAB, WAREHOUSES, WAREHOUSE_LOCATIONS,
} from './tabs';

export interface WarehouseItem {
  /** The computed code — what the sheet's Item Code column holds. */
  code: string;
  /** The computed description, which is what the ledger calls the item. */
  name: string;
  group: string;
  color: string;
  kind: string;
  material: string;
}

export interface Balance {
  item: string;
  warehouse: string;
  location: string;
  balance: number;
}

/** How long a read is trusted before it is taken again. */
const TTL = {
  /** The catalogue changes when somebody creates an item, which is rare. */
  items: 30 * 60_000,
  /** Coding tables change about once a year. */
  keys: 6 * 60 * 60_000,
  /** Balances change with every movement, and a write clears this anyway. */
  balances: 5 * 60_000,
};

@Injectable()
export class WarehouseReaderService {
  private readonly log = new Logger('WarehouseReader');

  constructor(private readonly sheet: WarehouseSheetClient) {}

  /* ------------------------------------------------------- the cache -- */

  private async cached<T>(key: string, ttlMs: number, read: () => Promise<T>): Promise<T> {
    const hit = await one<any>(
      `SELECT payload FROM wh_cache WHERE key = $1 AND expires_at > now()`, [key]);
    if (hit) return hit.payload as T;

    const value = await read();

    /* `ON CONFLICT` rather than delete-then-insert: two requests arriving
       together would otherwise race, and the loser would write a row that
       the winner had already replaced. */
    await query(
      `INSERT INTO wh_cache (key, payload, rows, read_at, expires_at)
       VALUES ($1, $2, $3, now(), now() + ($4 || ' milliseconds')::interval)
       ON CONFLICT (key) DO UPDATE
         SET payload = EXCLUDED.payload, rows = EXCLUDED.rows,
             read_at = EXCLUDED.read_at, expires_at = EXCLUDED.expires_at`,
      [key, JSON.stringify(value), Array.isArray(value) ? value.length : 0, String(ttlMs)]);

    return value;
  }

  /**
   * Forget what was read.
   *
   * Called after every write. A movement posted and then not visible for five
   * minutes is worse than a slightly slower page: somebody posts it twice.
   */
  async invalidate(...keys: string[]): Promise<void> {
    if (!keys.length) {
      await query(`DELETE FROM wh_cache`);
      return;
    }
    await query(`DELETE FROM wh_cache WHERE key = ANY($1)`, [keys]);
  }

  /* ------------------------------------------------------ the catalogue */

  /**
   * Every item the sheet knows.
   *
   * The code, the description and the group are formulas the sheet computes
   * from the three columns a person fills in, so they are read rather than
   * rebuilt here — a reimplementation would drift the first time somebody
   * adjusts a formula.
   *
   * Rows with no computed code are skipped: that is a half-filled row
   * somebody is still typing, not an item.
   */
  async items(): Promise<WarehouseItem[]> {
    return this.cached('items', TTL.items, async () => {
      await this.sheet.assertShape(ITEMS_TAB, ITEMS_SHAPE);

      const rows = await this.sheet.read(ITEMS_TAB);
      const from = this.sheet.headerRow(ITEMS_TAB); // skip blank row 1 + headers
      const out: WarehouseItem[] = [];

      for (let i = from; i < rows.length; i++) {
        const r = rows[i] ?? [];
        const code = String(r[ITEMS.itemCode] ?? '').trim();
        const name = String(r[ITEMS.description] ?? '').trim();
        if (!code || !name) continue;
        /* A formula that has not resolved yet comes back as an error string
           rather than a value; it is not an item either. */
        if (code.startsWith('#') || name.startsWith('#')) continue;

        out.push({
          code, name,
          group: String(r[ITEMS.group] ?? '').trim(),
          color: String(r[ITEMS.color] ?? '').trim(),
          kind: String(r[ITEMS.kind] ?? '').trim(),
          material: String(r[ITEMS.material] ?? '').trim(),
        });
      }

      this.log.log(`catalogue: ${out.length} items`);
      return out;
    });
  }

  /**
   * The colour, kind and material tables an item code is built from.
   *
   * Needed by the create-item screen so it can say whether a colour already
   * has a code or will be given a new one — the difference between adding an
   * item and extending the coding scheme, which is worth knowing before
   * pressing the button.
   */
  async codingTables() {
    return this.cached('keys', TTL.keys, async () => {
      const rows = await this.sheet.read(KEYS_TAB);
      const pick = (nameCol: number, codeCol: number) => {
        const out: Record<string, string> = {};
        for (let i = 1; i < rows.length; i++) {
          const name = String(rows[i]?.[nameCol] ?? '').trim();
          const code = String(rows[i]?.[codeCol] ?? '').trim();
          if (name && code) out[name] = code;
        }
        return out;
      };
      return {
        colors: pick(KEYS.colorName, KEYS.colorCode),
        kinds: pick(KEYS.kindName, KEYS.kindCode),
        materials: pick(KEYS.materialName, KEYS.materialCode),
      };
    });
  }

  /* -------------------------------------------------------- balances -- */

  /**
   * What is where, built by walking the ledger.
   *
   * Summed here rather than read from the sheet's Balance column, which is a
   * running total per row and only means anything in the order the rows
   * happen to be in. Walking Stock In and Stock Out gives a balance per item
   * per place that does not depend on row order at all.
   *
   * A `Transfer` writes two rows — one out of the source, one into the
   * destination — so it needs no special handling here. A `Cancelled` row
   * moves nothing and contributes nothing.
   */
  async balances(): Promise<Balance[]> {
    return this.cached('balances', TTL.balances, async () => {
      await this.sheet.assertShape(TX_TAB, TX_SHAPE);

      const rows = await this.sheet.read(TX_TAB);
      const totals = new Map<string, Balance>();

      for (let i = 1; i < rows.length; i++) {
        const r = rows[i] ?? [];
        const item = String(r[TX.itemName] ?? '').trim();
        if (!item) continue;

        const warehouse = String(r[TX.warehouse] ?? '').trim();
        const location = String(r[TX.location] ?? '').trim();
        const inQty = num(r[TX.stockIn]);
        const outQty = num(r[TX.stockOut]);
        if (!inQty && !outQty) continue;

        const key = `${item}\u0000${warehouse}\u0000${location}`;
        const row = totals.get(key)
          ?? { item, warehouse, location, balance: 0 };
        row.balance += inQty - outQty;
        totals.set(key, row);
      }

      const out = [...totals.values()];
      this.log.log(`balances: ${out.length} item/place rows from ${rows.length - 1} ledger rows`);
      return out;
    });
  }

  /** What is on hand for one item, everywhere it sits. */
  async itemBalances(itemName: string): Promise<Balance[]> {
    const all = await this.balances();
    const want = loose(itemName);
    return all.filter((b) => loose(b.item) === want);
  }

  /**
   * The balance in one exact place.
   *
   * Used by the negative-stock guard, which is why it answers 0 rather than
   * null for a place that has no rows: never having held an item and holding
   * none of it are the same thing to somebody trying to take one out.
   */
  async balanceAt(itemName: string, warehouse: string, location: string): Promise<number> {
    const all = await this.balances();
    const want = loose(itemName);
    const row = all.find((b) =>
      loose(b.item) === want
      && b.warehouse === warehouse
      && (b.location ?? '') === (location ?? ''));
    return row?.balance ?? 0;
  }

  /* ------------------------------------------------------ warehouses -- */

  /**
   * The warehouses and what is inside each.
   *
   * Taken from the places the ledger actually uses, with the known layout as
   * the floor — so a location somebody adds in the sheet appears here without
   * a code change, and a location that exists but has never been used does
   * not disappear from the dropdown.
   */
  async warehouses() {
    const used = await this.balances();
    const locations: Record<string, Set<string>> = {};

    for (const w of WAREHOUSES) {
      locations[w] = new Set(WAREHOUSE_LOCATIONS[w] ?? []);
    }
    for (const b of used) {
      if (!b.warehouse) continue;
      locations[b.warehouse] ??= new Set();
      if (b.location) locations[b.warehouse].add(b.location);
    }

    return Object.entries(locations).map(([code, locs]) => ({
      code,
      locations: [...locs].sort(),
    })).sort((a, b) => a.code.localeCompare(b.code));
  }

  /* -------------------------------------------------------- movements -- */

  /**
   * Recent ledger rows, newest first.
   *
   * Not cached: this is what somebody looks at straight after posting, and a
   * five-minute-old answer there is the one thing it must never give.
   */
  async movements(filter: {
    item?: string; warehouse?: string; kind?: string;
    order?: string; patch?: string; limit?: number;
  } = {}) {
    const rows = await this.sheet.read(TX_TAB);
    const limit = Math.min(filter.limit ?? 200, 2000);
    const out: any[] = [];

    for (let i = rows.length - 1; i >= 1 && out.length < limit; i--) {
      const r = rows[i] ?? [];
      const item = String(r[TX.itemName] ?? '').trim();
      if (!item) continue;

      const row = {
        rowNumber: i + 1,
        date: String(r[TX.date] ?? ''),
        item,
        nationalOrder: String(r[TX.nationalOrder] ?? '').trim(),
        globalOrder: String(r[TX.globalOrder] ?? '').trim(),
        patch: String(r[TX.patch] ?? '').trim(),
        stockIn: num(r[TX.stockIn]),
        stockOut: num(r[TX.stockOut]),
        warehouse: String(r[TX.warehouse] ?? '').trim(),
        location: String(r[TX.location] ?? '').trim(),
        kind: String(r[TX.kind] ?? '').trim(),
        enteredBy: String(r[TX.enteredBy] ?? '').trim(),
      };

      if (filter.item && loose(row.item) !== loose(filter.item)) continue;
      if (filter.warehouse && row.warehouse !== filter.warehouse) continue;
      if (filter.kind && row.kind !== filter.kind) continue;
      if (filter.order && row.nationalOrder !== filter.order
          && row.globalOrder !== filter.order) continue;
      if (filter.patch && row.patch !== filter.patch) continue;

      out.push(row);
    }

    return out;
  }

  /**
   * Whether this reference has already been posted.
   *
   * The ledger is the only place that can answer this: HUB's queue knows what
   * HUB sent, and somebody typing a row straight into the sheet is both
   * allowed and common.
   *
   * Scoped to the kind, because the same order number legitimately appears as
   * a `NEW ORDER` and later as a `Return`.
   */
  async alreadyPosted(dupBy: 'order' | 'patch', reference: string, kind: string) {
    const ref = reference.trim();
    if (!ref) return null;

    const rows = await this.sheet.read(TX_TAB);
    for (let i = rows.length - 1; i >= 1; i--) {
      const r = rows[i] ?? [];
      if (String(r[TX.kind] ?? '').trim() !== kind) continue;

      const hit = dupBy === 'patch'
        ? String(r[TX.patch] ?? '').trim() === ref
        : String(r[TX.nationalOrder] ?? '').trim() === ref
          || String(r[TX.globalOrder] ?? '').trim() === ref;

      if (hit) {
        return {
          rowNumber: i + 1,
          date: String(r[TX.date] ?? ''),
          item: String(r[TX.itemName] ?? '').trim(),
          enteredBy: String(r[TX.enteredBy] ?? '').trim(),
        };
      }
    }
    return null;
  }
}

/**
 * An item name with its spacing normalised, for matching only.
 *
 * The catalogue's Description is a formula joining three cells, and a
 * trailing space in any of them produces a double space in the name. 216
 * items have one. Matching on the raw string would make an item fail to find
 * its own balances.
 */
function loose(name: string): string {
  return String(name ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A sheet cell that should be a number. Blank and junk both mean zero. */
function num(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}