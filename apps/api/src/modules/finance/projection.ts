/**
 * Which fields of a request each person may see.
 *
 * Visibility decides *which rows* come back. This decides *which fields* of
 * those rows, and it is a separate question with a separate answer: a member of
 * Office may be entitled to see that his request exists and was approved, and
 * not entitled to see what it cost.
 *
 * The rule, from the legacy app and confirmed against its source:
 *
 *   Office, Workshop and Warehouse never see money. Not an amount, not a
 *   vendor, not transfer details -- anywhere. Not in a list, not on the
 *   request, not in a notification, not in an email, not in an export.
 *
 * In the legacy app this is enforced function by function, and three of them
 * miss it: the rejection email carries the amount, the receipt email carries
 * the requested, paid and remaining figures, and the purchase-order field is
 * left on the list rows with the supplier's name in it. Enforcing it in one
 * projection instead means a new screen cannot forget.
 *
 * The other half of the rule is about colleagues. Within an ordinary
 * department you may see that a colleague asked for something and what it cost,
 * but not where the money was sent: an account number is the requester's own
 * business and Finance's, nobody else's.
 *
 * Pure, so every combination can be checked without a database.
 */
import type { Principal } from '../../common/auth';

const MANAGE = 'finance.request.manage';
const REPORT = 'finance.report.view';
const PURCHASES = 'finance.purchases.decide';

/** What the viewer is, relative to one request. */
export interface ViewerFacts {
  /** They raised it. */
  own: boolean;
  /** They manage the department it came from. */
  managesDepartment: boolean;
  /** The request came from a department that must never see money. */
  requestingDepartmentIsLite: boolean;
}

export interface Lens {
  /** Amount, and anything derived from it. */
  money: boolean;
  /** Bank, account number, beneficiary, wallet or InstaPay number. */
  transferDetails: boolean;
  /** Supplier name and purchase-order references. */
  vendor: boolean;
}

/**
 * What this person may see of this request.
 *
 * Finance, Purchases and read-only Top Management see everything: they are the
 * people who price, pay and report on it.
 *
 * Everyone else is bounded by the asking department. A lite department's own
 * member -- the person who raised it -- is still shown nothing about money,
 * because the department is not permitted to know what its spending costs.
 * That is deliberate in the original and the one place where "own request"
 * does not open everything.
 */
export function lensFor(p: Principal, f: ViewerFacts): Lens {
  const finance = p.permissions.includes(MANAGE)
    || p.permissions.includes(PURCHASES)
    || p.permissions.includes(REPORT);

  if (finance) return { money: true, transferDetails: true, vendor: true };

  /* The lite rule comes before everything else, including ownership. */
  if (f.requestingDepartmentIsLite) {
    return { money: false, transferDetails: false, vendor: false };
  }

  if (f.own) return { money: true, transferDetails: true, vendor: true };

  /* A colleague, or the department's manager. The manager needs the figure to
     approve it; neither needs the account number. */
  if (f.managesDepartment) return { money: true, transferDetails: false, vendor: true };

  return { money: true, transferDetails: false, vendor: false };
}

/**
 * Apply the lens to one request, as it is about to leave the API.
 *
 * Fields that may not be seen are **removed**, not blanked: a null amount
 * already means "Purchases has not priced this yet", and reusing it for "you
 * may not see this" would make the two indistinguishable to the page drawing
 * it. `hidden` says which were taken away, so a screen can say "not shown"
 * rather than inventing a zero.
 */
export function project<T extends Record<string, any>>(row: T, lens: Lens): T {
  const out: Record<string, any> = { ...row };
  const hidden: string[] = [];

  if (!lens.money) {
    for (const k of ['requestedAmount', 'paidTotal', 'remaining']) {
      if (k in out) { delete out[k]; hidden.push(k); }
    }
  }
  if (!lens.transferDetails) {
    for (const k of ['paymentMethod', 'paymentDetails', 'bankName',
                     'accountNumber', 'beneficiaryName']) {
      if (k in out) { delete out[k]; hidden.push(k); }
    }
  }
  if (!lens.vendor) {
    for (const k of ['vendorName', 'vendorZohoId', 'purchaseOrderReference']) {
      if (k in out) { delete out[k]; hidden.push(k); }
    }
  }

  out.hidden = hidden;
  return out as T;
}

/**
 * The same rule, for a line of text rather than a row.
 *
 * Notifications and emails are where the legacy app leaks: the message is
 * assembled somewhere far from the list that was so careful. Anything built
 * for a person goes through here, and a figure for somebody who may not see
 * one is simply not mentioned.
 */
export function moneyPhrase(amount: number | null, lens: Lens): string {
  if (!lens.money || amount === null) return '';
  return amount.toFixed(2);
}