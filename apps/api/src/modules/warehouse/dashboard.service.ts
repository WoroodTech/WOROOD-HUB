/**
 * The warehouse dashboard.
 *
 * Built from the same payload shapes the sales dashboard uses, so the portal
 * draws it with the charts it already has — `SeriesChart` and
 * `CategoryChart`, the same colours, the same axes, the same empty states.
 * A second set of chart components that looked almost the same would drift
 * apart the first time either was touched.
 *
 * Everything is derived from the ledger. Nothing is stored.
 */
import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { WarehouseReaderService } from './sheets/warehouse-reader.service';
import { counts, WAREHOUSE_PURPOSE } from './sheets/tabs';

const TZ = 'Africa/Cairo';

/**
 * What counts as running low.
 *
 * The Apps Script uses twenty, and the number is shown on the tile rather
 * than hidden here — somebody reading "47 running low" should be able to see
 * what that means without opening the code.
 */
const LOW_AT = 20;

/**
 * Where stock is sellable from.
 *
 * Out of stock means out of stock where a customer could have had it, not in
 * the workshop or with quality. Counting those as out of stock makes the
 * number meaningless: a piece in WH-04 awaiting revision was never sellable.
 */
const SELLABLE: Array<{ warehouse: string; location: string }> = [
  { warehouse: 'WH-02', location: 'Local' },
  { warehouse: 'WH-02', location: 'Global' },
];

@Injectable()
export class WarehouseDashboardService {
  constructor(private readonly reader: WarehouseReaderService) {}

  /**
   * The four tiles.
   *
   * The same four the Apps Script shows, because they are the four questions
   * somebody opening the warehouse actually has.
   */
  async tiles() {
    const balances = await this.reader.balances();

    let inStock = 0;
    const sellable = new Map<string, number>();
    const negative: { item: string; where: string; balance: number }[] = [];

    for (const b of balances) {
      /* Retired warehouses are history, not stock. Counting them put every
         total about four thousand pieces above what the ledger means. */
      if (!counts(b.warehouse)) continue;

      if (b.balance > 0) inStock += b.balance;

      if (b.balance < 0) {
        negative.push({
          item: b.item,
          where: b.location ? `${b.warehouse} / ${b.location}` : b.warehouse,
          balance: b.balance,
        });
      }

      const isSellable = SELLABLE.some(
        (s) => s.warehouse === b.warehouse && s.location === b.location);
      if (isSellable) {
        sellable.set(b.item, (sellable.get(b.item) ?? 0) + b.balance);
      }
    }

    let low = 0, out = 0;
    for (const qty of sellable.values()) {
      if (qty <= 0) out++;
      else if (qty <= LOW_AT) low++;
    }

    return {
      inStock,
      warehouses: new Set(balances.map((b) => b.warehouse).filter(Boolean)).size,
      low,
      lowAt: LOW_AT,
      outOfStock: out,
      /*
       * Counted as items, not as places.
       *
       * One item below zero in three locations is one item to go and count,
       * not three — which is what the Apps Script's own tile says
       * (`new Set(negs.map(n => n.it.name)).size`), and what somebody reading
       * the number will act on. The list below still has a row per place,
       * because that is where they have to go and look.
       */
      negative: new Set(negative.map((n) => n.item)).size,
      negativePlaces: negative.length,
      negativeDetail: negative
        .sort((a, b) => a.balance - b.balance)
        .slice(0, 50),
    };
  }

