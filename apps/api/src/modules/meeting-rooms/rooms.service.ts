/**
 * Rooms: the catalogue employees search, and the records Facilities maintain.
 *
 * Every read goes through `ROOM_SELECT` so a room has exactly one shape on the
 * wire no matter which screen asked for it -- the booking search, the admin
 * table and the availability response are all the same object.
 */

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { one, query, tx } from '../../common/db';
import { BOOKING_LIMITS } from './slots';
import type { ListRoomsQuery, UpsertRoom } from './dto';

export interface RoomView {
  id: string; code: string; name: string; nameAr: string | null;
  capacity: number; floor: string | null;
  description: string | null; photoUrl: string | null;
  status: 'ACTIVE' | 'MAINTENANCE' | 'INACTIVE';
  opensAt: string; closesAt: string;
  maxAdvanceDays: number; bufferMinutes: number; requiresApproval: boolean;
  location: { id: string; code: string; name: string; building: string | null; timezone: string };
  equipment: Array<{ key: string; name: string; icon: string | null; quantity: number }>;
}

/* The equipment join is aggregated in the database rather than in a second
   round trip: six rooms with three fittings each is seven queries the naive
   way and one this way. */
const ROOM_SELECT = `
  SELECT r.id, r.code, r.name, r.name_ar, r.capacity, r.floor, r.description, r.photo_url,
         r.status, r.opens_at, r.closes_at,
         r.max_advance_days, r.buffer_minutes, r.requires_approval,
         l.id AS location_id, l.code AS location_code, l.name AS location_name,
         l.building AS location_building, l.iana_timezone AS location_timezone,
         COALESCE(
           (SELECT json_agg(json_build_object(
                     'key', e.key, 'name', e.name, 'icon', e.icon, 'quantity', re.quantity)
                     ORDER BY e.name)
              FROM mr_room_equipment re JOIN mr_equipment e ON e.id = re.equipment_id
             WHERE re.room_id = r.id),
           '[]'::json) AS equipment
    FROM mr_rooms r
    JOIN mr_locations l ON l.id = r.location_id
   WHERE r.deleted_at IS NULL`;

export function toRoomView(r: any): RoomView {
  return {
    id: r.id, code: r.code, name: r.name, nameAr: r.name_ar,
    capacity: r.capacity, floor: r.floor,
    description: r.description, photoUrl: r.photo_url,
    status: r.status,
    // `time` comes back as HH:MM:SS; the portal wants HH:MM.
    opensAt: String(r.opens_at).slice(0, 5),
    closesAt: String(r.closes_at).slice(0, 5),
    maxAdvanceDays: r.max_advance_days,
    bufferMinutes: r.buffer_minutes,
    requiresApproval: r.requires_approval,
    location: {
      id: r.location_id, code: r.location_code, name: r.location_name,
      building: r.location_building, timezone: r.location_timezone,
    },
    equipment: r.equipment ?? [],
  };
}

export const parseEquipmentKeys = (csv?: string): string[] =>
  (csv ?? '').split(',').map((s) => s.trim()).filter(Boolean);

@Injectable()
export class RoomsService {
  async list(q: ListRoomsQuery): Promise<RoomView[]> {
    const where: string[] = [];
    const params: any[] = [];

    // Default to bookable rooms. An admin asking for ALL says so explicitly.
    if (!q.status || q.status === 'ACTIVE') where.push(`r.status = 'ACTIVE'`);
    else if (q.status !== 'ALL') { params.push(q.status); where.push(`r.status = $${params.length}`); }

    if (q.locationId) { params.push(q.locationId); where.push(`r.location_id = $${params.length}`); }
    if (q.minCapacity) { params.push(q.minCapacity); where.push(`r.capacity >= $${params.length}`); }
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(`(r.name ILIKE $${params.length} OR r.name_ar ILIKE $${params.length} OR r.code ILIKE $${params.length})`);
    }

    /* Equipment is an AND, not an OR: asking for a projector *and* a VC unit
       means a room that has both. Anything else surprises the person booking. */
    const keys = parseEquipmentKeys(q.equipment);
    if (keys.length) {
      params.push(keys);
      params.push(keys.length);
      where.push(`(SELECT COUNT(*) FROM mr_room_equipment re JOIN mr_equipment e ON e.id = re.equipment_id
                    WHERE re.room_id = r.id AND e.key = ANY($${params.length - 1})) = $${params.length}`);
    }

