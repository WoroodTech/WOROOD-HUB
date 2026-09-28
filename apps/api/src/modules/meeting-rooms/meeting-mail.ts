/**
 * What a meeting email says, and the calendar file that goes with it.
 *
 * Kept apart from the service that sends it: composing a message is a different
 * job from deciding to send one, and this file has no database and no network
 * in it, so what an invitation reads like can be changed without going near the
 * booking logic.
 */
import { DateTime } from 'luxon';
import { config } from '../../common/config';

export interface MeetingMailInput {
  reference: string;
  title: string;
  organiserName: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  roomName: string;
  roomFloor?: string | null;
  locationName?: string | null;
  description?: string | null;
  attendeeCount: number;
  /** Where the recipient goes to answer. */
  invitationUrl: string;
}

/* ------------------------------------------------------------- formatting -- */

const when = (m: MeetingMailInput) => {
  const s = DateTime.fromJSDate(m.startsAt).setZone(m.timezone);
  const e = DateTime.fromJSDate(m.endsAt).setZone(m.timezone);
  const minutes = Math.round(e.diff(s, 'minutes').minutes);
  const length = minutes < 60
    ? `${minutes} minutes`
    : minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;

  return {
    /* The date spelled out and the zone named. An email is read in a mail
       client that knows nothing about the shop's timezone, and "10:20" with no
       zone is a guess for anyone travelling. */
    long: `${s.toFormat('cccc d LLLL yyyy')}, ${s.toFormat('HH:mm')}–${e.toFormat('HH:mm')}`,
    zone: s.toFormat('ZZZZ'),
    length,
  };
};

const place = (m: MeetingMailInput) =>
  [m.roomName, m.roomFloor ? `floor ${m.roomFloor}` : null, m.locationName]
    .filter(Boolean).join(', ');

/* ------------------------------------------------------------------- .ics -- */

/** Fold a line at 75 octets, as the format requires. Long titles and Arabic
 *  descriptions exceed it easily, and an unfolded line is quietly dropped by
 *  some clients rather than rejected. */
const fold = (line: string): string => {
  const out: string[] = [];
  let buf = line;
  while (Buffer.byteLength(buf, 'utf8') > 75) {
    let cut = 75;
    while (Buffer.byteLength(buf.slice(0, cut), 'utf8') > 75) cut--;
    out.push(buf.slice(0, cut));
    buf = ' ' + buf.slice(cut);
  }
  out.push(buf);
  return out.join('\r\n');
};

const esc = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/**
 * A calendar file for "add to calendar".
 *
 * `METHOD:PUBLISH`, not `REQUEST`. A REQUEST makes the mail client treat this
 * as an invitation it owns: Outlook shows its own Accept and Decline buttons,
 * and a reply is emailed to the organiser — which nothing here reads, so the
 * answer would vanish and the portal would still show the person as not having
 * responded. PUBLISH offers to add the event and nothing more, which is exactly
 * what was asked for, and leaves the portal as the single place an answer is
 * recorded.
 */
export function buildIcs(m: MeetingMailInput): string {
  const stamp = (d: Date) =>
    DateTime.fromJSDate(d).toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'");

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//WOROOD HUB//Meeting Rooms//EN',
    'METHOD:PUBLISH',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    /* Stable per meeting, so adding the same invitation twice updates the
       calendar entry rather than creating a second one. */
    `UID:${m.reference}@worood.co`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(m.startsAt)}`,
    `DTEND:${stamp(m.endsAt)}`,
    fold(`SUMMARY:${esc(m.title)}`),
    fold(`LOCATION:${esc(place(m))}`),
    fold(`DESCRIPTION:${esc(
      `Organised by ${m.organiserName}. ${m.reference}` +
      (m.description ? `\n\n${m.description}` : '') +
      `\n\nRespond in WOROOD HUB: ${m.invitationUrl}`)}`),
    fold(`ORGANIZER;CN=${esc(m.organiserName)}:mailto:${config.mail.from}`),
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Reminder',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n');
}

/* --------------------------------------------------------------- messages -- */

const shell = (heading: string, intro: string, rows: Array<[string, string]>,
                action?: { label: string; url: string }, footer?: string) => `
