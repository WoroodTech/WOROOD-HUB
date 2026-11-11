/**
 * Where everything is in the warehouse spreadsheet.
 *
 * Read out of the file itself rather than from the Apps Script's comments:
 * the two had already drifted apart in places. Each map is checked against
 * the tab's real header row before the first write of a process, so a column
 * somebody inserts is caught rather than silently shifting every value one to
 * the right.
 *
 * Indexes are 0-based, as the API returns them.
 */

/* ======================================== the ledger ======================= */

export const TX_TAB = 'Scarves Inventory';

/**
 * `Scarves Inventory`.
 *
 * Columns past O are formulas the sheet maintains — Group, NOTES, TOTAL
 * IN/OUT, Month, Week — and are never written from here. `Balance` (N) is a
 * formula too: writing a number into it would replace the formula for that
 * row and break every row below that refers to it.
 */
export const TX = {
  date: 0,            // A
  itemName: 1,        // B
  chPoint: 2,         // C  — local checkpoint
  nationalOrder: 3,   // D
  chPointGlobal: 4,   // E
  globalOrder: 5,     // F
  patch: 6,           // G
  chPo: 7,            // H
  stockIn: 8,         // I
  stockOut: 9,        // J
  warehouse: 10,      // K
  location: 11,       // L
  kind: 12,           // M  — Tr. Kind
  // N is the Balance formula. Deliberately absent: see above.
  enteredBy: 14,      // O
} as const;

/** The headers `assertShape` checks before writing a ledger row. */
export const TX_SHAPE: Record<string, number> = {
  'Date': TX.date,
  'Item Name': TX.itemName,
  'National Order #': TX.nationalOrder,
  'Global Order #': TX.globalOrder,
  'Patch Nu.': TX.patch,
  'Stock In': TX.stockIn,
  'Stock Out': TX.stockOut,
  'Warehouse': TX.warehouse,
  'Location': TX.location,
  'Tr. Kind': TX.kind,
  'Data Entry By': TX.enteredBy,
};

/* ======================================== the catalogue =================== */

export const ITEMS_TAB = 'Creating New Item';

/**
 * `Creating New Item`.
 *
 * Its header row is row 2, not row 1 — row 1 is blank. Reading from row 1
 * gives a row of empty strings and a catalogue that comes back with no
 * columns at all, which looks like an empty sheet rather than a wrong read.
 *
 * Only three columns are ever written: Color, Products Kind, Material. The
 * codings, the Item Code, the Description, the Group and the QR formula are
 * all computed by the sheet from those three. Writing any of them from here
 * would replace a formula with a value and stop the next row working.
 */
export const ITEMS = {
  itemCodeMirror: 0,  // A — =H{row}
  color: 1,           // B  ← written
  kind: 2,            // C  ← written
  material: 3,        // D  ← written
  colorCode: 4,       // E — VLOOKUP into Keys
  kindCode: 5,        // F — VLOOKUP into Keys
  materialCode: 6,    // G — VLOOKUP into Keys
  itemCode: 7,        // H — =E&F&G
  description: 8,     // I — =B&" "&C&" "&D   (this is the item's name in the ledger)
  group: 9,           // J — =C&" "&D
  qr: 10,             // K — an IMAGE() formula
  location: 11,       // L
} as const;

export const ITEMS_SHAPE: Record<string, number> = {
  'Color': ITEMS.color,
  'Products Kind': ITEMS.kind,
  'Material': ITEMS.material,
  'Item Code': ITEMS.itemCode,
  'Description': ITEMS.description,
  'Group': ITEMS.group,
};

/** The three coding tables an item's code is built from. */
export const KEYS_TAB = 'Keys';
export const KEYS = {
  colorName: 0, colorCode: 1,       // A, B
  kindName: 3, kindCode: 4,         // D, E
  materialName: 6, materialCode: 7, // G, H
} as const;

/* ======================================== rolls =========================== */

export const ROLLS_REGISTER_TAB = 'Rolls Register';
export const ROLLS_REGISTER = {
  rollId: 0, rollCode: 1, rollName: 2, ctn: 3, meters: 4,
  received: 5, receivedBy: 6, status: 7,
  planPriority: 8, plannedDate: 9, planNote: 10,
  operationOrder: 11, issued: 12, expectedUnits: 13, note: 14, poNumber: 15,
} as const;

