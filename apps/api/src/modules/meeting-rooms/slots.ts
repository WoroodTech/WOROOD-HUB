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
