/**
 * Getting payments into Zoho, eventually and exactly once.
 *
 *   DATABASE_URL=... npx tsx test/finance-zoho.test.ts
 *
 * Zoho itself is a stub. What is being tested is everything around it: that a
 * payment is never lost because Zoho was down, never posted twice because a
 * call timed out, and never silently abandoned.
 */
import { query, one, closeDb } from '../src/common/db';
import { ZohoQueueService } from '../src/modules/finance/zoho/zoho-queue.service';
import { ZohoError } from '../src/modules/finance/zoho/books-client';

let pass = 0, fail = 0;
const failures: string[] = [];
const ok = (n: string, c: boolean, d = '') => {
  c ? (pass++, console.log('  ok    ' + n))
    : (fail++, failures.push(n), console.log('  FAIL  ' + n + ' ' + d));
};
const eq = (n: string, a: any, b: any) =>
  ok(n, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
const section = (t: string) => console.log('\n' + t);

/** A Zoho that does whatever the test needs it to. */
function stubBooks(behaviour: {
  onPost?: (path: string, body: any) => any;
  onFind?: (kind: string, ref: string) => string | null;
} = {}) {
  const calls: { method: string; path: string; body?: any }[] = [];
  return {
    calls,
    mode: 'live' as const,
    configured: true,
    async call(method: string, path: string, opts: any = {}) {
      calls.push({ method, path, body: opts.body });
      if (behaviour.onPost) return behaviour.onPost(path, opts.body);
      return { expense_id: 'zoho-1', vendor_payment_id: 'zoho-1', transaction_id: 'zoho-1' };
    },
    async findByReference(kind: string, ref: string) {
      return behaviour.onFind ? behaviour.onFind(kind, ref) : null;
    },
  } as any;
}

async function main() {
  const stamp = Date.now();
  const dept = async (code: string) => (await one<any>(
    `SELECT department_id FROM fin_departments WHERE code=$1`, [code])).department_id;
  const MKT = await dept('MKT');

  const user = (await one<any>(
    `INSERT INTO core_users (email, password_hash, full_name, department_id)
     VALUES ($1,'x','Z Fin',$2) RETURNING id`,
    [`zfin-${stamp}@example.invalid`, MKT])).id;

  const made: string[] = [];
  let payN = 0;

  /** An approved, priced request with one payment against it. */
  const paidRequest = async (type = 'Other', vendor: string | null = null) => {
    const r = await one<any>(
      `INSERT INTO fin_requests
         (reference, department_id, requester_id, type, description, due_date,
          requested_amount, route, approval_state, payment_method, vendor_name,
          finance_decided_by_id, finance_decided_at)
       VALUES ($1,$2,$3,$4,'Studio hire','2026-12-01',1000,'finance','APPROVED',
               'Wallet Number',$5,$3,now()) RETURNING *`,
      [`ZT-${stamp}-${payN}`, MKT, user, type, vendor]);
    made.push(r.id);
    /* The accounts come from the payment now, not from configuration: the
       expense account is chosen per request from the whole chart. */
    const pm = await one<any>(
      `INSERT INTO fin_payments
         (request_id, amount, recorded_by_id, idempotency_key,
          zoho_paid_through_account_id, zoho_expense_account_id, zoho_to_account_id)
       VALUES ($1, 400, $2, $3, 'acct-bank', 'acct-expense', 'acct-petty')
       RETURNING *`,
      [r.id, user, `zt-${stamp}-${payN++}`]);
    return { request: r, payment: pm };
  };

  const statusOf = async (paymentId: string) => (await one<any>(
    `SELECT status, attempts, zoho_record_id, error FROM fin_zoho_events
      WHERE payment_id=$1`, [paymentId]));

  /* The queue is one queue: drainOne takes the oldest event that is due, not
     the one this section happens to have made. Clearing between sections is
     what lets a section assert how many calls were made. */
  const clearQueue = async () =>
    query(`DELETE FROM fin_zoho_events`);

  section('A payment is queued, not posted inline');
  {
    const books = stubBooks();
    const q = new ZohoQueueService(books);
    const { payment } = await paidRequest();
    await q.enqueuePayment(payment.id);

    const row = await statusOf(payment.id);
    eq('it waits in the queue', row.status, 'PENDING');
    eq('and nothing was sent while recording it', books.calls.length, 0);
  }

  await clearQueue();
  section('The worker drains it');
  {
    const books = stubBooks();
    const q = new ZohoQueueService(books);
    const { payment } = await paidRequest();
    await q.enqueuePayment(payment.id);

    ok('there was something to do', await q.drainOne('w1'));
    const row = await statusOf(payment.id);
    eq('it is posted', row.status, 'POSTED');
    eq('with the id Zoho gave it, kept for reconciliation', row.zoho_record_id, 'zoho-1');
    eq('one call was made', books.calls.length, 1);
    eq('to the expenses endpoint', books.calls[0].path, '/expenses');

    eq('and there is nothing left to do', await q.drainOne('w1'), false);
  }

  await clearQueue();
  section('Each kind of spending goes to its own endpoint');
  {
    for (const [type, path] of [
      ['Petty Cash', '/banktransactions'],
      ['Vendors Payments', '/vendorpayments'],
      ['Other', '/expenses'],
    ] as const) {
      const books = stubBooks();
      const q = new ZohoQueueService(books);
      const { payment } = await paidRequest(type, 'Nile Supplies');
      await q.enqueuePayment(payment.id);
      await q.drainOne('w1');
      eq(`${type} → ${path}`, books.calls[0]?.path, path);
    }
  }

  await clearQueue();
  section('Zoho being down loses nothing');
  {
    const books = stubBooks({
      onPost: () => { throw new ZohoError(503, 'Service Unavailable', undefined, true); },
    });
    const q = new ZohoQueueService(books);
    const { payment } = await paidRequest();
    await q.enqueuePayment(payment.id);
    await q.drainOne('w1');

    const row = await statusOf(payment.id);
    eq('it is marked failed, not lost', row.status, 'FAILED');
    eq('with one attempt behind it', Number(row.attempts), 1);
    ok('and the reason recorded', /Service Unavailable/.test(row.error));

    /* Backed off: not due yet, so the next pass leaves it alone. */
    eq('and it is not retried immediately', await q.drainOne('w1'), false);
  }

  await clearQueue();
  section('A body Zoho will never accept is dead at once');
  {
    const books = stubBooks({
      onPost: () => { throw new ZohoError(400, 'Invalid account_id', 1002, false); },
    });
    const q = new ZohoQueueService(books);
    const { payment } = await paidRequest();
    await q.enqueuePayment(payment.id);
    await q.drainOne('w1');

    const row = await statusOf(payment.id);
    /* Retrying a 400 six times wastes a day and ends in the same place. The
       sooner it is on somebody's screen the better. */
    eq('dead on the first attempt', row.status, 'DEAD');
    eq('rather than retried five more times', Number(row.attempts), 1);
  }

  await clearQueue();
  section('The dangerous case: Zoho succeeded and we never heard');
  {
    /* The first attempt times out after Zoho has created the record. A plain
       retry would create a second one. */
    let created = 0;
    const books = stubBooks({
      onPost: () => { created++; return { expense_id: 'zoho-dup' }; },
      onFind: () => 'zoho-already-there',
    });
    const q = new ZohoQueueService(books);
    const { payment } = await paidRequest();
    await q.enqueuePayment(payment.id);
    await q.drainOne('w1');

    const row = await statusOf(payment.id);
    eq('the existing record is adopted', row.zoho_record_id, 'zoho-already-there');
    eq('and nothing was created', created, 0);
    eq('the event is posted', row.status, 'POSTED');
  }

  await clearQueue();
  section('A failed lookup never licences a duplicate');
  {
    let created = 0;
    const books = stubBooks({
      onPost: () => { created++; return { expense_id: 'x' }; },
      onFind: () => { throw new ZohoError(0, 'lookup timed out', undefined, true); },
    });
    const q = new ZohoQueueService(books);
    const { payment } = await paidRequest();
    await q.enqueuePayment(payment.id);
    await q.drainOne('w1');

    /* "I could not find out" must not be read as "it is not there". */
    eq('nothing was created', created, 0);
    eq('and the event waits to try again', (await statusOf(payment.id)).status, 'FAILED');
  }

  await clearQueue();
  section('Two workers never take the same event');
  {
    const books = stubBooks();
    const q = new ZohoQueueService(books);
    const { payment } = await paidRequest();
    await q.enqueuePayment(payment.id);

    const [a, b] = await Promise.all([q.drainOne('w1'), q.drainOne('w2')]);
    ok('one of them did the work', a !== b || a === true);
    eq('and exactly one call was made', books.calls.length, 1);
  }

  await clearQueue();
  section('A crash leaves nothing stuck for long');
  {
    const books = stubBooks();
    const q = new ZohoQueueService(books);
    const { payment } = await paidRequest();
    await q.enqueuePayment(payment.id);

    await query(
      `UPDATE fin_zoho_events SET status='PROCESSING', lease_owner='w9',
              lease_expires_at = now() + interval '2 minutes' WHERE payment_id=$1`,
      [payment.id]);
    eq('while the lease holds, nobody else takes it', await q.drainOne('w1'), false);

    const n = await q.reclaimOwn('w9');
    ok('the worker releases its own on restart', n >= 1);
    eq('and it can be drained again', await q.drainOne('w1'), true);
  }

  section('A reversal is not posted');
  {
    const books = stubBooks();
    const q = new ZohoQueueService(books);
    const { payment } = await paidRequest();
    const rev = await one<any>(
      `INSERT INTO fin_payments
         (request_id, amount, recorded_by_id, idempotency_key, reversal_of_id)
       VALUES ($1, -400, $2, $3, $4) RETURNING *`,
      [payment.request_id, user, `zt-rev-${stamp}`, payment.id]);

    await q.enqueuePayment(rev.id);
    /* Undoing an entry in somebody's accounts is a bookkeeping decision, not
       one to guess at from here. */
    eq('no event is queued for it', await statusOf(rev.id), null);
  }

  await clearQueue();
  section('A payment with no account chosen cannot be posted, and says so');
  {
    const books = stubBooks();
    const q = new ZohoQueueService(books);
    const r = await one<any>(
      `INSERT INTO fin_requests
         (reference, department_id, requester_id, type, description, due_date,
          requested_amount, route, approval_state, payment_method,
          finance_decided_by_id, finance_decided_at)
       VALUES ($1,$2,$3,'Other','No account','2026-12-01',900,'finance','APPROVED',
               'Wallet Number',$3,now()) RETURNING *`,
      [`ZT-NOACC-${stamp}`, MKT, user]);
    made.push(r.id);
    const pm = await one<any>(
      `INSERT INTO fin_payments (request_id, amount, recorded_by_id, idempotency_key)
       VALUES ($1, 100, $2, $3) RETURNING *`, [r.id, user, `zt-noacc-${stamp}`]);

    await q.enqueuePayment(pm.id);
    const row = await statusOf(pm.id);
    /* Dead at once rather than retried six times across a day: nothing about
       waiting will supply an account nobody chose. */
    eq('it is dead immediately', row.status, 'DEAD');
    ok('saying what is missing', /no account was chosen to pay from/i.test(row.error), row.error);
    eq('and nothing was sent', books.calls.length, 0);
  }

  await clearQueue();
  section('Zoho reporting failure with an HTTP 200 is still a failure');
  {
    /* Zoho answers a great many errors -- "you are not authorised for this
       organisation" among them -- with status 200 and a non-zero `code` in
       the body. Checking only the status let those through as success with an
       empty list, which is how a connection to the wrong organisation looked
       identical to an organisation with no accounts in it. */
    const books = stubBooks({
      onPost: () => { throw new ZohoError(200, 'You are not authorized', 6042, false); },
    });
    const q = new ZohoQueueService(books);
    const { payment } = await paidRequest();
    await q.enqueuePayment(payment.id);
    await q.drainOne('w1');

    const row = await statusOf(payment.id);
    eq('it is dead, not posted', row.status, 'DEAD');
    ok('with what Zoho actually said', /not authorized/i.test(row.error), row.error);
  }

  await clearQueue();
  section('Queueing the same payment twice is one event');
  {
    const books = stubBooks();
    const q = new ZohoQueueService(books);
    const { payment } = await paidRequest();
    await q.enqueuePayment(payment.id);
    await q.enqueuePayment(payment.id);
    const rows = await query<any>(
      `SELECT id FROM fin_zoho_events WHERE payment_id=$1`, [payment.id]);
    eq('one row', rows.length, 1);
  }

  section('What an operator sees');
  {
    const books = stubBooks();
    const q = new ZohoQueueService(books);
    const h = await q.health();
    ok('a count by state', typeof h.counts === 'object');
    ok('and the dead ones listed with their reason',
       Array.isArray(h.dead) && h.dead.every((d: any) => 'error' in d));
    ok('with no payload among them — bodies carry account ids',
       h.dead.every((d: any) => !('payload' in d)));
  }

  await query(`DELETE FROM fin_zoho_events WHERE request_id = ANY($1::uuid[])`, [made]);
  for (const id of made) {
    await query(`DELETE FROM fin_payments WHERE request_id=$1`, [id]);
    await query(`DELETE FROM fin_requests WHERE id=$1`, [id]);
  }
  await query(`DELETE FROM core_users WHERE id=$1`, [user]);

  console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nfailures:'); failures.forEach((f) => console.log('  ' + f)); }
  await closeDb();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });