/**
 * "What can I actually book on Tuesday?"
 *
 * The day is a *calendar day in the room's own location*, not a 24-hour window
 * around the caller's clock. Cairo is the only location today, but the column
 * exists and the arithmetic honours it, because the day a Dubai employee means
 * by "Tuesday" is not the same instant range as the one a Cairo employee means.
 *
 * What comes back is an offer, not a promise. Between rendering a slot and
 * someone clicking it, another person can take it -- the exclusion constraint
 * in the database is what settles that, and the booking call reports it as a
 * conflict rather than pretending it cannot happen.
 */

import { BadRequestException, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { query } from '../../common/db';
import type { AvailabilityQuery } from './dto';
import { computeFreeSlots, isWindowFree, type Interval } from './slots';
import { parseEquipmentKeys, RoomsService, type RoomView } from './rooms.service';

export interface RoomAvailability {
  room: RoomView;
  /** Free start times for the requested duration, ISO-8601 with offset. */
  slots: Array<{ startsAt: string; endsAt: string }>;
  /** Present only when the caller asked for one exact window. */
  requestedWindow?: { startsAt: string; endsAt: string; free: boolean };
  /** Why a room offered nothing, when it offered nothing. */
  note?: string;
}

@Injectable()
export class AvailabilityService {
  constructor(private readonly rooms: RoomsService) { }

  async search(q: AvailabilityQuery): Promise<{
    date: string; durationMinutes: number; rooms: RoomAvailability[];
  }> {
    const candidates = await this.rooms.list({
      locationId: q.locationId,
      minCapacity: q.minCapacity,
      equipment: parseEquipmentKeys(q.equipment).join(','),
      status: 'ACTIVE',
    });

    const rooms = q.roomId
      ? candidates.filter((r) => r.id === q.roomId)
      : q.roomIds
        ? this.filterByIds(candidates, q.roomIds)
        : candidates;
    if (!rooms.length) return { date: q.date, durationMinutes: q.durationMinutes, rooms: [] };

    const busyByRoom = await this.busyFor(rooms.map((r) => r.id), q.date);
    const now = new Date();

    const out = rooms.map((room) => this.forRoom(room, q, busyByRoom.get(room.id) ?? [], now));
    return { date: q.date, durationMinutes: q.durationMinutes, rooms: out };
  }

  /** "id1, id2,id3" -> Set, trimmed and deduped -- mirrors how equipment keys
 *  are parsed, kept local since it is only used here. */
  private filterByIds(rooms: RoomView[], raw: string): RoomView[] {
    const wanted = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
    return rooms.filter((r) => wanted.has(r.id));
  }

  /* ------------------------------------------------------------ internals -- */

  private forRoom(
    room: RoomView, q: AvailabilityQuery, busy: Interval[], now: Date,
  ): RoomAvailability {
    const zone = room.location.timezone;
    const day = DateTime.fromISO(q.date, { zone });
    if (!day.isValid) throw new BadRequestException(`${q.date} is not a real date`);

    /* Policy is checked before arithmetic: a room that cannot take this
       booking at all should say so, not return an empty list that reads as
       "fully booked". The two are different answers. */
    if (q.durationMinutes < room.minDurationMinutes) {
      return { room, slots: [], note: `This room takes bookings of at least ${room.minDurationMinutes} minutes.` };
    }
    if (q.durationMinutes > room.maxDurationMinutes) {
      return { room, slots: [], note: `This room takes bookings of at most ${room.maxDurationMinutes} minutes.` };
    }

    const horizon = DateTime.now().setZone(zone).startOf('day').plus({ days: room.maxAdvanceDays });
    if (day > horizon) {
      return { room, slots: [], note: `This room can only be booked ${room.maxAdvanceDays} days ahead.` };
    }
    if (day < DateTime.now().setZone(zone).startOf('day')) {
      return { room, slots: [], note: 'That day has passed.' };
    }

    const [openH, openM] = room.opensAt.split(':').map(Number);
    const [closeH, closeM] = room.closesAt.split(':').map(Number);
    const dayStart = day.set({ hour: openH, minute: openM, second: 0, millisecond: 0 });
    const dayEnd = day.set({ hour: closeH, minute: closeM, second: 0, millisecond: 0 });

    const slots = computeFreeSlots({
      dayStart: dayStart.toJSDate(),
      dayEnd: dayEnd.toJSDate(),
      slotMinutes: room.slotMinutes,
      durationMinutes: q.durationMinutes,
      busy,
      bufferMinutes: room.bufferMinutes,
      notBefore: now,
    });

    const result: RoomAvailability = {
      room,
      slots: slots.map((s) => ({
        startsAt: DateTime.fromJSDate(s.start).setZone(zone).toISO()!,
        endsAt: DateTime.fromJSDate(s.end).setZone(zone).toISO()!,
      })),
    };

    if (!slots.length && !result.note) {
      result.note = busy.length ? 'Fully booked on this day.' : 'Outside this room’s opening hours.';
    }

    /* An exact window the employee already has in mind -- answered directly,
       because "is 14:00 free?" deserves yes or no, not a list to scan. */
    if (q.startTime) {
      const [h, m] = q.startTime.split(':').map(Number);
      const start = day.set({ hour: h, minute: m, second: 0, millisecond: 0 });
      const end = start.plus({ minutes: q.durationMinutes });
      const insideHours = start >= dayStart && end <= dayEnd;
      result.requestedWindow = {
        startsAt: start.toISO()!,
        endsAt: end.toISO()!,
        free: insideHours
          && start.toJSDate() >= now
          && isWindowFree({ start: start.toJSDate(), end: end.toJSDate() }, busy, room.bufferMinutes),
      };
    }

    return result;
  }

  /**
   * Live reservations and blackouts for every candidate room, in one query
   * each rather than one per room. The window is widened by a day on both
   * sides so a meeting that straddles midnight is still seen.
   */
  private async busyFor(roomIds: string[], date: string): Promise<Map<string, Interval[]>> {
    const from = DateTime.fromISO(date).minus({ days: 1 }).toJSDate();
    const to = DateTime.fromISO(date).plus({ days: 2 }).toJSDate();

    const [reservations, blackouts] = await Promise.all([
      query(
        `SELECT room_id, starts_at, ends_at FROM mr_reservations
          WHERE room_id = ANY($1) AND status IN ('PENDING','CONFIRMED')
            AND starts_at < $3 AND ends_at > $2`, [roomIds, from, to]),
      query(
        `SELECT room_id, starts_at, ends_at FROM mr_room_blackouts
          WHERE room_id = ANY($1) AND starts_at < $3 AND ends_at > $2`, [roomIds, from, to]),
    ]);

    const map = new Map<string, Interval[]>();
    for (const r of [...reservations, ...blackouts]) {
      const list = map.get(r.room_id) ?? [];
      list.push({ start: new Date(r.starts_at), end: new Date(r.ends_at) });
      map.set(r.room_id, list);
    }
    return map;
  }
}
