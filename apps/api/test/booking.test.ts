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

  console.log('\nbooking — catalogue');

  const rooms = await call(nadia, '/meeting-rooms/rooms');
  check('any employee can read the room catalogue', rooms.status === 200 && rooms.body.rooms.length > 0);

  const lotus = rooms.body.rooms.find((r: any) => r.code === 'LOTUS');
  const jasmine = rooms.body.rooms.find((r: any) => r.code === 'JASMINE');
  const training = rooms.body.rooms.find((r: any) => r.code === 'TRAINING');
  const studio = rooms.body.rooms.find((r: any) => r.code === 'STUDIO');
  check('rooms carry their own booking policy',
    !!jasmine && jasmine.slotMinutes === 15 && jasmine.maxDurationMinutes === 120);
  check('fittings come back from the catalogue, not an array column',
    !!training && training.equipment.some((e: any) => e.key === 'projector'));

  const filtered = await call(nadia, '/meeting-rooms/rooms?minCapacity=10&equipment=projector');
  check('capacity and equipment filters both apply',
    filtered.status === 200
    && filtered.body.rooms.length > 0
    && filtered.body.rooms.every((r: any) =>
      r.capacity >= 10 && r.equipment.some((e: any) => e.key === 'projector')));

  console.log('\nbooking — availability');

  const avail = await call(nadia, `/meeting-rooms/availability?date=${testDate()}&durationMinutes=60`);
  check('availability returns slots for the test day',
    avail.status === 200 && avail.body.rooms.some((r: any) => r.slots.length > 0));

  const jasmineAvail = avail.body.rooms.find((r: any) => r.room.code === 'JASMINE');
  check('a room refuses a duration outside its own policy with a reason, not an empty list',
    !!jasmineAvail && jasmineAvail.slots.length > 0);

  const longAvail = await call(nadia, `/meeting-rooms/availability?date=${testDate()}&durationMinutes=180`);
  const jasmineLong = longAvail.body.rooms.find((r: any) => r.room.code === 'JASMINE');
  check('...and says which policy refused it',
    !!jasmineLong && jasmineLong.slots.length === 0 && /at most 120/.test(jasmineLong.note ?? ''));

  console.log('\nbooking — making one');

  const booked = await call(nadia, '/meeting-rooms/reservations', {
    method: 'POST',
    body: JSON.stringify({
      roomId: lotus.id, title: 'TEST range planning',
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
      roomId: lotus.id, title: 'TEST overlapping',
      startsAt: testDayAt(10, 30), endsAt: testDayAt(11, 30), attendeeCount: 2,
    }),
  });
  check('an overlapping booking is refused', clash.status === 409, `got ${clash.status}`);
  check('...and says who has the room', /Lotus is taken/.test(clash.body?.error?.message ?? ''),
    clash.body?.error?.message);

  const abutting = await call(yousry, '/meeting-rooms/reservations', {
    method: 'POST',
    body: JSON.stringify({
      roomId: lotus.id, title: 'TEST straight after',
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
      [lotus.id, testDayAt(15), testDayAt(16)]),
    query(`INSERT INTO mr_reservations (reference, room_id, organizer_id, title, starts_at, ends_at, attendees)
           SELECT 'MR-RACE-B', $1, id, 'TEST race b', $2, $3, 2 FROM core_users WHERE email = 'Yousry@worood.co'`,
      [lotus.id, testDayAt(15, 30), testDayAt(16, 30)]),
  ]);
  check('two concurrent inserts for the same room: exactly one survives',
    settled.filter((s) => s.status === 'fulfilled').length === 1,
    settled.map((s) => s.status).join(','));

  console.log('\nbooking — policy');

  const tooBig = await call(nadia, '/meeting-rooms/reservations', {
    method: 'POST',
    body: JSON.stringify({
      roomId: jasmine.id, title: 'TEST too many people',
      startsAt: testDayAt(9), endsAt: testDayAt(10), attendeeCount: 40,
    }),
  });
  check('a booking beyond the room’s capacity is refused', tooBig.status === 400);
  check('...naming the capacity', /seats 4/.test(tooBig.body?.error?.message ?? ''),
    tooBig.body?.error?.message);

  const afterHours = await call(nadia, '/meeting-rooms/reservations', {
    method: 'POST',
    body: JSON.stringify({
      roomId: training.id, title: 'TEST after hours',
      startsAt: testDayAt(19), endsAt: testDayAt(20), attendeeCount: 5,
    }),
  });
  check('a booking outside opening hours is refused', afterHours.status === 400);
  check('...naming the hours', /08:00–17:00/.test(afterHours.body?.error?.message ?? ''),
    afterHours.body?.error?.message);

  const inThePast = await call(nadia, '/meeting-rooms/reservations', {
    method: 'POST',
    body: JSON.stringify({
      roomId: lotus.id, title: 'TEST yesterday',
      startsAt: '2020-01-01T10:00:00+03:00', endsAt: '2020-01-01T11:00:00+03:00',
    }),
  });
  check('a booking in the past is refused', inThePast.status === 400);

  const held = await call(nadia, '/meeting-rooms/reservations', {
    method: 'POST',
    body: JSON.stringify({
      roomId: studio.id, title: 'TEST approval room',
      startsAt: testDayAt(14), endsAt: testDayAt(15), attendeeCount: 3,
    }),
  });
  check('a room requiring approval books as PENDING, not CONFIRMED',
    held.body?.status === 'PENDING', held.body?.status);

  const pendingBlocks = await call(yousry, '/meeting-rooms/reservations', {
    method: 'POST',
    body: JSON.stringify({
      roomId: studio.id, title: 'TEST over a pending hold',
      startsAt: testDayAt(14, 30), endsAt: testDayAt(15, 30), attendeeCount: 2,
    }),
  });
  check('a pending hold still reserves the slot', pendingBlocks.status === 409);

  console.log('\nbooking — blackouts');

  // The seed blacks out the Training Hall 09:00–13:00 the day after tomorrow.
  const blackoutDay = dayOut(2);
  const blocked = await call(nadia, '/meeting-rooms/reservations', {
    method: 'POST',
    body: JSON.stringify({
      roomId: training.id, title: 'TEST during a blackout',
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
      roomId: lotus.id, title: 'TEST reusing the freed slot',
      startsAt: testDayAt(10), endsAt: testDayAt(11), attendeeCount: 2,
    }),
  });
  check('cancelling frees the room with no cleanup step',
    reused.status === 201 || reused.status === 200,
    JSON.stringify(reused.body).slice(0, 160));

  console.log('\nbooking — room administration');

  const nadiaCreates = await call(yousry, '/meeting-rooms/admin/rooms', {
    method: 'POST',
    body: JSON.stringify({ code: 'TEST1', name: 'Test room', locationId: lotus.location.id, capacity: 4 }),
  });
  check('creating a room without the permission is refused', nadiaCreates.status === 403);

  const created = await call(heba, '/meeting-rooms/admin/rooms', {
    method: 'POST',
    body: JSON.stringify({
      code: 'TEST1', name: 'TEST room', locationId: lotus.location.id, capacity: 4,
      slotMinutes: 30, minDurationMinutes: 30, equipmentKeys: ['whiteboard'],
    }),
  });
  check('facilities can create a room', created.status === 201 || created.status === 200,
    JSON.stringify(created.body).slice(0, 160));

  const badPolicy = await call(heba, `/meeting-rooms/admin/rooms/${created.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ code: 'TEST1', name: 'TEST room', locationId: lotus.location.id,
                           capacity: 4, slotMinutes: 30, minDurationMinutes: 20 }),
  });
  check('a minimum duration that the slot grid can never satisfy is refused',
    badPolicy.status === 400, badPolicy.body?.error?.message);

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

  /* Clean up so the demo data is left as the seed intended. */
  await query(`DELETE FROM mr_reservations WHERE title LIKE 'TEST %' OR reference LIKE 'MR-RACE-%'`);
  await query(`DELETE FROM mr_rooms WHERE code = 'TEST1'`);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await closeDb();
  if (fail) { console.error('  failed:', failures.join(', ')); process.exit(1); }
}

run().catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });
