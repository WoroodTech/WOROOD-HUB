/**
 * Reports over a date range.
 *
 * The Apps Script's `reportBuild_` is the largest single thing in that
 * project and the module had no equivalent. This is it: what sold, when, from
 * where, in which collection, what came back, and what the next eight weeks
 * look like — for any two dates.
 *
 * One pass over the ledger builds all of it. The alternative is a pass per
 * section, and the ledger is 35,000 rows.
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { one, query } from '../../common/db';
import { WarehouseReaderService } from './sheets/warehouse-reader.service';
import { SELLABLE, counts } from './sheets/tabs';
import { parseSheetDate } from './sheets/parse-date';

const TZ = 'Africa/Cairo';

/** How long a finished report is trusted. The Apps Script uses 25 minutes. */
const TTL = 25 * 60_000;

/** The trend window, in weeks. */
const TREND_WEEKS = 8;

export interface ReportRange { from: string; to: string }

@Injectable()
export class WarehouseReportsService {
  private readonly log = new Logger('WarehouseReports');

  constructor(private readonly reader: WarehouseReaderService) {}

  /**
   * Build a report, or return the one built recently.
   *
   * Cached because people open the same three ranges all day — this month,
   * last month, the last thirty days — and each one is a full pass over the
   * ledger.
   */
  async build(range: ReportRange, fresh = false) {
    const from = this.parse(range?.from, 'start');
    const to = this.parse(range?.to, 'end');
    if (to < from) {
      throw new BadRequestException('The end date is before the start date.');
    }

    const key = `report|${from.toISODate()}|${to.toISODate()}`;

    if (!fresh) {
      const hit = await one<any>(
        `SELECT payload FROM wh_cache WHERE key = $1 AND expires_at > now()`, [key]);
      if (hit) return hit.payload;
    }

    const report = await this.compute(from, to);

    await query(
      `INSERT INTO wh_cache (key, payload, rows, read_at, expires_at)
       VALUES ($1, $2, $3, now(), now() + ($4 || ' milliseconds')::interval)
       ON CONFLICT (key) DO UPDATE
         SET payload = EXCLUDED.payload, rows = EXCLUDED.rows,
             read_at = EXCLUDED.read_at, expires_at = EXCLUDED.expires_at`,
      [key, JSON.stringify(report), report.totals.rows, String(TTL)]);

    return report;
  }

  /** The ranges people actually open, so the screen can offer them. */
  presets() {
    const now = DateTime.now().setZone(TZ);
    const iso = (d: DateTime) => d.toISODate();
    return [
      { key: 'this-month', label: 'This month',
        from: iso(now.startOf('month')), to: iso(now) },
      { key: 'last-month', label: 'Last month',
        from: iso(now.minus({ months: 1 }).startOf('month')),
        to: iso(now.minus({ months: 1 }).endOf('month')) },
      { key: 'last-30', label: 'Last 30 days',
        from: iso(now.minus({ days: 29 })), to: iso(now) },
      { key: 'last-90', label: 'Last 90 days',
        from: iso(now.minus({ days: 89 })), to: iso(now) },
      { key: 'this-year', label: 'This year',
        from: iso(now.startOf('year')), to: iso(now) },
    ];
  }

  /* -------------------------------------------------------- build -- */