<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#f6f4f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#2b2724">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e7e2dc;border-radius:12px;overflow:hidden">
    <div style="padding:20px 24px;border-bottom:1px solid #e7e2dc">
      <span style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8a8079">WOROOD HUB</span>
    </div>
    <div style="padding:24px">
      <h1 style="margin:0 0 8px;font-size:19px;line-height:1.35">${heading}</h1>
      <p style="margin:0 0 20px;color:#6b635c;font-size:14px;line-height:1.5">${intro}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        ${rows.map(([k, v]) => `
        <tr>
          <td style="padding:7px 0;color:#8a8079;width:110px;vertical-align:top">${k}</td>
          <td style="padding:7px 0;vertical-align:top">${v}</td>
        </tr>`).join('')}
      </table>
      ${action ? `
      <div style="margin-top:24px">
        <a href="${action.url}" style="display:inline-block;background:#b4552d;color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-size:14px;font-weight:600">${action.label}</a>
      </div>
      <p style="margin:12px 0 0;font-size:12px;color:#8a8079">
        You will be asked to sign in first.
      </p>` : ''}
      ${footer ? `<p style="margin:20px 0 0;font-size:13px;color:#6b635c;line-height:1.5">${footer}</p>` : ''}
    </div>
  </div>
</body></html>`;

const plain = (heading: string, intro: string, rows: Array<[string, string]>,
               action?: { label: string; url: string }, footer?: string) =>
  [heading, '', intro, '',
   ...rows.map(([k, v]) => `${k}: ${v.replace(/<[^>]+>/g, '')}`),
   ...(action ? ['', `${action.label}: ${action.url}`, '(You will be asked to sign in first.)'] : []),
   ...(footer ? ['', footer.replace(/<[^>]+>/g, '')] : []),
   '', '— WOROOD HUB'].join('\n');

const rowsFor = (m: MeetingMailInput): Array<[string, string]> => {
  const w = when(m);
  return [
    ['What', `<strong>${m.title}</strong>`],
    ['When', `${w.long} <span style="color:#8a8079">(${w.zone})</span>`],
    ['How long', w.length],
    ['Where', place(m)],
    ['Organiser', m.organiserName],
    ['Attending', `${m.attendeeCount} ${m.attendeeCount === 1 ? 'person' : 'people'}`],
    ['Reference', `<span style="font-family:ui-monospace,monospace">${m.reference}</span>`],
    ...(m.description ? [['Notes', m.description] as [string, string]] : []),
  ];
};

export function invitationMail(m: MeetingMailInput) {
  const heading = `${m.organiserName} invited you to a meeting`;
  const intro = 'Let them know whether you can make it.';
  const action = { label: 'Accept or decline', url: m.invitationUrl };
  const footer = 'The attached file adds this to your calendar. Answering still happens in the portal.';
  return {
    subject: `Meeting invitation: ${m.title} — ${when(m).long}`,
    html: shell(heading, intro, rowsFor(m), action, footer),
    text: plain(heading, intro, rowsFor(m), action, footer),
    ics: buildIcs(m),
  };
}

export function responseMail(m: MeetingMailInput, who: string, accepted: boolean) {
  const heading = `${who} ${accepted ? 'accepted' : 'declined'} your meeting`;
  const intro = accepted
    ? 'No action needed.'
    : 'You may want to reschedule, or go ahead without them.';
  return {
    subject: `${accepted ? 'Accepted' : 'Declined'}: ${m.title} — ${m.reference}`,
    html: shell(heading, intro, rowsFor(m), { label: 'Open the meeting', url: m.invitationUrl }),
    text: plain(heading, intro, rowsFor(m), { label: 'Open the meeting', url: m.invitationUrl }),
  };
}

export function cancellationMail(m: MeetingMailInput, reason?: string | null) {
  const heading = 'A meeting you were invited to was cancelled';
  const intro = reason
    ? `${m.organiserName} cancelled it: ${reason}`
    : `${m.organiserName} cancelled it.`;
  /* No action link. There is nothing to answer, and a button on a cancellation
     invites a click that can only lead to a page saying it is gone. */
  return {
    subject: `Cancelled: ${m.title} — ${when(m).long}`,
    html: shell(heading, intro, rowsFor(m), undefined,
      'Your calendar entry, if you added one, will need removing by hand.'),
    text: plain(heading, intro, rowsFor(m), undefined,
      'Your calendar entry, if you added one, will need removing by hand.'),
  };
}

export function movedMail(m: MeetingMailInput) {
  const heading = 'A meeting you were invited to has moved';
  const intro = `${m.organiserName} changed the time or the room. The new details are below.`;
  const action = { label: 'Open the meeting', url: m.invitationUrl };
  return {
    subject: `Moved: ${m.title} — now ${when(m).long}`,
    html: shell(heading, intro, rowsFor(m), action,
      'The attached file updates the entry in your calendar.'),
    text: plain(heading, intro, rowsFor(m), action,
      'The attached file updates the entry in your calendar.'),
    ics: buildIcs(m),
  };
}