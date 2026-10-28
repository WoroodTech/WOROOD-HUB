/**
 * What a request must contain — the legacy form's rules.
 *
 *   npx tsx test/finance-form.test.ts
 *
 * Read from addEntry and payDetails_ rather than invented. The point worth
 * holding on to: what the form asks for depends on WHERE the request is going,
 * not on which department is asking. A Marketing request sent to Purchases is
 * treated exactly like an Office one.
 */
import {
  FormError, fieldsFor, validateRequest, assembleDetails, PAY_METHODS,
} from '../src/modules/finance/request-form';

let pass = 0, fail = 0;
const failures: string[] = [];
const ok = (n: string, c: boolean, d = '') => {
  c ? (pass++, console.log('  ok    ' + n))
    : (fail++, failures.push(n), console.log('  FAIL  ' + n + ' ' + d));
};
const eq = (n: string, a: any, b: any) =>
  ok(n, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
const section = (t: string) => console.log('\n' + t);

const refuses = (input: any, ctx: any): string => {
  try { validateRequest(input, ctx); return ''; }
  catch (e) { return e instanceof FormError ? e.message : String(e); }
};

const MKT_FIN = { route: 'finance' as const, lite: false,
                  requestTypes: ['Models', 'Stylist', 'Other'] };
const MKT_PUR = { ...MKT_FIN, route: 'purchases' as const };
const OFFICE  = { route: 'purchases' as const, lite: true, requestTypes: [] };

const good = {
  description: 'Photoshoot fee', moreDetails: 'Autumn campaign, two days',
  type: 'Models', dueDate: '2026-12-01', requestedAmount: 5000,
  paymentMethod: 'Wallet Number', accountNumber: '01001234567',
};

function main() {
  section('A request going straight to Finance');
  {
    const r = validateRequest(good, MKT_FIN);
    eq('is accepted', r.type, 'Models');
    eq('keeping its amount', r.requestedAmount, 5000);
    eq('and its transfer details', r.paymentDetails, '01001234567');
  }

  section('Everything it must have');
  {
    ok('a description', /enter a description/i.test(
      refuses({ ...good, description: '   ' }, MKT_FIN)));
    /* Required for everyone except the lite departments -- the legacy app
       makes the same exception. */
    ok('more details', /enter the more details/i.test(
      refuses({ ...good, moreDetails: '' }, MKT_FIN)));
    ok('a due date', /choose the due date/i.test(
      refuses({ ...good, dueDate: 'soon' }, MKT_FIN)));
    ok('a type from its own department', /choose a type/i.test(
      refuses({ ...good, type: 'Server renewal' }, MKT_FIN)));
    ok('an amount above zero', /valid amount/i.test(
      refuses({ ...good, requestedAmount: 0 }, MKT_FIN)));
    ok('not an absurd one', /valid amount/i.test(
      refuses({ ...good, requestedAmount: 2_000_000_000 }, MKT_FIN)));
    ok('a way to transfer the money', /how to transfer/i.test(
      refuses({ ...good, paymentMethod: '' }, MKT_FIN)));
    ok('and the details of it', /transfer details/i.test(
      refuses({ ...good, accountNumber: '12' }, MKT_FIN)));
  }

  section('A bank transfer must say who is being paid');
  {
    ok('an account number alone is not enough', /beneficiary name/i.test(
      refuses({ ...good, paymentMethod: 'IBAN',
                accountNumber: 'EG380003000123456789' }, MKT_FIN)));

    const r = validateRequest({ ...good, paymentMethod: 'IBAN',
      accountNumber: 'EG380003000123456789', beneficiaryName: 'Ahmed Hassan' }, MKT_FIN);
    eq('with a beneficiary it is accepted', r.beneficiaryName, 'Ahmed Hassan');
    eq('and the line is assembled as Zoho expects it',
       r.paymentDetails, 'EG380003000123456789 | Beneficiary: Ahmed Hassan');

    ok('a bank account also needs the bank', /choose the bank/i.test(
      refuses({ ...good, paymentMethod: 'Bank Account Number',
                accountNumber: '100012345678', beneficiaryName: 'Ahmed Hassan' }, MKT_FIN)));

    const b = validateRequest({ ...good, paymentMethod: 'Bank Account Number',
      bankName: 'Banque Misr', accountNumber: '100012345678',
      beneficiaryName: 'Ahmed Hassan' }, MKT_FIN);
    eq('and then carries all three', b.paymentDetails,
       'Banque Misr - 100012345678 | Beneficiary: Ahmed Hassan');
    eq('with the bank kept on its own', b.bankName, 'Banque Misr');
    eq('and the number kept on its own', b.accountNumber, '100012345678');
  }

  section('A bank name with a hyphen in it survives');
  {
    /* The legacy app stores one string and finds the account number by looking
       for the LAST " - ", so a hyphenated bank name is read back wrong. Here
       the parts are columns and only the display line is assembled. */
    const r = validateRequest({ ...good, paymentMethod: 'Bank Account Number',
      bankName: 'Al Ahli Bank of Kuwait - Egypt (ABK)', accountNumber: '100012345678',
      beneficiaryName: 'Mona Said' }, MKT_FIN);
    eq('the bank is still whole', r.bankName, 'Al Ahli Bank of Kuwait - Egypt (ABK)');
    eq('and so is the account number', r.accountNumber, '100012345678');
    eq('and the beneficiary', r.beneficiaryName, 'Mona Said');
  }

  section('A request going through Purchases carries no money at all');
  {
    /* The rule that is easy to get wrong by thinking of it as a department
       rule: this is Marketing, not a lite department. */
    const r = validateRequest({
      description: 'Two studio lights', moreDetails: 'The old ones failed',
      dueDate: '2026-12-01' }, MKT_PUR);
    eq('no amount', r.requestedAmount, null);
    eq('no type — Purchases will classify it', r.type, null);
    eq('no payment method', r.paymentMethod, null);
    eq('no transfer details', r.paymentDetails, null);

    ok('and none of those are asked for', !fieldsFor(MKT_PUR).amount
       && !fieldsFor(MKT_PUR).type && !fieldsFor(MKT_PUR).payment);
    ok('while the same department going to Finance is asked for all of them',
       fieldsFor(MKT_FIN).amount && fieldsFor(MKT_FIN).type && fieldsFor(MKT_FIN).payment);
  }

  section('Anything sent anyway is dropped, not kept');
  {
    const r = validateRequest({ ...good, requestedAmount: 9999, type: 'Models',
      paymentMethod: 'Wallet Number', accountNumber: '01001234567' }, MKT_PUR);
    eq('the amount is not kept', r.requestedAmount, null);
    eq('nor the type', r.type, null);
    eq('nor the payment method', r.paymentMethod, null);
    /* A guess stored here is one Purchases has to notice and undo. */
  }

  section('A lite department');
  {
    const r = validateRequest({
      description: 'Office cleaning, monthly', dueDate: '2026-12-01' }, OFFICE);
    eq('needs no more details', r.moreDetails, null);
    eq('and carries no money', r.requestedAmount, null);
    ok('which the form reflects', !fieldsFor(OFFICE).moreDetailsRequired);
    ok('but a description is still required', /enter a description/i.test(
      refuses({ description: '', dueDate: '2026-12-01' }, OFFICE)));
  }

  section('The legacy limits are kept');
  {
    const r = validateRequest({ ...good,
      description: 'x'.repeat(500), moreDetails: 'y'.repeat(2000) }, MKT_FIN);
    eq('a description is cut at 300', r.description.length, 300);
    eq('more details at 1000', r.moreDetails!.length, 1000);
  }

  section('The four ways money moves');
  eq('are the ones the app offers', [...PAY_METHODS],
     ['Wallet Number', 'InstaPay Number', 'Bank Account Number', 'IBAN']);
  {
    for (const m of ['Wallet Number', 'InstaPay Number']) {
      const r = validateRequest({ ...good, paymentMethod: m,
        accountNumber: '01001234567' }, MKT_FIN);
      eq(`${m} needs no beneficiary`, r.beneficiaryName, null);
    }
  }

  section('assembleDetails on its own');
  eq('a wallet is just the number', assembleDetails('Wallet Number', null, '01001234567', null),
     '01001234567');
  eq('an IBAN carries the beneficiary',
     assembleDetails('IBAN', null, 'EG38', 'Ahmed'), 'EG38 | Beneficiary: Ahmed');
  eq('a bank account carries both',
     assembleDetails('Bank Account Number', 'Banque Misr', '1000', 'Ahmed'),
     'Banque Misr - 1000 | Beneficiary: Ahmed');

  console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nfailures:'); failures.forEach((f) => console.log('  ' + f)); }
  process.exit(fail ? 1 : 0);
}
main();