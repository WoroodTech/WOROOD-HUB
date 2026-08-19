/**
 * Inviting colleagues, and the invitation reaching their home screen.
 *
 *   npm run migrate && npm run seed -- --reset
 *   npm run build && node dist/main.js       (in one shell)
 *   npx tsx test/invitations.test.ts         (in another)
 *
 * The assertion this file exists for is the one the feature was asked for:
 * that a meeting one person books for another **appears on the other person's
 * home screen**. So it is proven by asking the *invitee's* portlet endpoints --
 * the same calls their browser makes on sign-in -- rather than by checking that
 * a row landed in a join table.
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
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Worood@2026' }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`);
  return (await res.json()).accessToken;
}

const call = async (token: string, path: string, init: RequestInit = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await res.text();
  return { status: res.status, body: body ? JSON.parse(body) : null };
};

const DAYS_OUT = 9;
const dayAt = (hour: number, minute = 0, days = DAYS_OUT): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+03:00`;
};

const userId = async (email: string): Promise<string> =>
  (await one(`SELECT id FROM core_users WHERE email = $1`, [email]))!.id;

async function cleanup() {
  await query(`DELETE FROM mr_reservations WHERE title LIKE 'INVITE %'`);
  await query(`DELETE FROM core_notifications WHERE title LIKE '%invited you%' OR body LIKE '%INVITE %'`);
}

async function run() {
  await cleanup();

  const yousry = await login('Yousry@worood.co');       // organiser
  const nadia = await login('nadia@worood.co');       // guest
  const omnia = await login('omnia.osama@worood.co');      // guest
  const nadiaId = await userId('nadia@worood.co');
  const omniaId = await userId('omnia.osama@worood.co');
  const yousryId = await userId('Yousry@worood.co');

  const rooms = await call(yousry, '/meeting-rooms/rooms');
  const nile = rooms.body.rooms.find((r: any) => r.code === 'NILE');       // seats 14
  const jasmine = rooms.body.rooms.find((r: any) => r.code === 'JASMINE'); // seats 4

  console.log('\ninvitations — booking with guests');

  const booked = await call(yousry, '/meeting-rooms/reservations', {
    method: 'POST',
    body: JSON.stringify({
      roomId: nile.id, title: 'INVITE autumn range review',
      description: 'Bring the sample board.',
      startsAt: dayAt(10), endsAt: dayAt(11),
      attendeeUserIds: [nadiaId, omniaId],
    }),
  });
  check('a meeting can be booked with colleagues named',
    booked.status === 201 || booked.status === 200, JSON.stringify(booked.body).slice(0, 200));
  const meetingId = booked.body?.id;

  check('both guests are on the reservation', booked.body?.attendees?.length === 2);
  check('each starts as INVITED, unanswered',
    booked.body?.attendees.every((a: any) => a.response === 'INVITED' && a.respondedAt === null));
  check('the headcount counts the organiser as well as the guests',
    booked.body?.attendeeCount === 3, String(booked.body?.attendeeCount));
  check('the organiser is the organiser', booked.body?.myRole === 'organiser');

  console.log('\ninvitations — it reaches their home screen');

  /* The whole point of the feature. These are the same endpoints the invitee's
     browser calls when they sign in. */
  const nadiaInvites = await call(nadia, '/meeting-rooms/portlets/my-invitations');
  check('the invitation is on the guest’s home screen',
    nadiaInvites.body?.invitations?.some((i: any) => i.id === meetingId),
    JSON.stringify(nadiaInvites.body).slice(0, 200));
  const mine = nadiaInvites.body.invitations.find((i: any) => i.id === meetingId);
  check('...naming who invited them', mine?.organiserName === 'Mohamed Yousry', mine?.organiserName);
  check('...and where it is', mine?.room === nile.name);

  const nadiaNext = await call(nadia, '/meeting-rooms/portlets/next-meeting');
  check('"my next meeting" includes a meeting somebody else booked',
    !!nadiaNext.body?.meeting, JSON.stringify(nadiaNext.body).slice(0, 160));

  const nadiaUpcoming = await call(nadia, '/meeting-rooms/portlets/upcoming-reservations');
  check('so does "my meetings"',
    nadiaUpcoming.body?.reservations?.some((r: any) => r.title === 'INVITE autumn range review'),
    (nadiaUpcoming.body?.reservations ?? []).map((r: any) => r.title).join(' | '));
  const onList = nadiaUpcoming.body.reservations.find((r: any) => r.title === 'INVITE autumn range review');
  check('...marked as not theirs, with the organiser named',
    onList?.isOrganiser === false && onList?.organiserName === 'Mohamed Yousry');

  const listed = await call(nadia, '/meeting-rooms/reservations?scope=invited&period=upcoming');
  check('the reservations screen can show only what they were invited to',
    listed.body?.reservations?.some((r: any) => r.id === meetingId)
    && listed.body.reservations.every((r: any) => r.myRole === 'attendee'),
    JSON.stringify(listed.body?.reservations?.map((r: any) => r.myRole)));

  const organised = await call(nadia, '/meeting-rooms/reservations?scope=organised&period=upcoming');
  check('...and only what they booked, which excludes this one',
    !organised.body.reservations.some((r: any) => r.id === meetingId));

  console.log('\ninvitations — they are told');

  const note = await one(
    `SELECT title, body, link FROM core_notifications
      WHERE user_id = $1 AND title LIKE '%invited you%'
      ORDER BY created_at DESC LIMIT 1`, [nadiaId]);
  check('the guest gets a notification', !!note, 'none found');
  check('...naming the organiser', /Mohamed Yousry/.test(note?.title ?? ''), note?.title);
  check('...with the time, room and reference in it',
    /INVITE autumn range review/.test(note?.body ?? '') && /Nile/.test(note?.body ?? ''),
    note?.body);

  const organiserNote = await one(
    `SELECT id FROM core_notifications WHERE user_id = $1 AND title LIKE '%invited you%'`, [yousryId]);
  check('the organiser does not invite themselves', !organiserNote);

  console.log('\ninvitations — replying');

  const notInvited = await call(await login('heba.fayed@worood.co'),
    `/meeting-rooms/reservations/${meetingId}/response`, {
      method: 'POST', body: JSON.stringify({ response: 'ACCEPTED' }),
    });
  check('somebody not invited cannot reply', notInvited.status === 404, `got ${notInvited.status}`);

  const accepted = await call(nadia, `/meeting-rooms/reservations/${meetingId}/response`, {
    method: 'POST', body: JSON.stringify({ response: 'ACCEPTED' }),
  });
  check('a guest can accept', accepted.status === 200 || accepted.status === 201);
  check('...and their own answer comes back', accepted.body?.myResponse === 'ACCEPTED');
  check('...timestamped', accepted.body?.attendees.find((a: any) => a.userId === nadiaId)?.respondedAt !== null);

  const afterAccept = await call(nadia, '/meeting-rooms/portlets/my-invitations');
  check('an answered invitation leaves the waiting list',
    !afterAccept.body.invitations.some((i: any) => i.id === meetingId));
  const stillThere = await call(nadia, '/meeting-rooms/portlets/upcoming-reservations');
  check('...but the meeting stays in their meetings',
    stillThere.body.reservations.some((r: any) => r.title === 'INVITE autumn range review'));

  const answerNote = await one(
    `SELECT title FROM core_notifications WHERE user_id = $1 AND title LIKE '%accepted%'
      ORDER BY created_at DESC LIMIT 1`, [yousryId]);
  check('the organiser is told the answer', /Nadia accepted/.test(answerNote?.title ?? ''),
    answerNote?.title);

  const declined = await call(omnia, `/meeting-rooms/reservations/${meetingId}/response`, {
    method: 'POST', body: JSON.stringify({ response: 'DECLINED' }),
  });
  check('a guest can decline', declined.body?.myResponse === 'DECLINED');

  const omniaUpcoming = await call(omnia, '/meeting-rooms/portlets/upcoming-reservations');
  check('a declined meeting drops off their own list',
    !omniaUpcoming.body.reservations.some((r: any) => r.title === 'INVITE autumn range review'));

  const asOrganiser = await call(yousry, `/meeting-rooms/reservations/${meetingId}`);
  const omniaRow = asOrganiser.body.attendees.find((a: any) => a.userId === omniaId);
  check('but the organiser still sees they were asked, and said no',
    omniaRow?.response === 'DECLINED',
    JSON.stringify(asOrganiser.body.attendees.map((a: any) => a.response)));

  console.log('\ninvitations — editing the guest list');

  /* The trap this guards: rebuilding the attendee rows on every edit would
     reset everyone's reply to INVITED, and the accepts already collected would
     silently vanish. */
  const edited = await call(yousry, `/meeting-rooms/reservations/${meetingId}`, {
    method: 'PATCH',
    body: JSON.stringify({ attendeeUserIds: [nadiaId, omniaId, await userId('heba.fayed@worood.co')] }),
  });
  check('a guest can be added later', edited.body?.attendees?.length === 3);
  const nadiaAfterEdit = edited.body.attendees.find((a: any) => a.userId === nadiaId);
  check('...without resetting the replies already given',
    nadiaAfterEdit?.response === 'ACCEPTED', nadiaAfterEdit?.response);

  const hebaId = await userId('heba.fayed@worood.co');
  const hebaNote = await one(
    `SELECT title FROM core_notifications WHERE user_id = $1 AND title LIKE '%invited you%'
      ORDER BY created_at DESC LIMIT 1`, [hebaId]);
  check('the newly added guest is told', !!hebaNote);

  const dropped = await call(yousry, `/meeting-rooms/reservations/${meetingId}`, {
    method: 'PATCH', body: JSON.stringify({ attendeeUserIds: [nadiaId] }),
  });
  check('a guest can be removed', dropped.body?.attendees?.length === 1);
  const omniaAfterDrop = await call(omnia, '/meeting-rooms/portlets/my-invitations');
  check('...and it leaves their screen',
    !omniaAfterDrop.body.invitations.some((i: any) => i.id === meetingId));

  console.log('\ninvitations — capacity and moving');

  const tooMany = await call(yousry, '/meeting-rooms/reservations', {
    method: 'POST',
    body: JSON.stringify({
      roomId: jasmine.id, title: 'INVITE too many for jasmine',
      startsAt: dayAt(14), endsAt: dayAt(15),
      attendeeUserIds: [nadiaId, omniaId, hebaId, await userId('Kandil@worood.co')],
    }),
  });
  check('naming more guests than the room seats is refused',
    tooMany.status === 400, `got ${tooMany.status}`);
  check('...counting the organiser in the total',
    /seats 4\. You have 5/.test(tooMany.body?.error?.message ?? ''),
    tooMany.body?.error?.message);

  const moved = await call(yousry, `/meeting-rooms/reservations/${meetingId}`, {
    method: 'PATCH', body: JSON.stringify({ startsAt: dayAt(15), endsAt: dayAt(16) }),
  });
  check('the organiser can move the meeting', moved.status === 200, JSON.stringify(moved.body).slice(0, 160));
  const movedNote = await one(
    `SELECT title, body FROM core_notifications WHERE user_id = $1 AND title = 'Meeting moved'
      ORDER BY created_at DESC LIMIT 1`, [nadiaId]);
  check('the guests are told it moved, not that they were invited again',
    !!movedNote && /is now/.test(movedNote.body ?? ''), movedNote?.body);

  console.log('\ninvitations — cancelling');

  const cancelled = await call(yousry, `/meeting-rooms/reservations/${meetingId}`, {
    method: 'DELETE', body: JSON.stringify({ reason: 'INVITE clash with the board' }),
  });
  check('the organiser can cancel', cancelled.body?.status === 'CANCELLED');

  const cancelNote = await one(
    `SELECT title, body FROM core_notifications WHERE user_id = $1 AND title = 'Meeting cancelled'
      ORDER BY created_at DESC LIMIT 1`, [nadiaId]);
  check('every guest is told it is off', !!cancelNote, 'no notification');
  check('...with the reason, so nobody turns up to an empty room',
    /clash with the board/.test(cancelNote?.body ?? ''), cancelNote?.body);

  const afterCancel = await call(nadia, '/meeting-rooms/portlets/upcoming-reservations');
  check('a cancelled meeting leaves the guest’s home screen',
    !afterCancel.body.reservations.some((r: any) => r.title === 'INVITE autumn range review'));

  const replyAfter = await call(nadia, `/meeting-rooms/reservations/${meetingId}/response`, {
    method: 'POST', body: JSON.stringify({ response: 'DECLINED' }),
  });
  check('and it can no longer be replied to', replyAfter.status === 409, `got ${replyAfter.status}`);

  await cleanup();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await closeDb();
  if (fail) { console.error('  failed:', failures.join(', ')); process.exit(1); }
}

run().catch(async (e) => { console.error(e); await cleanup().catch(() => undefined); await closeDb(); process.exit(1); });
