/**
 * The parts of the dashboard that answer a question rather than show a total.
 *
 * Every one of these exists in the Apps Script, and the thresholds and
 * definitions here are its own — the run-out bands, what counts as a defect,
 * which warehouse is sellable. Changing any of them would make a number that
 * people already read mean something different without saying so.
 */
import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { WarehouseReaderService } from './sheets/warehouse-reader.service';
import { counts, WAREHOUSE_LOCATIONS, WAREHOUSE_PURPOSE } from './sheets/tabs';
import { parseSheetDate } from './sheets/parse-date';

const TZ = 'Africa/Cairo';

/** Where stock can actually be sold from. */
const SELLABLE_WAREHOUSE = 'WH-02';

/** Where a defect ends up. */
const DEFECT_WAREHOUSE = 'WH-04';

/**
 * The run-out bands, from the Apps Script's own legend.
 *
 * Under seven days is red, seven to fourteen amber, over fourteen green.
 */
const RUN_OUT = { urgent: 7, soon: 14 } as const;

/** The window the selling pace is measured over. */
const PACE_DAYS = 7;

@Injectable()
export class WarehouseInsightsService {
  constructor(private readonly reader: WarehouseReaderService) {}

  /**
   * Each warehouse, broken down by what is inside it.
   *
   * A total for WH-02 is not much use on its own: what somebody wants is how
   * much is Local and how much is Global, and for WH-04 how much is in B
   * versus C versus Sewing. The share is given as well as the count, because
   * "1,200 in B" means nothing without knowing whether that is most of it.
   */
  /**
   * Everything inside one warehouse, item by item.
   *
   * Each row also carries the same item's balance in every other warehouse,
   * because the question that follows "how many Sira are in WH-02" is almost
   * always "and where is the rest of it" — and answering it from a second
   * screen means holding the first number in your head while you look.
   */
  async warehouseInventory(code: string) {
    const balances = await this.reader.balances();
    const want = code.trim().toUpperCase();

    /* Per item: what is here, split by location, and what is elsewhere. */
    const here = new Map<string, Map<string, number>>();
    const elsewhere = new Map<string, Map<string, number>>();

    for (const b of balances) {
      if (!b.item || b.balance === 0) continue;
      const wh = String(b.warehouse ?? '').trim().toUpperCase();

      if (wh === want) {
        const locs = here.get(b.item) ?? new Map<string, number>();
        const key = b.location || '—';
        locs.set(key, (locs.get(key) ?? 0) + b.balance);
        here.set(b.item, locs);
      } else if (counts(b.warehouse)) {
        const other = elsewhere.get(b.item) ?? new Map<string, number>();
        other.set(b.warehouse, (other.get(b.warehouse) ?? 0) + b.balance);
        elsewhere.set(b.item, other);
      }
    }

    const rows = [...here.entries()].map(([item, locs]) => ({
      item,
      total: [...locs.values()].reduce((n, v) => n + v, 0),
      locations: [...locs.entries()]
        .map(([label, pieces]) => ({ label, pieces }))
        .sort((a, b) => b.pieces - a.pieces),
      elsewhere: [...(elsewhere.get(item) ?? new Map()).entries()]
        .map(([warehouse, pieces]) => ({ warehouse, pieces: pieces as number }))
        .sort((a, b) => b.pieces - a.pieces),
    })).sort((a, b) => b.total - a.total);

    return {
      warehouse: want,
      items: rows.length,
      total: rows.reduce((n, r) => n + r.total, 0),
      rows,
    };
  }

