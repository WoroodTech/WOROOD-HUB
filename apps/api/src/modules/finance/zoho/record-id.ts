/**
 * The id of whatever Zoho just created.
 *
 * Zoho wraps the record and names its id differently per endpoint, and the
 * names do not follow the endpoint:
 *
 *   /expenses          → { expense:        { expense_id: … } }
 *   /vendorpayments    → { vendorpayment:  { payment_id: … } }   ← not vendor_payment_id
 *   /banktransactions  → { banktransaction:{ transaction_id: … } }
 *
 * The first pass listed the shapes it expected, guessed `vendor_payment_id`
 * for the middle one, and so marked every vendor payment "accepted but
 * returned no id" — while the record sat in their books perfectly well.
 *
 * So rather than a longer list of guesses: look one level into the envelope
 * and take the first key that ends in `_id`. That is the record's own id by
 * Zoho's own convention, and a new endpoint works without another guess.
 */
export function idFrom(out: any): string | null {
  if (!out || typeof out !== 'object') return null;

  const pick = (o: any): string | null => {
    if (!o || typeof o !== 'object') return null;
    for (const [k, v] of Object.entries(o)) {
      if (!k.endsWith('_id')) continue;
      /* `_id` fields Zoho attaches that identify something else. */
      if (k === 'vendor_id' || k === 'customer_id' || k === 'account_id'
          || k === 'organization_id' || k === 'currency_id'
          || k === 'paid_through_account_id' || k === 'user_id') continue;
      if (typeof v === 'string' && v) return v;
      if (typeof v === 'number') return String(v);
    }
    return null;
  };

  /* The envelope first: `{ code, message, expense: {...} }`. */
  for (const [key, value] of Object.entries(out)) {
    if (key === 'code' || key === 'message') continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const found = pick(value);
      if (found) return found;
    }
  }

  /* Then the body itself, for endpoints that do not wrap. */
  return pick(out) ?? (typeof out.id === 'string' ? out.id : null);
}