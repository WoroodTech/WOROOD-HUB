/**
 * "Is 10:20 free for twenty minutes, and if not, what is?"
 *
 * This used to answer a different question. Every room carried a slot grid and
 * a minimum length, and the search enumerated every start time each room would
 * accept -- so the employee picked from a list the rooms had decided on. They
 * now type a start time and a length, which means there is exactly one window
 * in play and two things worth saying about it: whether the room they asked
 * for can take it, and who else can.
 *
 * Both answers are given at once, deliberately. A refusal on its own sends
 * someone back to the form to guess again; a refusal with "Jasmine and Orchid
 * are free then, and Lotus itself is free at 11:05" is a decision they can
 * make without another round trip.
 *
 * The day is a *calendar day in the room's own location*, not a 24-hour window
 * around the caller's clock. Cairo is the only location today, but the column
 * exists and the arithmetic honours it, because the day a Dubai employee means
 * by "Tuesday" is not the same instant range as the one a Cairo employee means.
 *
 * What comes back is still an offer, not a promise. Between this answer and
 * the booking call another person can take the room -- the exclusion
 * constraint in the database is what settles that, and `create` reports it as
 * a conflict rather than pretending it cannot happen.
 */

import { BadRequestException, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { query } from '../../common/db';
import type { AvailabilityQuery } from './dto';
import {
  BOOKING_LIMITS, blockedUntil, blockingBlocks, nextFreeWindow, type TaggedInterval,
} from './slots';

/** What a blocked room is blocked *by*. A booking and a changeover buffer are
 *  both "not available" and are not the same news, so the caller gets the
 *  distinction rather than a single flat refusal. */
export type BlockedBy = 'BOOKING' | 'BUFFER' | 'BLACKOUT';

/** Carried on each busy interval so the reason survives as far as the message.
 *  Blackouts bring their own wording; nothing else needs a payload. */
interface BusyRef { reason: string | null }
import { parseEquipmentKeys, RoomsService, type RoomView } from './rooms.service';

export interface RoomWindow {
  room: RoomView;
  available: boolean;
  /** Why not, when not -- in the room's own words, not a code. */
  reason?: string;
  /** The kind of obstruction, for a caller that wants to style a changeover
   *  differently from a clash. Absent when the room is free, or when the
   *  refusal has nothing to do with the timeline (too small, closed, past). */
  blockedBy?: BlockedBy;
  /** This room's earliest window of the same length at or after the requested
   *  time. Null when the rest of the day has nothing to offer. */
  nextFree?: { startsAt: string; endsAt: string } | null;
}

export interface WindowAvailability {
  date: string;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  /** Present only when the caller named a room. */
  requested?: RoomWindow;
  /** Rooms free for exactly this window. Never includes `requested`. */
  alternatives: RoomWindow[];
  /** Rooms that matched the filters but cannot take this window, each with the
   *  reason it gave. Shown rather than hidden, because "why isn't Lotus in the
   *  list?" is otherwise the next question. */
  unavailable: RoomWindow[];
}

@Injectable()
export class AvailabilityService {
  constructor(private readonly rooms: RoomsService) { }

  async search(q: AvailabilityQuery): Promise<WindowAvailability> {
    const candidates = await this.rooms.list({
      locationId: q.locationId,
      minCapacity: q.minCapacity,
      equipment: parseEquipmentKeys(q.equipment).join(','),
      status: 'ACTIVE',
    });

    /* The requested room is resolved separately rather than filtered out of
       `candidates`. It has to be answered about even when it fails the filters
       -- if someone asks for Lotus and Lotus seats four, "Lotus seats 4" is
       the useful answer, and dropping it silently is not. */
    const requestedRoom = q.roomId
      ? candidates.find((r) => r.id === q.roomId) ?? await this.rooms.get(q.roomId).catch(() => null)
      : null;

    const pool = q.roomIds ? this.filterByIds(candidates, q.roomIds) : candidates;
    const rooms = [...pool];
    if (requestedRoom && !rooms.some((r) => r.id === requestedRoom.id)) rooms.push(requestedRoom);

    const zone = (requestedRoom ?? rooms[0])?.location.timezone ?? 'Africa/Cairo';
    const { start, end } = this.window(q, zone);

    if (!rooms.length) {
      return {
        date: q.date,
        startsAt: start.toISO()!, endsAt: end.toISO()!,
        durationMinutes: q.durationMinutes,
        alternatives: [], unavailable: [],
      };
    }

    const busyByRoom = await this.busyFor(rooms.map((r) => r.id), q.date, zone);
    const now = new Date();

    const answers = rooms.map((room) =>
      this.forRoom(room, q, busyByRoom.get(room.id) ?? [], now));

    const requested = requestedRoom
      ? answers.find((a) => a.room.id === requestedRoom.id)
      : undefined;
    const rest = answers.filter((a) => a.room.id !== requestedRoom?.id);

    /* The window is the same for every room, so it is stated once at the top
       rather than repeated per answer. */
    return {
      date: q.date,
      startsAt: start.toISO()!,
      endsAt: end.toISO()!,
      durationMinutes: q.durationMinutes,
      requested,
      alternatives: rest.filter((a) => a.available),
      unavailable: rest.filter((a) => !a.available),
    };
  }

  /** "id1, id2,id3" -> Set, trimmed and deduped -- mirrors how equipment keys
   *  are parsed, kept local since it is only used here. */
  private filterByIds(rooms: RoomView[], raw: string): RoomView[] {
    const wanted = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
    return rooms.filter((r) => wanted.has(r.id));
  }

  /* ------------------------------------------------------------ internals -- */

  /** The requested window as two instants in the given zone. */
  private window(q: AvailabilityQuery, zone: string): { start: DateTime; end: DateTime } {
    const day = DateTime.fromISO(q.date, { zone });
    if (!day.isValid) throw new BadRequestException(`${q.date} is not a real date`);

    const [h, m] = q.startTime.split(':').map(Number);
    const start = day.set({ hour: h, minute: m, second: 0, millisecond: 0 });
    return { start, end: start.plus({ minutes: q.durationMinutes }) };
  }

  private forRoom(
    room: RoomView, q: AvailabilityQuery, busy: TaggedInterval<BusyRef>[], now: Date,
  ): RoomWindow {
    const zone = room.location.timezone;
    const { start, end } = this.window(q, zone);

    const opens = start.startOf('day').plus(minutesOf(room.opensAt));
    const closes = start.startOf('day').plus(minutesOf(room.closesAt));

    /* Everything that has nothing to do with who else booked the room is
       checked first, and each check returns rather than accumulating, so the
       reason an employee reads is the first real obstacle rather than the last
       one the code happened to test. A room that is too small is not "taken",
       and saying so would send them hunting for a different time when the time
       was never the problem. */
    const no = (reason: string): RoomWindow => ({ room, available: false, reason });

    if (room.status !== 'ACTIVE') {
      return no(room.status === 'MAINTENANCE'
        ? `${room.name} is under maintenance.`
        : `${room.name} is not available for booking.`);
    }
    if (q.minCapacity && room.capacity < q.minCapacity) {
      return no(`${room.name} seats ${room.capacity}.`);
    }

    const horizon = DateTime.now().setZone(zone).startOf('day').plus({ days: room.maxAdvanceDays });
    if (start > horizon.endOf('day')) {
      return no(`${room.name} can only be booked ${room.maxAdvanceDays} days ahead.`);
    }
    if (end.toJSDate() <= now) return no('That time has already passed.');
    /* Midnight before opening hours: a window running into tomorrow is a
       different mistake from one outside today's hours, and the message that
       names it is the more useful of the two. */
    if (!end.hasSame(start, 'day')) return no('A booking cannot run past midnight.');
    if (start < opens || end > closes) {
      return no(`${room.name} is open ${room.opensAt}–${room.closesAt}.`);
    }

    const window = { start: start.toJSDate(), end: end.toJSDate() };
    const inTheWay = blockingBlocks(window, busy, room.bufferMinutes);

    if (!inTheWay.length && start.toJSDate() >= now) return { room, available: true };

    /* Blocked. The useful follow-up is this room's own next opening, searched
       from the requested time forward -- not from the start of the day, since
       an earlier gap is no answer to "can I have it at 10:20". */
    const searchFrom = new Date(Math.max(window.start.getTime(), now.getTime()));
    const found = nextFreeWindow({
      from: searchFrom,
      dayEnd: closes.toJSDate(),
      durationMinutes: q.durationMinutes,
      busy,
      bufferMinutes: room.bufferMinutes,
      stepMinutes: BOOKING_LIMITS.STEP_MINUTES,
    });

    const nextFree = found
      ? {
          startsAt: DateTime.fromJSDate(found.start).setZone(zone).toISO()!,
          endsAt: DateTime.fromJSDate(found.end).setZone(zone).toISO()!,
        }
      : null;

    if (window.start < now) {
      return { room, available: false, reason: 'That time has already passed.', nextFree };
    }

    /* Which obstruction to name, when there is more than one. A blackout is
       the most specific thing that can be said and carries its own wording; a
       real booking is the next most useful; a buffer is named only when it is
       the *sole* reason, because "held for changeover" beside a room that is
       also genuinely booked would be the smaller half of the truth. */
    const blackout = inTheWay.find((b) => b.kind === 'BLACKOUT');
    const booking = inTheWay.find((b) => b.kind === 'BOOKING');
    const clockOf = (d: Date) => DateTime.fromJSDate(d).setZone(zone).toFormat('HH:mm');

    if (blackout) {
      const why = (blackout as { ref?: BusyRef }).ref?.reason;
      return {
        room, available: false, blockedBy: 'BLACKOUT', nextFree,
        reason: why
          ? `${room.name} is unavailable then: ${why.toLowerCase()}`
          : `${room.name} is unavailable then.`,
      };
    }

    if (booking) {
      return { room, available: false, blockedBy: 'BOOKING', nextFree,
               reason: `${room.name} is taken then.` };
    }

    /* Buffer only. This is the case that used to read as "taken" and send
       people hunting for a meeting that does not exist -- the room is empty,
       it is being reset around one either side. Naming the minute it frees is
       the whole point, so say it rather than only offering a suggestion. */
    const until = blockedUntil(inTheWay);
    return {
      room, available: false, blockedBy: 'BUFFER', nextFree,
      reason: until
        ? `${room.name} is free, but held for changeover until ${clockOf(until)}.`
        : `${room.name} is held for changeover then.`,
    };
  }

  /**
   * Live reservations and blackouts for every candidate room, in one query
   * each rather than one per room. The window is widened by a day on both
   * sides so a meeting that straddles midnight is still seen -- and it is
   * anchored in a room's own zone rather than the server's, because "the day
   * either side of Tuesday" is a different pair of instants in Cairo and in
   * Dubai.
   */
  private async busyFor(
    roomIds: string[], date: string, zone: string,
  ): Promise<Map<string, TaggedInterval<BusyRef>[]>> {
    if (!roomIds.length) return new Map();

    const anchor = DateTime.fromISO(date, { zone });
    const from = anchor.minus({ days: 1 }).toJSDate();
    const to = anchor.plus({ days: 2 }).toJSDate();

    const [reservations, blackouts] = await Promise.all([
      query(
        `SELECT room_id, starts_at, ends_at FROM mr_reservations
          WHERE room_id = ANY($1) AND status IN ('PENDING','CONFIRMED')
            AND starts_at < $3 AND ends_at > $2`, [roomIds, from, to]),
      query(
        `SELECT room_id, starts_at, ends_at, reason FROM mr_room_blackouts
          WHERE room_id = ANY($1) AND starts_at < $3 AND ends_at > $2`, [roomIds, from, to]),
    ]);

    /* Tagged rather than plain intervals: the kind has to survive as far as
       the message, and the same tagging is what the room calendar draws from.
       No booking title travels with it -- the search says a room is taken, not
       what it is taken for. */
    const map = new Map<string, TaggedInterval<BusyRef>[]>();
    const push = (roomId: string, item: TaggedInterval<BusyRef>) => {
      const list = map.get(roomId) ?? [];
      list.push(item);
      map.set(roomId, list);
    };

    for (const r of reservations) {
      push(r.room_id, {
        start: new Date(r.starts_at), end: new Date(r.ends_at),
        kind: 'BOOKING', ref: { reason: null },
      });
    }
    for (const b of blackouts) {
      push(b.room_id, {
        start: new Date(b.starts_at), end: new Date(b.ends_at),
        kind: 'BLACKOUT', ref: { reason: b.reason ?? null },
      });
    }
    return map;
  }
}

/** "09:30" -> { hours: 9, minutes: 30 } */
function minutesOf(hhmm: string): { hours: number; minutes: number } {
  const [h, m] = hhmm.split(':').map(Number);
  return { hours: h, minutes: m };
}