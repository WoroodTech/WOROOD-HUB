/**
 * Module 1: Meeting Room Reservation System.
 *
 * The descriptor is the whole integration: the sidebar, the home-screen grid
 * and the permission rows all come from it. Note that every path it advertises
 * now has both an endpoint below and a screen in the portal -- an entry here
 * with nothing behind it is a link to a dead end, which is exactly the state
 * this module was in when it existed at portlet depth only.
 */

import {
  Body, Controller, Delete, Get, Module, Param, ParseUUIDPipe, Patch, Post, Query,
} from '@nestjs/common';
import { CurrentUser, Permissions, Principal } from '../../common/auth';
import { query } from '../../common/db';
import { registerHubModule } from '../../core/hub-registry';
import { MR_PERMISSIONS } from './permissions';
import {
  AvailabilityQuery, CancelReservation, CreateReservation, ListReservationsQuery,
  ListRoomsQuery, UpdateReservation, UpsertRoom,
} from './dto';
import { RoomsService } from './rooms.service';
import { AvailabilityService } from './availability.service';
import { ReservationsService } from './reservations.service';

export const MEETING_ROOMS_MODULE = registerHubModule({
  key: 'meeting-rooms',
  name: 'Meeting Rooms',
  nameAr: 'قاعات الاجتماعات',
  version: '2.0.0',
  apiPrefix: '/api/v1/meeting-rooms',
  tablePrefix: 'mr_',
  enabled: true,
  navigation: [
    { label: 'Book a Room', labelAr: 'حجز قاعة', path: '/meeting-rooms/book', icon: 'search' },
    { label: 'My Reservations', labelAr: 'حجوزاتي', path: '/meeting-rooms/reservations', icon: 'calendar' },
    { label: 'Manage Rooms', labelAr: 'إدارة القاعات', path: '/meeting-rooms/admin', icon: 'door',
      requiresAnyPermission: [MR_PERMISSIONS.ROOM_MANAGE] },
  ],
  // No permission gate: every employee may see their own next meeting.
  portlets: [
    { key: 'next-meeting', title: 'My Next Meeting', titleAr: 'اجتماعي القادم', width: 4, order: 10 },
    { key: 'free-now', title: 'Free Right Now', titleAr: 'متاحة الآن', width: 4, order: 30 },
    { key: 'upcoming-reservations', title: 'My Upcoming Reservations', titleAr: 'حجوزاتي القادمة', width: 4, order: 40 },
  ],
  permissions: [
    { key: MR_PERMISSIONS.ROOM_MANAGE, description: 'Create, edit and retire rooms' },
    { key: MR_PERMISSIONS.MANAGE_ANY, description: 'Modify or cancel anyone’s reservation' },
  ],
});

/* ------------------------------------------------------------- portlets -- */

@Controller('meeting-rooms/portlets')
export class MeetingRoomsPortletsController {
  @Get('next-meeting')
  async nextMeeting(@CurrentUser() p: Principal) {
    const rows = await query(
      `SELECT r.reference, r.title, r.starts_at, r.ends_at, r.attendees,
              rm.name AS room, rm.floor
         FROM mr_reservations r JOIN mr_rooms rm ON rm.id = r.room_id
        WHERE r.organizer_id = $1 AND r.status IN ('PENDING','CONFIRMED') AND r.ends_at > now()
        ORDER BY r.starts_at ASC LIMIT 1`, [p.id],
    );
    const m = rows[0];
    return { meeting: m ? {
      reference: m.reference, title: m.title, room: m.room, floor: m.floor,
      startsAt: m.starts_at, endsAt: m.ends_at, attendees: m.attendees,
    } : null };
  }

