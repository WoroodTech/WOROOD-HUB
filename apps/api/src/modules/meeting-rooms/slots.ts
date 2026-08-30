/**
 * Availability arithmetic. No database, no framework, no clock of its own --
 * every instant is passed in.
 *
 * Booking rules are the part of this module most likely to be argued about and
 * changed, so they live here as pure functions that `test/slots.test.ts` can
 * pin down exhaustively. The database still owns the *guarantee* against
 * double-booking; this file owns the *answer* -- whether a time is free, and
 * when the next one is.
 * The two are deliberately separate, because a slot list computed a second ago
 * is advice, and only the exclusion constraint is a promise.
 */

export interface Interval { start: Date; end: Date }

/**
 * Duration rules, system-wide rather than per-room.
 *
 * Rooms used to carry their own slot grid and minimum/maximum length, which
 * meant a twenty-minute conversation was refused by a room whose owner had
 * set a thirty-minute floor. The floor now exists for one reason only: a
 * booking of a minute or two is a mistake, not a meeting. The ceiling stops
 * someone quietly holding a room for a whole day. STEP is presentation --
 * what the time picker moves by, and what a suggested time is rounded to --
 * and nothing rejects a start time that falls off it.
 */
export const BOOKING_LIMITS = {
  MIN_MINUTES: 10,
  MAX_MINUTES: 480,
  STEP_MINUTES: 5,
} as const;

/** Half-open [start, end): a meeting ending at 10:00 does not clash with one
 *  starting at 10:00. Every comparison in this file uses this convention, and
 *  so does the GiST constraint in the database -- they must not disagree. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Merge overlapping or touching busy periods into a minimal sorted set. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((x, y) => x.start.getTime() - y.start.getTime());
  const merged: Interval[] = [{ ...sorted[0] }];

  for (const current of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (current.start <= last.end) {
      if (current.end > last.end) last.end = current.end;
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

/** Grow each busy period by the room's changeover buffer on both sides, so a
 *  room needing ten minutes to reset is not offered back-to-back. */
export function applyBuffer(intervals: Interval[], bufferMinutes: number): Interval[] {
  if (bufferMinutes <= 0) return intervals;
  const ms = bufferMinutes * 60_000;
  return intervals.map((i) => ({
    start: new Date(i.start.getTime() - ms),
    end: new Date(i.end.getTime() + ms),
  }));
}

export interface NextFreeOptions {
  /** Earliest instant worth offering -- the requested start, or now. */
  from: Date;
  /** End of the room's bookable window for the day. */
  dayEnd: Date;
  /** Length of the meeting being planned. */
  durationMinutes: number;
  /** Live reservations plus blackout windows. */
  busy: Interval[];
  bufferMinutes?: number;
  /** Round a suggestion up to this grid so the offered time is one the picker
   *  can actually land on. Alignment only ever moves a suggestion later, and
   *  the result is re-checked against `busy`, so it can never offer a taken
   *  window. */
  stepMinutes?: number;
}

/**
 * The earliest window of `durationMinutes` that fits, at or after `from`.
 *
 * This replaced `computeFreeSlots`. The old function enumerated every start
 * time on a room's grid, because the employee was picking from that list. They
 * now type a time, so the only question left is "and if that one is taken,
 * when is the next one?" -- which is one answer, not a list, and is found by
 * walking the gaps between busy periods rather than testing every candidate.
 */
export function nextFreeWindow(options: NextFreeOptions): Interval | null {
  const { from, dayEnd, durationMinutes, busy, bufferMinutes = 0, stepMinutes = 0 } = options;
  if (durationMinutes <= 0) return null;

  const durationMs = durationMinutes * 60_000;
  const blocked = mergeIntervals(applyBuffer(busy, bufferMinutes));

  const align = (t: Date): Date => {
    if (stepMinutes <= 0) return t;
    const stepMs = stepMinutes * 60_000;
    const remainder = t.getTime() % stepMs;
    return remainder === 0 ? t : new Date(t.getTime() + (stepMs - remainder));
  };

  const fits = (candidate: Date): Interval | null => {
    const window = { start: candidate, end: new Date(candidate.getTime() + durationMs) };
    if (window.end > dayEnd) return null;
    return blocked.some((b) => overlaps(window, b)) ? null : window;
  };

  let cursor = align(from);
  /* Walk forward through the busy periods. Each one either sits behind the
     cursor and is skipped, or opens a gap in front of it -- and the gap is
     only usable once the cursor has been aligned into it, which is why `fits`
     re-tests rather than trusting the arithmetic. */
  for (const b of blocked) {
    if (b.end <= cursor) continue;
    if (b.start > cursor) {
      const found = fits(cursor);
      if (found && found.end <= b.start) return found;
    }
    cursor = align(b.end);
  }

  return fits(cursor);
}