    const rows = await query(
      `${ROOM_SELECT} ${where.length ? `AND ${where.join(' AND ')}` : ''} ORDER BY r.capacity DESC, r.name`,
      params,
    );
    return rows.map(toRoomView);
  }

  async get(id: string): Promise<RoomView> {
    const row = await one(`${ROOM_SELECT} AND r.id = $1`, [id]);
    if (!row) throw new NotFoundException('Room not found');
    return toRoomView(row);
  }

  async locations() {
    return query(
      `SELECT l.id, l.code, l.name, l.name_ar, l.building, l.iana_timezone AS timezone,
              (SELECT COUNT(*)::int FROM mr_rooms r
                WHERE r.location_id = l.id AND r.deleted_at IS NULL) AS room_count
         FROM mr_locations l ORDER BY l.name`,
    );
  }

  async equipmentCatalogue() {
    return query(`SELECT key, name, name_ar, icon FROM mr_equipment ORDER BY name`);
  }

  /* ------------------------------------------------------------- writes -- */

  /**
   * Opening hours are the only policy left that can contradict itself, now
   * that the slot grid and the per-room duration limits are gone. Checked
   * against the merged current-plus-patch values so a PATCH that moves only
   * one of the two is still judged against the other.
   *
   * A room must also be open for longer than the shortest possible booking,
   * or it would appear in the catalogue and refuse every window offered.
   */
  private assertPolicy(dto: Partial<UpsertRoom>, current?: RoomView): void {
    const opens = dto.opensAt ?? current?.opensAt ?? '08:00';
    const closes = dto.closesAt ?? current?.closesAt ?? '18:00';
    if (closes <= opens) throw new BadRequestException('Closing time must be after opening time');

    const openMinutes = toMinutes(closes) - toMinutes(opens);
    if (openMinutes < BOOKING_LIMITS.MIN_MINUTES) {
      throw new BadRequestException(
        `A room must be open for at least ${BOOKING_LIMITS.MIN_MINUTES} minutes ` +
        `-- the shortest booking anyone can make.`);
    }
  }

  async create(dto: UpsertRoom): Promise<RoomView> {
    this.assertPolicy(dto);
    const id = await tx(async (c) => {
      let row;
      try {
        row = (await c.query(
          `INSERT INTO mr_rooms (code, name, name_ar, location_id, floor, capacity, description,
             photo_url, status, opens_at, closes_at,
             max_advance_days, buffer_minutes, requires_approval)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'ACTIVE'),
                   COALESCE($10::time,'08:00'),COALESCE($11::time,'18:00'),
                   COALESCE($12,90),COALESCE($13,0),COALESCE($14,false))
           RETURNING id`,
          [dto.code, dto.name, dto.nameAr ?? null, dto.locationId, dto.floor ?? null, dto.capacity,
           dto.description ?? null, dto.photoUrl ?? null, dto.status ?? null,
           dto.opensAt ?? null, dto.closesAt ?? null,
           dto.maxAdvanceDays ?? null, dto.bufferMinutes ?? null, dto.requiresApproval ?? null],
        )).rows[0];
      } catch (e: any) {
        if (e.code === '23505') throw new ConflictException(`A room with code "${dto.code}" already exists`);
        if (e.code === '23503') throw new BadRequestException('That location does not exist');
        throw e;
      }
      await this.replaceEquipment(c, row.id, dto.equipmentKeys);
      return row.id as string;
    });
    /* Read *after* the commit. Inside the transaction this would go out on a
       different pooled connection and find nothing -- the row is not visible
       to anyone else until COMMIT, and `get` is deliberately not transaction
       aware. */
    return this.get(id);
  }

  async update(id: string, dto: Partial<UpsertRoom>): Promise<RoomView> {
    const current = await this.get(id);
    this.assertPolicy(dto, current);

    const sets: string[] = [];
    const params: any[] = [];
    const set = (col: string, value: any) => {
      if (value === undefined) return;
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };

    set('code', dto.code); set('name', dto.name); set('name_ar', dto.nameAr);
    set('location_id', dto.locationId); set('floor', dto.floor); set('capacity', dto.capacity);
    set('description', dto.description); set('photo_url', dto.photoUrl); set('status', dto.status);
    // `time` columns need the cast: node-postgres sends a bare string as text.
    if (dto.opensAt !== undefined) { params.push(dto.opensAt); sets.push(`opens_at = $${params.length}::time`); }
    if (dto.closesAt !== undefined) { params.push(dto.closesAt); sets.push(`closes_at = $${params.length}::time`); }
    set('max_advance_days', dto.maxAdvanceDays);
    set('buffer_minutes', dto.bufferMinutes); set('requires_approval', dto.requiresApproval);

    await tx(async (c) => {
      if (sets.length) {
        params.push(id);
        try {
          await c.query(`UPDATE mr_rooms SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
        } catch (e: any) {
          if (e.code === '23505') throw new ConflictException(`A room with code "${dto.code}" already exists`);
          throw e;
        }
      }
      if (dto.equipmentKeys !== undefined) await this.replaceEquipment(c, id, dto.equipmentKeys);
    });
    return this.get(id);
  }

  /**
   * Retiring a room is a soft delete, and it is refused while the room still
   * has live bookings ahead of it. Silently orphaning eight meetings to make a
   * button work is not a kindness -- Facilities should see the number and
   * decide.
   */
  async retire(id: string): Promise<{ id: string; status: string }> {
    await this.get(id);
    const [{ count }] = await query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM mr_reservations
        WHERE room_id = $1 AND status IN ('PENDING','CONFIRMED') AND ends_at > now()`, [id]);
    if (count > 0) {
      throw new ConflictException(
        `This room has ${count} upcoming reservation${count === 1 ? '' : 's'}. ` +
        `Cancel or move them first, or set the room to MAINTENANCE to stop new bookings.`);
    }
    await query(`UPDATE mr_rooms SET deleted_at = now(), status = 'INACTIVE' WHERE id = $1`, [id]);
    return { id, status: 'RETIRED' };
  }

  private async replaceEquipment(c: any, roomId: string, keys?: string[]): Promise<void> {
    if (keys === undefined) return;
    await c.query(`DELETE FROM mr_room_equipment WHERE room_id = $1`, [roomId]);
    if (!keys.length) return;

    const { rows } = await c.query(`SELECT id, key FROM mr_equipment WHERE key = ANY($1)`, [keys]);
    const found = new Set(rows.map((r: any) => r.key));
    const unknown = keys.filter((k) => !found.has(k));
    if (unknown.length) {
      throw new BadRequestException(`Unknown equipment: ${unknown.join(', ')}`);
    }
    for (const r of rows) {
      await c.query(
        `INSERT INTO mr_room_equipment (room_id, equipment_id, quantity) VALUES ($1,$2,1)
         ON CONFLICT DO NOTHING`, [roomId, r.id]);
    }
  }
}

/** "09:30" -> 570. Lexical comparison already orders HH:mm correctly, so this
 *  exists only where the *difference* between two times is needed. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}