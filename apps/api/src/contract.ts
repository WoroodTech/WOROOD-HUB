/**
 * The contract shared by the API and the portal. Every payload shape that
 * crosses the network is declared here exactly once, so a change to a response
 * breaks compilation on the consumer rather than at runtime in a browser.
 *
 * This file is the source of truth; `scripts/sync-contract.sh` copies it into
 * both apps. It is type-only, so a copy needs no runtime resolver or build step.
 */

export interface Principal {
  id: string; email: string; fullName: string; fullNameAr?: string | null;
  jobTitle?: string | null; department?: string | null;
  timezone: string; locale: string; roles: string[]; permissions: string[];
}

export interface LoginResponse {
  accessToken: string; refreshToken: string; expiresIn: number; principal: Principal;
}

export interface HubNavItem { label: string; labelAr?: string; path: string; icon: string }
export interface HubPortlet {
  key: string; moduleKey: string; title: string; titleAr?: string;
  width: number; order: number;
}
export interface HubModule {
  key: string; name: string; nameAr?: string; version: string;
  enabled: boolean; comingSoon?: boolean;
  navigation: HubNavItem[]; portlets: HubPortlet[];
}
export interface HubModulesResponse { modules: HubModule[]; dashboard: HubPortlet[] }

/* --------------------------------------------------- home-screen portlets -- */

export interface MyDashboardsPortlet {
  dashboards: Array<{
    key: string; name: string; nameAr?: string | null; description?: string | null;
    headline?: { label: string; value: string } | null;
    dataAgeSeconds: number | null;
  }>;
}

export interface StorePulseMetric {
  key: 'total_sales' | 'orders' | 'sessions' | 'conversion_rate' | 'collected';
  label: string; value: number;
  format: 'money' | 'integer' | 'percent';
  comparedTo: number | null; comparisonLabel: string;
}

export interface StorePulsePortlet {
  shopName: string; currency: string; timezone: string;
  businessDate: string; provisional: boolean; dataAgeSeconds: number | null;
  metrics: StorePulseMetric[];
}

export interface MyAlertsPortlet {
  alerts: Array<{
    id: string; severity: 'INFO' | 'WARNING' | 'CRITICAL';
    title: string; body?: string | null; link?: string | null;
    createdAt: string; readAt?: string | null;
  }>;
  unread: number;
}

export interface MyInvitationsPortlet {
  invitations: Array<{
    id: string; reference: string; title: string;
    room: string; floor: string | null;
    startsAt: string; endsAt: string;
    organiserName: string;
  }>;
}

export interface NextMeetingPortlet {
  /** The next meeting you are *in* -- not merely the next one you booked. */
  meeting: { reference: string; title: string; room: string; floor: string | null;
             startsAt: string; endsAt: string; attendees: number;
             isOrganiser: boolean; organiserName: string | null;
             myResponse: 'INVITED' | 'ACCEPTED' | 'DECLINED' | null } | null;
}
export interface FreeNowPortlet {
  rooms: Array<{ name: string; floor: string | null; capacity: number; freeForMinutes: number | null }>;
}
export interface UpcomingReservationsPortlet {
  reservations: Array<{ reference: string; title: string; room: string;
                        startsAt: string; endsAt: string;
                        isOrganiser: boolean; organiserName: string | null }>;
}

/* ------------------------------------------------------- administration -- */

export interface AdminRoleRef { id: string; key: string; name: string }

export interface AdminUserSummary {
  id: string; email: string; fullName: string; fullNameAr: string | null;
  jobTitle: string | null; department: string | null; departmentId: string | null;
  timezone: string; locale: string; status: 'ACTIVE' | 'SUSPENDED';
  lastLoginAt: string | null; createdAt: string;
  roles: AdminRoleRef[];
  /** Whether this account can reach the administration console. */
  isAdministrator: boolean;
}

export interface AdminUserDetail extends AdminUserSummary {
  /** Computed from their roles, with the role that supplied each one -- the
   *  answer to "why can they do that?", which a flat key list does not give. */
  permissions: Array<{ key: string; moduleKey: string; description: string | null; viaRoles: string[] }>;
  dashboards: Array<{
    id: string; key: string; name: string;
    viaRole: boolean; override: 'GRANT' | 'REVOKE' | null; effective: boolean;
  }>;
}

