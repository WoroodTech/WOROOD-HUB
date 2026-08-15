/**
 * Module 1: Meeting Room Reservation System.
 *
 * Present in this build at portlet depth only -- enough for the home dashboard
 * to render a genuinely multi-module grid and for the sales module to be seen
 * sitting alongside an existing one. The full booking flow, availability
 * search and room administration are the subject of the Module 1 design doc.
 */
import { Controller, Get, Module } from '@nestjs/common';
import { CurrentUser, Permissions, Principal } from '../../common/auth';
import { query } from '../../common/db';
import { registerHubModule } from '../../core/hub-registry';

export const MEETING_ROOMS_MODULE = registerHubModule({
  key: 'meeting-rooms',
  name: 'Meeting Rooms',
  nameAr: 'قاعات الاجتماعات',
  version: '1.0.0',
  apiPrefix: '/api/v1/meeting-rooms',
  tablePrefix: 'mr_',
  enabled: true,
  navigation: [
    { label: 'Book a Room', labelAr: 'حجز قاعة', path: '/meeting-rooms/book', icon: 'search' },
    { label: 'My Reservations', labelAr: 'حجوزاتي', path: '/meeting-rooms/reservations', icon: 'calendar' },
    { label: 'Manage Rooms', labelAr: 'إدارة القاعات', path: '/meeting-rooms/admin', icon: 'settings',
      requiresAnyPermission: ['meeting-rooms.room.manage'] },
  ],
  // No permission gate: every employee may see their own next meeting.
  portlets: [
    { key: 'next-meeting', title: 'My Next Meeting', titleAr: 'اجتماعي القادم', width: 4, order: 10 },
    { key: 'free-now', title: 'Free Right Now', titleAr: 'متاحة الآن', width: 4, order: 30 },
    { key: 'upcoming-reservations', title: 'My Upcoming Reservations', titleAr: 'حجوزاتي القادمة', width: 4, order: 40 },
  ],
  permissions: [
    { key: 'meeting-rooms.room.manage', description: 'Create, edit and retire rooms' },
    { key: 'meeting-rooms.reservation.manage-any', description: 'Modify or cancel anyone’s reservation' },
  ],
});

@Controller('meeting-rooms/portlets')
export class MeetingRoomsPortletsController {
  @Get('next-meeting')
  async nextMeeting(@CurrentUser() p: Principal) {
    const rows = await query(
      `SELECT r.reference, r.title, r.starts_at, r.ends_at, r.attendees,
              rm.name AS room, rm.floor
         FROM mr_reservations r JOIN mr_rooms rm ON rm.id = r.room_id
        WHERE r.organizer_id = $1 AND r.status = 'CONFIRMED' AND r.ends_at > now()
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
        WHERE r.organizer_id = $1 AND r.status = 'CONFIRMED' AND r.starts_at > now()
        ORDER BY r.starts_at ASC LIMIT 5`, [p.id],
    );
    return { reservations: rows.map((r) => ({
      reference: r.reference, title: r.title, room: r.room,
      startsAt: r.starts_at, endsAt: r.ends_at,
    })) };
  }

  @Get('rooms')
  @Permissions('meeting-rooms.room.manage')
  async rooms() {
    return { rooms: await query(
      `SELECT id, name, name_ar, capacity, floor, status, equipment
         FROM mr_rooms WHERE deleted_at IS NULL ORDER BY name`) };
  }
}

@Module({ controllers: [MeetingRoomsPortletsController] })
export class MeetingRoomsModule {}
