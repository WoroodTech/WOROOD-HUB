/**
 * Changing a request after it has been approved.
 *
 *   DATABASE_URL=... npx tsx test/finance-edits.test.ts
 *
 * The rule the whole thing turns on: the edit holds the new values and the
 * request keeps the old ones until BOTH the manager and Finance have agreed.
 * An edit approved halfway changes nothing.
 */
import { query, one, closeDb } from '../src/common/db';
import { FinanceRequestsService } from '../src/modules/finance/requests.service';
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

async function main() {
  const reqs = new FinanceRequestsService(notifications, audit);
  const edits = new FinanceEditsService(notifications, audit);
  const stamp = Date.now();

  const mkUser = async (name: string, deptId: string) => (await one<any>(
    `INSERT INTO core_users (email, password_hash, full_name, department_id)
     VALUES ($1,'x',$2,$3) RETURNING id`,
    [`${name}-${stamp}@example.invalid`, name, deptId])).id;
  const dept = async (code: string) => (await one<any>(
    `SELECT department_id FROM fin_departments WHERE code=$1`, [code])).department_id;

  const MKT = await dept('MKT'), PUR = await dept('PUR');
  const sami = { id: await mkUser('ESami', MKT), fullName: 'Sami', departmentId: MKT,
                 permissions: [], managedDepartmentIds: [] } as any;
  const mona = { id: await mkUser('EMona', MKT), fullName: 'Mona', departmentId: MKT,
                 permissions: [], managedDepartmentIds: [MKT] } as any;
  const fin = { id: await mkUser('EFin', PUR), fullName: 'Fin', departmentId: PUR,
                permissions: ['finance.request.manage'], managedDepartmentIds: [] } as any;
  await query(`INSERT INTO core_department_managers (department_id, user_id) VALUES ($1,$2)`,
              [MKT, mona.id]);

  const made: string[] = [];
  /** A request taken all the way to approved. */
  const approved = async (amount = 5000) => {
    const r = await reqs.create(sami, {
      type: 'Models', description: 'Photoshoot fee',
      moreDetails: 'Autumn campaign', dueDate: '2026-12-01',
      requestedAmount: amount, paymentMethod: 'Wallet Number',
      accountNumber: '01001234567' } as any);
    made.push(r.id);
    await reqs.decide(mona, r.id, 'APPROVED');
    await reqs.decide(fin, r.id, 'APPROVED');
    return r;
  };

  section('A change can only be asked for once the request is approved');
  {
    const r = await reqs.create(sami, {
      type: 'Models', description: 'x', moreDetails: 'y', dueDate: '2026-12-01',
      requestedAmount: 1000, paymentMethod: 'Wallet Number',
      accountNumber: '01001234567' } as any);
    made.push(r.id);
    const m = await err(() => edits.request(sami, r.id, { newAmount: 2000, reason: 'more' }));
    ok('while it is Open, you change it directly instead',
       /change it directly/i.test(m), m);
  }

  section('Asking for one');
  {
    const r = await approved();
    const m = await err(() => edits.request(mona, r.id, { newAmount: 1, reason: 'x' }));
    ok('only the person who raised it may ask', /person who raised it/i.test(m), m);

    const m2 = await err(() => edits.request(sami, r.id, { newAmount: 6000, reason: '  ' }));
    ok('and must say why', /say why/i.test(m2), m2);

    const m3 = await err(() => edits.request(sami, r.id, { reason: 'just because' }));
    ok('and must ask for something', /what you would like to change/i.test(m3), m3);

    const e = await edits.request(sami, r.id, {
      newAmount: 6500, reason: 'The studio raised its day rate' });
    eq('it starts with the department manager', e.status, 'MANAGER_PENDING');
    eq('carrying the new figure', e.newAmount, 6500);
    eq('and what the old one was', e.amountBefore, 5000);
  }

  section('Nothing changes until the whole chain agrees');
  {
    const r = await approved();
    const e = await edits.request(sami, r.id, { newAmount: 7000, reason: 'price went up' });

    const still = await reqs.get(sami, r.id);
    eq('the request is untouched while the edit waits', still.requestedAmount, 5000);

    await edits.decide(mona, e.id, 'APPROVED');
    const afterMgr = await reqs.get(sami, r.id);
    /* The manager agreeing is half the chain. The legacy app applied the change
       at this point from one of its two code paths. */
    eq('and still untouched after the manager agrees', afterMgr.requestedAmount, 5000);

    const done = await edits.decide(fin, e.id, 'APPROVED');
    eq('the edit is applied once Finance agrees too', done.status, 'APPLIED');
    const after = await reqs.get(sami, r.id);
    eq('and only now does the request carry the new figure', after.requestedAmount, 7000);
    ok('with the change recorded on its trail',
       after.approvals.some((a: any) => /Change applied/.test(a.reason ?? '')));
  }

  section('Who may decide a change');
  {
    const r = await approved();
    const e = await edits.request(sami, r.id, { newAmount: 5500, reason: 'rounding' });

    const m = await err(() => edits.decide(fin, e.id, 'APPROVED'));
    ok('Finance cannot jump the manager step', /not waiting for you/i.test(m), m);
    const m2 = await err(() => edits.decide(sami, e.id, 'APPROVED'));
    ok('nor can the person who asked decide it', /your own change/i.test(m2), m2);

    await edits.decide(mona, e.id, 'APPROVED');
    /* Having approved it, the manager has handed it on: it is now Finance's,
       so trying again says it is not waiting for him rather than that it is
       finished -- which it is not. */
    const m3 = await err(() => edits.decide(mona, e.id, 'APPROVED'));
    ok('and having approved it, the manager no longer holds it',
       /not waiting for you/i.test(m3), m3);

    await edits.decide(fin, e.id, 'APPROVED');
    const m4 = await err(() => edits.decide(fin, e.id, 'APPROVED'));
    ok('once the chain is finished, nobody can decide it again',
       /already been decided/i.test(m4), m4);
  }

  section('A refused change leaves the request alone');
  {
    const r = await approved();
    const e = await edits.request(sami, r.id, { newAmount: 9000, reason: 'want more' });
    const m = await err(() => edits.decide(mona, e.id, 'REJECTED'));
    ok('a refusal must say why', /say why/i.test(m), m);

    const out = await edits.decide(mona, e.id, 'REJECTED', 'Budget is fixed this quarter');
    eq('it is refused', out.status, 'REJECTED');
    eq('with the reason', out.decisionReason, 'Budget is fixed this quarter');
    const after = await reqs.get(sami, r.id);
    eq('and the request keeps its figure', after.requestedAmount, 5000);
  }

  section("A manager's own change skips his own step");
  {
    const r = await reqs.create(mona, {
      type: 'Models', description: 'Manager request', moreDetails: 'y',
      dueDate: '2026-12-01', requestedAmount: 3000,
      paymentMethod: 'Wallet Number', accountNumber: '01001234567' } as any);
    made.push(r.id);
    await reqs.decide(fin, r.id, 'APPROVED');
    const e = await edits.request(mona, r.id, { newAmount: 3500, reason: 'extra day' });
    eq('straight to Finance', e.status, 'FINANCE_PENDING');
  }

  section('Only one open change per request');
  {
    const r = await approved();
    await edits.request(sami, r.id, { newAmount: 6000, reason: 'first' });
    const m = await err(() => edits.request(sami, r.id, { newAmount: 7000, reason: 'second' }));
    /* Two approved changes would leave the request holding whichever landed
       last, with no record of the contradiction. */
    ok('a second is refused while the first is undecided',
       /already a change waiting/i.test(m), m);
  }

  section('Taking one back');
  {
    const r = await approved();
    const e = await edits.request(sami, r.id, { newAmount: 5200, reason: 'maybe' });
    const m = await err(() => edits.withdraw(mona, e.id));
    ok('only the person who asked may withdraw it', /person who asked/i.test(m), m);
    const out = await edits.withdraw(sami, e.id);
    ok('and then it is gone', out.withdrawn);
    const again = await edits.request(sami, r.id, { newAmount: 5300, reason: 'decided' });
    eq('so another can be asked for', again.status, 'MANAGER_PENDING');
  }

  section('A manager looking at the request can act on the change');
  {
    /* The bug this catches: the list of changes on a request did not bring the
       request's department back with it, so "do you manage this department"
       was asked of an undefined value and always answered no. The manager saw
       the change and had no button. */
    const r = await approved();
    await edits.request(sami, r.id, { newAmount: 6100, reason: 'rate went up' });

    const asManager = await edits.forRequest(mona, r.id);
    eq('the change is there', asManager.length, 1);
    ok('and the manager can act on it', asManager[0].canDecide);

    const asRequester = await edits.forRequest(sami, r.id);
    ok('the person who asked cannot decide it', !asRequester[0].canDecide);
    ok('but can take it back', asRequester[0].canWithdraw);

    const asFinance = await edits.forRequest(fin, r.id);
    ok('and Finance cannot, while it is with the manager', !asFinance[0].canDecide);

    await edits.decide(mona, asManager[0].id, 'APPROVED');
    const afterMgr = await edits.forRequest(fin, r.id);
    ok('once the manager agrees, Finance can', afterMgr[0].canDecide);
    ok('and the manager no longer can', !(await edits.forRequest(mona, r.id))[0].canDecide);
  }

  section('The queue holds only what is yours');
  {
    const monaQ = await edits.queue(mona);
    ok('the manager sees changes at the manager step',
       monaQ.every((e: any) => e.status === 'MANAGER_PENDING'));
    ok('and never his own', monaQ.every((e: any) => e.requestedBy.id !== mona.id));
    const finQ = await edits.queue(fin);
    ok('Finance sees only what reached Finance',
       finQ.every((e: any) => e.status === 'FINANCE_PENDING'));
    eq('an ordinary employee has none', (await edits.queue(sami)).length, 0);
  }

  section('An edit that changes words rather than money');
  {
    const r = await approved();
    const e = await edits.request(sami, r.id, {
      newDescription: 'Photoshoot fee — revised brief', reason: 'brief changed' });
    eq('carries no new amount', e.newAmount, null);
    await edits.decide(mona, e.id, 'APPROVED');
    await edits.decide(fin, e.id, 'APPROVED');
    const after = await reqs.get(sami, r.id);
    eq('the words change', after.description, 'Photoshoot fee — revised brief');
    eq('and the figure does not', after.requestedAmount, 5000);
  }

  for (const id of made) await query(`DELETE FROM fin_requests WHERE id=$1`, [id]);
  await query(`DELETE FROM core_department_managers WHERE user_id=$1`, [mona.id]);
  await query(`DELETE FROM core_notifications WHERE user_id = ANY($1::uuid[])`,
              [[sami.id, mona.id, fin.id]]);
  await query(`DELETE FROM core_users WHERE id = ANY($1::uuid[])`, [[sami.id, mona.id, fin.id]]);

  console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nfailures:'); failures.forEach((f) => console.log('  ' + f)); }
  await closeDb();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });