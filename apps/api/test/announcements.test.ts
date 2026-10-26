/**
 * Company news: who may write, how long it stays, and who may reply.
 *
 *   DATABASE_URL=... npx tsx test/announcements.test.ts
 *
 * Against a real database, because almost everything worth checking here is a
 * rule the database enforces or a window it evaluates against now().
 *
 * The bucket is stubbed. What matters about images in these tests is the rows
 * and the permission around them, not S3.
 */
import { query, one, closeDb } from '../src/common/db';
import { AnnouncementsService } from '../src/modules/announcements/announcements.service';

let pass = 0, fail = 0;
const failures: string[] = [];
const ok = (n: string, c: boolean, d = '') => {
  c ? (pass++, console.log('  ok    ' + n))
    : (fail++, failures.push(n), console.log('  FAIL  ' + n + ' ' + d));
};
const eq = (n: string, a: any, b: any) =>
  ok(n, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
const section = (t: string) => console.log('\n' + t);

const HR = { id: '', fullName: 'Hana HR', permissions: ['announcements.manage'] } as any;
const STAFF = { id: '', fullName: 'Sami Staff', permissions: [] } as any;

let notified: string[] = [];
const notifications = {
  notify: async (userId: string) => { notified.push(userId); return 'n'; },
} as any;
const store = {
  presignDownload: async () => 'https://example.invalid/signed',
  presignUpload: async () => 'https://example.invalid/upload',
  remove: async () => undefined,
  head: async () => ({ size: 1000, contentType: 'image/webp' }),
  read: async () => Buffer.alloc(0),
  put: async () => undefined,
} as any;

const svc = () => new AnnouncementsService(store, notifications);

async function main() {
  // Two people: one who looks after the board, one who does not.
  HR.id = (await one<any>(
    `INSERT INTO core_users (email, password_hash, full_name)
     VALUES ($1,'x','Hana HR') RETURNING id`, [`hr-${Date.now()}@example.invalid`])).id;
  STAFF.id = (await one<any>(
    `INSERT INTO core_users (email, password_hash, full_name)
     VALUES ($1,'x','Sami Staff') RETURNING id`, [`staff-${Date.now()}@example.invalid`])).id;

  const s = svc();
  const made: string[] = [];

  section('Only the people who look after the board may write');
  {
    let err = '';
    try { await s.create(STAFF, { title: 'Sneaky' }); } catch (e: any) { err = e.message; }
    ok('an ordinary employee cannot publish news', /look after company news/i.test(err), err);

    const a = await s.create(HR, { title: 'Q3 stars', body: 'Well done everyone' });
    made.push(a.id);
    ok('somebody who may, can', !!a.id);
    eq('and it starts as a draft, not live', a.status, 'DRAFT');
  }

  section('A draft is not news yet');
  {
    const live = await s.live(STAFF);
    ok('a draft is not on the home page', !live.some((x: any) => x.id === made[0]));
    let err = '';
    try { await s.get(STAFF, made[0]); } catch (e: any) { err = e.message; }
    ok('nor readable by anyone else', /no such announcement/i.test(err), err);
    const seen = await s.get(HR, made[0]);
    eq('though its author can still see it', seen.id, made[0]);
  }

  section('Publishing rings the bell once, and only once');
  {
    notified = [];
    await s.publish(HR, made[0]);
    ok('everybody with an account is notified', notified.length >= 2, String(notified.length));
    ok('including the ordinary employee', notified.includes(STAFF.id));

    const first = notified.length;
    notified = [];
    await s.publish(HR, made[0]);
    eq('publishing again notifies nobody — fixing a typo must not ring fifty bells',
       notified.length, 0);
    ok('and the first publish did notify', first > 0);

    const live = await s.live(STAFF);
    ok('now it is on the home page', live.some((x: any) => x.id === made[0]));
  }

  section('How long it stays is decided per announcement');
  {
    const short = await s.create(HR, { title: 'Lift out of order', days: 2 });
    made.push(short.id);
    const until = new Date(short.expiresAt!).getTime() - Date.now();
    ok('two days means two days', until > 1.5 * 86400_000 && until < 2.5 * 86400_000,
       `${Math.round(until / 3600_000)}h`);

    const forever = await s.create(HR, { title: 'Q3 stars, pinned', days: 0 });
    made.push(forever.id);
    eq('zero days means it stays until taken down', forever.expiresAt, null);

    const dflt = await s.create(HR, { title: 'Ordinary notice' });
    made.push(dflt.id);
    ok('and an unspecified one gets a sensible default', dflt.expiresAt !== null);
  }

  section('An expired notice leaves the home page by itself');
  {
    const a = await s.create(HR, { title: 'Yesterday news' });
    made.push(a.id);
    await s.publish(HR, a.id);
    ok('it is up while it is current', (await s.live(STAFF)).some((x: any) => x.id === a.id));

    await query(
      `UPDATE hr_announcements SET publish_at = now() - interval '10 days',
                                   expires_at = now() - interval '1 hour' WHERE id=$1`, [a.id]);
    ok('and gone once its time is up, with nothing to run',
       !(await s.live(STAFF)).some((x: any) => x.id === a.id));
    ok('but still findable in the archive',
       (await s.list(HR)).announcements.some((x: any) => x.id === a.id));
  }

  section('Something scheduled for later is not shown early');
  {
    const a = await s.create(HR, {
      title: 'Next month', publishAt: new Date(Date.now() + 7 * 86400_000).toISOString() });
    made.push(a.id);
    await s.publish(HR, a.id);
    ok('not on the home page yet', !(await s.live(STAFF)).some((x: any) => x.id === a.id));
    let err = '';
    try { await s.comment(STAFF, a.id, 'early'); } catch (e: any) { err = e.message; }
    ok('and not open for replies yet', /not open for replies/i.test(err), err);
  }

  section('Pinned news comes first');
  {
    const pin = await s.create(HR, { title: 'Read this first', pinned: true });
    made.push(pin.id);
    await s.publish(HR, pin.id);
    const live = await s.live(STAFF);
    eq('whatever the dates say', live[0]?.id, pin.id);
  }

  section('Replies');
  {
    const id = made[0];
    const c = await s.comment(STAFF, id, '  Congratulations!  ');
    eq('anybody may reply', c.body, 'Congratulations!');
    ok('and may remove their own', c.canRemove);

    const list = await s.comments(HR, id);
    eq('the reply is on the thread', list.length, 1);
    ok('and whoever looks after the board may remove it too', list[0].canRemove);

    let err = '';
    try { await s.comment(STAFF, id, '   '); } catch (e: any) { err = e.message; }
    ok('an empty reply is refused', /write something/i.test(err), err);

    await s.removeComment(STAFF, c.id);
    eq('a removed reply leaves the thread', (await s.comments(HR, id)).length, 0);
    const row = await one<any>(
      `SELECT deleted_at, deleted_by_id FROM hr_announcement_comments WHERE id=$1`, [c.id]);
    ok('but the row stays, with who removed it', !!row.deleted_at && row.deleted_by_id === STAFF.id);
  }

  section('Replies can be turned off');
  {
    const quiet = await s.create(HR, { title: 'With sadness', commentsEnabled: false });
    made.push(quiet.id);
    await s.publish(HR, quiet.id);
    let err = '';
    try { await s.comment(STAFF, quiet.id, 'sorry'); } catch (e: any) { err = e.message; }
    ok('a notice that should not be replied to cannot be', /turned off/i.test(err), err);
  }

  section("One person's reply is not another's to remove");
  {
    const id = made[0];
    const mine = await s.comment(STAFF, id, 'mine');
    const other = await one<any>(
      `INSERT INTO core_users (email, password_hash, full_name)
       VALUES ($1,'x','Other') RETURNING id`, [`other-${Date.now()}@example.invalid`]);
    let err = '';
    try {
      await s.removeComment({ id: other.id, fullName: 'Other', permissions: [] } as any, mine.id);
    } catch (e: any) { err = e.message; }
    ok('a colleague cannot delete it', /only remove your own/i.test(err), err);
    await query(`DELETE FROM core_users WHERE id=$1`, [other.id]);
  }

  section('Both languages, either alone');
  {
    const ar = await s.create(HR, { titleAr: 'نجوم الربع', bodyAr: 'تهانينا للجميع' });
    made.push(ar.id);
    eq('an Arabic-only notice is accepted', ar.titleAr, 'نجوم الربع');
    eq('with no English forced on it', ar.title, null);

    let err = '';
    try { await s.create(HR, { body: 'no title anywhere' }); } catch (e: any) { err = e.message; }
    ok('but a notice with no title at all is refused', /needs a title/i.test(err), err);
  }

  section('Images need the permission too');
  {
    let err = '';
    try {
      await s.requestImageUpload(STAFF, made[0], { name: 'x.jpg', type: 'image/jpeg', size: 100 });
    } catch (e: any) { err = e.message; }
    ok('an employee cannot attach pictures to the board', /look after company news/i.test(err), err);

    err = '';
    try {
      await s.requestImageUpload(HR, made[0], { name: 'x.exe', type: 'application/x-msdownload', size: 100 });
    } catch (e: any) { err = e.message; }
    ok('and not everything is a picture', /JPEG, PNG or WebP/i.test(err), err);

    const up = await s.requestImageUpload(HR, made[0], { name: 'team.jpg', type: 'image/jpeg', size: 5000 });
    ok('a real one gets an upload URL', !!up.uploadUrl && !!up.imageId);
    const row = await one<any>(
      `SELECT status FROM hr_announcement_images WHERE id=$1`, [up.imageId]);
    eq('and starts as pending, not shown', row.status, 'PENDING');
    ok('so an abandoned upload never reaches the page',
       (await s.get(HR, made[0])).images.length === 0);
  }

  // tidy up
  for (const id of made) await query(`DELETE FROM hr_announcements WHERE id=$1`, [id]);
  await query(`DELETE FROM core_notifications WHERE user_id IN ($1,$2)`, [HR.id, STAFF.id]);
  await query(`DELETE FROM core_users WHERE id IN ($1,$2)`, [HR.id, STAFF.id]);

  console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nfailures:'); failures.forEach((f) => console.log('  ' + f)); }
  await closeDb();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });