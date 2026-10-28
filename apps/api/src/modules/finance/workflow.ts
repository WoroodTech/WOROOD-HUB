/**
 * Where a request goes next, and what to call where it is.
 *
 * Kept apart from the service that writes rows, because this is the part Finance
 * actually described and the part most likely to be argued about later. It is
 * pure: given a request and a person, it says what may happen. Nothing here
 * reads or writes the database, so every rule below can be tested directly.
 *
 * The chain:
 *
 *     created ─▶ manager ─▶ [purchases] ─▶ finance ─▶ approved
 *
 * The manager step is skipped when the department has no manager, and when the
 * requester is the manager -- nobody approves their own request. The purchases
 * step applies only to requests routed there. Finance is always last, and its
 * approval is what makes a request In Progress.
 */
import type { Principal } from '../../common/auth';

export type ApprovalState =
  | 'DRAFT' | 'MANAGER_PENDING' | 'PURCHASES_PENDING' | 'FINANCE_PENDING'
  | 'APPROVED' | 'REJECTED';

export type PaymentState = 'UNPAID' | 'PARTIAL' | 'PAID';

/** What the two states mean together, in the words Finance uses. */
export type RequestLabel =
  | 'Open' | 'In Progress' | 'Partial Pay' | 'Complete' | 'Rejected' | 'Draft';

/**
 * The single label a person sees.
 *
 * Approval and payment are separate facts and are stored separately; this is
 * the one place they are combined. The legacy app kept one column and needed a
 * second for the stage anyway, which is how a request could read "Open" while
 * sitting rejected in a pending tab.
 */
export function labelFor(approval: ApprovalState, payment: PaymentState): RequestLabel {
  if (approval === 'REJECTED') return 'Rejected';
  if (approval === 'DRAFT') return 'Draft';
  if (approval !== 'APPROVED') return 'Open';       // still going through the chain
  if (payment === 'PAID') return 'Complete';
  if (payment === 'PARTIAL') return 'Partial Pay';
  return 'In Progress';                              // approved, nothing paid yet
}

/** Arabic, for the portal's other half. */
export const LABEL_AR: Record<RequestLabel, string> = {
  'Draft': 'مسودة',
  'Open': 'قيد الموافقة',
  'In Progress': 'جاري التنفيذ',
  'Partial Pay': 'مدفوع جزئيًا',
  'Complete': 'مكتمل',
  'Rejected': 'مرفوض',
};

export interface RequestShape {
  requesterId: string;
  departmentId: string;
  route: 'finance' | 'purchases';
  approvalState: ApprovalState;
  paymentState: PaymentState;
}

/**
 * The first state a request enters when it is submitted.
 *
 * `departmentManagerIds` is who manages the requesting department. A request
 * from the manager himself skips straight past his own step -- the legacy app
 * has the same rule and it is the one piece of its routing that is unambiguous.
 */
export function firstState(
  r: { requesterId: string; route: 'finance' | 'purchases' },
  departmentManagerIds: string[],
): ApprovalState {
  const needsManager = departmentManagerIds.length > 0
    && !departmentManagerIds.includes(r.requesterId);
  if (needsManager) return 'MANAGER_PENDING';
  return r.route === 'purchases' ? 'PURCHASES_PENDING' : 'FINANCE_PENDING';
}

/** Where an approval at the current step sends it. */
export function nextState(
  current: ApprovalState, route: 'finance' | 'purchases',
): ApprovalState {
  switch (current) {
    case 'MANAGER_PENDING':
      return route === 'purchases' ? 'PURCHASES_PENDING' : 'FINANCE_PENDING';
    case 'PURCHASES_PENDING':
      return 'FINANCE_PENDING';
    case 'FINANCE_PENDING':
      return 'APPROVED';
    default:
      return current;
  }
}

/** Which step a state is waiting on, for the approvals queue. */
export function stepOf(state: ApprovalState): 'MANAGER' | 'PURCHASES' | 'FINANCE' | null {
  if (state === 'MANAGER_PENDING') return 'MANAGER';
  if (state === 'PURCHASES_PENDING') return 'PURCHASES';
  if (state === 'FINANCE_PENDING') return 'FINANCE';
  return null;
}

/**
 * May this person decide this request right now?
 *
 * Deliberately narrow. Holding `finance.request.manage` does not let somebody
 * decide a request that is still with its department manager: the legacy app
 * blocked that too, and it is the rule that stops an approval chain from being
 * quietly skipped by whoever happens to have the most permissions.
 */
export function canDecide(p: Principal, r: RequestShape): boolean {
  const step = stepOf(r.approvalState);
  if (!step) return false;

  // Never your own request, at any step, however senior you are.
  if (r.requesterId === p.id) return false;

  if (step === 'MANAGER') return p.managedDepartmentIds.includes(r.departmentId);
  if (step === 'PURCHASES') return p.permissions.includes('finance.purchases.decide');
  return p.permissions.includes('finance.request.manage');
}

/**
 * May this request be edited in place?
 *
 * Only while it is still Open -- before anybody has approved anything. Once the
 * chain has started, a change to the amount is a new decision for everyone who
 * already made one, so it goes through an edit request instead (phase 3).
 *
 * This is the rule that removes the legacy app's worst inconsistency: there,
 * two different code paths could change an amount, one of which checked it
 * against what had been paid and one of which did not.
 */
export function canEditDirectly(p: Principal, r: RequestShape): boolean {
  if (r.requesterId !== p.id) return false;
  return r.approvalState === 'DRAFT' || isOpen(r.approvalState);
}

/** Still going through the chain: submitted, not yet approved or rejected. */
export function isOpen(state: ApprovalState): boolean {
  return state === 'MANAGER_PENDING'
      || state === 'PURCHASES_PENDING'
      || state === 'FINANCE_PENDING';
}

/**
 * May this request be removed?
 *
 * Never once money has moved against it. A request with payments is part of the
 * financial record, and deleting it would leave payments pointing at nothing.
 * Taking it out of circulation is what rejection and archiving are for.
 */
export function canDelete(p: Principal, r: RequestShape): boolean {
  if (r.paymentState !== 'UNPAID') return false;
  return p.permissions.includes('finance.request.manage');
}

/**
 * The reference people quote to each other: PUR-a1b2c3d.
 *
 * The legacy shape is kept on purpose. Staff recognise these, they appear on
 * Zoho records, and migrated rows keep the reference they already had -- which
 * is what makes reconciliation after the migration possible at all.
 */
export function makeReference(code: string, random: () => string): string {
  return `${code}-${random().slice(0, 7).toLowerCase()}`;
}