  private async compute(from: DateTime, to: DateTime) {
    const [movements, items] = await Promise.all([
      this.reader.movements({ limit: 60000 }),
      this.reader.items(),
    ]);

    const groupOf = new Map(items.map((i) => [loose(i.name), i.group || 'Other']));

    /* The trend looks further back than the range, so a report on one week
       still shows where that week sits. */
    const trendFrom = to.minus({ weeks: TREND_WEEKS }).startOf('day');
    const scanFrom = trendFrom < from ? trendFrom : from;

    const sold = new Map<string, { item: string; qty: number; orders: Set<string>; returned: number }>();
    const byDay = new Map<string, number>();
    const byWarehouse = new Map<string, number>();
    const byGroup = new Map<string, number>();
    const byKind = new Map<string, number>();
    const trend = new Map<string, number[]>();
    const orders = new Set<string>();

    let units = 0, returned = 0, rows = 0, received = 0;

    for (const m of movements) {
      const d = parseSheetDate(m.date);
      if (!d || d < scanFrom || d > to) continue;
      if (!counts(m.warehouse)) continue;

      const key = loose(m.item);
      const inRange = d >= from;

      /* The 8-week trend, bucketed back from the range's end. */
      if (m.kind === 'NEW ORDER' && m.stockOut) {
        const weeksBack = Math.min(
          TREND_WEEKS - 1,
          Math.floor(to.diff(d, 'weeks').weeks));
        const bucket = trend.get(key) ?? new Array(TREND_WEEKS).fill(0);
        bucket[TREND_WEEKS - 1 - weeksBack] += m.stockOut;
        trend.set(key, bucket);
      }

      if (!inRange) continue;
      rows++;

      const kind = m.kind || '(none)';
      byKind.set(kind, (byKind.get(kind) ?? 0) + (m.stockOut || m.stockIn));

      if (kind === 'Receiving' && m.stockIn) received += m.stockIn;

      if (kind === 'NEW ORDER' && m.stockOut) {
        const row = sold.get(key)
          ?? { item: m.item, qty: 0, orders: new Set<string>(), returned: 0 };
        row.qty += m.stockOut;
        const ref = m.nationalOrder || m.globalOrder;
        if (ref) { row.orders.add(ref); orders.add(ref); }
        sold.set(key, row);

        units += m.stockOut;
        const day = d.toISODate()!;
        byDay.set(day, (byDay.get(day) ?? 0) + m.stockOut);
        byWarehouse.set(m.warehouse, (byWarehouse.get(m.warehouse) ?? 0) + m.stockOut);
        const g = groupOf.get(key) ?? 'Other';
        byGroup.set(g, (byGroup.get(g) ?? 0) + m.stockOut);
      }

      if (kind === 'Return' && m.stockIn) {
        returned += m.stockIn;
        const row = sold.get(key)
          ?? { item: m.item, qty: 0, orders: new Set<string>(), returned: 0 };
        row.returned += m.stockIn;
        sold.set(key, row);
      }
    }

    /* Every day in the range, quiet ones included: dropping them would make
       a weekend look like a missing week. */
    const days: { t: string; v: number }[] = [];
    for (let d = from; d <= to; d = d.plus({ days: 1 })) {
      const iso = d.toISODate()!;
      days.push({ t: iso, v: byDay.get(iso) ?? 0 });
    }

    const topSellers = [...sold.values()]
      .filter((r) => r.qty > 0)
      .map((r) => ({
        item: r.item,
        quantity: r.qty,
        orders: r.orders.size,
        returned: r.returned,
        /* Against what went out, not against everything sold: an item
           returned twice out of three is a problem the total hides. */
        returnRate: r.qty > 0 ? Math.round((r.returned / r.qty) * 1000) / 10 : 0,
        trend: trend.get(loose(r.item)) ?? new Array(TREND_WEEKS).fill(0),
      }))
      .sort((a, b) => b.quantity - a.quantity);

    const span = Math.max(1, Math.round(to.diff(from, 'days').days) + 1);

    /*
     * What could be sold today, and what moved in and out of each warehouse.
     *
     * Sellable is WH-02's two shelves — a piece with quality or in the
     * workshop is real but cannot be promised to anybody — and it is the
     * stock every "days of cover" figure below is measured against. Taking
     * total stock instead would make an item look comfortable while the
     * shelf it sells from was empty.
     */
    const balances = await this.reader.balances();
    const sellable = new Map<string, number>();
    const movement = new Map<string, { in: number; out: number }>();

    for (const b of balances) {
      if (SELLABLE.some((x) => x.warehouse === b.warehouse
                            && x.location === b.location)) {
        sellable.set(loose(b.item), (sellable.get(loose(b.item)) ?? 0) + b.balance);
      }
    }

    for (const m of movements) {
      const d = parseSheetDate(m.date);
      if (!d || d < from || d > to) continue;
      if (!m.warehouse) continue;
      const w = movement.get(m.warehouse) ?? { in: 0, out: 0 };
      w.in += m.stockIn || 0;
      w.out += m.stockOut || 0;
      movement.set(m.warehouse, w);
    }

    /*
     * Demand for the coming month, from the eight weeks behind us.
     *
     * A mean over the whole window rather than the last week alone: one
     * quiet week during a holiday would otherwise halve every forecast on
     * the page. Weeks with no history at all are left out of the mean so a
     * new item is not averaged against zeroes it was never on sale for.
     */
    const forecastFor = (key: string) => {
      const weeks = trend.get(key);
      if (!weeks?.length) return 0;
      const seen = weeks.filter((w) => w !== undefined);
      if (!seen.length) return 0;
      const perWeek = seen.reduce((n, v) => n + (v || 0), 0) / seen.length;
      return Math.round((perWeek / 7) * 30);
    };

    /* Per day over the range, which is what days of cover divides by. */
    const rate = (qty: number) => qty / span;

    const cover = (key: string, perDay: number) => {
      const have = sellable.get(key) ?? 0;
      if (perDay <= 0) return have > 0 ? null : 0;
      return Math.round((have / perDay) * 10) / 10;
    };

    const movers = [...sold.values()]
      .filter((r) => r.qty > 0)
      .map((r) => {
        const key = loose(r.item);
        const perDay = Math.round(rate(r.qty) * 100) / 100;
        return {
          item: r.item,
          quantity: r.qty,
          perDay,
          stock: sellable.get(key) ?? 0,
          daysOfCover: cover(key, rate(r.qty)),
          forecast30: forecastFor(key),
        };
      });

    return {
      range: { from: from.toISODate(), to: to.toISODate(), days: span },
      builtAt: new Date().toISOString(),
      totals: {
        units,
        orders: orders.size,
        items: topSellers.length,
        returned,
        returnRate: units > 0 ? Math.round((returned / units) * 1000) / 10 : 0,
        received,
        perDay: Math.round((units / span) * 10) / 10,
        rows,
      },
      /* Shaped for the portal's own chart components, so the screen draws
         them with the ones it already has. */
      daily: {
        kind: 'line' as const, format: 'integer' as const, timezone: TZ,
        series: [{ key: 'sold', label: 'Sold', points: days }],
      },
      byWarehouse: {
        kind: 'donut' as const, format: 'integer' as const,
        items: [...byWarehouse.entries()]
          .map(([label, value]) => ({ label, value }))
          .sort((a, b) => b.value - a.value),
      },
      byCollection: {
        kind: 'bar' as const, format: 'integer' as const,
        items: [...byGroup.entries()]
          .map(([label, value]) => ({ label, value }))
          .sort((a, b) => b.value - a.value),
      },
      byKind: [...byKind.entries()]
        .map(([kind, units]) => ({ kind, units }))
        .sort((a, b) => b.units - a.units),
      topSellers: topSellers.slice(0, 50),
      /* Returned most, which is a different list from sold most and the one
         worth acting on. */
      mostReturned: [...sold.values()]
        .filter((r) => r.returned > 0)
        .map((r) => ({
          item: r.item, quantity: r.qty, returned: r.returned,
          returnRate: r.qty > 0 ? Math.round((r.returned / r.qty) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.returned - a.returned)
        .slice(0, 25),
      /*
       * Selling fastest, by pieces a day rather than by total.
       *
       * Total favours whatever has been on sale longest; a rate says which
       * item is actually moving now, which is the one to reorder.
       */
      fastMovers: [...movers]
        .sort((a, b) => b.perDay - a.perDay)
        .slice(0, 25),

      /*
       * What to do something about today.
       *
       * Ranked by how little cover is left, not by how fast it sells: an
       * item with four days of stock needs attention before one with forty,
       * however well the second is doing. `needed30` is the shortfall
       * against the next month's forecast — what to order, not what to have.
       */
      actNow: [...movers]
        .filter((r) => r.daysOfCover !== null && r.daysOfCover <= 30)
        .map((r) => ({
          ...r,
          needed30: Math.max(0, r.forecast30 - r.stock),
          priority: r.daysOfCover !== null && r.daysOfCover <= 7 ? 'now'
            : r.daysOfCover !== null && r.daysOfCover <= 14 ? 'soon' : 'watch',
        }))
        .sort((a, b) => (a.daysOfCover ?? 0) - (b.daysOfCover ?? 0))
        .slice(0, 25),

      /*
       * Stock sitting still: something on the shelf and nothing sold in the
       * range. Not a forecast — a plain fact about the period chosen, so it
       * moves with the filter.
       */
      slowMovers: [...sellable.entries()]
        .filter(([key, qty]) => qty > 0 && !(sold.get(key)?.qty))
        .map(([key, stock]) => ({
          item: sold.get(key)?.item ?? key, stock,
        }))
        .sort((a, b) => b.stock - a.stock)
        .slice(0, 25),

      /* Demand for the next thirty days, biggest first. */
      demandForecast: [...movers]
        .filter((r) => r.forecast30 > 0)
        .map((r) => ({
          item: r.item, forecast30: r.forecast30, stock: r.stock,
          shortfall: Math.max(0, r.forecast30 - r.stock),
        }))
        .sort((a, b) => b.forecast30 - a.forecast30)
        .slice(0, 25),

      /* In, out and the difference, per warehouse. */
      movementByWarehouse: [...movement.entries()]
        .map(([warehouse, w]) => ({
          warehouse, in: w.in, out: w.out, net: w.in - w.out,
        }))
        .sort((a, b) => b.out - a.out),

      /* WH-02's two shelves, which is what "sellable" means everywhere. */
      sellableStock: [...sellable.values()].reduce((n, v) => n + v, 0),

      trendWeeks: TREND_WEEKS,
    };
  }

  /* ------------------------------------------------------ helpers -- */

  private parse(value: string | undefined, edge: 'start' | 'end'): DateTime {
    const d = DateTime.fromISO(String(value ?? ''), { zone: TZ });
    if (!d.isValid) {
      throw new BadRequestException(`"${value}" is not a date. Use 2026-11-01.`);
    }
    return edge === 'start' ? d.startOf('day') : d.endOf('day');
  }

}

function loose(s: string): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}