  /**
   * Movement over the last sixty days, as the portal's own line chart.
   *
   * Two series on one axis: both are counts of pieces, so they share a scale
   * honestly. (`SeriesChart` splits them into small multiples when formats
   * differ, which is why the format is stated once here.)
   */
  async movementTrend(days = 60) {
    const movements = await this.reader.movements({ limit: 20000 });

    const since = DateTime.now().setZone(TZ).minus({ days }).startOf('day');
    const inByDay = new Map<string, number>();
    const outByDay = new Map<string, number>();

    for (const m of movements) {
      const d = this.parseDate(m.date);
      if (!d || d < since) continue;
      const key = d.toFormat('yyyy-LL-dd');
      if (m.stockIn) inByDay.set(key, (inByDay.get(key) ?? 0) + m.stockIn);
      if (m.stockOut) outByDay.set(key, (outByDay.get(key) ?? 0) + m.stockOut);
    }

    /* Every day in the window, including the quiet ones. Dropping empty days
       would make a weekend look like a missing week. */
    const points: string[] = [];
    for (let i = days; i >= 0; i--) {
      points.push(DateTime.now().setZone(TZ).minus({ days: i }).toFormat('yyyy-LL-dd'));
    }

    return {
      kind: 'line' as const,
      format: 'integer' as const,
      timezone: TZ,
      series: [
        { key: 'in', label: 'Stock in',
          points: points.map((t) => ({ t, v: inByDay.get(t) ?? 0 })) },
        { key: 'out', label: 'Stock out',
          points: points.map((t) => ({ t, v: outByDay.get(t) ?? 0 })) },
      ],
    };
  }

  /** Stock by warehouse, as the portal's own category chart. */
  async stockByWarehouse() {
    const balances = await this.reader.balances();
    const byWarehouse = new Map<string, number>();

    for (const b of balances) {
      if (!counts(b.warehouse) || b.balance <= 0) continue;
      byWarehouse.set(b.warehouse, (byWarehouse.get(b.warehouse) ?? 0) + b.balance);
    }

    return {
      kind: 'donut' as const,
      format: 'integer' as const,
      items: [...byWarehouse.entries()]
        .map(([label, value]) => ({ label, value }))
        .sort((a, b) => b.value - a.value),
    };
  }

  /** Stock by location inside one warehouse. */
  async stockByLocation(warehouse: string) {
    const balances = await this.reader.balances();
    const byLocation = new Map<string, number>();

    for (const b of balances) {
      if (b.warehouse !== warehouse || b.balance <= 0) continue;
      const label = b.location || 'No location';
      byLocation.set(label, (byLocation.get(label) ?? 0) + b.balance);
    }

    return {
      kind: 'bar' as const,
      format: 'integer' as const,
      items: [...byLocation.entries()]
        .map(([label, value]) => ({ label, value }))
        .sort((a, b) => b.value - a.value),
    };
  }

  /**
   * What is nearly gone, where a customer could have had it.
   *
   * A table rather than a chart: the use for this is reading down a list and
   * ordering more, and a bar chart of fifteen item names is harder to read
   * than fifteen rows.
   */
  async runningLow(limit = 25) {
    const balances = await this.reader.balances();
    const sellable = new Map<string, number>();

    for (const b of balances) {
      const isSellable = SELLABLE.some(
        (s) => s.warehouse === b.warehouse && s.location === b.location);
      if (isSellable) sellable.set(b.item, (sellable.get(b.item) ?? 0) + b.balance);
    }

    return {
      kind: 'table' as const,
      columns: [
        { key: 'item', label: 'Item', format: 'text' as const },
        { key: 'balance', label: 'Sellable', format: 'integer' as const,
          align: 'end' as const },
      ],
      rows: [...sellable.entries()]
        .filter(([, qty]) => qty > 0 && qty <= LOW_AT)
        .sort((a, b) => a[1] - b[1])
        .slice(0, limit)
        .map(([item, balance]) => ({ item, balance })),
    };
  }

  /**
   * The sheet writes dates as dd/mm/yyyy, which `Date` reads as the American
   * order and gets wrong for every day before the thirteenth of a month.
   */
  private parseDate(s: string): DateTime | null {
    const t = String(s ?? '').trim();
    if (!t) return null;
    for (const fmt of ['dd/LL/yyyy', 'yyyy-LL-dd', 'd/L/yyyy']) {
      const d = DateTime.fromFormat(t, fmt, { zone: TZ });
      if (d.isValid) return d;
    }
    return null;
  }
}