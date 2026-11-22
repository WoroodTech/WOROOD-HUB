/**
 * The workshop's own stages, inside a job order.
 *
 *   Cutting (metres) → In Production (lots) → Workshop Quality (count)
 *   → handed to the warehouse
 *
 * This sits alongside the roll cycle rather than replacing any of it: a job
 * order is still issued and still closed the same way. What this adds is
 * where the work is *between* those two, which is the question the workshop
 * is asked all day and the register cannot answer.
 *
 * A lot is the unit. Cutting releases metres as a lot; production sends a lot
 * on with a quantity; quality counts it and the difference between what
 * production said and what quality counted is kept, not reconciled away.
 */
import {
  BadRequestException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import { Principal } from '../../common/auth';
import { AuditService } from '../../core/core.module';
import { WarehouseSheetClient } from './sheets/warehouse-sheet.client';
import { sheetDate } from './sheets/parse-date';

const TZ = 'Africa/Cairo';

export const STAGES_TAB = 'Rolls Stages';
export const LOTS_TAB = 'Rolls Lots';

/** One row per job order: when cutting started, how many metres, when it ended. */
export const STAGES = {
  operationOrder: 0, cutStartAt: 1, cutStartBy: 2, cutMeters: 3, cutEndAt: 4,
} as const;

/** One row per lot of metres released from cutting. */
export const LOTS = {
  lot: 0, operationOrder: 1, meters: 2,
  cutAt: 3, cutBy: 4,
  productionQty: 5, sentAt: 6, sentBy: 7,
  qualityCount: 8, qualityAt: 9, qualityBy: 10,
  difference: 11, status: 12,
  toWarehouseAt: 13, toWarehouseBy: 14, note: 15,
} as const;

/**
 * A lot's states.
 *
 * `Cut` means the metres are released and nobody has made anything from them
 * yet; `In production` that a quantity has been claimed; `Counted` that
 * quality has checked it; `With warehouse` that it has been handed over.
 */
export const LOT_STATUS = ['Cut', 'In production', 'Counted', 'With warehouse'] as const;
export type LotStatus = (typeof LOT_STATUS)[number];

const LOT_NEXT: Record<LotStatus, LotStatus[]> = {
  Cut: ['In production'],
  'In production': ['Counted'],
  Counted: ['With warehouse'],
  'With warehouse': [],
};

@Injectable()
export class WarehouseStagesService {
  private readonly log = new Logger('WarehouseStages');

  constructor(
    private readonly sheet: WarehouseSheetClient,
    private readonly audit: AuditService,
  ) {}

  /* ---------------------------------------------------------- reads -- */

  /** Where every lot of one job order is. */
  async lots(operationOrder?: string) {
    const rows = await this.readLots();
    const want = operationOrder?.trim().toLowerCase();
    const out: any[] = [];

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] ?? [];
      const oo = String(r[LOTS.operationOrder] ?? '').trim();
      if (!oo) continue;
      if (want && oo.toLowerCase() !== want) continue;

      out.push({
        rowNumber: i + 1,
        lot: num(r[LOTS.lot]),
        operationOrder: oo,
        meters: num(r[LOTS.meters]),
        cutAt: r[LOTS.cutAt] ?? '', cutBy: String(r[LOTS.cutBy] ?? '').trim(),
        productionQty: num(r[LOTS.productionQty]),
        sentAt: r[LOTS.sentAt] ?? '', sentBy: String(r[LOTS.sentBy] ?? '').trim(),
        qualityCount: num(r[LOTS.qualityCount]),
        qualityAt: r[LOTS.qualityAt] ?? '', qualityBy: String(r[LOTS.qualityBy] ?? '').trim(),
        /* What production claimed, less what quality counted. Negative means
           pieces went missing between the two; it stays visible. */
        difference: num(r[LOTS.difference]),
        status: String(r[LOTS.status] ?? '').trim(),
        toWarehouseAt: r[LOTS.toWarehouseAt] ?? '',
        toWarehouseBy: String(r[LOTS.toWarehouseBy] ?? '').trim(),
        note: String(r[LOTS.note] ?? '').trim(),
      });
    }

    return out.sort((a, b) => a.lot - b.lot);
  }

  /** The cutting record for one job order, if it has started. */
  async stage(operationOrder: string) {
    const rows = await this.readStages();
    const want = operationOrder.trim().toLowerCase();

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] ?? [];
      if (String(r[STAGES.operationOrder] ?? '').trim().toLowerCase() !== want) continue;
      return {
        rowNumber: i + 1,
        operationOrder: String(r[STAGES.operationOrder] ?? '').trim(),
        cutStartAt: r[STAGES.cutStartAt] ?? '',
        cutStartBy: String(r[STAGES.cutStartBy] ?? '').trim(),
        cutMeters: num(r[STAGES.cutMeters]),
        cutEndAt: r[STAGES.cutEndAt] ?? '',
      };
    }
    return null;
  }

  /**
   * One job order's whole workshop picture.
   *
   * The cutting record plus every lot, with the totals that say whether it
   * adds up — because the question is never about one lot, it is whether the
   * order is on track.
   */
  async overview(operationOrder: string) {
    const [stage, lots] = await Promise.all([
      this.stage(operationOrder), this.lots(operationOrder),
    ]);

    return {
      operationOrder,
      stage,
      lots,
      totals: {
        metersCut: lots.reduce((n, l) => n + l.meters, 0),
        produced: lots.reduce((n, l) => n + l.productionQty, 0),
        counted: lots.reduce((n, l) => n + l.qualityCount, 0),
        /* Across the order, not per lot: a lot short here and a lot over
           there is a counting problem, not a loss. */
        difference: lots.reduce((n, l) => n + l.difference, 0),
        withWarehouse: lots.filter((l) => l.status === 'With warehouse').length,
        open: lots.filter((l) => l.status !== 'With warehouse').length,
      },
    };
  }

  /* --------------------------------------------------------- writes -- */

  /** Start cutting on a job order. */
  async startCutting(p: Principal, operationOrder: string) {
    const oo = String(operationOrder ?? '').trim();
    if (!oo) throw new BadRequestException('Which operation order?');

    const already = await this.stage(oo);
    if (already?.cutStartAt) {
      throw new BadRequestException(
        `Cutting on ${oo} already started, by ${already.cutStartBy || 'somebody'}.`);
    }

    const row = new Array(STAGES.cutEndAt + 1).fill('');
    row[STAGES.operationOrder] = WarehouseSheetClient.safe(oo);
    row[STAGES.cutStartAt] = sheetDate(DateTime.now().setZone(TZ));
    row[STAGES.cutStartBy] = WarehouseSheetClient.safe(who(p));

    await this.sheet.append(STAGES_TAB, row);
    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.stages.cutStart',
      entityType: 'warehouse_job_order', entityId: oo, payload: {},
    });

    return { ok: true };
  }

  /**
   * Release a lot of metres from cutting.
   *
   * Each release is its own lot, numbered in order, because production and
   * quality track what they are holding by lot — and a single running total
   * of metres would leave nothing for them to point at.
   */
  async releaseLot(p: Principal, dto: {
    operationOrder: string; meters: number; note?: string;
  }) {
    const oo = String(dto.operationOrder ?? '').trim();
    const stage = await this.stage(oo);
    if (!stage?.cutStartAt) {
      throw new BadRequestException(`Cutting on ${oo} has not started.`);
    }
    if (stage.cutEndAt) {
      throw new BadRequestException(`Cutting on ${oo} is finished.`);
    }

    const meters = Number(dto.meters);
    if (!Number.isFinite(meters) || meters <= 0) {
      throw new BadRequestException('Enter how many metres this lot holds.');
    }

    const existing = await this.lots(oo);
    const lot = existing.reduce((m, l) => Math.max(m, l.lot), 0) + 1;

    const row = new Array(LOTS.note + 1).fill('');
    row[LOTS.lot] = lot;
    row[LOTS.operationOrder] = WarehouseSheetClient.safe(oo);
    row[LOTS.meters] = meters;
    row[LOTS.cutAt] = sheetDate(DateTime.now().setZone(TZ));
    row[LOTS.cutBy] = WarehouseSheetClient.safe(who(p));
    row[LOTS.status] = 'Cut';
    row[LOTS.note] = WarehouseSheetClient.safe(dto.note ?? '');

    await this.sheet.append(LOTS_TAB, row);

    /* The running total on the stage row, so the order's cut metres can be
       read without walking every lot. */
    const total = existing.reduce((n, l) => n + l.meters, 0) + meters;
    await this.sheet.write(
      STAGES_TAB, `D${stage.rowNumber}:D${stage.rowNumber}`, [[total]]);

    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.stages.lotCut',
      entityType: 'warehouse_job_order', entityId: oo, payload: { lot, meters },
    });

    return { ok: true, lot };
  }

  /** Cutting is done on this order; no more lots. */
  async endCutting(p: Principal, operationOrder: string) {
    const oo = String(operationOrder ?? '').trim();
    const stage = await this.stage(oo);
    if (!stage?.cutStartAt) {
      throw new BadRequestException(`Cutting on ${oo} has not started.`);
    }
    if (stage.cutEndAt) {
      throw new BadRequestException(`Cutting on ${oo} is already finished.`);
    }
    if (!(await this.lots(oo)).length) {
      /* Finishing with nothing cut means the metres went somewhere this
         cannot show — better asked about now than reconciled later. */
      throw new BadRequestException(
        `No lots were released on ${oo}, so there is nothing to finish.`);
    }

    await this.sheet.write(STAGES_TAB, `E${stage.rowNumber}:E${stage.rowNumber}`,
      [[sheetDate(DateTime.now().setZone(TZ))]]);

    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.stages.cutEnd',
      entityType: 'warehouse_job_order', entityId: oo, payload: {},
    });

    return { ok: true };
  }

  /** Production claims a quantity made from a lot. */
  async sendToQuality(p: Principal, dto: {
    operationOrder: string; lot: number; quantity: number; note?: string;
  }) {
    const lot = await this.mustFindLot(dto.operationOrder, dto.lot);
    this.assertCanMoveTo(lot, 'In production');

    const qty = whole(dto.quantity, 'The quantity');
    if (qty < 1) throw new BadRequestException('Enter how many pieces were made.');

    const at = lot.rowNumber;
    await this.sheet.write(LOTS_TAB, `F${at}:H${at}`, [[
      qty, sheetDate(DateTime.now().setZone(TZ)), WarehouseSheetClient.safe(who(p)),
    ]]);
    await this.sheet.write(LOTS_TAB, `M${at}:M${at}`, [['In production']]);
    if (dto.note) {
      await this.sheet.write(LOTS_TAB, `P${at}:P${at}`,
        [[WarehouseSheetClient.safe(dto.note)]]);
    }

    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.stages.prodSend',
      entityType: 'warehouse_job_order', entityId: lot.operationOrder,
      payload: { lot: lot.lot, quantity: qty },
    });

    return { ok: true };
  }

  /**
   * Workshop quality counts a lot.
   *
   * The difference between what production claimed and what quality counted
   * is written and kept. It is not an error to be argued down to one figure:
   * it is the measurement, and it is what tells anybody later whether pieces
   * went missing between the two benches.
   */
  async count(p: Principal, dto: {
    operationOrder: string; lot: number; counted: number; note?: string;
  }) {
    const lot = await this.mustFindLot(dto.operationOrder, dto.lot);
    this.assertCanMoveTo(lot, 'Counted');

    const counted = whole(dto.counted, 'The count');
    const difference = counted - lot.productionQty;

    const at = lot.rowNumber;
    await this.sheet.write(LOTS_TAB, `I${at}:L${at}`, [[
      counted, sheetDate(DateTime.now().setZone(TZ)),
      WarehouseSheetClient.safe(who(p)), difference,
    ]]);
    await this.sheet.write(LOTS_TAB, `M${at}:M${at}`, [['Counted']]);
    if (dto.note) {
      await this.sheet.write(LOTS_TAB, `P${at}:P${at}`,
        [[WarehouseSheetClient.safe(dto.note)]]);
    }

    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.stages.qCount',
      entityType: 'warehouse_job_order', entityId: lot.operationOrder,
      payload: {
        lot: lot.lot, counted, productionSaid: lot.productionQty, difference,
      },
    });

    return { ok: true, difference };
  }

  /**
   * Hand a counted lot to the warehouse.
   *
   * This records the handover and nothing else. The stock itself arrives
   * through the job order's batch receive, which is where it is counted
   * against the ledger — two paths writing the same pieces would double
   * them.
   */
  async handOver(p: Principal, dto: {
    operationOrder: string; lot: number; note?: string;
  }) {
    const lot = await this.mustFindLot(dto.operationOrder, dto.lot);
    this.assertCanMoveTo(lot, 'With warehouse');

    const at = lot.rowNumber;
    await this.sheet.write(LOTS_TAB, `N${at}:O${at}`, [[
      sheetDate(DateTime.now().setZone(TZ)), WarehouseSheetClient.safe(who(p)),
    ]]);
    await this.sheet.write(LOTS_TAB, `M${at}:M${at}`, [['With warehouse']]);

    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.stages.qSend',
      entityType: 'warehouse_job_order', entityId: lot.operationOrder,
      /*
       * The real caller, never a fixed role.
       *
       * `Stages.gs` passes a hardcoded 'Admin' into the ledger posting here,
       * so every handover is recorded as an administrator's whatever the
       * workshop account actually was. The audit trail is worth less than
       * nothing when it names the wrong person.
       */
      payload: { lot: lot.lot, counted: lot.qualityCount },
    });

    return { ok: true };
  }

  /* --------------------------------------------------------- helpers -- */

  /**
   * The tabs are created on first use by the Apps Script, so they may not
   * exist yet. A missing tab reads as empty rather than as an error: there
   * being no lots and the tab not existing are the same thing to anybody
   * asking what is in production.
   */
  private async readLots(): Promise<any[][]> {
    try { return await this.sheet.read(LOTS_TAB); } catch { return [[]]; }
  }

  private async readStages(): Promise<any[][]> {
    try { return await this.sheet.read(STAGES_TAB); } catch { return [[]]; }
  }

  private async mustFindLot(operationOrder: string, lotNumber: number) {
    const lots = await this.lots(operationOrder);
    const lot = lots.find((l) => l.lot === Number(lotNumber));
    if (!lot) {
      throw new NotFoundException(
        `Lot ${lotNumber} is not on ${operationOrder}.`);
    }
    return lot;
  }

  private assertCanMoveTo(lot: any, next: LotStatus) {
    const now = lot.status as LotStatus;

    if (!LOT_STATUS.includes(now)) {
      throw new BadRequestException(
        `Lot ${lot.lot} has an unexpected status in the sheet ("${lot.status}"), `
        + 'so nothing here can move it.');
    }
    if (!(LOT_NEXT[now] ?? []).includes(next)) {
      throw new BadRequestException(
        `Lot ${lot.lot} is "${now}" and cannot go straight to "${next}".`);
    }
  }
}


function who(p: Principal): string { return p.fullName ?? p.email ?? ''; }

function num(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function whole(v: unknown, what: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new BadRequestException(`${what} must be a whole number, 0 or more.`);
  }
  return n;
}