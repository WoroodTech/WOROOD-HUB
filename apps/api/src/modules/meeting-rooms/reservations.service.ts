/**
 * Making, changing and cancelling a booking.
 *
 * Two rules run through everything here:
 *
 * 1. **The database owns the double-booking guarantee, not this file.** There
 *    is a pre-flight check, and it exists only to produce a good error message
 *    quickly. The check-then-insert pattern is a race by construction -- two
 *    requests can both pass the check before either writes -- so the authority
 *    is the GiST exclusion constraint from migration 0002, and `23P01` is
 *    caught and reported as a conflict. If the pre-flight check were deleted,
 *    the system would still be correct; only the wording would get worse.
 *
 * 2. **Whose booking it is decides who may touch it.** An employee may change
 *    their own. Someone holding `reservation.manage-any` may change anyone's.
 *    Nobody may change one that has already been cancelled, and nothing that
 *    has already finished can be edited into the past.
 */

import {
  BadRequestException, ConflictException, ForbiddenException,
  Injectable, NotFoundException,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import { one, query, tx } from '../../common/db';
import { can, type Principal } from '../../common/auth';
import { NotificationsService } from '../../core/core.module';
import { MR_PERMISSIONS } from './permissions';
import type {
  CancelReservation, CreateReservation, ListReservationsQuery,
  RespondToInvitation, UpdateReservation,
} from './dto';
import { RoomsService, type RoomView } from './rooms.service';
import { BOOKING_LIMITS, computeBlockedTimeline, type TaggedInterval } from './slots';

export interface ReservationView {
  id: string; reference: string; title: string; description: string | null;
  startsAt: string; endsAt: string; status: string; attendeeCount: number;
  room: { id: string; name: string; nameAr: string | null; floor: string | null; capacity: number; location: string };
  organiser: { id: string; fullName: string; email: string };
  attendees: Array<{ userId: string | null; name: string; email: string; response: string; respondedAt: string | null }>;
  cancelledAt: string | null; cancellationReason: string | null;
  /** What the caller is to this meeting. Computed here so no screen has to
   *  compare ids and get it wrong. */
  myRole: 'organiser' | 'attendee' | 'none';
  /** Their own answer, when they are an attendee. */
  myResponse: 'INVITED' | 'ACCEPTED' | 'DECLINED' | null;
  /** Whether *this* caller may edit or cancel it -- computed here so the
   *  portal never has to re-derive the permission rule and get it wrong. */
  canManage: boolean;
}

const RESERVATION_SELECT = `
  SELECT res.id, res.reference, res.title, res.description, res.starts_at, res.ends_at,
         res.status, res.attendees AS attendee_count, res.cancelled_at, res.cancellation_reason,
         res.organizer_id,
         rm.id AS room_id, rm.name AS room_name, rm.name_ar AS room_name_ar,
         rm.floor AS room_floor, rm.capacity AS room_capacity, l.name AS location_name,
         u.full_name AS organiser_name, u.email AS organiser_email,
         COALESCE(
           (SELECT json_agg(json_build_object(
                     'userId', a.user_id,
                     'name', COALESCE(au.full_name, a.external_name, a.external_email),
                     'email', COALESCE(au.email, a.external_email),
                     'response', a.response,
                     'respondedAt', a.responded_at) ORDER BY COALESCE(au.full_name, a.external_name))
              FROM mr_reservation_attendees a
              LEFT JOIN core_users au ON au.id = a.user_id
             WHERE a.reservation_id = res.id),
           '[]'::json) AS attendees_json
    FROM mr_reservations res
    JOIN mr_rooms rm     ON rm.id = res.room_id
    JOIN mr_locations l  ON l.id = rm.location_id
    JOIN core_users u    ON u.id = res.organizer_id`;

@Injectable()
export class ReservationsService {
  constructor(
    private readonly rooms: RoomsService,
    private readonly notifications: NotificationsService,
  ) { }

  private view(r: any, p: Principal): ReservationView {
    return {
      id: r.id, reference: r.reference, title: r.title, description: r.description,
      startsAt: new Date(r.starts_at).toISOString(),
      endsAt: new Date(r.ends_at).toISOString(),
      status: r.status, attendeeCount: r.attendee_count,
      room: {
        id: r.room_id, name: r.room_name, nameAr: r.room_name_ar,
        floor: r.room_floor, capacity: r.room_capacity, location: r.location_name,
      },
      organiser: { id: r.organizer_id, fullName: r.organiser_name, email: r.organiser_email },
      attendees: r.attendees_json ?? [],
      cancelledAt: r.cancelled_at ? new Date(r.cancelled_at).toISOString() : null,
      cancellationReason: r.cancellation_reason,
      canManage: this.mayManage(p, r.organizer_id),
      myRole: r.organizer_id === p.id
        ? 'organiser'
        : (r.attendees_json ?? []).some((a: any) => a.userId === p.id) ? 'attendee' : 'none',
      myResponse: (r.attendees_json ?? []).find((a: any) => a.userId === p.id)?.response ?? null,
    };
  }

  private mayManage(p: Principal, organiserId: string): boolean {
    return p.id === organiserId || can(p, MR_PERMISSIONS.MANAGE_ANY);
  }

  /* --------------------------------------------------------------- reads -- */

  async list(p: Principal, q: ListReservationsQuery) {
    const where: string[] = [];
    const params: any[] = [];

    /* `scope=all` is not a filter, it is a privilege. Asking for it without
       the permission narrows silently back to your own rather than failing --
       the screen still works, it just shows what you are entitled to see. */
    const wantsAll = q.scope === 'all' && can(p, MR_PERMISSIONS.MANAGE_ANY);
    const scope = wantsAll ? 'all' : (q.scope === 'all' ? 'mine' : q.scope ?? 'mine');

    /* A meeting somebody booked *for* you is one of yours. Before invitations
       existed this asked only for `organizer_id = me`, which is why an invited
       employee saw nothing at all. */
    const invitedClause = (idx: number) =>
      `EXISTS (SELECT 1 FROM mr_reservation_attendees a
                WHERE a.reservation_id = res.id AND a.user_id = $${idx})`;

    if (scope === 'mine') {
      params.push(p.id);
      where.push(`(res.organizer_id = $${params.length} OR ${invitedClause(params.length)})`);
    } else if (scope === 'invited') {
      params.push(p.id);
      where.push(invitedClause(params.length));
      // Their own meeting is not an invitation, even if they are also listed.
      where.push(`res.organizer_id <> $${params.length}`);
    } else if (scope === 'organised') {
      params.push(p.id);
      where.push(`res.organizer_id = $${params.length}`);
    }

    const period = q.period ?? 'upcoming';
    if (period === 'upcoming') where.push(`res.ends_at > now()`);
    if (period === 'past') where.push(`res.ends_at <= now()`);

    if (q.status) { params.push(q.status); where.push(`res.status = $${params.length}`); }
    else if (period === 'upcoming') where.push(`res.status IN ('PENDING','CONFIRMED')`);

    if (q.roomId) { params.push(q.roomId); where.push(`res.room_id = $${params.length}`); }

    const limit = Math.min(q.limit ?? 50, 200);
    params.push(limit, q.offset ?? 0);

    const rows = await query(
      `${RESERVATION_SELECT}
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY res.starts_at ${period === 'past' ? 'DESC' : 'ASC'}
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

    return { reservations: rows.map((r) => this.view(r, p)), scope, period };
  }

  async get(p: Principal, id: string): Promise<ReservationView> {
    const row = await one(`${RESERVATION_SELECT} WHERE res.id = $1`, [id]);
    if (!row) throw new NotFoundException('Reservation not found');
    /* Not a permission check -- anyone in the company may see that a room is
       taken and by whom. Editing is what is gated. */
    return this.view(row, p);
  }

 async calendar(
  p: Principal,
  roomId: string,
  date: string,
): Promise<{
  room: {
    id: string;
    name: string;
    nameAr: string | null;
    opensAt: string;
    closesAt: string;
    bufferMinutes: number;
  };
  date: string;
  blocks: Array<
    | {
        type: 'BOOKING';
        id: string;
        reference: string;
        title: string;
        startsAt: string;
        endsAt: string;
        status: string;
        organiserName: string;
        isMine: boolean;
        canManage: boolean;
      }
    | {
        type: 'BLACKOUT';
        startsAt: string;
        endsAt: string;
        reason: string | null;
      }
    | {
        type: 'BUFFER';
        startsAt: string;
        endsAt: string;
      }
  >;
}> {
  const room = await this.rooms.get(roomId);
  const zone = room.location.timezone;

  const day = DateTime.fromISO(date, { zone });

  if (!day.isValid) {
    throw new BadRequestException(`${date} is not a real date`);
  }

  const dayStart = day.startOf('day').toJSDate();
  const dayEnd = day.endOf('day').toJSDate();

  /*
   * Widened by the buffer either side, so a booking that sits just outside
   * today's bounds but whose changeover bleeds into today is not missed.
   */
  const bufferMs = room.bufferMinutes * 60_000;

  const queryFrom = new Date(dayStart.getTime() - bufferMs);
  const queryTo = new Date(dayEnd.getTime() + bufferMs);

  const [reservations, blackouts] = await Promise.all([
    query(
      `SELECT
         res.id,
         res.reference,
         res.title,
         res.starts_at,
         res.ends_at,
         res.status,
         res.organizer_id,
         u.full_name AS organiser_name
       FROM mr_reservations res
       JOIN core_users u ON u.id = res.organizer_id
       WHERE res.room_id = $1
         AND res.status IN ('PENDING', 'CONFIRMED')
         AND res.starts_at < $3
         AND res.ends_at > $2
       ORDER BY res.starts_at ASC`,
      [roomId, queryFrom, queryTo],
    ),

    query(
      `SELECT
         id,
         starts_at,
         ends_at,
         reason
       FROM mr_room_blackouts
       WHERE room_id = $1
         AND starts_at < $3
         AND ends_at > $2
       ORDER BY starts_at ASC`,
      [roomId, queryFrom, queryTo],
    ),
  ]);

  type Ref =
    | {
        kind: 'BOOKING';
        row: (typeof reservations)[number];
      }
    | {
        kind: 'BLACKOUT';
        row: (typeof blackouts)[number];
      };

  const items: TaggedInterval<Ref>[] = [
    ...reservations.map(
      (r): TaggedInterval<Ref> => ({
        start: new Date(r.starts_at),
        end: new Date(r.ends_at),
        kind: 'BOOKING',
        ref: {
          kind: 'BOOKING',
          row: r,
        },
      }),
    ),

    ...blackouts.map(
      (b): TaggedInterval<Ref> => ({
        start: new Date(b.starts_at),
        end: new Date(b.ends_at),
        kind: 'BLACKOUT',
        ref: {
          kind: 'BLACKOUT',
          row: b,
        },
      }),
    ),
  ];

  const timeline = computeBlockedTimeline(
    items,
    room.bufferMinutes,
  );

  /*
   * Clip to the requested calendar day.
   * The widened query above can bring in a buffer edge that starts
   * before midnight or ends after it.
   */
  const blocks = timeline
    .map((b) => {
      const start = b.start < dayStart ? dayStart : b.start;
      const end = b.end > dayEnd ? dayEnd : b.end;

      return {
        ...b,
        start,
        end,
      };
    })
    .filter((b) => b.start < b.end)
    .map((b) => {
      const startsAt =
        DateTime.fromJSDate(b.start)
          .setZone(zone)
          .toISO()!;

      const endsAt =
        DateTime.fromJSDate(b.end)
          .setZone(zone)
          .toISO()!;

      if (b.kind === 'BUFFER') {
        return {
          type: 'BUFFER' as const,
          startsAt,
          endsAt,
        };
      }

      const ref = (b as { ref: Ref }).ref;

      if (ref.kind === 'BOOKING') {
        const r = ref.row;

        return {
          type: 'BOOKING' as const,
          id: r.id,
          reference: r.reference,
          title: r.title,
          startsAt,
          endsAt,
          status: r.status,
          organiserName: r.organiser_name,
          isMine: r.organizer_id === p.id,
          canManage: this.mayManage(
            p,
            r.organizer_id,
          ),
        };
      }

      const bl = ref.row;

      return {
        type: 'BLACKOUT' as const,
        startsAt,
        endsAt,
        reason: bl.reason,
      };
    });

  return {
    room: {
      id: room.id,
      name: room.name,
      nameAr: room.nameAr,
      opensAt: room.opensAt,
      closesAt: room.closesAt,
      bufferMinutes: room.bufferMinutes,
    },
    date,
    blocks,
  };
}

  /* -------------------------------------------------------------- writes -- */

  async create(p: Principal, dto: CreateReservation): Promise<ReservationView> {
    const room = await this.rooms.get(dto.roomId);
    const start = new Date(dto.startsAt);
    const end = new Date(dto.endsAt);
    /* If you named five colleagues, six people are coming -- them and you. Only
       fall back to the explicit count when no guest list was given, so the
       capacity check is against reality rather than against a field somebody
       forgot to update after adding a name. */
    const attendeeCount = dto.attendeeCount
      ?? (dto.attendeeUserIds?.length ? dto.attendeeUserIds.length + 1 : 1);
    this.assertBookable(room, start, end, attendeeCount);

    await this.assertFree(room, start, end, null);

    const status = room.requiresApproval ? 'PENDING' : 'CONFIRMED';

    const id = await tx(async (c) => {
      let row;
      try {
        row = (await c.query(
          `INSERT INTO mr_reservations
             (reference, room_id, organizer_id, title, description, starts_at, ends_at, attendees, status)
           VALUES ('MR-' || to_char(now(), 'YYYY') || '-' ||
                   lpad(nextval('mr_reservation_reference_seq')::text, 4, '0'),
                   $1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id`,
          [room.id, p.id, dto.title, dto.description ?? null, start, end,
            attendeeCount, status],
        )).rows[0];
      } catch (e: any) {
        // 23P01: the exclusion constraint. Someone took the slot between the
        // pre-flight check and this insert -- which is exactly why it exists.
        if (e.code === '23P01') throw this.taken(room);
        throw e;
      }
      await this.replaceAttendees(c, row.id, dto.attendeeUserIds);
      return row.id as string;
    });

    const reservation = await this.get(p, id);
    await this.inviteAll(p, reservation, dto.attendeeUserIds ?? []);
    return reservation;
  }

  async update(p: Principal, id: string, dto: UpdateReservation): Promise<ReservationView> {
    const existing = await one(
      `SELECT id, room_id, organizer_id, status, starts_at, ends_at, attendees
         FROM mr_reservations WHERE id = $1`, [id]);
    if (!existing) throw new NotFoundException('Reservation not found');

    if (!this.mayManage(p, existing.organizer_id)) {
      throw new ForbiddenException('This is not your reservation');
    }
    if (existing.status === 'CANCELLED') {
      throw new ConflictException('This reservation was cancelled. Make a new booking instead.');
    }
    if (new Date(existing.ends_at) <= new Date()) {
      throw new ConflictException('This meeting has already finished.');
    }

    const before = await this.get(p, id);
    const room = await this.rooms.get(dto.roomId ?? existing.room_id);
    const start = dto.startsAt ? new Date(dto.startsAt) : new Date(existing.starts_at);
    const end = dto.endsAt ? new Date(dto.endsAt) : new Date(existing.ends_at);
    const attendeeCount = dto.attendeeCount
      ?? (dto.attendeeUserIds ? dto.attendeeUserIds.length + 1 : existing.attendees);

    this.assertBookable(room, start, end, attendeeCount);
    // Exclude itself: moving a meeting fifteen minutes must not clash with
    // where it currently is.
    await this.assertFree(room, start, end, id);

    await tx(async (c) => {
      try {
        await c.query(
          `UPDATE mr_reservations
              SET room_id = $1, title = COALESCE($2, title), description = COALESCE($3, description),
                  starts_at = $4, ends_at = $5, attendees = $6
            WHERE id = $7`,
          [room.id, dto.title ?? null, dto.description ?? null, start, end, attendeeCount, id]);
      } catch (e: any) {
        if (e.code === '23P01') throw this.taken(room);
        throw e;
      }
      if (dto.attendeeUserIds !== undefined) await this.replaceAttendees(c, id, dto.attendeeUserIds);
    });

    const after = await this.get(p, id);

    /* Two different messages, because they are two different situations. Being
       newly added is news; a meeting you already knew about moving is a
       correction, and telling the second group they have been "invited" would
       be wrong. */
    const wasInvited = new Set(before.attendees.map((a) => a.userId).filter(Boolean) as string[]);
    const nowInvited = (dto.attendeeUserIds ?? [...wasInvited]).filter((uid) => uid !== p.id);

    await this.inviteAll(p, after, nowInvited.filter((uid) => !wasInvited.has(uid)));

    const moved = start.getTime() !== new Date(existing.starts_at).getTime()
      || end.getTime() !== new Date(existing.ends_at).getTime()
      || room.id !== existing.room_id;
    if (moved) {
      const keeping = nowInvited.filter((uid) => wasInvited.has(uid));
      await this.tellAll(keeping, 'Meeting moved',
        `"${after.title}" is now ${this.whenText(after, room)}.`, `/meeting-rooms/reservations`);
    }

    return after;
  }

  async cancel(p: Principal, id: string, dto: CancelReservation): Promise<ReservationView> {
    const existing = await one(
      `SELECT id, organizer_id, status FROM mr_reservations WHERE id = $1`, [id]);
    if (!existing) throw new NotFoundException('Reservation not found');
    if (!this.mayManage(p, existing.organizer_id)) {
      throw new ForbiddenException('This is not your reservation');
    }
    // Cancelling twice is not an error; it is the state the caller wanted.
    if (existing.status !== 'CANCELLED') {
      const before = await this.get(p, id);
      await query(
        `UPDATE mr_reservations
            SET status = 'CANCELLED', cancelled_by_id = $1, cancelled_at = now(),
                cancellation_reason = $2
          WHERE id = $3`, [p.id, dto.reason ?? null, id]);

      // Anyone who had it in their calendar needs to know it is gone. Silence
      // here means people turning up to an empty room.
      const guests = before.attendees.map((a) => a.userId).filter((x): x is string => !!x && x !== p.id);
      await this.tellAll(guests, 'Meeting cancelled',
        `"${before.title}" has been cancelled${dto.reason ? `: ${dto.reason}` : '.'}`,
        '/meeting-rooms/reservations', 'WARNING');
    }
    return this.get(p, id);
  }

  /**
   * Accepting or declining an invitation.
   *
   * Only the invited person may answer, and only for themselves -- an organiser
   * marking someone as attending on their behalf is a guess recorded as a fact.
   * Declining does not remove them from the meeting: the organiser needs to see
   * that they were asked and said no, which is different from never being asked.
   */
  async respond(p: Principal, id: string, dto: RespondToInvitation): Promise<ReservationView> {
    const row = await one(
      `SELECT a.id, res.status, res.ends_at, res.title
         FROM mr_reservation_attendees a
         JOIN mr_reservations res ON res.id = a.reservation_id
        WHERE a.reservation_id = $1 AND a.user_id = $2`, [id, p.id]);
    if (!row) throw new NotFoundException('You are not invited to that meeting');
    if (row.status === 'CANCELLED') throw new ConflictException('That meeting was cancelled.');
    if (new Date(row.ends_at) <= new Date()) throw new ConflictException('That meeting has already finished.');

    await query(
      `UPDATE mr_reservation_attendees
          SET response = $1, responded_at = now()
        WHERE reservation_id = $2 AND user_id = $3`, [dto.response, id, p.id]);

    const reservation = await this.get(p, id);
    // The organiser asked a question; they should get the answer.
    if (reservation.organiser.id !== p.id) {
      await this.notifications.notify(
        reservation.organiser.id, 'meeting-rooms',
        `${p.fullName} ${dto.response === 'ACCEPTED' ? 'accepted' : 'declined'}`,
        `"${reservation.title}" — ${reservation.reference}`,
        'INFO', '/meeting-rooms/reservations');
    }
    return reservation;
  }

  /* ---------------------------------------------------------- validation -- */

  private assertBookable(room: RoomView, start: Date, end: Date, attendeeCount: number): void {
    if (!(start instanceof Date) || Number.isNaN(start.getTime())) throw new BadRequestException('Invalid start time');
    if (!(end instanceof Date) || Number.isNaN(end.getTime())) throw new BadRequestException('Invalid end time');
    if (end <= start) throw new BadRequestException('The meeting must end after it starts');

    if (room.status !== 'ACTIVE') {
      throw new ConflictException(
        room.status === 'MAINTENANCE'
          ? `${room.name} is under maintenance and is not taking bookings.`
          : `${room.name} is not available for booking.`);
    }

    if (attendeeCount > room.capacity) {
      throw new BadRequestException(
        `${room.name} seats ${room.capacity}. You have ${attendeeCount} attending.`);
    }

    /* Duration limits are the system's, not the room's. A room used to be able
       to refuse a twenty-minute meeting because its owner had set a
       thirty-minute floor, which is the constraint people worked around rather
       than with. What is left is a floor that rules out a mis-typed one-minute
       booking and a ceiling that stops a room being held all day. */
    const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
    if (minutes < BOOKING_LIMITS.MIN_MINUTES) {
      throw new BadRequestException(
        `A meeting must be at least ${BOOKING_LIMITS.MIN_MINUTES} minutes long.`);
    }
    if (minutes > BOOKING_LIMITS.MAX_MINUTES) {
      throw new BadRequestException(
        `A meeting cannot be longer than ${BOOKING_LIMITS.MAX_MINUTES / 60} hours.`);
    }

    const zone = room.location.timezone;
    const localStart = DateTime.fromJSDate(start).setZone(zone);
    const localEnd = DateTime.fromJSDate(end).setZone(zone);

    if (localStart < DateTime.now().setZone(zone)) {
      throw new BadRequestException('That time has already passed.');
    }

    const horizon = DateTime.now().setZone(zone).startOf('day').plus({ days: room.maxAdvanceDays });
    if (localStart > horizon.endOf('day')) {
      throw new BadRequestException(`${room.name} can only be booked ${room.maxAdvanceDays} days ahead.`);
    }

    /* Midnight is tested before opening hours, not after. A window running into
       tomorrow also falls outside today's closing time, so with the old order
       this check could never fire and the employee was told the room's hours
       when the real problem was the date. The specific message goes first. */
    if (!localEnd.hasSame(localStart, 'day')) {
      throw new BadRequestException('A booking cannot run past midnight.');
    }

    /* Opening hours are compared as wall-clock in the room's own zone -- the
       whole reason the location carries a timezone at all. */
    const opens = localStart.startOf('day').plus(minutesOf(room.opensAt));
    const closes = localStart.startOf('day').plus(minutesOf(room.closesAt));
    if (localStart < opens || localEnd > closes) {
      throw new BadRequestException(
        `${room.name} is open ${room.opensAt}–${room.closesAt}. Choose a time inside those hours.`);
    }
  }

  /** Pre-flight only. See the note at the top of this file: the guarantee is
   *  the constraint's, and this exists to say *who* has the room. */
  private async assertFree(room: RoomView, start: Date, end: Date, excludeId: string | null): Promise<void> {
    const bufferMs = room.bufferMinutes * 60_000;
    const from = new Date(start.getTime() - bufferMs);
    const to = new Date(end.getTime() + bufferMs);

    const clash = await one(
      `SELECT res.reference, res.title, res.starts_at, res.ends_at, u.full_name AS organiser
         FROM mr_reservations res JOIN core_users u ON u.id = res.organizer_id
        WHERE res.room_id = $1 AND res.status IN ('PENDING','CONFIRMED')
          AND ($4::uuid IS NULL OR res.id <> $4)
          AND res.starts_at < $3 AND res.ends_at > $2
        LIMIT 1`, [room.id, from, to, excludeId]);

    if (clash) {
      const when = DateTime.fromJSDate(new Date(clash.starts_at)).setZone(room.location.timezone).toFormat('HH:mm');
      const until = DateTime.fromJSDate(new Date(clash.ends_at)).setZone(room.location.timezone).toFormat('HH:mm');
      throw new ConflictException(
        `${room.name} is taken ${when}–${until} by ${clash.organiser} (${clash.reference}).`);
    }

    const blackout = await one(
      `SELECT reason, starts_at, ends_at FROM mr_room_blackouts
        WHERE room_id = $1 AND starts_at < $3 AND ends_at > $2 LIMIT 1`, [room.id, from, to]);
    if (blackout) {
      throw new ConflictException(
        `${room.name} is unavailable then${blackout.reason ? `: ${blackout.reason}` : '.'}`);
    }
  }

  private taken(room: RoomView): ConflictException {
    return new ConflictException(
      `${room.name} was booked by someone else a moment ago. Pick another time or room.`);
  }

  /* ------------------------------------------------------------ invites -- */

  /** The meeting's time and place, in the room's own zone, as a sentence. */
  private whenText(r: ReservationView, room: RoomView): string {
    const zone = room.location.timezone;
    const start = DateTime.fromISO(r.startsAt).setZone(zone);
    const end = DateTime.fromISO(r.endsAt).setZone(zone);
    return `${start.toFormat('ccc d LLL, HH:mm')}–${end.toFormat('HH:mm')} in ${room.name}`;
  }

  /**
   * Tell people they have been invited.
   *
   * A notification is the *announcement*; the meeting reaching their home
   * screen is a consequence of them being an attendee, not of this call. So a
   * failure here must not fail the booking -- they are still invited, they just
   * have to notice it on their own home screen rather than being told. Losing
   * the meeting because a notification insert failed would be much worse.
   */
  private async inviteAll(organiser: Principal, r: ReservationView, userIds: string[]): Promise<void> {
    const guests = [...new Set(userIds)].filter((uid) => uid !== organiser.id);
    if (!guests.length) return;

    const room = await this.rooms.get(r.room.id).catch(() => null);
    const when = room ? this.whenText(r, room) : `${r.room.name}`;
    await this.tellAll(
      guests,
      `${organiser.fullName} invited you to a meeting`,
      `"${r.title}" — ${when}. ${r.reference}`,
      '/meeting-rooms/reservations');
  }

  private async tellAll(
    userIds: string[], title: string, body: string, link: string,
    severity: 'INFO' | 'WARNING' = 'INFO',
  ): Promise<void> {
    await Promise.all([...new Set(userIds)].map((uid) =>
      this.notifications.notify(uid, 'meeting-rooms', title, body, severity, link)
        .catch(() => undefined)));
  }

  private async replaceAttendees(c: any, reservationId: string, userIds?: string[]): Promise<void> {
    if (userIds === undefined) return;

    const unique = [...new Set(userIds)];
    if (unique.length) {
      const { rows } = await c.query(
        `SELECT id FROM core_users
          WHERE id = ANY($1) AND status = 'ACTIVE' AND deleted_at IS NULL`, [unique]);
      if (rows.length !== unique.length) {
        throw new BadRequestException('One or more attendees are not active employees');
      }
    }

    /* Remove only those dropped, and insert only those added, rather than
       clearing the table and rebuilding it. A delete-and-reinsert would reset
       everybody's response to INVITED every time the organiser edited anything,
       and the accepts they already collected would silently vanish. */
    await c.query(
      `DELETE FROM mr_reservation_attendees
        WHERE reservation_id = $1 AND user_id IS NOT NULL AND NOT (user_id = ANY($2))`,
      [reservationId, unique]);

    for (const userId of unique) {
      await c.query(
        `INSERT INTO mr_reservation_attendees (reservation_id, user_id) VALUES ($1,$2)
         ON CONFLICT DO NOTHING`, [reservationId, userId]);
    }
  }
}

/** "09:30" -> { hours: 9, minutes: 30 } */
function minutesOf(hhmm: string): { hours: number; minutes: number } {
  const [h, m] = hhmm.split(':').map(Number);
  return { hours: h, minutes: m };
}