/**
 * End-to-end verification of the administration console.
 *
 *   npm run migrate && npm run seed -- --reset
 *   npm run build && node dist/main.js     (in one shell)
 *   npx tsx test/administration.test.ts    (in another)
 *
 * The assertions that matter most here are the ones nobody wants to discover
 * in production: that a non-administrator cannot reach any of it, that changing
 * a password or an e-mail actually ends the old sessions rather than only
 * appearing to, and that an administrator cannot strip the last way into the
 * console. Each is proven by doing it -- signing in with the old credentials
 * afterwards and watching it fail.
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

const rawLogin = (email: string, password: string) =>
  fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

async function login(email: string, password = 'Worood@2026'): Promise<string> {
  const res = await rawLogin(email, password);
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

const TEST_EMAIL = 'zzz.console.test@worood.co';
const MOVED_EMAIL = 'zzz.console.moved@worood.co';
const STRONG = 'a-long-enough-password';

async function cleanup() {
  /* The audit trail holds a foreign key to the actor, which is the whole point
     of it -- so the test's own audit rows go first. Production never does this;
     accounts there are soft-deleted precisely so history keeps its names. */
  const rows = await query<{ id: string }>(
    `SELECT id FROM core_users WHERE email IN ($1,$2)`, [TEST_EMAIL, MOVED_EMAIL]);
  for (const { id } of rows) {
    await query(`DELETE FROM core_audit_logs WHERE actor_id = $1 OR entity_id = $1::text`, [id]);
  }
  await query(`DELETE FROM core_users WHERE email IN ($1,$2)`, [TEST_EMAIL, MOVED_EMAIL]);
  await query(`DELETE FROM core_roles WHERE key IN ('zzz-test-role','zzz-renamed-role')`);
}

