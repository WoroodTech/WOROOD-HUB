/**
 * QR labels, and the register of printed papers.
 *
 * Two things that both end up on paper, and both need the same discipline: a
 * serial handed out before printing, and a count of how many times it has
 * been printed since.
 *
 * That count is the point. A quality note printed four times is four pieces
 * of paper that all look official, and knowing there are four is the
 * difference between a reprint and something nobody can account for.
 *
 * The labels themselves are rendered in the browser — this supplies what goes
 * on them. The item code is the sheet's own, so a label scanned against the
 * catalogue matches.
 */
import {
  BadRequestException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import { Principal } from '../../common/auth';
import { AuditService } from '../../core/core.module';
import { WarehouseSheetClient } from './sheets/warehouse-sheet.client';
import { WarehouseReaderService } from './sheets/warehouse-reader.service';
import {
  DOC_TYPES, DOCS_REGISTER, DOCS_REGISTER_TAB,
  PRINT_DOCS, PRINT_DOCS_TAB,
} from './sheets/tabs';
import { sheetDate } from './sheets/parse-date';

const TZ = 'Africa/Cairo';

export interface LabelRequest {
  /** Items to print, by catalogue name. */
  lines: { item: string; copies: number }[];
}

@Injectable()
export class WarehouseDocumentsService {
  private readonly log = new Logger('WarehouseDocs');

  constructor(
    private readonly sheet: WarehouseSheetClient,
    private readonly reader: WarehouseReaderService,
    private readonly audit: AuditService,
  ) {}

  /* ----------------------------------------------------- QR labels -- */

  /**
   * What goes on each label.
   *
   * The code is the catalogue's own computed Item Code, so a label scanned
   * against the sheet matches. Nothing is invented here: an item not in the
   * catalogue has no label, because a label with a code the sheet does not
   * know is worse than no label.
   */
  async labels(dto: LabelRequest) {
    const lines = (dto?.lines ?? [])
      .map((l) => ({
        item: String(l?.item ?? '').trim(),
        copies: Number(l?.copies ?? 1),
      }))
      .filter((l) => l.item);

    if (!lines.length) throw new BadRequestException('Add at least one item.');

    for (const l of lines) {
      if (!Number.isInteger(l.copies) || l.copies < 1 || l.copies > 200) {
        throw new BadRequestException(
          `"${l.item}": copies must be a whole number between 1 and 200.`);
      }
    }

    const catalogue = await this.reader.items();
    const byName = new Map(
      catalogue.map((i) => [i.name.replace(/\s+/g, ' ').trim().toLowerCase(), i]));

    const out: any[] = [];
    const missing: string[] = [];

    for (const l of lines) {
      const item = byName.get(l.item.replace(/\s+/g, ' ').trim().toLowerCase());
      if (!item) { missing.push(l.item); continue; }

      out.push({
        /* The catalogue's spelling, not what was typed: the label has to
           match what the ledger calls it. */
        name: item.name,
        code: item.code,
        group: item.group,
        /* What the QR encodes. The code alone, so a scanner reading it gets
           something that can be looked up rather than a URL that will be
           wrong the first time anything moves. */
        qr: item.code,
        copies: l.copies,
      });
    }

    if (missing.length) {
      throw new BadRequestException(
        missing.length === 1
          ? `"${missing[0]}" is not an item in the sheet.`
          : `These are not items in the sheet: ${missing.slice(0, 5).join(', ')}`
            + (missing.length > 5 ? `, and ${missing.length - 5} more.` : '.'));
    }

    return {
      labels: out,
      total: out.reduce((n, l) => n + l.copies, 0),
      /* The two papers the warehouse uses. Stated here so the screen and the
         stylesheet cannot drift apart on the dimensions. */
      papers: [
        { key: 'label', label: 'Label printer — 50 × 30 mm', width: 50, height: 30 },
        { key: 'a4', label: 'A4 sheet (many labels)', width: 210, height: 297 },
      ],
    };
  }

  /* ---------------------------------------------- printed documents -- */

  /** Papers printed, newest first. */
  async documents(filter: { type?: string } = {}) {
    const rows = await this.read(PRINT_DOCS_TAB);
    const out: any[] = [];

    for (let i = rows.length - 1; i >= 1 && out.length < 300; i--) {
      const r = rows[i] ?? [];
      const serialNo = String(r[PRINT_DOCS.serial] ?? '').trim();
      if (!serialNo) continue;

      const doc = {
        rowNumber: i + 1,
        serial: serialNo,
        type: String(r[PRINT_DOCS.type] ?? '').trim(),
        transaction: String(r[PRINT_DOCS.transaction] ?? '').trim(),
        ref: String(r[PRINT_DOCS.ref] ?? '').trim(),
        units: num(r[PRINT_DOCS.units]),
        items: String(r[PRINT_DOCS.items] ?? '').trim(),
        created: r[PRINT_DOCS.created] ?? '',
        createdBy: String(r[PRINT_DOCS.createdBy] ?? '').trim(),
        /* Zero means a serial was reserved and nothing was ever printed —
           which is itself worth seeing. */
        timesPrinted: num(r[PRINT_DOCS.timesPrinted]),
        lastPrinted: r[PRINT_DOCS.lastPrinted] ?? '',
        lastPrintedBy: String(r[PRINT_DOCS.lastPrintedBy] ?? '').trim(),
      };

      if (filter.type && doc.type !== filter.type) continue;
      out.push(doc);
    }

    return out;
  }

  /**
   * Reserve a serial for a paper about to be printed.
   *
   * Handed out by the server, before printing, for the same reason the
   * receiving serial is: two people printing at once would otherwise produce
   * two papers with the same number, and nothing downstream could tell them
   * apart.
   *
   * The Apps Script leaves this ungated — anybody signed in can burn through
   * the counters. Here it needs a permission, and the route says which.
   */
  async reserve(p: Principal, dto: {
    type: string; transaction?: string; ref?: string;
    units?: number; items?: string;
  }) {
    const type = String(dto.type ?? '').trim().toUpperCase();
    const spec = DOC_TYPES[type];
    if (!spec) {
      throw new BadRequestException(
        `"${dto.type}" is not a kind of document. `
        + `Expected one of: ${Object.keys(DOC_TYPES).join(', ')}.`);
    }

    const rows = await this.read(PRINT_DOCS_TAB);
    let highest = 0;
    let width = 3;

    for (let i = 1; i < rows.length; i++) {
      const s = String(rows[i]?.[PRINT_DOCS.serial] ?? '').trim();
      const m = s.match(new RegExp(`^${spec.prefix.replace('.', '\\.')}\\s*(\\d+)$`, 'i'));
      if (!m) continue;
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > highest) {
        highest = n;
        /* Keep whatever padding is already in use, so a run of Q.C 001 does
           not become Q.C 1000 at the thousandth. */
        width = Math.max(width, m[1].length);
      }
    }

    const serialNo = `${spec.prefix} ${String(highest + 1).padStart(width, '0')}`;

    const row = new Array(PRINT_DOCS.lastPrintedBy + 1).fill('');
    row[PRINT_DOCS.serial] = serialNo;
    row[PRINT_DOCS.type] = spec.label;
    row[PRINT_DOCS.transaction] = WarehouseSheetClient.safe(dto.transaction ?? '');
    row[PRINT_DOCS.ref] = WarehouseSheetClient.safe(dto.ref ?? '');
    row[PRINT_DOCS.units] = Number(dto.units) || '';
    row[PRINT_DOCS.items] = WarehouseSheetClient.safe(dto.items ?? '');
    row[PRINT_DOCS.created] = sheetDate(DateTime.now().setZone(TZ));
    row[PRINT_DOCS.createdBy] = WarehouseSheetClient.safe(who(p));
    row[PRINT_DOCS.timesPrinted] = 0;

    await this.sheet.append(PRINT_DOCS_TAB, row);
    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.doc.reserve',
      entityType: 'warehouse_document', entityId: serialNo,
      payload: { type: spec.label, ref: dto.ref ?? null },
    });

    return { ok: true, serial: serialNo, type: spec.label };
  }

  /**
   * Record that a paper was printed.
   *
   * Counted rather than logged as separate rows: what anybody asks later is
   * "how many of these are out there", and a count answers it directly.
   */
  async recordPrint(p: Principal, serialNo: string) {
    const docs = await this.documents();
    const doc = docs.find(
      (d) => d.serial.toLowerCase() === String(serialNo ?? '').trim().toLowerCase());
    if (!doc) throw new NotFoundException(`${serialNo} is not a registered document.`);

    const at = doc.rowNumber;
    await this.sheet.write(PRINT_DOCS_TAB, `I${at}:K${at}`, [[
      doc.timesPrinted + 1,
      sheetDate(DateTime.now().setZone(TZ)),
      WarehouseSheetClient.safe(who(p)),
    ]]);

    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.doc.print',
      entityType: 'warehouse_document', entityId: doc.serial,
      /* The number this print makes. A fourth copy of a quality note is
         worth noticing, and the audit trail is where somebody will look. */
      payload: { copy: doc.timesPrinted + 1, type: doc.type },
    });

    return { ok: true, copy: doc.timesPrinted + 1 };
  }

  /** Handover papers for job orders. */
  async handovers(operationOrder?: string) {
    const rows = await this.read(DOCS_REGISTER_TAB);
    const want = operationOrder?.trim().toLowerCase();
    const out: any[] = [];

    for (let i = rows.length - 1; i >= 1 && out.length < 300; i--) {
      const r = rows[i] ?? [];
      const serialNo = String(r[DOCS_REGISTER.serial] ?? '').trim();
      if (!serialNo) continue;

      const entry = {
        rowNumber: i + 1,
        serial: serialNo,
        document: String(r[DOCS_REGISTER.document] ?? '').trim(),
        operation: String(r[DOCS_REGISTER.operation] ?? '').trim(),
        patch: String(r[DOCS_REGISTER.patch] ?? '').trim(),
        units: num(r[DOCS_REGISTER.units]),
        firstPrintedBy: String(r[DOCS_REGISTER.firstPrintedBy] ?? '').trim(),
        firstPrintedAt: r[DOCS_REGISTER.firstPrintedAt] ?? '',
        timesPrinted: num(r[DOCS_REGISTER.timesPrinted]),
        lastPrintedBy: String(r[DOCS_REGISTER.lastPrintedBy] ?? '').trim(),
        lastPrintedAt: r[DOCS_REGISTER.lastPrintedAt] ?? '',
      };

      if (want && entry.operation.toLowerCase() !== want) continue;
      out.push(entry);
    }

    return out;
  }

  /** A tab created on first use may not exist yet. */
  private async read(tab: string): Promise<any[][]> {
    try { return await this.sheet.read(tab); } catch { return [[]]; }
  }
}


function who(p: Principal): string { return p.fullName ?? p.email ?? ''; }

function num(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}