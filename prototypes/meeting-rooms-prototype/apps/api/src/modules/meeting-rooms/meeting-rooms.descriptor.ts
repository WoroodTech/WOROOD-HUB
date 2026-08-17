import { registerHubModule } from '../../core/hub/module-registry';

/** Permission keys owned by this module. Referenced by guards and the seeder. */
export const MR_PERMISSIONS = {
  ROOM_READ: 'meeting-rooms.room.read',
  ROOM_MANAGE: 'meeting-rooms.room.manage',
  RESERVATION_CREATE: 'meeting-rooms.reservation.create',
  RESERVATION_READ_ALL: 'meeting-rooms.reservation.read_all',
  RESERVATION_MANAGE_ALL: 'meeting-rooms.reservation.manage_all',
} as const;

export const MEETING_ROOMS_MODULE = registerHubModule({
  key: 'meeting-rooms',
  name: 'Meeting Rooms',
  nameAr: 'قاعات الاجتماعات',
  description: 'Find, book and manage meeting rooms across Worood offices.',
  version: '1.0.0',
  icon: 'calendar',
  apiPrefix: '/api/v1/meeting-rooms',
  tablePrefix: 'mr_',
  enabled: true,
  navigation: [
    { label: 'Book a Room', labelAr: 'حجز قاعة', path: '/meeting-rooms/book', icon: 'search' },
    { label: 'Rooms', labelAr: 'القاعات', path: '/meeting-rooms/rooms', icon: 'grid' },
    {
      label: 'My Reservations',
      labelAr: 'حجوزاتي',
      path: '/meeting-rooms/reservations',
      icon: 'list',
    },
    {
      label: 'Manage Rooms',
      labelAr: 'إدارة القاعات',
      path: '/meeting-rooms/admin',
      icon: 'settings',
      requiresAnyPermission: [MR_PERMISSIONS.ROOM_MANAGE],
    },
  ],
  portlets: [
    { key: 'next-meeting', title: 'My Next Meeting', titleAr: 'اجتماعي القادم', width: 4, order: 10 },
    { key: 'quick-book', title: 'Quick Book', titleAr: 'حجز سريع', width: 4, order: 20 },
    { key: 'free-now', title: 'Free Right Now', titleAr: 'متاح الآن', width: 4, order: 30 },
    { key: 'my-upcoming', title: 'Upcoming Reservations', titleAr: 'الحجوزات القادمة', width: 12, order: 40 },
  ],
  permissions: [
    { key: MR_PERMISSIONS.ROOM_READ, description: 'View rooms and availability' },
    { key: MR_PERMISSIONS.ROOM_MANAGE, description: 'Create, edit and retire rooms' },
    { key: MR_PERMISSIONS.RESERVATION_CREATE, description: 'Book a room and manage own bookings' },
    { key: MR_PERMISSIONS.RESERVATION_READ_ALL, description: "View all employees' reservations" },
    {
      key: MR_PERMISSIONS.RESERVATION_MANAGE_ALL,
      description: "Modify or cancel any employee's reservation",
    },
  ],
});