/** "Is this exact window free?" -- the check behind a direct booking, as
 *  opposed to picking from an offered list. */
export function isWindowFree(window: Interval, busy: Interval[], bufferMinutes = 0): boolean {
  return !mergeIntervals(applyBuffer(busy, bufferMinutes)).some((b) => overlaps(window, b));
}

/* ------------------------------------------------------------- timeline -- */

/** A busy period tagged with what it *is*, for callers that need to render
 *  the reason a time is blocked rather than only whether it is. */
export interface TaggedInterval<T = unknown> extends Interval {
  kind: string;
  ref: T;
}

export type TimelineBlock<T = unknown> =
  | { kind: 'BUFFER'; start: Date; end: Date }
  | { kind: string; start: Date; end: Date; ref: T };

/**
 * The same blocked timeline the availability search reasons about, but kept
 * in pieces instead of collapsed into a yes/no -- for a calendar view that
 * needs to show *why* a stretch is blocked, not only that it is.
 *
 * Uses the exact same `applyBuffer` + `mergeIntervals` pair as
 * `nextFreeWindow` and `isWindowFree`, so the boundary of "blocked" here can
 * never disagree with the boundary they exclude. Only what happens *inside*
 * each merged chunk is new: the original, unbuffered items are walked in
 * order and the gaps left over are reported as BUFFER.
 */
export function computeBlockedTimeline<T>(
  items: TaggedInterval<T>[],
  bufferMinutes: number,
): TimelineBlock<T>[] {
  if (!items.length) return [];

  // Identical computation to the availability search's `blocked` -- this is
  // the guarantee that keeps the calendar and the search agreeing.
  const merged = mergeIntervals(applyBuffer(items, bufferMinutes));

  const blocks: TimelineBlock<T>[] = [];
  for (const chunk of merged) {
    const inside = items
      .filter((it) => it.start < chunk.end && it.end > chunk.start)
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    let cursor = chunk.start;
    for (const it of inside) {
      const start = it.start > chunk.start ? it.start : chunk.start;
      const end = it.end < chunk.end ? it.end : chunk.end;
      if (end <= cursor) continue; // fully covered by a previous item already
      if (start > cursor) blocks.push({ kind: 'BUFFER', start: cursor, end: start });
      blocks.push({ kind: it.kind, start, end, ref: it.ref });
      cursor = end > cursor ? end : cursor;
    }
    if (cursor < chunk.end) blocks.push({ kind: 'BUFFER', start: cursor, end: chunk.end });
  }
  return blocks;
}

/**
 * *Why* a window is blocked, not only whether it is.
 *
 * `isWindowFree` answers yes or no, and for a long time that was all the
 * availability search asked -- which meant a room sitting in its changeover
 * buffer was reported with the same words as a room that was genuinely
 * double-booked. "Nile is taken then" when Nile has nothing booked at that
 * hour is worse than unhelpful: the employee goes looking for the meeting that
 * is in their way, and there isn't one.
 *
 * This runs the same `computeBlockedTimeline` the calendar draws from and
 * keeps only the pieces the window actually touches, so the reason an employee
 * reads and the block they can see on the calendar are the same object. An
 * empty result means free.
 */
export function blockingBlocks<T>(
  window: Interval,
  items: TaggedInterval<T>[],
  bufferMinutes = 0,
): TimelineBlock<T>[] {
  return computeBlockedTimeline(items, bufferMinutes).filter((b) => overlaps(window, b));
}

/** The instant a window stops being blocked -- the far edge of the last piece
 *  in its way. Not the same as "when is the next free window", which has to
 *  fit a whole meeting; this is just when the obstruction ends. */
export function blockedUntil(blocks: Array<{ end: Date }>): Date | null {
  if (!blocks.length) return null;
  return blocks.reduce((latest, b) => (b.end > latest ? b.end : latest), blocks[0].end);
}