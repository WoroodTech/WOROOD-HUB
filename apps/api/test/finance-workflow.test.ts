/**
 * The approval chain, as Finance described it.
 *
 *   npx tsx test/finance-workflow.test.ts
 *
 * No database: these are the rules themselves, which is what makes them worth
 * testing on their own. If the chain is wrong here, everything built on it is
 * wrong in a way that is much harder to see.
 */
import {
  canDecide, canDelete, canEditDirectly, firstState, isOpen, labelFor,
  nextState, stepOf, type ApprovalState, type PaymentState,
} from '../src/modules/finance/workflow';

let pass = 0, fail = 0;
const failures: string[] = [];
const ok = (n: string, c: boolean, d = '') => {
  c ? (pass++, console.log('  ok    ' + n))
    : (fail++, failures.push(n), console.log('  FAIL  ' + n + ' ' + d));
};
const eq = (n: string, a: any, b: any) =>
  ok(n, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
const section = (t: string) => console.log('\n' + t);

const MKT = 'dept-marketing', OFC = 'dept-office';
const person = (id: string, perms: string[] = [], manages: string[] = []) =>
  ({ id, permissions: perms, managedDepartmentIds: manages }) as any;

const SAMI = person('sami');                                 // ordinary employee
const MONA = person('mona', [], [MKT]);                      // marketing manager
const PURCH = person('purch', ['finance.purchases.decide']);
const FIN = person('fin', ['finance.request.manage', 'finance.payment.record']);

const req = (over: Partial<any> = {}) => ({
  requesterId: 'sami', departmentId: MKT, route: 'finance' as const,
  approvalState: 'FINANCE_PENDING' as ApprovalState,
  paymentState: 'UNPAID' as PaymentState, ...over,
});

function main() {
  section('What a request is called');
  eq('going through the chain, it is Open', labelFor('MANAGER_PENDING', 'UNPAID'), 'Open');
  eq('and still Open at the finance step', labelFor('FINANCE_PENDING', 'UNPAID'), 'Open');
  eq('approved with nothing paid is In Progress', labelFor('APPROVED', 'UNPAID'), 'In Progress');
  eq('some money paid is Partial Pay', labelFor('APPROVED', 'PARTIAL'), 'Partial Pay');
  eq('paid in full is Complete', labelFor('APPROVED', 'PAID'), 'Complete');
  eq('rejected says so', labelFor('REJECTED', 'UNPAID'), 'Rejected');
  /* The pair is what makes this possible: a rejected request cannot read as
     Open the way it could when one column held both facts. */
  eq('a rejection is not hidden by payment state', labelFor('REJECTED', 'PARTIAL'), 'Rejected');

  section('Where a submitted request goes first');
  eq('an ordinary member starts with the manager',
     firstState({ requesterId: 'sami', route: 'finance' }, ['mona']), 'MANAGER_PENDING');
  eq('the manager\'s own request skips his own step',
     firstState({ requesterId: 'mona', route: 'finance' }, ['mona']), 'FINANCE_PENDING');
  eq('a department with no manager goes straight on',
     firstState({ requesterId: 'sami', route: 'finance' }, []), 'FINANCE_PENDING');
  eq('a purchases-routed request with no manager goes to Purchases',
     firstState({ requesterId: 'sami', route: 'purchases' }, []), 'PURCHASES_PENDING');
  eq('and with a manager, to the manager first',
     firstState({ requesterId: 'sami', route: 'purchases' }, ['mona']), 'MANAGER_PENDING');

  section('The chain, step by step');
  eq('manager approval sends a finance request to Finance',
     nextState('MANAGER_PENDING', 'finance'), 'FINANCE_PENDING');
  eq('manager approval sends a purchases request to Purchases',
     nextState('MANAGER_PENDING', 'purchases'), 'PURCHASES_PENDING');
  eq('Purchases always hands on to Finance',
     nextState('PURCHASES_PENDING', 'purchases'), 'FINANCE_PENDING');
  eq('Finance approval is the end of the chain',
     nextState('FINANCE_PENDING', 'finance'), 'APPROVED');
  eq('an approved request goes nowhere further',
     nextState('APPROVED', 'finance'), 'APPROVED');

  section('A whole journey: Office asks, three people decide');
  {
    let state = firstState({ requesterId: 'sami', route: 'purchases' }, ['mona']);
    eq('1. with the manager', state, 'MANAGER_PENDING');
    state = nextState(state, 'purchases');
    eq('2. with Purchases', state, 'PURCHASES_PENDING');
    state = nextState(state, 'purchases');
    eq('3. with Finance', state, 'FINANCE_PENDING');
    state = nextState(state, 'purchases');
    eq('4. approved', state, 'APPROVED');
    eq('which the requester sees as In Progress', labelFor(state, 'UNPAID'), 'In Progress');
  }

  section('Who may decide, and who may not');
  ok('the department manager may decide at the manager step',
     canDecide(MONA, req({ approvalState: 'MANAGER_PENDING' })));
  ok('a colleague may not', !canDecide(SAMI, req({ approvalState: 'MANAGER_PENDING' })));
  ok("a manager of another department may not",
     !canDecide(person('other', [], ['dept-tech']), req({ approvalState: 'MANAGER_PENDING' })));

  /* The rule that stops the chain being skipped by whoever holds the most
     permissions. Finance is senior to a department manager and still cannot
     take his step for him. */
  ok('Finance may not decide while it is still with the manager',
     !canDecide(FIN, req({ approvalState: 'MANAGER_PENDING' })));
  ok('nor may Purchases', !canDecide(PURCH, req({ approvalState: 'MANAGER_PENDING' })));

  ok('Purchases decides at the Purchases step',
     canDecide(PURCH, req({ approvalState: 'PURCHASES_PENDING', route: 'purchases' })));
  ok('a manager does not decide at the Purchases step',
     !canDecide(MONA, req({ approvalState: 'PURCHASES_PENDING', route: 'purchases' })));

  ok('Finance decides at the Finance step',
     canDecide(FIN, req({ approvalState: 'FINANCE_PENDING' })));
  ok('Purchases does not decide at the Finance step',
     !canDecide(PURCH, req({ approvalState: 'FINANCE_PENDING' })));

  section('Nobody approves their own request, however senior');
  ok('not the manager, at his own step',
     !canDecide(MONA, req({ requesterId: 'mona', approvalState: 'MANAGER_PENDING' })));
  ok('not Finance, at the Finance step',
     !canDecide(FIN, req({ requesterId: 'fin', approvalState: 'FINANCE_PENDING' })));
  ok('not Purchases, at the Purchases step',
     !canDecide(PURCH, req({ requesterId: 'purch', approvalState: 'PURCHASES_PENDING',
                             route: 'purchases' })));

  section('A decided request cannot be decided again');
  ok('not once approved', !canDecide(FIN, req({ approvalState: 'APPROVED' })));
  ok('not once rejected', !canDecide(FIN, req({ approvalState: 'REJECTED' })));
  eq('and it is waiting on nobody', stepOf('APPROVED'), null);

  section('Editing in place, only while Open');
  ok('the requester may edit his own draft',
     canEditDirectly(SAMI, req({ approvalState: 'DRAFT' })));
  ok('and while it is still going through the chain',
     canEditDirectly(SAMI, req({ approvalState: 'MANAGER_PENDING' })));
  ok('and at the finance step, still Open',
     canEditDirectly(SAMI, req({ approvalState: 'FINANCE_PENDING' })));

  /* Once approved the amount has been agreed by everyone who decided it, so a
     change is a new decision for all of them -- an edit request, not an edit. */
  ok('but not once approved — that is what an edit request is for',
     !canEditDirectly(SAMI, req({ approvalState: 'APPROVED' })));
  ok('nor once partly paid',
     !canEditDirectly(SAMI, req({ approvalState: 'APPROVED', paymentState: 'PARTIAL' })));
  ok('nor once rejected', !canEditDirectly(SAMI, req({ approvalState: 'REJECTED' })));
  ok('and never somebody else\'s request',
     !canEditDirectly(MONA, req({ approvalState: 'MANAGER_PENDING' })));
  ok('not even by Finance',
     !canEditDirectly(FIN, req({ approvalState: 'MANAGER_PENDING' })));

  section('Nothing with money against it is deleted');
  ok('an unpaid request may be removed by Finance', canDelete(FIN, req()));
  ok('a partly paid one may not',
     !canDelete(FIN, req({ approvalState: 'APPROVED', paymentState: 'PARTIAL' })));
  ok('a fully paid one may not',
     !canDelete(FIN, req({ approvalState: 'APPROVED', paymentState: 'PAID' })));
  ok('and an ordinary employee may not delete anything', !canDelete(SAMI, req()));

  section('isOpen covers exactly the pending states');
  const all: ApprovalState[] =
    ['DRAFT', 'MANAGER_PENDING', 'PURCHASES_PENDING', 'FINANCE_PENDING', 'APPROVED', 'REJECTED'];
  eq('three states are open',
     all.filter(isOpen), ['MANAGER_PENDING', 'PURCHASES_PENDING', 'FINANCE_PENDING']);
  eq('and each of those is waiting on somebody',
     all.filter(isOpen).every((s) => stepOf(s) !== null), true);

  console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nfailures:'); failures.forEach((f) => console.log('  ' + f)); }
  process.exit(fail ? 1 : 0);
}
main();