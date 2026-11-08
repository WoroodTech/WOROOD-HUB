/**
 * People asking for an account.
 *
 * The form is open to anyone who can reach the portal, which is deliberate:
 * approval is the gate, not the form. What that costs is handled here --
 * nothing a stranger submits can tell them anything they did not already
 * know, and nothing they submit becomes a user until somebody says so.
 */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { one, query, tx } from '../../common/db';
import { Principal } from '../../common/auth';
import { config } from '../../common/config';
import { AuditService, NotificationsService } from '../../core/core.module';
import { MailService } from '../../core/mail.service';
import { approvedMail, refusedMail } from './signup-mail';

/** Who may act on these. */
export const REVIEW = 'core.signup.review';

@Injectable()
export class SignupService {
  private readonly log = new Logger('Signup');

  constructor(
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    /* Optional, like everywhere else that sends: a server with mail off runs
       the whole module and simply tells nobody. */
    private readonly mailer?: MailService,
  ) {}

  /** The departments the form can offer. */
  async departments() {
    /* `core_departments` has no Arabic name and no soft delete — the names
       are the only thing the form needs, and this is what the table holds. */
    const rows = await query<any>(
      `SELECT id, name FROM core_departments ORDER BY name`);
    return rows.map((r) => ({ id: r.id, name: r.name }));
  }

  /**
   * Ask for an account.
   *
   * Answers the same way whatever happens. An address that already has an
   * account, one with a request already waiting, and a brand new one all get
   * the same reply, because a different answer for each is a way to ask the
   * portal who works here -- try an address, read the error. Everything real
   * is decided by a reviewer afterwards.
   */
  async request(dto: {
    email: string; password: string; fullName: string; departmentId: string;
  }, ip: string | null) {
    const email = dto.email.trim().toLowerCase();
    const fullName = dto.fullName.trim();

    /*
     * A ceiling per address, per hour.
     *
     * The form is open to anyone who can reach the portal, so without this a
     * script can fill the review screen faster than anybody can clear it --
     * and the reviewers are the defence, so burying them defeats the design.
     *
     * Counted from the table rather than from a cache: the rows are already
     * here with their times on them, and a counter in Redis would be a second
     * store to keep and an import from another module to get at it.
     *
     * Over the limit is answered exactly like everything else. A stranger who
     * can tell "too many attempts" from "received" has learned something.
     */
    const recent = await one<any>(
      `SELECT count(*) AS n FROM core_signup_requests
        WHERE (lower(email) = $1 OR ($2::text IS NOT NULL AND requested_ip = $2))
          AND created_at > now() - interval '1 hour'`,
      [email, ip]);
    if (Number(recent?.n ?? 0) >= 5) {
      this.log.warn(`sign-up rate limit reached for ${email} / ${ip ?? 'no ip'}`);
      return this.sameAnswer();
    }

    const department = await one<any>(
      `SELECT id FROM core_departments WHERE id = $1`, [dto.departmentId]);
    /* The one thing worth refusing outright: the department list came from
       us a moment ago, so a value not in it is a tampered form rather than a
       person making a mistake. */
    if (!department) throw new BadRequestException('Choose a department from the list.');

    /* Hashed before it is stored, not when it is approved. The request may
       sit for days, and a plain password waiting in a table is a plain
       password whatever becomes of the request. */
    const passwordHash = await bcrypt.hash(dto.password, 12);

    /*
     * Only a live account blocks a request.
     *
     * An address whose account was removed is free to ask again: somebody who
     * left and came back is a person, not a new problem. Approval revives
     * that row rather than making a second one -- see `approve` -- so the
     * UNIQUE constraint on `email` is never challenged.
     */
    const taken = await one<any>(
      `SELECT 1 FROM core_users WHERE lower(email) = $1 AND deleted_at IS NULL`,
      [email]);

    if (taken) {
      /* Recorded and left, so a reviewer can see somebody tried -- which is
         worth knowing if it was not the account's owner. */
      this.log.warn(`sign-up for ${email}, which already has an account`);
      return this.sameAnswer();
    }

    let recorded = false;
    try {
      await query(
        `INSERT INTO core_signup_requests
           (email, full_name, password_hash, department_id, requested_ip)
         VALUES ($1,$2,$3,$4,$5)`,
        [email, fullName, passwordHash, dto.departmentId, ip]);
      recorded = true;
    } catch (e: any) {
      /* The partial unique index: a request for this address is already
         waiting. Also the same answer -- somebody pressing the button twice
         should not be told their first attempt exists. */
      if (e?.code !== '23505') throw e;
    }

    /*
     * Tell the people who can act on it.
     *
     * The bell, not e-mail. A reviewer who gets a message for every stranger
     * who fills in a form learns to ignore mail from this portal, and the one
     * that mattered goes with the rest. The bell is where work waiting on
     * somebody already lives.
     *
     * Outside the catch above on purpose: that one swallows a duplicate-key
     * error, and a notification failing is a different thing that should not
     * disappear into it. And only when something was actually recorded -- a
     * duplicate leaves the queue unchanged, so there is nothing new to see.
     */
    if (recorded) {
      try {
        await this.notifications.notifyPermissionHolders(
          REVIEW, 'administration',
          'Someone has asked for an account',
          `${fullName} (${email}) is waiting for approval.`,
          'INFO',
          /* Where the work is. Without it the notification is a sentence with
             nowhere to go, and the reader has to find the screen themselves —
             which is the thing it was meant to save them. */
          '/admin/signups');
      } catch (e: any) {
        /* Never fails the request: the row is in, and a reviewer will see it
           on the screen whether or not the bell rang. */
        this.log.warn(`could not raise the sign-up notification: ${e?.message ?? e}`);
      }
    }

    return this.sameAnswer();
  }

