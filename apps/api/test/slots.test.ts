/**
 * Unit tests for the booking arithmetic.
 *
 * These need no database and no server:
 *
 *   npx tsx test/slots.test.ts
 *
 * The properties pinned here are the ones people argue about in a booking
 * system -- whether 10:00–11:00 clashes with 11:00–12:00, whether a buffer
 * eats the time before or after, whether a half-hour gap between two meetings
 * is offered for a half-hour booking. Getting these wrong does not crash
 * anything; it quietly shows the wrong times, which is worse.
 *
 * `computeFreeSlots` used to be tested here and is gone. Rooms no longer
 * publish a grid of start times for an employee to pick from -- they name a
 * time, so the question is no longer "which starts fit" but "this one does
 * not, when is the next". `nextFreeWindow` answers that, and the assertions
 * below are the old ones re-pointed at it.
 */

import {
  applyBuffer, blockedUntil, blockingBlocks, isWindowFree, mergeIntervals,
  nextFreeWindow, overlaps, type Interval, type TaggedInterval,
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

console.log('\nslots — next free window');

const hhmm = (d: Date | null | undefined) => (d ? d.toISOString().slice(11, 16) : 'none');
const startOf = (w: Interval | null) => hhmm(w?.start);

{
  const w = nextFreeWindow({
    from: at('09:00'), dayEnd: at('12:00'), durationMinutes: 60, busy: [],
  });
  check('an empty day offers the time asked for, unchanged',
    startOf(w) === '09:00');
  check('the window is exactly as long as the meeting',
    !!w && w.end.getTime() - w.start.getTime() === 60 * 60_000);
}

{
  // 09:00 would end exactly when the booking begins -- the half-open rule
  // again, and the single most common thing to get wrong.
  const w = nextFreeWindow({
    from: at('09:00'), dayEnd: at('12:00'), durationMinutes: 60,
    busy: [iv('10:00', '11:00')],
  });
  check('a request that ends where a booking starts is granted, not deferred',
    startOf(w) === '09:00');
}

{
  const w = nextFreeWindow({
    from: at('10:00'), dayEnd: at('12:00'), durationMinutes: 60,
    busy: [iv('10:00', '11:00')],
  });
  check('a taken time is answered with the moment it frees up',
    startOf(w) === '11:00');
}

{
  // 09:00-10:00 and 10:30-12:00 busy: exactly one half-hour gap.
  const w = nextFreeWindow({
    from: at('09:00'), dayEnd: at('12:00'), durationMinutes: 30,
    busy: [iv('09:00', '10:00'), iv('10:30', '12:00')],
  });
  check('a gap exactly the length of the meeting is found',
    startOf(w) === '10:00');
}

{
  const w = nextFreeWindow({
    from: at('09:00'), dayEnd: at('12:00'), durationMinutes: 30,
    busy: [iv('09:00', '10:00'), iv('10:30', '12:00')],
    bufferMinutes: 15,
  });
  check('a buffer closes a gap that would otherwise fit', w === null);
}

{
  const w = nextFreeWindow({
    from: at('10:07'), dayEnd: at('12:00'), durationMinutes: 30, busy: [],
    stepMinutes: 5,
  });
  check('a suggestion is rounded up onto the picker step, never down',
    startOf(w) === '10:10');
}

{
  // Aligning 10:52 up to 10:55 must not be allowed to land inside 11:00-12:00
  // by arithmetic that assumed the gap was big enough before rounding.
  const w = nextFreeWindow({
    from: at('10:52'), dayEnd: at('13:00'), durationMinutes: 30,
    busy: [iv('11:00', '12:00')], stepMinutes: 5,
  });
  check('alignment cannot push a window into a booking',
    startOf(w) === '12:00');
}

{
  check('a meeting longer than what is left of the day finds nothing',
    nextFreeWindow({
      from: at('09:00'), dayEnd: at('12:00'), durationMinutes: 240, busy: [],
    }) === null);

  check('a zero-length meeting finds nothing rather than everything',
    nextFreeWindow({
      from: at('09:00'), dayEnd: at('12:00'), durationMinutes: 0, busy: [],
    }) === null);

  check('a fully booked day finds nothing',
    nextFreeWindow({
      from: at('09:00'), dayEnd: at('12:00'), durationMinutes: 30,
      busy: [iv('09:00', '12:00')],
    }) === null);
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

console.log('\nslots — why a window is blocked');

const tagged = (from: string, to: string, kind: string): TaggedInterval<null> =>
  ({ ...iv(from, to), kind, ref: null });

{
  const booking = [tagged('10:30', '10:55', 'BOOKING')];

  check('a window clear of everything is blocked by nothing',
    blockingBlocks(iv('14:00', '15:00'), booking, 10).length === 0);

  const onTheBooking = blockingBlocks(iv('10:40', '11:00'), booking, 10);
  check('a window over the meeting itself names the booking',
    onTheBooking.some((b) => b.kind === 'BOOKING'));

  /* The case that sent someone looking for a meeting that was not there:
     11:00 with a ten-minute buffer on a 10:30-10:55 booking. The room is
     empty; it is being reset until 11:05. */
  const onTheBuffer = blockingBlocks(iv('11:00', '11:20'), booking, 10);
  check('a window that only touches the changeover names the buffer, not the booking',
    onTheBuffer.length > 0 && onTheBuffer.every((b) => b.kind === 'BUFFER'));
  check('...and reports the minute the room frees up',
    blockedUntil(onTheBuffer)?.toISOString().slice(11, 16) === '11:05');

  check('with no buffer, the same window is clear',
    blockingBlocks(iv('11:00', '11:20'), booking, 0).length === 0);
}

{
  const mixed = [tagged('10:00', '11:00', 'BOOKING'), tagged('11:00', '12:00', 'BLACKOUT')];
  const both = blockingBlocks(iv('10:30', '11:30'), mixed, 0);
  check('a window spanning two kinds reports both, in order',
    both.length === 2 && both[0].kind === 'BOOKING' && both[1].kind === 'BLACKOUT');
}

check('nothing in the way has no end', blockedUntil([]) === null);

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.error('  failed:', failures.join(', ')); process.exit(1); }