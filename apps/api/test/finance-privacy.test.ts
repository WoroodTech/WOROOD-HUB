/**
 * Who may see money.
 *
 *   npx tsx test/finance-privacy.test.ts
 *
 * The rule, from the legacy app: Office, Workshop and Warehouse never see an
 * amount, a vendor or transfer details — anywhere. The legacy app enforces it
 * function by function and three of them forget, which is why it is one
 * projection here.
 *
 * No database: these are the rules themselves.
 */
import { lensFor, project, moneyPhrase } from '../src/modules/finance/projection';

let pass = 0, fail = 0;
const failures: string[] = [];
const ok = (n: string, c: boolean, d = '') => {
  c ? (pass++, console.log('  ok    ' + n))
    : (fail++, failures.push(n), console.log('  FAIL  ' + n + ' ' + d));
};
const eq = (n: string, a: any, b: any) =>
  ok(n, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
const section = (t: string) => console.log('\n' + t);

const person = (perms: string[] = [], manages: string[] = []) =>
  ({ id: 'u1', permissions: perms, managedDepartmentIds: manages }) as any;

const EMPLOYEE = person();
const MANAGER = person([], ['dept-a']);
const FINANCE = person(['finance.request.manage']);
const PURCH = person(['finance.purchases.decide']);
const TOPMGMT = person(['finance.report.view']);

const facts = (o: Partial<any> = {}) => ({
  own: false, managesDepartment: false, requestingDepartmentIsLite: false, ...o,
});

const row = () => ({
  id: 'r1', reference: 'MKT-abc1234', description: 'Photoshoot',
  requestedAmount: 5000,
  paymentMethod: 'Bank Account Number', paymentDetails: 'Banque Misr - 100 | Beneficiary: A',
  bankName: 'Banque Misr', accountNumber: '100012345678', beneficiaryName: 'Ahmed',
  vendorName: 'Studio Nile',
});

function main() {
  section('A lite department never sees money — not even its own request');
  {
    const lens = lensFor(EMPLOYEE, facts({ own: true, requestingDepartmentIsLite: true }));
    ok('no amount', !lens.money);
    ok('no transfer details', !lens.transferDetails);
    ok('no supplier', !lens.vendor);

    const out: any = project(row(), lens);
    eq('the amount is gone from the row', out.requestedAmount, undefined);
    eq('and the account number', out.accountNumber, undefined);
    eq('and the supplier', out.vendorName, undefined);
    /* Removed rather than blanked: a null amount already means "Purchases has
       not priced this yet", and reusing it would make the two
       indistinguishable to whatever draws the page. */
    ok('and the row says which fields were taken away',
       out.hidden.includes('requestedAmount') && out.hidden.includes('accountNumber'));
    eq('while what it may see is untouched', out.description, 'Photoshoot');
  }

  section('…including its own manager');
  {
    const lens = lensFor(MANAGER,
      facts({ managesDepartment: true, requestingDepartmentIsLite: true }));
    ok('a lite department manager sees no amount either', !lens.money);
  }

  section('An ordinary department');
  {
    const own = lensFor(EMPLOYEE, facts({ own: true }));
    ok('your own request shows you everything', own.money && own.transferDetails);

    const colleague = lensFor(EMPLOYEE, facts());
    ok("a colleague's amount is visible", colleague.money);
    /* Where the money was sent is the requester's business and Finance's. */
    ok('but not where the money goes', !colleague.transferDetails);

    const mgr = lensFor(MANAGER, facts({ managesDepartment: true }));
    ok('a manager sees the figure he is approving', mgr.money);
    ok('and the supplier', mgr.vendor);
    ok('but still not the account number', !mgr.transferDetails);
  }

  section('The people who price, pay and report');
  {
    for (const [who, p] of [['Finance', FINANCE], ['Purchases', PURCH],
                            ['Top Management', TOPMGMT]] as const) {
      const lens = lensFor(p, facts());
      ok(`${who} sees everything`, lens.money && lens.transferDetails && lens.vendor);
      const lite = lensFor(p, facts({ requestingDepartmentIsLite: true }));
      ok(`${who} sees a lite department's figures too — somebody has to`,
         lite.money && lite.transferDetails);
    }
  }

  section('Nothing is hidden that was not asked to be');
  {
    const lens = lensFor(FINANCE, facts());
    const out: any = project(row(), lens);
    eq('a full lens removes nothing', out.hidden, []);
    eq('the amount survives', out.requestedAmount, 5000);
    eq('and the account number', out.accountNumber, '100012345678');
  }

  section('Figures built into messages follow the same rule');
  {
    /* This is where the legacy app leaks: the rejection email carries the
       amount and the receipt email carries three figures, assembled far from
       the list that was careful. */
    const lite = lensFor(EMPLOYEE, facts({ own: true, requestingDepartmentIsLite: true }));
    eq('a lite reader is given no figure to put in a sentence',
       moneyPhrase(5000, lite), '');
    const normal = lensFor(EMPLOYEE, facts({ own: true }));
    eq('an ordinary one is', moneyPhrase(5000, normal), '5000.00');
    eq('and an unpriced request has none to give', moneyPhrase(null, normal), '');
  }

  section('A row that carries only some of the fields');
  {
    const lens = lensFor(EMPLOYEE, facts({ requestingDepartmentIsLite: true }));
    const out: any = project({ id: 'x', description: 'y' }, lens);
    eq('loses nothing it did not have', out.hidden, []);
    eq('and keeps what it did', out.description, 'y');
  }

  console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nfailures:'); failures.forEach((f) => console.log('  ' + f)); }
  process.exit(fail ? 1 : 0);
}
main();