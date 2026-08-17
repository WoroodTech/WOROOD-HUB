// Mock implementation of the Core Platform + Meeting Rooms API described in
// the Technical Design Document, sections 3.3 and 5. Every function here
// returns data shaped exactly like the real `GET` endpoints will, so this
// file is the only thing that needs to change when the NestJS API exists —
// swap the bodies below for `fetch('/api/v1/...')` calls. Nothing in
// components/ or pages/ needs to change.

import type {
  FreeRoomNow,
  HubModule,
  HubModulesResponse,
  HubNotification,
  Principal,
  ReservationSummary,
} from '../types';

const NETWORK_DELAY_MS = 350;

function delay<T>(value: T, ms = NETWORK_DELAY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

// ---------------------------------------------------------------------------
// GET /auth/me
// ---------------------------------------------------------------------------

const CURRENT_USER: Principal = {
  id: 'usr_2f1a9c',
  fullName: 'Omar Khaled',
  fullNameAr: 'عمر خالد',
  email: 'omar.khaled@worood.co',
  jobTitle: 'Product Analyst',
  department: 'Strategy & Operations',
  locationName: 'Cairo — Head Office',
  timezone: 'Africa/Cairo',
  locale: 'en',
  avatarInitials: 'OK',
  roles: ['employee'],
  permissions: ['meeting-rooms.reservation.manage-own'],
};

export function fetchMe(): Promise<Principal> {
  return delay(CURRENT_USER);
}

// ---------------------------------------------------------------------------
// GET /hub/modules — drives the sidebar and the dashboard grid. This is the
// single source of truth: the frontend shell has no hard-coded menu.
// ---------------------------------------------------------------------------

const HUB_MODULES: HubModule[] = [
  {
    key: 'meeting-rooms',
    name: 'Meeting Rooms',
    nameAr: 'قاعات الاجتماعات',
    version: '1.0.0',
    enabled: true,
    navigation: [
      { label: 'Book a Room', path: '/meeting-rooms/book', icon: 'calendar-plus' },
      { label: 'My Reservations', path: '/meeting-rooms/reservations', icon: 'list' },
      {
        label: 'Manage Rooms',
        path: '/meeting-rooms/admin',
        icon: 'settings',
        requiresAnyPermission: ['meeting-rooms.room.manage'],
      },
    ],
    portlets: [
      { key: 'next-meeting', title: 'My Next Meeting', width: 4, order: 10 },
      { key: 'free-now', title: 'Free Right Now', width: 4, order: 20 },
      { key: 'my-reservations', title: 'Upcoming Reservations', width: 8, order: 40 },
    ],
  },
  {
    key: 'leave-requests',
    name: 'Leave Requests',
    nameAr: 'طلبات الإجازة',
    version: '0.0.0',
    enabled: false,
    comingSoon: true,
    navigation: [{ label: 'Leave Requests', path: '/leave-requests', icon: 'sun', comingSoon: true }],
    portlets: [],
  },
  {
    key: 'help-desk',
    name: 'Help Desk',
    nameAr: 'مكتب المساعدة',
    version: '0.0.0',
    enabled: false,
    comingSoon: true,
    navigation: [{ label: 'Help Desk', path: '/help-desk', icon: 'life-buoy', comingSoon: true }],
    portlets: [],
  },
  {
    key: 'documents',
    name: 'Document Library',
    nameAr: 'مكتبة المستندات',
    version: '0.0.0',
    enabled: false,
    comingSoon: true,
    navigation: [{ label: 'Document Library', path: '/documents', icon: 'folder', comingSoon: true }],
    portlets: [],
  },
];

/** Filters navigation/portlets a user cannot see, mirroring the real guard. */
export function fetchHubModules(principal: Principal): Promise<HubModulesResponse> {
  const visible = HUB_MODULES.map((m) => ({
    ...m,
    navigation: m.navigation.filter(
      (n) => !n.requiresAnyPermission || n.requiresAnyPermission.some((p) => principal.permissions.includes(p)),
    ),
  }));
  return delay({ modules: visible });
}

// ---------------------------------------------------------------------------
// Meeting Rooms portlet data
// ---------------------------------------------------------------------------

export function fetchNextMeeting(): Promise<ReservationSummary | null> {
  return delay({
    id: 'res_8817',
    title: 'Q3 Roadmap Sync',
    roomName: 'Falcon',
    locationName: 'Cairo — Head Office, 3rd Floor',
    startsAt: nextBusinessMoment(2, 30),
    endsAt: nextBusinessMoment(3, 15),
    organizerName: 'Omar Khaled',
    status: 'CONFIRMED',
  });
}

export function fetchFreeRoomsNow(): Promise<FreeRoomNow[]> {
  return delay([
    { roomId: 'room_1', roomName: 'Oryx', locationName: '2nd Floor', capacity: 4, freeForMinutes: 45, equipment: ['TV Screen'] },
    { roomId: 'room_2', roomName: 'Heron', locationName: '3rd Floor', capacity: 8, freeForMinutes: 120, equipment: ['Video Conference', 'Whiteboard'] },
    { roomId: 'room_3', roomName: 'Ibis', locationName: '1st Floor', capacity: 2, freeForMinutes: 20, equipment: [] },
  ]);
}

export function fetchMyReservations(): Promise<ReservationSummary[]> {
  return delay([
    {
      id: 'res_8817',
      title: 'Q3 Roadmap Sync',
      roomName: 'Falcon',
      locationName: 'Cairo — Head Office, 3rd Floor',
      startsAt: nextBusinessMoment(2, 30),
      endsAt: nextBusinessMoment(3, 15),
      organizerName: 'Omar Khaled',
      status: 'CONFIRMED',
    },
    {
      id: 'res_8790',
      title: 'Vendor Onboarding Call',
      roomName: 'Heron',
      locationName: 'Cairo — Head Office, 3rd Floor',
      startsAt: nextBusinessMoment(26, 0),
      endsAt: nextBusinessMoment(27, 0),
      organizerName: 'Omar Khaled',
      status: 'CONFIRMED',
    },
    {
      id: 'res_8655',
      title: 'Design Review',
      roomName: 'Oryx',
      locationName: 'Cairo — Head Office, 2nd Floor',
      startsAt: nextBusinessMoment(50, 0),
      endsAt: nextBusinessMoment(51, 0),
      organizerName: 'Hala Mansour',
      status: 'PENDING',
    },
  ]);
}

// ---------------------------------------------------------------------------
// Notifications (core_notifications, tagged by module)
// ---------------------------------------------------------------------------

export function fetchNotifications(): Promise<HubNotification[]> {
  return delay([
    {
      id: 'ntf_1',
      module: 'meeting-rooms',
      message: 'Your reservation "Q3 Roadmap Sync" in Falcon is confirmed.',
      createdAt: nextBusinessMoment(-3, 0),
      read: false,
    },
    {
      id: 'ntf_2',
      module: 'core',
      message: 'Welcome to WOROOD HUB — your new employee intranet.',
      createdAt: nextBusinessMoment(-48, 0),
      read: true,
    },
    {
      id: 'ntf_3',
      module: 'meeting-rooms',
      message: 'Facilities added a new room, "Heron", on the 3rd floor.',
      createdAt: nextBusinessMoment(-72, 0),
      read: true,
    },
  ]);
}

// Helper: an ISO timestamp `hours`+`minutes` from "now" at import time. Using
// a fixed reference avoids the environment's Date.now()/new Date() ban inside
// Workflow scripts elsewhere in this project; this file runs in the browser,
// where those are fine.
function nextBusinessMoment(hoursFromNow: number, minutes: number): string {
  const d = new Date();
  d.setHours(d.getHours() + hoursFromNow, d.getMinutes() + minutes, 0, 0);
  return d.toISOString();
}
