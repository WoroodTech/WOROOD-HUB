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

export interface NextMeetingPortlet {
  meeting: { reference: string; title: string; room: string; floor: string | null;
             startsAt: string; endsAt: string; attendees: number } | null;
}
export interface FreeNowPortlet {
  rooms: Array<{ name: string; floor: string | null; capacity: number; freeForMinutes: number | null }>;
}
export interface UpcomingReservationsPortlet {
  reservations: Array<{ reference: string; title: string; room: string;
                        startsAt: string; endsAt: string }>;
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

export interface KpiPayload {
  kind: 'kpi'; label: string; value: number;
  format: 'money' | 'integer' | 'percent'; currency?: string;
  comparedTo?: number | null; comparisonLabel?: string;
  provisional?: boolean; sparkline?: number[];
}
export interface SeriesPayload {
  kind: 'line' | 'bar'; format: 'money' | 'integer' | 'percent';
  currency?: string; timezone: string; provisionalFrom?: string | null;
  series: Array<{ key: string; label: string; format?: 'money' | 'integer' | 'percent';
                  points: Array<{ t: string; v: number }> }>;
}
export interface CategoryPayload {
  kind: 'donut' | 'bar'; format: 'money' | 'integer' | 'percent'; currency?: string;
  items: Array<{ label: string; value: number; secondary?: number | null }>;
}
export interface TablePayload {
  kind: 'table';
  columns: Array<{ key: string; label: string;
                   format: 'text' | 'money' | 'integer' | 'percent' | 'datetime' | 'status';
                   align?: 'start' | 'end' }>;
  rows: Array<Record<string, string | number | null>>;
  /** Set when columns were withheld because the caller lacks a permission. */
  redactedColumns?: string[];
}
export interface FunnelPayload { kind: 'funnel'; steps: Array<{ label: string; value: number }> }

export type WidgetPayload = KpiPayload | SeriesPayload | CategoryPayload | TablePayload | FunnelPayload;

export interface WidgetEnvelope {
  widgetKey: string; title: string; titleAr?: string | null;
  generatedAt: string; dataAgeSeconds: number | null;
  payload: WidgetPayload | null; error?: string | null;
}

export interface DashboardDataResponse {
  dashboard: DashboardDetail;
  widgets: WidgetEnvelope[];
  shop: { name: string; currency: string; timezone: string };
  range: string;
  staleAfterMinutes: number;
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
} as const;
