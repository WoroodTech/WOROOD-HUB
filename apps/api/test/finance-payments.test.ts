/**
 * The payments ledger.
 *
 *   DATABASE_URL=... npx tsx test/finance-payments.test.ts
 *
 * The invariants that must always hold:
 *   1. the total paid is a sum of rows, never a stored figure
 *   2. no two payments share an idempotency key
 *   3. nothing is paid beyond what was asked for
 *   4. the status follows the ledger, in both directions
 *   5. nothing is deleted — a mistake is reversed
 */
import { query, one, closeDb } from '../src/common/db';
import { FinanceRequestsService } from '../src/modules/finance/requests.service';
import { FinancePaymentsService } from '../src/modules/finance/payments.service';
import { FinanceEditsService } from '../src/modules/finance/edits.service';

let pass = 0, fail = 0;
const failures: string[] = [];
const ok = (n: string, c: boolean, d = '') => {
  c ? (pass++, console.log('  ok    ' + n))
    : (fail++, failures.push(n), console.log('  FAIL  ' + n + ' ' + d));
};
const eq = (n: string, a: any, b: any) =>
  ok(n, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
const section = (t: string) => console.log('\n' + t);
const err = async (fn: () => Promise<any>): Promise<string> => {
  try { await fn(); return ''; } catch (e: any) { return e?.message ?? String(e); }
};

const notifications = { notify: async () => 'n', notifyPermissionHolders: async () => undefined } as any;
const audit = { write: async () => undefined } as any;
let keyN = 0;
const key = () => `test-key-${Date.now()}-${keyN++}`;

async function main() {
  const reqs = new FinanceRequestsService(notifications, audit);
  /* Payments now queue a Zoho event after committing. The queue is tested on
     its own in finance-zoho; here it is a stub, so a payment is exercised
     without pulling Zoho into it. */
  const zoho = { enqueuePayment: async () => undefined } as any;
  /* No account cache in these tests, so the check is skipped — which is also
     what happens on a server with no Zoho connection. */
  const zohoAccounts = { ready: async () => false, check: async () => true } as any;
  const pays = new FinancePaymentsService(notifications, audit, zoho, zohoAccounts);
  const edits = new FinanceEditsService(notifications, audit);
  const stamp = Date.now();

  const mkUser = async (name: string, deptId: string) => (await one<any>(
    `INSERT INTO core_users (email, password_hash, full_name, department_id)
     VALUES ($1,'x',$2,$3) RETURNING id`,
    [`${name}-${stamp}@example.invalid`, name, deptId])).id;
  const dept = async (code: string) => (await one<any>(
    `SELECT department_id FROM fin_departments WHERE code=$1`, [code])).department_id;

  const MKT = await dept('MKT'), PUR = await dept('PUR'), OFC = await dept('OFC');
  await query(`DELETE FROM core_department_managers WHERE department_id = ANY($1::uuid[])`,
              [[MKT, OFC]]);

  const sami = { id: await mkUser('YSami', MKT), fullName: 'Sami', departmentId: MKT,
                 permissions: [], managedDepartmentIds: [] } as any;
  const fin = { id: await mkUser('YFin', PUR), fullName: 'Fin', departmentId: PUR,
                permissions: ['finance.request.manage', 'finance.payment.record'],
                managedDepartmentIds: [] } as any;
  const made: string[] = [];
  const extraUsers: string[] = [];

  const approved = async (amount = 1000) => {
    const r = await reqs.create(sami, {
      type: 'Models', description: 'Shoot', moreDetails: 'details',
      dueDate: '2026-12-01', requestedAmount: amount,
      paymentMethod: 'Wallet Number', accountNumber: '01001234567' } as any);
    made.push(r.id);
    await reqs.decide(fin, r.id, 'APPROVED');
    return r;
  };
  const state = async (id: string) => (await one<any>(
    `SELECT payment_state FROM fin_requests WHERE id=$1`, [id])).payment_state;

  section('Who may record a payment');
  {
    const r = await approved();
    const m = await err(() => pays.record(sami, r.id, { amount: 100, idempotencyKey: key() }));
    ok('not an ordinary employee', /Only Finance/i.test(m), m);
  }

  section('Nothing is paid against a request that was not approved');
  {
    const r = await reqs.create(sami, {
      type: 'Models', description: 'Pending', moreDetails: 'x', dueDate: '2026-12-01',
      requestedAmount: 500, paymentMethod: 'Wallet Number',
      accountNumber: '01001234567' } as any);
    made.push(r.id);
    const m = await err(() => pays.record(fin, r.id, { amount: 100, idempotencyKey: key() }));
    ok('not one still going through approval', /not been approved/i.test(m), m);
  }

  section('Paying in parts');
  {
    const r = await approved(1000);
    eq('it starts unpaid', await state(r.id), 'UNPAID');

    await pays.record(fin, r.id, { amount: 400, idempotencyKey: key() });
    eq('a part payment makes it PARTIAL', await state(r.id), 'PARTIAL');
    const half = await pays.forRequest(fin, r.id);
    eq('the total is the sum of the rows', half.paid, 400);
    eq('and what is left is derived from it', half.remaining, 600);

    await pays.record(fin, r.id, { amount: 600, idempotencyKey: key() });
    eq('paying the rest makes it PAID', await state(r.id), 'PAID');
    const full = await pays.forRequest(fin, r.id);
    eq('with both payments on the record', full.payments.length, 2);
    eq('nothing left', full.remaining, 0);
    /* Both dated, separately. The sheet keeps only the last date, which is why
       its cash flow is wrong for every day between two part payments. */
    ok('and each payment carries its own date',
       full.payments[0].paidAt !== full.payments[1].paidAt
       || full.payments.every((x: any) => !!x.paidAt));
  }

  section('Nothing is paid beyond what was asked for');
  {
    const r = await approved(1000);
    await pays.record(fin, r.id, { amount: 900, idempotencyKey: key() });
    const m = await err(() => pays.record(fin, r.id, { amount: 200, idempotencyKey: key() }));
    ok('an overpayment is refused', /Only 100.00 is left/i.test(m), m);
    eq('and nothing was recorded', (await pays.forRequest(fin, r.id)).paid, 900);
  }

  section('The same payment twice is one payment');
  {
    const r = await approved(1000);
    const k = key();
    const first = await pays.record(fin, r.id, { amount: 300, idempotencyKey: k });
    /* A double click, a retry after a timeout, a refreshed form: the same key
       arrives again and must not become a second payment. */
    const again = await pays.record(fin, r.id, { amount: 300, idempotencyKey: k });
    eq('the second attempt returns the first payment', again.id, first.id);
    eq('and the total has not moved', (await pays.forRequest(fin, r.id)).paid, 300);
    eq('with one row on the ledger', (await pays.forRequest(fin, r.id)).payments.length, 1);
  }

  section('Reversing a mistake');
  {
    const r = await approved(1000);
    const pm = await pays.record(fin, r.id, { amount: 1000, idempotencyKey: key() });
    eq('it is paid', await state(r.id), 'PAID');

    const m = await err(() => pays.reverse(fin, pm.id, '  '));
    ok('a reversal must say why', /Say why/i.test(m), m);

    await pays.reverse(fin, pm.id, 'Paid the wrong supplier');
    eq('the request is unpaid again', await state(r.id), 'UNPAID');

    const after = await pays.forRequest(fin, r.id);
    eq('the total is back to nothing', after.paid, 0);
    /* Nothing is deleted: a payment entered and reversed is a different thing
       from one that never happened, and the record says which. */
    eq('but both rows are still there', after.payments.length, 2);
    ok('one of them marked as the reversal', after.payments.some((x: any) => x.isReversal));

    /* The reason belongs on the request where people read it, not only in an
       audit log where they would have to go looking. */
    const notes = await query<any>(
      `SELECT body FROM fin_request_notes WHERE request_id=$1`, [r.id]);
    ok('and the reason is on the request for anyone reading it',
       notes.some((n: any) => /Paid the wrong supplier/.test(n.body)),
       JSON.stringify(notes.map((n: any) => n.body)));

    const m2 = await err(() => pays.reverse(fin, pm.id, 'again'));
    ok('and it cannot be reversed twice', /already been reversed/i.test(m2), m2);
  }

  section('An approved change re-opens a paid request');
  {
    const r = await approved(1000);
    await pays.record(fin, r.id, { amount: 1000, idempotencyKey: key() });
    eq('paid in full', await state(r.id), 'PAID');

    const e = await edits.request(sami, r.id, { newAmount: 1500, reason: 'scope grew' });
    await edits.decide(fin, e.id, 'APPROVED');
    /* Raising the figure means it is no longer fully paid, and the status has
       to follow the ledger rather than stay where it was put. */
    eq('raising the amount makes it partial again', await state(r.id), 'PARTIAL');
    eq('with the rest owing', (await pays.forRequest(fin, r.id)).remaining, 500);
  }

  section('A change may never go below what has been paid');
  {
    const r = await approved(1000);
    await pays.record(fin, r.id, { amount: 800, idempotencyKey: key() });
    const m = await err(() => edits.request(sami, r.id, { newAmount: 500, reason: 'less' }));
    /* The rule the legacy app applies from one of its two edit paths and not
       the other. Here there is one path. */
    ok('it is refused outright', /800.00 has already been paid/i.test(m), m);

    const okEdit = await edits.request(sami, r.id, { newAmount: 900, reason: 'a bit less' });
    eq('but down to the paid figure is fine', okEdit.newAmount, 900);
  }

  section('A lite department sees no payment history either');
  {
    const omar = { id: await mkUser('YOmar', OFC), fullName: 'Omar', departmentId: OFC,
                   permissions: [], managedDepartmentIds: [] } as any;
    const r = await reqs.create(omar, {
      description: 'Lamps', dueDate: '2026-12-01' } as any);
    made.push(r.id);
    const purch = { ...fin, permissions: ['finance.purchases.decide'] } as any;
    await reqs.decide(purch, r.id, 'APPROVED', undefined, {
      type: 'Petty Cash', requestedAmount: 600,
      paymentMethod: 'Wallet Number', accountNumber: '01001234567' } as any);
    await reqs.decide(fin, r.id, 'APPROVED');
    await pays.record(fin, r.id, { amount: 600, idempotencyKey: key() });

    const asOmar = await pays.forRequest(omar, r.id);
    eq('no payments are listed', asOmar.payments, []);
    eq('no total', asOmar.paid, null);
    ok('and it says so rather than showing a zero', asOmar.hidden);

    const asFinance = await pays.forRequest(fin, r.id);
    eq('while Finance sees the lot', asFinance.paid, 600);
    extraUsers.push(omar.id);   // his request outlives this block; tidy in order
  }

  section('What is still owing');
  {
    const list = await pays.outstanding(fin);
    ok('every row is approved and not fully paid',
       list.every((x: any) => x.remaining === null || x.remaining > 0));
    const m = await err(() => pays.outstanding(sami));
    ok('and an employee cannot see the list', /cannot see the payment list/i.test(m), m);
  }

  section('The database itself refuses a nonsense row');
  {
    const r = await approved();
    const bad = await err(async () => query(
      `INSERT INTO fin_payments (request_id, amount, recorded_by_id, idempotency_key)
       VALUES ($1, 0, $2, $3)`, [r.id, fin.id, key()]));
    ok('a payment of zero', /amount_not_zero/i.test(bad), bad.slice(0, 70));

    const bad2 = await err(async () => query(
      `INSERT INTO fin_payments (request_id, amount, recorded_by_id, idempotency_key)
       VALUES ($1, -50, $2, $3)`, [r.id, fin.id, key()]));
    ok('and a negative one that reverses nothing',
       /negative_is_reversal/i.test(bad2), bad2.slice(0, 70));
  }

  for (const id of made) {
    await query(`DELETE FROM fin_payments WHERE request_id=$1`, [id]);
    await query(`DELETE FROM fin_requests WHERE id=$1`, [id]);
  }
  const everyone = [sami.id, fin.id, ...extraUsers];
  await query(`DELETE FROM core_notifications WHERE user_id = ANY($1::uuid[])`, [everyone]);
  await query(`DELETE FROM core_users WHERE id = ANY($1::uuid[])`, [everyone]);

  console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nfailures:'); failures.forEach((f) => console.log('  ' + f)); }
  await closeDb();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });