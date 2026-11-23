/**
 * Quality check: a chain of custody for stock routed through WH-05.
 *
 *   A transfer into WH-05 opens a batch → Quality counts what arrived →
 *   Quality hands some back, saying where each piece goes → the warehouse
 *   keeper counts it and confirms → only then are the transfer rows written.
 *
 * The confirm step is the whole design. Quality saying it handed back forty
 * pieces and the warehouse finding thirty-eight is normal, and the ledger
 * should record what the warehouse counted, not what quality intended. So
 * nothing reaches the ledger until somebody has physically counted it.
 *
 * Partial hand-backs are expected: the rest stays with quality and the batch
 * stays open. Nothing is ever hard-deleted — a cancellation keeps its
 * history, because "where did those twelve pieces go" is a question asked
 * weeks later.
 *
 * Two cycles share this: `Q.C###` for Worood Quality and `W.Q###` for
 * Workshop Quality. Each team sees its own.
 */
import {
  BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import { Principal } from '../../common/auth';
import { AuditService } from '../../core/core.module';
import { WarehouseSheetClient } from './sheets/warehouse-sheet.client';
import { WarehouseReaderService } from './sheets/warehouse-reader.service';
import { WarehouseQueueService } from './sheets/warehouse-queue.service';
import { QC, QC_TAB, TX, WAREHOUSE_LOCATIONS } from './sheets/tabs';
import { sheetDate } from './sheets/parse-date';

const TZ = 'Africa/Cairo';

/** Which location in WH-05 a serial belongs to. */
const locationOf = (serial: string) =>
  /^W\.Q/i.test(serial) ? 'Workshop Quality' : 'Worood Quality';

/** Which cycle a serial is. */
const cycleOf = (serial: string): 'Q' | 'W' =>
  /^W\.Q/i.test(serial) ? 'W' : 'Q';

export interface QcLine {
  item: string;
  /** What the transfer said was sent. */
  sent: number;
  /** What quality counted on arrival. */
  got: number;
  /** How many have been handed back and confirmed. */
  done: number;
  /** How many are accounted for as missing. */
  short: number;
}

@Injectable()
export class WarehouseQcService {
  private readonly log = new Logger('WarehouseQc');

  constructor(
    private readonly sheet: WarehouseSheetClient,
    private readonly reader: WarehouseReaderService,
    private readonly queue: WarehouseQueueService,
    private readonly audit: AuditService,
  ) {}

  /* ---------------------------------------------------------- reads -- */

  /**
   * The batches somebody may see.
   *
   * `cycle` is which team they are: Worood Quality sees Q.C, Workshop
   * Quality sees W.Q, and everybody else sees both.
   */
  async batches(cycle: 'Q' | 'W' | 'A' = 'A') {
    const rows = await this.readTab();
    const out: any[] = [];

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] ?? [];
      const serial = String(r[QC.serial] ?? '').trim();
      if (!serial) continue;
      if (cycle !== 'A' && cycleOf(serial) !== cycle) continue;

      const batch = this.parse(r, i + 1);
      out.push({ ...batch, status: this.statusOf(batch) });
    }

    return out.sort((a, b) => b.serial.localeCompare(a.serial));
  }

  async batch(serial: string) {
    const rows = await this.readTab();
    const want = serial.trim().toLowerCase();

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] ?? [];
      if (String(r[QC.serial] ?? '').trim().toLowerCase() !== want) continue;
      const b = this.parse(r, i + 1);
      return { ...b, status: this.statusOf(b) };
    }
    return null;
  }

  /* --------------------------------------------------------- writes -- */

  /**
   * Quality counts what arrived.
   *
   * What quality counted can differ from what the transfer said was sent,
   * and both are kept. The `got` figure is what everything afterwards works
   * from: handing back more than arrived is the one thing this must not
   * allow.
   */
  async receive(p: Principal, dto: {
    serial: string;
    counted: { item: string; got: number }[];
    note?: string;
  }) {
    const b = await this.mustFind(dto.serial);
    if (b.state.received) {
      throw new BadRequestException(
        `${b.serial} was already counted in, by ${b.state.receivedBy || 'somebody'}.`);
    }
    if (b.status === 'Cancelled') {
      throw new BadRequestException(`${b.serial} was cancelled.`);
    }

    const counted = new Map<string, number>();
    for (const c of dto.counted ?? []) {
      const item = String(c?.item ?? '').trim();
      if (!item) continue;
      counted.set(item.toLowerCase(), whole(c.got, `the count for "${item}"`));
    }

    const lines = b.lines.map((l) => ({
      ...l,
      got: counted.get(l.item.toLowerCase()) ?? 0,
    }));

    const state = {
      ...b.state,
      received: sheetDate(DateTime.now().setZone(TZ)),
      receivedBy: who(p),
      receiveNote: String(dto.note ?? '').trim(),
      rounds: b.state.rounds ?? [],
    };

    await this.save(b.rowNumber, lines, state);

    const shortfall = lines
      .filter((l) => l.got !== l.sent)
      .map((l) => ({ item: l.item, sent: l.sent, got: l.got }));

    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.qc.receive',
      entityType: 'warehouse_qc_batch', entityId: b.serial,
      /* Any discrepancy at the door is recorded here, where it happened,
         rather than discovered when the numbers fail to add up later. */
      payload: { lines: lines.length, shortfall },
    });

    return { ok: true, shortfall };
  }

  /**
   * The manager has seen the quantity difference.
   *
   * A shortfall at the door is recorded when the batch is received, and then
   * nothing happens to it: the numbers disagree, the batch carries on, and
   * whether anybody with authority ever looked is not written down. The Apps
   * Script has `qcAck_` for exactly this — "the manager saw the quantity
   * difference" — and it was the one step of that tab the portal had no
   * equivalent for.
   *
   * It changes no quantity and settles nothing. It records that the
   * difference was seen, by whom and when, so an unexplained gap can be told
   * apart from one somebody has already taken on.
   */
  async acknowledge(p: Principal, serial: string, note?: string) {
    const b = await this.mustFind(serial);

    if (b.status === 'Cancelled') {
      throw new BadRequestException('That batch was cancelled.');
    }
    if (!b.lines.some((l: any) => l.got !== l.sent)) {
      throw new BadRequestException('Nothing on that batch disagrees.');
    }
    /* Said once. A second person pressing it would overwrite the first, and
       who looked first is the part worth keeping. */
    if (b.state.ack) {
      throw new BadRequestException(
        `Already seen by ${b.state.ack.by} on ${b.state.ack.at}.`);
    }

    const state = {
      ...b.state,
      ack: {
        by: who(p),
        at: sheetDate(DateTime.now().setZone(TZ)),
        note: String(note ?? '').trim(),
      },
    };

    await this.save(b.rowNumber, b.lines, state);

    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.qc.acknowledge',
      entityType: 'warehouse_qc_batch', entityId: b.serial,
      payload: {
        shortfall: b.lines
          .filter((l: any) => l.got !== l.sent)
          .map((l: any) => ({ item: l.item, sent: l.sent, got: l.got })),
      },
    });

    return { ok: true, ack: state.ack };
  }

  /**
   * Quality hands pieces back, saying where each goes.
   *
   * Nothing is written to the ledger here. This records an intention; the
   * warehouse keeper confirming it is what makes it stock. Partial hand-backs
   * are normal and the batch stays open for the rest.
   */
  async handBack(p: Principal, dto: {
    serial: string;
    lines: { item: string; quantity: number; warehouse: string; location?: string }[];
    note?: string;
  }) {
    const b = await this.mustFind(dto.serial);
    if (!b.state.received) {
      throw new BadRequestException(
        `${b.serial} has not been counted in yet.`);
    }
    if (b.status === 'Cancelled') {
      throw new BadRequestException(`${b.serial} was cancelled.`);
    }
    if (b.state.rounds?.some((r: any) => r.status === 'Waiting')) {
      /* One hand-back at a time: a second while the first is uncounted
         would leave the keeper confirming two piles as one. */
      throw new BadRequestException(
        `${b.serial} already has a hand-back waiting for the warehouse.`);
    }

    const lines = (dto.lines ?? [])
      .map((l) => ({
        item: String(l?.item ?? '').trim(),
        quantity: whole(l?.quantity, 'The quantity'),
        warehouse: String(l?.warehouse ?? '').trim(),
        location: String(l?.location ?? '').trim(),
      }))
      .filter((l) => l.item && l.quantity > 0);

    if (!lines.length) throw new BadRequestException('Nothing to hand back.');

    /* Where each line is going has to be a real place. */
    for (const l of lines) {
      const known = WAREHOUSE_LOCATIONS[l.warehouse];
      if (known === undefined) {
        throw new BadRequestException(`${l.warehouse} is not a warehouse.`);
      }
      if (known.length && !known.includes(l.location)) {
        throw new BadRequestException(
          `"${l.location || '(none)'}" is not a location in ${l.warehouse}.`);
      }
      if (!known.length && l.location) {
        throw new BadRequestException(`${l.warehouse} has no locations inside it.`);
      }
    }

    /*
     * Nothing leaves that did not arrive.
     *
     * Handing back more than quality counted in would put pieces into the
     * ledger that nothing accounts for — and the balance would be wrong with
     * no row to explain it.
     */
    const remaining = new Map<string, number>();
    for (const l of b.lines) {
      remaining.set(l.item.toLowerCase(),
        Math.max(0, l.got - l.done - l.short));
    }

    const wanted = new Map<string, number>();
    for (const l of lines) {
      const key = l.item.toLowerCase();
      wanted.set(key, (wanted.get(key) ?? 0) + l.quantity);
    }

    for (const [key, qty] of wanted) {
      const have = remaining.get(key);
      const name = lines.find((l) => l.item.toLowerCase() === key)!.item;
      if (have === undefined) {
        throw new BadRequestException(`"${name}" is not in this batch.`);
      }
      if (qty > have) {
        throw new BadRequestException(
          `"${name}": ${have} left with quality, and ${qty} were handed back.`);
      }
    }

    const round = {
      n: (b.state.rounds?.length ?? 0) + 1,
      at: sheetDate(DateTime.now().setZone(TZ)),
      by: who(p),
      note: String(dto.note ?? '').trim(),
      status: 'Waiting' as const,
      lines,
    };

    const state = { ...b.state, rounds: [...(b.state.rounds ?? []), round] };
    await this.save(b.rowNumber, b.lines, state);

    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.qc.handBack',
      entityType: 'warehouse_qc_batch', entityId: b.serial,
      payload: { round: round.n, lines: lines.length },
    });

    return { ok: true, round: round.n };
  }

  /**
   * Quality takes a hand-back back before the warehouse has counted it.
   *
   * Recorded rather than removed: a hand-back that was announced and then
   * withdrawn is exactly the kind of thing somebody asks about later.
   */
  async recall(p: Principal, serialStr: string, round: number, reason?: string) {
    const b = await this.mustFind(serialStr);
    const r = (b.state.rounds ?? []).find((x: any) => x.n === Number(round));
    if (!r) throw new NotFoundException(`Hand-back ${round} is not on ${b.serial}.`);
    if (r.status !== 'Waiting') {
      throw new BadRequestException(
        `Hand-back ${round} is already ${String(r.status).toLowerCase()}.`);
    }

    r.status = 'Recalled';
    r.recalledAt = sheetDate(DateTime.now().setZone(TZ));
    r.recalledBy = who(p);
    r.recallReason = String(reason ?? '').trim();

    await this.save(b.rowNumber, b.lines, b.state);
    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.qc.recall',
      entityType: 'warehouse_qc_batch', entityId: b.serial,
      payload: { round: Number(round), reason: r.recallReason },
    });

    return { ok: true };
  }

  /**
   * The warehouse keeper counts what quality handed back, and confirms.
   *
   * This is where stock moves. The transfer rows are written from what the
   * keeper counted, not from what quality said — which is the whole reason
   * the two steps are separate.
   */
  async confirm(p: Principal, dto: {
    serial: string;
    round: number;
    counted: { item: string; warehouse: string; location?: string; quantity: number }[];
    note?: string;
  }) {
    const b = await this.mustFind(dto.serial);
    const r = (b.state.rounds ?? []).find((x: any) => x.n === Number(dto.round));
    if (!r) throw new NotFoundException(`Hand-back ${dto.round} is not on ${b.serial}.`);
    if (r.status !== 'Waiting') {
      throw new BadRequestException(
        `Hand-back ${dto.round} is already ${String(r.status).toLowerCase()}.`);
    }

    const counted = (dto.counted ?? [])
      .map((c) => ({
        item: String(c?.item ?? '').trim(),
        warehouse: String(c?.warehouse ?? '').trim(),
        location: String(c?.location ?? '').trim(),
        quantity: whole(c?.quantity, 'The count'),
      }))
      .filter((c) => c.item && c.quantity > 0);

    if (!counted.length) {
      throw new BadRequestException('Nothing was counted — recall it instead.');
    }

    /* Each counted line has to be one quality said it was handing back, to
       the same place. Anything else is a different movement. */
    for (const c of counted) {
      const match = (r.lines ?? []).find(
        (l: any) => l.item.toLowerCase() === c.item.toLowerCase()
          && l.warehouse === c.warehouse
          && (l.location ?? '') === (c.location ?? ''));
      if (!match) {
        throw new BadRequestException(
          `"${c.item}" into ${c.warehouse}${c.location ? ` / ${c.location}` : ''} `
          + 'was not part of this hand-back.');
      }
      if (c.quantity > match.quantity) {
        throw new BadRequestException(
          `"${c.item}": quality handed back ${match.quantity}, and ${c.quantity} were counted.`);
      }
    }

    /*
     * Two rows per line: out of WH-05 and into the destination.
     *
     * Written from the keeper's count. Queued rather than written directly,
     * like every other movement — a confirm that cannot reach the sheet
     * right now is not a confirm that should be lost.
     */
    const date = sheetDate(DateTime.now().setZone(TZ));
    const by = WarehouseSheetClient.safe(who(p));
    const from = locationOf(b.serial);
    let rows = 0;

    for (const c of counted) {
      const out = new Array(15).fill('');
      out[TX.date] = date;
      out[TX.itemName] = WarehouseSheetClient.safe(c.item);
      out[TX.patch] = WarehouseSheetClient.safe(b.serial);
      out[TX.stockOut] = c.quantity;
      out[TX.warehouse] = 'WH-05';
      out[TX.location] = from;
      out[TX.kind] = 'Transfer';
      out[TX.enteredBy] = by;
      await this.queue.enqueue('LEDGER_ROW', out);

      const into = new Array(15).fill('');
      into[TX.date] = date;
      into[TX.itemName] = WarehouseSheetClient.safe(c.item);
      into[TX.patch] = WarehouseSheetClient.safe(b.serial);
      into[TX.stockIn] = c.quantity;
      into[TX.warehouse] = c.warehouse;
      into[TX.location] = c.location;
      into[TX.kind] = 'Transfer';
      into[TX.enteredBy] = by;
      await this.queue.enqueue('LEDGER_ROW', into);

      rows += 2;
    }

    /* What the keeper actually took, line by line. */
    const takenPerItem = new Map<string, number>();
    for (const c of counted) {
      const key = c.item.toLowerCase();
      takenPerItem.set(key, (takenPerItem.get(key) ?? 0) + c.quantity);
    }

    const lines = b.lines.map((l) => ({
      ...l,
      done: l.done + (takenPerItem.get(l.item.toLowerCase()) ?? 0),
    }));

    r.status = 'Confirmed';
    r.confirmedAt = date;
    r.confirmedBy = who(p);
    r.confirmedLines = counted;
    r.confirmNote = String(dto.note ?? '').trim();

    await this.save(b.rowNumber, lines, b.state);
    await this.reader.invalidate();

    const difference = counted.map((c) => {
      const said = (r.lines ?? []).find(
        (l: any) => l.item.toLowerCase() === c.item.toLowerCase()
          && l.warehouse === c.warehouse
          && (l.location ?? '') === (c.location ?? ''))?.quantity ?? 0;
      return { item: c.item, handedBack: said, counted: c.quantity, gap: c.quantity - said };
    }).filter((d) => d.gap !== 0);

    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.qc.confirm',
      entityType: 'warehouse_qc_batch', entityId: b.serial,
      payload: { round: Number(dto.round), rows, difference },
    });

    return { ok: true, rows, difference };
  }

  /**
   * Account for pieces that never turned up.
   *
   * A batch where quality counted forty and only thirty-eight were ever
   * handed back stays open for ever otherwise. This closes the gap
   * explicitly, with a reason, rather than letting it be forgotten.
   */
  async markShort(p: Principal, dto: {
    serial: string; item: string; quantity: number; reason: string;
  }) {
    const b = await this.mustFind(dto.serial);
    const reason = String(dto.reason ?? '').trim();
    if (!reason) {
      throw new BadRequestException('Say what happened to them.');
    }

    const item = String(dto.item ?? '').trim();
    const qty = whole(dto.quantity, 'The quantity');
    const line = b.lines.find((l) => l.item.toLowerCase() === item.toLowerCase());
    if (!line) throw new NotFoundException(`"${item}" is not in this batch.`);

    const left = line.got - line.done - line.short;
    if (qty > left) {
      throw new BadRequestException(
        `"${item}": ${left} unaccounted for, and ${qty} were given.`);
    }

    const lines = b.lines.map((l) =>
      (l.item.toLowerCase() === item.toLowerCase()
        ? { ...l, short: l.short + qty } : l));

    const state = {
      ...b.state,
      shortages: [...(b.state.shortages ?? []), {
        item, quantity: qty, reason,
        at: sheetDate(DateTime.now().setZone(TZ)), by: who(p),
      }],
    };

    await this.save(b.rowNumber, lines, state);
    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.qc.short',
      entityType: 'warehouse_qc_batch', entityId: b.serial,
      payload: { item, quantity: qty, reason },
    });

    return { ok: true };
  }

  /* -------------------------------------------------------- helpers -- */

  /** The tab is created on first use, so it may not exist yet. */
  private async readTab(): Promise<any[][]> {
    try { return await this.sheet.read(QC_TAB); } catch { return [[]]; }
  }

  private parse(r: any[], rowNumber: number) {
    /*
     * Lines and state are JSON in two cells.
     *
     * Bad JSON reads as empty rather than throwing: one malformed cell
     * should not take down the whole screen for every other batch.
     */
    let lines: QcLine[] = [];
    let state: any = {};
    try { lines = JSON.parse(String(r[QC.lines] ?? '[]')); } catch { lines = []; }
    try { state = JSON.parse(String(r[QC.state] ?? '{}')); } catch { state = {}; }

    return {
      rowNumber,
      serial: String(r[QC.serial] ?? '').trim(),
      created: r[QC.created] ?? '',
      createdBy: String(r[QC.createdBy] ?? '').trim(),
      txId: String(r[QC.txId] ?? '').trim(),
      stored: String(r[QC.status] ?? '').trim(),
      location: locationOf(String(r[QC.serial] ?? '')),
      cycle: cycleOf(String(r[QC.serial] ?? '')),
      lines: (lines ?? []).map((l: any) => ({
        item: String(l?.item ?? ''),
        sent: Number(l?.sent ?? 0) || 0,
        got: Number(l?.got ?? 0) || 0,
        done: Number(l?.done ?? 0) || 0,
        short: Number(l?.short ?? 0) || 0,
      })),
      /*
       * Every round gets its `lines`, whatever the sheet holds.
       *
       * A round written by the Apps Script, or stored before a field
       * existed, can have no lines at all — and the screen maps over them,
       * so one old row took the whole Quality Check page down with
       * `undefined.map`. Normalised here rather than guarded there: the next
       * thing to read this should not have to know.
       */
      state: {
        ...state,
        rounds: (state?.rounds ?? []).map((r: any) => ({
          ...r,
          n: Number(r?.n ?? 0),
          status: String(r?.status ?? 'Waiting'),
          lines: Array.isArray(r?.lines) ? r.lines : [],
          confirmedLines: Array.isArray(r?.confirmedLines) ? r.confirmedLines : undefined,
        })),
        shortages: Array.isArray(state?.shortages) ? state.shortages : [],
      },
      updated: r[QC.updated] ?? '',
    };
  }

  /**
   * The status, worked out from the numbers rather than stored.
   *
   * A stored status drifts: somebody edits a line in the sheet and the label
   * still says Complete. Derived, it cannot disagree with what it describes.
   */
  private statusOf(b: any): string {
    if (b.stored === 'Cancelled') return 'Cancelled';
    if (!b.state?.received) return 'New';

    const waiting = (b.state.rounds ?? []).some((r: any) => r.status === 'Waiting');
    if (waiting) return 'Waiting for warehouse';

    const left = b.lines.reduce(
      (n: number, l: QcLine) => n + Math.max(0, l.got - l.done - l.short), 0);
    return left > 0 ? 'With quality' : 'Complete';
  }

  private async mustFind(serialStr: string) {
    const s = String(serialStr ?? '').trim();
    if (!s) throw new BadRequestException('Which batch?');
    const b = await this.batch(s);
    if (!b) throw new NotFoundException(`${s} is not a quality batch.`);
    return b;
  }

  private async save(rowNumber: number, lines: QcLine[], state: any) {
    /* Lines, state and the timestamp. The serial, the creation and the
       transfer id are never rewritten: they are what identifies the batch. */
    await this.sheet.write(QC_TAB, `F${rowNumber}:H${rowNumber}`, [[
      JSON.stringify(lines),
      JSON.stringify(state),
      sheetDate(DateTime.now().setZone(TZ)),
    ]]);
  }
}


function who(p: Principal): string { return p.fullName ?? p.email ?? ''; }

function whole(v: unknown, what: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new BadRequestException(`${what} must be a whole number, 0 or more.`);
  }
  return n;
}