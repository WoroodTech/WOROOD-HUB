import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, gte, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../../common/database.module';
import type { Database } from '../../../db/client';
import { equipment, locations, roomEquipment, rooms } from '../../../db/schema';
import type { ListRoomsQueryDto, UpsertRoomDto } from '../dto';

export interface RoomView {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  capacity: number;
  floor: string | null;
  description: string | null;
  photoUrl: string | null;
  status: string;
  requiresApproval: boolean;
  openingTime: string;
  closingTime: string;
  slotMinutes: number;
  minDurationMinutes: number;
  maxDurationMinutes: number;
  maxAdvanceDays: number;
  bufferMinutes: number;
  location: { id: string; name: string; building: string | null; timezone: string };
  equipment: { key: string; name: string; icon: string | null; quantity: number }[];
}

@Injectable()
export class RoomsService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /* --------------------------------------------------------------------- */
  /* Reads                                                                  */
  /* --------------------------------------------------------------------- */

  async list(query: ListRoomsQueryDto): Promise<RoomView[]> {
    const requestedEquipment = (query.equipment ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);

    const statusFilter =
      !query.status || query.status === 'ACTIVE'
        ? eq(rooms.status, 'ACTIVE')
        : query.status === 'ALL'
          ? undefined
          : eq(rooms.status, query.status as 'ACTIVE' | 'MAINTENANCE' | 'INACTIVE');

    const rows = await this.db
      .select({ room: rooms, location: locations })
      .from(rooms)
      .innerJoin(locations, eq(locations.id, rooms.locationId))
      .where(
        and(
          isNull(rooms.deletedAt),
          statusFilter,
          query.locationId ? eq(rooms.locationId, query.locationId) : undefined,
          query.minCapacity ? gte(rooms.capacity, query.minCapacity) : undefined,
          query.q
            ? or(ilike(rooms.name, `%${query.q}%`), ilike(rooms.code, `%${query.q}%`))
            : undefined,
        ),
      )
      .orderBy(asc(locations.name), asc(rooms.name));

    const equipmentByRoom = await this.equipmentFor(rows.map((r) => r.room.id));

    const views = rows.map(({ room, location }) =>
      RoomsService.toView(room, location, equipmentByRoom.get(room.id) ?? []),
    );

    // Equipment is an AND filter: the room must have every requested item.
    if (requestedEquipment.length === 0) return views;
    return views.filter((room) => {
      const keys = new Set(room.equipment.map((e) => e.key));
      return requestedEquipment.every((k) => keys.has(k));
    });
  }

  async findById(id: string): Promise<RoomView> {
    const [row] = await this.db
      .select({ room: rooms, location: locations })
      .from(rooms)
      .innerJoin(locations, eq(locations.id, rooms.locationId))
      .where(and(eq(rooms.id, id), isNull(rooms.deletedAt)))
      .limit(1);

    if (!row) throw new NotFoundException('Room not found');
    const equipmentByRoom = await this.equipmentFor([id]);
    return RoomsService.toView(row.room, row.location, equipmentByRoom.get(id) ?? []);
  }

  /** Raw row + timezone, used internally by the booking rules. */
  async findBookableRoom(id: string) {
    const [row] = await this.db
      .select({ room: rooms, timezone: locations.timezone })
      .from(rooms)
      .innerJoin(locations, eq(locations.id, rooms.locationId))
      .where(and(eq(rooms.id, id), isNull(rooms.deletedAt)))
      .limit(1);

    if (!row) throw new NotFoundException('Room not found');
    if (row.room.status !== 'ACTIVE') {
      throw new BadRequestException(
        row.room.status === 'MAINTENANCE'
          ? 'This room is under maintenance and cannot be booked'
          : 'This room is not available for booking',
      );
    }
    return row;
  }

  async listLocations() {
    return this.db.select().from(locations).orderBy(asc(locations.name));
  }

  async listEquipment() {
    return this.db.select().from(equipment).orderBy(asc(equipment.name));
  }

  /* --------------------------------------------------------------------- */
  /* Writes (facilities administrators)                                     */
  /* --------------------------------------------------------------------- */

  async create(dto: UpsertRoomDto): Promise<RoomView> {
    RoomsService.assertPolicy(dto);
    const [existing] = await this.db.select({ id: rooms.id }).from(rooms).where(eq(rooms.code, dto.code)).limit(1);
    if (existing) throw new ConflictException(`Room code "${dto.code}" is already in use`);

    const created = await this.db.transaction(async (tx) => {
      const [room] = await tx
        .insert(rooms)
        .values({
          code: dto.code,
          name: dto.name,
          nameAr: dto.nameAr ?? null,
          locationId: dto.locationId,
          floor: dto.floor ?? null,
          capacity: dto.capacity,
          description: dto.description ?? null,
          photoUrl: dto.photoUrl ?? null,
          status: dto.status ?? 'ACTIVE',
          openingTime: dto.openingTime ? `${dto.openingTime}:00` : undefined,
          closingTime: dto.closingTime ? `${dto.closingTime}:00` : undefined,
          slotMinutes: dto.slotMinutes,
          minDurationMinutes: dto.minDurationMinutes,
          maxDurationMinutes: dto.maxDurationMinutes,
          maxAdvanceDays: dto.maxAdvanceDays,
          bufferMinutes: dto.bufferMinutes,
          requiresApproval: dto.requiresApproval,
        })
        .returning();

      await this.syncEquipment(tx, room.id, dto.equipmentKeys);
      return room;
    });

    return this.findById(created.id);
  }

  async update(id: string, dto: Partial<UpsertRoomDto>): Promise<RoomView> {
    RoomsService.assertPolicy(dto);
    await this.findById(id);

    await this.db.transaction(async (tx) => {
      await tx
        .update(rooms)
        .set({
          ...(dto.code !== undefined && { code: dto.code }),
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.nameAr !== undefined && { nameAr: dto.nameAr }),
          ...(dto.locationId !== undefined && { locationId: dto.locationId }),
          ...(dto.floor !== undefined && { floor: dto.floor }),
          ...(dto.capacity !== undefined && { capacity: dto.capacity }),
          ...(dto.description !== undefined && { description: dto.description }),
          ...(dto.photoUrl !== undefined && { photoUrl: dto.photoUrl }),
          ...(dto.status !== undefined && { status: dto.status }),
          ...(dto.openingTime !== undefined && { openingTime: `${dto.openingTime}:00` }),
          ...(dto.closingTime !== undefined && { closingTime: `${dto.closingTime}:00` }),
          ...(dto.slotMinutes !== undefined && { slotMinutes: dto.slotMinutes }),
          ...(dto.minDurationMinutes !== undefined && { minDurationMinutes: dto.minDurationMinutes }),
          ...(dto.maxDurationMinutes !== undefined && { maxDurationMinutes: dto.maxDurationMinutes }),
          ...(dto.maxAdvanceDays !== undefined && { maxAdvanceDays: dto.maxAdvanceDays }),
          ...(dto.bufferMinutes !== undefined && { bufferMinutes: dto.bufferMinutes }),
          ...(dto.requiresApproval !== undefined && { requiresApproval: dto.requiresApproval }),
        })
        .where(eq(rooms.id, id));

      if (dto.equipmentKeys) await this.syncEquipment(tx, id, dto.equipmentKeys);
    });

    return this.findById(id);
  }

  /** Soft delete — historical reservations must remain readable. */
  async retire(id: string): Promise<void> {
    await this.findById(id);
    await this.db
      .update(rooms)
      .set({ deletedAt: new Date(), status: 'INACTIVE' })
      .where(eq(rooms.id, id));
  }

  /* --------------------------------------------------------------------- */
  /* Helpers                                                                */
  /* --------------------------------------------------------------------- */

  private async equipmentFor(roomIds: string[]) {
    const map = new Map<string, RoomView['equipment']>();
    if (roomIds.length === 0) return map;

    const rows = await this.db
      .select({
        roomId: roomEquipment.roomId,
        key: equipment.key,
        name: equipment.name,
        icon: equipment.icon,
        quantity: roomEquipment.quantity,
      })
      .from(roomEquipment)
      .innerJoin(equipment, eq(equipment.id, roomEquipment.equipmentId))
      .where(inArray(roomEquipment.roomId, roomIds))
      .orderBy(asc(equipment.name));

    for (const row of rows) {
      const list = map.get(row.roomId) ?? [];
      list.push({ key: row.key, name: row.name, icon: row.icon, quantity: row.quantity });
      map.set(row.roomId, list);
    }
    return map;
  }

  private async syncEquipment(tx: any, roomId: string, keys?: string[]) {
    if (!keys) return;
    await tx.delete(roomEquipment).where(eq(roomEquipment.roomId, roomId));
    if (keys.length === 0) return;

    const found = await tx.select().from(equipment).where(inArray(equipment.key, keys));
    if (found.length !== keys.length) {
      const missing = keys.filter((k) => !found.some((f: any) => f.key === k));
      throw new BadRequestException(`Unknown equipment key(s): ${missing.join(', ')}`);
    }
    await tx.insert(roomEquipment).values(found.map((e: any) => ({ roomId, equipmentId: e.id, quantity: 1 })));
  }

  private static assertPolicy(dto: Partial<UpsertRoomDto>) {
    if (
      dto.minDurationMinutes !== undefined &&
      dto.maxDurationMinutes !== undefined &&
      dto.minDurationMinutes > dto.maxDurationMinutes
    ) {
      throw new BadRequestException('minDurationMinutes cannot exceed maxDurationMinutes');
    }
    if (dto.openingTime && dto.closingTime && dto.openingTime >= dto.closingTime) {
      throw new BadRequestException('closingTime must be after openingTime');
    }
  }

  private static toView(room: any, location: any, roomEquipmentList: RoomView['equipment']): RoomView {
    return {
      id: room.id,
      code: room.code,
      name: room.name,
      nameAr: room.nameAr,
      capacity: room.capacity,
      floor: room.floor,
      description: room.description,
      photoUrl: room.photoUrl,
      status: room.status,
      requiresApproval: room.requiresApproval,
      openingTime: String(room.openingTime).slice(0, 5),
      closingTime: String(room.closingTime).slice(0, 5),
      slotMinutes: room.slotMinutes,
      minDurationMinutes: room.minDurationMinutes,
      maxDurationMinutes: room.maxDurationMinutes,
      maxAdvanceDays: room.maxAdvanceDays,
      bufferMinutes: room.bufferMinutes,
      location: {
        id: location.id,
        name: location.name,
        building: location.building,
        timezone: location.timezone,
      },
      equipment: roomEquipmentList,
    };
  }
}
