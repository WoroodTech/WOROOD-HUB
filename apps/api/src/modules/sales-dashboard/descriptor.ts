import { registerHubModule } from '../../core/hub-registry';

/**
 * Module 2: Sales Dashboard (Shopify).
 *
 * From this single declaration the platform produces the sidebar navigation
 * filtered per employee, the home-screen portlet grid, the permission rows the
 * seeder registers, and the GET /hub/modules response. Two lines in the
 * application root register the module; nothing in meeting-rooms or the portal
 * shell is edited.
 */
export const SALES_DASHBOARD_MODULE = registerHubModule({
  key: 'sales-dashboard',
  name: 'Sales Dashboard',
  nameAr: 'لوحة المبيعات',
  version: '1.0.0',
  apiPrefix: '/api/v1/sales',
  tablePrefix: 'sd_',
  enabled: true,

  // requiresAnyPermission is ANY, not ALL, so these four entries are
  // independent: an operations engineer holding only sales.sync.manage sees
  // Data & Sync and nothing else. That is intended, not an oversight.
  navigation: [
    { label: 'Sales', labelAr: 'المبيعات', path: '/sales', icon: 'trending-up',
      requiresAnyPermission: ['sales.dashboard.view'] },
    { label: 'Orders', labelAr: 'الطلبات', path: '/sales/orders', icon: 'receipt',
      requiresAnyPermission: ['sales.order.view'] },
    { label: 'Manage Dashboards', labelAr: 'إدارة اللوحات', path: '/sales/admin', icon: 'layout-grid',
      requiresAnyPermission: ['sales.dashboard.manage'] },
    { label: 'Data & Sync', labelAr: 'البيانات والمزامنة', path: '/sales/admin/sync', icon: 'refresh',
      requiresAnyPermission: ['sales.sync.manage'] },
  ],

  // All three are gated, so an employee with no sales access sees a home screen
  // exactly as it was before this module existed. my-dashboards and my-alerts
  // are personal by construction; store-pulse is the one piece of business
  // content on the personal screen, and it is there deliberately.
  portlets: [
    { key: 'my-dashboards', title: 'My Sales Dashboards', titleAr: 'لوحاتي', width: 4, order: 20,
      requiresAnyPermission: ['sales.dashboard.view'] },
    { key: 'store-pulse', title: 'Store Pulse', titleAr: 'نبض المتجر', width: 8, order: 25,
      requiresAnyPermission: ['sales.dashboard.view'] },
    { key: 'my-alerts', title: 'My Sales Alerts', titleAr: 'تنبيهاتي', width: 4, order: 60,
      requiresAnyPermission: ['sales.dashboard.view'] },
  ],

  permissions: [
    { key: 'sales.dashboard.view',   description: 'Open sales dashboards assigned to me' },
    { key: 'sales.dashboard.manage', description: 'Create, edit and delete dashboards; see all of them' },
    { key: 'sales.dashboard.assign', description: 'Assign dashboards to roles and to individuals' },
    { key: 'sales.order.view',       description: 'Browse individual orders (no customer identity)' },
    { key: 'sales.customer.view',    description: 'See customer name, e-mail, phone and address' },
    { key: 'sales.sync.manage',      description: 'Trigger backfills, inspect sync health, re-register webhooks' },
  ],
});
