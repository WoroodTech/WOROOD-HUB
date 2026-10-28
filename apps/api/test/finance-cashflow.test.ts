/**
 * The daily cash-flow forecast.
 *
 *   DATABASE_URL=... npx tsx test/finance-cashflow.test.ts
 *
 * Two things are being checked. That the legacy method reproduces the
 * spreadsheet formula exactly — otherwise the migration cannot be verified
 * against figures Finance already has — and that the accurate method differs
 * from it in exactly the case it should: a request paid in instalments.
 */
import { query, one, closeDb } from '../src/common/db';
import { CashFlowService } from '../src/modules/finance/cashflow.service';

let pass = 0, fail = 0;
const failures: string[] = [];
const ok = (n: string, c: boolean, d = '') => {
  c ? (pass++, console.log('  ok    ' + n))
    : (fail++, failures.push(n), console.log('  FAIL  ' + n + ' ' + d));
};
const eq = (n: string, a: any, b: any) =>
  ok(n, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
const section = (t: string) => console.log('\n' + t);

const FINANCE = { id: '', fullName: 'Fin', permissions: ['finance.report.view'],
                  managedDepartmentIds: [] } as any;
const MONTH = '2027-03';

async function main() {
  const cf = new CashFlowService();
  const stamp = Date.now();
  const dept = async (code: string) => (await one<any>(
    `SELECT department_id FROM fin_departments WHERE code=$1`, [code])).department_id;

  const MKT = await dept('MKT'), PUR = await dept('PUR');
  FINANCE.id = (await one<any>(
    `INSERT INTO core_users (email, password_hash, full_name, department_id)
     VALUES ($1,'x','CF Fin',$2) RETURNING id`,
    [`cf-${stamp}@example.invalid`, PUR])).id;

  /* The cash flow is a figure for the whole company, so this test cannot
     scope itself to its own rows the way the others do: anything left in the
     test month by an earlier run lands in the same sum. The month is cleared
     first, and it is a month only this test ever writes to. */
  await query(
    `DELETE FROM fin_payments WHERE request_id IN (
       SELECT id FROM fin_requests WHERE due_date BETWEEN ($1||'-01')::date
         AND (($1||'-01')::date + interval '1 month - 1 day')::date)`, [MONTH]);
  await query(
    `DELETE FROM fin_requests WHERE due_date BETWEEN ($1||'-01')::date
       AND (($1||'-01')::date + interval '1 month - 1 day')::date`, [MONTH]);

  const made: string[] = [];
  let n = 0;

  /** An approved request charged to a department, due on a given day. */
  const request = async (deptId: string, due: string, amount: number, type = 'Models') => {
    const r = await one<any>(
      `INSERT INTO fin_requests
         (reference, department_id, charged_to_department_id, requester_id, type,
          description, due_date, requested_amount, route, approval_state,
          payment_method, finance_decided_by_id, finance_decided_at)
       VALUES ($1,$2,$2,$3,$4,'cash flow probe',$5,$6,'finance','APPROVED',
               'Wallet Number',$3,now()) RETURNING *`,
      [`CF-${stamp}-${n++}`, deptId, FINANCE.id, type, due, amount]);
    made.push(r.id);
    return r;
  };

  const pay = async (requestId: string, amount: number, on: string) =>
    query(`INSERT INTO fin_payments
             (request_id, amount, paid_at, recorded_by_id, idempotency_key)
           VALUES ($1,$2,$3::date,$4,$5)`,
      [requestId, amount, on, FINANCE.id, `cf-${stamp}-${n++}`]);

  const dayOf = (out: any, day: string) => out.days.find((d: any) => d.day === day);
  const col = (out: any, day: string, key: string) => dayOf(out, day).columns[key];

  /* The forecast counts every approved request due on or before the day being
     asked about, not just the month's -- an overdue request that has not been
     paid still needs money, and the spreadsheet formula says the same
     (`A<=day` with no lower bound). So a database carrying requests from
     earlier months has a baseline, and these assertions measure what this
     test's own rows ADD to it rather than pretending it is zero. */
  /* The default is the corrected method now, so every assertion that wants
     the spreadsheet's own answer asks for it by name. */
  const baseline = await cf.forMonth(FINANCE, MONTH, 'legacy');
  const added = (out: any, day: string, key: string) =>
    col(out, day, key) - col(baseline, day, key);

  section('A request counts from its due date, not before');
  {
    await request(MKT, `${MONTH}-10`, 1000);
    const out = await cf.forMonth(FINANCE, MONTH, 'legacy');
    eq('it adds nothing on the 9th', added(out, `${MONTH}-09`, 'marketingexp'), 0);
    eq('the full amount on the 10th', added(out, `${MONTH}-10`, 'marketingexp'), 1000);
    eq('and it stays there afterwards', added(out, `${MONTH}-20`, 'marketingexp'), 1000);
  }

  section('Once paid, only what is left counts — and only from the next day');
  {
    const before = await cf.forMonth(FINANCE, MONTH, 'legacy');
    const r = await request(MKT, `${MONTH}-01`, 1000);
    await pay(r.id, 400, `${MONTH}-15`);
    const out = await cf.forMonth(FINANCE, MONTH, 'legacy');
    const delta = (d: string) =>
      col(out, d, 'marketingexp') - col(before, d, 'marketingexp');

    /* The formula's own rule: the full amount while last-paid is on or AFTER
       the day being asked about. So the day of payment still shows the full
       figure, and the reduction appears the day after. */
    eq('the full amount on the day of payment', delta(`${MONTH}-15`), 1000);
    eq('and only the remaining the day after', delta(`${MONTH}-16`), 600);
  }

  section('Where the spreadsheet is wrong: two part payments');
  {
    /* 1,000 on the 5th and 2,000 on the 20th. On the 10th, 1,000 has really
       gone out — but the sheet keeps only the LAST payment date, sees the
       20th, decides nothing has been paid yet, and counts the full 3,000. */
    const r = await request(PUR, `${MONTH}-01`, 3000, 'Petty Cash');
    await pay(r.id, 1000, `${MONTH}-05`);
    await pay(r.id, 2000, `${MONTH}-20`);

    const legacy = await cf.forMonth(FINANCE, MONTH, 'legacy');
    const accurate = await cf.forMonth(FINANCE, MONTH, 'accurate');

    eq('the sheet says the whole 3,000 is still needed on the 10th',
       col(legacy, `${MONTH}-10`, 'pettycash') - col(baseline, `${MONTH}-10`, 'pettycash'),
       3000);
    eq('the real answer is 2,000',
       col(accurate, `${MONTH}-10`, 'pettycash') - col(baseline, `${MONTH}-10`, 'pettycash'),
       2000);
    eq('after the last payment it is settled',
       col(accurate, `${MONTH}-25`, 'pettycash') - col(baseline, `${MONTH}-25`, 'pettycash'),
       0);
  }

  section('The comparison screen finds exactly those days');
  {
    const cmp = await cf.compare(FINANCE, MONTH);
    ok('some days differ', cmp.daysThatDiffer > 0);
    ok('and the sheet is the one overstating',
       cmp.differences.every((d: any) => d.overstatedBy > 0),
       JSON.stringify(cmp.differences.slice(0, 2)));
    ok('with the legacy total the larger', cmp.legacyTotal > cmp.accurateTotal);
  }

  section('Each column takes only what belongs to it');
  {
    const out = await cf.forMonth(FINANCE, MONTH, 'legacy');
    const d = dayOf(out, `${MONTH}-25`);
    /* Purchases is split by type: Petty Cash in one column, everything else
       in the other. */
    ok('petty cash is in its own column', 'pettycash' in d.columns);
    ok('and vendors payments in another', 'vendorspayments' in d.columns);
    eq('a Petty Cash request does not reach the vendors column',
       d.columns.vendorspayments - col(baseline, `${MONTH}-25`, 'vendorspayments'), 0);

    const before = await cf.forMonth(FINANCE, MONTH, 'legacy');
    await request(PUR, `${MONTH}-02`, 500, 'Vendors Payments');
    const after = await cf.forMonth(FINANCE, MONTH, 'legacy');
    eq('but a vendors one does',
       col(after, `${MONTH}-05`, 'vendorspayments')
       - col(before, `${MONTH}-05`, 'vendorspayments'), 500);
  }

  section('Office, Workshop and Warehouse have no column of their own');
  {
    const out = await cf.forMonth(FINANCE, MONTH, 'legacy');
    const keys = out.columns.map((c: any) => c.key);
    eq('seven columns, as the sheet has', keys.length, 7);
    ok('and none of them is a lite department',
       !keys.some((k: string) => /office|workshop|warehouse/i.test(k)));
    /* They reach the forecast only after Purchases prices them, through the
       Purchases columns -- which is what charged_to_department_id carries. */
  }

  section('Only approved requests are forecast');
  {
    const beforePending = await cf.forMonth(FINANCE, MONTH, 'legacy');
    const pending = await one<any>(
      `INSERT INTO fin_requests
         (reference, department_id, charged_to_department_id, requester_id, type,
          description, due_date, requested_amount, route, approval_state, payment_method)
       VALUES ($1,$2,$2,$3,'Models','not approved',$4,9999,'finance','FINANCE_PENDING',
               'Wallet Number') RETURNING id`,
      [`CF-PEND-${stamp}`, MKT, FINANCE.id, `${MONTH}-03`]);
    made.push(pending.id);

    const after = await cf.forMonth(FINANCE, MONTH, 'legacy');
    /* Inserted just above and still FINANCE_PENDING. The forecast is about
       money somebody has committed to, and nobody has committed to this. */
    ok('a request still being approved adds nothing to the forecast',
       col(after, `${MONTH}-28`, 'marketingexp')
       - col(beforePending, `${MONTH}-28`, 'marketingexp') === 0);
  }

  section('The corrected figures are what you get by default');
  {
    /* The decision taken here: the default is the right number, because the
       other one overstates and a forecast that overstates makes the company
       hold cash it does not need. The old one stays reachable by name. */
    const dflt = await cf.forMonth(FINANCE, MONTH);
    eq('asking for nothing in particular gives the corrected method',
       dflt.method, 'accurate');
    const old = await cf.forMonth(FINANCE, MONTH, 'legacy');
    eq('and the spreadsheet is still available by name', old.method, 'legacy');
    ok('with the old one asking for more',
       old.days.reduce((n: number, d: any) => n + d.total, 0)
       >= dflt.days.reduce((n: number, d: any) => n + d.total, 0));
  }

  section('Who may see it');
  {
    let msg = '';
    try {
      await cf.forMonth({ id: 'x', permissions: [], managedDepartmentIds: [] } as any, MONTH);
    } catch (e: any) { msg = e.message; }
    ok('not an ordinary employee', /cannot see the cash flow/i.test(msg), msg);
  }

  for (const id of made) {
    await query(`DELETE FROM fin_payments WHERE request_id=$1`, [id]);
    await query(`DELETE FROM fin_requests WHERE id=$1`, [id]);
  }
  await query(`DELETE FROM core_users WHERE id=$1`, [FINANCE.id]);

  console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nfailures:'); failures.forEach((f) => console.log('  ' + f)); }
  await closeDb();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });