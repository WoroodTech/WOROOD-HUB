#!/usr/bin/env node
/**
 * End-to-end verification of the Meeting Rooms module against a running API.
 *
 *   node scripts/api-smoke-test.mjs [baseUrl]
 *
 * Every requirement from the module brief is asserted here, including the one
 * that matters most under load: concurrent requests for the same slot.
 */

const BASE = process.argv[2] ?? process.env.API_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.SEED_PASSWORD ?? 'Worood@2026';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function api(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, body: json };
}

/** A weekday, 3 days out, 09:00–10:00 Cairo time. */
function bookingWindow(dayOffset, startHour, durationMinutes = 60) {
  const day = new Date();
  day.setDate(day.getDate() + dayOffset);
  const date = day.toISOString().slice(0, 10);
  const pad = (n) => String(n).padStart(2, '0');
  const startsAt = `${date}T${pad(startHour)}:00:00+03:00`;
  const end = new Date(new Date(startsAt).getTime() + durationMinutes * 60_000);
  return { date, startsAt, endsAt: end.toISOString() };
}

async function main() {
  console.log(`\n\x1b[1mWOROOD HUB — Meeting Rooms end-to-end test\x1b[0m\n${BASE}`);

  /* ---------------------------------------------------------------- */
  section('1. Platform health');
  const health = await api('/health');
  check('health endpoint is public and reports ok', health.status === 200 && health.body.status === 'ok');
  check('database round-trip succeeds', health.body?.database === 'up');

  /* ---------------------------------------------------------------- */
  section('2. Authentication');
  const badLogin = await api('/auth/login', {
    method: 'POST',
    body: { email: 'omar.khaled@worood.co', password: 'wrong-password' },
  });
  check('wrong password is rejected with 401', badLogin.status === 401);

  const login = await api('/auth/login', {
    method: 'POST',
    body: { email: 'omar.khaled@worood.co', password: PASSWORD },
  });
  check('employee can sign in', login.status === 201 || login.status === 200, `status ${login.status}`);
  const employee = login.body;
  check('access token issued', typeof employee?.accessToken === 'string');
  check('effective permissions resolved from roles', Array.isArray(employee?.user?.permissions) && employee.user.permissions.length > 0);

  const adminLogin = await api('/auth/login', {
    method: 'POST',
    body: { email: 'admin@worood.co', password: PASSWORD },
  });
  const admin = adminLogin.body;
  check('administrator can sign in', typeof admin?.accessToken === 'string');

  const noToken = await api('/meeting-rooms/rooms');
  check('protected route rejects an anonymous caller', noToken.status === 401);

  const token = employee.accessToken;
  const adminToken = admin.accessToken;

  /* ---------------------------------------------------------------- */
  section('3. Module registry (extensibility contract)');
  const modules = await api('/hub/modules', { token });
  const meetingRooms = modules.body?.data?.find((m) => m.key === 'meeting-rooms');
  check('hub reports the meeting-rooms module', Boolean(meetingRooms));
  check('navigation is returned for the portal shell', (meetingRooms?.navigation?.length ?? 0) >= 3);
  check('dashboard portlets are declared by the module', (meetingRooms?.portlets?.length ?? 0) >= 3);
  check(
    'admin-only nav item is hidden from a normal employee',
    !meetingRooms?.navigation?.some((n) => n.path.includes('/admin')),
  );
  const adminModules = await api('/hub/modules', { token: adminToken });
  check(
    'admin-only nav item is visible to an administrator',
    adminModules.body?.data?.[0]?.navigation?.some((n) => n.path.includes('/admin')),
  );

  /* ---------------------------------------------------------------- */
  section('4. View available meeting rooms');
  const roomsResponse = await api('/meeting-rooms/rooms', { token });
  const rooms = roomsResponse.body?.data ?? [];
  check('room list is returned', roomsResponse.status === 200 && rooms.length >= 5, `${rooms.length} rooms`);
  const sample = rooms[0];
  check('room exposes name', typeof sample?.name === 'string');
  check('room exposes capacity', typeof sample?.capacity === 'number');
  check('room exposes location', typeof sample?.location?.name === 'string');
  check('room exposes equipment list', Array.isArray(sample?.equipment));
  check(
    'at least one room advertises equipment',
    rooms.some((r) => r.equipment.length > 0),
  );

  const filtered = await api('/meeting-rooms/rooms?minCapacity=12&equipment=video-conference', { token });
  check(
    'capacity + equipment filter narrows the list',
    filtered.body.data.length > 0 && filtered.body.data.every((r) => r.capacity >= 12 && r.equipment.some((e) => e.key === 'video-conference')),
  );

  /* ---------------------------------------------------------------- */
  section('5. Check availability by date and time');
  const slot = bookingWindow(3, 9);
  const availability = await api(
    `/meeting-rooms/availability?date=${slot.date}&durationMinutes=60&startTime=09:00&minCapacity=6`,
    { token },
  );
  const options = availability.body?.data ?? [];
  check('availability search returns candidate rooms', availability.status === 200 && options.length > 0);
  check('each room reports free slots for the day', options.every((o) => Array.isArray(o.freeSlots)));
  check(
    'requested window is answered with a yes/no',
    options.every((o) => typeof o.availableForRequestedWindow === 'boolean'),
  );

  const target = options.find((o) => o.availableForRequestedWindow);
  check('at least one room is free for the requested window', Boolean(target));
  const roomId = target.room.id;

  const schedule = await api(`/meeting-rooms/rooms/${roomId}/schedule?date=${slot.date}`, { token });
  check('room day-schedule endpoint works', schedule.status === 200 && Array.isArray(schedule.body.data.busy));

  /* ---------------------------------------------------------------- */
  section('6. Reserve a meeting room');
  const created = await api('/meeting-rooms/reservations', {
    method: 'POST',
    token,
    body: {
      roomId,
      title: 'Automated test booking',
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      attendeeCount: 4,
    },
  });
  check('reservation is created', created.status === 201, `status ${created.status} ${JSON.stringify(created.body).slice(0, 160)}`);
  const reservation = created.body?.data;
  check('booking reference is issued', /^MR-\d{8}-[A-Z0-9]{4}$/.test(reservation?.reference ?? ''));
  check('reservation is confirmed', reservation?.status === 'CONFIRMED');

  const afterBooking = await api(
    `/meeting-rooms/availability?date=${slot.date}&durationMinutes=60&startTime=09:00&minCapacity=6`,
    { token },
  );
  const sameRoom = afterBooking.body.data.find((o) => o.room.id === roomId);
  check('the room now reports the window as unavailable', sameRoom?.availableForRequestedWindow === false);
  check(
    'the booking appears as a busy block on the timeline',
    sameRoom?.busy?.some((b) => b.startsAt === new Date(slot.startsAt).toISOString()),
  );

  /* ---------------------------------------------------------------- */
  section('7. Prevent double bookings');
  const duplicate = await api('/meeting-rooms/reservations', {
    method: 'POST',
    token: adminToken,
    body: { roomId, title: 'Clashing booking', startsAt: slot.startsAt, endsAt: slot.endsAt, attendeeCount: 2 },
  });
  check('identical slot is rejected with 409', duplicate.status === 409, `status ${duplicate.status}`);
  check('conflict names the meeting already holding the slot', Boolean(duplicate.body?.conflict?.reference));

  const partial = bookingWindow(3, 9);
  const overlapStart = new Date(new Date(partial.startsAt).getTime() + 30 * 60_000).toISOString();
  const overlapEnd = new Date(new Date(partial.startsAt).getTime() + 90 * 60_000).toISOString();
  const overlapping = await api('/meeting-rooms/reservations', {
    method: 'POST',
    token: adminToken,
    body: { roomId, title: 'Partial overlap', startsAt: overlapStart, endsAt: overlapEnd, attendeeCount: 2 },
  });
  check('partially overlapping slot is rejected', overlapping.status === 409);

  const backToBack = await api('/meeting-rooms/reservations', {
    method: 'POST',
    token: adminToken,
    body: {
      roomId,
      title: 'Back to back booking',
      startsAt: slot.endsAt,
      endsAt: new Date(new Date(slot.endsAt).getTime() + 60 * 60_000).toISOString(),
      attendeeCount: 2,
    },
  });
  check(
    'a meeting starting exactly when the previous ends is allowed',
    backToBack.status === 201,
    `status ${backToBack.status}`,
  );

  // The real test: simultaneous requests for one slot.
  const raceWindow = bookingWindow(5, 14);
  const attempts = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      api('/meeting-rooms/reservations', {
        method: 'POST',
        token: i % 2 === 0 ? token : adminToken,
        body: {
          roomId,
          title: `Concurrent attempt ${i + 1}`,
          startsAt: raceWindow.startsAt,
          endsAt: raceWindow.endsAt,
          attendeeCount: 2,
        },
      }),
    ),
  );
  const wins = attempts.filter((a) => a.status === 201).length;
  const conflicts = attempts.filter((a) => a.status === 409).length;
  check(
    '8 simultaneous requests for one slot → exactly 1 booking',
    wins === 1 && conflicts === 7,
    `${wins} created, ${conflicts} conflicted`,
  );

  /* ---------------------------------------------------------------- */
  section('8. Booking rules');
  const past = await api('/meeting-rooms/reservations', {
    method: 'POST',
    token,
    body: {
      roomId,
      title: 'Booking in the past',
      startsAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
      endsAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    },
  });
  check('a booking in the past is refused', past.status === 400);

  const outOfHours = bookingWindow(4, 23);
  const afterHours = await api('/meeting-rooms/reservations', {
    method: 'POST',
    token,
    body: { roomId, title: 'Midnight meeting', startsAt: outOfHours.startsAt, endsAt: outOfHours.endsAt },
  });
  check('a booking outside opening hours is refused', afterHours.status === 400);

  const tooMany = bookingWindow(6, 11);
  const overCapacity = await api('/meeting-rooms/reservations', {
    method: 'POST',
    token,
    body: { roomId, title: 'Too many people', startsAt: tooMany.startsAt, endsAt: tooMany.endsAt, attendeeCount: 999 },
  });
  check('attendees beyond room capacity are refused', overCapacity.status === 400);

  /* ---------------------------------------------------------------- */
  section('9. View upcoming and previous reservations');
  const upcoming = await api('/meeting-rooms/reservations?scope=mine&period=upcoming', { token });
  check('upcoming reservations are listed', upcoming.status === 200 && upcoming.body.data.length > 0);
  check('all upcoming reservations are in the future', upcoming.body.data.every((r) => !r.isPast));

  const history = await api('/meeting-rooms/reservations?scope=mine&period=past', { token });
  check('previous reservations are listed', history.status === 200);
  check('all previous reservations are in the past', history.body.data.every((r) => r.isPast));

  const otherPeople = await api('/meeting-rooms/reservations?scope=all', { token });
  check("an employee cannot list everyone's reservations", otherPeople.status === 403);
  const allForAdmin = await api('/meeting-rooms/reservations?scope=all', { token: adminToken });
  check('an administrator can list all reservations', allForAdmin.status === 200 && allForAdmin.body.data.length > 0);

  /* ---------------------------------------------------------------- */
  section('10. Modify a reservation');
  const newStart = new Date(new Date(slot.startsAt).getTime() + 4 * 3600_000).toISOString();
  const newEnd = new Date(new Date(slot.startsAt).getTime() + 5 * 3600_000).toISOString();
  const modified = await api(`/meeting-rooms/reservations/${reservation.id}`, {
    method: 'PATCH',
    token,
    body: { startsAt: newStart, endsAt: newEnd, title: 'Automated test booking (moved)' },
  });
  check('organizer can move their reservation', modified.status === 200, `status ${modified.status}`);
  check('new time is stored', modified.body?.data?.startsAt === newStart);
  check('title update is stored', modified.body?.data?.title === 'Automated test booking (moved)');

  const freedAgain = await api(
    `/meeting-rooms/availability?date=${slot.date}&durationMinutes=60&startTime=09:00&minCapacity=6`,
    { token },
  );
  check(
    'the vacated 09:00 slot becomes bookable again',
    freedAgain.body.data.find((o) => o.room.id === roomId)?.availableForRequestedWindow === true,
  );

  const foreign = allForAdmin.body.data.find((r) => r.organizer.email !== 'omar.khaled@worood.co' && !r.isPast);
  if (foreign) {
    const forbidden = await api(`/meeting-rooms/reservations/${foreign.id}`, {
      method: 'PATCH',
      token,
      body: { title: 'Hijack attempt' },
    });
    check("an employee cannot modify someone else's reservation", forbidden.status === 403 || forbidden.status === 404);
  }

  /* ---------------------------------------------------------------- */
  section('11. Cancel a reservation');
  const cancelled = await api(`/meeting-rooms/reservations/${reservation.id}/cancel`, {
    method: 'POST',
    token,
    body: { reason: 'Automated test cleanup' },
  });
  check('organizer can cancel', cancelled.status === 201 || cancelled.status === 200);
  check('status becomes CANCELLED', cancelled.body?.data?.status === 'CANCELLED');

  const rebooked = await api('/meeting-rooms/reservations', {
    method: 'POST',
    token: adminToken,
    body: { roomId, title: 'Re-using the freed slot', startsAt: newStart, endsAt: newEnd, attendeeCount: 2 },
  });
  check('a cancelled slot can be booked by someone else', rebooked.status === 201, `status ${rebooked.status}`);
  if (rebooked.status === 201) {
    await api(`/meeting-rooms/reservations/${rebooked.body.data.id}/cancel`, {
      method: 'POST',
      token: adminToken,
      body: { reason: 'test cleanup' },
    });
  }

  /* ---------------------------------------------------------------- */
  section('12. Dashboard portlet data');
  const next = await api('/meeting-rooms/reservations/next', { token: adminToken });
  check('next-meeting portlet returns data', next.status === 200);
  const freeNow = await api('/meeting-rooms/free-now?minutes=60', { token });
  check('free-right-now portlet returns data', freeNow.status === 200 && Array.isArray(freeNow.body.data));

  /* ---------------------------------------------------------------- */
  section('13. Token lifecycle');
  const refreshed = await api('/auth/refresh', { method: 'POST', body: { refreshToken: employee.refreshToken } });
  check('refresh token exchanges for a new access token', typeof refreshed.body?.accessToken === 'string');
  const replay = await api('/auth/refresh', { method: 'POST', body: { refreshToken: employee.refreshToken } });
  check('a refresh token cannot be replayed', replay.status === 401);

  /* ---------------------------------------------------------------- */
  console.log(
    `\n\x1b[1mResult:\x1b[0m ${passed} passed, ${failed} failed` +
      (failed ? `\n\x1b[31mFailures:\x1b[0m\n  - ${failures.join('\n  - ')}` : ''),
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nTest harness crashed:', error);
  process.exit(1);
});
