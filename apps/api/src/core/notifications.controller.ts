/**
 * Reading notifications, and sending the ones that should also be emailed.
 *
 * `core_notifications` has been written to since the meeting-rooms module
 * shipped — invitations, responses, cancellations, time changes — and until now
 * nothing read it. There was no endpoint, no bell and no screen, so every one
 * of those rows was filed and never seen. This is the other half.
 */
import {
  Controller, Get, Injectable, Logger, Param, Post, Query,
} from '@nestjs/common';
import { CurrentUser, type Principal } from '../common/auth';
import { one, query } from '../common/db';
import { MailService } from './mail.service';

export interface NotificationView {
  id: string;
  moduleKey: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

@Injectable()
export class NotificationReadService {
  /**
   * The list, newest first.
   *
   * Capped rather than paged. A notification list is something people glance at
   * — the useful ones are from today — and a person who has ignored the bell
   * for a month is not helped by being able to scroll to the bottom of it.
   */
  async list(userId: string, limit = 30): Promise<NotificationView[]> {
    const rows = await query<any>(
      `SELECT id, module_key, severity, title, body, link, read_at, created_at
         FROM core_notifications
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`, [userId, Math.min(limit, 100)]);

    return rows.map((r) => ({
      id: r.id, moduleKey: r.module_key, severity: r.severity,
      title: r.title, body: r.body, link: r.link,
      readAt: r.read_at ? new Date(r.read_at).toISOString() : null,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  async unreadCount(userId: string): Promise<number> {
    const row = await one<{ n: string }>(
      `SELECT COUNT(*) AS n FROM core_notifications
        WHERE user_id = $1 AND read_at IS NULL`, [userId]);
    return Number(row?.n ?? 0);
  }

  /** Scoped to the caller, so an id from somewhere else marks nothing. */
  async markRead(userId: string, id: string): Promise<void> {
    await query(
      `UPDATE core_notifications SET read_at = now()
        WHERE id = $1 AND user_id = $2 AND read_at IS NULL`, [id, userId]);
  }

  async markAllRead(userId: string): Promise<number> {
    const rows = await query(
      `UPDATE core_notifications SET read_at = now()
        WHERE user_id = $1 AND read_at IS NULL RETURNING id`, [userId]);
    return rows.length;
  }
}

/**
 * Sends the emails that notifications ask for.
 *
 * Separate from writing the notification, and deliberately so: the write
 * happens inside the transaction that books the meeting, and an email must
 * never be able to roll that back. SES being slow, or the sandbox refusing an
 * address, is not a reason to refuse a booking.
 *
 * So a notification is written with `email_sent_at` null and a payload saying
 * what to send, and this picks it up a moment later. If the process dies in
 * between, the row is still there and the next sweep finds it — which is what
 * the column is for.
 */
@Injectable()
export class NotificationMailer {
  private readonly log = new Logger('NotificationMailer');

  constructor(private mail: MailService) {}

  /**
   * Record the outcome against the notification.
   *
   * A failure is written to `email_error` rather than only logged. The
   * difference matters: a log line is gone in a week and nobody reads it, while
   * a column can be queried when somebody asks why a colleague never heard
   * about a meeting.
   */
  async deliver(
    notificationId: string, to: string, subject: string,
    html: string, text: string, ics?: string, icsName = 'meeting.ics',
  ): Promise<void> {
    const result = await this.mail.send(to, subject, html, text,
      ics ? { filename: icsName, contentType: 'text/calendar; charset=utf-8; method=PUBLISH', content: ics } : undefined);

    if (result.sent) {
      await query(
        `UPDATE core_notifications SET email_sent_at = now(), email_error = NULL
          WHERE id = $1`, [notificationId]);
      return;
    }

    /* Mail being switched off is not an error worth recording on every row --
       it is a development machine behaving as configured. Anything else is. */
    const off = result.error?.includes('MAIL_ENABLED');
    await query(
      `UPDATE core_notifications
          SET email_sent_at = $2, email_error = $3
        WHERE id = $1`,
      [notificationId, off ? new Date() : null, off ? null : (result.error ?? 'unknown')]);

    if (!off) this.log.warn(`notification ${notificationId}: ${result.error}`);
  }
}

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationReadService) {}

  /* No permission key. Notifications are addressed to one person and the query
     is scoped to them, so there is nothing here that a role could usefully
     gate: everybody may read their own, and nobody can read anybody else's. */
  @Get()
  async list(@CurrentUser() p: Principal, @Query('limit') limit?: string) {
    const [items, unread] = await Promise.all([
      this.notifications.list(p.id, limit ? parseInt(limit, 10) : 30),
      this.notifications.unreadCount(p.id),
    ]);
    return { notifications: items, unread };
  }

  @Post(':id/read')
  async read(@CurrentUser() p: Principal, @Param('id') id: string) {
    await this.notifications.markRead(p.id, id);
    return { unread: await this.notifications.unreadCount(p.id) };
  }

  @Post('read-all')
  async readAll(@CurrentUser() p: Principal) {
    return { cleared: await this.notifications.markAllRead(p.id) };
  }
}