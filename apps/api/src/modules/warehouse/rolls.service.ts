/**
 * The fabric-roll cycle.
 *
 *   Received → Planned → Issued → Reported → Delivered → Closed
 *
 * A roll arrives, gets planned into a job order, goes to the workshop, comes
 * back as reported production, is received into stock, and the order is
 * closed. Each step belongs to a different part of the business, and the
 * permission for each is separate for that reason.
 *
 * The arithmetic rules are the Apps Script's own, and they matter: a job
 * order whose grades do not add up to its total is a count nobody can
 * reconcile against the fabric that went in.
 */
import {
  BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import { Principal } from '../../common/auth';
import { AuditService } from '../../core/core.module';
import { WarehouseSheetClient } from './sheets/warehouse-sheet.client';
import { WarehouseReaderService } from './sheets/warehouse-reader.service';
import { sheetDate } from './sheets/parse-date';
import { SETTINGS_TAB } from './costing.service';
import {
  ROLL_NEXT, ROLL_STATUS, RollStatus,
  ROLLS_BATCHES, ROLLS_BATCHES_TAB,
  ROLLS_REGISTER, ROLLS_REGISTER_TAB,
  ROLLS_WORKSHOP, ROLLS_WORKSHOP_TAB,
} from './sheets/tabs';

const TZ = 'Africa/Cairo';

export interface Roll {
  rowNumber: number;
  rollId: string;
  rollCode: string;
  rollName: string;
  ctn: string;
  /** The purchase order it arrived against — the sheet's P.O of Q.D. */
  poNumber: string;
  meters: number;
  received: string | number;
  receivedBy: string;
  status: RollStatus | string;
  planPriority: string;
  plannedDate: string | number;
  planNote: string;
  operationOrder: string;
  expectedUnits: number;
  note: string;
}

export interface JobOrder {
  rowNumber: number;
  operationOrder: string;
  issued: string | number;
  issuedBy: string;
  rolls: number;
  meters: number;
  expectedUnits: number;
  gradeA: number;
  gradeB: number;
  fabricationWaste: number;
  materialWaste: number;
  dryClean: number;
  delivered: string | number;
  deliveredBy: string;
  variance: number;
  status: string;
  note: string;
  rollIds: string;
}

@Injectable()
export class WarehouseRollsService {
  private readonly log = new Logger('WarehouseRolls');

  constructor(
    private readonly sheet: WarehouseSheetClient,
    private readonly reader: WarehouseReaderService,
    private readonly audit: AuditService,
  ) {}

  /* ---------------------------------------------------------- reads -- */

  /** Every roll in the register. */
  async rolls(filter: { status?: string; operationOrder?: string } = {}): Promise<Roll[]> {
    const rows = await this.sheet.read(ROLLS_REGISTER_TAB);
    const out: Roll[] = [];

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] ?? [];
      const rollId = String(r[ROLLS_REGISTER.rollId] ?? '').trim();
      if (!rollId) continue;

      const roll: Roll = {
        rowNumber: i + 1,
        rollId,
        rollCode: String(r[ROLLS_REGISTER.rollCode] ?? '').trim(),
        rollName: String(r[ROLLS_REGISTER.rollName] ?? '').trim(),
        ctn: String(r[ROLLS_REGISTER.ctn] ?? '').trim(),
        poNumber: String(r[ROLLS_REGISTER.poNumber] ?? '').trim(),
        meters: num(r[ROLLS_REGISTER.meters]),
        received: r[ROLLS_REGISTER.received] ?? '',
        receivedBy: String(r[ROLLS_REGISTER.receivedBy] ?? '').trim(),
        status: String(r[ROLLS_REGISTER.status] ?? '').trim(),
        planPriority: String(r[ROLLS_REGISTER.planPriority] ?? '').trim(),
        plannedDate: r[ROLLS_REGISTER.plannedDate] ?? '',
        planNote: String(r[ROLLS_REGISTER.planNote] ?? '').trim(),
        operationOrder: String(r[ROLLS_REGISTER.operationOrder] ?? '').trim(),
        expectedUnits: num(r[ROLLS_REGISTER.expectedUnits]),
        note: String(r[ROLLS_REGISTER.note] ?? '').trim(),
      };

      if (filter.status && roll.status !== filter.status) continue;
      if (filter.operationOrder && roll.operationOrder !== filter.operationOrder) continue;
      out.push(roll);
    }

    return out;
  }

  /** Every job order. */
  async jobOrders(filter: { status?: string } = {}): Promise<JobOrder[]> {
    const rows = await this.sheet.read(ROLLS_WORKSHOP_TAB);
    const out: JobOrder[] = [];

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] ?? [];
      const oo = String(r[ROLLS_WORKSHOP.operationOrder] ?? '').trim();
      if (!oo) continue;

      const job: JobOrder = {
        rowNumber: i + 1,
        operationOrder: oo,
        issued: r[ROLLS_WORKSHOP.issued] ?? '',
        issuedBy: String(r[ROLLS_WORKSHOP.issuedBy] ?? '').trim(),
        rolls: num(r[ROLLS_WORKSHOP.rolls]),
        meters: num(r[ROLLS_WORKSHOP.meters]),
        expectedUnits: num(r[ROLLS_WORKSHOP.expectedUnits]),
        gradeA: num(r[ROLLS_WORKSHOP.gradeA]),
        gradeB: num(r[ROLLS_WORKSHOP.gradeB]),
        fabricationWaste: num(r[ROLLS_WORKSHOP.fabricationWaste]),
        materialWaste: num(r[ROLLS_WORKSHOP.materialWaste]),
        dryClean: num(r[ROLLS_WORKSHOP.dryClean]),
        delivered: r[ROLLS_WORKSHOP.delivered] ?? '',
        deliveredBy: String(r[ROLLS_WORKSHOP.deliveredBy] ?? '').trim(),
        variance: num(r[ROLLS_WORKSHOP.variance]),
        status: String(r[ROLLS_WORKSHOP.status] ?? '').trim(),
        note: String(r[ROLLS_WORKSHOP.note] ?? '').trim(),
        rollIds: String(r[ROLLS_WORKSHOP.rollIds] ?? '').trim(),
      };

      if (filter.status && job.status !== filter.status) continue;
      out.push(job);
    }

    return out;
  }

  /** The batches reported against one job order. */
  async batches(operationOrder: string) {
    const rows = await this.sheet.read(ROLLS_BATCHES_TAB);
    const want = operationOrder.trim().toLowerCase();
    const out: any[] = [];

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] ?? [];
      const oo = String(r[ROLLS_BATCHES.operationOrder] ?? '').trim();
      if (oo.toLowerCase() !== want) continue;

      out.push({
        rowNumber: i + 1,
        operationOrder: oo,
        batch: num(r[ROLLS_BATCHES.batch]),
        reportedAt: r[ROLLS_BATCHES.reportedAt] ?? '',
        reportedBy: String(r[ROLLS_BATCHES.reportedBy] ?? '').trim(),
        /* What the workshop said, and what the warehouse counted. Both are
           kept: the difference is the thing worth looking at. */
        workshop: {
          total: num(r[ROLLS_BATCHES.workshopTotal]),
          a: num(r[ROLLS_BATCHES.workshopA]),
          b: num(r[ROLLS_BATCHES.workshopB]),
          c: num(r[ROLLS_BATCHES.workshopC]),
          global: num(r[ROLLS_BATCHES.workshopGlobal]),
          note: String(r[ROLLS_BATCHES.workshopNote] ?? '').trim(),
        },
        received: {
          on: r[ROLLS_BATCHES.receivedOn] ?? '',
          by: String(r[ROLLS_BATCHES.receivedBy] ?? '').trim(),
          a: num(r[ROLLS_BATCHES.receivedA]),
          b: num(r[ROLLS_BATCHES.receivedB]),
          c: num(r[ROLLS_BATCHES.receivedC]),
          global: num(r[ROLLS_BATCHES.receivedGlobal]),
          note: String(r[ROLLS_BATCHES.receivingNote] ?? '').trim(),
        },
        status: String(r[ROLLS_BATCHES.status] ?? '').trim(),
        fullyDelivered: !!r[ROLLS_BATCHES.fullyDelivered],
      });
    }

    return out.sort((a, b) => a.batch - b.batch);
  }

  /* --------------------------------------------------------- writes -- */

  /**
   * Record a roll arriving.
   *
   * The roll id is given rather than generated: rolls come with a code on the
   * physical carton, and inventing a second identifier for the same object is
   * how two systems end up disagreeing about which roll is which.
   */
  async receive(p: Principal, dto: {
    rollId: string; rollCode?: string; rollName?: string;
    ctn?: string; meters: number; note?: string;
    /** The purchase order the roll arrived against — the sheet's P.O of Q.D. */
    poNumber?: string;
  }) {
    const rollId = String(dto.rollId ?? '').trim();
    if (!rollId) throw new BadRequestException('Enter the roll id.');

    const meters = Number(dto.meters);
    if (!Number.isFinite(meters) || meters <= 0) {
      throw new BadRequestException('Enter how many metres the roll holds.');
    }

    const existing = (await this.rolls()).find(
      (r) => r.rollId.toLowerCase() === rollId.toLowerCase());
    if (existing) {
      throw new BadRequestException(
        `${rollId} is already in the register, received by `
        + `${existing.receivedBy || 'somebody'} and currently ${existing.status}.`);
    }

    const row = new Array(ROLLS_REGISTER.poNumber + 1).fill('');
    row[ROLLS_REGISTER.rollId] = WarehouseSheetClient.safe(rollId);
    row[ROLLS_REGISTER.rollCode] = WarehouseSheetClient.safe(dto.rollCode ?? '');
    row[ROLLS_REGISTER.rollName] = WarehouseSheetClient.safe(dto.rollName ?? '');
    row[ROLLS_REGISTER.ctn] = WarehouseSheetClient.safe(dto.ctn ?? '');
    row[ROLLS_REGISTER.meters] = meters;
    row[ROLLS_REGISTER.received] = sheetDate(DateTime.now().setZone(TZ));
    row[ROLLS_REGISTER.receivedBy] = WarehouseSheetClient.safe(who(p));
    row[ROLLS_REGISTER.status] = 'Received';
    row[ROLLS_REGISTER.note] = WarehouseSheetClient.safe(dto.note ?? '');
    /* The column the row already reached and nothing ever filled: a roll
       received with no purchase order on it cannot be matched to what was
       ordered or to what the supplier invoiced. */
    row[ROLLS_REGISTER.poNumber] = WarehouseSheetClient.safe(dto.poNumber ?? '');

    await this.sheet.append(ROLLS_REGISTER_TAB, row);
    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.rolls.receive',
      entityType: 'warehouse_roll', entityId: rollId, payload: { meters },
    });

    return { ok: true, rollId };
  }

  /**
   * Set a roll's priority and planned date.
   *
   * Planning does not move fabric, so it is the one step that can be undone
   * freely — a priority is a statement of intent, and intent changes.
   */
  async plan(p: Principal, dto: {
    rollId: string; priority?: string; plannedDate?: string; note?: string;
  }) {
    const roll = await this.mustFind(dto.rollId);
    this.assertCanMoveTo(roll, 'Planned');

    const at = roll.rowNumber;
    await this.sheet.write(ROLLS_REGISTER_TAB, `I${at}:K${at}`, [[
      WarehouseSheetClient.safe(dto.priority ?? ''),
      dto.plannedDate ? sheetDate(DateTime.fromISO(dto.plannedDate, { zone: TZ })) : '',
      WarehouseSheetClient.safe(dto.note ?? ''),
    ]]);
    await this.setStatus(roll, 'Planned');

    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.rolls.plan',
      entityType: 'warehouse_roll', entityId: roll.rollId,
      payload: { priority: dto.priority ?? null },
    });

    return { ok: true };
  }

  /**
   * Send rolls to the workshop as one job order.
   *
   * Several rolls at once, because that is how fabric is cut — and the job
   * order is what everything afterwards is reported against.
   */
  async issue(p: Principal, dto: {
    rollIds: string[]; note?: string;
  }) {
    /*
     * The warehouse hands rolls over; it does not open a job order.
     *
     * One paper, one serial (W.R 002), several rolls — and no operation
     * number on it, because the workshop assigns J.O 001 when it picks a
     * roll up. That is the Apps Script's own note on `rlIssue_`, and the
     * portal had the warehouse typing a job order for work it does not do.
     */
    const ids = (dto.rollIds ?? []).map((s) => String(s).trim()).filter(Boolean);
    if (!ids.length) throw new BadRequestException('Choose at least one roll.');
    /* One lorry, one paper. Thirty is the Apps Script's own ceiling. */
    if (ids.length > 30) {
      throw new BadRequestException('Thirty rolls at most on one paper.');
    }

    const all = await this.rolls();
    const chosen: Roll[] = [];
    for (const id of ids) {
      const roll = all.find((r) => r.rollId.toLowerCase() === id.toLowerCase());
      if (!roll) throw new NotFoundException(`${id} is not in the register.`);
      this.assertCanMoveTo(roll, 'Handed over');
      chosen.push(roll);
    }

    for (const roll of chosen) await this.setStatus(roll, 'Handed over');

    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.rolls.issue',
      entityType: 'warehouse_roll', entityId: chosen.map((r) => r.rollId).join(', '),
      payload: { rolls: chosen.length, note: dto.note ?? '' },
    });

    return { ok: true, rolls: chosen.length };
  }

  /**
   * The workshop picks up one roll and opens a job order on it.
   *
   * The number and the expected pieces are both worked out rather than
   * typed: `J.O 001` is the next in the series, and the pieces are the
   * roll's metres times what a metre yields. Asking the workshop for either
   * invites a guess, and both are checked against later.
   */
  async startJobOrder(p: Principal, dto: { rollId: string; note?: string }) {
    const roll = await this.mustFind(dto.rollId);
    this.assertCanMoveTo(roll, 'Issued');

    /*
     * `unitsPerMeter` read from the settings tab, not from the costing
     * service.
     *
     * Costing already injects this service to price a job order, so taking
     * it as a dependency here would be a cycle Nest refuses at boot. The
     * constant is one cell, and both read it from the same place.
     */
    const [jobs, settings] = await Promise.all([
      this.jobOrders(), this.planSettings(),
    ]);

    /* The next in the series, by the highest number already used. */
    let highest = 0;
    for (const j of jobs) {
      const m = /^J\.O\s*(\d+)$/i.exec(j.operationOrder.trim());
      if (m) highest = Math.max(highest, Number(m[1]));
    }
    const next = String(highest + 1);
    const oo = `J.O ${next.padStart(Math.max(3, next.length), '0')}`;

    const metres = Number(roll.meters) || 0;
    const expected = Math.round(metres * (settings.unitsPerMeter || 0));

    const row = new Array(ROLLS_WORKSHOP.flag + 1).fill('');
    row[ROLLS_WORKSHOP.operationOrder] = WarehouseSheetClient.safe(oo);
    row[ROLLS_WORKSHOP.issued] = sheetDate(DateTime.now().setZone(TZ));
    row[ROLLS_WORKSHOP.issuedBy] = WarehouseSheetClient.safe(who(p));
    row[ROLLS_WORKSHOP.rolls] = 1;
    row[ROLLS_WORKSHOP.meters] = Math.round(metres * 100) / 100;
    row[ROLLS_WORKSHOP.expectedUnits] = expected;
    row[ROLLS_WORKSHOP.status] = 'At workshop';
    row[ROLLS_WORKSHOP.note] = WarehouseSheetClient.safe(dto.note ?? '');
    row[ROLLS_WORKSHOP.rollIds] = WarehouseSheetClient.safe(roll.rollId);

    await this.sheet.append(ROLLS_WORKSHOP_TAB, row);

    /* The roll carries its job order and what is expected off it, so the
       register alone answers "where is this roll and what for". */
    const at = roll.rowNumber;
    await this.sheet.write(ROLLS_REGISTER_TAB, `L${at}:N${at}`, [[
      WarehouseSheetClient.safe(oo),
      sheetDate(DateTime.now().setZone(TZ)),
      expected,
    ]]);
    await this.setStatus(roll, 'Issued');

    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.rolls.start',
      entityType: 'warehouse_job_order', entityId: oo,
      payload: { rollId: roll.rollId, metres, expected },
    });

    return { ok: true, operationOrder: oo, expectedUnits: expected };
  }

  /**
   * The workshop reports what it produced.
   *
   * Reported in batches, because production finishes in batches. The
   * arithmetic is the Apps Script's and it is strict for good reason: a batch
   * whose grades do not add up to its total cannot be reconciled against the
   * fabric that went in, and nobody will notice until the fabric is gone.
   */
  async report(p: Principal, dto: {
    operationOrder: string;
    total: number; gradeA: number; gradeB: number; gradeC: number;
    global?: number; note?: string;
  }) {
    const job = await this.mustFindJob(dto.operationOrder);
    if (job.status !== 'At workshop') {
      throw new BadRequestException(
        `${job.operationOrder} is ${job.status} — no more batches can be reported.`);
    }

    const total = whole(dto.total, 'the total');
    const a = whole(dto.gradeA, 'Grade A');
    const b = whole(dto.gradeB, 'Grade B');
    const c = whole(dto.gradeC, 'Grade C');
    const global = whole(dto.global ?? 0, 'Global');

    if (total < 1) throw new BadRequestException('Enter the total produced.');
    if (a + b + c !== total) {
      throw new BadRequestException(
        `The total (${total}) must equal A + B + C (${a + b + c}).`);
    }
    if (global > a) {
      /* Global is a subset of Grade A, not a fourth grade. */
      throw new BadRequestException(
        `Global (${global}) cannot be more than Grade A (${a}).`);
    }

    const existing = await this.batches(job.operationOrder);
    if (existing.some((x) => x.fullyDelivered)) {
      throw new BadRequestException(
        `${job.operationOrder} was already marked fully delivered.`);
    }

    const batch = existing.reduce((m, x) => Math.max(m, x.batch), 0) + 1;

    const row = new Array(ROLLS_BATCHES.fullyDelivered + 1).fill('');
    row[ROLLS_BATCHES.operationOrder] = WarehouseSheetClient.safe(job.operationOrder);
    row[ROLLS_BATCHES.batch] = batch;
    row[ROLLS_BATCHES.reportedAt] = sheetDate(DateTime.now().setZone(TZ));
    row[ROLLS_BATCHES.reportedBy] = WarehouseSheetClient.safe(who(p));
    row[ROLLS_BATCHES.workshopTotal] = total;
    row[ROLLS_BATCHES.workshopA] = a;
    row[ROLLS_BATCHES.workshopB] = b;
    row[ROLLS_BATCHES.workshopC] = c;
    row[ROLLS_BATCHES.workshopGlobal] = global;
    row[ROLLS_BATCHES.workshopNote] = WarehouseSheetClient.safe(dto.note ?? '');
    row[ROLLS_BATCHES.status] = 'Reported';

    await this.sheet.append(ROLLS_BATCHES_TAB, row);

    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.rolls.report',
      entityType: 'warehouse_job_order', entityId: job.operationOrder,
      payload: { batch, total, a, b, c, global },
    });

    return { ok: true, batch };
  }

  /**
   * The warehouse receives a reported batch.
   *
   * What it counts can differ from what the workshop said, and both numbers
   * are kept. The difference is not an error to be resolved into one figure —
   * it is the thing anybody reviewing this wants to see.
   */
  async receiveBatch(p: Principal, dto: {
    operationOrder: string; batch: number;
    gradeA: number; gradeB: number; gradeC: number;
    global?: number; note?: string; fullyDelivered?: boolean;
  }) {
    const batches = await this.batches(dto.operationOrder);
    const row = batches.find((x) => x.batch === Number(dto.batch));
    if (!row) throw new NotFoundException('That batch is not there.');
    if (row.status !== 'Reported') {
      throw new BadRequestException(
        `Batch ${row.batch} is already ${row.status.toLowerCase()}.`);
    }

    const a = whole(dto.gradeA, 'Grade A');
    const b = whole(dto.gradeB, 'Grade B');
    const c = whole(dto.gradeC, 'Grade C');
    const global = whole(dto.global ?? 0, 'Global');
    if (global > a) {
      throw new BadRequestException(
        `Global (${global}) cannot be more than Grade A (${a}).`);
    }

    const at = row.rowNumber;
    await this.sheet.write(ROLLS_BATCHES_TAB, `K${at}:P${at}`, [[
      sheetDate(DateTime.now().setZone(TZ)),
      WarehouseSheetClient.safe(who(p)),
      a, b, c,
      WarehouseSheetClient.safe(dto.note ?? ''),
    ]]);
    await this.sheet.write(ROLLS_BATCHES_TAB, `J${at}:J${at}`, [['Received']]);
    await this.sheet.write(ROLLS_BATCHES_TAB, `S${at}:T${at}`, [[
      global, dto.fullyDelivered ? 1 : '',
    ]]);

    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.rolls.receiveBatch',
      entityType: 'warehouse_job_order', entityId: row.operationOrder,
      payload: {
        batch: row.batch, a, b, c, global,
        /* Recorded explicitly: a quiet discrepancy is the one that costs
           somebody a day reconciling later. */
        workshopSaid: row.workshop, difference: {
          a: a - row.workshop.a, b: b - row.workshop.b, c: c - row.workshop.c,
        },
      },
    });

    return {
      ok: true,
      difference: {
        a: a - row.workshop.a, b: b - row.workshop.b, c: c - row.workshop.c,
      },
    };
  }

  /**
   * Close a job order.
   *
   * Only once every batch has been received: closing with a batch still
   * outstanding loses whatever the workshop is holding, and the register has
   * no way to show it again.
   */
  async close(p: Principal, operationOrder: string, note?: string) {
    const job = await this.mustFindJob(operationOrder);
    if (job.status === 'Closed') {
      throw new BadRequestException(`${job.operationOrder} is already closed.`);
    }

    const batches = await this.batches(job.operationOrder);
    const open = batches.filter((b) => b.status !== 'Received');
    if (open.length) {
      throw new BadRequestException(
        `${open.length} batch${open.length === 1 ? '' : 'es'} on `
        + `${job.operationOrder} ${open.length === 1 ? 'has' : 'have'} not been `
        + 'received yet. Receive them before closing it.');
    }

    const delivered = batches.reduce((n, b) => n + b.received.a + b.received.b + b.received.c, 0);
    const at = job.rowNumber;

    await this.sheet.write(ROLLS_WORKSHOP_TAB, `L${at}:P${at}`, [[
      sheetDate(DateTime.now().setZone(TZ)),
      WarehouseSheetClient.safe(who(p)),
      /* Variance against what was expected when the fabric went out — the
         one number that says whether the order went well. */
      delivered - job.expectedUnits,
      'Closed',
      WarehouseSheetClient.safe(note ?? job.note),
    ]]);

    for (const roll of await this.rolls({ operationOrder: job.operationOrder })) {
      await this.setStatus(roll, 'Closed');
    }

    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.rolls.close',
      entityType: 'warehouse_job_order', entityId: job.operationOrder,
      payload: { delivered, expected: job.expectedUnits, variance: delivered - job.expectedUnits },
    });

    return { ok: true, delivered, variance: delivered - job.expectedUnits };
  }

  /* --------------------------------------------------------- helpers -- */

  private async mustFind(rollId: string): Promise<Roll> {
    const id = String(rollId ?? '').trim();
    if (!id) throw new BadRequestException('Which roll?');
    const roll = (await this.rolls()).find(
      (r) => r.rollId.toLowerCase() === id.toLowerCase());
    if (!roll) throw new NotFoundException(`${id} is not in the register.`);
    return roll;
  }

  private async mustFindJob(operationOrder: string): Promise<JobOrder> {
    const oo = String(operationOrder ?? '').trim();
    if (!oo) throw new BadRequestException('Which operation order?');
    const job = (await this.jobOrders()).find(
      (j) => j.operationOrder.toLowerCase() === oo.toLowerCase());
    if (!job) throw new NotFoundException(`${oo} is not a job order.`);
    return job;
  }

  /**
   * Whether a roll may make this move.
   *
   * A map rather than a condition per entry point: an impossible move is a
   * lookup, and a new step added later cannot quietly skip a check somebody
   * forgot to copy.
   */
  /**
   * What a metre yields, from the settings tab.
   *
   * One cell, read directly: the costing service owns the whole of that
   * tab but already depends on this one, and pointing them at each other
   * would be a cycle for a single number.
   */
  private async planSettings(): Promise<{ unitsPerMeter: number }> {
    const rows = await this.sheet.read(SETTINGS_TAB).catch(() => []);
    for (let i = 1; i < rows.length; i++) {
      const key = String(rows[i]?.[0] ?? '').trim().toLowerCase();
      if (key === 'unitspermeter' || key === 'units per meter') {
        const n = Number(rows[i]?.[1]);
        if (Number.isFinite(n) && n > 0) return { unitsPerMeter: n };
      }
    }
    /* The Apps Script's own default: 1.43 pieces out of a metre. */
    return { unitsPerMeter: 1.43 };
  }

  private assertCanMoveTo(roll: Roll, next: RollStatus) {
    const now = roll.status as RollStatus;

    if (!ROLL_STATUS.includes(now)) {
      throw new BadRequestException(
        `${roll.rollId} has an unexpected status in the sheet ("${roll.status}"), `
        + 'so nothing here can move it. Put it right in the register first.');
    }

    if (!(ROLL_NEXT[now] ?? []).includes(next)) {
      throw new BadRequestException(
        `${roll.rollId} is ${now} and cannot go straight to ${next}.`);
    }
  }

  private async setStatus(roll: Roll, status: RollStatus) {
    await this.sheet.write(
      ROLLS_REGISTER_TAB, `H${roll.rowNumber}:H${roll.rowNumber}`, [[status]]);
  }
}


function who(p: Principal): string {
  return p.fullName ?? p.email ?? '';
}

function num(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** A count of pieces. Fractions of a scarf do not exist. */
function whole(v: unknown, what: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new BadRequestException(`${what} must be a whole number, 0 or more.`);
  }
  return n;
}