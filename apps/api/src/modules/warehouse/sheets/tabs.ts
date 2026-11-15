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

/**
 * `Rolls Register` — one row per physical roll of fabric.
 *
 * A roll moves Received → Planned → Issued → Reported → Delivered → Closed,
 * and the status column is the only thing that says where it is. Columns past
 * P are the sheet's own and are not written from here.
 */
export const ROLLS_REGISTER_SHAPE: Record<string, number> = {
  'Roll ID': 0, 'Roll Code': 1, 'CTN': 3, 'Meters': 4,
  'Status': 7, 'Operation Order': 11,
};

/** The six states a roll can be in. Nothing else is a status. */
export const ROLL_STATUS = [
  'Received', 'Planned', 'Issued', 'Reported', 'Delivered', 'Closed',
] as const;
export type RollStatus = (typeof ROLL_STATUS)[number];

/**
 * What may follow what.
 *
 * The Apps Script checks these one at a time, at each entry point. Written
 * out as a map, an impossible move is a lookup rather than a condition
 * somebody has to remember to add when a new step appears.
 */
export const ROLL_NEXT: Record<RollStatus, RollStatus[]> = {
  Received: ['Planned', 'Issued'],
  Planned: ['Issued'],
  Issued: ['Reported'],
  /* A job order can be reported in several batches, so Reported stays
     reachable from itself. */
  Reported: ['Reported', 'Delivered'],
  Delivered: ['Closed'],
  Closed: [],
};

export const ROLLS_WORKSHOP_TAB = 'Rolls Workshop';
export const ROLLS_WORKSHOP = {
  operationOrder: 0, issued: 1, issuedBy: 2, rolls: 3, meters: 4,
  expectedUnits: 5, gradeA: 6, gradeB: 7,
  fabricationWaste: 8, materialWaste: 9, dryClean: 10,
  delivered: 11, deliveredBy: 12, variance: 13, status: 14,
  note: 15, rollIds: 16, flag: 17,
} as const;

/* ======================================== quality ========================= */

/**
 * `Rolls Batches` — what the workshop reported, batch by batch.
 *
 * One job order can be reported several times as production finishes, which
 * is why this is a tab of its own rather than more columns on the workshop
 * row. The warehouse then receives each batch, and what it counts can differ
 * from what the workshop said — both numbers are kept, side by side, because
 * the difference is the thing anybody looking at this wants to see.
 */
export const ROLLS_BATCHES_TAB = 'Rolls Batches';
export const ROLLS_BATCHES = {
  operationOrder: 0, batch: 1, reportedAt: 2, reportedBy: 3,
  workshopTotal: 4, workshopA: 5, workshopB: 6, workshopC: 7, workshopNote: 8,
  status: 9,
  receivedOn: 10, receivedBy: 11,
  receivedA: 12, receivedB: 13, receivedC: 14, receivingNote: 15,
  flag: 16, workshopGlobal: 17, receivedGlobal: 18, fullyDelivered: 19,
} as const;

export const ROLLS_BATCHES_SHAPE: Record<string, number> = {
  'Operation Order': ROLLS_BATCHES.operationOrder,
  'Batch': ROLLS_BATCHES.batch,
  'Workshop Total': ROLLS_BATCHES.workshopTotal,
  'Status': ROLLS_BATCHES.status,
};

export const QC_TAB = 'QC Batches';
export const QC = {
  serial: 0, created: 1, createdBy: 2, txId: 3,
  status: 4, lines: 5, state: 6, updated: 7,
} as const;

/* ======================================== history ========================= */

export const AUDIT_TAB = 'App Audit Log';
export const CHANGE_TAB = 'App Change Log';
/**
 * `Return Issues` — a return that did not match its order.
 *
 * Logged by whoever opened the parcel, with a photo, and closed by the
 * Operations Manager with a comment. The three counts are the point: what
 * was shipped, what came back, and what came back that should not have.
 */
export const RETURN_ISSUES_TAB = 'Return Issues';
export const RETURN_ISSUES = {
  loggedAt: 0, issueId: 1, order: 2, orderType: 3,
  shippedPatch: 4, shippedItems: 5, returnedItems: 6, unexpectedItems: 7,
  warehouse: 8, location: 9,
  enteredBy: 10, enteredByEmail: 11, attachment: 12,
  status: 13, comment: 14, handledBy: 15, handledAt: 16,
  firstRow: 17, rows: 18,
} as const;

