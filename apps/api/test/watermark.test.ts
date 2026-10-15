/**
 * What `markSync` actually writes to `sd_sync_state`.
 *
 *   npx tsx test/watermark.test.ts        (needs a database; no server)
 *
 * Separate from reconcile.test.ts, which proves how far a run got. This proves
 * the other half: that the point a run reports is the point the database ends
 * up holding. The two are easy to get right independently and still disagree,
 * because the rule lives in a CASE expression inside an upsert -- the kind of
 * thing that reads correctly and does something else.
 *
 * Writes only under a synthetic shop id that belongs to no real shop, and
 * removes its own rows afterwards. It touches no order, event or customer data.
 */
import { query, one, closeDb } from '../src/common/db';

/* sd_sync_state references sd_shops, so this needs a real shop row rather than
   an invented uuid. A fixture shop of its own, fixed by domain, so a crashed
   run leaves rows the next run cleans up instead of orphans. */
const SHOP_DOMAIN = 'watermark-test.myshopify.com';
let SHOP: string;

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`); }
}
const section = (t: string) => console.log(`\n${t}`);

/* The statement from SyncService.markSync, with its parameter mapping. Kept
   here verbatim: if the service's copy changes and this one does not, these
   assertions stop describing the system and that should be noticed. */
const SQL = `INSERT INTO sd_sync_state (shop_id, resource, watermark, last_run_at, last_ok_at, status, records, error,
                                  resume_cursor, resume_since)
   VALUES ($1,$2, CASE WHEN $4::text IS NOT NULL THEN NULL
                       WHEN $5::boolean THEN $6::timestamptz ELSE now() END,
           now(), CASE WHEN $4::text IS NULL THEN now() END,
           CASE WHEN $4::text IS NULL THEN 'OK' ELSE 'ERROR' END, $3, $4,
           $7::text, $8::timestamptz)
   ON CONFLICT (shop_id, resource) DO UPDATE
     SET watermark = CASE
           WHEN $4::text IS NOT NULL THEN sd_sync_state.watermark
           WHEN $5::boolean THEN COALESCE($6::timestamptz, sd_sync_state.watermark)
           ELSE now() END,
         last_run_at = now(),
         last_ok_at = CASE WHEN $4::text IS NULL THEN now() ELSE sd_sync_state.last_ok_at END,
         status = CASE WHEN $4::text IS NULL THEN 'OK' ELSE 'ERROR' END,
         records = EXCLUDED.records, error = $4,
         resume_cursor = CASE WHEN $9::boolean THEN $7::text ELSE sd_sync_state.resume_cursor END,
         resume_since  = CASE WHEN $9::boolean THEN $8::timestamptz ELSE sd_sync_state.resume_since END`;

const markSync = (
  resource: string, records: number, error?: string, watermark?: Date | null,
  resume?: { cursor: string | null; since: Date | null },
) => query(SQL, [SHOP, resource, records, error ?? null,
                 watermark !== undefined, watermark === undefined ? null : watermark,
                 resume?.cursor ?? null, resume?.since ?? null, resume !== undefined]);

const read = (resource: string) => one<any>(
  `SELECT watermark, status, error, resume_cursor, resume_since
     FROM sd_sync_state WHERE shop_id = $1 AND resource = $2`, [SHOP, resource]);

const iso = (d: any) => (d ? new Date(d).toISOString() : null);

async function main() {
  const existing = await one<any>(
    `SELECT id FROM sd_shops WHERE myshopify_domain = $1`, [SHOP_DOMAIN]);
  SHOP = existing?.id ?? (await one<any>(
    `INSERT INTO sd_shops (myshopify_domain, name, currency_code, iana_timezone)
     VALUES ($1,'Watermark fixture','EGP','Africa/Cairo') RETURNING id`, [SHOP_DOMAIN])).id;
  await query(`DELETE FROM sd_sync_state WHERE shop_id = $1`, [SHOP]);

  const T1 = new Date('2026-03-01T10:00:00Z');
  const T2 = new Date('2026-03-01T11:00:00Z');

  section('An explicit point is stored, on insert and on update');
  {
    await markSync('orders', 5, undefined, T1);
    check('the first run stores the point it reported', iso((await read('orders')).watermark) === T1.toISOString());

    await markSync('orders', 7, undefined, T2);
    check('a later run moves it forward', iso((await read('orders')).watermark) === T2.toISOString());
  }

  section('The resume point an unfinished run leaves behind');
  {
    /* The run stopped at the ceiling: the watermark must not move, and the
       cursor must be stored so the next run carries on from it rather than
       re-reading the same pages for ever. */
    await markSync('orders', 2000, undefined, null, { cursor: 'eyJsYXN0X2lkIjo5OX0=', since: T1 });
    const r = await read('orders');
    check('the watermark is untouched', iso(r.watermark) === T2.toISOString(), iso(r.watermark) ?? '');
    check('the cursor is kept', r.resume_cursor === 'eyJsYXN0X2lkIjo5OX0=', String(r.resume_cursor));
    check('together with the query it belongs to',
      iso(r.resume_since) === T1.toISOString(), iso(r.resume_since) ?? '');

    /* And the run after that finishes, which clears it -- a stale cursor left
       behind would send the following run back into an old window. */
    const T3 = new Date('2026-03-01T12:00:00Z');
    await markSync('orders', 500, undefined, T3, { cursor: null, since: null });
    const done = await read('orders');
    check('finishing moves the watermark on', iso(done.watermark) === T3.toISOString());
    check('and clears the cursor', done.resume_cursor === null, String(done.resume_cursor));
    check('and the query with it', done.resume_since === null);

    // put it back for the assertions that follow
    await markSync('orders', 0, undefined, T2, { cursor: null, since: null });
  }

  section('An incomplete run that wrote nothing leaves it alone');
  {
    /* The reconcile path passes null for exactly this case. Writing now() here
       is the original defect in its purest form: no order was fetched, and the
       mark would still claim everything up to this moment had been seen. */
    await markSync('orders', 0, undefined, null, { cursor: null, since: null });
    const r = await read('orders');
    check('the watermark is untouched', iso(r.watermark) === T2.toISOString(), iso(r.watermark) ?? '');
    check('and the run is still recorded as OK, because it did not fail', r.status === 'OK');
  }

  section('A failed run never moves it, whatever it passes');
  {
    await markSync('orders', 0, 'boom', new Date('2027-01-01T00:00:00Z'),
      { cursor: 'after-the-failure', since: T1 });
    const r = await read('orders');
    check('a failed run still records where it got to, so the retry resumes',
      r.resume_cursor === 'after-the-failure', String(r.resume_cursor));
    check('a point passed alongside an error is ignored',
      iso(r.watermark) === T2.toISOString(), iso(r.watermark) ?? '');
    check('the status flips to ERROR', r.status === 'ERROR', r.status);
    check('and the message is kept for the health screen', r.error === 'boom');
  }

  section('A first-page failure drops the stored cursor');
  {
    /* The run failed before writing anything, so there is no new checkpoint
       and the old one is deliberately not kept -- see nextResume. What must
       hold at the database is that the cursor really is cleared and the
       watermark really is not touched, because the next run then covers the
       whole window again rather than resuming past it. */
    await markSync('orders', 0, undefined, T2, { cursor: 'some-earlier-cursor', since: T1 });
    check('a cursor is in place to begin with',
      (await read('orders')).resume_cursor === 'some-earlier-cursor');

    await markSync('orders', 0, 'invalid cursor', null, { cursor: null, since: null });
    const r = await read('orders');
    check('the failure clears it', r.resume_cursor === null, String(r.resume_cursor));
    check('and the query that went with it', r.resume_since === null);
    check('while the watermark stays exactly where it was',
      iso(r.watermark) === T2.toISOString(), iso(r.watermark) ?? '');
    check('and the failure is recorded', r.status === 'ERROR' && r.error === 'invalid cursor');
  }

  section('Resources that finish or fail whole are unchanged');
  {
    /* Everything other than reconciliation calls markSync without a point and
       must keep its old meaning: now(). */
    const before = Date.now();
    await markSync('webhooks', 3);
    const first = await read('webhooks');
    check('an omitted point still means now() on insert',
      new Date(first.watermark).getTime() >= before - 2000, iso(first.watermark) ?? '');

    await new Promise((r) => setTimeout(r, 50));
    const mid = Date.now();
    await markSync('webhooks', 4);
    const upd = await read('webhooks');
    check('and on update', new Date(upd.watermark).getTime() >= mid - 2000);
    check('and such a resource never acquires a resume cursor', upd.resume_cursor === null);
  }

  section('A first run that failed records no progress at all');
  {
    await markSync('fresh', 0, 'failed before anything was read');
    const r = await read('fresh');
    check('the watermark is null, not now()', r.watermark === null, String(r.watermark));
    check('and the row says ERROR', r.status === 'ERROR');
  }

  await query(`DELETE FROM sd_sync_state WHERE shop_id = $1`, [SHOP]);
  await query(`DELETE FROM sd_shops WHERE myshopify_domain = $1`, [SHOP_DOMAIN]);
  const left = await one<any>(
    `SELECT COUNT(*) AS n FROM sd_sync_state WHERE shop_id = $1`, [SHOP]);
  check('the test leaves nothing behind', Number(left.n) === 0);

  console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nfailures:'); failures.forEach((f) => console.log('  ' + f)); }
  await closeDb();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });