/**
 * The emails the Finance module sends.
 *
 * Only two kinds go out, and the restraint is the design:
 *
 *   - something is waiting on you to decide
 *   - something you asked for was refused
 *
 * Everything else -- approved, paid, a note added, a change agreed -- stays in
 * the bell. An inbox that fills with "your request moved to the next step" is
 * an inbox where the one message that needed acting on gets missed, and the
 * legacy app sends on every transition for exactly that reason.
 *
 * **No figure appears in any of these.** Not in the subject, not in the body.
 * Departments that must never see money receive these emails like everybody
 * else, and the legacy app leaks precisely here: its rejection email carries
 * the amount, and its receipt email carries three. A message assembled far
 * from the list that was careful is the easiest place to forget. The safest
 * amount to put in an email is none: whoever opens the request sees whatever
 * they are entitled to.
 */

export interface FinanceMailInput {
  reference: string;
  description: string;
  departmentName: string;
  requesterName: string;
  /** Where the recipient should go. */
  url: string;
  /** Only on a refusal. */
  reason?: string;
}

const escape = (s: string) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Plain and narrow: these are read on phones, in a hurry, between other things. */
function wrap(heading: string, lines: string[], url: string, cta: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f5f3;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
         style="max-width:520px;margin:0 auto;background:#fff;border-radius:10px;">
    <tr><td style="padding:28px 28px 8px;">
      <h1 style="margin:0 0 14px;font-size:18px;color:#1d1b19;">${escape(heading)}</h1>
      ${lines.map((l) => `<p style="margin:0 0 10px;font-size:14px;line-height:1.5;color:#44403c;">${l}</p>`).join('')}
    </td></tr>
    <tr><td style="padding:10px 28px 30px;">
      <a href="${escape(url)}"
         style="display:inline-block;padding:10px 18px;border-radius:7px;
                background:#c2410c;color:#fff;text-decoration:none;font-size:14px;">
        ${escape(cta)}</a>
    </td></tr>
  </table>
  <p style="max-width:520px;margin:14px auto 0;font-size:11.5px;color:#8a8580;
            text-align:center;">WOROOD HUB</p>
</body></html>`;
}

/** Something is waiting on this person to decide. */
export function awaitingDecisionMail(i: FinanceMailInput, step: string) {
  const who = step === 'MANAGER' ? 'your department'
            : step === 'PURCHASES' ? 'Purchases' : 'Finance';
  return {
    subject: `${i.reference} needs your approval`,
    html: wrap(
      'A request is waiting for you',
      [
        `<strong>${escape(i.requesterName)}</strong> in ${escape(i.departmentName)} `
        + `has raised ${escape(i.reference)}.`,
        `“${escape(i.description)}”`,
        `It is at the ${escape(who)} step, which is yours.`,
      ],
      i.url, 'Open the request'),
    text: `${i.requesterName} in ${i.departmentName} has raised ${i.reference}.\n`
      + `"${i.description}"\n\nIt is waiting for your decision: ${i.url}`,
  };
}

/** A request was refused. */
export function refusedMail(i: FinanceMailInput) {
  return {
    subject: `${i.reference} was not approved`,
    html: wrap(
      'Your request was not approved',
      [
        `${escape(i.reference)} — “${escape(i.description)}”`,
        i.reason
          ? `<strong>Reason given:</strong> ${escape(i.reason)}`
          : 'No reason was recorded.',
        'If something has changed, raise a new request rather than replying here.',
      ],
      i.url, 'See the request'),
    text: `${i.reference} — "${i.description}" was not approved.\n`
      + (i.reason ? `Reason: ${i.reason}\n` : '')
      + `\n${i.url}`,
  };
}

/** A change to an approved request needs deciding. */
export function changeAwaitingMail(i: FinanceMailInput) {
  return {
    subject: `${i.reference}: a change needs your approval`,
    html: wrap(
      'A change needs agreeing',
      [
        `<strong>${escape(i.requesterName)}</strong> has asked to change `
        + `${escape(i.reference)}, which was already approved.`,
        i.reason ? `<strong>Why:</strong> ${escape(i.reason)}` : '',
        'Nothing changes on the request until you and Finance both agree.',
      ].filter(Boolean),
      i.url, 'Review the change'),
    text: `${i.requesterName} has asked to change ${i.reference}.\n`
      + (i.reason ? `Why: ${i.reason}\n` : '')
      + `\nNothing changes until you and Finance both agree: ${i.url}`,
  };
}