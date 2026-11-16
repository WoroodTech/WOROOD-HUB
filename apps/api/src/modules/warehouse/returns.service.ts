/**
 * Return issues, and the log of batch sheets sent out.
 *
 * A return issue is a parcel that came back wrong: fewer pieces than went
 * out, extra pieces nobody sent, the wrong item. Whoever opens the parcel
 * logs it with a photo; the Operations Manager reads it and closes it with a
 * comment.
 *
 * The three counts are the whole record — shipped, returned, unexpected —
 * because the gap between them is what the issue *is*, and a single
 * "something was wrong" field would lose it.
 *
 * The patch log is separate and simpler: which batch sheets have been sent,
 * how many times, and the conversation on each.
 */
import {
  BadRequestException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import { Principal } from '../../common/auth';
import { AuditService } from '../../core/core.module';
import { WarehouseSheetClient } from './sheets/warehouse-sheet.client';
import {
  BATCH_COMMENTS, BATCH_COMMENTS_TAB,
  PATCH_LOG, PATCH_LOG_TAB,
  RETURN_ISSUES, RETURN_ISSUES_TAB,
  WAREHOUSE_LOCATIONS,
} from './sheets/tabs';

const TZ = 'Africa/Cairo';

@Injectable()
export class WarehouseReturnsService {
  private readonly log = new Logger('WarehouseReturns');

  constructor(
    private readonly sheet: WarehouseSheetClient,
    private readonly audit: AuditService,
  ) {}

  /* -------------------------------------------------- return issues -- */

  /**
   * Issues, newest first.
   *
   * Capped at 300: this is a working list, and anybody who needs the
   * hundredth-oldest issue is looking for something specific and should
   * search for it.
   */
  async issues(filter: { status?: string; q?: string } = {}) {
    const rows = await this.read(RETURN_ISSUES_TAB);
    const q = (filter.q ?? '').trim().toLowerCase();
    const out: any[] = [];

    for (let i = rows.length - 1; i >= 1 && out.length < 300; i--) {
      const r = rows[i] ?? [];
      const id = String(r[RETURN_ISSUES.issueId] ?? '').trim();
      if (!id) continue;

      const issue = {
        rowNumber: i + 1,
        id,
        loggedAt: r[RETURN_ISSUES.loggedAt] ?? '',
        order: String(r[RETURN_ISSUES.order] ?? '').trim(),
        orderType: String(r[RETURN_ISSUES.orderType] ?? '').trim(),
        shippedPatch: String(r[RETURN_ISSUES.shippedPatch] ?? '').trim(),
        shippedItems: String(r[RETURN_ISSUES.shippedItems] ?? '').trim(),
        returnedItems: String(r[RETURN_ISSUES.returnedItems] ?? '').trim(),
        unexpectedItems: String(r[RETURN_ISSUES.unexpectedItems] ?? '').trim(),
        warehouse: String(r[RETURN_ISSUES.warehouse] ?? '').trim(),
        location: String(r[RETURN_ISSUES.location] ?? '').trim(),
        enteredBy: String(r[RETURN_ISSUES.enteredBy] ?? '').trim(),
        attachment: String(r[RETURN_ISSUES.attachment] ?? '').trim(),
        /* Anything that is not the word Resolved is open. A blank status on a
           hand-added row should not hide an issue nobody has looked at. */
        status: String(r[RETURN_ISSUES.status] ?? '').trim() === 'Resolved'
          ? 'Resolved' : 'Open',
        comment: String(r[RETURN_ISSUES.comment] ?? '').trim(),
        handledBy: String(r[RETURN_ISSUES.handledBy] ?? '').trim(),
        handledAt: r[RETURN_ISSUES.handledAt] ?? '',
      };

      if (filter.status && issue.status !== filter.status) continue;
      if (q) {
        const haystack = [
          issue.order, issue.shippedPatch, issue.shippedItems,
          issue.returnedItems, issue.unexpectedItems, issue.enteredBy,
        ].join(' ').toLowerCase();
        if (!haystack.includes(q)) continue;
      }

      out.push(issue);
    }

    return out;
  }

  /** How many are still open — the number on the tab. */
  async openCount() {
    const all = await this.issues({ status: 'Open' });
    return { open: all.length };
  }

  /**
   * Log an issue.
   *
   * Three counts rather than one description, because "the return was wrong"
   * is not something anybody can act on later. The photo is a link to a file
   * already uploaded; this stores the reference, not the file.
   */
  async logIssue(p: Principal, dto: {
    order: string; orderType?: string; shippedPatch?: string;
    shippedItems: string; returnedItems: string; unexpectedItems?: string;
    warehouse: string; location?: string; attachment?: string;
  }) {
    const order = String(dto.order ?? '').trim();
    if (!order) throw new BadRequestException('Enter the order number.');

    const shipped = String(dto.shippedItems ?? '').trim();
    const returned = String(dto.returnedItems ?? '').trim();
    if (!shipped && !returned) {
      throw new BadRequestException(
        'Say what was shipped and what came back — otherwise there is no issue to look at.');
    }

    const warehouse = String(dto.warehouse ?? '').trim();
    const location = String(dto.location ?? '').trim();
    const known = WAREHOUSE_LOCATIONS[warehouse];
    if (known === undefined) {
      throw new BadRequestException(`${warehouse} is not a warehouse.`);
    }
    if (known.length && location && !known.includes(location)) {
      throw new BadRequestException(`"${location}" is not a location in ${warehouse}.`);
    }

    /* `RI-20261113-4821`: the date makes it readable, the suffix makes two
       logged in the same second distinct. */
    const now = DateTime.now().setZone(TZ);
    const id = `RI-${now.toFormat('yyyyLLdd')}-`
      + String(Math.floor(Math.random() * 10000)).padStart(4, '0');

    const row = new Array(RETURN_ISSUES.rows + 1).fill('');
    row[RETURN_ISSUES.loggedAt] = serial(now);
    row[RETURN_ISSUES.issueId] = id;
    row[RETURN_ISSUES.order] = WarehouseSheetClient.safe(order);
    row[RETURN_ISSUES.orderType] = WarehouseSheetClient.safe(dto.orderType ?? '');
    row[RETURN_ISSUES.shippedPatch] = WarehouseSheetClient.safe(dto.shippedPatch ?? '');
    row[RETURN_ISSUES.shippedItems] = WarehouseSheetClient.safe(shipped);
    row[RETURN_ISSUES.returnedItems] = WarehouseSheetClient.safe(returned);
    row[RETURN_ISSUES.unexpectedItems] =
      WarehouseSheetClient.safe(dto.unexpectedItems ?? '');
    row[RETURN_ISSUES.warehouse] = warehouse;
    row[RETURN_ISSUES.location] = location;
    row[RETURN_ISSUES.enteredBy] = WarehouseSheetClient.safe(p.fullName ?? '');
    row[RETURN_ISSUES.enteredByEmail] = WarehouseSheetClient.safe(p.email ?? '');
    row[RETURN_ISSUES.attachment] = WarehouseSheetClient.safe(dto.attachment ?? '');
    row[RETURN_ISSUES.status] = 'Open';

    await this.sheet.append(RETURN_ISSUES_TAB, row);
    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.returns.log',
      entityType: 'warehouse_return_issue', entityId: id,
      payload: { order, warehouse, hasPhoto: !!dto.attachment },
    });

    return { ok: true, id };
  }

  /**
   * Close an issue with a comment, or reopen one.
   *
   * A comment is required to close: an issue marked Resolved with nothing
   * said is indistinguishable from one somebody clicked by accident, and the
   * next person to see the order has no idea what happened.
   */
  async updateIssue(p: Principal, dto: {
    id: string; status: 'Open' | 'Resolved'; comment?: string;
  }) {
    /*
     * The id column only, not the whole tab.
     *
     * `issues()` reads every column of every row and builds an object for
     * each, to find one. On a long tab that is the whole document pulled
     * across the network for a row number — and with the write that follows
     * it, the request was passing nginx's sixty seconds and returning 504
     * while the change had actually gone through.
     */
    const want = String(dto.id ?? '').trim().toLowerCase();
    if (!want) throw new BadRequestException('Which issue?');

    const ids = await this.read(RETURN_ISSUES_TAB, 'B:B');
    let rowNumber = 0;
    for (let i = 1; i < ids.length; i++) {
      if (String(ids[i]?.[0] ?? '').trim().toLowerCase() === want) {
        rowNumber = i + 1;
        break;
      }
    }
    if (!rowNumber) throw new NotFoundException('No such issue.');

    /* That one row, for its current status and comment. */
    const current = (await this.read(RETURN_ISSUES_TAB, `${rowNumber}:${rowNumber}`))[0] ?? [];
    const issue = {
      rowNumber,
      comment: String(current[RETURN_ISSUES.comment] ?? '').trim(),
      id: String(current[RETURN_ISSUES.issueId] ?? '').trim(),
    };

    const comment = String(dto.comment ?? '').trim();
    if (dto.status === 'Resolved' && !comment) {
      throw new BadRequestException('Say what was done before closing it.');
    }

    const at = issue.rowNumber;
    await this.sheet.write(RETURN_ISSUES_TAB, `N${at}:Q${at}`, [[
      dto.status === 'Resolved' ? 'Resolved' : 'Open',
      WarehouseSheetClient.safe(comment || issue.comment),
      WarehouseSheetClient.safe(p.fullName ?? p.email ?? ''),
      serial(DateTime.now().setZone(TZ)),
    ]]);

    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse',
      action: dto.status === 'Resolved'
        ? 'warehouse.returns.resolve' : 'warehouse.returns.reopen',
      entityType: 'warehouse_return_issue', entityId: issue.id,
      payload: { comment },
    });

    return { ok: true };
  }

  /* ------------------------------------------------------ patch log -- */

  /** Batch sheets sent out, newest activity first. */
  async patches(filter: { status?: string } = {}) {
    const rows = await this.read(PATCH_LOG_TAB);
    const out: any[] = [];

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] ?? [];
      const patch = String(r[PATCH_LOG.patch] ?? '').trim();
      if (!patch) continue;

      const entry = {
        rowNumber: i + 1,
        patch,
        firstSent: r[PATCH_LOG.firstSent] ?? '',
        lastSent: r[PATCH_LOG.lastSent] ?? '',
        sentBy: String(r[PATCH_LOG.sentBy] ?? '').trim(),
        /* More than one send is usually a reprint, and occasionally a
           mistake worth noticing. */
        timesSent: num(r[PATCH_LOG.timesSent]),
        orders: num(r[PATCH_LOG.orders]),
        units: num(r[PATCH_LOG.units]),
        status: String(r[PATCH_LOG.status] ?? '').trim() || 'Open',
        closedBy: String(r[PATCH_LOG.closedBy] ?? '').trim(),
        closedAt: r[PATCH_LOG.closedAt] ?? '',
        comments: num(r[PATCH_LOG.comments]),
        serial: String(r[PATCH_LOG.serial] ?? '').trim(),
      };

      if (filter.status && entry.status !== filter.status) continue;
      out.push(entry);
    }

    return out.sort((a, b) => Number(b.lastSent ?? 0) - Number(a.lastSent ?? 0));
  }

  /** The conversation on one patch, oldest first. */
  async comments(patch: string) {
    const rows = await this.read(BATCH_COMMENTS_TAB);
    const want = patch.trim().toLowerCase();
    const out: any[] = [];

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] ?? [];
      if (String(r[BATCH_COMMENTS.patch] ?? '').trim().toLowerCase() !== want) continue;
      out.push({
        at: r[BATCH_COMMENTS.at] ?? '',
        by: String(r[BATCH_COMMENTS.by] ?? '').trim(),
        comment: String(r[BATCH_COMMENTS.comment] ?? '').trim(),
      });
    }

    return out;
  }

  /** Add a comment to a patch. */
  async comment(p: Principal, patch: string, text: string) {
    const name = String(patch ?? '').trim();
    const body = String(text ?? '').trim();
    if (!name) throw new BadRequestException('Which patch?');
    if (!body) throw new BadRequestException('Write something.');

    const row = new Array(BATCH_COMMENTS.comment + 1).fill('');
    row[BATCH_COMMENTS.patch] = WarehouseSheetClient.safe(name);
    row[BATCH_COMMENTS.at] = serial(DateTime.now().setZone(TZ));
    row[BATCH_COMMENTS.byEmail] = WarehouseSheetClient.safe(p.email ?? '');
    row[BATCH_COMMENTS.by] = WarehouseSheetClient.safe(p.fullName ?? '');
    row[BATCH_COMMENTS.comment] = WarehouseSheetClient.safe(body);

    await this.sheet.append(BATCH_COMMENTS_TAB, row);

    /* The count on the patch row, so the list can show which patches have a
       conversation without reading every comment. */
    const entry = (await this.patches()).find(
      (x) => x.patch.toLowerCase() === name.toLowerCase());
    if (entry) {
      await this.sheet.write(PATCH_LOG_TAB, `L${entry.rowNumber}:L${entry.rowNumber}`,
        [[entry.comments + 1]]);
    }

    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.patch.comment',
      entityType: 'warehouse_patch', entityId: name, payload: {},
    });

    return { ok: true };
  }

  /** Close a patch, or reopen it. */
  async setPatchStatus(p: Principal, patch: string, status: 'Open' | 'Closed') {
    const entry = (await this.patches()).find(
      (x) => x.patch.toLowerCase() === String(patch ?? '').trim().toLowerCase());
    if (!entry) throw new NotFoundException('No such patch.');

    const at = entry.rowNumber;
    await this.sheet.write(PATCH_LOG_TAB, `I${at}:K${at}`, [[
      status,
      status === 'Closed' ? WarehouseSheetClient.safe(p.fullName ?? p.email ?? '') : '',
      status === 'Closed' ? serial(DateTime.now().setZone(TZ)) : '',
    ]]);

    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.patch.status',
      entityType: 'warehouse_patch', entityId: entry.patch, payload: { status },
    });

    return { ok: true };
  }

  /* -------------------------------------------------------- helpers -- */

  /**
   * A tab created on first use may not exist yet; empty is the answer.
   *
   * `range` narrows the read to one column or one row, which is the
   * difference between pulling a whole document and pulling what is needed.
   */
  private async read(tab: string, range?: string): Promise<any[][]> {
    try { return await this.sheet.read(tab, range); } catch { return [[]]; }
  }
}

function serial(d: DateTime): number {
  return Math.round(
    d.startOf('day').diff(DateTime.fromISO('1899-12-30', { zone: TZ }), 'days').days);
}

function num(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}