export const RETURN_ISSUES_SHAPE: Record<string, number> = {
  'Issue ID': RETURN_ISSUES.issueId,
  'Order #': RETURN_ISSUES.order,
  'Shipped Items': RETURN_ISSUES.shippedItems,
  'Returned Items': RETURN_ISSUES.returnedItems,
  'Status': RETURN_ISSUES.status,
};

/**
 * `Patch Log` — batch sheets printed and sent out.
 *
 * One row per patch, counting how many times it has been sent. A patch sent
 * twice is usually a reprint, and occasionally a mistake worth seeing.
 */
export const PATCH_LOG_TAB = 'Patch Log';
export const PATCH_LOG = {
  patch: 0, firstSent: 1, lastSent: 2,
  sentByEmail: 3, sentBy: 4, timesSent: 5,
  orders: 6, units: 7,
  status: 8, closedBy: 9, closedAt: 10, comments: 11, serial: 12,
} as const;

export const PATCH_LOG_SHAPE: Record<string, number> = {
  'Patch': PATCH_LOG.patch,
  'Times Sent': PATCH_LOG.timesSent,
  'Status': PATCH_LOG.status,
};

/**
 * `Print Documents` — every printed paper, by serial.
 *
 * A serial is handed out before the paper is printed, and the count of
 * reprints is kept on the row. Which matters: a quality note printed four
 * times is four pieces of paper that all look official, and knowing there
 * are four is the difference between a reprint and a forgery.
 */
export const PRINT_DOCS_TAB = 'Print Documents';
export const PRINT_DOCS = {
  serial: 0, type: 1, transaction: 2, ref: 3, units: 4, items: 5,
  created: 6, createdBy: 7,
  timesPrinted: 8, lastPrinted: 9, lastPrintedBy: 10,
} as const;

/** The kinds of paper, and the prefix each serial carries. */
export const DOC_TYPES: Record<string, { label: string; prefix: string }> = {
  QC_NOTE: { label: 'Quality note', prefix: 'Q.C' },
  WQ_NOTE: { label: 'Workshop quality note', prefix: 'W.Q' },
  HANDOVER: { label: 'Handover paper', prefix: 'Q.D' },
  PATCH: { label: 'Patch sheet', prefix: 'R.O' },
};

/** `Documents Register` — handover papers for a job order. */
export const DOCS_REGISTER_TAB = 'Documents Register';
export const DOCS_REGISTER = {
  serial: 0, document: 1, operation: 2, patch: 3, units: 4,
  firstPrintedBy: 5, firstPrintedAt: 6,
  timesPrinted: 7, lastPrintedBy: 8, lastPrintedAt: 9,
} as const;

/** `Batch Comments` — the conversation on a patch, oldest first. */
export const BATCH_COMMENTS_TAB = 'Batch Comments';
export const BATCH_COMMENTS = {
  patch: 0, at: 1, byEmail: 2, by: 3, comment: 4,
} as const;

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

/**
 * Warehouses the ledger still mentions but that are no longer counted.
 *
 * The sheet has 49,888 pieces across every name it has ever used; 45,161 of
 * those are in the five above. The rest sit in places that were retired —
 * an old transit location, a bazaar, warehouses numbered past five — and
 * counting them makes every total on the dashboard about four thousand
 * pieces too high.
 *
 * They are excluded from totals, not deleted: the rows are real history and
 * the item card still shows them, because somebody looking for a piece wants
 * to know it is in WH-06 rather than be told it does not exist.
 *
 * This list is the Apps Script's own `WH_HIDE`.
 */
export const RETIRED_WAREHOUSES = new Set([
  'WH-06', 'WH-07', 'WH-08', 'WH-09', 'BAZZAR', 'Global', 'WH-05 (Old Transit)',
]);

/** Whether a warehouse name counts towards a total. */
export function counts(warehouse: string): boolean {
  const w = String(warehouse ?? '').trim();
  return !!w && !RETIRED_WAREHOUSES.has(w);
}

/**
 * What each warehouse is for.
 *
 * WH-01 is where everything received arrives — which is why Receiving does
 * not ask for a warehouse.
 */
export const WAREHOUSE_PURPOSE: Record<string, string> = {
  'WH-01': 'Receiving',
  'WH-02': 'Sellable',
  'WH-03': 'Store',
  'WH-04': 'Workshop',
  'WH-05': 'Quality',
};

/** Where a receiving lands, always. */
export const RECEIVING_WAREHOUSE = 'WH-01';

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