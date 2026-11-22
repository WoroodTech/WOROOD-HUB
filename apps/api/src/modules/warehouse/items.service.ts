/**
 * Creating an item.
 *
 * Only three columns are ever written: Color, Products Kind, Material. The
 * code, the description, the group and the QR formula are all computed by the
 * sheet from those three. Writing any of them from here would replace a
 * formula with a value, and the next row that refers to it would stop
 * working.
 *
 * That constraint is why this is so short, and it is a good constraint: the
 * sheet stays the one place that decides what an item is called.
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Principal } from '../../common/auth';
import { AuditService } from '../../core/core.module';
import { WarehouseReaderService } from './sheets/warehouse-reader.service';
import { WarehouseQueueService } from './sheets/warehouse-queue.service';
import { WarehouseSheetClient } from './sheets/warehouse-sheet.client';
import { ITEMS } from './sheets/tabs';

export interface CreateItemInput {
  color: string;
  kind: string;
  material: string;
  /**
   * A name of the creator's own, instead of the one the sheet builds.
   *
   * Column I is normally `=B&" "&C&" "&D`, so the name is the three parts
   * read out. That is right for almost everything and wrong for the few
   * items whose usual name is not their description. Given one, it is
   * written over that row's formula — the rest of the column keeps its own,
   * and the ledger reads column I either way.
   */
  name?: string;
}

@Injectable()
export class WarehouseItemsService {
  private readonly log = new Logger('WarehouseItems');

  constructor(
    private readonly reader: WarehouseReaderService,
    private readonly queue: WarehouseQueueService,
    private readonly audit: AuditService,
  ) {}

  /**
   * What the form offers, and what each choice will produce.
   *
   * The coding tables are returned with the item's own columns so the screen
   * can show the code before it is created. An item whose colour has no code
   * yet is not an error — it means the coding scheme is being extended, which
   * is worth knowing before pressing the button rather than after.
   */
  async options() {
    const [coding, items] = await Promise.all([
      this.reader.codingTables(),
      this.reader.items(),
    ]);

    /* The values already in use, so the pickers offer what exists before
       anybody invents a near-duplicate of it. */
    const used = {
      colors: [...new Set(items.map((i) => i.color).filter(Boolean))].sort(),
      kinds: [...new Set(items.map((i) => i.kind).filter(Boolean))].sort(),
      materials: [...new Set(items.map((i) => i.material).filter(Boolean))].sort(),
    };

    return { coding, used };
  }

  /**
   * What the sheet will compute for a given three, without creating anything.
   *
   * Lets the screen show the code and the name as they are typed. If any of
   * the three has no code, the item code cannot be predicted and this says so
   * rather than guessing at one.
   */
  async preview(dto: CreateItemInput) {
    const { color, kind, material } = this.clean(dto);
    const coding = await this.reader.codingTables();

    const colorCode = coding.colors[color];
    const kindCode = coding.kinds[kind];
    const materialCode = coding.materials[material];

    const missing: string[] = [];
    if (!colorCode) missing.push(`the colour "${color}"`);
    if (!kindCode) missing.push(`the kind "${kind}"`);
    if (!materialCode) missing.push(`the material "${material}"`);

    return {
      /* `=E&F&G` in the sheet. */
      code: missing.length ? null : `${colorCode}${kindCode}${materialCode}`,
      /* `=B&" "&C&" "&D` — and this is what the ledger calls the item. */
      name: `${color} ${kind} ${material}`,
      group: `${kind} ${material}`,
      missing,
    };
  }

  /**
   * Create it.
   *
   * Queued like a movement rather than written straight away, for the same
   * reason: the sheet can be slow or briefly unreachable, and somebody told
   * the item was created should not find out later that it was not.
   */
  async create(p: Principal, dto: CreateItemInput) {
    const { color, kind, material } = this.clean(dto);
    const preview = await this.preview({ color, kind, material });

    if (preview.missing.length) {
      /*
       * Refused rather than created with a broken code.
       *
       * The sheet would write `#N/A` into the code column, and every row that
       * referred to it would carry the error forward. Adding the coding first
       * is a deliberate act and should look like one.
       */
      throw new BadRequestException(
        `The Keys tab has no code for ${preview.missing.join(', ')}. `
        + 'Add it there first, or the item would be created with no code.');
    }

    /* An item that already exists. The catalogue's description is what the
       ledger uses, so two rows making the same one is two items that cannot
       be told apart. */
    const items = await this.reader.items();
    const clash = items.find(
      (i) => i.name.toLowerCase() === preview.name!.toLowerCase());
    if (clash) {
      throw new BadRequestException(
        `"${clash.name}" already exists, with code ${clash.code}.`);
    }

    /*
     * Three cells, in their own columns, with everything else left empty so
     * the sheet's formulas fill them. A row shorter than the tab is extended
     * with blanks by the API, which is exactly what is wanted here.
     */
    /*
     * As wide as the description column, so a chosen name has a place to sit
     * — the cells between stay empty and the sheet's formulas fill them.
     */
    const row = new Array(ITEMS.description + 1).fill('');
    row[ITEMS.color] = WarehouseSheetClient.safe(color);
    row[ITEMS.kind] = WarehouseSheetClient.safe(kind);
    row[ITEMS.material] = WarehouseSheetClient.safe(material);

    /*
     * A chosen name goes in as the row's own value, over the formula.
     *
     * Sent with the row rather than written afterwards: the row's position
     * is decided when it is written, and a second call would have to guess
     * at it or read the tab again, with another item possibly created in
     * between.
     */
    const chosen = WarehouseSheetClient.safe(dto.name ?? '');
    if (chosen && chosen.toLowerCase() !== preview.name!.toLowerCase()) {
      row[ITEMS.description] = chosen;
    }

    const eventId = await this.queue.enqueue('ITEM', row);

    await this.audit.write({
      actorId: p.id, moduleKey: 'warehouse', action: 'warehouse.item.create',
      entityType: 'warehouse_item', entityId: eventId,
      payload: { color, kind, material, expectedCode: preview.code },
    });

    await this.reader.invalidate('items');

    return {
      ok: true,
      eventId,
      code: preview.code,
      name: preview.name,
      /* The formulas run when the row lands, so the code here is what it
         will be rather than what it is. Said plainly so nobody reports it
         missing a second later. */
      note: 'The item is on its way to the sheet. Its code and QR are '
          + 'computed there, so it appears in the catalogue once the row lands.',
    };
  }

  /** Trim, and refuse the three ways this goes wrong. */
  private clean(dto: CreateItemInput) {
    const color = String(dto?.color ?? '').trim();
    const kind = String(dto?.kind ?? '').trim();
    const material = String(dto?.material ?? '').trim();

    if (!color || !kind || !material) {
      throw new BadRequestException('A colour, a kind and a material — all three.');
    }
    for (const [what, v] of [['colour', color], ['kind', kind], ['material', material]]) {
      if (v.length > 60) throw new BadRequestException(`That ${what} is too long.`);
    }
    return { color, kind, material };
  }
}