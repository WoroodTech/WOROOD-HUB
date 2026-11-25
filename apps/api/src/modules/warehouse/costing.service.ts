/**
 * Costing, the constants behind it, and the demand plan.
 *
 * Three features the Apps Script has and the first pass of this module did
 * not. They belong together because they share one store — a key/value tab
 * the Apps Script calls `Rolls Settings` — and because the cost of a piece
 * and the demand for it are the two halves of the same question.
 *
 * Nothing here is invented. The constants, the rates and the arithmetic are
 * the ones already in use, so a number read here matches a number read there.
 */
import {
  BadRequestException, ForbiddenException, Injectable, Logger,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import { Principal } from '../../common/auth';
import { AuditService } from '../../core/core.module';
import { WarehouseSheetClient } from './sheets/warehouse-sheet.client';
import { WarehouseReaderService } from './sheets/warehouse-reader.service';
import { WarehouseRollsService } from './rolls.service';
import { SETTINGS_TAB, counts } from './sheets/tabs';
import { parseSheetDate } from './sheets/parse-date';

const TZ = 'Africa/Cairo';

/** The key/value tab both costing and planning read from. */
/* Re-exported for anything that already imports it from here; the
   definition lives in `sheets/tabs` so no service has to import another
   service for a tab name. */
export { SETTINGS_TAB };

/**
 * Monthly overheads and the fabric rate, in EGP.
 *
 * The Apps Script's own defaults, used when the sheet has no value — so a
 * fresh workbook produces the same numbers as the one in use rather than
 * zeroes that look like a working answer.
 */
const COST_DEFAULTS = { rent: 75000, utilities: 7500, fabric: 168 };

/** Selling price of one piece by grade. 0 means nobody has entered it. */
const PRICE_KEYS = ['p_ap', 'p_a', 'p_b', 'p_c'] as const;

/**
 * Planning constants.
 *
 * `unitsPerMeter` is the one that matters: 1.43 pieces come out of a metre,
 * and every expected-units figure in the rolls cycle is built from it.
 */
const PLAN_DEFAULTS = {
  unitsPerMeter: 1.43,
  shortagePct: 5,
  checkPct: 2,
  wastePct: 5,
  overdueDays: 14,
};

/** How far back the demand plan looks: 26 weeks, as the Apps Script does. */
const PLAN_WEEKS = 26;

@Injectable()
export class WarehouseCostingService {
  private readonly log = new Logger('WarehouseCosting');

  constructor(
    private readonly sheet: WarehouseSheetClient,
    private readonly reader: WarehouseReaderService,
    private readonly rolls: WarehouseRollsService,
    private readonly audit: AuditService,
  ) {}

  /* --------------------------------------------------------- store -- */

  /**
   * Everything in the settings tab, as a map.
   *
   * Four columns: key, value, who, when. Salaries are `sal_<month>` and
   * indirect expenses `ind_<month>`, which is how one tab holds both the
   * constants and a year of monthly figures without a column per month.
   */
  private async readAll(): Promise<Record<string, any>> {
    let rows: any[][];
    try { rows = await this.sheet.read(SETTINGS_TAB); } catch { rows = [[]]; }

    const out: Record<string, any> = {
      ...COST_DEFAULTS, ...PLAN_DEFAULTS,
      p_ap: 0, p_a: 0, p_b: 0, p_c: 0,
      salaries: {} as Record<string, number>,
      indirect: {} as Record<string, number>,
    };

    for (let i = 1; i < rows.length; i++) {
      const key = String(rows[i]?.[0] ?? '').trim();
      const raw = rows[i]?.[1];
      if (!key || raw === '' || raw === null || raw === undefined) continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;

      if (key.startsWith('sal_')) out.salaries[key.slice(4)] = value;
      else if (key.startsWith('ind_')) out.indirect[key.slice(4)] = value;
      /* A zero overhead is almost certainly a blank cell rather than a
         decision, so the default stands. A zero price is meaningful — it
         means nobody has set one — and is kept. */
      else if (key in COST_DEFAULTS) { if (value > 0) out[key] = value; }
      else if ((PRICE_KEYS as readonly string[]).includes(key)) { if (value >= 0) out[key] = value; }
      else if (key in PLAN_DEFAULTS) { if (value > 0) out[key] = value; }
    }

    return out;
  }

  /** Write one key. The tab is a flat key/value list, so this is a replace. */
  private async put(p: Principal, key: string, value: number) {
    let rows: any[][];
    try { rows = await this.sheet.read(SETTINGS_TAB); } catch { rows = [[]]; }

    const stamp = Math.round(DateTime.now().setZone(TZ).startOf('day')
      .diff(DateTime.fromISO('1899-12-30', { zone: TZ }), 'days').days);
    const by = WarehouseSheetClient.safe(p.fullName ?? p.email ?? '');

    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i]?.[0] ?? '').trim() === key) {
        await this.sheet.write(SETTINGS_TAB, `A${i + 1}:D${i + 1}`,
          [[key, value, by, stamp]]);
        return;
      }
    }

    await this.sheet.append(SETTINGS_TAB, [key, value, by, stamp]);
  }

  /* ------------------------------------------------------ settings -- */

  /** The planning constants, and what each one is for. */
  async settings() {
    const all = await this.readAll();
    return {
      unitsPerMeter: all.unitsPerMeter,
      shortagePct: all.shortagePct,
      checkPct: all.checkPct,
      wastePct: all.wastePct,
      overdueDays: all.overdueDays,
      defaults: PLAN_DEFAULTS,
    };
  }

  /**
   * Change a planning constant.
   *
   * Admin only, as it is there — `unitsPerMeter` in particular feeds every
   * expected-units figure in the rolls cycle, so changing it changes what
   * every open job order is measured against.
   */
  async setSettings(p: Principal, isAdmin: boolean, patch: Record<string, number>) {
    if (!isAdmin) {
      throw new ForbiddenException(
        'Only an admin can change the planning constants — they decide what '
        + 'every open job order is measured against.');
    }

    const changed: Record<string, number> = {};
    for (const [key, raw] of Object.entries(patch ?? {})) {
      if (!(key in PLAN_DEFAULTS)) {
        throw new BadRequestException(`"${key}" is not a planning constant.`);
      }
      const value = Number(raw);
      /* The Apps Script's own bounds: anything outside them is a typo, and a
         typo here silently rewrites every expectation in the module. */
      if (!Number.isFinite(value) || value <= 0 || value > 1000) {
        throw new BadRequestException(
          `"${key}" must be more than 0 and no more than 1000.`);
      }
      await this.put(p, key, value);
      changed[key] = value;
    }

    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.costing.settings',
      entityType: 'warehouse_settings', entityId: 'planning', payload: changed,
    });

    return { ok: true, changed };
  }

  /* --------------------------------------------------------- costs -- */

  /** The overheads, salaries, indirect expenses and selling prices. */
  async costs() {
    const all = await this.readAll();
    return {
      rent: all.rent,
      utilities: all.utilities,
      fabric: all.fabric,
      salaries: all.salaries,
      indirect: all.indirect,
      prices: {
        gradeAPlus: all.p_ap, gradeA: all.p_a, gradeB: all.p_b, gradeC: all.p_c,
      },
      defaults: COST_DEFAULTS,
    };
  }

  /**
   * Change a cost or a price.
   *
   * Manager or admin, as it is there. Salaries and indirect expenses are
   * per month, keyed `YYYY-MM`.
   */
  async setCosts(p: Principal, canManage: boolean, dto: {
    rent?: number; utilities?: number; fabric?: number;
    prices?: Partial<Record<'gradeAPlus' | 'gradeA' | 'gradeB' | 'gradeC', number>>;
    salary?: { month: string; amount: number };
    indirect?: { month: string; amount: number };
  }) {
    if (!canManage) {
      throw new ForbiddenException('Only a manager or an admin can change the costs.');
    }

    const changed: Record<string, number> = {};

    const simple: Record<string, number | undefined> = {
      rent: dto.rent, utilities: dto.utilities, fabric: dto.fabric,
    };
    for (const [key, raw] of Object.entries(simple)) {
      if (raw === undefined) continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        throw new BadRequestException(`"${key}" must be 0 or more.`);
      }
      await this.put(p, key, value);
      changed[key] = value;
    }

    const priceKey: Record<string, string> = {
      gradeAPlus: 'p_ap', gradeA: 'p_a', gradeB: 'p_b', gradeC: 'p_c',
    };
    for (const [name, raw] of Object.entries(dto.prices ?? {})) {
      const key = priceKey[name];
      if (!key) throw new BadRequestException(`"${name}" is not a grade.`);
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        throw new BadRequestException(`The price for ${name} must be 0 or more.`);
      }
      await this.put(p, key, value);
      changed[name] = value;
    }

    for (const [prefix, entry] of [['sal_', dto.salary], ['ind_', dto.indirect]] as const) {
      if (!entry) continue;
      const month = String(entry.month ?? '').trim();
      if (!/^\d{4}-\d{2}$/.test(month)) {
        throw new BadRequestException('A month looks like 2026-11.');
      }
      const amount = Number(entry.amount);
      if (!Number.isFinite(amount) || amount < 0) {
        throw new BadRequestException('The amount must be 0 or more.');
      }
      await this.put(p, prefix + month, amount);
      changed[prefix + month] = amount;
    }

    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.costing.costs',
      entityType: 'warehouse_settings', entityId: 'costs', payload: changed,
    });

    return { ok: true, changed };
  }

  /**
   * What a piece cost to make in one month, and what it sold for.
   *
   *   fabric per piece  = the metre rate ÷ pieces per metre
   *   overhead per piece = (rent + utilities + salaries + indirect) ÷ pieces made
   *
   * Overheads are spread across everything the month produced, which is the
   * only split the ledger supports — there is nothing recording which rent
   * belongs to which scarf.
   *
   * Grade C is counted in the pieces but sold at its own price, so a month
   * heavy with C costs the same per piece and earns less. That is the
   * number worth seeing.
   */
  async costReport(month?: string) {
    const all = await this.readAll();
    const at = month && /^\d{4}-\d{2}$/.test(month)
      ? month
      : DateTime.now().setZone(TZ).toFormat('yyyy-LL');

    const jobs = await this.rolls.jobOrders();
    const produced = { a: 0, b: 0, c: 0 };
    let metres = 0;

    for (const j of jobs) {
      /* Closed in this month: an open order has no final count, and
         counting it would move the figure every time anything is reported. */
      const d = this.monthOf(j.delivered);
      if (d !== at) continue;
      produced.a += j.gradeA;
      produced.b += j.gradeB;
      metres += j.meters;
    }

    const pieces = produced.a + produced.b + produced.c;

    const salaries = Number(all.salaries[at] ?? 0);
    const indirect = Number(all.indirect[at] ?? 0);
    const overhead = all.rent + all.utilities + salaries + indirect;

    const fabricPerPiece = all.unitsPerMeter > 0
      ? all.fabric / all.unitsPerMeter : 0;
    const overheadPerPiece = pieces > 0 ? overhead / pieces : 0;
    const costPerPiece = fabricPerPiece + overheadPerPiece;

    const revenue = produced.a * all.p_a + produced.b * all.p_b + produced.c * all.p_c;
    const cost = pieces * costPerPiece;

    return {
      month: at,
      pieces, metres, produced,
      overhead: { rent: all.rent, utilities: all.utilities, salaries, indirect, total: overhead },
      perPiece: {
        fabric: round(fabricPerPiece),
        overhead: round(overheadPerPiece),
        total: round(costPerPiece),
      },
      prices: {
        gradeAPlus: all.p_ap, gradeA: all.p_a, gradeB: all.p_b, gradeC: all.p_c,
      },
      revenue: round(revenue),
      cost: round(cost),
      margin: round(revenue - cost),
      /*
       * Said plainly rather than shown as a zero.
       *
       * A margin of zero because nobody entered the selling prices looks
       * exactly like a margin of zero because the month broke even.
       */
      pricesMissing: PRICE_KEYS.filter((k) => !Number(all[k])).length === PRICE_KEYS.length,
      noProduction: pieces === 0,
    };
  }

  /* -------------------------------------------------------- demand -- */

  /**
   * How much to make, from what has sold.
   *
   * 26 weeks of `NEW ORDER` rows give a weekly rate per item; the gap
   * between that rate and what is in WH-02 is what to plan for, with the
   * shortage, quality-check and waste allowances added on top.
   *
   * Those three allowances are why this is not simply "sales minus stock":
   * pieces go missing, pieces fail a check, and fabric is wasted, and a plan
   * that ignores all three is short by about a tenth every time.
   */
  async demandPlan(weeks = PLAN_WEEKS) {
    const all = await this.readAll();
    const [movements, balances] = await Promise.all([
      this.reader.movements({ limit: 40000 }),
      this.reader.balances(),
    ]);

    const since = DateTime.now().setZone(TZ).minus({ weeks }).startOf('day');
    const sold = new Map<string, number>();

    for (const m of movements) {
      if (m.kind !== 'NEW ORDER' || !m.stockOut) continue;
      if (!counts(m.warehouse)) continue;
      const d = parseSheetDate(m.date);
      if (!d || d < since) continue;
      sold.set(m.item, (sold.get(m.item) ?? 0) + m.stockOut);
    }

    const onHand = new Map<string, number>();
    for (const b of balances) {
      if (b.warehouse !== 'WH-02' || b.balance <= 0) continue;
      onHand.set(b.item, (onHand.get(b.item) ?? 0) + b.balance);
    }

    const allowance = 1
      + all.shortagePct / 100
      + all.checkPct / 100
      + all.wastePct / 100;

    const rows = [...sold.entries()]
      .map(([item, qty]) => {
        const perWeek = qty / weeks;
        const have = onHand.get(item) ?? 0;
        /* Eight weeks of cover: long enough to be worth cutting fabric for,
           short enough not to fill the warehouse. */
        const target = perWeek * 8;
        const gap = Math.max(0, target - have);
        const make = Math.ceil(gap * allowance);

        return {
          item,
          sold: qty,
          perWeek: round(perWeek),
          onHand: have,
          weeksOfCover: perWeek > 0 ? round(have / perWeek) : null,
          make,
          /* What that is in fabric, at the rate everything else uses. */
          metres: all.unitsPerMeter > 0 ? round(make / all.unitsPerMeter) : 0,
        };
      })
      .filter((r) => r.make > 0)
      .sort((a, b) => (a.weeksOfCover ?? 999) - (b.weeksOfCover ?? 999));

    return {
      weeks,
      allowance: {
        shortagePct: all.shortagePct,
        checkPct: all.checkPct,
        wastePct: all.wastePct,
        total: round((allowance - 1) * 100),
      },
      unitsPerMeter: all.unitsPerMeter,
      rows,
      totals: {
        pieces: rows.reduce((n, r) => n + r.make, 0),
        metres: round(rows.reduce((n, r) => n + r.metres, 0)),
      },
    };
  }

  /* -------------------------------------------------------- helpers -- */

  private monthOf(v: unknown): string {
    const d = parseSheetDate(v);
    return d ? d.toFormat('yyyy-LL') : '';
  }

}

/** Money and rates, to two places. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}