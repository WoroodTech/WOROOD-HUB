/**
 * The paging half of reconciliation, separated so it can be proven.
 *
 * It owns one decision and nothing else: how far a run actually got. That
 * matters because the watermark is derived from it, and a watermark that moves
 * past unfetched work does not delay those orders -- it loses them. The next
 * run asks for `updated_at >= watermark`, so anything skipped and older than
 * the overlap is never requested again.
 *
 * The old loop could not express this. It ended on `!hasNextPage` and on
 * running out of pages through the same `break`, and the caller advanced the
 * watermark either way. Here the two endings are different values of
 * `complete`, and the caller is obliged to look.
 *
 * No database, no Shopify client, no clock: both effects arrive as functions,
 * so every branch below is reachable from a test.
 */

/** 50 because each order carries its line items; a hundred of those is a large
 *  response to hold and to parse. */
export const RECONCILE_PAGE_SIZE = 50;

/** A bound on how long one run may take, not a belief about how much can have
 *  changed. Hitting it is an ordinary outcome and is reported, not ignored. */
export const RECONCILE_MAX_PAGES = 40;

export interface OrderPage {
  nodes: Array<{ updatedAt?: string | null }>;
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface PaginateResult {
  /**
   * Where to resume, as Shopify's own cursor for the last page that was
   * written. Null when nothing was written.
   *
   * A timestamp cannot do this job. Orders are read in `updated_at` order, and
   * a backlog can sit entirely inside one minute -- or share a single
   * `updated_at` outright, which a bulk edit produces. Checkpointing by time
   * then puts the next run back at the start of the same set, and the same
   * pages are fetched for ever while the tail is never reached.
   *
   * Shopify's cursor resumes between two orders carrying the same instant, and
   * this is documented rather than assumed. Their engineering account of
   * relative cursors states that sorting on a non-unique field and remembering
   * only that field's last value "would potentially be skipping records", and
   * that the remedy is a secondary sort on a unique column, with both the last
   * value and the last id remembered. The API reference says the same from the
   * outside: each node's position in the list is what its cursor indicates,
   * `endCursor` is the cursor of the last node, and `after` returns the nodes
   * following it.
   *
   *   https://shopify.engineering/pagination-relative-cursors
   *   https://shopify.dev/docs/api/usage/pagination-graphql
   */
  lastCursor: string | null;
  /**
   * The error that stopped the run, if one did. Returned rather than thrown so
   * the caller can still checkpoint the pages that were written before it.
   */
  failure: Error | null;
  /** Orders returned by Shopify across every page fetched. */
  seen: number;
  /** Orders the writer reported as written. */
  written: number;
  /** Pages fetched, including any that returned nothing. */
  pages: number;
  /**
   * True only when Shopify said there was no further page. False when the page
   * ceiling stopped the run with work still behind it — which is the case the
   * caller must not treat as success.
   */
  complete: boolean;
  /**
   * The highest `updated_at` among orders actually written, or null if nothing
   * was written. Safe to resume from: the query sorts ascending and pages are
   * written in order, so every matching order at or below this point has been
   * through the writer.
   */
  lastUpdatedAt: Date | null;
}

export async function paginateOrders(opts: {
  /** One page from Shopify. */
  fetchPage: (cursor: string | null) => Promise<OrderPage>;
  /** Writes one page and returns how many rows it wrote. */
  writePage: (nodes: any[]) => Promise<number>;
  maxPages?: number;
  /** Resume point from a previous run that did not finish. */
  startCursor?: string | null;
}): Promise<PaginateResult> {
  const maxPages = opts.maxPages ?? RECONCILE_MAX_PAGES;

  let cursor: string | null = opts.startCursor ?? null;
  let seen = 0;
  let written = 0;
  let pages = 0;
  let complete = false;
  let lastUpdatedAt: Date | null = null;
  let lastCursor: string | null = null;
  let failure: Error | null = null;

  while (pages < maxPages) {
    let page: OrderPage;
    try {
      page = await opts.fetchPage(cursor);
    } catch (e) {
      /* Kept rather than thrown. Pages already written are durable, and the
         caller needs their cursor to resume from -- discarding it would make
         every transient error replay work that is already in the mirror. */
      failure = e as Error;
      break;
    }
    pages++;

    const nodes = page?.nodes ?? [];
    seen += nodes.length;

    if (nodes.length) {
      /* Written before the high-water mark moves. If the writer throws, this
         page is not counted as done and the run resumes from the page before
         it -- re-fetching work that is already in the mirror, which the upsert
         absorbs, rather than stepping over work that is not. */
      try {
        written += await opts.writePage(nodes);
      } catch (e) {
        /* The checkpoint is not moved. A page the writer did not finish may be
           half in the mirror, and the next run must cover it again; the upsert
           makes that harmless, whereas stepping over it would not be. */
        failure = e as Error;
        break;
      }

      /* Only now, after the page is durable. */
      lastCursor = page.endCursor ?? lastCursor;

      for (const n of nodes) {
        const t = n?.updatedAt ? new Date(n.updatedAt) : null;
        if (t && !Number.isNaN(t.getTime()) && (!lastUpdatedAt || t > lastUpdatedAt)) {
          lastUpdatedAt = t;
        }
      }
    }

    if (!page?.hasNextPage) { complete = true; break; }
    cursor = page.endCursor;

    /* A connection that claims another page but hands back no cursor would
       otherwise re-fetch page one until the ceiling. Stop, and report the run
       as incomplete so the watermark stays where the work got to. */
    if (!cursor) break;
  }

  return { seen, written, pages, complete, lastUpdatedAt, lastCursor, failure };
}

/**
 * Where the watermark should stand after a run.
 *
 * Only a run that reached the end of its result set moves it, and it moves to
 * the instant that run began -- taken before the first request, so anything
 * changed while the run was in flight stays inside the next run's window.
 *
 * An unfinished run returns null and the watermark is left exactly where it
 * was. It does not need to move: the cursor is what records how far the run
 * got, and resuming from it covers the remainder without widening the window.
 * This is also the only honest answer, because a run that stopped at page
 * forty has no idea what lies beyond it.
 */
export function nextWatermark(
  result: Pick<PaginateResult, 'complete'>,
  runStartedAt: Date,
): Date | null {
  return result.complete ? runStartedAt : null;
}

/** How long a stored cursor is trusted. Runs are a quarter of an hour apart,
 *  so anything older than this means something went wrong rather than that the
 *  backlog is deep -- and Shopify gives no guarantee an old cursor resolves. */
export const RESUME_MAX_AGE_MS = 2 * 60 * 60_000;

/** The overlap applied when starting from the watermark, to absorb clock skew
 *  between two independent runs. */
export const RECONCILE_OVERLAP_MS = 5 * 60_000;

/** First run with no watermark: a day, not all of history. A full load is the
 *  backfill's job and it uses a bulk operation for a reason. */
export const RECONCILE_COLD_START_MS = 24 * 60 * 60_000;

export interface SyncStateRow {
  watermark?: Date | string | null;
  resume_cursor?: string | null;
  resume_since?: Date | string | null;
}

export interface ResumePlan {
  /** The `updated_at:>=` bound for this run. */
  since: Date;
  /** Cursor to continue from, or null to start at the beginning of `since`. */
  startCursor: string | null;
  /** True when continuing an unfinished run rather than starting a fresh one. */
  resuming: boolean;
}

/**
 * Where this run should start, given what the last one left behind.
 *
 * The decision reconcile() makes, as a function, so it can be driven directly
 * by a test. Written out it is small, and every clause earns its place:
 *
 *  - A cursor is only reissued against the query that produced it, so
 *    `resume_since` travels with it and is reused verbatim.
 *  - The overlap is NOT reapplied when resuming. It exists to absorb clock
 *    skew between separate runs; a cursor is a position inside this run's own
 *    result set and needs no allowance. Reapplying it was the livelock: the
 *    window reopened before the backlog began and the same pages were read
 *    for ever.
 *  - An old cursor is dropped rather than trusted, and the run falls back to
 *    the watermark -- re-reading work the upsert already holds, which is the
 *    safe direction to be wrong in.
 */
export function resumePlan(state: SyncStateRow | null | undefined, now: Date): ResumePlan {
  const resumeSince = state?.resume_since ? new Date(state.resume_since) : null;
  const age = resumeSince ? now.getTime() - resumeSince.getTime() : Infinity;
  const resuming = !!state?.resume_cursor && !!resumeSince && age < RESUME_MAX_AGE_MS;

  if (resuming) return { since: resumeSince!, startCursor: state!.resume_cursor!, resuming: true };

  const watermark = state?.watermark ? new Date(state.watermark) : null;
  const since = new Date(watermark
    ? watermark.getTime() - RECONCILE_OVERLAP_MS
    : now.getTime() - RECONCILE_COLD_START_MS);
  return { since, startCursor: null, resuming: false };
}

/**
 * The resume point to store for the next run.
 *
 * A finished run clears it: the next run starts from the watermark, which has
 * just moved. An unfinished one keeps the cursor of the last page it actually
 * wrote, together with the `since` that cursor was produced under -- a cursor
 * only means anything against the query that issued it, so resuming has to
 * reissue the same one.
 */
export function nextResume(
  result: Pick<PaginateResult, 'complete' | 'lastCursor'>,
  since: Date,
): { cursor: string | null; since: Date | null } {
  if (result.complete) return { cursor: null, since: null };

  /* Nothing written means no new checkpoint, and the old one is dropped rather
     than kept.
  
     Kept, a cursor Shopify has started rejecting would be reissued every run
     until it aged out -- hours of a sync that cannot move. Dropped, the next
     run starts from the watermark, which has not advanced, so it re-reads
     pages the upsert absorbs and then lays down a fresh cursor. The cost is
     repeated work after a transient first-page failure; the alternative is a
     sync that stalls, and that is the worse failure. */
  if (!result.lastCursor) return { cursor: null, since: null };

  return { cursor: result.lastCursor, since };
}