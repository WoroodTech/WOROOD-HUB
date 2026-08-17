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
import { MR_PERMISSIONS } from './permissions';
import type { CancelReservation, CreateReservation, ListReservationsQuery, UpdateReservation } from './dto';
import { RoomsService, type RoomView } from './rooms.service';

export interface ReservationView {
  id: string; reference: string; title: string; description: string | null;
  startsAt: string; endsAt: string; status: string; attendeeCount: number;
  room: { id: string; name: string; nameAr: string | null; floor: string | null; capacity: number; location: string };
  organiser: { id: string; fullName: string; email: string };
  attendees: Array<{ userId: string | null; name: string; email: string; response: string }>;
  cancelledAt: string | null; cancellationReason: string | null;
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
                     'response', a.response) ORDER BY COALESCE(au.full_name, a.external_name))
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
  constructor(private readonly rooms: RoomsService) {}

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
    if (!wantsAll) { params.push(p.id); where.push(`res.organizer_id = $${params.length}`); }

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

    return { reservations: rows.map((r) => this.view(r, p)), scope: wantsAll ? 'all' : 'mine', period };
  }

  async get(p: Principal, id: string): Promise<ReservationView> {
    const row = await one(`${RESERVATION_SELECT} WHERE res.id = $1`, [id]);
    if (!row) throw new NotFoundException('Reservation not found');
    /* Not a permission check -- anyone in the company may see that a room is
       taken and by whom. Editing is what is gated. */
    return this.view(row, p);
  }

  /* -------------------------------------------------------------- writes -- */

  async create(p: Principal, dto: CreateReservation): Promise<ReservationView> {
    const room = await this.rooms.get(dto.roomId);
    const start = new Date(dto.startsAt);
    const end = new Date(dto.endsAt);
    this.assertBookable(room, start, end, dto.attendeeCount ?? 1);

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
           dto.attendeeCount ?? 1, status],
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

    return this.get(p, id);
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

    const room = await this.rooms.get(dto.roomId ?? existing.room_id);
    const start = dto.startsAt ? new Date(dto.startsAt) : new Date(existing.starts_at);
    const end = dto.endsAt ? new Date(dto.endsAt) : new Date(existing.ends_at);
    const attendeeCount = dto.attendeeCount ?? existing.attendees;

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

    return this.get(p, id);
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
      await query(
        `UPDATE mr_reservations
            SET status = 'CANCELLED', cancelled_by_id = $1, cancelled_at = now(),
                cancellation_reason = $2
          WHERE id = $3`, [p.id, dto.reason ?? null, id]);
    }
    return this.get(p, id);
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

    const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
    if (minutes < room.minDurationMinutes) {
      throw new BadRequestException(`${room.name} takes bookings of at least ${room.minDurationMinutes} minutes.`);
    }
    if (minutes > room.maxDurationMinutes) {
      throw new BadRequestException(`${room.name} takes bookings of at most ${room.maxDurationMinutes} minutes.`);
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

    /* Opening hours are compared as wall-clock in the room's own zone -- the
       whole reason the location carries a timezone at all. */
    const opens = localStart.startOf('day').plus(minutesOf(room.opensAt));
    const closes = localStart.startOf('day').plus(minutesOf(room.closesAt));
    if (localStart < opens || localEnd > closes) {
      throw new BadRequestException(
        `${room.name} is open ${room.opensAt}–${room.closesAt}. Choose a time inside those hours.`);
    }
    if (!localEnd.hasSame(localStart, 'day')) {
      throw new BadRequestException('A booking cannot run past midnight.');
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

  private async replaceAttendees(c: any, reservationId: string, userIds?: string[]): Promise<void> {
    if (userIds === undefined) return;
    await c.query(`DELETE FROM mr_reservation_attendees WHERE reservation_id = $1`, [reservationId]);
    if (!userIds.length) return;

    const unique = [...new Set(userIds)];
    const { rows } = await c.query(`SELECT id FROM core_users WHERE id = ANY($1) AND status = 'ACTIVE' AND deleted_at IS NULL`, [unique]);
    if (rows.length !== unique.length) {
      throw new BadRequestException('One or more attendees are not active employees');
    }
    for (const r of rows) {
      await c.query(
        `INSERT INTO mr_reservation_attendees (reservation_id, user_id) VALUES ($1,$2)
         ON CONFLICT DO NOTHING`, [reservationId, r.id]);
    }
  }
}

/** "09:30" -> { hours: 9, minutes: 30 } */
function minutesOf(hhmm: string): { hours: number; minutes: number } {
  const [h, m] = hhmm.split(':').map(Number);
  return { hours: h, minutes: m };
}
