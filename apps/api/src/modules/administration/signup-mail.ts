/**
 * Telling somebody what happened to their request for an account.
 *
 * Two messages, both to the person who asked. There is no message to the
 * reviewers: the pending tab is where that work lives, and a mail for every
 * stranger who fills in a form is how a reviewer learns to ignore mail from
 * this portal.
 *
 * The same house style as the finance mail, deliberately -- somebody who has
 * had one of those should recognise this as coming from the same place.
 */
import { config } from '../../common/config';

function escape(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrap(heading: string, lines: string[], url?: string, cta?: string): string {
  const button = url && cta ? `
    <tr><td style="padding:10px 28px 30px;">
      <a href="${escape(url)}"
         style="display:inline-block;padding:10px 18px;border-radius:7px;
                background:#c2410c;color:#fff;text-decoration:none;font-size:14px;">
        ${escape(cta)}</a>
    </td></tr>` : '<tr><td style="padding:0 28px 24px;"></td></tr>';

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f5f3;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
         style="max-width:520px;margin:0 auto;background:#fff;border-radius:10px;">
    <tr><td style="padding:28px 28px 8px;">
      <h1 style="margin:0 0 14px;font-size:18px;color:#1d1b19;">${escape(heading)}</h1>
      ${lines.map((l) => `<p style="margin:0 0 10px;font-size:14px;line-height:1.5;color:#44403c;">${l}</p>`).join('')}
    </td></tr>
    ${button}
  </table>
  <p style="max-width:520px;margin:14px auto 0;font-size:11.5px;color:#8a8580;
            text-align:center;">WOROOD HUB</p>
</body></html>`;
}

/** Approved: the account exists and the password they chose works. */
export function approvedMail(fullName: string) {
  const url = config.portalOrigin || 'https://hub.worood.co';
  return {
    subject: 'Your WOROOD HUB account is ready',
    html: wrap(
      `Welcome, ${escape(fullName.split(' ')[0] ?? fullName)}`,
      [
        'Your request for an account has been approved.',
        /* Said plainly, because the commonest thing somebody does next is
           wait for a password that is never coming. */
        'Sign in with the e-mail address and password you chose when you asked '
        + '— no new password has been sent.',
      ],
      url, 'Sign in'),
    text:
      `Welcome, ${fullName}.\n\n`
      + 'Your request for a WOROOD HUB account has been approved.\n\n'
      + 'Sign in with the e-mail address and password you chose when you asked. '
      + 'No new password has been sent.\n\n'
      + url,
  };
}

/**
 * Refused, with the reason.
 *
 * The reason is the point of the message. "No" on its own leaves somebody who
 * may well belong here with nothing to act on, and the next thing they do is
 * ask again exactly as before.
 */
export function refusedMail(fullName: string, reason: string) {
  return {
    subject: 'About your WOROOD HUB account request',
    html: wrap(
      'Your request was not approved',
      [
        `${escape(fullName)}, your request for an account has not been approved.`,
        `<strong>Reason:</strong> ${escape(reason)}`,
        'If you think this is a mistake, speak to your manager or the technology team.',
      ]),
    text:
      `${fullName}, your request for a WOROOD HUB account has not been approved.\n\n`
      + `Reason: ${reason}\n\n`
      + 'If you think this is a mistake, speak to your manager or the technology team.',
  };
}