  async warehouseDetail() {
    const balances = await this.reader.balances();
    const byWarehouse = new Map<string, Map<string, number>>();

    for (const b of balances) {
      if (!counts(b.warehouse) || b.balance <= 0) continue;
      const locs = byWarehouse.get(b.warehouse) ?? new Map<string, number>();
      const key = b.location || '—';
      locs.set(key, (locs.get(key) ?? 0) + b.balance);
      byWarehouse.set(b.warehouse, locs);
    }

    return [...byWarehouse.entries()]
      .map(([code, locs]) => {
        const total = [...locs.values()].reduce((n, v) => n + v, 0);
        return {
          code,
          purpose: WAREHOUSE_PURPOSE[code] ?? '',
          total,
          /* Locations the layout says exist, even at zero — an empty Sewing
             is a fact worth seeing, not a row to hide. */
          locations: [...new Set([
            ...(WAREHOUSE_LOCATIONS[code] ?? []),
            ...locs.keys(),
          ])]
            .map((label) => {
              const pieces = locs.get(label) ?? 0;
              return {
                label,
                pieces,
                share: total ? Math.round((pieces / total) * 1000) / 10 : 0,
              };
            })
            .sort((a, b) => b.pieces - a.pieces),
        };
      })
      .sort((a, b) => b.total - a.total);
  }

  /**
   * One item, as a card per warehouse.
   *
   * The item card already lists places in a table; this is the same facts
   * shaped for a search box — where is it, how much of it is where, and what
   * share of the total each place holds.
   */
  async findItem(name: string) {
    const [balances, items] = await Promise.all([
      this.reader.itemBalances(name),
      this.reader.items(),
    ]);

    const item = items.find(
      (i) => i.name.replace(/\s+/g, ' ').trim().toLowerCase()
          === name.replace(/\s+/g, ' ').trim().toLowerCase());

    const counted = balances.filter((b) => counts(b.warehouse));
    const total = counted.reduce((n, b) => n + b.balance, 0);

    const byWarehouse = new Map<string, { pieces: number; locations: Map<string, number> }>();
    for (const b of counted) {
      const w = byWarehouse.get(b.warehouse)
        ?? { pieces: 0, locations: new Map<string, number>() };
      w.pieces += b.balance;
      if (b.location) {
        w.locations.set(b.location, (w.locations.get(b.location) ?? 0) + b.balance);
      }
      byWarehouse.set(b.warehouse, w);
    }

    return {
      item: item ?? null,
      total,
      /*
       * Also shown: what is in warehouses that no longer count. Somebody
       * hunting for a piece wants to know it is in WH-06 rather than be told
       * there is none — it is just kept out of the total.
       */
      retired: balances
        .filter((b) => !counts(b.warehouse) && b.balance !== 0)
        .map((b) => ({
          warehouse: b.warehouse, location: b.location, pieces: b.balance,
        })),
      warehouses: [...byWarehouse.entries()]
        .map(([code, w]) => ({
          code,
          purpose: WAREHOUSE_PURPOSE[code] ?? '',
          pieces: w.pieces,
          share: total ? Math.round((w.pieces / total) * 1000) / 10 : 0,
          locations: [...w.locations.entries()]
            .map(([label, pieces]) => ({
              label, pieces,
              share: w.pieces ? Math.round((pieces / w.pieces) * 1000) / 10 : 0,
            }))
            .sort((a, b) => b.pieces - a.pieces),
        }))
        .sort((a, b) => b.pieces - a.pieces),
    };
  }

