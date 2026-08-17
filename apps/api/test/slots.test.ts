/**
 * Unit tests for the booking arithmetic.
 *
 * These need no database and no server:
 *
 *   npx tsx test/slots.test.ts
 *
 * The properties pinned here are the ones people argue about in a booking
 * system -- whether 10:00–11:00 clashes with 11:00–12:00, whether a buffer
 * eats the slot before or after, whether a half-hour gap between two meetings
 * is offered for a half-hour booking. Getting these wrong does not crash
 * anything; it quietly shows the wrong times, which is worse.
 */

import {
  applyBuffer, computeFreeSlots, isWindowFree, mergeIntervals, overlaps, type Interval,
} from '../src/modules/meeting-rooms/slots';

let pass = 0, fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name} ${detail}`); }
}

/** Local wall-clock on a fixed day, so the assertions read like a calendar. */
const at = (hhmm: string) => new Date(`2026-08-18T${hhmm}:00.000Z`);
const iv = (a: string, b: string): Interval => ({ start: at(a), end: at(b) });
const times = (slots: Interval[]) =>
  slots.map((s) => s.start.toISOString().slice(11, 16));

console.log('\nslots — overlap');

check('half-open: touching intervals do not overlap',
  overlaps(iv('10:00', '11:00'), iv('11:00', '12:00')) === false);
check('a one-minute intrusion does overlap',
  overlaps(iv('10:00', '11:00'), iv('10:59', '12:00')) === true);
check('containment overlaps',
  overlaps(iv('10:00', '12:00'), iv('10:30', '11:00')) === true);
check('overlap is symmetric',
  overlaps(iv('10:00', '11:00'), iv('10:30', '11:30'))
    === overlaps(iv('10:30', '11:30'), iv('10:00', '11:00')));

console.log('\nslots — merge');

check('disjoint periods stay separate',
  mergeIntervals([iv('09:00', '10:00'), iv('11:00', '12:00')]).length === 2);
check('overlapping periods merge',
  JSON.stringify(times(mergeIntervals([iv('09:00', '11:00'), iv('10:00', '12:00')]))) === '["09:00"]');
check('touching periods merge into one',
  mergeIntervals([iv('09:00', '10:00'), iv('10:00', '11:00')]).length === 1);
check('merge is order-independent',
  mergeIntervals([iv('11:00', '12:00'), iv('09:00', '11:30')]).length === 1);
check('empty stays empty', mergeIntervals([]).length === 0);

console.log('\nslots — buffer');

{
  const [b] = applyBuffer([iv('10:00', '11:00')], 15);
  check('buffer grows a busy period on both sides',
    b.start.toISOString().slice(11, 16) === '09:45' && b.end.toISOString().slice(11, 16) === '11:15');
  check('a zero buffer changes nothing',
    applyBuffer([iv('10:00', '11:00')], 0)[0].start.getTime() === at('10:00').getTime());
}

console.log('\nslots — free slots');

{
  const slots = computeFreeSlots({
    dayStart: at('09:00'), dayEnd: at('12:00'),
    slotMinutes: 30, durationMinutes: 60, busy: [],
  });
  check('an empty day offers every fitting start',
    JSON.stringify(times(slots)) === '["09:00","09:30","10:00","10:30","11:00"]');
  check('no slot runs past closing',
    slots.every((s) => s.end <= at('12:00')));
}

{
  const slots = computeFreeSlots({
    dayStart: at('09:00'), dayEnd: at('12:00'),
    slotMinutes: 30, durationMinutes: 60, busy: [iv('10:00', '11:00')],
  });
  // 09:00 survives because it ends exactly when the booking begins -- the
  // half-open rule again, and the single most common thing to get wrong.
  check('a booking removes every start that would collide with it, and no more',
    JSON.stringify(times(slots)) === '["09:00","11:00"]');
}

{
  // 09:00-10:00 and 10:30-12:00 busy: exactly one half-hour gap.
  const slots = computeFreeSlots({
    dayStart: at('09:00'), dayEnd: at('12:00'),
    slotMinutes: 30, durationMinutes: 30,
    busy: [iv('09:00', '10:00'), iv('10:30', '12:00')],
  });
  check('a gap exactly the length of the meeting is offered',
    JSON.stringify(times(slots)) === '["10:00"]');
}

{
  const slots = computeFreeSlots({
    dayStart: at('09:00'), dayEnd: at('12:00'),
    slotMinutes: 30, durationMinutes: 30,
    busy: [iv('09:00', '10:00'), iv('10:30', '12:00')],
    bufferMinutes: 15,
  });
  check('a buffer closes a gap that would otherwise fit', slots.length === 0);
}

{
  const slots = computeFreeSlots({
    dayStart: at('09:00'), dayEnd: at('12:00'),
    slotMinutes: 30, durationMinutes: 60, busy: [], notBefore: at('10:15'),
  });
  check('starts before "now" are dropped, and a part-past slot is not rounded in',
    JSON.stringify(times(slots)) === '["10:30","11:00"]');
}

{
  check('a meeting longer than the day offers nothing',
    computeFreeSlots({
      dayStart: at('09:00'), dayEnd: at('12:00'),
      slotMinutes: 30, durationMinutes: 240, busy: [],
    }).length === 0);

  check('a zero-length meeting offers nothing rather than everything',
    computeFreeSlots({
      dayStart: at('09:00'), dayEnd: at('12:00'),
      slotMinutes: 30, durationMinutes: 0, busy: [],
    }).length === 0);

  check('a zero slot size offers nothing rather than looping forever',
    computeFreeSlots({
      dayStart: at('09:00'), dayEnd: at('12:00'),
      slotMinutes: 0, durationMinutes: 30, busy: [],
    }).length === 0);
}

console.log('\nslots — exact window');

check('a free window is free',
  isWindowFree(iv('14:00', '15:00'), [iv('09:00', '10:00')]) === true);
check('a taken window is not',
  isWindowFree(iv('09:30', '10:30'), [iv('09:00', '10:00')]) === false);
check('a window butting up against a booking is free',
  isWindowFree(iv('10:00', '11:00'), [iv('09:00', '10:00')]) === true);
check('...until a buffer is applied',
  isWindowFree(iv('10:00', '11:00'), [iv('09:00', '10:00')], 10) === false);

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.error('  failed:', failures.join(', ')); process.exit(1); }