export interface AdminPermission { key: string; moduleKey: string; description: string | null }

export interface AdminRole {
  id: string; key: string; name: string; nameAr: string | null; description: string | null;
  permissions: AdminPermission[];
  holders: number;
  grantsConsole: boolean;
}

export interface AdminDepartment { id: string; name: string; head_count: number }
export interface AdminDashboardRef { id: string; key: string; name: string; description: string | null }

/* --------------------------------------------------------- meeting rooms -- */

export interface MeetingRoomEquipment { key: string; name: string; icon: string | null; quantity: number }

export interface MeetingRoom {
  id: string; code: string; name: string; nameAr: string | null;
  capacity: number; floor: string | null;
  description: string | null; photoUrl: string | null;
  status: 'ACTIVE' | 'MAINTENANCE' | 'INACTIVE';
  opensAt: string; closesAt: string;
  maxAdvanceDays: number; bufferMinutes: number; requiresApproval: boolean;
  location: { id: string; code: string; name: string; building: string | null; timezone: string };
  equipment: MeetingRoomEquipment[];
}

export interface MeetingLocation {
  id: string; code: string; name: string; name_ar: string | null;
  building: string | null; timezone: string; room_count: number;
}

export interface AvailabilitySlot { startsAt: string; endsAt: string }

/** One room's answer about one requested window.
 *
 *  This replaced a per-room list of offered slots. Rooms no longer publish the
 *  start times they will accept -- the employee names a time and a length, so
 *  each room has one thing to say about it and, when the answer is no, one
 *  useful thing to say next. */
/** What a blocked room is blocked by. A booking and a changeover buffer are
 *  both "not available" and are not the same news. */
export type BlockedBy = 'BOOKING' | 'BUFFER' | 'BLACKOUT';

export interface RoomAvailability {
  room: MeetingRoom;
  available: boolean;
  /** Why not, when not. */
  reason?: string;
  /** The kind of obstruction. Absent when the room is free, and when the
   *  refusal has nothing to do with the timeline -- too small, closed, past. */
  blockedBy?: BlockedBy;
  /** This same room's earliest window of the same length at or after the time
   *  asked for. Null when nothing is left today. Only sent for a room that is
   *  unavailable -- there is nothing to suggest about one that is free. */
  nextFree?: { startsAt: string; endsAt: string } | null;
}

export interface AvailabilityResponse {
  date: string;
  /** The window every answer below is about, stated once. */
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  /** The room the employee asked for, when they asked for one. */
  requested?: RoomAvailability;
  /** Other rooms free for exactly this window. */
  alternatives: RoomAvailability[];
  /** Rooms that matched the filters and cannot take it, each with its reason.
   *  Kept visible rather than filtered away, so "why isn't Lotus here?" is
   *  answered before it is asked. */
  unavailable: RoomAvailability[];
}

export interface RoomCalendarEntry {
  id: string; reference: string; title: string;
  startsAt: string; endsAt: string;
  status: 'PENDING' | 'CONFIRMED';
  organiserName: string;
  isMine: boolean;
  canManage: boolean;
}

export type RoomCalendarBlock =
  | {
      type: 'BOOKING'; id: string; reference: string; title: string;
      startsAt: string; endsAt: string; status: 'PENDING' | 'CONFIRMED';
      organiserName: string; isMine: boolean; canManage: boolean;
    }
  | { type: 'BLACKOUT'; startsAt: string; endsAt: string; reason: string | null }
  | { type: 'BUFFER'; startsAt: string; endsAt: string };

/** A room's timeline for one day, in the room's own timezone. */
export interface RoomCalendarResponse {
  room: {
    id: string;
    name: string;
    nameAr: string | null;
    opensAt: string;
    closesAt: string;
    bufferMinutes: number;
  };
  date: string;
  blocks: RoomCalendarBlock[];
}

export interface Reservation {
  id: string; reference: string; title: string; description: string | null;
  startsAt: string; endsAt: string;
  status: 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED';
  attendeeCount: number;
  room: { id: string; name: string; nameAr: string | null; floor: string | null; capacity: number; location: string };
  organiser: { id: string; fullName: string; email: string };
  attendees: Array<{
    userId: string | null; name: string; email: string;
    response: 'INVITED' | 'ACCEPTED' | 'DECLINED';
    respondedAt: string | null;
  }>;
  cancelledAt: string | null; cancellationReason: string | null;
  /** Decided by the API, never re-derived here. */
  canManage: boolean;
  /** What the caller is to this meeting, and their own answer if invited. */
  myRole: 'organiser' | 'attendee' | 'none';
  myResponse: 'INVITED' | 'ACCEPTED' | 'DECLINED' | null;
}