  /**
   * How long the sellable stock lasts.
   *
   * Days left = what is in WH-02 now, divided by the average sold per day
   * over the last seven. An item selling nothing has no run-out date at all
   * rather than an infinite one, and is left out — the question is which
   * things are about to run out, and something nobody is buying is not.
   *
   * Only `NEW ORDER` rows count as selling. A transfer out of WH-02 moves
   * stock somewhere else in the business; counting it as demand would make
   * the warehouse look like it was about to run dry every time anything was
   * moved to the workshop.
   */
  async runOutForecast(limit = 20) {
    const [balances, movements] = await Promise.all([
      this.reader.balances(),
      this.reader.movements({ limit: 20000 }),
    ]);

    const since = DateTime.now().setZone(TZ)
      .minus({ days: PACE_DAYS }).startOf('day');

    const soldPerItem = new Map<string, number>();
    for (const m of movements) {
      if (m.kind !== 'NEW ORDER' || !m.stockOut) continue;
      if (m.warehouse !== SELLABLE_WAREHOUSE) continue;
      const d = parseSheetDate(m.date);
      if (!d || d < since) continue;
      soldPerItem.set(m.item, (soldPerItem.get(m.item) ?? 0) + m.stockOut);
    }

    const stock = new Map<string, number>();
    for (const b of balances) {
      if (b.warehouse !== SELLABLE_WAREHOUSE) continue;
      stock.set(b.item, (stock.get(b.item) ?? 0) + b.balance);
    }

    const rows = [...soldPerItem.entries()]
      .map(([item, sold]) => {
        const perDay = sold / PACE_DAYS;
        const have = stock.get(item) ?? 0;
        return {
          item,
          pieces: have,
          perDay: Math.round(perDay * 10) / 10,
          /* Already gone is zero days, not a negative number of them. */
          days: perDay > 0 ? Math.max(0, Math.round((have / perDay) * 10) / 10) : null,
          band: '' as 'urgent' | 'soon' | 'ok' | '',
        };
      })
      .filter((r) => r.days !== null)
      .map((r) => ({
        ...r,
        band: (r.days! < RUN_OUT.urgent ? 'urgent'
             : r.days! < RUN_OUT.soon ? 'soon' : 'ok') as 'urgent' | 'soon' | 'ok',
      }))
      .sort((a, b) => a.days! - b.days!)
      .slice(0, limit);

    /*
     * The weeks ahead, as pieces left rather than as a date.
     *
     * "Runs out in 9.4 days" answers when; planning asks what will be on the
     * shelf at the end of each week, because an order placed now arrives
     * against that, not against today. Four weeks is as far as the pace is
     * worth trusting — beyond it the forecast is arithmetic rather than
     * evidence.
     *
     * Floored at zero: an item that runs out in week two is empty in weeks
     * three and four, not increasingly negative.
     */
    const weeksAhead = 4;
    const outlook = rows.map((r) => ({
      item: r.item,
      weeks: Array.from({ length: weeksAhead }, (_, i) =>
        Math.max(0, Math.round(r.pieces - r.perDay * 7 * (i + 1)))),
    }));

    return { bands: RUN_OUT, paceDays: PACE_DAYS, weeksAhead, rows, outlook };
  }

  /**
   * Stock by collection.
   *
   * The catalogue's Group — the kind and material together, "Plain Cotton",
   * "Printed Delicate". It is the level buying decisions are made at, which
   * is why it is a panel of its own rather than a filter on the item list.
   */
  async byCollection(warehouse?: string) {
    const [balances, items] = await Promise.all([
      this.reader.balances(),
      this.reader.items(),
    ]);

    const groupOf = new Map<string, string>();
    for (const i of items) {
      groupOf.set(i.name.replace(/\s+/g, ' ').trim().toLowerCase(), i.group || 'Ungrouped');
    }

    const totals = new Map<string, number>();
    for (const b of balances) {
      if (!counts(b.warehouse) || b.balance <= 0) continue;
      if (warehouse && b.warehouse !== warehouse) continue;
      const group = groupOf.get(b.item.replace(/\s+/g, ' ').trim().toLowerCase())
        ?? 'Ungrouped';
      totals.set(group, (totals.get(group) ?? 0) + b.balance);
    }

    return {
      kind: 'bar' as const,
      format: 'integer' as const,
      scope: warehouse ?? null,
      items: [...totals.entries()]
        .map(([label, value]) => ({ label, value }))
        .sort((a, b) => b.value - a.value),
    };
  }

  /**
   * The items with the most defects.
   *
   * Counted as pieces sitting in WH-04, which is where a defect ends up —
   * the Apps Script's own definition, and the only one the ledger supports:
   * there is no column saying a piece is faulty, only where it is.
   */
  async mostDefects(limit = 15) {
    const balances = await this.reader.balances();
    const totals = new Map<string, number>();

    for (const b of balances) {
      if (b.warehouse !== DEFECT_WAREHOUSE || b.balance <= 0) continue;
      totals.set(b.item, (totals.get(b.item) ?? 0) + b.balance);
    }

    return [...totals.entries()]
      .map(([item, pieces]) => ({ item, pieces }))
      .sort((a, b) => b.pieces - a.pieces)
      .slice(0, limit);
  }

}