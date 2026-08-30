/**
 * End-to-end verification of the booking flow, against a running API and a
 * real PostgreSQL.
 *
 *   npm run migrate && npm run seed -- --reset
 *   npm run build && node dist/main.js     (in one shell)
 *   npx tsx test/booking.test.ts           (in another)
 *
 * Mocks are deliberately absent. The properties that matter here -- that the
 * exclusion constraint refuses a double booking, that a permission boundary
 * holds, that a cancelled meeting frees its room -- are properties of the
 * database and the guards, and a mock would only prove that the mock agrees
 * with itself.
 */

import { closeDb, one, query } from '../src/common/db';
import { config } from '../src/common/config';

const BASE = `http://127.0.0.1:${config.port}/api/v1`;
let pass = 0, fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name} ${detail}`); }
}

async function login(email: string): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Worood@2026' }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`);
  return (await res.json()).accessToken;
}

const call = async (token: string, path: string, init: RequestInit = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await res.text();
  return { status: res.status, body: body ? JSON.parse(body) : null };
};

/* The seed fills the next four days with demo meetings so the home screen has
   something to show. These tests work a week out, where the calendar is empty:
   a clash in an assertion below is then the code's doing, not the seed's. */
const DAYS_OUT = 7;

const dayOut = (days: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** A Cairo wall-clock time on the test day, as an ISO instant with offset. */
const testDayAt = (hour: number, minute = 0): string =>
  `${dayOut(DAYS_OUT)}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+03:00`;

const testDate = () => dayOut(DAYS_OUT);

async function run() {
  const nadia = await login('nadia@worood.co');            // no room permissions
  const yousry = await login('Yousry@worood.co');          // no room permissions either
  const heba = await login('heba.fayed@worood.co');        // room.manage + manage-any

  /* Start from a clean slate for the rooms this test touches, so a re-run is
     not defeated by its own previous bookings. */
  await query(`DELETE FROM mr_reservations WHERE title LIKE 'TEST %'`);
  await query(`DELETE FROM mr_rooms WHERE code LIKE 'TEST-%'`);

  /* ------------------------------------------------------------ fixtures --
   *
   * Every room below is created by this test and destroyed at the end of it.
   * None of them is a seeded room.
   *
   * They used to be: the suite looked up LOTUS, JASMINE, TRAINING and STUDIO
   * by code, which made it a hostage to the seed. When Worood replaced the
   * demonstration inventory with its real rooms, every one of those lookups
   * returned `undefined` and the suite failed for reasons that had nothing to
   * do with the code it was meant to be checking. Naming a fixture after the
   * property it carries rather than after a room somebody might delete is the
   * whole fix.
   *
   * The behaviours below still have to be exercised: a room that closes early,
   * a room that needs approval, a room in maintenance. Rather than hoping the
   * catalogue happens to contain one of each, the test creates them, and
   * removes them at the end. The only thing it now asks of the seed is that at
   * least one room exists.
   */
  console.log('\nbooking — catalogue');

  const rooms = await call(nadia, '/meeting-rooms/rooms');
  check('any employee can read the room catalogue', rooms.status === 200 && rooms.body.rooms.length > 0);

  const locationId = rooms.body.rooms[0]?.location?.id;
  if (!locationId) throw new Error('no rooms in the catalogue — run the seed first');

  const makeRoom = async (body: Record<string, unknown>) => {
    const res = await call(heba, '/meeting-rooms/admin/rooms', {
      method: 'POST', body: JSON.stringify({ locationId, ...body }),
    });
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`fixture room ${body.code} failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body;
  };

  // The everyday room: default hours, no buffer, books instantly.
  const plainRoom = await makeRoom({
    code: 'TEST-PLAIN', name: 'Test Plain Room', capacity: 6,
    equipmentKeys: ['whiteboard'],
  });
  // Small, for the capacity refusal.
  const smallRoom = await makeRoom({
    code: 'TEST-SMALL', name: 'Test Small Room', capacity: 4,
  });
  // Closes at 17:00 and carries a projector, for the after-hours refusal and
  // the equipment filter.
  const earlyRoom = await makeRoom({
    code: 'TEST-EARLY', name: 'Test Early Closing', capacity: 30,
    closesAt: '17:00', equipmentKeys: ['projector'],
  });
  // Holds bookings for approval.
  const approvalRoom = await makeRoom({
    code: 'TEST-APPROVAL', name: 'Test Approval Room', capacity: 5,
    requiresApproval: true,
  });
  // Ten minutes of changeover, for the buffer distinction.
  const bufferedRoom = await makeRoom({
    code: 'TEST-BUFFER', name: 'Test Buffered Room', capacity: 8,
    bufferMinutes: 10,
  });

  const cleanUpFixtures = async () => {
    await query(`DELETE FROM mr_reservations WHERE room_id IN
                   (SELECT id FROM mr_rooms WHERE code LIKE 'TEST-%')`);
    await query(`DELETE FROM mr_room_blackouts WHERE room_id IN
                   (SELECT id FROM mr_rooms WHERE code LIKE 'TEST-%')`);
    await query(`DELETE FROM mr_room_equipment WHERE room_id IN
                   (SELECT id FROM mr_rooms WHERE code LIKE 'TEST-%')`);
    await query(`DELETE FROM mr_rooms WHERE code LIKE 'TEST-%'`);
  };

  check('a room created through the admin API comes back with its policy',
    !!plainRoom?.id && /^\d{2}:\d{2}$/.test(plainRoom.opensAt) && plainRoom.maxAdvanceDays > 0
    && typeof plainRoom.bufferMinutes === 'number');
  check('the slot grid and per-room duration limits are gone from the wire',
    plainRoom.slotMinutes === undefined
    && plainRoom.minDurationMinutes === undefined
    && plainRoom.maxDurationMinutes === undefined);
  check('fittings come back from the catalogue, not an array column',
    earlyRoom.equipment.some((e: any) => e.key === 'projector'));

  const filtered = await call(nadia, '/meeting-rooms/rooms?minCapacity=10&equipment=projector');
  check('capacity and equipment filters both apply',
    filtered.status === 200
    && filtered.body.rooms.length > 0
    && filtered.body.rooms.every((r: any) =>
      r.capacity >= 10 && r.equipment.some((e: any) => e.key === 'projector')));

  console.log('\nbooking — availability');

  const avail = await call(nadia,
    `/meeting-rooms/availability?date=${testDate()}&startTime=09:00&durationMinutes=60`);
  check('availability answers one window rather than listing slots',
    avail.status === 200 && Array.isArray(avail.body.alternatives)
    && typeof avail.body.startsAt === 'string');
  check('rooms free at that time come back as alternatives',
    avail.body.alternatives.length > 0);

  /* Twenty minutes used to be refused outright by whichever room had the
     longer minimum. The point of the change is that no room has an opinion
     about duration any more. */
  const odd = await call(nadia,
    `/meeting-rooms/availability?date=${testDate()}&startTime=10:20&durationMinutes=20`);
  check('an off-grid start and a short duration are both accepted',
    odd.status === 200 && odd.body.durationMinutes === 20
    && odd.body.startsAt.includes('10:20'));

  const tooShort = await call(nadia,
    `/meeting-rooms/availability?date=${testDate()}&startTime=10:00&durationMinutes=4`);
  check('below the system floor is refused by validation, not by a room',
    tooShort.status === 400);

  const named = await call(nadia,
    `/meeting-rooms/availability?date=${testDate()}&startTime=09:00&durationMinutes=60&roomId=${plainRoom.id}`);
  check('naming a room answers about that room specifically',
    named.status === 200 && named.body.requested?.room?.code === plainRoom.code
    && typeof named.body.requested.available === 'boolean');
  check('the named room is never repeated among the alternatives',
    named.body.alternatives.every((a: any) => a.room.code !== plainRoom.code));

  const outOfHours = await call(nadia,
    `/meeting-rooms/availability?date=${testDate()}&startTime=03:00&durationMinutes=60&roomId=${plainRoom.id}`);
  check('a window outside opening hours is refused with the hours in the message',
    outOfHours.body.requested?.available === false
    && /open/i.test(outOfHours.body.requested?.reason ?? ''));
  check('a refusal that has nothing to do with the timeline carries no blockedBy',
    outOfHours.body.requested?.blockedBy === undefined);

  /* A room in its changeover buffer used to be reported in exactly the same
     words as one that was genuinely double-booked, which sent people hunting
     for a meeting that was not there. The fixture above carries a ten-minute
     buffer, so a window starting the moment a booking ends is the case. */
  /* A room in its changeover buffer used to be reported in exactly the same
     words as one that was genuinely double-booked, which sent people hunting
     for a meeting that was not there. Booked deliberately here rather than
     hoping the catalogue contains a buffered room. */
  const buffered = await call(nadia, '/meeting-rooms/reservations', {
    method: 'POST',
    body: JSON.stringify({
      roomId: bufferedRoom.id, title: 'TEST buffer neighbour',
      startsAt: testDayAt(10, 30), endsAt: testDayAt(10, 55), attendeeCount: 2,
    }),
  });
  check('a booking beside a buffer is accepted', buffered.status === 201,
    `got ${buffered.status}`);

  // 11:00 is clear of the meeting and inside its ten-minute changeover.
  const inChangeover = await call(nadia,
    `/meeting-rooms/availability?date=${testDate()}&startTime=11:00&durationMinutes=30&roomId=${bufferedRoom.id}`);
  check('a window inside the changeover is refused',
    inChangeover.body.requested?.available === false);
  check('...named as a buffer rather than as a booking',
    inChangeover.body.requested?.blockedBy === 'BUFFER',
    inChangeover.body.requested?.blockedBy);
  check('...and never claims the room is taken',
    !/taken/i.test(inChangeover.body.requested?.reason ?? ''),
    inChangeover.body.requested?.reason);
  check('...while reporting the minute it frees up',
    /11:05/.test(inChangeover.body.requested?.reason ?? ''),
    inChangeover.body.requested?.reason);

  // Over the meeting itself, the same room reports a booking.
  const onBooking = await call(nadia,
    `/meeting-rooms/availability?date=${testDate()}&startTime=10:40&durationMinutes=20&roomId=${bufferedRoom.id}`);
  check('a window over the meeting is named as a booking',
    onBooking.body.requested?.blockedBy === 'BOOKING');

  console.log('\nbooking — making one');

  const booked = await call(nadia, '/meeting-rooms/reservations', {
    method: 'POST',
    body: JSON.stringify({
      roomId: plainRoom.id, title: 'TEST range planning',
      startsAt: testDayAt(10), endsAt: testDayAt(11), attendeeCount: 4,
    }),
  });
  check('an employee can book a free room', booked.status === 201 || booked.status === 200,
    JSON.stringify(booked.body).slice(0, 160));
  check('the booking is confirmed and carries a reference',
    booked.body?.status === 'CONFIRMED' && /^MR-\d{4}-\d{4}$/.test(booked.body?.reference ?? ''),
    booked.body?.reference);
  check('the organiser may manage what they booked', booked.body?.canManage === true);

  console.log('\nbooking — the guarantee');

  const clash = await call(yousry, '/meeting-rooms/reservations', {
    method: 'POST',
    body: JSON.stringify({
      roomId: plainRoom.id, title: 'TEST overlapping',
      startsAt: testDayAt(10, 30), endsAt: testDayAt(11, 30), attendeeCount: 2,
    }),
  });
  check('an overlapping booking is refused', clash.status === 409, `got ${clash.status}`);
  check('...and says who has the room',
    clash.body?.error?.message?.includes(plainRoom.name) === true,
    clash.body?.error?.message);

  const abutting = await call(yousry, '/meeting-rooms/reservations', {
    method: 'POST',
    body: JSON.stringify({
      roomId: plainRoom.id, title: 'TEST straight after',
      startsAt: testDayAt(11), endsAt: testDayAt(12), attendeeCount: 2,
    }),
  });
  check('a booking starting exactly when another ends is allowed',
    abutting.status === 201 || abutting.status === 200,
    JSON.stringify(abutting.body).slice(0, 160));

  /* The same rule, proven at the database rather than through the API: two
     concurrent inserts, only one of which may survive. */
  const settled = await Promise.allSettled([
    query(`INSERT INTO mr_reservations (reference, room_id, organizer_id, title, starts_at, ends_at, attendees)
           SELECT 'MR-RACE-A', $1, id, 'TEST race a', $2, $3, 2 FROM core_users WHERE email = 'nadia@worood.co'`,
      [plainRoom.id, testDayAt(15), testDayAt(16)]),
    query(`INSERT INTO mr_reservations (reference, room_id, organizer_id, title, starts_at, ends_at, attendees)
           SELECT 'MR-RACE-B', $1, id, 'TEST race b', $2, $3, 2 FROM core_users WHERE email = 'Yousry@worood.co'`,
      [plainRoom.id, testDayAt(15, 30), testDayAt(16, 30)]),
  ]);
  check('two concurrent inserts for the same room: exactly one survives',
    settled.filter((s) => s.status === 'fulfilled').length === 1,
    settled.map((s) => s.status).join(','));

  console.log('\nbooking — policy');

  const tooBig = await call(nadia, '/meeting-rooms/reservations', {
    method: 'POST',
    body: JSON.stringify({
      roomId: smallRoom.id, title: 'TEST too many people',
      startsAt: testDayAt(9), endsAt: testDayAt(10), attendeeCount: 40,
    }),
  });
  check('a booking beyond the room’s capacity is refused', tooBig.status === 400);
  check('...naming the capacity', /seats 4/.test(tooBig.body?.error?.message ?? ''),
    tooBig.body?.error?.message);

  const afterHours = await call(nadia, '/meeting-rooms/reservations', {
    method: 'POST',
    body: JSON.stringify({
      roomId: earlyRoom.id, title: 'TEST after hours',
      startsAt: testDayAt(19), endsAt: testDayAt(20), attendeeCount: 5,
    }),
  });
  check('a booking outside opening hours is refused', afterHours.status === 400);
  check('...naming the hours', /08:00–17:00/.test(afterHours.body?.error?.message ?? ''),
    afterHours.body?.error?.message);

  const inThePast = await call(nadia, '/meeting-rooms/reservations', {
    method: 'POST',
    body: JSON.stringify({
      roomId: plainRoom.id, title: 'TEST yesterday',
      startsAt: '2020-01-01T10:00:00+03:00', endsAt: '2020-01-01T11:00:00+03:00',
    }),
  });
  check('a booking in the past is refused', inThePast.status === 400);

  const held = await call(nadia, '/meeting-rooms/reservations', {
    method: 'POST',
    body: JSON.stringify({
      roomId: approvalRoom.id, title: 'TEST approval room',
      startsAt: testDayAt(14), endsAt: testDayAt(15), attendeeCount: 3,
    }),
  });
  check('a room requiring approval books as PENDING, not CONFIRMED',
    held.body?.status === 'PENDING', held.body?.status);

  const pendingBlocks = await call(yousry, '/meeting-rooms/reservations', {
    method: 'POST',
    body: JSON.stringify({
      roomId: approvalRoom.id, title: 'TEST over a pending hold',
      startsAt: testDayAt(14, 30), endsAt: testDayAt(15, 30), attendeeCount: 2,
    }),
  });
  check('a pending hold still reserves the slot', pendingBlocks.status === 409);

  console.log('\nbooking — blackouts');

  /* The seed used to carry one blackout so availability had something to
     refuse that was not a booking. It is demonstration data and Worood's
     install has none, so the test makes its own -- blackouts have no API yet
     (only SQL), which is itself worth remembering. */
  const blackoutDay = dayOut(2);
  await query(
    `INSERT INTO mr_room_blackouts (room_id, starts_at, ends_at, reason)
     VALUES ($1, $2::timestamptz, $3::timestamptz, 'Projector replacement')`,
    [earlyRoom.id, `${blackoutDay}T09:00:00+03:00`, `${blackoutDay}T13:00:00+03:00`]);
  const blocked = await call(nadia, '/meeting-rooms/reservations', {
    method: 'POST',
    body: JSON.stringify({
      roomId: earlyRoom.id, title: 'TEST during a blackout',
      startsAt: `${blackoutDay}T10:00:00+03:00`, endsAt: `${blackoutDay}T11:00:00+03:00`,
      attendeeCount: 5,
    }),
  });
  check('a blackout blocks a booking', blocked.status === 409, `got ${blocked.status}`);
  check('...and says why, rather than blaming another meeting',
    /Projector replacement/.test(blocked.body?.error?.message ?? ''),
    blocked.body?.error?.message);

  console.log('\nbooking — whose booking it is');

  const omniaCancels = await call(yousry, `/meeting-rooms/reservations/${booked.body.id}`, {
    method: 'DELETE', body: JSON.stringify({ reason: 'not mine to cancel' }),
  });
  check('an employee cannot cancel someone else’s booking', omniaCancels.status === 403);

  const hebaCancels = await call(heba, `/meeting-rooms/reservations/${booked.body.id}`, {
    method: 'DELETE', body: JSON.stringify({ reason: 'TEST facilities override' }),
  });
  check('facilities can cancel anyone’s booking', hebaCancels.status === 200);
  check('...and the cancellation is recorded, not erased',
    hebaCancels.body?.status === 'CANCELLED'
    && hebaCancels.body?.cancellationReason === 'TEST facilities override');

  const reused = await call(yousry, '/meeting-rooms/reservations', {
    method: 'POST',
    body: JSON.stringify({
      roomId: plainRoom.id, title: 'TEST reusing the freed slot',
      startsAt: testDayAt(10), endsAt: testDayAt(11), attendeeCount: 2,
    }),
  });
  check('cancelling frees the room with no cleanup step',
    reused.status === 201 || reused.status === 200,
    JSON.stringify(reused.body).slice(0, 160));

  console.log('\nbooking — room administration');

  const nadiaCreates = await call(yousry, '/meeting-rooms/admin/rooms', {
    method: 'POST',
    body: JSON.stringify({ code: 'TEST1', name: 'Test room', locationId: plainRoom.location.id, capacity: 4 }),
  });
  check('creating a room without the permission is refused', nadiaCreates.status === 403);

  const created = await call(heba, '/meeting-rooms/admin/rooms', {
    method: 'POST',
    body: JSON.stringify({
      code: 'TEST1', name: 'TEST room', locationId: plainRoom.location.id, capacity: 4,
      equipmentKeys: ['whiteboard'],
    }),
  });
  check('facilities can create a room', created.status === 201 || created.status === 200,
    JSON.stringify(created.body).slice(0, 160));

  const badPolicy = await call(heba, `/meeting-rooms/admin/rooms/${created.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ code: 'TEST1', name: 'TEST room', locationId: plainRoom.location.id,
                           capacity: 4, opensAt: '18:00', closesAt: '08:00' }),
  });
  check('a room that closes before it opens is refused',
    badPolicy.status === 400, badPolicy.body?.error?.message);

  const tooNarrow = await call(heba, `/meeting-rooms/admin/rooms/${created.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ code: 'TEST1', name: 'TEST room', locationId: plainRoom.location.id,
                           capacity: 4, opensAt: '09:00', closesAt: '09:05' }),
  });
  check('a room open for less than the shortest booking is refused',
    tooNarrow.status === 400, tooNarrow.body?.error?.message);

  const withBooking = await call(nadia, '/meeting-rooms/reservations', {
    method: 'POST',
    body: JSON.stringify({
      roomId: created.body.id, title: 'TEST blocks retirement',
      startsAt: testDayAt(9), endsAt: testDayAt(10), attendeeCount: 2,
    }),
  });
  check('the new room can be booked immediately', withBooking.status === 201 || withBooking.status === 200);

  const retireBusy = await call(heba, `/meeting-rooms/admin/rooms/${created.body.id}`, { method: 'DELETE' });
  check('a room with upcoming meetings cannot be retired out from under them',
    retireBusy.status === 409);
  check('...and the message says how many', /1 upcoming reservation/.test(retireBusy.body?.error?.message ?? ''),
    retireBusy.body?.error?.message);

  await call(nadia, `/meeting-rooms/reservations/${withBooking.body.id}`, {
    method: 'DELETE', body: JSON.stringify({ reason: 'TEST cleanup' }),
  });
  const retireFree = await call(heba, `/meeting-rooms/admin/rooms/${created.body.id}`, { method: 'DELETE' });
  check('once it is clear, the room retires', retireFree.status === 200);

  const afterRetire = await call(nadia, '/meeting-rooms/rooms?status=ALL');
  check('a retired room leaves the catalogue',
    !afterRetire.body.rooms.some((r: any) => r.code === 'TEST1'));

  console.log('\nbooking — the home portlets still agree');

  const next = await call(yousry, '/meeting-rooms/portlets/next-meeting');
  check('the next-meeting portlet sees the booking just made',
    next.status === 200 && next.body.meeting !== null);

  /* Clean up: the catalogue is left exactly as it was found. Every room this
     suite created is prefixed TEST-, so the sweep is by prefix rather than by
     a list somebody has to remember to extend. */
  await query(`DELETE FROM mr_reservations WHERE title LIKE 'TEST %' OR reference LIKE 'MR-RACE-%'`);
  await query(`DELETE FROM mr_rooms WHERE code = 'TEST1'`);
  await cleanUpFixtures();

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await closeDb();
  if (fail) { console.error('  failed:', failures.join(', ')); process.exit(1); }
}

/* A failure part-way through must not leave half a dozen TEST- rooms in the
   catalogue for somebody to find later, so the sweep runs on the error path
   too -- and its own failure is reported rather than replacing the real one. */
run().catch(async (e) => {
  console.error(e);
  try {
    await query(`DELETE FROM mr_reservations WHERE room_id IN
                   (SELECT id FROM mr_rooms WHERE code LIKE 'TEST-%')`);
    await query(`DELETE FROM mr_room_blackouts WHERE room_id IN
                   (SELECT id FROM mr_rooms WHERE code LIKE 'TEST-%')`);
    await query(`DELETE FROM mr_rooms WHERE code LIKE 'TEST-%' OR code = 'TEST1'`);
  } catch (cleanup) {
    console.error('  cleanup also failed:', cleanup);
  }
  await closeDb();
  process.exit(1);
});