export interface ReservationsResponse {
  reservations: Reservation[];
  scope: 'mine' | 'invited' | 'organised' | 'all';
  period: string;
}

/** The employee directory, for picking attendees. */
export interface DirectoryPerson {
  id: string; fullName: string; fullNameAr: string | null;
  email: string; jobTitle: string | null;
}

/* ------------------------------------------------------ sales dashboards -- */

export type WidgetKind = 'kpi' | 'line' | 'bar' | 'donut' | 'table' | 'funnel';

export interface WidgetDefinition {
  key: string; name: string; nameAr?: string | null; description?: string | null;
  kind: WidgetKind; dataSource: string; requiredPermission?: string | null;
  minWidth: number; maxWidth: number; defaultWidth: number;
  defaultConfig: Record<string, unknown>;
}

export interface DashboardWidgetPlacement {
  id: string; widgetKey: string; name: string; nameAr?: string | null;
  kind: WidgetKind; position: number; width: number;
  config: Record<string, unknown>;
}

export interface DashboardSummary {
  id: string; key: string; name: string; nameAr?: string | null;
  description?: string | null; isSystem: boolean; widgetCount: number;
  /** Why this employee can see it -- role default, individual grant, or admin. */
  grantedBy: 'ROLE' | 'USER' | 'ADMIN';
}

export interface DashboardDetail extends DashboardSummary {
  widgets: DashboardWidgetPlacement[];
}

/** Marks a figure computed inside WOROOD HUB rather than read from ShopifyQL.
 *
 *  Cohort retention, repeat-purchase rate and RFM segmentation have no
 *  ShopifyQL metric to read, so they are derived from the order mirror. They
 *  therefore cannot be checked against a Shopify admin report, and small
 *  differences from Shopify's own customer reports are expected. A number that
 *  cannot be reconciled must not look like one that can, so widgets carrying
 *  this flag are labelled in the interface. */
export interface LocallyComputed { computedLocally?: boolean }

export interface KpiPayload extends LocallyComputed {
  kind: 'kpi'; label: string; value: number;
  format: 'money' | 'integer' | 'percent'; currency?: string;
  comparedTo?: number | null; comparisonLabel?: string;
  provisional?: boolean; sparkline?: number[];
}
export interface SeriesPayload extends LocallyComputed {
  kind: 'line' | 'bar'; format: 'money' | 'integer' | 'percent';
  currency?: string; timezone: string; provisionalFrom?: string | null;
  series: Array<{
    key: string; label: string; format?: 'money' | 'integer' | 'percent';
    /** Draw this series dashed. Set on the comparison day so the two are
     *  distinguishable without relying on colour alone -- which matters both
     *  in print and for anyone who does not see the two hues apart. */
    dashed?: boolean;
    points: Array<{ t: string; v: number }>;
  }>;
}
export interface CategoryPayload extends LocallyComputed {
  kind: 'donut' | 'bar'; format: 'money' | 'integer' | 'percent'; currency?: string;
  items: Array<{ label: string; value: number; secondary?: number | null }>;
}
export interface TablePayload extends LocallyComputed {
  kind: 'table';
  columns: Array<{ key: string; label: string;
                   format: 'text' | 'money' | 'integer' | 'percent' | 'datetime' | 'status';
                   align?: 'start' | 'end' }>;
  rows: Array<Record<string, string | number | null>>;
  /** Set when columns were withheld because the caller lacks a permission. */
  redactedColumns?: string[];
}
export interface FunnelPayload extends LocallyComputed { kind: 'funnel'; steps: Array<{ label: string; value: number }> }

export type WidgetPayload = KpiPayload | SeriesPayload | CategoryPayload | TablePayload | FunnelPayload;

export interface WidgetEnvelope {
  widgetKey: string; title: string; titleAr?: string | null;
  generatedAt: string; dataAgeSeconds: number | null;
  payload: WidgetPayload | null; error?: string | null;
}