export const ROLLS_WORKSHOP_TAB = 'Rolls Workshop';
export const ROLLS_WORKSHOP = {
  operationOrder: 0, issued: 1, issuedBy: 2, rolls: 3, meters: 4,
  expectedUnits: 5, gradeA: 6, gradeB: 7,
  fabricationWaste: 8, materialWaste: 9, dryClean: 10,
  delivered: 11, deliveredBy: 12, variance: 13, status: 14,
  note: 15, rollIds: 16, flag: 17,
} as const;

/* ======================================== quality ========================= */

export const QC_TAB = 'QC Batches';
export const QC = {
  serial: 0, created: 1, createdBy: 2, txId: 3,
  status: 4, lines: 5, state: 6, updated: 7,
} as const;

/* ======================================== history ========================= */

export const AUDIT_TAB = 'App Audit Log';
export const CHANGE_TAB = 'App Change Log';
export const RETURN_ISSUES_TAB = 'Return Issues';
export const PATCH_LOG_TAB = 'Patch Log';

/* ======================================== warehouses ====================== */

/**
 * Which locations exist in which warehouse.
 *
 * The Apps Script reads this from the sheet's own data-validation rules and
 * falls back to a hardcoded list. HUB does the same, and this is the
 * fallback: the sheet is the authority on what exists, but a module that
 * cannot start because a validation rule was edited is worse than one that
 * starts with last known good.
 *
 * WH-01 and WH-03 have no sub-locations at all — that is not an omission.
 */
export const WAREHOUSES = ['WH-01', 'WH-02', 'WH-03', 'WH-04', 'WH-05'] as const;

export const WAREHOUSE_LOCATIONS: Record<string, string[]> = {
  'WH-01': [],
  'WH-02': ['Local', 'Global'],
  'WH-03': [],
  'WH-04': ['B', 'C', 'Sewing', 'Hold for Revision', 'Photoshots'],
  'WH-05': ['Worood Quality', 'Workshop Quality', 'Return Check'],
};

/* ======================================== movements ======================= */

/**
 * The nine kinds the app posts.
 *
 * `Exchange` and `Composite SKUs` appear in the Apps Script's filter list and
 * in the sheet's dropdown, but no code writes either and the ledger's 34,000
 * rows contain none of them. They are filter options for historical rows, not
 * things the app creates, so they are not here.
 *
 * (`Update Credits` has three rows in the ledger and is in no list at all —
 * hand-entered, long ago. It reads fine and is never written.)
 *
 *   mode     what it does to stock
 *   ----     ---------------------
 *   out      leaves the warehouse
 *   in       arrives
 *   transfer leaves one place and arrives in another
 *   sel      the person chooses the direction
 *   none     no movement at all; the row records that something happened
 */
export interface TxType {
  kind: string;
  mode: 'in' | 'out' | 'transfer' | 'sel' | 'none';
  /** Needs an order number. */
  order?: boolean;
  /** Which reference identifies a duplicate: the order, or the patch. */
  dup?: 'order' | 'patch';
  /** A location must be given, not just a warehouse. */
  locationRequired?: boolean;
  /** Only somebody with warehouse.tx.manage may post it. */
  managerOnly?: boolean;
}

export const TX_TYPES: Record<string, TxType> = {
  NEW_ORDER: { kind: 'NEW ORDER', mode: 'out', order: true, dup: 'order' },
  RETURN: { kind: 'Return', mode: 'in', order: true, dup: 'order', locationRequired: true },
  CANCEL: { kind: 'Cancelled', mode: 'none', order: true, dup: 'order' },
  RECEIVING: { kind: 'Receiving', mode: 'in', dup: 'patch' },
  TRANSFER: { kind: 'Transfer', mode: 'transfer', dup: 'patch', locationRequired: true },
  QUALITY: { kind: 'Quality Check', mode: 'out', locationRequired: true },
  DEFECT: { kind: 'Defect', mode: 'in', locationRequired: true },

  /* The two that can move a balance with no physical movement behind them. */
  SHORTAGE: { kind: 'Shortage & Over', mode: 'sel', locationRequired: true, managerOnly: true },
  OPENBAL: { kind: 'Open Balance', mode: 'in', locationRequired: true, managerOnly: true },
};