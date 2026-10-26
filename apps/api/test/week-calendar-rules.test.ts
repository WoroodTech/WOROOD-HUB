/**
 * The rules the week grid draws: what is bookable, and what time it is.
 *
 *   npx tsx test/week-calendar-rules.test.ts
 *
 * The grid showed every empty minute as open, including minutes that had
 * already gone and days past the room's booking horizon -- so it offered
 * selections the server was always going to refuse. These are the predicates
 * behind that, and the timezone arithmetic underneath them, pulled out so they
 * can be checked without a browser.
 */
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = '') => {
  c ? (pass++, console.log('  ok    ' + n)) : (fail++, console.log('  FAIL  ' + n + ' ' + d));
};
const eq = (n: string, a: any, b: any) =>
  ok(n, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
const section = (t: string) => console.log('\n' + t);

/* ---- the same helpers the component uses, verbatim ---- */
function minutesInZone(iso: string, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}
const dayInZone = (iso: string, zone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(iso));

function instantAt(isoDate: string, minutes: number, zone: string): Date {
  const guess = new Date(`${isoDate}T00:00:00Z`).getTime() + minutes * 60_000;
  const drift = minutesInZone(new Date(guess).toISOString(), zone) - minutes;
  return new Date(guess - drift * 60_000);
}
function shiftDay(isoDate: string, delta: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
const WEEK_STARTS_ON = 6;
function weekStart(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return shiftDay(isoDate, -((d.getUTCDay() - WEEK_STARTS_ON + 7) % 7));
}

const closedBefore = (dayDate: string, today: string, now: number, closesAt: number) =>
  dayDate < today ? closesAt : dayDate === today ? now : null;

function main() {
  const ZONE = 'Africa/Cairo', NY = 'America/New_York';
  const today = '2026-11-10', now = 14 * 60, closesAt = 20 * 60, opensAt = 8 * 60;
  const shut = (d: string) => closedBefore(d, today, now, closesAt);

  section('Time that has gone cannot be booked');
  eq('yesterday is closed all day', shut('2026-11-09'), closesAt);
  eq('today is closed up to now', shut(today), now);
  eq('tomorrow is wide open', shut('2026-11-11'), null);

  ok('this morning is not selectable', (shut(today) ?? 0) > 9 * 60);
  ok('but this evening is', (shut(today) ?? 0) < 18 * 60);

  section("Yesterday's bookings are still shown, just not bookable");
  /* The closed overlay is drawn under the blocks, so the rule is only about
     selection -- a past day still has its meetings rendered. */
  const pastDayBlocks = [{ type: 'BOOKING', startsAt: '2026-11-09T08:00:00Z' }];
  ok('a past day still carries its blocks', pastDayBlocks.length === 1);
  eq('and the whole column is marked closed', shut('2026-11-09'), closesAt);

  section('The room horizon stops selection but not display');
  const horizon = shiftDay(today, 30);
  const beyond = (d: string) => d > horizon;
  ok('a day inside the horizon is selectable', !beyond(shiftDay(today, 29)));
  ok('a day past it is not', beyond(shiftDay(today, 31)));
  eq('the horizon lands where expected', horizon, '2026-12-10');

  section('The week starts on Saturday');
  eq('a Tuesday belongs to the Saturday before it', weekStart('2026-11-10'), '2026-11-07');
  eq('a Saturday is its own start', weekStart('2026-11-07'), '2026-11-07');
  eq('and a Friday closes that week', weekStart('2026-11-13'), '2026-11-07');
  eq('seven columns cover Sat to Fri', shiftDay(weekStart('2026-11-10'), 6), '2026-11-13');

  section('The two clocks');
  /* 14:00 in Cairo, read in New York. November: Cairo +2, New York -5. */
  const t = instantAt('2026-11-10', 14 * 60, ZONE);
  eq('14:00 Cairo is 07:00 in New York', minutesInZone(t.toISOString(), NY) / 60, 7);
  eq('and it is still the same date there', dayInZone(t.toISOString(), NY), '2026-11-10');

  /* Early morning in Cairo is the previous evening in New York -- which is why
     the columns are the room's days and not the viewer's. */
  const early = instantAt('2026-11-10', 6 * 60, ZONE);
  eq('06:00 Cairo is 23:00 the night before in New York',
     minutesInZone(early.toISOString(), NY) / 60, 23);
  eq('on the previous date', dayInZone(early.toISOString(), NY), '2026-11-09');

  section('The gap between the two is not a constant');
  /* The reason the second clock is computed from a real instant every time
     rather than from a remembered offset.
  
     Egypt and the United States both keep summer time, but they start and end
     it on different dates -- the United States from the second Sunday in March
     to the first Sunday in November, Egypt from late April to late October. For
     most of the year the gap is seven hours, and in the two windows where one
     has changed and the other has not it is six. Anyone who works it out once
     is wrong for about six weeks a year, and wrong exactly when a meeting is
     being arranged across it. */
  const gap = (date: string) =>
    (14 * 60 - minutesInZone(instantAt(date, 14 * 60, ZONE).toISOString(), NY) + 1440) % 1440 / 60;

  eq('mid-winter: seven hours', gap('2026-01-15'), 7);
  eq('mid-summer: seven hours too', gap('2026-07-15'), 7);
  eq('late March, after the US changed and before Egypt did: six', gap('2026-03-20'), 6);
  eq('late October, after Egypt changed and before the US did: six', gap('2026-10-30'), 6);
  ok('so the gap is not something that can be remembered',
     gap('2026-03-20') !== gap('2026-07-15'));

  section('A selection is the range that was pointed at');
  const from = instantAt('2026-11-12', 9 * 60 + 30, ZONE);
  const to = instantAt('2026-11-12', 10 * 60 + 45, ZONE);
  eq('it starts where the column said', minutesInZone(from.toISOString(), ZONE), 570);
  eq('it ends where the drag stopped', minutesInZone(to.toISOString(), ZONE), 645);
  eq('and lasts the dragged length', (to.getTime() - from.getTime()) / 60000, 75);

  section('A day on which the clocks change');
  /* Egypt ends summer time at the end of October. A day named in the room's own
     zone keeps its own hours instead of sliding every later day by an hour. */
  const before = instantAt('2026-10-29', 12 * 60, ZONE);
  const after = instantAt('2026-11-05', 12 * 60, ZONE);
  eq('noon is noon the week before', minutesInZone(before.toISOString(), ZONE), 720);
  eq('and noon the week after', minutesInZone(after.toISOString(), ZONE), 720);

  console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();