  /** The one reply the form ever gives. */
  private sameAnswer() {
    return {
      received: true,
      message:
        'Your request has been sent. Somebody will review it, and you will get '
        + 'an e-mail either way. You cannot sign in until it is approved.',
    };
  }

  /** What is waiting, for the review screen. */
  async pending(_p: Principal) {
    const rows = await query<any>(
      `SELECT s.id, s.email, s.full_name, s.created_at,
              d.name AS department_name
         FROM core_signup_requests s
         JOIN core_departments d ON d.id = s.department_id
        WHERE s.status = 'PENDING'
        ORDER BY s.created_at`);
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      fullName: r.full_name,
      departmentName: r.department_name,
      requestedAt: r.created_at,
    }));
  }

  /** The ones already dealt with, newest first. */
  async decided(_p: Principal, limit = 50) {
    const rows = await query<any>(
      `SELECT s.id, s.email, s.full_name, s.status, s.decided_at, s.reason,
              d.name AS department_name, u.full_name AS decided_by
         FROM core_signup_requests s
         JOIN core_departments d ON d.id = s.department_id
         LEFT JOIN core_users u ON u.id = s.decided_by_id
        WHERE s.status <> 'PENDING'
        ORDER BY s.decided_at DESC
        LIMIT $1`, [limit]);
    return rows.map((r) => ({
      id: r.id, email: r.email, fullName: r.full_name, status: r.status,
      departmentName: r.department_name, decidedBy: r.decided_by,
      decidedAt: r.decided_at, reason: r.reason,
    }));
  }

  /**
   * Approve: make the account.
   *
   * The password they chose is carried across as it was hashed on arrival, so
   * they sign in with what they typed and nobody has to send them one.
   *
   * `employee` and nothing else. Whatever they need beyond that is a
   * deliberate grant on the Administration screen, not a side effect of
   * being let in.
   */
  async approve(p: Principal, id: string) {
    const row = await one<any>(
      `SELECT * FROM core_signup_requests WHERE id = $1`, [id]);
    if (!row) throw new NotFoundException('No such request.');
    if (row.status !== 'PENDING') {
      throw new BadRequestException('That request has already been decided.');
    }

    /*
     * Who, if anyone, already holds this address.
     *
     * Checked again here rather than only at request time: days can pass
     * between asking and deciding, and somebody may have been given an
     * account in between.
     *
     * `core_users.email` is UNIQUE with no condition on it, and deletion is
     * soft -- so a removed account still holds its address, and inserting a
     * second row for it would fail on the constraint. That is why one is
     * revived below rather than replaced.
     */
    const existing = await one<any>(
      `SELECT id, deleted_at FROM core_users WHERE lower(email) = $1`, [row.email]);

    if (existing && !existing.deleted_at) {
      throw new BadRequestException(
        `${row.email} already has an account. Refuse this request instead.`);
    }

    const created = await tx(async (c) => {
      let userId: string;

      if (existing) {
        /*
         * Somebody who left and came back.
         *
         * The same row, revived: the id does not change, so everything
         * attached to it comes back with it -- the expense requests they
         * raised, the approvals they gave, their notifications. A second row
         * would leave all of that pointing at an account nobody can sign in
         * to, and the portal would hold two people where there is one.
         *
         * Name, department and password come from what they just asked with.
         * Those are current; whatever the old row holds is however long out
         * of date.
         *
         * `locked_until` is cleared because a lock is a response to failed
         * sign-ins against an account that no longer exists.
         */
        userId = existing.id;
        await c.query(
          `UPDATE core_users
              SET deleted_at = NULL, status = 'ACTIVE',
                  password_hash = $2, full_name = $3, department_id = $4,
                  locked_until = NULL, updated_at = now()
            WHERE id = $1`,
          [userId, row.password_hash, row.full_name, row.department_id]);
      } else {
        const { rows: made } = await c.query(
          `INSERT INTO core_users
             (email, password_hash, full_name, department_id, status, timezone, locale)
           VALUES ($1,$2,$3,$4,'ACTIVE','Africa/Cairo','en')
           RETURNING id`,
          [row.email, row.password_hash, row.full_name, row.department_id]);
        userId = made[0].id;
      }

      /*
       * `employee`, alongside whatever they held before.
       *
       * Deleting an account does not touch `core_user_roles`, so a revived
       * one still carries its old roles and keeps them. A new account gets
       * `employee` alone; anything beyond that is a deliberate grant on the
       * Roles screen.
       */
      await c.query(
        `INSERT INTO core_user_roles (user_id, role_id)
         SELECT $1, id FROM core_roles WHERE key = 'employee'
         ON CONFLICT DO NOTHING`, [userId]);

      await c.query(
        `UPDATE core_signup_requests
            SET status='APPROVED', decided_by_id=$2, decided_at=now(), user_id=$3
          WHERE id=$1`, [id, p.id, userId]);

      return userId;
    });

    await this.audit.write({
      actorId: p.id, moduleKey: 'administration', action: 'signup.approve',
      entityType: 'core_signup_request', entityId: id,
      /* Worth recording which it was: a revived account arrives with its
         history and roles already on it, and somebody reading the log later
         should not have to work that out. */
      payload: { email: row.email, userId: created, revived: !!existing },
    });

    await this.tell(row.email, approvedMail(row.full_name));
    return { ok: true, userId: created };
  }

  /** Refuse, with a reason the person will read. */
  async reject(p: Principal, id: string, reason: string) {
    const text = (reason ?? '').trim();
    if (!text) {
      /* Required, because the e-mail carries it and "no" with nothing after
         it leaves somebody who may well belong here with nothing to do. */
      throw new BadRequestException('Give a reason — it is sent to them.');
    }

    const row = await one<any>(
      `SELECT * FROM core_signup_requests WHERE id = $1`, [id]);
    if (!row) throw new NotFoundException('No such request.');
    if (row.status !== 'PENDING') {
      throw new BadRequestException('That request has already been decided.');
    }

    await query(
      `UPDATE core_signup_requests
          SET status='REJECTED', decided_by_id=$2, decided_at=now(), reason=$3
        WHERE id=$1`, [id, p.id, text]);

    await this.audit.write({
      actorId: p.id, moduleKey: 'administration', action: 'signup.reject',
      entityType: 'core_signup_request', entityId: id,
      payload: { email: row.email, reason: text },
    });

    await this.tell(row.email, refusedMail(row.full_name, text));
    return { ok: true };
  }

  /**
   * Send the decision.
   *
   * Never throws. The decision is already recorded and the account already
   * made; failing the reviewer's request because a mail server was slow would
   * tell them nothing happened when it did.
   */
  private async tell(to: string, mail: { subject: string; html: string; text: string }) {
    if (!this.mailer) return;
    try {
      await this.mailer.send(to, mail.subject, mail.html, mail.text);
    } catch (e: any) {
      this.log.error(`could not e-mail ${to}: ${e?.message ?? e}`);
    }
  }
}