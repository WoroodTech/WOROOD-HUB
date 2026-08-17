import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, inArray, lt, or } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { DRIZZLE } from '../../../common/database.module';
import type { Database } from '../../../db/client';
import { reservations, roomBlackouts, users } from '../../../db/schema';
import { computeFreeSlots, isWindowFree, type Interval } from './slots';
import { RoomsService, type RoomView } from './rooms.service';
import type { AvailabilityQueryDto } from '../dto';

export interface RoomAvailability {
  room: RoomView;
  /** Only present when the caller asked about a specific window. */
  availableForRequestedWindow?: boolean;
  bookableFrom: string;
  bookableTo: string;
  busy: { startsAt: string; endsAt: string; kind: 'RESERVATION' | 'BLACKOUT'; title?: string }[];
  freeSlots: { startsAt: string; endsAt: string }[];
}

@Injectable()
export class AvailabilityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly roomsService: RoomsService,
  ) {}

  /**
   * Busy periods for a set of rooms in a window. Only PENDING/CONFIRMED
   * reservations count — a cancelled booking never blocks a room.
   */
  async busyPeriods(roomIds: string[], from: Date, to: Date) {
    if (roomIds.length === 0) return new Map<string, RoomAvailability['busy']>();

    const [bookings, blackouts] = await Promise.all([
      this.db
        .select({
          roomId: reservations.roomId,
          startsAt: reservations.startsAt,
          endsAt: reservations.endsAt,
          title: reservations.title,
          organizer: users.fullName,
        })
        .from(reservations)
        .innerJoin(users, eq(users.id, reservations.organizerId))
        .where(
          and(
            inArray(reservations.roomId, roomIds),
            or(eq(reservations.status, 'CONFIRMED'), eq(reservations.status, 'PENDING')),
            lt(reservations.startsAt, to),
            gt(reservations.endsAt, from),
          ),
        ),
      this.db
        .select()
        .from(roomBlackouts)
        .where(
          and(
            inArray(roomBlackouts.roomId, roomIds),
            lt(roomBlackouts.startsAt, to),
            gt(roomBlackouts.endsAt, from),
          ),
        ),
    ]);

    const map = new Map<string, RoomAvailability['busy']>();
    const push = (roomId: string, entry: RoomAvailability['busy'][number]) => {
      const list = map.get(roomId) ?? [];
      list.push(entry);
      map.set(roomId, list);
    };

    for (const b of bookings) {
      push(b.roomId, {
        startsAt: b.startsAt.toISOString(),
        endsAt: b.endsAt.toISOString(),
        kind: 'RESERVATION',
        title: `${b.title} — ${b.organizer}`,
      });
    }
    for (const b of blackouts) {
      push(b.roomId, {
        startsAt: b.startsAt.toISOString(),
        endsAt: b.endsAt.toISOString(),
        kind: 'BLACKOUT',
        title: b.reason ?? 'Unavailable',
      });
    }
    return map;
  }

  /**
   * Main search behind the "find me a room" screen: filter the room catalogue,
   * then compute free slots for the requested day for each surviving room.
   */
  async search(query: AvailabilityQueryDto, now = new Date()): Promise<RoomAvailability[]> {
    const catalogue = await this.roomsService.list({
      locationId: query.locationId,
      minCapacity: query.minCapacity,
      equipment: query.equipment,
      status: 'ACTIVE',
    });

    if (catalogue.length === 0) return [];

    const windows = catalogue.map((room) => ({
      room,
      ...AvailabilityService.dayWindow(room, query.date),
    }));

    const from = new Date(Math.min(...windows.map((w) => w.dayStart.getTime())));
    const to = new Date(Math.max(...windows.map((w) => w.dayEnd.getTime())));
    const busyByRoom = await this.busyPeriods(catalogue.map((r) => r.id), from, to);

    return windows.map(({ room, dayStart, dayEnd }) => {
      const busy = busyByRoom.get(room.id) ?? [];
      const intervals: Interval[] = busy.map((b) => ({
        start: new Date(b.startsAt),
        end: new Date(b.endsAt),
      }));

      const freeSlots = computeFreeSlots({
        dayStart,
        dayEnd,
        slotMinutes: room.slotMinutes,
        durationMinutes: query.durationMinutes,
        busy: intervals,
        bufferMinutes: room.bufferMinutes,
        notBefore: now,
      });

      let availableForRequestedWindow: boolean | undefined;
      if (query.startTime) {
        const start = AvailabilityService.localInstant(
          query.date,
          query.startTime,
          room.location.timezone,
        );
        const end = new Date(start.getTime() + query.durationMinutes * 60_000);
        availableForRequestedWindow =
          start >= dayStart &&
          end <= dayEnd &&
          start >= now &&
          isWindowFree({ start, end }, intervals, room.bufferMinutes);
      }

      return {
        room,
        availableForRequestedWindow,
        bookableFrom: dayStart.toISOString(),
        bookableTo: dayEnd.toISOString(),
        busy: busy.sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
        freeSlots: freeSlots.map((s) => ({
          startsAt: s.start.toISOString(),
          endsAt: s.end.toISOString(),
        })),
      };
    });
  }

  /** Day timeline for one room, used by the room detail screen. */
  async daySchedule(roomId: string, date: string, now = new Date()): Promise<RoomAvailability> {
    const room = await this.roomsService.findById(roomId);
    const { dayStart, dayEnd } = AvailabilityService.dayWindow(room, date);
    const busy = (await this.busyPeriods([roomId], dayStart, dayEnd)).get(roomId) ?? [];

    const freeSlots = computeFreeSlots({
      dayStart,
      dayEnd,
      slotMinutes: room.slotMinutes,
      durationMinutes: room.minDurationMinutes,
      busy: busy.map((b) => ({ start: new Date(b.startsAt), end: new Date(b.endsAt) })),
      bufferMinutes: room.bufferMinutes,
      notBefore: now,
    });

    return {
      room,
      bookableFrom: dayStart.toISOString(),
      bookableTo: dayEnd.toISOString(),
      busy: busy.sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
      freeSlots: freeSlots.map((s) => ({ startsAt: s.start.toISOString(), endsAt: s.end.toISOString() })),
    };
  }

  /** Rooms with nothing booked for the next `minutes`, for the dashboard portlet. */
  async freeRightNow(minutes = 30, now = new Date()) {
    const catalogue = await this.roomsService.list({ status: 'ACTIVE' });
    if (catalogue.length === 0) return [];

    const until = new Date(now.getTime() + minutes * 60_000);
    const busyByRoom = await this.busyPeriods(catalogue.map((r) => r.id), now, until);

    return catalogue
      .filter((room) => {
        const busy = busyByRoom.get(room.id) ?? [];
        const withinHours = AvailabilityService.isWithinOpeningHours(room, now);
        return withinHours && busy.length === 0;
      })
      .map((room) => ({
        id: room.id,
        code: room.code,
        name: room.name,
        capacity: room.capacity,
        location: room.location.name,
        floor: room.floor,
      }));
  }

  /* --------------------------------------------------------------------- */
  /* Timezone helpers — all room hours are local to the room's site         */
  /* --------------------------------------------------------------------- */

  static localInstant(date: string, time: string, timezone: string): Date {
    return DateTime.fromISO(`${date}T${time}`, { zone: timezone }).toJSDate();
  }

  static dayWindow(room: RoomView, date: string): { dayStart: Date; dayEnd: Date } {
    return {
      dayStart: AvailabilityService.localInstant(date, room.openingTime, room.location.timezone),
      dayEnd: AvailabilityService.localInstant(date, room.closingTime, room.location.timezone),
    };
  }

  static isWithinOpeningHours(room: RoomView, instant: Date): boolean {
    const local = DateTime.fromJSDate(instant, { zone: room.location.timezone });
    const hhmm = local.toFormat('HH:mm');
    return hhmm >= room.openingTime && hhmm < room.closingTime;
  }
}
