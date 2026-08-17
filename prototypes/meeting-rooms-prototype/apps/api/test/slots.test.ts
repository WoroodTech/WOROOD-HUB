/**
 * Unit tests for the booking arithmetic. Run with: npm test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyBuffer,
  computeFreeSlots,
  isWindowFree,
  mergeIntervals,
  overlaps,
} from '../src/modules/meeting-rooms/services/slots';

const t = (hhmm: string) => new Date(`2026-08-12T${hhmm}:00.000Z`);
const iv = (from: string, to: string) => ({ start: t(from), end: t(to) });
const fmt = (d: Date) => d.toISOString().slice(11, 16);

describe('overlaps', () => {
  it('detects a straightforward clash', () => {
    assert.equal(overlaps(iv('09:00', '10:00'), iv('09:30', '10:30')), true);
  });

  it('treats back-to-back meetings as free of conflict', () => {
    assert.equal(overlaps(iv('09:00', '10:00'), iv('10:00', '11:00')), false);
  });

  it('detects full containment in both directions', () => {
    assert.equal(overlaps(iv('09:00', '12:00'), iv('10:00', '11:00')), true);
    assert.equal(overlaps(iv('10:00', '11:00'), iv('09:00', '12:00')), true);
  });

  it('reports no clash for disjoint periods', () => {
    assert.equal(overlaps(iv('09:00', '10:00'), iv('14:00', '15:00')), false);
  });
});

describe('mergeIntervals', () => {
  it('collapses overlapping and touching periods', () => {
    const merged = mergeIntervals([
      iv('09:00', '10:00'),
      iv('09:30', '11:00'),
      iv('11:00', '12:00'),
      iv('14:00', '15:00'),
    ]);
    assert.equal(merged.length, 2);
    assert.equal(fmt(merged[0].start), '09:00');
    assert.equal(fmt(merged[0].end), '12:00');
    assert.equal(fmt(merged[1].start), '14:00');
  });

  it('handles an empty list', () => {
    assert.deepEqual(mergeIntervals([]), []);
  });
});

describe('applyBuffer', () => {
  it('pads a busy period on both sides', () => {
    const [padded] = applyBuffer([iv('09:00', '10:00')], 15);
    assert.equal(fmt(padded.start), '08:45');
    assert.equal(fmt(padded.end), '10:15');
  });

  it('is a no-op when the room has no changeover buffer', () => {
    const [same] = applyBuffer([iv('09:00', '10:00')], 0);
    assert.equal(fmt(same.start), '09:00');
  });
});

describe('computeFreeSlots', () => {
  const base = {
    dayStart: t('07:00'),
    dayEnd: t('12:00'),
    slotMinutes: 30,
    durationMinutes: 60,
    busy: [] as { start: Date; end: Date }[],
  };

  it('offers every slot when the room is empty', () => {
    const slots = computeFreeSlots(base);
    assert.equal(fmt(slots[0].start), '07:00');
    assert.equal(fmt(slots[slots.length - 1].start), '11:00');
    assert.equal(slots.length, 9); // 07:00 .. 11:00 every 30 minutes
  });

  it('never proposes a slot that runs past closing time', () => {
    const slots = computeFreeSlots({ ...base, durationMinutes: 120 });
    assert.equal(fmt(slots[slots.length - 1].end), '12:00');
    assert.ok(slots.every((s) => s.end <= base.dayEnd));
  });

  it('excludes slots that clash with an existing booking', () => {
    const slots = computeFreeSlots({ ...base, busy: [iv('09:00', '10:00')] });
    const starts = slots.map((s) => fmt(s.start));
    assert.ok(!starts.includes('08:30'), '08:30–09:30 would clash');
    assert.ok(!starts.includes('09:00'));
    assert.ok(!starts.includes('09:30'));
    assert.ok(starts.includes('08:00'), '08:00–09:00 ends exactly as the meeting starts');
    assert.ok(starts.includes('10:00'), '10:00 is free again');
  });

  it('honours the room changeover buffer', () => {
    const starts = computeFreeSlots({
      ...base,
      busy: [iv('09:00', '10:00')],
      bufferMinutes: 30,
    }).map((s) => fmt(s.start));
    assert.ok(!starts.includes('08:00'), 'a 30-minute buffer blocks the 08:00–09:00 slot');
    assert.ok(!starts.includes('10:00'), 'and the 10:00 slot immediately after');
    assert.ok(starts.includes('10:30'));
  });

  it('drops slots that have already started', () => {
    const starts = computeFreeSlots({ ...base, notBefore: t('09:15') }).map((s) => fmt(s.start));
    assert.ok(!starts.includes('09:00'));
    assert.ok(starts.includes('09:30'));
  });

  it('returns nothing when the day is fully booked', () => {
    assert.equal(computeFreeSlots({ ...base, busy: [iv('07:00', '12:00')] }).length, 0);
  });

  it('returns nothing for a non-positive duration', () => {
    assert.equal(computeFreeSlots({ ...base, durationMinutes: 0 }).length, 0);
  });

  it('respects a 15-minute granularity for huddle rooms', () => {
    const slots = computeFreeSlots({ ...base, slotMinutes: 15, durationMinutes: 15 });
    assert.equal(fmt(slots[1].start), '07:15');
  });
});

describe('isWindowFree', () => {
  it('accepts an exact window in a gap between meetings', () => {
    assert.equal(isWindowFree(iv('10:00', '11:00'), [iv('09:00', '10:00'), iv('11:00', '12:00')]), true);
  });

  it('rejects a window that overlaps a meeting', () => {
    assert.equal(isWindowFree(iv('09:30', '10:30'), [iv('09:00', '10:00')]), false);
  });

  it('rejects a window that falls inside another room booking', () => {
    assert.equal(isWindowFree(iv('09:15', '09:45'), [iv('09:00', '10:00')]), false);
  });

  it('applies the buffer to an exact window check', () => {
    assert.equal(isWindowFree(iv('10:00', '11:00'), [iv('09:00', '10:00')], 15), false);
  });
});
