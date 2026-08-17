import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, desc, eq, gt, gte, inArray, lt, lte, ne, or, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { DRIZZLE } from '../../../common/database.module';
import type { Database } from '../../../db/client';
import {
  notifications,
  reservationAttendees,
  reservations,
  roomBlackouts,
  rooms,
  users,
} from '../../../db/schema';
import { AuditService } from '../../../core/audit/audit.service';
import { RoomsService } from './rooms.service';
import { MR_PERMISSIONS } from '../meeting-rooms.descriptor';
import type { AuthenticatedUser } from '../../../common/auth';
import type {
  CreateReservationDto,
  ListReservationsQueryDto,
  UpdateReservationDto,
} from '../dto';

/** PostgreSQL SQLSTATE raised by the mr_reservations_no_overlap constraint. */
const EXCLUSION_VIOLATION = '23P01';
const MODULE_KEY = 'meeting-rooms';

/**
 * Drizzle wraps driver errors, so the original SQLSTATE lives somewhere down
 * the `cause` chain. Walk it rather than assuming a fixed nesting depth.
 */
function sqlStateOf(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

@Injectable()
export class ReservationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly roomsService: RoomsService,
    private readonly audit: AuditService,
  ) {}

  /* --------------------------------------------------------------------- */
  /* Create                                                                 */
  /* --------------------------------------------------------------------- */

  async create(dto: CreateReservationDto, actor: AuthenticatedUser, ip?: string) {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    const { room, timezone } = await this.roomsService.findBookableRoom(dto.roomId);

    await this.assertBookable({
      room,
      timezone,
      startsAt,
      endsAt,
      attendeeCount: dto.attendeeCount ?? 1,
    });

    const reference = ReservationsService.buildReference(startsAt);

    try {
      const reservation = await this.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(reservations)
          .values({
            reference,
            roomId: dto.roomId,
            organizerId: actor.id,
            title: dto.title,
            description: dto.description ?? null,
            startsAt,
            endsAt,
            attendeeCount: dto.attendeeCount ?? 1,
            status: room.requiresApproval ? 'PENDING' : 'CONFIRMED',
          })
          .returning();

        await this.syncAttendees(tx, created.id, dto.attendeeUserIds, actor.id);
        await this.notifyAttendees(tx, created, dto.attendeeUserIds ?? [], room.name, 'invited');
        return created;
      });

      await this.audit.record({
        actorUserId: actor.id,
        moduleKey: MODULE_KEY,
        action: 'reservation.created',
        entityType: 'reservation',
        entityId: reservation.id,
        metadata: { reference, roomId: dto.roomId, startsAt: dto.startsAt, endsAt: dto.endsAt },
        ipAddress: ip,
      });

      return this.findById(reservation.id, actor);
    } catch (error) {
      await this.rethrowAsConflict(error, dto.roomId, startsAt, endsAt);
      throw error;
    }
  }

  /* --------------------------------------------------------------------- */
  /* Read                                                                   */
  /* --------------------------------------------------------------------- */

  async list(query: ListReservationsQueryDto, actor: AuthenticatedUser) {
    const canReadAll =
      actor.permissions.includes(MR_PERMISSIONS.RESERVATION_READ_ALL) ||
      actor.permissions.includes(MR_PERMISSIONS.RESERVATION_MANAGE_ALL);

    const scope = query.scope ?? 'mine';
    if (scope === 'all' && !canReadAll) {
      throw new ForbiddenException('You are not allowed to view other employees’ reservations');
    }

    const now = new Date();
    const period = query.period ?? 'all';
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const where = and(
      scope === 'mine' ? eq(reservations.organizerId, actor.id) : undefined,
      query.status
        ? eq(reservations.status, query.status as 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED')
        : undefined,
      query.roomId ? eq(reservations.roomId, query.roomId) : undefined,
      query.from ? gte(reservations.startsAt, new Date(query.from)) : undefined,
      query.to ? lte(reservations.startsAt, new Date(query.to)) : undefined,
      period === 'upcoming' ? gt(reservations.endsAt, now) : undefined,
      period === 'past' ? lte(reservations.endsAt, now) : undefined,
      // "Upcoming" means things that are still happening: a cancelled booking
      // is history, so it is only shown when explicitly asked for.
      period === 'upcoming' && !query.status ? ne(reservations.status, 'CANCELLED') : undefined,
    );

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select({
          reservation: reservations,
          room: rooms,
          organizer: { id: users.id, fullName: users.fullName, email: users.email },
        })
        .from(reservations)
        .innerJoin(rooms, eq(rooms.id, reservations.roomId))
        .innerJoin(users, eq(users.id, reservations.organizerId))
        .where(where)
        .orderBy(period === 'past' ? desc(reservations.startsAt) : asc(reservations.startsAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(reservations).where(where),
    ]);

    return {
      data: rows.map((r) => this.toView(r.reservation, r.room, r.organizer, actor)),
      meta: { total: Number(total), limit, offset },
    };
  }

  async findById(id: string, actor: AuthenticatedUser) {
    const [row] = await this.db
      .select({
        reservation: reservations,
        room: rooms,
        organizer: { id: users.id, fullName: users.fullName, email: users.email },
      })
      .from(reservations)
      .innerJoin(rooms, eq(rooms.id, reservations.roomId))
      .innerJoin(users, eq(users.id, reservations.organizerId))
      .where(eq(reservations.id, id))
      .limit(1);

    if (!row) throw new NotFoundException('Reservation not found');

    const canReadAll =
      actor.permissions.includes(MR_PERMISSIONS.RESERVATION_READ_ALL) ||
      actor.permissions.includes(MR_PERMISSIONS.RESERVATION_MANAGE_ALL);

    const attendees = await this.db
      .select({
        id: reservationAttendees.id,
        response: reservationAttendees.response,
        userId: reservationAttendees.userId,
        externalEmail: reservationAttendees.externalEmail,
        fullName: users.fullName,
        email: users.email,
      })
      .from(reservationAttendees)
      .leftJoin(users, eq(users.id, reservationAttendees.userId))
      .where(eq(reservationAttendees.reservationId, id));

    const isParticipant =
      row.reservation.organizerId === actor.id || attendees.some((a) => a.userId === actor.id);

    if (!canReadAll && !isParticipant) {
      throw new ForbiddenException('You do not have access to this reservation');
    }

    return { ...this.toView(row.reservation, row.room, row.organizer, actor), attendees };
  }

  /** Dashboard portlet: the signed-in employee's next confirmed meeting. */
  async nextMeeting(actor: AuthenticatedUser, now = new Date()) {
    const [row] = await this.db
      .select({
        reservation: reservations,
        room: rooms,
        organizer: { id: users.id, fullName: users.fullName, email: users.email },
      })
      .from(reservations)
      .innerJoin(rooms, eq(rooms.id, reservations.roomId))
      .innerJoin(users, eq(users.id, reservations.organizerId))
      .where(
        and(
          eq(reservations.organizerId, actor.id),
          eq(reservations.status, 'CONFIRMED'),
          gt(reservations.endsAt, now),
        ),
      )
      .orderBy(asc(reservations.startsAt))
      .limit(1);

    return row ? this.toView(row.reservation, row.room, row.organizer, actor) : null;
  }

  /* --------------------------------------------------------------------- */
  /* Modify                                                                 */
  /* --------------------------------------------------------------------- */

  async update(id: string, dto: UpdateReservationDto, actor: AuthenticatedUser, ip?: string) {
    const existing = await this.loadForWrite(id, actor);

    const startsAt = dto.startsAt ? new Date(dto.startsAt) : existing.startsAt;
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : existing.endsAt;
    const roomId = dto.roomId ?? existing.roomId;
    const attendeeCount = dto.attendeeCount ?? existing.attendeeCount;

    const timeOrRoomChanged =
      roomId !== existing.roomId ||
      startsAt.getTime() !== existing.startsAt.getTime() ||
      endsAt.getTime() !== existing.endsAt.getTime();

    if (timeOrRoomChanged || attendeeCount !== existing.attendeeCount) {
      const { room, timezone } = await this.roomsService.findBookableRoom(roomId);
      await this.assertBookable({ room, timezone, startsAt, endsAt, attendeeCount });
    }

    try {
      await this.db.transaction(async (tx) => {
        await tx
          .update(reservations)
          .set({
            roomId,
            startsAt,
            endsAt,
            attendeeCount,
            ...(dto.title !== undefined && { title: dto.title }),
            ...(dto.description !== undefined && { description: dto.description }),
          })
          .where(eq(reservations.id, id));

        if (dto.attendeeUserIds) {
          await this.syncAttendees(tx, id, dto.attendeeUserIds, existing.organizerId);
        }
      });
    } catch (error) {
      await this.rethrowAsConflict(error, roomId, startsAt, endsAt, id);
      throw error;
    }

    await this.audit.record({
      actorUserId: actor.id,
      moduleKey: MODULE_KEY,
      action: 'reservation.updated',
      entityType: 'reservation',
      entityId: id,
      metadata: {
        before: {
          roomId: existing.roomId,
          startsAt: existing.startsAt.toISOString(),
          endsAt: existing.endsAt.toISOString(),
        },
        after: { roomId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
      },
      ipAddress: ip,
    });

    return this.findById(id, actor);
  }

  async cancel(id: string, reason: string | undefined, actor: AuthenticatedUser, ip?: string) {
    const existing = await this.loadForWrite(id, actor);

    if (existing.status === 'CANCELLED') {
      throw new BadRequestException('This reservation is already cancelled');
    }
    if (existing.endsAt < new Date()) {
      throw new BadRequestException('A reservation that has already finished cannot be cancelled');
    }

    await this.db
      .update(reservations)
      .set({
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledById: actor.id,
        cancellationReason: reason ?? null,
      })
      .where(eq(reservations.id, id));

    // Cancelling frees the room immediately: the exclusion constraint only
    // applies to PENDING/CONFIRMED rows.

    await this.audit.record({
      actorUserId: actor.id,
      moduleKey: MODULE_KEY,
      action: 'reservation.cancelled',
      entityType: 'reservation',
      entityId: id,
      metadata: { reference: existing.reference, reason },
      ipAddress: ip,
    });

    return this.findById(id, actor);
  }

  /* --------------------------------------------------------------------- */
  /* Booking rules                                                          */
  /* --------------------------------------------------------------------- */

  private async assertBookable(input: {
    room: typeof rooms.$inferSelect;
    timezone: string;
    startsAt: Date;
    endsAt: Date;
    attendeeCount: number;
  }) {
    const { room, timezone, startsAt, endsAt, attendeeCount } = input;

    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      throw new BadRequestException('startsAt and endsAt must be valid ISO-8601 timestamps');
    }
    if (endsAt <= startsAt) {
      throw new BadRequestException('The end time must be after the start time');
    }
    if (startsAt < new Date()) {
      throw new BadRequestException('A room cannot be booked in the past');
    }

    const durationMinutes = (endsAt.getTime() - startsAt.getTime()) / 60_000;
    if (durationMinutes < room.minDurationMinutes) {
      throw new BadRequestException(`Minimum booking length for this room is ${room.minDurationMinutes} minutes`);
    }
    if (durationMinutes > room.maxDurationMinutes) {
      throw new BadRequestException(`Maximum booking length for this room is ${room.maxDurationMinutes} minutes`);
    }

    const advanceDays = (startsAt.getTime() - Date.now()) / 86_400_000;
    if (advanceDays > room.maxAdvanceDays) {
      throw new BadRequestException(`This room can only be booked up to ${room.maxAdvanceDays} days ahead`);
    }

    if (attendeeCount > room.capacity) {
      throw new BadRequestException(
        `${attendeeCount} attendees exceeds the room capacity of ${room.capacity}`,
      );
    }

    // Opening hours are evaluated in the room's own timezone.
    const localStart = DateTime.fromJSDate(startsAt, { zone: timezone });
    const localEnd = DateTime.fromJSDate(endsAt, { zone: timezone });
    const opening = String(room.openingTime).slice(0, 5);
    const closing = String(room.closingTime).slice(0, 5);

    if (localStart.toFormat('yyyy-LL-dd') !== localEnd.toFormat('yyyy-LL-dd')) {
      throw new BadRequestException('A reservation must start and end on the same day');
    }
    if (localStart.toFormat('HH:mm') < opening || localEnd.toFormat('HH:mm') > closing) {
      throw new BadRequestException(`This room is bookable between ${opening} and ${closing} local time`);
    }

    // Maintenance / holiday windows behave exactly like a booking.
    const [blackout] = await this.db
      .select()
      .from(roomBlackouts)
      .where(
        and(
          eq(roomBlackouts.roomId, room.id),
          lt(roomBlackouts.startsAt, endsAt),
          gt(roomBlackouts.endsAt, startsAt),
        ),
      )
      .limit(1);

    if (blackout) {
      throw new ConflictException(
        `The room is unavailable during this period${blackout.reason ? `: ${blackout.reason}` : ''}`,
      );
    }
  }

  /**
   * Turn PostgreSQL's exclusion violation into a helpful 409 that names the
   * meeting already holding the slot. The database is the only thing deciding
   * whether the slot is taken, so this is race-free by construction.
   */
  private async rethrowAsConflict(
    error: unknown,
    roomId: string,
    startsAt: Date,
    endsAt: Date,
    excludeId?: string,
  ): Promise<never | void> {
    if (sqlStateOf(error) !== EXCLUSION_VIOLATION) return;

    const [clash] = await this.db
      .select({
        reference: reservations.reference,
        title: reservations.title,
        startsAt: reservations.startsAt,
        endsAt: reservations.endsAt,
        organizer: users.fullName,
      })
      .from(reservations)
      .innerJoin(users, eq(users.id, reservations.organizerId))
      .where(
        and(
          eq(reservations.roomId, roomId),
          or(eq(reservations.status, 'CONFIRMED'), eq(reservations.status, 'PENDING')),
          lt(reservations.startsAt, endsAt),
          gt(reservations.endsAt, startsAt),
          excludeId ? sql`${reservations.id} <> ${excludeId}` : undefined,
        ),
      )
      .limit(1);

    throw new ConflictException({
      statusCode: 409,
      error: 'RoomAlreadyBooked',
      message: clash
        ? `This room is already booked from ${clash.startsAt.toISOString()} to ${clash.endsAt.toISOString()} by ${clash.organizer}.`
        : 'This room has just been booked by someone else for an overlapping time.',
      conflict: clash
        ? {
            reference: clash.reference,
            title: clash.title,
            organizer: clash.organizer,
            startsAt: clash.startsAt.toISOString(),
            endsAt: clash.endsAt.toISOString(),
          }
        : undefined,
    });
  }

  /* --------------------------------------------------------------------- */
  /* Helpers                                                                */
  /* --------------------------------------------------------------------- */

  private async loadForWrite(id: string, actor: AuthenticatedUser) {
    const [existing] = await this.db.select().from(reservations).where(eq(reservations.id, id)).limit(1);
    if (!existing) throw new NotFoundException('Reservation not found');

    const canManageAll = actor.permissions.includes(MR_PERMISSIONS.RESERVATION_MANAGE_ALL);
    if (existing.organizerId !== actor.id && !canManageAll) {
      throw new ForbiddenException('Only the organizer can change this reservation');
    }
    return existing;
  }

  private async syncAttendees(tx: any, reservationId: string, userIds: string[] | undefined, organizerId: string) {
    if (!userIds) return;
    const unique = [...new Set(userIds.filter((id) => id !== organizerId))];

    await tx.delete(reservationAttendees).where(eq(reservationAttendees.reservationId, reservationId));
    if (unique.length === 0) return;

    const found = await tx.select({ id: users.id }).from(users).where(inArray(users.id, unique));
    await tx
      .insert(reservationAttendees)
      .values(found.map((u: { id: string }) => ({ reservationId, userId: u.id })));
  }

  private async notifyAttendees(
    tx: any,
    reservation: typeof reservations.$inferSelect,
    attendeeIds: string[],
    roomName: string,
    kind: 'invited',
  ) {
    if (attendeeIds.length === 0) return;
    await tx.insert(notifications).values(
      attendeeIds.map((userId) => ({
        userId,
        moduleKey: MODULE_KEY,
        type: `reservation.${kind}`,
        title: `Meeting invitation: ${reservation.title}`,
        body: `${roomName} — ${reservation.startsAt.toISOString()}`,
        link: `/meeting-rooms/reservations/${reservation.id}`,
      })),
    );
  }

  private toView(
    reservation: typeof reservations.$inferSelect,
    room: typeof rooms.$inferSelect,
    organizer: { id: string; fullName: string; email: string },
    actor: AuthenticatedUser,
  ) {
    const now = new Date();
    const isOrganizer = reservation.organizerId === actor.id;
    const canManageAll = actor.permissions.includes(MR_PERMISSIONS.RESERVATION_MANAGE_ALL);
    const isEditable =
      (isOrganizer || canManageAll) && reservation.status !== 'CANCELLED' && reservation.endsAt > now;

    return {
      id: reservation.id,
      reference: reservation.reference,
      title: reservation.title,
      description: reservation.description,
      startsAt: reservation.startsAt.toISOString(),
      endsAt: reservation.endsAt.toISOString(),
      durationMinutes: Math.round((reservation.endsAt.getTime() - reservation.startsAt.getTime()) / 60_000),
      status: reservation.status,
      attendeeCount: reservation.attendeeCount,
      cancellationReason: reservation.cancellationReason,
      isPast: reservation.endsAt <= now,
      isOrganizer,
      canModify: isEditable,
      canCancel: isEditable,
      room: {
        id: room.id,
        code: room.code,
        name: room.name,
        capacity: room.capacity,
        floor: room.floor,
      },
      organizer,
      createdAt: reservation.createdAt.toISOString(),
    };
  }

  /** Human-friendly booking reference, e.g. MR-20260812-4F7A. */
  private static buildReference(startsAt: Date): string {
    const day = startsAt.toISOString().slice(0, 10).replace(/-/g, '');
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `MR-${day}-${suffix}`;
  }
}
