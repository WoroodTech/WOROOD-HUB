/**
 * What a request must contain, and what it must not.
 *
 * These are the legacy form's rules, read from `addEntry` and `payDetails_`
 * rather than reinvented, because Finance and Purchases have been working to
 * them for a year and a request that arrives missing a beneficiary name is a
 * phone call, not a validation message.
 *
 * The shape of the rules is not obvious from the outside, so it is worth
 * stating plainly: **what the form asks for depends on where the request is
 * going, not on which department is asking.**
 *
 *   Straight to Finance   — amount, type, payment method and transfer details
 *                           are all required. Somebody is asking for a
 *                           specific sum to go to a specific place.
 *
 *   Through Purchases     — none of those are asked, for any department. The
 *                           requester says what is needed and why; Purchases
 *                           decides what it costs, what kind of spending it is
 *                           and where the money goes, when it approves.
 *
 * A lite department (Office, Workshop, Warehouse) always goes through
 * Purchases, so it never sees any of it -- but a Marketing request sent to
 * Purchases is treated exactly the same way, which is the part that is easy to
 * get wrong by thinking of this as a department rule.
 *
 * Pure, so every rule can be checked without a database or a browser.
 */

export const PAY_METHODS = [
  'Wallet Number', 'InstaPay Number', 'Bank Account Number', 'IBAN',
] as const;
export type PayMethod = typeof PAY_METHODS[number];

/** The ones that also need a named beneficiary. */
const NEEDS_BENEFICIARY: readonly string[] = ['Bank Account Number', 'IBAN'];

/* The legacy limits, kept as they are: these are what the sheet columns and the
   emails were sized for, and a description three times longer makes a list
   unreadable rather than more informative. */
export const LIMITS = {
  description: 300,
  moreDetails: 1000,
  paymentDetails: 200,
  beneficiary: 100,
  maxAmount: 1_000_000_000,
} as const;

export interface FormInput {
  description?: string;
  moreDetails?: string;
  type?: string;
  dueDate?: string;
  requestedAmount?: number | null;
  paymentMethod?: string;
  /** Wallet or InstaPay number, or the bank account number. */
  accountNumber?: string;
  bankName?: string;
  beneficiaryName?: string;
}

export interface FormContext {
  /** Where this request is going, once the department's route and the
   *  requester's choice have been resolved. */
  route: 'finance' | 'purchases';
  /** Office, Workshop, Warehouse: no type list, and never any money. */
  lite: boolean;
  /** The types this department offers, for a request going to Finance. */
  requestTypes: string[];
}

export interface CleanRequest {
  description: string;
  moreDetails: string | null;
  type: string | null;
  dueDate: string;
  requestedAmount: number | null;
  paymentMethod: string | null;
  paymentDetails: string | null;
  bankName: string | null;
  accountNumber: string | null;
  beneficiaryName: string | null;
}

export class FormError extends Error {}

const clip = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);

/**
 * Check and tidy one request.
 *
 * Throws `FormError` with the message the person should see. The messages are
 * the legacy ones almost word for word: they are plain, they say what to do,
 * and staff already recognise them.
 */
export function validateRequest(input: FormInput, ctx: FormContext): CleanRequest {
  const description = clip(input.description, LIMITS.description);
  if (!description) throw new FormError('Please enter a description');

  /* Required for everyone except the lite departments, which are describing
     something they need rather than justifying a sum. The legacy app makes the
     same exception, and for the same reason. */
  const moreDetails = clip(input.moreDetails, LIMITS.moreDetails);
  if (!moreDetails && !ctx.lite) throw new FormError('Please enter the more details');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.dueDate ?? ''))) {
    throw new FormError('Please choose the due date');
  }

  /* The dividing line. Everything below depends on it, and on nothing else. */
  const noMoney = ctx.lite || ctx.route === 'purchases';

  if (noMoney) {
    /* Nothing is known about cost or payment yet, so nothing is asked and
       nothing sent is kept: a type or an amount arriving here would be a guess
       that Purchases then has to notice and undo. */
    return {
      description, moreDetails: moreDetails || null,
      type: null,
      dueDate: String(input.dueDate),
      requestedAmount: null,
      paymentMethod: null, paymentDetails: null,
      bankName: null, accountNumber: null, beneficiaryName: null,
    };
  }

  const type = clip(input.type, 80);
  if (!type || !ctx.requestTypes.includes(type)) {
    throw new FormError(`Please choose a type: ${ctx.requestTypes.join(', ')}`);
  }

  const amount = Number(input.requestedAmount);
  if (!(amount > 0) || amount > LIMITS.maxAmount) {
    throw new FormError('Please enter a valid amount');
  }

  const method = clip(input.paymentMethod, 60);
  if (!(PAY_METHODS as readonly string[]).includes(method)) {
    throw new FormError('Please choose how to transfer the money');
  }

  const account = clip(input.accountNumber, LIMITS.paymentDetails);
  if (account.length < 4) {
    throw new FormError(`Please enter the transfer details (${method})`);
  }

  let bankName: string | null = null;
  let beneficiary: string | null = null;

  if (NEEDS_BENEFICIARY.includes(method)) {
    beneficiary = clip(input.beneficiaryName, LIMITS.beneficiary);
    if (beneficiary.length < 2) {
      throw new FormError('Please type the beneficiary name (the account holder)');
    }
    if (method === 'Bank Account Number') {
      bankName = clip(input.bankName, 120);
      if (bankName.length < 2) {
        throw new FormError('Please choose the bank and type the account number');
      }
    }
  }

  return {
    description, moreDetails: moreDetails || null, type,
    dueDate: String(input.dueDate),
    requestedAmount: amount,
    paymentMethod: method,
    paymentDetails: assembleDetails(method, bankName, account, beneficiary),
    bankName, accountNumber: account, beneficiaryName: beneficiary,
  };
}

/**
 * The one-line form the legacy app stores and Zoho receives.
 *
 * Assembled from the parts rather than typed as one string, and the parts are
 * also kept in their own columns. The legacy app keeps only this line and
 * re-parses it by searching for " - " and " | Beneficiary: ", which loses the
 * beneficiary the first time a bank name contains a hyphen.
 */
export function assembleDetails(
  method: string, bank: string | null, account: string, beneficiary: string | null,
): string {
  const base = method === 'Bank Account Number' && bank ? `${bank} - ${account}` : account;
  return beneficiary ? `${base} | Beneficiary: ${beneficiary}` : base;
}

/**
 * Which fields the form should show.
 *
 * Returned to the browser so the form and the server cannot disagree about
 * what is being asked for -- the alternative is the same condition written
 * twice in two languages, which drifts.
 */
export function fieldsFor(ctx: FormContext) {
  const noMoney = ctx.lite || ctx.route === 'purchases';
  return {
    type: !noMoney,
    amount: !noMoney,
    payment: !noMoney,
    moreDetails: true,
    moreDetailsRequired: !ctx.lite,
  };
}