async function run() {
  await cleanup();

  const admin = await login('Admin@worood.co');          // core.user.manage + core.role.manage
  const yousry = await login('Yousry@worood.co');          // no core permissions at all

  console.log('\nadministration — who may open it');

  for (const [path, verb] of [['/admin/users', 'GET'], ['/admin/roles', 'GET'], ['/admin/permissions', 'GET']] as const) {
    const denied = await call(yousry, path, { method: verb });
    check(`a non-administrator is refused ${verb} ${path}`, denied.status === 403, `got ${denied.status}`);
  }
  const deniedWrite = await call(yousry, '/admin/users', {
    method: 'POST', body: JSON.stringify({ email: 'x@worood.co', fullName: 'X', password: STRONG }),
  });
  check('...and cannot create an account', deniedWrite.status === 403);

  const list = await call(admin, '/admin/users');
  check('an administrator sees every account',
    list.status === 200 && list.body.users.length >= 6, String(list.body?.users?.length));
  check('each row says whether that account can administer',
    list.body.users.some((u: any) => u.isAdministrator === true)
    && list.body.users.some((u: any) => u.isAdministrator === false));

  const roles = await call(admin, '/admin/roles');
  const roleByKey = (k: string) => roles.body.roles.find((r: any) => r.key === k);
  check('roles come back with holder counts', roleByKey('finance')?.holders >= 1);
  check('...and which role opens the console is computed, not guessed',
    roleByKey('admin')?.grantsConsole === true && roleByKey('employee')?.grantsConsole === false);

  console.log('\nadministration — creating a person');

  const tooShort = await call(admin, '/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email: TEST_EMAIL, fullName: 'Console Test', password: 'short' }),
  });
  check('a weak password is refused', tooShort.status === 400);

  const created = await call(admin, '/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      email: TEST_EMAIL, fullName: 'Console Test', fullNameAr: 'اختبار',
      jobTitle: 'Analyst', password: STRONG, roleIds: [roleByKey('employee').id],
    }),
  });
  check('an administrator can create an account', created.status === 201 || created.status === 200,
    JSON.stringify(created.body).slice(0, 200));
  const userId = created.body.id;

  const canSignIn = await rawLogin(TEST_EMAIL, STRONG);
  check('the new account can sign in immediately', canSignIn.status === 200 || canSignIn.status === 201);

  const duplicate = await call(admin, '/admin/users', {
    method: 'POST', body: JSON.stringify({ email: TEST_EMAIL, fullName: 'Twin', password: STRONG }),
  });
  check('a duplicate e-mail is refused', duplicate.status === 409);
  check('...by name, so the message is usable', /already has an account/.test(duplicate.body?.error?.message ?? ''));

  console.log('\nadministration — name, e-mail and roles');

  const renamed = await call(admin, `/admin/users/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({ fullName: 'Console Tester', jobTitle: 'Senior Analyst',
                           roleIds: [roleByKey('marketing').id] }),
  });
  check('name and job title change', renamed.body?.fullName === 'Console Tester');
  check('roles are replaced, not added to',
    renamed.body?.roles.length === 1 && renamed.body.roles[0].key === 'marketing',
    JSON.stringify(renamed.body?.roles));
  check('effective permissions are computed from the new roles',
    renamed.body?.permissions.some((p: any) => p.key === 'sales.dashboard.view'));
  check('...and say which role supplied each one',
    renamed.body?.permissions.every((p: any) => p.viaRoles.length > 0));

  /* An e-mail change is an identity change, so the old sessions must not
     survive it. Proven by using the old address afterwards. */
  const sessionBefore = await rawLogin(TEST_EMAIL, STRONG).then((r) => r.json());
  const emailChanged = await call(admin, `/admin/users/${userId}`, {
    method: 'PATCH', body: JSON.stringify({ email: MOVED_EMAIL }),
  });
  check('the e-mail address changes', emailChanged.body?.email === MOVED_EMAIL);
  check('the old address no longer signs in', (await rawLogin(TEST_EMAIL, STRONG)).status === 401);
  check('the new one does', (await rawLogin(MOVED_EMAIL, STRONG)).status < 300);

  const oldRefresh = await fetch(`${BASE}/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: sessionBefore.refreshToken }),
  });
  check('and the session open under the old address cannot be refreshed',
    oldRefresh.status === 401, `got ${oldRefresh.status}`);

  console.log('\nadministration — passwords');

  const liveSession = await rawLogin(MOVED_EMAIL, STRONG).then((r) => r.json());
  const NEW_PASSWORD = 'another-long-password';
  const pwChanged = await call(admin, `/admin/users/${userId}/password`, {
    method: 'POST', body: JSON.stringify({ password: NEW_PASSWORD }),
  });
  check('an administrator can set a password', pwChanged.status === 200 || pwChanged.status === 201);
  check('the new password works', (await rawLogin(MOVED_EMAIL, NEW_PASSWORD)).status < 300);
  check('the old one does not', (await rawLogin(MOVED_EMAIL, STRONG)).status === 401);

  const staleRefresh = await fetch(`${BASE}/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: liveSession.refreshToken }),
  });
  check('sessions open at the time are ended, not left to expire',
    staleRefresh.status === 401, `got ${staleRefresh.status}`);

  const auditedPassword = await one(
    `SELECT payload::text FROM core_audit_logs
      WHERE action = 'core.user.password_set' AND entity_id = $1
      ORDER BY created_at DESC LIMIT 1`, [userId]);
  check('the password change is audited', !!auditedPassword);
  check('...without the password or its digest in the payload',
    !!auditedPassword && !/\$2[aby]\$|another-long-password/.test(auditedPassword.payload),
    auditedPassword?.payload);

  console.log('\nadministration — assigning dashboards');

  /* Which dashboards a role carries is seeded data and will change as the
     company's roles do, so the two the assertions need are *found* rather than
     named: one this person already reaches through their role, and one they do
     not. Hard-coding keys here would make this test a hostage to the seed. */
  const beforeAssign = await call(admin, `/admin/users/${userId}`);
  const exec = beforeAssign.body.dashboards.find((d: any) => d.viaRole === true);
  const finance = beforeAssign.body.dashboards.find((d: any) => d.viaRole === false);
  check('their role carries at least one dashboard, and not all of them',
    !!exec && !!finance,
    JSON.stringify(beforeAssign.body.dashboards.map((d: any) => [d.key, d.viaRole])));
  check('a dashboard reached through a role is reported as such',
    exec?.viaRole === true && exec?.effective === true, JSON.stringify(exec));

  const assigned = await call(admin, `/admin/users/${userId}/dashboards`, {
    method: 'PUT',
    body: JSON.stringify({ assignments: [
      { dashboardId: finance.id, effect: 'GRANT' },   // one their role does not give them
      { dashboardId: exec.id, effect: 'REVOKE' },     // one it does
    ] }),
  });
  const fin = assigned.body.dashboards.find((d: any) => d.id === finance.id);
  const ex = assigned.body.dashboards.find((d: any) => d.id === exec.id);
  check('an individual grant adds a dashboard their role does not carry',
    fin?.override === 'GRANT' && fin?.effective === true);
  check('an individual revoke beats a role grant',
    ex?.override === 'REVOKE' && ex?.viaRole === true && ex?.effective === false,
    JSON.stringify(ex));

  /* The console's arithmetic must agree with what the sales module actually
     serves that person -- two implementations of one rule is how they drift. */
  const asUser = await login(MOVED_EMAIL, NEW_PASSWORD);
  const theirs = await call(asUser, '/sales/dashboards');
  // The endpoint returns a bare array. Asserting `!keys.includes(...)` against
  // an empty list would pass for the wrong reason, so the list is checked to be
  // non-empty first -- otherwise this test proves nothing on the day it breaks.
  const mine = Array.isArray(theirs.body) ? theirs.body : theirs.body?.dashboards ?? [];
  const keys = mine.map((d: any) => d.key);
  check('the module actually serves them dashboards', keys.length > 0, JSON.stringify(theirs.body).slice(0, 160));
  check('the sales module agrees: the granted one is there',
    keys.includes(finance.key), `${finance.key} not in ${keys.join(',')}`);
  check('...and the revoked one is not',
    keys.length > 0 && !keys.includes(exec.key), `${exec.key} still in ${keys.join(',')}`);

  const unassigned = await call(admin, `/admin/users/${userId}/dashboards`, {
    method: 'PUT', body: JSON.stringify({ assignments: [] }),
  });
  const finAfter = unassigned.body.dashboards.find((d: any) => d.id === finance.id);
  const exAfter = unassigned.body.dashboards.find((d: any) => d.id === exec.id);
  check('unassigning clears the override and role access returns',
    finAfter?.override === null && finAfter?.effective === false
    && exAfter?.override === null && exAfter?.effective === true);

  console.log('\nadministration — the lockout rails');

  const adminUser = list.body.users.find((u: any) => u.email === 'Admin@worood.co');

  const suspendSelf = await call(admin, `/admin/users/${adminUser.id}`, {
    method: 'PATCH', body: JSON.stringify({ status: 'SUSPENDED' }),
  });
  check('an administrator cannot suspend their own account', suspendSelf.status === 400,
    suspendSelf.body?.error?.message);

  const deleteSelf = await call(admin, `/admin/users/${adminUser.id}`, { method: 'DELETE' });
  check('...nor delete it', deleteSelf.status === 400);

  const stripSelf = await call(admin, `/admin/users/${adminUser.id}`, {
    method: 'PATCH', body: JSON.stringify({ roleIds: [roleByKey('employee').id] }),
  });
  check('...nor demote themselves while they are the only administrator',
    stripSelf.status === 409, `got ${stripSelf.status}: ${stripSelf.body?.error?.message}`);
  check('...with a message that says what to do first',
    /another active account/.test(stripSelf.body?.error?.message ?? ''),
    stripSelf.body?.error?.message);

  const stripRole = await call(admin, `/admin/roles/${roleByKey('admin').id}/permissions`, {
    method: 'PUT', body: JSON.stringify({ permissionKeys: ['sales.dashboard.view'] }),
  });
  check('the console permission cannot be taken off the only role that has it',
    stripRole.status === 409, `got ${stripRole.status}`);

  /* With a second administrator in place, the same operations become legal --
     which is what proves the rails are counting, not refusing categorically. */
  await call(admin, `/admin/users/${userId}`, {
    method: 'PATCH', body: JSON.stringify({ roleIds: [roleByKey('admin').id] }),
  });
  const nowAllowed = await call(admin, `/admin/users/${adminUser.id}`, {
    method: 'PATCH', body: JSON.stringify({ roleIds: [roleByKey('employee').id] }),
  });
  check('with a second administrator, demoting the first is allowed',
    nowAllowed.status === 200, `got ${nowAllowed.status}: ${nowAllowed.body?.error?.message}`);

  // Put the seeded administrator back before anything else runs.
  await call(admin, `/admin/users/${adminUser.id}`, {
    method: 'PATCH', body: JSON.stringify({ roleIds: [roleByKey('admin').id] }),
  }).catch(() => undefined);
  await query(
    `INSERT INTO core_user_roles (user_id, role_id)
     SELECT $1, id FROM core_roles WHERE key = 'admin' ON CONFLICT DO NOTHING`, [adminUser.id]);
  await query(`DELETE FROM core_user_roles WHERE user_id = $1 AND role_id =
                 (SELECT id FROM core_roles WHERE key = 'employee')`, [adminUser.id]);

  console.log('\nadministration — roles');

  const adminAgain = await login('Admin@worood.co');

  const newRole = await call(adminAgain, '/admin/roles', {
    method: 'POST',
    body: JSON.stringify({
      key: 'zzz-test-role', name: 'Test Role', description: 'Created by the test suite',
      permissionKeys: ['sales.dashboard.view', 'meeting-rooms.room.manage'],
    }),
  });
  check('a role can be created with its permissions', newRole.status === 201 || newRole.status === 200,
    JSON.stringify(newRole.body).slice(0, 200));
  check('...and reports them back', newRole.body?.permissions?.length === 2);

  const badKey = await call(adminAgain, '/admin/roles', {
    method: 'POST', body: JSON.stringify({ key: 'Not A Key', name: 'Bad' }),
  });
  check('a role key that is not a slug is refused', badKey.status === 400);

  const unknownPerm = await call(adminAgain, `/admin/roles/${newRole.body.id}/permissions`, {
    method: 'PUT', body: JSON.stringify({ permissionKeys: ['sales.dashboard.view', 'not.a.permission'] }),
  });
  check('an unknown permission key is refused by name', unknownPerm.status === 400
    && /not\.a\.permission/.test(unknownPerm.body?.error?.message ?? ''),
    unknownPerm.body?.error?.message);

  await call(adminAgain, `/admin/users/${userId}`, {
    method: 'PATCH', body: JSON.stringify({ roleIds: [newRole.body.id] }),
  });
  const heldRole = await call(adminAgain, `/admin/roles/${newRole.body.id}`);
  check('a role counts its holders', heldRole.body?.holders === 1, String(heldRole.body?.holders));

  const deleteHeld = await call(adminAgain, `/admin/roles/${newRole.body.id}`, { method: 'DELETE' });
  check('a role in use is not deleted out from under its holders', deleteHeld.status === 409);
  check('...and the message says how many hold it',
    /held by 1 person/.test(deleteHeld.body?.error?.message ?? ''), deleteHeld.body?.error?.message);

  await call(adminAgain, `/admin/users/${userId}`, {
    method: 'PATCH', body: JSON.stringify({ roleIds: [] }),
  });
  const deleteFree = await call(adminAgain, `/admin/roles/${newRole.body.id}`, { method: 'DELETE' });
  check('once nobody holds it, the role is deleted', deleteFree.status === 200);

  console.log('\nadministration — suspending and deleting');

  const suspended = await call(adminAgain, `/admin/users/${userId}`, {
    method: 'PATCH', body: JSON.stringify({ status: 'SUSPENDED' }),
  });
  check('an account can be suspended', suspended.body?.status === 'SUSPENDED');
  check('a suspended account cannot sign in',
    (await rawLogin(MOVED_EMAIL, NEW_PASSWORD)).status === 401);

  const restored = await call(adminAgain, `/admin/users/${userId}`, {
    method: 'PATCH', body: JSON.stringify({ status: 'ACTIVE' }),
  });
  check('and can be restored', restored.body?.status === 'ACTIVE'
    && (await rawLogin(MOVED_EMAIL, NEW_PASSWORD)).status < 300);

  const removed = await call(adminAgain, `/admin/users/${userId}`, { method: 'DELETE' });
  check('an account can be deleted', removed.status === 200);
  const gone = await call(adminAgain, '/admin/users?status=ALL');
  check('...and leaves the directory', !gone.body.users.some((u: any) => u.id === userId));
  const stillThere = await one(`SELECT deleted_at FROM core_users WHERE id = $1`, [userId]);
  check('...but the row survives, so history still resolves to a name',
    !!stillThere?.deleted_at);

  const auditRows = await query(
    `SELECT action FROM core_audit_logs WHERE entity_id = $1 ORDER BY created_at`, [userId]);
  const actions = auditRows.map((r) => r.action);
  check('every change is on the audit trail',
    ['core.user.created', 'core.user.updated', 'core.user.password_set',
     'core.user.dashboards_changed', 'core.user.deleted'].every((a) => actions.includes(a)),
    actions.join(', '));

  await cleanup();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await closeDb();
  if (fail) { console.error('  failed:', failures.join(', ')); process.exit(1); }
}

run().catch(async (e) => { console.error(e); await cleanup().catch(() => undefined); await closeDb(); process.exit(1); });