/** Whether Shopify is currently answering.
 *
 *  Sent with every dashboard payload. The figures below it are mirrored in
 *  PostgreSQL and remain readable during an outage -- what must not happen is
 *  their being read as current. A four-hour-old number that looks live is worse
 *  than no number, because somebody will act on it. */
export interface ShopifyConnection {
  live: boolean;
  lastOkAt: string | null;
  /** When the trouble started, stamped at the first failure rather than when it
   *  was finally reported -- so the banner's time matches the last figure that
   *  can be trusted. */
  degradedSince: string | null;
  lastError: string | null;
}

export interface DashboardDataResponse {
  dashboard: DashboardDetail;
  widgets: WidgetEnvelope[];
  shop: { name: string; currency: string; timezone: string };
  range: string;
  staleAfterMinutes: number;
  /** Absent means the question was not asked; present and false means the
   *  figures are the last received rather than the current ones. */
  connection?: ShopifyConnection;
}

/* --------------------------------------------------------------- orders -- */

export interface OrderListItem {
  id: string; name: string; createdAt: string;
  financialStatus: string | null; fulfillmentStatus: string | null;
  totalPrice: number; netPayment: number; outstanding: number;
  currency: string; test: boolean; cancelledAt: string | null; itemCount: number;
  /** Null when the caller lacks sales.customer.view -- omitted, not blanked. */
  customer: { displayName: string | null; email: string | null; city: string | null } | null;
}
export interface OrderListResponse {
  orders: OrderListItem[]; total: number; page: number; pageSize: number;
  customerDataRedacted: boolean;
  totals: { sales: number; collected: number; outstanding: number; currency: string };
}

/* ---------------------------------------------------------------- admin -- */

export interface SyncStateRow {
  resource: string; watermark: string | null;
  lastRunAt: string | null; lastOkAt: string | null;
  status: 'IDLE' | 'RUNNING' | 'OK' | 'ERROR';
  error: string | null; records: number;
  lagSeconds: number | null; healthy: boolean;
}

export interface SyncHealthResponse {
  shop: { name: string; domain: string; plan: string | null; apiVersion: string };
  resources: SyncStateRow[];
  queue: { waiting: number; active: number; failed: number; completed: number };
  webhooks: {
    subscribed: string[]; missing: string[]; lastCheckedAt: string | null;
    received24h: number; duplicates24h: number; stale24h: number;
  };
  costGovernor: {
    restoreRate: number; available: number | null; maximum: number | null;
    throttledCalls24h: number;
  };
  token: { source: string; expiresAt: string | null; refreshedAt: string | null };
}

export interface DashboardAccessResponse {
  dashboardId: string;
  roles: Array<{ id: string; key: string; name: string; granted: boolean }>;
  users: Array<{ id: string; fullName: string; email: string; effect: 'GRANT' | 'REVOKE' }>;
  directory: Array<{ id: string; fullName: string; email: string }>;
}

/* -------------------------------------------------------------- realtime -- */

export interface MetricsChangedEvent {
  type: 'metrics:changed';
  /** Widget keys whose data is now stale, or ['*'] for invalidate-all. The
   *  client invalidates then refetches through the ordinary authenticated API:
   *  no data travels over the socket, so no path bypasses the permission layer. */
  widgetKeys: string[];
  reason: 'order' | 'refund' | 'snapshot' | 'reconciliation';
  at: string;
}
export interface DashboardRevokedEvent { type: 'dashboard:revoked'; dashboardId: string }
export type RealtimeEvent = MetricsChangedEvent | DashboardRevokedEvent;

export const PERMISSIONS = {
  DASHBOARD_VIEW: 'sales.dashboard.view',
  DASHBOARD_MANAGE: 'sales.dashboard.manage',
  DASHBOARD_ASSIGN: 'sales.dashboard.assign',
  ORDER_VIEW: 'sales.order.view',
  CUSTOMER_VIEW: 'sales.customer.view',
  SYNC_MANAGE: 'sales.sync.manage',
  ROOM_MANAGE: 'meeting-rooms.room.manage',
  RESERVATION_MANAGE_ANY: 'meeting-rooms.reservation.manage-any',
  USER_MANAGE: 'core.user.manage',
  ROLE_MANAGE: 'core.role.manage',
  AUDIT_VIEW: 'core.audit.view',
} as const;