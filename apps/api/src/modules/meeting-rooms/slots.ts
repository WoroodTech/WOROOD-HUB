/**
 * Availability arithmetic. No database, no framework, no clock of its own --
 * every instant is passed in.
 *
 * Booking rules are the part of this module most likely to be argued about and
 * changed, so they live here as pure functions that `test/slots.test.ts` can
 * pin down exhaustively. The database still owns the *guarantee* against
 * double-booking; this file owns the *offer* -- which times to show someone.
 * The two are deliberately separate, because a slot list computed a second ago
 * is advice, and only the exclusion constraint is a promise.
 */

export interface Interval { start: Date; end: Date }

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

export interface FreeSlotOptions {
  /** Start of the room's bookable window for the day, as an instant. */
  dayStart: Date;
  /** End of that window. */
  dayEnd: Date;
  /** Granularity of candidate start times, e.g. every 30 minutes. */
  slotMinutes: number;
  /** Length of the meeting being planned. */
  durationMinutes: number;
  /** Live reservations plus blackout windows. */
  busy: Interval[];
  bufferMinutes?: number;
  /** Slots starting before this instant are dropped -- usually "now", so the
   *  morning's past hours stop being offered as the day goes on. */
  notBefore?: Date;
}

/**
 * Every start time at which a meeting of `durationMinutes` fits entirely
 * inside the bookable window without touching a busy period.
 */
export function computeFreeSlots(options: FreeSlotOptions): Interval[] {
  const {
    dayStart, dayEnd, slotMinutes, durationMinutes, busy,
    bufferMinutes = 0, notBefore,
  } = options;

  if (durationMinutes <= 0 || slotMinutes <= 0) return [];

  const blocked = mergeIntervals(applyBuffer(busy, bufferMinutes));
  const stepMs = slotMinutes * 60_000;
  const durationMs = durationMinutes * 60_000;
  const slots: Interval[] = [];

  for (let t = dayStart.getTime(); t + durationMs <= dayEnd.getTime(); t += stepMs) {
    const candidate: Interval = { start: new Date(t), end: new Date(t + durationMs) };
    if (notBefore && candidate.start < notBefore) continue;
    if (blocked.some((b) => overlaps(candidate, b))) continue;
    slots.push(candidate);
  }

  return slots;
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
 * The same blocked timeline `computeFreeSlots` reasons about, but kept in
 * pieces instead of collapsed into a yes/no per slot -- for a calendar view
 * that needs to show *why* a stretch is blocked, not only that it is.
 *
 * Uses the exact same `applyBuffer` + `mergeIntervals` pair as
 * `computeFreeSlots`, so the boundary of "blocked" here can never disagree
 * with the boundary "blocked" excludes there. Only what happens *inside*
 * each merged chunk is new: the original, unbuffered items are walked in
 * order and the gaps left over are reported as BUFFER.
 */
export function computeBlockedTimeline<T>(
  items: TaggedInterval<T>[],
  bufferMinutes: number,
): TimelineBlock<T>[] {
  if (!items.length) return [];

  // Identical computation to computeFreeSlots's `blocked` -- this is the
  // guarantee that keeps the calendar and the availability search agreeing.
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
