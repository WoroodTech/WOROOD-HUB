// Shared shapes mirroring the API contracts described in the Technical Design
// Document (WOROOD-HUB-Technical-Design.md, sections 3.3 and 5). These will be
// replaced by the generated types from the NestJS API once it exists; for now
// the mock API in lib/api/* returns data matching these shapes exactly, so
// swapping the mock for real `fetch` calls later requires no component changes.

export interface Principal {
  id: string;
  fullName: string;
  fullNameAr?: string;
  email: string;
  jobTitle: string;
  department: string;
  locationName: string;
  timezone: string;
  locale: 'en' | 'ar';
  avatarInitials: string;
  roles: string[];
  permissions: string[];
}

export type PortletKey =
  | 'next-meeting'
  | 'free-now'
  | 'my-reservations'
  | 'quick-actions'
  | 'announcements'
  | 'coming-soon';

export interface PortletDescriptor {
  key: PortletKey;
  title: string;
  /** columns out of a 12-column grid, per section 7 */
  width: 4 | 6 | 8 | 12;
  order: number;
}

export interface NavItem {
  label: string;
  path: string;
  icon: string;
  requiresAnyPermission?: string[];
  comingSoon?: boolean;
}

export interface HubModule {
  key: string;
  name: string;
  nameAr?: string;
  version: string;
  enabled: boolean;
  comingSoon?: boolean;
  navigation: NavItem[];
  portlets: PortletDescriptor[];
}

export interface HubModulesResponse {
  modules: HubModule[];
}

export interface ReservationSummary {
  id: string;
  title: string;
  roomName: string;
  locationName: string;
  startsAt: string; // ISO, UTC
  endsAt: string; // ISO, UTC
  organizerName: string;
  status: 'PENDING' | 'CONFIRMED' | 'CANCELLED';
}

export interface FreeRoomNow {
  roomId: string;
  roomName: string;
  locationName: string;
  capacity: number;
  freeForMinutes: number;
  equipment: string[];
}

export interface HubNotification {
  id: string;
  module: string;
  message: string;
  createdAt: string;
  read: boolean;
}
