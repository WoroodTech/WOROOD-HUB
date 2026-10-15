/**
 * Turning a bulk export back into orders, a batch at a time.
 *
 * Shopify writes the result as JSONL: one object per line, a parent followed by
 * its children, each child naming its parent in `__parentId`. Reassembling that
 * is easy if you keep everything in a map and hand back an array at the end --
 * which is what this used to do, and why importing a store's full history held
 * every order in memory at once. For WOROOD that is ninety thousand orders with
 * their line items, on a box with 768 MB for the whole process.
 *
 * So the reassembly keeps a window instead of the whole file. Orders enter in
 * the order they appear and leave once the window is full, in the same order,
 * in batches. Memory is bounded by the window rather than by the size of the
 * export.
 *
 * The window exists because children are not guaranteed to be adjacent to their
 * parent -- only to come after it. Flushing each order the moment the next one
 * starts would drop any child that arrived a few lines late. A window of a
 * thousand tolerates that separation while still bounding what is held.
 *
 * No network and no database here, so every branch is reachable from a test
 * with a string.
 */

export interface StreamOptions {
  /** Orders handed to `onBatch` at a time. */
  batchSize?: number;
  /** Orders held before the oldest is flushed. Must exceed batchSize. */
  windowSize?: number;
  /**
   * Lines already dealt with by an earlier run, skipped on resume.
   *
   * An optimisation and not a correctness mechanism: the write path is
   * idempotent, so re-reading costs time rather than accuracy. If the count is
   * ever wrong the import is still correct.
   */
  skipLines?: number;
  /** Called as each batch completes; returns how many orders were written. */
  onBatch: (orders: any[]) => Promise<number>;
  /** Called after each batch, with totals, so progress can be persisted. */
  onProgress?: (p: { lines: number; orders: number; written: number }) => Promise<void>;
  log?: { warn: (m: string) => void };
}

export interface StreamResult {
  /** Lines read from the file, including skipped and malformed ones. */
  lines: number;
  /** Lines that could not be parsed. */
  malformed: number;
  /** Orders reassembled and handed on. */
  orders: number;
  /** Orders the write path reported writing. */
  written: number;
  /** Child rows whose parent never appeared within the window. */
  orphans: number;
}

/**
 * Read a JSONL bulk result and hand it on in batches.
 *
 * `lines` is counted against the export's own `objectCount` by the caller: one
 * line is one object, so the two agreeing is what proves the download was not
 * cut short. Without that check a truncated body looks exactly like a small
 * store.
 */
export async function streamBulkJsonl(
  input: AsyncIterable<string>, opts: StreamOptions,
): Promise<StreamResult> {
  const batchSize = opts.batchSize ?? 200;
  const windowSize = Math.max(opts.windowSize ?? 1000, batchSize * 2);
  const skip = opts.skipLines ?? 0;

  /* Insertion-ordered by construction: a Map iterates in insertion order, so
     "the oldest order still open" is simply its first key. */
  const open = new Map<string, any>();
  const pendingChildren = new Map<string, any[]>();

  let lines = 0, malformed = 0, orders = 0, written = 0, orphans = 0;
  let batch: any[] = [];

  const flushBatch = async () => {
    if (!batch.length) return;
    const n = await opts.onBatch(batch);
    written += n;
    orders += batch.length;
    batch = [];
    await opts.onProgress?.({ lines, orders, written });
  };

  /** Move the oldest open order out of the window and into the batch. */
  const retireOldest = async () => {
    const first = open.keys().next();
    if (first.done) return;
    const id = first.value as string;
    const order = open.get(id)!;
    open.delete(id);
    /* Anything still waiting for this parent never arrived in time. Counted so
       a mismatch between the export and the reassembly is visible rather than
       discovered later as a missing total. */
    if (pendingChildren.has(id)) {
      orphans += pendingChildren.get(id)!.length;
      pendingChildren.delete(id);
    }
    batch.push(order);
    if (batch.length >= batchSize) await flushBatch();
  };

  for await (const raw of input) {
    const line = raw.trim();
    if (!line) continue;
    lines++;
    // Resuming: these were dealt with by the run that was interrupted.
    if (lines <= skip) continue;

    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      // One malformed line must not lose the other forty thousand.
      malformed++;
      opts.log?.warn(`skipped an unparseable JSONL line at ${lines}`);
      continue;
    }

    const parent = obj.__parentId;
    if (!parent) {
      if (!obj.id) { malformed++; opts.log?.warn(`top-level object with no id at line ${lines}`); continue; }

      /* A top-level object. Children that arrived before it -- possible when a
         parent's own line is late -- are attached now. */
      const held = pendingChildren.get(obj.id) ?? [];
      pendingChildren.delete(obj.id);
      obj.lineItems = { nodes: held.filter((c) => c.totalRefundedSet === undefined) };
      obj.refunds = held.filter((c) => c.totalRefundedSet !== undefined);

      open.set(obj.id, obj);
      if (open.size > windowSize) await retireOldest();
      continue;
    }

    /* A child. The JSONL carries no type field, so they are told apart by
       shape: a refund has totalRefundedSet, a line item has a quantity. */
    const isRefund = obj.totalRefundedSet !== undefined;
    const target = open.get(parent);
    if (target) {
      if (isRefund) target.refunds.push(obj);
      else target.lineItems.nodes.push(obj);
      continue;
    }

    /* Parent not open: either it has not been read yet, or it has already been
       retired. Held briefly in case it is the former. The map is bounded by the
       same window, so a stream of children for parents that will never come
       cannot grow without limit. */
    const held = pendingChildren.get(parent) ?? [];
    held.push(obj);
    pendingChildren.set(parent, held);
    if (pendingChildren.size > windowSize) {
      const first = pendingChildren.keys().next();
      if (!first.done) {
        orphans += pendingChildren.get(first.value as string)!.length;
        pendingChildren.delete(first.value as string);
      }
    }
  }

  // Everything still open at the end of the file is complete.
  while (open.size) await retireOldest();
  await flushBatch();

  for (const held of pendingChildren.values()) orphans += held.length;
  if (orphans) {
    opts.log?.warn(`${orphans} child rows had no parent within the window`);
  }

  return { lines, malformed, orders, written, orphans };
}

/** Lines from a byte stream, without holding the file. */
export async function* linesOf(stream: AsyncIterable<Uint8Array | string>): AsyncIterable<string> {
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      yield buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer.length) yield buffer;
}