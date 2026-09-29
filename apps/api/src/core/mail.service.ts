/**
 * Email, through Amazon SES.
 *
 * No credentials anywhere. The instance carries an IAM role
 * (`woroodhubinstancerole`) and the SDK picks it up from the instance metadata
 * service, so there is no access key in the environment file, nothing to rotate
 * and nothing to leak. Locally there is no role, so `send` reports that it
 * cannot send rather than throwing — a developer should be able to book a
 * meeting without an AWS account.
 *
 * **Sending must never fail the thing that caused it.** A booking that succeeds
 * and an email that does not is a small problem; a booking refused because SES
 * was slow is a large one. Every path here returns a result rather than
 * throwing, and the caller records the outcome without acting on it.
 */
import { Injectable, Logger } from '@nestjs/common';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { config } from '../common/config';

export interface MailResult { sent: boolean; error?: string }

export interface Attachment {
  filename: string;
  contentType: string;
  content: string;
}

@Injectable()
export class MailService {
  private readonly log = new Logger('Mail');
  private client: SESv2Client | null = null;

  private get ses(): SESv2Client {
    /* Built once, lazily. Constructing it at module load would resolve the
       instance role during boot, and a metadata service that is briefly slow
       would delay every start rather than the first email. */
    if (!this.client) {
      this.client = new SESv2Client({ region: config.mail.region });
    }
    return this.client;
  }

  get enabled(): boolean {
    return config.mail.enabled;
  }

  /**
   * Send one message.
   *
   * Raw MIME rather than the simple API, because an invitation carries a
   * calendar file and the simple API has nowhere to put it. The parts are
   * assembled here rather than by a library: it is forty lines of a format that
   * has not changed in twenty years, against a dependency that would need
   * updating forever.
   */
  async send(to: string, subject: string, html: string, text: string,
             attachment?: Attachment): Promise<MailResult> {
    if (!this.enabled) {
      return { sent: false, error: 'mail is not configured (MAIL_ENABLED is not true)' };
    }
    if (!to || !to.includes('@')) {
      return { sent: false, error: `not a usable address: ${to || '(empty)'}` };
    }

    try {
      const raw = this.buildMime(to, subject, html, text, attachment);
      await this.ses.send(new SendEmailCommand({
        FromEmailAddress: config.mail.from,
        Destination: { ToAddresses: [to] },
        Content: { Raw: { Data: Buffer.from(raw, 'utf8') } },
      }));
      return { sent: true };
    } catch (e: any) {
      /* Reported, never thrown. The most common failure on a new account is
         the SES sandbox, which refuses any recipient that has not been verified
         -- worth recognising, because the message SES returns for it reads like
         a permissions problem and sends people to IAM. */
      const message = e?.message ?? String(e);
      const hint = /not verified|sandbox/i.test(message)
        ? ' — the SES account may still be in the sandbox, which only delivers to verified addresses'
        : '';
      this.log.warn(`could not email ${to}: ${message}${hint}`);
      return { sent: false, error: `${message}${hint}` };
    }
  }

  /**
   * A MIME message: text and HTML alternatives, plus an optional attachment.
   *
   * Two levels of nesting, and the order matters. `multipart/mixed` holds the
   * attachment; inside it `multipart/alternative` holds the two renderings of
   * the same message, plain text first. Mail clients take the *last* part they
   * understand, so HTML must come second or everybody reads the plain version.
   */
  private buildMime(
    to: string, subject: string, html: string, text: string, attachment?: Attachment,
  ): string {
    const mixed = `mixed_${Date.now().toString(36)}`;
    const alt = `alt_${Date.now().toString(36)}`;
    const enc = (s: string) => Buffer.from(s, 'utf8').toString('base64');

    /* Subjects carry Arabic, and a raw non-ASCII header is undefined behaviour.
       Encoded-word with base64 is the form every client handles. */
    const encodedSubject = /[^\x20-\x7E]/.test(subject)
      ? `=?UTF-8?B?${enc(subject)}?=`
      : subject;

    const parts = [
      `From: ${config.mail.fromName} <${config.mail.from}>`,
      `To: ${to}`,
      `Subject: ${encodedSubject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${mixed}"`,
      '',
      `--${mixed}`,
      `Content-Type: multipart/alternative; boundary="${alt}"`,
      '',
      `--${alt}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      enc(text),
      '',
      `--${alt}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      enc(html),
      '',
      `--${alt}--`,
      '',
    ];

    if (attachment) {
      parts.push(
        `--${mixed}`,
        `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${attachment.filename}"`,
        '',
        enc(attachment.content),
        '',
      );
    }

    parts.push(`--${mixed}--`, '');
    return parts.join('\r\n');
  }
}