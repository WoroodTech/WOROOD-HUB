/**
 * Edits and deletes that wait for a manager.
 *
 * Somebody who can post a movement cannot quietly change one afterwards: the
 * ledger is what stock is counted against, and a correction that nobody saw
 * is indistinguishable from a mistake nobody caught.
 *
 * Two faults in the Apps Script's version are closed here. A requester could
 * approve their own request — now a database constraint, not a convention in
 * code somebody can forget. And the lock was released before the final status
 * was written, so two near-simultaneous approvals could both apply — now the
 * request moves to `PROCESSING` in the same statement that claims it.
 */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { one, query } from '../../common/db';
import { Principal } from '../../common/auth';
import { AuditService } from '../../core/core.module';
import { WarehouseReaderService } from './sheets/warehouse-reader.service';
import { WarehouseSheetClient } from './sheets/warehouse-sheet.client';
import { TX, TX_TAB } from './sheets/tabs';

@Injectable()
export class WarehouseApprovalsService {
  private readonly log = new Logger('WarehouseApprovals');

  constructor(
    private readonly sheet: WarehouseSheetClient,
    private readonly reader: WarehouseReaderService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Ask for a ledger row to be changed or removed.
   *
   * The row number is taken as given and checked when the request is
   * approved, not now: rows can be inserted into the sheet by hand in the
   * meantime, and a number that was right at request time can be wrong by the
   * time somebody decides.
   */
  async request(p: Principal, dto: {
    kind: 'EDIT' | 'DELETE';
    rowNumber: number;
    changes?: Record<string, string | number>;
    reason?: string;
  }) {
    if (dto.kind !== 'EDIT' && dto.kind !== 'DELETE') {
      throw new BadRequestException('A request is either an edit or a delete.');
    }
    if (!Number.isInteger(dto.rowNumber) || dto.rowNumber < 2) {
      throw new BadRequestException('That is not a row in the ledger.');
    }

    const reason = String(dto.reason ?? '').trim();
    if (!reason) {
      /* Required, because the manager deciding it has only this to go on and
         the row itself rarely says why it is wrong. */
      throw new BadRequestException('Say why — the manager deciding this reads it.');
    }

    /* What the row says now, stored with the request. A manager deciding it
       tomorrow should see what the requester saw, not what it has become. */
    const current = await this.rowAt(dto.rowNumber);
    if (!current) throw new NotFoundException('That row is not in the ledger.');

    const row = await one<any>(
      `INSERT INTO wh_approvals (kind, requested_by, target_ref, payload, reason)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [dto.kind, p.id, String(dto.rowNumber),
       JSON.stringify({ changes: dto.changes ?? {}, snapshot: current }), reason]);

    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.approval.request',
      entityType: 'warehouse_approval', entityId: row.id,
      payload: { kind: dto.kind, rowNumber: dto.rowNumber },
    });

    return { ok: true, id: row.id as string };
  }

  /** What is waiting. */
  async pending() {
    const rows = await query<any>(
      `SELECT a.id, a.kind, a.target_ref, a.payload, a.reason, a.requested_at,
              u.full_name AS requested_by_name, u.id AS requested_by
         FROM wh_approvals a
         JOIN core_users u ON u.id = a.requested_by
        WHERE a.status = 'PENDING'
        ORDER BY a.requested_at`);

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      rowNumber: Number(r.target_ref),
      changes: r.payload?.changes ?? {},
      snapshot: r.payload?.snapshot ?? null,
      reason: r.reason,
      requestedBy: r.requested_by,
      requestedByName: r.requested_by_name,
      requestedAt: r.requested_at,
    }));
  }

  /**
   * Decide one.
   *
   * The claim and the status change are one statement: `WHERE status =
   * 'PENDING'` means two managers pressing together produce one winner and
   * one "already decided", rather than two applications of the same change.
   */
  async decide(p: Principal, id: string, approve: boolean, note?: string) {
    const claimed = await one<any>(
      `UPDATE wh_approvals
          SET status = 'PROCESSING', decided_by = $2
        WHERE id = $1 AND status = 'PENDING'
        RETURNING *`, [id, p.id]);

    if (!claimed) {
      const exists = await one<any>(
        `SELECT status, requested_by FROM wh_approvals WHERE id = $1`, [id]);
      if (!exists) throw new NotFoundException('No such request.');
      if (exists.requested_by === p.id) {
        /* The constraint would refuse this anyway; saying so plainly beats a
           database error reaching the screen. */
        throw new BadRequestException(
          'You raised this request, so somebody else has to decide it.');
      }
      throw new BadRequestException('That request has already been decided.');
    }

    /* The constraint is the real guard; this catches it before the write so
       the message is one somebody can act on. */
    if (claimed.requested_by === p.id) {
      await query(
        `UPDATE wh_approvals SET status='PENDING', decided_by=NULL WHERE id=$1`, [id]);
      throw new BadRequestException(
        'You raised this request, so somebody else has to decide it.');
    }

    const text = String(note ?? '').trim();

    if (!approve) {
      await query(
        `UPDATE wh_approvals
            SET status='REJECTED', decided_at=now(), decision_note=$2
          WHERE id=$1`, [id, text || null]);
      await this.audit.write({
        actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.approval.reject',
        entityType: 'warehouse_approval', entityId: id, payload: { note: text },
      });
      return { ok: true, status: 'REJECTED' as const };
    }

    try {
      await this.apply(claimed);
    } catch (e: any) {
      /*
       * Recorded as failed rather than left in `PROCESSING`.
       *
       * A request stuck mid-apply is invisible: it is not pending, so nobody
       * sees it, and it is not decided, so nothing happened. Saying it failed
       * puts it back in front of a person.
       */
      await query(
        `UPDATE wh_approvals
            SET status='FAILED', decided_at=now(), decision_note=$2
          WHERE id=$1`, [id, `Could not apply: ${String(e?.message ?? e).slice(0, 400)}`]);
      throw new BadRequestException(
        `Approved, but it could not be applied: ${e?.message ?? e}`);
    }

    await query(
      `UPDATE wh_approvals
          SET status='APPROVED', decided_at=now(), decision_note=$2
        WHERE id=$1`, [id, text || null]);

    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.approval.approve',
      entityType: 'warehouse_approval', entityId: id,
      payload: { kind: claimed.kind, rowNumber: Number(claimed.target_ref) },
    });

    await this.reader.invalidate();
    return { ok: true, status: 'APPROVED' as const };
  }

  /* --------------------------------------------------------- apply -- */

  /**
   * Make the change in the sheet.
   *
   * A delete blanks the quantity columns rather than removing the row.
   * Removing it would shift every row below by one, and every approval
   * waiting on a row number would then point at the wrong movement — the
   * Apps Script has the same problem and the same answer.
   */
  private async apply(req: any) {
    const rowNumber = Number(req.target_ref);
    const live = await this.rowAt(rowNumber);
    if (!live) throw new Error('that row is no longer in the ledger');

    /*
     * The row has to still be the row that was asked about.
     *
     * Somebody can insert rows into the sheet by hand between the request and
     * the decision, and then row 4,521 is a different movement entirely.
     * Applying the change anyway would edit an innocent row.
     */
    const snap = req.payload?.snapshot;
    if (snap && (snap.item !== live.item || snap.kind !== live.kind
                 || snap.date !== live.date)) {
      throw new Error(
        `row ${rowNumber} is no longer the movement this was raised against `
        + `(it now reads "${live.item}", ${live.kind}, ${live.date}) — `
        + 'rows were probably inserted in the sheet. Raise it again.');
    }

    if (req.kind === 'DELETE') {
      await this.sheet.write(TX_TAB, `I${rowNumber}:J${rowNumber}`, [['', '']]);
      return;
    }

    /* An edit changes only the columns it names, and only columns that are
       values. Nothing here can touch N (Balance) or anything past O, which
       are the sheet's own formulas. */
    const allowed: Record<string, number> = {
      item: TX.itemName,
      nationalOrder: TX.nationalOrder,
      globalOrder: TX.globalOrder,
      patch: TX.patch,
      stockIn: TX.stockIn,
      stockOut: TX.stockOut,
      warehouse: TX.warehouse,
      location: TX.location,
    };

    const changes = req.payload?.changes ?? {};
    for (const [field, value] of Object.entries(changes)) {
      const col = allowed[field];
      if (col === undefined) continue;

      const cell = (field === 'stockIn' || field === 'stockOut')
        ? (Number(value) || '')
        : WarehouseSheetClient.safe(value);

      await this.sheet.write(
        TX_TAB, `${colLetter(col)}${rowNumber}:${colLetter(col)}${rowNumber}`, [[cell]]);
    }
  }

  /** One ledger row, as the screen and the snapshot see it. */
  private async rowAt(rowNumber: number) {
    const values = await this.sheet.read(TX_TAB, `${rowNumber}:${rowNumber}`);
    const r = values[0];
    if (!r || !String(r[TX.itemName] ?? '').trim()) return null;
    return {
      rowNumber,
      date: String(r[TX.date] ?? ''),
      item: String(r[TX.itemName] ?? '').trim(),
      nationalOrder: String(r[TX.nationalOrder] ?? '').trim(),
      globalOrder: String(r[TX.globalOrder] ?? '').trim(),
      patch: String(r[TX.patch] ?? '').trim(),
      stockIn: Number(r[TX.stockIn] ?? 0) || 0,
      stockOut: Number(r[TX.stockOut] ?? 0) || 0,
      warehouse: String(r[TX.warehouse] ?? '').trim(),
      location: String(r[TX.location] ?? '').trim(),
      kind: String(r[TX.kind] ?? '').trim(),
      enteredBy: String(r[TX.enteredBy] ?? '').trim(),
    };
  }
}

/** 0 → A. */
function colLetter(index: number): string {
  let n = index, out = '';
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1; }
  while (n >= 0);
  return out;
}