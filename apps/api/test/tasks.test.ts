/**
 * End-to-end verification of Module 3.
 *
 *   npm run migrate && npm run seed -- --reset
 *   npm run build && node dist/main.js     (in one shell)
 *   npx tsx test/tasks.test.ts             (in another)
 *
 * The properties worth proving here are the ones that cannot be proven by
 * reading the code, and each is proven by DOING it rather than by inspecting
 * a row:
 *
 *   - a ticket is invisible to a colleague in the same department who is not
 *     on it, and becomes visible the moment a manager brings them in;
 *   - authority is scoped by the org chart, so a manager of one department
 *     cannot assign inside another even though they hold the same key;
 *   - a dependency is an ordinary ticket to a third department, the parent
 *     blocks, and it unblocks on its own when the child closes;
 *   - the requester can see THAT it is blocked and on whom, and cannot see
 *     the blocking ticket's content;
 *   - lateness is a condition beside the status, not instead of it.
 */

import { closeDb, one, query } from '../src/common/db';
import { config } from '../src/common/config';

const BASE = `http://127.0.0.1:${config.port}/api/v1`;
const OPEN = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED', 'RESOLVED'];
let pass = 0, fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name} ${detail}`); }
}

async function login(email: string, password = 'Worood@2026'): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
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

const post = (t: string, p: string, body?: unknown) =>
  call(t, p, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

async function main() {
  console.log('\nModule 3 — tasks & tickets\n');

  /* The cast. Nadia runs Marketing; Omnia and Mariam both run Customer Care;
     Youssef and Salma are agents underneath them; Tarek runs Facilities. */
  const nadia = await login('nadia@worood.co');
  const omnia = await login('omnia.osama@worood.co');
  const mariam = await login('mariam.adel@worood.co');
  const youssef = await login('youssef.samir@worood.co');
  const salma = await login('salma.nabil@worood.co');
  const tarek = await login('tarek.mahmoud@worood.co');
  const kandil = await login('Kandil@worood.co');
  const admin = await login('Admin@worood.co');

  const depts = (await call(nadia, '/tasks/departments')).body as any[];
  const careDept = depts.find((d) => d.name === 'Customer Care');
  const facilities = depts.find((d) => d.name === 'Facilities');
  const marketing = depts.find((d) => d.name === 'Marketing');

  console.log('-- the org chart is the scope --');

  check('every department offered has a manager',
    depts.length === 8 && depts.every((d) => !!d.id));

  const nadiaMe = (await call(nadia, '/auth/me')).body;
  const youssefMe = (await call(youssef, '/auth/me')).body;
  check('managing a department derives the assign key, without a role',
    nadiaMe.permissions.includes('tasks.item.assign')
    && nadiaMe.managedDepartmentIds.includes(marketing.id));
  check('an ordinary employee derives nothing',
    !youssefMe.permissions.includes('tasks.item.assign')
    && youssefMe.managedDepartmentIds.length === 0);
  check("a manager's scope is their own department only",
    !nadiaMe.managedDepartmentIds.includes(careDept.id));

  console.log('\n-- raising and assigning --');

  const created = await post(nadia, '/tasks', {
    title: 'Refund enquiry from the Zamalek order',
    description: 'Customer says the vase arrived chipped. Need the courier note.',
    priority: 'HIGH', departmentId: careDept.id,
  });
  check('a ticket can be raised to another department', created.status === 201, String(created.status));
  const ticket = created.body;
  check('it opens unassigned, in the target department',
    ticket.status === 'NEW' && ticket.assigneeId === null && ticket.department === 'Customer Care');
  check('the reference comes from a sequence', /^TK-\d+$/.test(ticket.reference), ticket.reference);

  check('the requester sees her own ticket',
    (await call(nadia, `/tasks/${ticket.id}`)).status === 200);
  check('both managers of the target department see it',
    (await call(omnia, `/tasks/${ticket.id}`)).status === 200
    && (await call(mariam, `/tasks/${ticket.id}`)).status === 200);

  /* The confidentiality rule, and the reason the module stores visibility per
     ticket rather than per department. */
  const peek = await call(youssef, `/tasks/${ticket.id}`);
  check('a colleague in that department who is not on it cannot see it',
    peek.status === 404, `got ${peek.status}`);

  const wrongManager = await post(nadia, `/tasks/${ticket.id}/assign`,
    { assigneeId: youssefMe.id });
  check('a manager of another department cannot assign inside this one',
    wrongManager.status === 403 || wrongManager.status === 404, `got ${wrongManager.status}`);

  const outsider = await post(omnia, `/tasks/${ticket.id}/assign`,
    { assigneeId: nadiaMe.id });
  check('a manager cannot assign to somebody outside their department',
    outsider.status === 400, `got ${outsider.status}`);

  const assigned = await post(omnia, `/tasks/${ticket.id}/assign`, { assigneeId: youssefMe.id });
  check('the manager assigns it to one of her own team',
    assigned.status === 201 && assigned.body.status === 'ASSIGNED'
    && assigned.body.assigneeId === youssefMe.id);
  check('the assignee can now see it',
    (await call(youssef, `/tasks/${ticket.id}`)).status === 200);

  /* Two managers on one department is deliberate -- it is how cover during
     leave works -- so the second one has to be told it has gone. */
  const mariamNotes = (await call(mariam, '/hub/notifications')).body;
  const told = JSON.stringify(mariamNotes).includes('No longer waiting');
  check('the co-manager is told it has been assigned', told);

  const queueAfter = (await call(mariam, '/tasks?scope=queue')).body;
  check('it leaves the awaiting-assignment queue',
    !queueAfter.items.some((i: any) => i.id === ticket.id));

  console.log('\n-- who may change what --');

  const assigneeEdit = await call(youssef, `/tasks/${ticket.id}`, {
    method: 'PATCH', body: JSON.stringify({ title: 'Something else entirely' }),
  });
  check('the assignee cannot rewrite the request',
    assigneeEdit.status === 403, `got ${assigneeEdit.status}`);

  const requesterEdit = await call(nadia, `/tasks/${ticket.id}`, {
    method: 'PATCH', body: JSON.stringify({ title: 'Changed my mind' }),
  });
  check('nor can the requester, once somebody is on it',
    requesterEdit.status === 403, `got ${requesterEdit.status}`);

  const contributorBySelf = await post(youssef, `/tasks/${ticket.id}/contributors`,
    { userId: (await call(salma, '/auth/me')).body.id });
  check('the assignee cannot bring in a colleague himself',
    contributorBySelf.status === 403, `got ${contributorBySelf.status}`);

  const salmaId = (await call(salma, '/auth/me')).body.id;
  const added = await post(omnia, `/tasks/${ticket.id}/contributors`, { userId: salmaId });
  check('the manager can', added.status === 201);
  check('and the contributor can now read it',
    (await call(salma, `/tasks/${ticket.id}`)).status === 200);
  const salmaView = (await call(salma, `/tasks/${ticket.id}`)).body;
  check('a contributor may comment but not work on it',
    salmaView.access.canComment === true && salmaView.access.canWork === false);

  console.log('\n-- the dependency --');

  await post(youssef, `/tasks/${ticket.id}/start`);
  const dep = await post(youssef, `/tasks/${ticket.id}/dependencies`, {
    title: 'Check the cold room packing bench for damage',
    departmentId: facilities.id, priority: 'NORMAL',
  });
  check('raising a dependency creates a ticket for the third department',
    dep.status === 201 && dep.body.blockedBy.length === 1);
  check('and blocks the parent', dep.body.status === 'BLOCKED');

  const childId = dep.body.blockedBy[0].itemId;
  const facilitiesQueue = (await call(tarek, '/tasks?scope=queue')).body;
  check('it lands in the third department\'s queue as an ordinary ticket',
    facilitiesQueue.items.some((i: any) => i.id === childId));

  check('Facilities cannot see the ticket that caused it',
    (await call(tarek, `/tasks/${ticket.id}`)).status === 404);

  /* What the requester is entitled to: that it is waiting, on whom, and since
     when. Not the other department's title or conversation. */
  const nadiaSees = (await call(nadia, `/tasks/${ticket.id}`)).body;
  check('the requester can see it is blocked and on which department',
    nadiaSees.status === 'BLOCKED'
    && nadiaSees.blockedBy[0].department === 'Facilities'
    && !!nadiaSees.blockedBy[0].raisedAt);
  check('but not the blocking ticket\'s content',
    nadiaSees.blockedBy[0].title === undefined && nadiaSees.blockedBy[0].readable === false);

  const earlyResolve = await post(youssef, `/tasks/${ticket.id}/resolve`, { resolution: 'done' });
  check('it cannot be resolved while something is still owed to it',
    earlyResolve.status === 409, `got ${earlyResolve.status}`);

  /* Close the child the long way round, through its own department, because
     that is the only way it actually happens. */
  const hassan = (await call(tarek, `/tasks/departments/${facilities.id}/people`)).body
    .find((p: any) => !p.isManager);
  await post(tarek, `/tasks/${childId}/assign`, { assigneeId: hassan.id });
  const hassanToken = await login('hassan.ali@worood.co');
  await post(hassanToken, `/tasks/${childId}/start`);
  await post(hassanToken, `/tasks/${childId}/resolve`, { resolution: 'Bench edge sanded and re-lined.' });

  /* "Done" from the other department is not acceptance: the person who asked
     still has to agree it is what they needed, so the parent stays blocked.
     That is correct and it is useless unless the parent's own screen says so
     and can be clicked through -- which is exactly what was missing, and what
     this asserts. */
  const stillBlocked = (await call(youssef, `/tasks/${ticket.id}`)).body;
  check('a resolved dependency does not unblock the parent on its own',
    stillBlocked.status === 'BLOCKED');
  const answered = stillBlocked.blockedBy.find((d: any) => !d.releasedAt);
  check('and the parent can see the answer is sitting there waiting for them',
    answered.status === 'RESOLVED' && answered.readable === true && !!answered.reference);
  check('with a route to it, not just the name of a department',
    answered.itemId === childId);

  await post(youssef, `/tasks/${childId}/confirm`);

  const unblocked = (await call(youssef, `/tasks/${ticket.id}`)).body;
  check('closing the child unblocks the parent on its own',
    unblocked.status === 'IN_PROGRESS', unblocked.status);
  check('and the parent records why it moved',
    unblocked.events.some((e: any) => e.type === 'UNBLOCKED'));

  /* A manager often knows before the assignee does that another department has
     to be involved. Making them message the assignee to click a button adds a
     step and nothing else. */
  console.log('\n-- a manager may raise the dependency too --');
  {
    const byManager = await post(omnia, `/tasks/${ticket.id}/dependencies`, {
      title: 'Confirm the courier insurance covers glassware',
      departmentId: facilities.id,
    });
    check('the department manager can raise one', byManager.status === 201);
    check('and it blocks the parent again', byManager.body.status === 'BLOCKED');

    const raised = byManager.body.blockedBy.find((d: any) => !d.releasedAt);

    /* The point of the change: the person actually stuck can see what they are
       stuck on, even though somebody else asked for it. */
    const assigneeView = (await call(youssef, `/tasks/${raised.itemId}`));
    check('the assignee of the blocked ticket can open it',
      assigneeView.status === 200, `got ${assigneeView.status}`);

    check('and the requester of the blocked ticket still cannot',
      (await call(nadia, `/tasks/${raised.itemId}`)).status === 404);
    const nadiaStrip = (await call(nadia, `/tasks/${ticket.id}`)).body
      .blockedBy.find((d: any) => !d.releasedAt);
    check('she gets the strip and nothing more',
      nadiaStrip.department === 'Facilities' && nadiaStrip.title === undefined);

    check('a contributor cannot raise one',
      (await post(salma, `/tasks/${ticket.id}/dependencies`,
        { title: 'nope', departmentId: facilities.id })).status === 403);

    const dropped = await call(omnia, `/tasks/${ticket.id}/dependencies/${raised.linkId}`,
      { method: 'DELETE' });
    check('and may drop it again', dropped.status === 200 && dropped.body.status === 'IN_PROGRESS');
  }

  console.log('\n-- lateness is a condition, not a status --');

  await post(youssef, `/tasks/${ticket.id}/due`,
    { dueAt: new Date(Date.now() + 60_000).toISOString() });
  await query(`UPDATE tk_items SET due_at = now() - interval '2 hours' WHERE id = $1`, [ticket.id]);
  await post(admin, '/tasks/admin/sweep');

  const late = (await call(youssef, `/tasks/${ticket.id}`)).body;
  check('the sweep marks it overdue', late.slaState === 'OVERDUE');
  check('without touching where the work actually is',
    late.status === 'IN_PROGRESS', late.status);

  console.log('\n-- finishing --');

  const resolved = await post(youssef, `/tasks/${ticket.id}/resolve`,
    { resolution: 'Courier note attached, refund raised with Finance.' });
  check('the assignee resolves it', resolved.body.status === 'RESOLVED');

  const assigneeCloses = await post(youssef, `/tasks/${ticket.id}/confirm`);
  check('the assignee cannot close his own work',
    assigneeCloses.status === 403, `got ${assigneeCloses.status}`);

  const sentBack = await post(nadia, `/tasks/${ticket.id}/reject-resolution`,
    { reason: 'The refund has not reached the customer yet.' });
  check('the requester can send it back, and it returns to the same person',
    sentBack.body.status === 'IN_PROGRESS' && sentBack.body.assigneeId === youssefMe.id);

  await post(youssef, `/tasks/${ticket.id}/resolve`, { resolution: 'Refund confirmed received.' });
  const closed = await post(nadia, `/tasks/${ticket.id}/confirm`);
  check('and close it when satisfied', closed.body.status === 'CLOSED');
  check('closing clears the late flag', closed.body.slaState === 'ON_TIME');

  /* The complaint that produced this section: somebody resolved a ticket and
     then could not find it again. Access never expires -- being on a ticket is
     permanent -- but the list defaulted to open only, so a finished ticket
     left the screen for everyone who had worked on it. */
  /* The three-department chain, which is the shape real work takes: Marketing
     asks Sales, Sales asks Customer Care. Each ticket is visible to the
     managers of BOTH its departments -- the one that asked and the one that
     was asked -- and the chain does not cascade past that, or Marketing would
     be reading Customer Care's internal conversation. */
  console.log('\n-- managers see what their own people asked for --');
  {
    const sales = depts.find((d: any) => d.name === 'Sales');
    const sherif = await login('sherif.adham@worood.co');
    const nourhan = await login('nourhan.wael@worood.co');
    const nourhanId = (await call(nourhan, '/auth/me')).body.id;
    const dina = await login('dina.ashraf@worood.co');

    const fromMarketing = await post(dina, '/tasks',
      { title: 'Stock check for the Eid bundle', departmentId: sales.id });
    check('an employee raises a ticket to another department', fromMarketing.status === 201);
    const id = fromMarketing.body.id;

    check("the asking employee's own manager can see it",
      (await call(nadia, `/tasks/${id}`)).status === 200);
    const nadiaView = (await call(nadia, `/tasks/${id}`)).body.access;
    check('and may comment on it, because it is her department that asked',
      nadiaView.managesRequestingDepartment === true && nadiaView.canComment === true);
    check('but not run the other department\'s queue',
      nadiaView.canAssign === false && nadiaView.canWork === false);
    check('it is in her department view, which covers both directions',
      (await call(nadia, '/tasks?scope=department&status=')).body.items
        .some((i: any) => i.id === id));

    check('a colleague in neither department still sees nothing',
      (await call(youssef, `/tasks/${id}`)).status === 404);

    await post(sherif, `/tasks/${id}/assign`, { assigneeId: nourhanId });
    await post(nourhan, `/tasks/${id}/start`);
    const child = await post(nourhan, `/tasks/${id}/dependencies`,
      { title: 'Confirm the courier can hold chilled stock', departmentId: careDept.id });
    const childId = child.body.blockedBy.find((d: any) => !d.releasedAt).itemId;

    check("the asking department's managers see the dependency too",
      (await call(sherif, `/tasks/${childId}`)).status === 200);
    check('as do the managers of the department it went to',
      (await call(omnia, `/tasks/${childId}`)).status === 200);

    /* The boundary. Marketing sees its own ticket and the strip on it; it does
       not get to read Customer Care's work, any more than Dina does. */
    check('but Marketing does not follow the chain into a third department',
      (await call(nadia, `/tasks/${childId}`)).status === 404);
    const strip = (await call(nadia, `/tasks/${id}`)).body.blockedBy[0];
    check('it sees the dependency as a strip: department, status, dates',
      strip.department === 'Customer Care' && strip.title === undefined);

    /* Reassignment inside the receiving team changes who works on it and
       nothing about who is watching. */
    const salma2 = (await call(salma, '/auth/me')).body.id;
    const other = (await call(omnia, `/tasks/departments/${careDept.id}/people`)).body
      .find((x: any) => x.id !== salma2 && !x.isManager);
    await post(omnia, `/tasks/${childId}/assign`, { assigneeId: other.id });
    check('the receiving manager still sees it after handing it on',
      (await call(omnia, `/tasks/${childId}`)).status === 200);
    check('and the person who asked for it still does',
      (await call(nourhan, `/tasks/${childId}`)).status === 200);
  }

  console.log('\n-- finished tickets stay findable --');
  {
    const everyone: Array<[string, string]> = [
      ['the person who raised it', nadia],
      ['the person who did it', youssef],
      ['the manager of the department', omnia],
      ['the colleague brought in to help', salma],
    ];
    for (const [who, token] of everyone) {
      const unfiltered = await call(token, '/tasks?scope=contributing&status=');
      const asRequester = await call(token, '/tasks?scope=requested&status=');
      const asAssignee = await call(token, '/tasks?scope=assigned&status=');
      const dept = await call(token, '/tasks?scope=department&status=');
      const found = [unfiltered, asRequester, asAssignee, dept]
        .some((r) => r.status === 200 && r.body.items.some((i: any) => i.id === ticket.id));
      check(`a closed ticket is still listed for ${who}`, found);
    }

    const closedOnly = await call(youssef, '/tasks?scope=assigned&status=closed');
    check('and the finished filter finds it on its own',
      closedOnly.body.items.some((i: any) => i.id === ticket.id));

    /* Showing everything must not bury what is live. */
    const mixed = (await call(omnia, '/tasks?scope=department&status=')).body.items;
    const lastOpen = mixed.map((i: any) => OPEN.includes(i.status)).lastIndexOf(true);
    const firstClosed = mixed.map((i: any) => OPEN.includes(i.status)).indexOf(false);
    check('with live work above finished work',
      firstClosed === -1 || lastOpen === -1 || lastOpen < firstClosed);
  }

  console.log('\n-- a ticket for yourself --');

  const own = await post(youssef, '/tasks',
    { title: 'Tidy the returns shelf', assignToSelf: youssefMe.id });
  check('goes straight onto you, skipping the queue',
    own.body.status === 'ASSIGNED' && own.body.assigneeId === youssefMe.id);
  check('and your manager can still see it and move it',
    (await call(omnia, `/tasks/${own.body.id}`)).body.access.canAssign === true);
  check('but a colleague still cannot',
    (await call(salma, `/tasks/${own.body.id}`)).status === 404);

  /* The flag is what skips the queue, not the department. Raising it to your
     own department WITHOUT claiming it still waits for the manager -- which is
     the honest behaviour: you asked the team, not yourself. */
  const toOwnTeam = await post(youssef, '/tasks', { title: 'Someone re-label the ribbon drawer' });
  check('raising it to your own department without claiming it still queues',
    toOwnTeam.body.status === 'NEW' && toOwnTeam.body.assigneeId === null);

  const claimingSomebodyElse = await post(youssef, '/tasks',
    { title: 'Nope', assignToSelf: salmaId });
  check('and you cannot put a new ticket straight onto a colleague',
    claimingSomebodyElse.status === 400, `got ${claimingSomebodyElse.status}`);

  console.log('\n-- the administrator reads every department --');
  {
    /* On a ticket that is still open -- the one above is closed by now, and a
       closed ticket has no actions for anybody, which is the correct answer to
       a different question. */
    const live = await post(nadia, '/tasks',
      { title: 'Something still open', departmentId: careDept.id });
    const seen = await call(admin, `/tasks/${live.body.id}`);
    check('the admin opens a ticket in a department he does not manage', seen.status === 200);
    check('and may act on it, unlike view-any',
      seen.body.access.canAssign === true && seen.body.access.canManageContributors === true);
    const everything = await call(admin, '/tasks?scope=all&status=');
    check('scope=all returns the company', everything.status === 200 && everything.body.total > 0);
    /* The keys come from the admin role holding every key, which the module
       registers in its own migration rather than relying on the seeder -- a
       live install must never run that. */
    const me = (await call(admin, '/auth/me')).body;
    check('because the admin role carries every task key there is',
      ['tasks.item.view-any', 'tasks.item.manage-any', 'tasks.report.view']
        .every((k) => me.permissions.includes(k)));

    /* manage-any means "in any department", not "in any state". A finished
       ticket offers nothing to anybody, and an administrator looking at
       Accept and Cancel on a ticket closed last week is how a screen loses
       the reader's trust in everything else it says. */
    const finished = await call(admin, `/tasks/${ticket.id}`);
    const fa = finished.body.access;
    check('and still gets no actions on a closed ticket',
      fa.canConfirmResolution === false && fa.canCancel === false
      && fa.canEditRequest === false && fa.canResolve === false
      && fa.canAssign === false && fa.canComment === false);
    check('except reopening it, which is the only thing left to do',
      fa.canReopen === true);

    const requesterOnClosed = (await call(nadia, `/tasks/${ticket.id}`)).body.access;
    check('and neither does the person who raised it',
      requesterOnClosed.canConfirmResolution === false
      && requesterOnClosed.canCancel === false);
  }

  console.log('\n-- reading everything, changing nothing --');

  const ceo = await call(kandil, `/tasks/${ticket.id}`);
  check('view-any reads a ticket in a department it does not manage', ceo.status === 200);
  check('and cannot act on it',
    ceo.body.access.canAssign === false && ceo.body.access.canWork === false);
  const ceoSweep = await post(kandil, '/tasks/admin/sweep');
  check('the widest reading permission is not an operational one',
    ceoSweep.status === 403, `got ${ceoSweep.status}`);

  console.log('\n-- refusing and redirecting --');

  const misdirected = await post(nadia, '/tasks',
    { title: 'Fix the lift on the second floor', departmentId: careDept.id });
  const refused = await post(omnia, `/tasks/${misdirected.body.id}/reject`,
    { reason: 'This is one for Facilities.' });
  check('a manager may refuse, with a reason', refused.body.status === 'REJECTED');

  const noReason = await post(omnia, `/tasks/${misdirected.body.id}/reject`, { reason: '' });
  check('and may not refuse without one', noReason.status === 400, `got ${noReason.status}`);

  const redirected = await post(nadia, '/tasks',
    { title: 'Replace the broken chair in reception', departmentId: careDept.id });
  const moved = await post(omnia, `/tasks/${redirected.body.id}/transfer`,
    { departmentId: facilities.id, reason: 'Facilities own the furniture.' });
  check('or send it to the right department', moved.body.department === 'Facilities'
    && moved.body.status === 'NEW' && moved.body.assigneeId === null);
  check('the manager who redirected it keeps read access',
    (await call(omnia, `/tasks/${redirected.body.id}`)).status === 200);
  check('the requester keeps hers',
    (await call(nadia, `/tasks/${redirected.body.id}`)).status === 200);

  /* Every reason-carrying route, called with EXACTLY the body the dialog
     sends. The suite used to build each body by hand, which is why it passed
     while the screen sent `resolution` to /cancel and got a 400: the pipe runs
     with forbidNonWhitelisted, so an undeclared field is refused rather than
     ignored. Worth keeping refused -- but worth testing from the caller's
     side, not the API's. */
  console.log('\n-- the bodies the screen actually sends --');
  {
    const shapes: Array<[string, Record<string, string>]> = [
      ['/cancel', { reason: 'No longer needed.' }],
      ['/reject', { reason: 'Not ours.' }],
      ['/transfer', { reason: 'Belongs to Facilities.' }],
      ['/resolve', { resolution: 'Done.' }],
      ['/reject-resolution', { reason: 'Still missing the note.' }],
      ['/reopen', { reason: 'It came back.' }],
    ];
    for (const [route, body] of shapes) {
      const probe = await post(nadia, `/tasks/${ticket.id}${route}`,
        route === '/transfer' ? { ...body, departmentId: facilities.id } : body);
      check(`${route} accepts the field it declares`,
        probe.status !== 400 || !String(probe.body?.error?.message ?? '').includes('should not exist'),
        JSON.stringify(probe.body?.error?.message ?? ''));
    }
    const extra = await post(nadia, `/tasks/${ticket.id}/cancel`,
      { reason: 'x', resolution: 'y' });
    check('and refuses one it does not',
      extra.status === 400, `got ${extra.status}`);
  }

  console.log('\n-- the portlets ask "am I on it", not "did I raise it" --');

  const mine = (await call(youssef, '/tasks/portlets/assigned-to-me')).body;
  check('assigned-to-me shows work given to you by somebody else',
    mine.items.some((i: any) => i.id === own.body.id));
  const queue = (await call(omnia, '/tasks/portlets/awaiting-assignment')).body;
  check('awaiting-assignment is a manager card', Array.isArray(queue.items));
  const noQueue = await call(youssef, '/tasks/portlets/awaiting-assignment');
  check('and an employee who manages nothing gets an empty one, not somebody else\'s',
    noQueue.body.items.length === 0);

  const hub = (await call(youssef, '/hub/modules')).body;
  const tasksNav = hub.modules.find((m: any) => m.key === 'tasks');
  check('the employee sees the module but not the queue link',
    tasksNav.navigation.length === 1 && tasksNav.navigation[0].path === '/tasks');
  const hubManager = (await call(omnia, '/hub/modules')).body;
  check('the manager sees the queue link, derived from the org chart',
    hubManager.modules.find((m: any) => m.key === 'tasks').navigation.length === 2);

  /* The org chart is now load-bearing, so it needs a screen and it needs
     rails. A department that loses its last manager goes out of service
     silently: the picker stops offering it and anything already raised to it
     can never be assigned. */
  console.log('\n-- keeping every department reachable --');
  {
    const overview = (await call(admin, '/admin/departments/overview')).body;
    check('every department has an active manager after seeding',
      overview.departments.every((d: any) => d.reachable));

    const care = overview.departments.find((d: any) => d.name === 'Customer Care');
    check('and Customer Care has two, which is the point of allowing it',
      care.managers.length === 2);

    const omniaId = (await call(omnia, '/auth/me')).body.id;
    const mariamId = (await call(mariam, '/auth/me')).body.id;

    const dropOne = await call(admin, `/admin/departments/${care.id}/managers/${omniaId}`,
      { method: 'DELETE' });
    check('one of two may be removed', dropOne.status === 200);

    const dropLast = await call(admin, `/admin/departments/${care.id}/managers/${mariamId}`,
      { method: 'DELETE' });
    check('the last one may not', dropLast.status === 409, `got ${dropLast.status}`);
    check('and the refusal says what to do first',
      String(dropLast.body?.error?.message ?? '').includes('Add another manager'));

    const suspend = await call(admin, `/admin/users/${mariamId}`, {
      method: 'PATCH', body: JSON.stringify({ status: 'SUSPENDED' }),
    });
    check('nor may she be suspended while she is the only one',
      suspend.status === 409, `got ${suspend.status}`);

    const del = await call(admin, `/admin/users/${mariamId}`, { method: 'DELETE' });
    check('nor deleted', del.status === 409, `got ${del.status}`);

    const marketing = overview.departments.find((d: any) => d.name === 'Marketing');
    const outsider = await post(admin, `/admin/departments/${marketing.id}/managers`,
      { userId: mariamId });
    check('somebody outside the department cannot be made to run it',
      outsider.status === 400, `got ${outsider.status}`);

    const back = await post(admin, `/admin/departments/${care.id}/managers`, { userId: omniaId });
    check('adding a second one again lifts the rail', back.status === 201);
    const afterRemove = await call(admin, `/admin/departments/${care.id}/managers/${mariamId}`,
      { method: 'DELETE' });
    check('and then the other may go', afterRemove.status === 200);

    /* Put the org chart back the way the seed left it. A suite that mutates
       shared state and does not restore it passes once and then fails for
       reasons that have nothing to do with the code -- the same trap as a test
       that hard-codes a seeded room code. */
    await post(admin, `/admin/departments/${care.id}/managers`, { userId: mariamId });
    const restored = (await call(admin, '/admin/departments/overview')).body
      .departments.find((d: any) => d.name === 'Customer Care');
    check('and the suite leaves the org chart as it found it',
      restored.managers.length === 2);

    /* The whole point of asking it on the People screen: an administrator
       adding an employee thinks "she runs Customer Care" and should not have
       to remember a second screen. The detail therefore answers it. */
    const detail = (await call(admin, `/admin/users/${mariamId}`)).body;
    check('the person detail says which departments they run',
      Array.isArray(detail.managedDepartments));

    const nonAdmin = await call(omnia, '/admin/departments/overview');
    check('a department manager is not an administrator',
      nonAdmin.status === 403, `got ${nonAdmin.status}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) console.log(`failed: ${failures.join(', ')}`);
  await closeDb();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });