/** Who sees the Approvals tab. */
import { resolveForPrincipal } from '../src/core/hub-registry';
/* Both are imported so the registry holds more than one module: the point of
   the last assertion is that extending the filter did not change how an
   ungated entry behaves anywhere else. */
import '../src/modules/finance/finance.module';
import '../src/modules/meeting-rooms/meeting-rooms.module';

let pass=0, fail=0;
const ok=(n:string,c:boolean,d='')=>{c?(pass++,console.log('  ok    '+n)):(fail++,console.log('  FAIL  '+n+' '+d));};

const nav = (perms: string[], managesDept: boolean) => {
  const r = resolveForPrincipal(perms, managesDept);
  const fin = r.modules.find((m: any) => m.key === 'finance');
  return (fin?.navigation ?? []).map((n: any) => n.path);
};

console.log('\nThe Approvals tab');
ok('an ordinary employee does not see it',
   !nav([], false).includes('/finance/approvals'), JSON.stringify(nav([], false)));
ok('a department manager does — authority that is a row, not a permission',
   nav([], true).includes('/finance/approvals'));
ok('Finance does', nav(['finance.request.manage'], false).includes('/finance/approvals'));
ok('Purchases does', nav(['finance.purchases.decide'], false).includes('/finance/approvals'));
ok('read-only Top Management does not — it decides nothing',
   !nav(['finance.report.view'], false).includes('/finance/approvals'));

console.log('\nThe rest of the tabs are unaffected');
ok('everybody can raise a request', nav([], false).includes('/finance/new'));
ok('and see their own', nav([], false).includes('/finance'));
ok('an employee does not see All Requests',
   !nav([], false).includes('/finance/all'));
/* Changed deliberately: a manager had no way to see his department's
   requests, so a change asked for on one reached him only as a bell. The page
   filters by the same visibility rule either way -- his department for him,
   everything for Finance. */
ok('a department manager sees it too, for his own department',
   nav([], true).includes('/finance/all'));
ok('Top Management does', nav(['finance.report.view'], false).includes('/finance/all'));

console.log('\nOther modules still filter as before');
const roomsFor = (perms: string[]) => {
  const r = resolveForPrincipal(perms, false);
  return (r.modules.find((m: any) => m.key === 'meeting-rooms')?.navigation ?? []).length;
};
ok('ungated entries still show for everyone', roomsFor([]) > 0);

console.log(`\n${pass+fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);