  @Get('free-now')
  async freeNow() {
    // A room is free if nothing live overlaps the next 30 minutes. The same
    // GiST index that backs the no-overlap constraint accelerates this.
    // Blackouts count as busy: a room being deep-cleaned is not walk-in-able.
    const rows = await query(
      `SELECT rm.name, rm.floor, rm.capacity,
              (SELECT EXTRACT(EPOCH FROM (MIN(r2.starts_at) - now()))/60
                 FROM mr_reservations r2
                WHERE r2.room_id = rm.id AND r2.status IN ('PENDING','CONFIRMED')
                  AND r2.starts_at > now()) AS free_for_minutes
         FROM mr_rooms rm
        WHERE rm.deleted_at IS NULL AND rm.status = 'ACTIVE'
          AND NOT EXISTS (
            SELECT 1 FROM mr_reservations r
             WHERE r.room_id = rm.id AND r.status IN ('PENDING','CONFIRMED')
               AND tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(now(), now() + interval '30 minutes', '[)'))
          AND NOT EXISTS (
            SELECT 1 FROM mr_room_blackouts b
             WHERE b.room_id = rm.id
               AND tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(now(), now() + interval '30 minutes', '[)'))
        ORDER BY rm.capacity DESC LIMIT 6`,
    );
    return { rooms: rows.map((r) => ({
      name: r.name, floor: r.floor, capacity: r.capacity,
      freeForMinutes: r.free_for_minutes === null ? null : Math.round(Number(r.free_for_minutes)),
    })) };
  }

  @Get('upcoming-reservations')
  async upcoming(@CurrentUser() p: Principal) {
    const rows = await query(
      `SELECT r.reference, r.title, r.starts_at, r.ends_at, rm.name AS room
         FROM mr_reservations r JOIN mr_rooms rm ON rm.id = r.room_id
        WHERE r.organizer_id = $1 AND r.status IN ('PENDING','CONFIRMED') AND r.starts_at > now()
        ORDER BY r.starts_at ASC LIMIT 5`, [p.id],
    );
    return { reservations: rows.map((r) => ({
      reference: r.reference, title: r.title, room: r.room,
      startsAt: r.starts_at, endsAt: r.ends_at,
    })) };
  }
}

/* ------------------------------------------------- rooms and reservations -- */

@Controller('meeting-rooms')
export class MeetingRoomsController {
  constructor(
    private readonly rooms: RoomsService,
    private readonly availability: AvailabilityService,
    private readonly reservations: ReservationsService,
  ) {}

  /* Reading the catalogue is open to every employee: you cannot choose a room
     you are not allowed to know exists. Changing it is gated. */
  @Get('rooms')
  async listRooms(@Query() q: ListRoomsQuery) { return { rooms: await this.rooms.list(q) }; }

  @Get('rooms/:id')
  getRoom(@Param('id', ParseUUIDPipe) id: string) { return this.rooms.get(id); }

  @Get('locations')
  async listLocations() { return { locations: await this.rooms.locations() }; }

  @Get('equipment')
  async listEquipment() { return { equipment: await this.rooms.equipmentCatalogue() }; }

  @Get('availability')
  availabilitySearch(@Query() q: AvailabilityQuery) { return this.availability.search(q); }

  @Get('reservations')
  listReservations(@CurrentUser() p: Principal, @Query() q: ListReservationsQuery) {
    return this.reservations.list(p, q);
  }

  @Get('reservations/:id')
  getReservation(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.reservations.get(p, id);
  }

  @Post('reservations')
  book(@CurrentUser() p: Principal, @Body() dto: CreateReservation) {
    return this.reservations.create(p, dto);
  }

  @Patch('reservations/:id')
  amend(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateReservation) {
    return this.reservations.update(p, id, dto);
  }

  /* Cancelling is a state change, not a deletion: the row stays, so the room's
     history survives, and the exclusion constraint releases the slot on its
     own because it only applies to live bookings. */
  @Delete('reservations/:id')
  cancel(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelReservation) {
    return this.reservations.cancel(p, id, dto ?? {});
  }

  /* ---------------------------------------------------------- room admin -- */

  @Post('admin/rooms')
  @Permissions(MR_PERMISSIONS.ROOM_MANAGE)
  createRoom(@Body() dto: UpsertRoom) { return this.rooms.create(dto); }

  @Patch('admin/rooms/:id')
  @Permissions(MR_PERMISSIONS.ROOM_MANAGE)
  updateRoom(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpsertRoom) {
    return this.rooms.update(id, dto);
  }

  @Delete('admin/rooms/:id')
  @Permissions(MR_PERMISSIONS.ROOM_MANAGE)
  retireRoom(@Param('id', ParseUUIDPipe) id: string) { return this.rooms.retire(id); }
}

@Module({
  controllers: [MeetingRoomsPortletsController, MeetingRoomsController],
  providers: [RoomsService, AvailabilityService, ReservationsService],
})
export class MeetingRoomsModule {}
