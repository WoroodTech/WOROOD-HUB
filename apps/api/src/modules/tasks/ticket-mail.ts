/**
 * What a ticket email says.
 *
 * One template rather than one per event. Every ticket message is the same
 * shape — here is what happened, here is the ticket, here is the link — and the
 * part that differs is a heading and a sentence, both of which the caller
 * already has because it just wrote them to the notification. Writing ten
 * near-identical templates would mean ten places for the wording to drift.
 *
 * No calendar file. A ticket is not an appointment, and the meeting module's
 * `.ics` exists because a meeting has a time you must be somewhere.
 */
import { DateTime } from 'luxon';

export interface TicketMailInput {
  reference: string;
  title: string;
  status: string;
  priority: string;
  department: string;
  requesterDepartment: string | null;
  requesterName: string;
  dueAt: Date | string | null;
  plannedFor: Date | string | null;
  /** What happened, in the words the notification used. */
  heading: string;
  message: string;
  url: string;
}

const TZ = 'Africa/Cairo';

const date = (v: Date | string | null) => {
  if (!v) return null;
  const d = DateTime.fromJSDate(new Date(v)).setZone(TZ);
  return d.isValid ? d.toFormat('cccc d LLLL, HH:mm') : null;
};

/** The status as a person says it, not as the column stores it. */
const readable: Record<string, string> = {
  NEW: 'New', PLANNING: 'Planned', ON_HOLD: 'On hold', ASSIGNED: 'Assigned',
  IN_PROGRESS: 'In progress', BLOCKED: 'Waiting on another department',
  FOR_REVIEW: 'Waiting for review', IMPLEMENTATION: 'Being carried out',
  DONE: 'Done', REJECTED: 'Refused', CANCELLED: 'Cancelled',
};

export function ticketMail(t: TicketMailInput) {
  const rows: Array<[string, string]> = [
    ['Ticket', `<strong>${t.title}</strong>`],
    ['Reference', `<span style="font-family:ui-monospace,monospace">${t.reference}</span>`],
    ['Status', readable[t.status] ?? t.status],
    ['Priority', t.priority.toLowerCase()],
    ['Department', t.department],
    ['Raised by', t.requesterName + (t.requesterDepartment ? ` — ${t.requesterDepartment}` : '')],
  ];

  /* Only the date that applies. A planned ticket has no due date and a ticket
     in progress has no planned date, so showing both means showing an empty
     row on every email. */
  const due = date(t.dueAt);
  const planned = date(t.plannedFor);
  if (due) rows.push(['Due', due]);
  else if (planned) rows.push(['Planned for', planned]);

  const html = `
<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#f6f4f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#2b2724">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e7e2dc;border-radius:12px;overflow:hidden">
    <div style="padding:20px 24px;border-bottom:1px solid #e7e2dc">
      <span style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8a8079">WOROOD HUB · Tickets</span>
    </div>
    <div style="padding:24px">
      <h1 style="margin:0 0 8px;font-size:19px;line-height:1.35">${t.heading}</h1>
      ${t.message ? `<p style="margin:0 0 20px;color:#6b635c;font-size:14px;line-height:1.5">${t.message}</p>` : ''}
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        ${rows.map(([k, v]) => `
        <tr>
          <td style="padding:7px 0;color:#8a8079;width:120px;vertical-align:top">${k}</td>
          <td style="padding:7px 0;vertical-align:top">${v}</td>
        </tr>`).join('')}
      </table>
      <div style="margin-top:24px">
        <a href="${t.url}" style="display:inline-block;background:#b4552d;color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-size:14px;font-weight:600">Open the ticket</a>
      </div>
      <p style="margin:12px 0 0;font-size:12px;color:#8a8079">You will be asked to sign in first.</p>
    </div>
  </div>
</body></html>`;

  const text = [
    t.heading, '',
    ...(t.message ? [t.message, ''] : []),
    ...rows.map(([k, v]) => `${k}: ${v.replace(/<[^>]+>/g, '')}`),
    '', `Open the ticket: ${t.url}`,
    '(You will be asked to sign in first.)',
    '', '— WOROOD HUB',
  ].join('\n');

  /* The reference leads, because a person with several open tickets sorts by
     subject and needs to know which one this is before reading a word. */
  return { subject: `${t.reference} — ${t.heading}`, html, text };
}