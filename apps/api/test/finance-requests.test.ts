/**
 * Finance requests against a real database: the chain end to end.
 *
 *   DATABASE_URL=... npx tsx test/finance-requests.test.ts
 *
 * The rules themselves are tested without a database in finance-workflow.test.
 * This is about what actually happens to rows: that a decision is recorded
 * once, that the trail is append-only, that visibility holds, and that the
 * states a constraint forbids really are impossible.
 */
import { query, one, closeDb } from '../src/common/db';
import { FinanceRequestsService } from '../src/modules/finance/requests.service';

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
const svc = () => new FinanceRequestsService(notifications, audit);

const DUE = '2026-12-01';

async function main() {
  const s = svc();
  const stamp = Date.now();
  const mkUser = async (name: string, deptId: string | null) => (await one<any>(
    `INSERT INTO core_users (email, password_hash, full_name, department_id)
     VALUES ($1,'x',$2,$3) RETURNING id`,
    [`${name}-${stamp}@example.invalid`, name, deptId])).id;

  const dept = async (code: string) => (await one<any>(
    `SELECT department_id FROM fin_departments WHERE code=$1`, [code])).department_id;

  const MKT = await dept('MKT'), OFC = await dept('OFC'), PUR = await dept('PUR');

  const sami = { id: await mkUser('Sami', MKT), fullName: 'Sami', departmentId: MKT,
                 permissions: [], managedDepartmentIds: [] } as any;
  const mona = { id: await mkUser('Mona', MKT), fullName: 'Mona', departmentId: MKT,
                 permissions: [], managedDepartmentIds: [MKT] } as any;
  const purch = { id: await mkUser('Purch', PUR), fullName: 'Purch', departmentId: PUR,
                  permissions: ['finance.purchases.decide'], managedDepartmentIds: [] } as any;
  const fin = { id: await mkUser('Fin', PUR), fullName: 'Fin', departmentId: PUR,
                permissions: ['finance.request.manage', 'finance.payment.record'],
                managedDepartmentIds: [] } as any;
  await query(`INSERT INTO core_department_managers (department_id, user_id) VALUES ($1,$2)`,
              [MKT, mona.id]);

  const made: string[] = [];
  /* No departmentId: a request is always for the requester's own department.
     moreDetails and the transfer details are required for a request going
     straight to Finance, as the legacy form requires them. */
  const create = async (p: any, over: any = {}) => {
    const r = await s.create(p, {
      type: 'Models', description: 'Photoshoot fee',
      moreDetails: 'Autumn campaign, two days',
      dueDate: DUE, requestedAmount: 5000,
      paymentMethod: 'Wallet Number', accountNumber: '01001234567', ...over });
    made.push(r.id); return r;
  };

  section('Raising a request');
  {
    const r = await create(sami);
    eq('it starts with the department manager', r.approvalState, 'MANAGER_PENDING');
    eq('which the requester sees as Open', r.label, 'Open');
    eq('in Arabic too', r.labelAr, 'قيد الموافقة');
    ok('and it has a reference in the familiar shape', /^MKT-[a-z0-9]{7}$/.test(r.reference),
       r.reference);
    eq('waiting on the manager step', r.waitingOn, 'MANAGER');
  }

  section('The type must be one the department actually has');
  {
    const m = await err(() => create(sami, { type: 'Server renewal' }));
    ok('a type from another department is refused', /choose a type/i.test(m), m);

    /* A request bound for Purchases carries no type at all, whoever asks --
       so a type sent anyway is dropped rather than refused. */
    const toPur = await create(sami, { sendToPurchases: true });
    eq('and one sent to Purchases carries none', toPur.type, null);
    eq('nor an amount', toPur.requestedAmount, null);
  }

  section("A manager's own request skips his own step");
  {
    const r = await create(mona);
    eq('straight to Finance', r.approvalState, 'FINANCE_PENDING');
    ok('and he cannot decide it himself', !r.canDecide);
    const m = await err(() => s.decide(mona, r.id, 'APPROVED'));
    ok('the server refuses too', /your own request/i.test(m), m);
  }

  section('The chain, on real rows');
  {
    const r = await create(sami);
    const m = await err(() => s.decide(fin, r.id, 'APPROVED'));
    ok('Finance cannot jump the manager step', /not waiting for you/i.test(m), m);

    const afterMgr = await s.decide(mona, r.id, 'APPROVED');
    eq('the manager approves and it moves to Finance', afterMgr.approvalState, 'FINANCE_PENDING');
    eq('still Open to the requester', afterMgr.label, 'Open');

    const done = await s.decide(fin, r.id, 'APPROVED');
    eq('Finance approves and the chain ends', done.approvalState, 'APPROVED');
    eq('now it reads In Progress', done.label, 'In Progress');
    eq('in Arabic', done.labelAr, 'جاري التنفيذ');

    const m2 = await err(() => s.decide(fin, r.id, 'APPROVED'));
    ok('and it cannot be decided twice', /already been decided/i.test(m2), m2);
  }

  section('A lite department goes through Purchases');
  {
    const omar = { id: await mkUser('Omar', OFC), fullName: 'Omar', departmentId: OFC,
                   permissions: [], managedDepartmentIds: [] } as any;
    const r = await s.create(omar, {
      description: 'Office cleaning, monthly', dueDate: DUE } as any);
    made.push(r.id);
    /* Office has no manager of its own in this fixture, so it starts at
       Purchases rather than with a manager. */
    eq('it starts with Purchases', r.approvalState, 'PURCHASES_PENDING');
    eq('and carries no type yet', r.type, null);

    const m = await err(() => s.decide(fin, r.id, 'APPROVED'));
    ok('Finance cannot take the Purchases step', /not waiting for you/i.test(m), m);

    /* Purchases cannot wave it through: it must say what the thing costs and
       how it is paid, or Finance has approved something nobody can pay. */
    const afterPur = await s.decide(purch, r.id, 'APPROVED', undefined, {
      type: 'Petty Cash', requestedAmount: 1200,
      paymentMethod: 'Wallet Number', accountNumber: '01001234567' } as any);
    eq('Purchases approves, Finance is next', afterPur.approvalState, 'FINANCE_PENDING');
    const done = await s.decide(fin, r.id, 'APPROVED');
    eq('and Finance finishes it', done.approvalState, 'APPROVED');
  }

  section('Rejection');
  {
    const r = await create(sami);
    const m = await err(() => s.decide(mona, r.id, 'REJECTED'));
    ok('a rejection must say why', /Say why/i.test(m), m);

    const rejected = await s.decide(mona, r.id, 'REJECTED', 'Not budgeted this quarter');
    eq('it is rejected', rejected.approvalState, 'REJECTED');
    eq('and says so to the requester', rejected.label, 'Rejected');
    eq('with the reason attached', rejected.rejectionReason, 'Not budgeted this quarter');

    const full = await s.get(sami, r.id);
    ok('the reason is on the conversation as well',
       full.notes.some((n: any) => /Not budgeted/.test(n.body)));
  }

  section('The approval trail is appended, never rewritten');
  {
    const r = await create(sami);
    await s.decide(mona, r.id, 'REJECTED', 'wrong amount');
    const after = await s.get(fin, r.id);
    eq('one entry so far', after.approvals.length, 1);
    eq('recording the step', after.approvals[0].step, 'MANAGER');
    eq('the decision', after.approvals[0].decision, 'REJECTED');
    eq('and what the amount was at the time', after.approvals[0].amountAtDecision, 5000);
  }

  section('Editing in place, only while Open');
  {
    const r = await create(sami);
    const edited = await s.update(sami, r.id, { requestedAmount: 6000 });
    eq('the requester may change it while it is Open', edited.requestedAmount, 6000);

    const m = await err(() => s.update(mona, r.id, { requestedAmount: 1 }));
    ok('a colleague may not', /person who raised it/i.test(m), m);

    await s.decide(mona, r.id, 'APPROVED');
    await s.decide(fin, r.id, 'APPROVED');
    const m2 = await err(() => s.update(sami, r.id, { requestedAmount: 7000 }));
    ok('and nobody may, once approved', /Ask for a change instead/i.test(m2), m2);
  }

  section('What each person can see');
  {
    const samiSees = await s.list(sami);
    ok('an employee sees only his own', samiSees.requests.every((x: any) =>
      x.requester.id === sami.id), JSON.stringify(samiSees.requests.map((x: any) => x.reference)));

    const monaSees = await s.list(mona);
    ok('a manager sees his department too',
       monaSees.requests.some((x: any) => x.requester.id === sami.id));

    const finSees = await s.list(fin);
    /* Not "everything": a request still with its department manager has not
       reached Finance yet, so Finance can legitimately see fewer rows than the
       manager does. What Finance must see is everything that has passed the
       department. */
    ok('Finance sees every request that has left its department',
       finSees.requests.every((x: any) =>
         x.approvalState !== 'MANAGER_PENDING' && x.approvalState !== 'DRAFT'));
    ok('including requests from departments it does not manage',
       finSees.requests.some((x: any) => x.requester.id !== fin.id));

    const other = { id: await mkUser('Other', OFC), fullName: 'Other', departmentId: OFC,
                    permissions: [], managedDepartmentIds: [] } as any;
    const m = await err(() => s.get(other, made[0]));
    ok("and somebody unrelated cannot open another department's request",
       /No such request/i.test(m), m);
    await query(`DELETE FROM core_users WHERE id=$1`, [other.id]);
  }

  section('Finance does not see a request still with its department manager');
  {
    /* The department has not finished deciding whether to ask for this yet.
       Until the manager has had it, it is the department's business. */
    const r = await create(sami);
    eq('it is with the manager', r.approvalState, 'MANAGER_PENDING');

    const finList = await s.list(fin);
    ok('Finance does not have it in the list',
       !finList.requests.some((x: any) => x.id === r.id));
    const m = await err(() => s.get(fin, r.id));
    ok('nor can Finance open it by its address', /No such request/i.test(m), m);

    const monaList = await s.list(mona);
    ok('but the manager does — it is waiting for him',
       monaList.requests.some((x: any) => x.id === r.id));
    const samiList = await s.list(sami);
    ok('and the requester watches his own', samiList.requests.some((x: any) => x.id === r.id));

    await s.decide(mona, r.id, 'APPROVED');
    const after = await s.list(fin);
    ok('once the manager approves, Finance sees it',
       after.requests.some((x: any) => x.id === r.id));
    const opened = await s.get(fin, r.id);
    eq('and can open it', opened.id, r.id);
  }

  section("A manager's own request reaches Finance at once");
  {
    const r = await create(mona);
    eq('it skipped the manager step', r.approvalState, 'FINANCE_PENDING');
    const finList = await s.list(fin);
    ok('so Finance has it immediately', finList.requests.some((x: any) => x.id === r.id));
    const q = await s.approvalsQueue(fin);
    ok('and it is in the Finance queue', q.requests.some((x: any) => x.id === r.id));
  }

  section('A draft belongs to nobody but its author');
  {
    const d = await create(sami, {
      description: 'Thinking about it', requestedAmount: 900, submit: false });
    eq('it is a draft', d.approvalState, 'DRAFT');

    ok('the author sees it', (await s.list(sami)).requests.some((x: any) => x.id === d.id));
    ok('his manager does not',
       !(await s.list(mona)).requests.some((x: any) => x.id === d.id));
    ok('Finance does not', !(await s.list(fin)).requests.some((x: any) => x.id === d.id));
    const m = await err(() => s.get(fin, d.id));
    ok('and cannot open it', /No such request/i.test(m), m);

    const sent = await s.submit(sami, d.id);
    eq('submitting sends it to the manager', sent.approvalState, 'MANAGER_PENDING');
    ok('who now sees it', (await s.list(mona)).requests.some((x: any) => x.id === d.id));
  }

  section('The approvals queue holds only what is yours to decide');
  {
    const monaQ = await s.approvalsQueue(mona);
    ok('the manager sees pending requests from his department',
       monaQ.requests.every((x: any) => x.approvalState === 'MANAGER_PENDING'));
    ok('and never his own', monaQ.requests.every((x: any) => x.requester.id !== mona.id));

    const finQ = await s.approvalsQueue(fin);
    ok('Finance sees only what reached Finance',
       finQ.requests.every((x: any) => x.approvalState === 'FINANCE_PENDING'));

    const samiQ = await s.approvalsQueue(sami);
    eq('an ordinary employee has an empty queue', samiQ.total, 0);
  }

  section('Internal notes stay internal');
  {
    const r = await create(sami);
    await s.addNote(fin, r.id, 'Check last quarter first', true);
    await s.addNote(sami, r.id, 'Needed before the shoot', false);

    const asRequester = await s.notes(sami, r.id);
    eq('the requester sees only the open note', asRequester.length, 1);
    eq('which is his own', asRequester[0].body, 'Needed before the shoot');

    const asFinance = await s.notes(fin, r.id);
    eq('Finance sees both', asFinance.length, 2);

    const m = await err(() => s.addNote(sami, r.id, 'sneaky', true));
    ok('and an employee cannot leave an internal one', /Finance and Purchases/i.test(m), m);
  }

  section('Deleting');
  {
    const r = await create(sami);
    const m = await err(() => s.remove(sami, r.id));
    ok('an employee cannot delete a request', /cannot delete/i.test(m), m);
    const out = await s.remove(fin, r.id);
    ok('Finance can, while nothing has been paid', out.removed);
    const m2 = await err(() => s.get(fin, r.id));
    ok('and it is gone from view', /No such request/i.test(m2), m2);
  }

  section('States the database itself refuses');
  {
    const r = await create(sami);
    const bad = await err(async () => query(
      `UPDATE fin_requests SET approval_state='REJECTED' WHERE id=$1`, [r.id]));
    ok('a rejection with no rejector is impossible',
       /rejection_is_complete/i.test(bad), bad.slice(0, 80));

    const bad2 = await err(async () => query(
      `UPDATE fin_requests SET approval_state='APPROVED' WHERE id=$1`, [r.id]));
    ok('and so is an approval nobody made',
       /approval_is_complete/i.test(bad2), bad2.slice(0, 80));

    const bad3 = await err(async () => query(
      `UPDATE fin_requests SET requested_amount=0 WHERE id=$1`, [r.id]));
    /* The constraint is now route-aware: zero is fine for a Purchases request
       that has not been priced, and refused for one going straight to Finance. */
    ok('an amount of zero is refused on a request bound for Finance',
       /amount_matches_route/i.test(bad3), bad3.slice(0, 80));
  }

  // tidy up
  for (const id of made) await query(`DELETE FROM fin_requests WHERE id=$1`, [id]);
  await query(`DELETE FROM core_department_managers WHERE user_id=$1`, [mona.id]);
  await query(`DELETE FROM core_users WHERE full_name='Omar' AND email LIKE $1`,
              [`%-${stamp}@example.invalid`]);
  await query(`DELETE FROM core_notifications WHERE user_id = ANY($1::uuid[])`,
              [[sami.id, mona.id, purch.id, fin.id]]);
  await query(`DELETE FROM core_users WHERE id = ANY($1::uuid[])`,
              [[sami.id, mona.id, purch.id, fin.id]]);

  console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nfailures:'); failures.forEach((f) => console.log('  ' + f)); }
  await closeDb();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });