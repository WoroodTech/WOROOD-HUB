/**
 * Pure availability arithmetic — no database, no framework, fully unit tested
 * in test/slots.test.ts. Keeping this logic pure is deliberate: booking rules
 * are the part of the module most likely to change, and pure functions are the
 * cheapest thing to change safely.
 */

export interface Interval {
  start: Date;
  end: Date;
}

export function overlaps(a: Interval, b: Interval): boolean {
  // Half-open [start, end): a meeting ending at 10:00 does not clash with one
  // starting at 10:00.
  return a.start < b.end && b.start < a.end;
}

/** Merge overlapping/adjacent busy periods into a minimal sorted set. */
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

/** Expand each busy period by the room's changeover buffer on both sides. */
export function applyBuffer(intervals: Interval[], bufferMinutes: number): Interval[] {
  if (bufferMinutes <= 0) return intervals;
  const ms = bufferMinutes * 60_000;
  return intervals.map((i) => ({
    start: new Date(i.start.getTime() - ms),
    end: new Date(i.end.getTime() + ms),
  }));
}

export interface FreeSlotOptions {
  /** Start of the room's bookable window for the day. */
  dayStart: Date;
  /** End of the room's bookable window for the day. */
  dayEnd: Date;
  /** Granularity of candidate start times, e.g. 30 minutes. */
  slotMinutes: number;
  /** Length of the meeting being planned. */
  durationMinutes: number;
  /** Confirmed bookings plus blackout windows. */
  busy: Interval[];
  bufferMinutes?: number;
  /** Slots that start before this instant are dropped (usually "now"). */
  notBefore?: Date;
}

/**
 * Every start time at which a meeting of `durationMinutes` fits entirely
 * inside the bookable window without touching a busy period.
 */
export function computeFreeSlots(options: FreeSlotOptions): Interval[] {
  const {
    dayStart,
    dayEnd,
    slotMinutes,
    durationMinutes,
    busy,
    bufferMinutes = 0,
    notBefore,
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

/** Convenience wrapper used by the "is this exact window free?" check. */
export function isWindowFree(window: Interval, busy: Interval[], bufferMinutes = 0): boolean {
  return !mergeIntervals(applyBuffer(busy, bufferMinutes)).some((b) => overlaps(window, b));
}
