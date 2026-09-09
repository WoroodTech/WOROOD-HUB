/**
 * widget catalogue; five dashboards; and the access assignments that make every
 * branch of the resolution rule visible.
 *
 * Idempotent throughout -- safe to run repeatedly. `--reset` truncates first.
 *
 * Shopify order and metric data is NOT seeded — it is pulled from the live
 * store by the sync service. What is seeded is the shop row itself, plus the
 * dashboards, widgets and access rules, which Shopify does not own.
 *
 * The shop row still reads its display fields from the captured fixture when
 * one is present, because domain, timezone and currency are cheap to have
 * right before the first sync runs. Historically all Shopify data came from
 * fixtures captured read-only from the real Worood
 * store, so the aggregates on every dashboard are genuine figures.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as bcrypt from 'bcryptjs';
import { DateTime } from 'luxon';
import { pool, query, one } from '../common/db';
import { config } from '../common/config';

const FIX = config.shopify.fixtureDir;
const readFix = (n: string) => {
  const p = join(FIX, n);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};
const TZ = 'Africa/Cairo';
const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '0'));
  return Number.isFinite(n) ? n : 0;
};

/* ---------------------------------------------------------------- people -- */

const DEPARTMENTS = ['Executive', 'Sales', 'Marketing', 'Finance', 'Operations',
  'Customer Care', 'Facilities', 'Technology'];

const PERMISSIONS: [string, string, string][] = [
  ['sales.dashboard.view', 'sales-dashboard', 'Open sales dashboards assigned to me'],
  ['sales.dashboard.manage', 'sales-dashboard', 'Create, edit and delete dashboards; see all of them'],
  ['sales.dashboard.assign', 'sales-dashboard', 'Assign dashboards to roles and to individuals'],
  ['sales.order.view', 'sales-dashboard', 'Browse individual orders (no customer identity)'],
  ['sales.customer.view', 'sales-dashboard', 'See customer name, e-mail, phone and address'],
  ['sales.sync.manage', 'sales-dashboard', 'Trigger backfills, inspect sync health, re-register webhooks'],
  ['meeting-rooms.room.manage', 'meeting-rooms', 'Create, edit and retire rooms'],
  ['meeting-rooms.reservation.manage-any', 'meeting-rooms', 'Modify or cancel any reservation'],
  ['core.user.manage', 'core', 'Create employee accounts, change their details and password, assign roles and dashboards'],
  ['core.role.manage', 'core', 'Create roles and decide which permissions each one carries'],
  ['core.audit.view', 'core', 'Read the audit trail'],
];

/**
 * Roles follow the actual shape of the company rather than a ladder.
 *
 * The keys are independent, not hierarchical: nothing is implied by anything
 * else, and each role below reaches something the others do not. That is the
 * point of the demonstration -- Operations reaches Data & Sync and room
 * administration but not the dashboard composer, Customer Care sees customer
 * identity on an order but holds no dashboard through its role at all, and only
 * the administrator can open the administration console.
 */
const ROLES: Record<string, { name: string; nameAr: string; perms: string[] }> = {
  'employee': { name: 'Employee', nameAr: 'موظف', perms: [] },

  'executive': {
    name: 'Executive', nameAr: 'الإدارة التنفيذية',
    perms: ['sales.dashboard.view', 'sales.order.view', 'sales.customer.view']
  },

  'finance': {
    name: 'Finance', nameAr: 'المالية',
    perms: ['sales.dashboard.view', 'sales.order.view', 'sales.customer.view']
  },

  'marketing': {
    name: 'Marketing', nameAr: 'التسويق',
    // No order access at all: campaign performance is not a reason
    // to read a customer's address.
    perms: ['sales.dashboard.view']
  },

  'operations': {
    name: 'Operations', nameAr: 'العمليات',
    // Order *flow* without customer identity: fulfilment does not
    // require a name and address, so the API withholds them and
    // says it is doing so rather than blanking the field.
    perms: ['sales.dashboard.view', 'sales.order.view', 'sales.sync.manage',
      'meeting-rooms.room.manage', 'meeting-rooms.reservation.manage-any']
  },

  'customer-care': {
    name: 'Customer Care', nameAr: 'خدمة العملاء',
    /* Orders and customer identity, because answering the phone means knowing
       who is on it. Plus dashboard access, added once Customer Insights and
       Checkout Recovery existed and gave the role something worth opening.
    
       This used to hold no dashboard permission at all, deliberately: it was
       the account that made the permission gate visibly true. Worood granted it
       from the console, and this line is what stops the next `npm run seed`
       taking it away again -- the seeder deletes and rewrites every role's
       permissions on each run, so a console grant that is not also here is
       temporary without anyone being told.
    
       The demonstration the old comment described has not been lost. Marketing
       still holds dashboard.view without order.view, and the gate is just as
       visible from that side. */
    perms: ['sales.order.view', 'sales.customer.view', 'sales.dashboard.view']
  },

  'admin': {
    name: 'System Administrator', nameAr: 'مدير النظام',
    perms: PERMISSIONS.map((p) => p[0])
  },
};

const USERS: [string, string, string, string, string, string][] = [
  // email, name, name_ar, job title, department, role
  ['Admin@worood.co', 'Khalid Hesham', 'خالد هشام', 'IT & Systems Administrator', 'Technology', 'admin'],
  ['Kandil@worood.co', 'Mohamed Kandil', 'محمد قنديل', 'Chief Executive Officer', 'Executive', 'executive'],
  ['heba.fayed@worood.co', 'Heba Fayed', 'هبة فايد', 'Operations Manager', 'Operations', 'operations'],
  ['omnia.osama@worood.co', 'Omnia Osama', 'أمنية أسامة', 'Customer Care', 'Customer Care', 'customer-care'],
  ['nadia@worood.co', 'Nadia', 'نادية', 'Marketing Director', 'Marketing', 'marketing'],
  ['Yousry@worood.co', 'Mohamed Yousry', 'محمد يسري', 'Financial Manager', 'Finance', 'finance'],
];

/* --------------------------------------------------------------- widgets -- */

const WIDGETS: Array<{
  key: string; name: string; nameAr: string; kind: string; dataSource: string;
  width: number; description: string; permission?: string;
}> = [
    {
      key: 'kpi-total-sales', name: 'Total sales', nameAr: 'إجمالي المبيعات', kind: 'kpi', dataSource: 'sales.snapshot', width: 3,
      description: 'Net sales plus shipping, taxes and duties, exactly as Shopify defines it.'
    },
    {
      key: 'kpi-orders', name: 'Orders', nameAr: 'الطلبات', kind: 'kpi', dataSource: 'sales.snapshot', width: 3,
      description: 'Order count, each order counted once regardless of item count.'
    },
    {
      key: 'kpi-aov', name: 'Average order value', nameAr: 'متوسط قيمة الطلب', kind: 'kpi', dataSource: 'sales.snapshot', width: 3,
      description: 'Gross sales less discounts, divided by orders — Shopify’s own formula.'
    },
    {
      key: 'kpi-gross-sales', name: 'Gross sales', nameAr: 'المبيعات الإجمالية', kind: 'kpi', dataSource: 'sales.snapshot', width: 3,
      description: 'Top-line revenue before discounts and returns.'
    },
    {
      key: 'kpi-discounts', name: 'Discounts', nameAr: 'الخصومات', kind: 'kpi', dataSource: 'sales.snapshot', width: 3,
      description: 'Amount taken off sales revenue through discounts.'
    },
    {
      key: 'kpi-returns', name: 'Returns and reversals', nameAr: 'المرتجعات', kind: 'kpi', dataSource: 'sales.snapshot', width: 3,
      description: 'Value removed through refunds, returns, cancellations and edits. Derived, because this store’s ShopifyQL schema does not expose the column.'
    },
    {
      key: 'kpi-net-sales', name: 'Net sales', nameAr: 'صافي المبيعات', kind: 'kpi', dataSource: 'sales.snapshot', width: 3,
      description: 'Gross sales less discounts and reversals, before shipping and tax.'
    },
    {
      key: 'kpi-sessions', name: 'Sessions', nameAr: 'الجلسات', kind: 'kpi', dataSource: 'sessions.snapshot', width: 3,
      description: 'Online store sessions, bot traffic excluded.'
    },
    {
      key: 'kpi-conversion', name: 'Conversion rate', nameAr: 'معدل التحويل', kind: 'kpi', dataSource: 'sessions.snapshot', width: 3,
      description: 'Share of sessions that completed checkout.'
    },
    {
      key: 'kpi-collected', name: 'Collected', nameAr: 'المحصّل', kind: 'kpi', dataSource: 'orders.mirror', width: 3,
      description: 'Money actually received. On a cash-on-delivery store this sits well below sales.'
    },
    {
      key: 'kpi-outstanding', name: 'Outstanding with couriers', nameAr: 'مستحق لدى المندوبين', kind: 'kpi', dataSource: 'orders.mirror', width: 3,
      description: 'Ordered but not yet collected — the cash-on-delivery float.'
    },
    {
      key: 'chart-sales-trend', name: 'Sales trend', nameAr: 'اتجاه المبيعات', kind: 'line', dataSource: 'sales.snapshot', width: 8,
      description: 'Total and net sales over the selected range.'
    },
    {
      key: 'chart-orders-trend', name: 'Orders per day', nameAr: 'الطلبات يومياً', kind: 'bar', dataSource: 'sales.snapshot', width: 4,
      description: 'Order volume per bucket.'
    },
    {
      key: 'chart-sessions-trend', name: 'Sessions and conversion', nameAr: 'الجلسات والتحويل', kind: 'line', dataSource: 'sessions.snapshot', width: 8,
      description: 'Traffic against conversion rate on one timeline.'
    },
    {
      key: 'donut-traffic-sources', name: 'Traffic sources', nameAr: 'مصادر الزيارات', kind: 'donut', dataSource: 'traffic.snapshot', width: 4,
      description: 'Where sessions came from over the last 30 days.'
    },
    {
      key: 'donut-devices', name: 'Sessions by device', nameAr: 'الجلسات حسب الجهاز', kind: 'donut', dataSource: 'sessions.snapshot', width: 4,
      description: 'Desktop, mobile and tablet split.'
    },
    {
      key: 'table-top-products', name: 'Top products', nameAr: 'أفضل المنتجات', kind: 'table', dataSource: 'sales.snapshot', width: 6,
      description: 'Best sellers by total sales over 90 days.'
    },
    {
      key: 'table-top-countries', name: 'Sessions by country', nameAr: 'الجلسات حسب الدولة', kind: 'table', dataSource: 'sessions.snapshot', width: 6,
      description: 'Where visitors are, and how well each converts.'
    },
    {
      key: 'table-recent-orders', name: 'Recent orders', nameAr: 'أحدث الطلبات', kind: 'table', dataSource: 'orders.mirror', width: 12,
      description: 'The latest orders from the mirror. Customer columns require sales.customer.view.',
      permission: 'sales.order.view'
    },
    {
      key: 'funnel-conversion', name: 'Conversion funnel', nameAr: 'مسار التحويل', kind: 'funnel', dataSource: 'sessions.snapshot', width: 4,
      description: 'Sessions through cart, checkout and purchase.'
    },

    /* --------------------------------------------------- customer analytics --
     *
     * Computed from the order mirror rather than read from ShopifyQL, because
     * Shopify does not expose cohort retention, repeat-purchase rate or RFM
     * through shopifyqlQuery -- its own customer reports calculate them
     * internally. Every one of these carries `computedLocally` on the wire and
     * is labelled in the interface, because a figure that cannot be checked
     * against the Shopify admin must not look like one that can.
     *
     * Only `table-top-customers` names anyone. The rest are counts and ratios,
     * so they need `sales.dashboard.view` and nothing more.
     */
    {
      key: 'kpi-new-vs-returning', name: 'Returning customer orders', nameAr: 'طلبات العملاء العائدين',
      kind: 'kpi', dataSource: 'customers.mirror', width: 3,
      description: 'Share of orders placed by someone who had bought before — measured against each order’s own date, not today’s.'
    },
    {
      key: 'kpi-repeat-rate', name: 'Repeat purchase rate', nameAr: 'معدل تكرار الشراء',
      kind: 'kpi', dataSource: 'customers.mirror', width: 3,
      description: 'Of the customers who bought in this range, the share who have ever bought more than once.'
    },
    {
      key: 'kpi-returning-revenue', name: 'Revenue from returning customers', nameAr: 'إيرادات العملاء العائدين',
      kind: 'kpi', dataSource: 'customers.mirror', width: 3,
      description: 'What repeat business is actually worth, separated from first-time orders.'
    },
    {
      key: 'kpi-time-to-second-order', name: 'Median days to second order', nameAr: 'وسيط الأيام حتى الطلب الثاني',
      kind: 'kpi', dataSource: 'customers.mirror', width: 3,
      description: 'How long a customer typically takes to come back. The median, not the mean — a handful of two-year gaps would drag an average anywhere.'
    },
    {
      key: 'donut-new-vs-returning', name: 'First-time vs returning', nameAr: 'جديد مقابل عائد',
      kind: 'donut', dataSource: 'customers.mirror', width: 4,
      description: 'Order split between first-time and returning buyers.'
    },
    {
      key: 'donut-customer-segments', name: 'Customer segments', nameAr: 'شرائح العملاء',
      kind: 'donut', dataSource: 'customers.mirror', width: 4,
      description: 'Champions, Growing, New, Cooling, At risk and Lapsed — by recency and order count.'
    },
    {
      key: 'bar-order-frequency', name: 'Orders per customer', nameAr: 'الطلبات لكل عميل',
      kind: 'donut', dataSource: 'customers.mirror', width: 4,
      description: 'How many customers buy once, twice, or many times over.'
    },
    {
      key: 'chart-acquisition', name: 'Acquisition and retention', nameAr: 'الاكتساب والاحتفاظ',
      kind: 'line', dataSource: 'customers.mirror', width: 8,
      description: 'New customers against orders from customers acquired earlier, on one timeline.'
    },
    {
      key: 'table-cohort-retention', name: 'Cohort retention', nameAr: 'الاحتفاظ حسب الفوج',
      kind: 'table', dataSource: 'customers.mirror', width: 8,
      description: 'Customers grouped by the month they first bought, and how many came back. A cohort too young for a column shows a dash rather than zero.'
    },
    {
      key: 'table-top-customers', name: 'Top customers', nameAr: 'أفضل العملاء',
      kind: 'table', dataSource: 'customers.mirror', width: 6,
      description: 'Highest lifetime spend. Names and cities require sales.customer.view; without it the ranking still shows, the identities do not.',
      permission: 'sales.dashboard.view'
    },

    /* ------------------------------------------------- abandoned checkouts --
     *
     * The only dataset in the module customer care can act on rather than read:
     * a checkout is "abandoned" in Shopify's sense only once contact details
     * were entered, so every row is somebody reachable, and Shopify supplies a
     * recovery URL with each one.
     */
    {
      key: 'kpi-abandoned', name: 'Abandoned checkouts', nameAr: 'عربات متروكة',
      kind: 'kpi', dataSource: 'abandoned.mirror', width: 3,
      description: 'Checkouts started with contact details entered and never completed.'
    },
    {
      key: 'kpi-abandoned-value', name: 'Value left in checkouts', nameAr: 'قيمة العربات المتروكة',
      kind: 'kpi', dataSource: 'abandoned.mirror', width: 3,
      description: 'What is still sitting uncollected — abandoned value less anything since recovered.'
    },
    {
      key: 'kpi-recovery-rate', name: 'Checkout recovery rate', nameAr: 'معدل استرداد العربات',
      kind: 'kpi', dataSource: 'abandoned.mirror', width: 3,
      description: 'Share of abandoned checkouts that were later completed. Includes people who came back on their own — Shopify does not say who was contacted.'
    },
    {
      key: 'kpi-recovered-value', name: 'Recovered revenue', nameAr: 'إيرادات مستردة',
      kind: 'kpi', dataSource: 'abandoned.mirror', width: 3,
      description: 'Value of checkouts that were abandoned and then completed.'
    },
    {
      key: 'chart-abandonment', name: 'Abandoned and recovered', nameAr: 'المتروك والمسترد',
      kind: 'line', dataSource: 'abandoned.mirror', width: 8,
      description: 'Both lines together: how many are lost, and how many come back.'
    },
    {
      key: 'donut-abandoned-age', name: 'How long they have been sitting', nameAr: 'عمر العربات المتروكة',
      kind: 'donut', dataSource: 'abandoned.mirror', width: 4,
      description: 'Age of the still-open checkouts. A checkout abandoned an hour ago is a different conversation from one abandoned last week.'
    },
    {
      key: 'table-open-checkouts', name: 'Open checkouts to follow up', nameAr: 'عربات تحتاج متابعة',
      kind: 'table', dataSource: 'abandoned.mirror', width: 12,
      description: 'The working list, newest first. Contact details require sales.customer.view; without it the value and age still show.',
      permission: 'sales.dashboard.view'
    },

    /* ------------------------------------------------------- store credit --
     *
     * Shopify keeps a ledger, not just a balance: every credit and debit with
     * its own timestamp, event and running total. That is what makes a usage
     * report possible rather than a balance readout.
     *
     * Exported nightly by bulk operation, because store credit transactions
     * hang off the customer and there is no way to ask Shopify for "customers
     * with store credit" -- so the choice is exporting everyone once cheaply or
     * asking about 37,000 customers expensively.
     */
    {
      key: 'kpi-credit-issued', name: 'Store credit issued', nameAr: 'رصيد ممنوح',
      kind: 'kpi', dataSource: 'credit.mirror', width: 3,
      description: 'Credit added to customer accounts in this period — refunds taken as credit, goodwill, adjustments.'
    },
    {
      key: 'kpi-credit-spent', name: 'Store credit spent', nameAr: 'رصيد مستخدم',
      kind: 'kpi', dataSource: 'credit.mirror', width: 3,
      description: 'Credit actually used against orders.'
    },
    {
      key: 'kpi-credit-outstanding', name: 'Credit outstanding', nameAr: 'رصيد قائم',
      kind: 'kpi', dataSource: 'credit.mirror', width: 3,
      description: 'Total balance still sitting on customer accounts — a liability, and a reason for them to come back.'
    },
    {
      key: 'kpi-credit-redemption', name: 'Credit redemption rate', nameAr: 'معدل استخدام الرصيد',
      kind: 'kpi', dataSource: 'credit.mirror', width: 3,
      description: 'Spent against issued in the same window. Credit issued in one month and spent the next counts as spend in the second, so this is a ratio rather than a cohort figure.'
    },
    {
      key: 'chart-credit', name: 'Credit issued and spent', nameAr: 'الرصيد الممنوح والمستخدم',
      kind: 'line', dataSource: 'credit.mirror', width: 8,
      description: 'Both lines together: how much goes out, and how much comes back as orders.'
    },
    {
      key: 'donut-credit-events', name: 'Why credit was issued', nameAr: 'أسباب منح الرصيد',
      kind: 'donut', dataSource: 'credit.mirror', width: 4,
      description: 'Shopify’s own classification of each transaction.'
    },
    {
      key: 'table-credit-holders', name: 'Who holds credit', nameAr: 'أصحاب الأرصدة',
      kind: 'table', dataSource: 'credit.mirror', width: 12,
      description: 'Largest balances first. Names require sales.customer.view.',
      permission: 'sales.dashboard.view'
    },
  ];

const DASHBOARDS: Array<{
  key: string; name: string; nameAr: string; description: string;
  system: boolean; widgets: [string, number][]
}> = [
    {
      key: 'executive-daily', name: 'Executive Daily', nameAr: 'اللوحة التنفيذية اليومية', system: true,
      description: 'The headline view: what sold, how much, and where it came from.',
      widgets: [['kpi-total-sales', 3], ['kpi-orders', 3], ['kpi-aov', 3], ['kpi-conversion', 3],
      ['chart-sales-trend', 8], ['donut-traffic-sources', 4], ['table-top-products', 12]]
    },
    {
      key: 'sales-operations', name: 'Sales Operations', nameAr: 'عمليات المبيعات', system: true,
      description: 'Order flow and cash collection for a cash-on-delivery business.',
      widgets: [['kpi-orders', 4], ['kpi-collected', 4], ['kpi-outstanding', 4],
      ['chart-orders-trend', 12], ['table-recent-orders', 12]]
    },
    {
      key: 'marketing-traffic', name: 'Marketing and Traffic', nameAr: 'التسويق والزيارات', system: true,
      description: 'Where visitors come from and how far they get.',
      widgets: [['kpi-sessions', 6], ['kpi-conversion', 6], ['chart-sessions-trend', 8],
      ['funnel-conversion', 4], ['donut-traffic-sources', 4], ['donut-devices', 4],
      ['table-top-countries', 4]]
    },
    {
      key: 'finance-reconciliation', name: 'Finance Reconciliation', nameAr: 'تسوية الحسابات', system: true,
      description: 'The sales build-up in Shopify’s own vocabulary, for reconciling against the admin.',
      widgets: [['kpi-gross-sales', 3], ['kpi-discounts', 3], ['kpi-returns', 3], ['kpi-net-sales', 3],
      ['kpi-total-sales', 3],
      ['chart-sales-trend', 12], ['table-recent-orders', 12]]
    },
    // Required no special-casing. A "combined" dashboard is just another row
    // reusing widgets from two areas -- which is the whole point of the model.
    {
      key: 'customer-insights', name: 'Customer Insights', nameAr: 'تحليلات العملاء', system: true,
      description: 'Who buys, who comes back, and how long they take — computed from order history rather than read from Shopify.',
      widgets: [['kpi-new-vs-returning', 3], ['kpi-repeat-rate', 3],
      ['kpi-returning-revenue', 3], ['kpi-time-to-second-order', 3],
      ['chart-acquisition', 8], ['donut-new-vs-returning', 4],
      ['donut-customer-segments', 4], ['bar-order-frequency', 4],
      ['table-cohort-retention', 8], ['table-top-customers', 12]]
    },
    {
      key: 'checkout-recovery', name: 'Checkout Recovery', nameAr: 'استرداد العربات المتروكة', system: true,
      description: 'Checkouts started and not finished, and what came back. A working list rather than a report.',
      widgets: [['kpi-abandoned', 3], ['kpi-abandoned-value', 3],
      ['kpi-recovery-rate', 3], ['kpi-recovered-value', 3],
      ['chart-abandonment', 8], ['donut-abandoned-age', 4],
      ['table-open-checkouts', 12]]
    },
    {
      key: 'store-credit', name: 'Store Credit', nameAr: 'رصيد المتجر', system: true,
      description: 'Credit issued, credit spent, and what is still owed to customers.',
      widgets: [['kpi-credit-issued', 3], ['kpi-credit-spent', 3],
      ['kpi-credit-outstanding', 3], ['kpi-credit-redemption', 3],
      ['chart-credit', 8], ['donut-credit-events', 4],
      ['table-credit-holders', 12]]
    },
    {
      key: 'combined-sales-marketing', name: 'Combined Sales and Marketing', nameAr: 'المبيعات والتسويق معاً', system: false,
      description: 'A hybrid view built by picking existing widgets from two areas — no new code.',
      widgets: [['kpi-total-sales', 4], ['kpi-sessions', 4], ['kpi-conversion', 4],
      ['chart-sales-trend', 8], ['chart-sessions-trend', 4],
      ['donut-traffic-sources', 4], ['table-top-products', 8]]
    },
  ];

/* ------------------------------------------------------------------ main -- */

async function main() {
  const reset = process.argv.includes('--reset');
  if (reset) {
    await query(`TRUNCATE sd_dashboard_widgets, sd_role_dashboard_access,
                          sd_user_dashboard_access, sd_dashboards, sd_widgets,
                          sd_order_line_items, sd_refunds, sd_orders, sd_customers,
                          sd_metric_snapshots, sd_sync_state, sd_webhook_events,
                          sd_products, sd_shops,
                          mr_reservation_attendees, mr_reservations,
                          mr_room_blackouts, mr_room_equipment, mr_rooms,
                          mr_equipment, mr_locations,
                          core_notifications, core_audit_logs, core_refresh_tokens,
                          core_user_roles, core_role_permissions, core_users,
                          core_roles, core_permissions, core_departments CASCADE`);
    console.log('  reset: all seeded tables truncated');
  }

  /* departments, permissions, roles */
  const deptIds: Record<string, string> = {};
  for (const name of DEPARTMENTS) {
    const r = await one(
      `INSERT INTO core_departments (name) VALUES ($1)
       ON CONFLICT DO NOTHING RETURNING id`, [name])
      ?? await one(`SELECT id FROM core_departments WHERE name = $1`, [name]);
    deptIds[name] = r.id;
  }

  for (const [key, moduleKey, description] of PERMISSIONS) {
    await query(
      `INSERT INTO core_permissions (key, module_key, description) VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET module_key = EXCLUDED.module_key,
                                       description = EXCLUDED.description`,
      [key, moduleKey, description]);
  }

  const roleIds: Record<string, string> = {};
  for (const [key, def] of Object.entries(ROLES)) {
    const r = await one(
      `INSERT INTO core_roles (key, name, name_ar) VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, name_ar = EXCLUDED.name_ar
       RETURNING id`, [key, def.name, def.nameAr]);
    roleIds[key] = r.id;
    await query(`DELETE FROM core_role_permissions WHERE role_id = $1`, [r.id]);
    for (const perm of def.perms) {
      await query(
        `INSERT INTO core_role_permissions (role_id, permission_id)
         SELECT $1, id FROM core_permissions WHERE key = $2
         ON CONFLICT DO NOTHING`, [r.id, perm]);
    }
  }

  // bcrypt at cost 12 is deliberately slow. Every demo account shares one
  // password, so the digest is computed once and reused -- hashing it seven
  // times would add seconds to every seed run for no benefit.
  const digest = await bcrypt.hash('Worood@2026', config.security.bcryptRounds);
  const userIds: Record<string, string> = {};
  for (const [email, name, nameAr, title, dept, role] of USERS) {
    const u = await one(
      `INSERT INTO core_users (email, password_hash, full_name, full_name_ar, job_title, department_id, timezone)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name,
         full_name_ar = EXCLUDED.full_name_ar, job_title = EXCLUDED.job_title,
         department_id = EXCLUDED.department_id
       RETURNING id`,
      [email, digest, name, nameAr, title, deptIds[dept], TZ]);
    userIds[email] = u.id;
    await query(`DELETE FROM core_user_roles WHERE user_id = $1`, [u.id]);
    await query(`INSERT INTO core_user_roles (user_id, role_id) VALUES ($1,$2)
                 ON CONFLICT DO NOTHING`, [u.id, roleIds[role]]);
  }

  /* meeting rooms */
  const loc = await one(
    `INSERT INTO mr_locations (code, name, name_ar, building, iana_timezone, address)
     VALUES ('HQ','Worood HQ','مقر ورود','Tower A',$1,'Sheikh Zayed, Giza')
     ON CONFLICT (code) DO UPDATE SET building = EXCLUDED.building RETURNING id`, [TZ])
    ?? await one(`SELECT id FROM mr_locations LIMIT 1`);

  /* Rooms carry their own booking policy, so the seed exercises the range
     rather than accepting the defaults everywhere: the Training Hall takes
     hour-long bookings with a changeover buffer, the Studio needs approval,
     and Jasmine is a quick huddle room on a fifteen-minute grid. A demo where
     every room behaves identically hides the whole point of the policy. */
  interface SeedRoom {
    code: string; name: string; nameAr: string; capacity: number; floor: string;
    equipment: string[]; opensAt?: string; closesAt?: string;
    buffer?: number; approval?: boolean; status?: string;
    description?: string;
  }
  /* `--reset` truncates mr_equipment, which migration 0004 populated. The
     catalogue is reference data, not demo data, so the seed restores it rather
     than leaving the fittings filter with nothing to offer. */
  const EQUIPMENT: [string, string, string, string][] = [
    ['display', 'Wall Display', 'شاشة عرض', 'monitor'],
    ['internet', 'High-Speed Internet', 'إنترنت سريع', 'wifi'],
    ['whiteboard', 'Whiteboard', 'سبورة', 'edit'],
    ['video-conference', 'Video Conferencing', 'مؤتمرات فيديو', 'users'],
    ['projector', 'Projector', 'جهاز عرض', 'video'],
    ['speakerphone', 'Speakerphone', 'هاتف مؤتمرات', 'phone'],
  ];
  for (const [key, name, nameAr, icon] of EQUIPMENT) {
    await query(
      `INSERT INTO mr_equipment (key, name, name_ar, icon) VALUES ($1,$2,$3,$4)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, name_ar = EXCLUDED.name_ar,
                                       icon = EXCLUDED.icon`, [key, name, nameAr, icon]);
  }

  const ROOMS: SeedRoom[] = [
    {
      code: 'MEETING-ROOM',
      name: 'Meeting Room',
      nameAr: 'غرفة الاجتماعات',
      capacity: 12,
      floor: '2',
      equipment: [
        'display',
        'internet',
        'whiteboard',
        'video-conference',
        'projector',
        'speakerphone',
      ],
      description:
        'Main meeting room with a 12-seat table, display, video conferencing and presentation equipment.',
    },

    {
      code: 'OMNIA-OFFICE',
      name: 'Omnia Office',
      nameAr: 'مكتب أمنية',
      capacity: 4,
      floor: '2',
      equipment: [
        'display',
        'internet',
        'whiteboard',
      ],
      description:
        'Private office suitable for small meetings and one-to-one discussions.',
    },

    {
      code: 'HEBA-OFFICE',
      name: 'Heba Office',
      nameAr: 'مكتب هبة',
      capacity: 4,
      floor: '2',
      equipment: [
        'display',
        'internet',
        'whiteboard',
      ],
      description:
        'Private office suitable for small meetings and operational discussions.',
    },

    {
      code: 'YOUSRY-OFFICE',
      name: 'Yousry Office',
      nameAr: 'مكتب يسري',
      capacity: 4,
      floor: '2',
      equipment: [
        'display',
        'internet',
        'whiteboard',
      ],
      description:
        'Private office suitable for finance meetings and small team discussions.',
    },

    {
      code: 'NADIA-OFFICE',
      name: 'Nadia Office',
      nameAr: 'مكتب نادية',
      capacity: 4,
      floor: '2',
      equipment: [
        'display',
        'internet',
        'whiteboard',
      ],
      description:
        'Private office suitable for marketing meetings and one-to-one discussions.',
    },

    {
      code: 'NOURA-OFFICE',
      name: 'Noura Office',
      nameAr: 'مكتب نورا',
      capacity: 4,
      floor: '2',
      equipment: [
        'display',
        'internet',
        'whiteboard',
      ],
      description:
        'Private office suitable for small meetings and focused discussions.',
    },

    {
      code: 'ALI-OFFICE',
      name: 'Ali Office',
      nameAr: 'مكتب علي',
      capacity: 4,
      floor: '2',
      equipment: [
        'display',
        'internet',
        'whiteboard',
      ],
      description:
        'Private office suitable for small meetings and one-to-one discussions.',
    },
  ];

  for (const r of ROOMS) {
    const row = await one(
      `INSERT INTO mr_rooms (code, location_id, name, name_ar, capacity, floor, description,
         status, opens_at, closes_at, buffer_minutes, requires_approval)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'ACTIVE'),COALESCE($9::time,'08:00'),
               COALESCE($10::time,'18:00'),COALESCE($11,0),COALESCE($12,false))
       ON CONFLICT (code) DO UPDATE SET
         name = EXCLUDED.name, name_ar = EXCLUDED.name_ar, capacity = EXCLUDED.capacity,
         floor = EXCLUDED.floor, description = EXCLUDED.description,
         opens_at = EXCLUDED.opens_at, closes_at = EXCLUDED.closes_at,
         buffer_minutes = EXCLUDED.buffer_minutes, requires_approval = EXCLUDED.requires_approval
       RETURNING id`,
      [r.code, loc.id, r.name, r.nameAr, r.capacity, r.floor, r.description ?? null,
      r.status ?? null, r.opensAt ?? null, r.closesAt ?? null,
      r.buffer ?? null, r.approval ?? null]);

    // Equipment is a join now, not an array on the row: replace the set rather
    // than accumulating duplicates across re-runs.
    await query(`DELETE FROM mr_room_equipment WHERE room_id = $1`, [row.id]);
    await query(
      `INSERT INTO mr_room_equipment (room_id, equipment_id)
       SELECT $1, id FROM mr_equipment WHERE key = ANY($2)
       ON CONFLICT DO NOTHING`, [row.id, r.equipment]);
  }

 
 

  /* shop */
  const shopFix = readFix('shop.json') ?? {};
  const shop = await one(
    `INSERT INTO sd_shops (myshopify_domain, name, primary_domain, iana_timezone,
        currency_code, money_format, plan_name, api_version, cost_restore_rate)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (myshopify_domain) DO UPDATE SET
       name = EXCLUDED.name, primary_domain = EXCLUDED.primary_domain,
       currency_code = EXCLUDED.currency_code, money_format = EXCLUDED.money_format,
       plan_name = EXCLUDED.plan_name, cost_restore_rate = EXCLUDED.cost_restore_rate
     RETURNING id`,
    [shopFix.myshopifyDomain ?? config.shopify.shopDomain, shopFix.name ?? 'WOROOD',
    shopFix.domain ?? null, shopFix.ianaTimezone ?? TZ, shopFix.currencyCode ?? 'EGP',
    shopFix.currencyFormats?.moneyFormat ?? 'EGP {{amount_no_decimals}}',
    shopFix.planName ?? 'Advanced', config.shopify.apiVersion,
    // Advanced plan restores 200 points per second.
    config.shopify.costRestoreRate]);

  /* widgets */
  for (const w of WIDGETS) {
    await query(
      `INSERT INTO sd_widgets (key, name, name_ar, description, data_source, kind,
          required_permission, default_width)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, name_ar = EXCLUDED.name_ar,
         description = EXCLUDED.description, data_source = EXCLUDED.data_source,
         kind = EXCLUDED.kind, required_permission = EXCLUDED.required_permission,
         default_width = EXCLUDED.default_width`,
      [w.key, w.name, w.nameAr, w.description, w.dataSource, w.kind,
      w.permission ?? null, w.width]);
  }

  /* dashboards */
  const dashIds: Record<string, string> = {};
  for (const d of DASHBOARDS) {
    const row = await one(
      `INSERT INTO sd_dashboards (key, name, name_ar, description, is_system, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, name_ar = EXCLUDED.name_ar,
         description = EXCLUDED.description, is_system = EXCLUDED.is_system
       RETURNING id`,
      [d.key, d.name, d.nameAr, d.description, d.system, userIds['Admin@worood.co']]);
    dashIds[d.key] = row.id;

    await query(`DELETE FROM sd_dashboard_widgets WHERE dashboard_id = $1`, [row.id]);
    let position = 0;
    for (const [widgetKey, width] of d.widgets) {
      await query(
        `INSERT INTO sd_dashboard_widgets (dashboard_id, widget_id, position, width)
         SELECT $1, id, $2, $3 FROM sd_widgets WHERE key = $4`,
        [row.id, position++, width, widgetKey]);
    }
  }

  /* access -- every branch of the resolution rule made visible */
  await query(`DELETE FROM sd_role_dashboard_access`);
  await query(`DELETE FROM sd_user_dashboard_access`);
  const grantRole = (role: string, dash: string) => query(
    `INSERT INTO sd_role_dashboard_access (role_id, dashboard_id) VALUES ($1,$2)
     ON CONFLICT DO NOTHING`, [roleIds[role], dashIds[dash]]);

  /* Every branch of the resolution rule, on real people:
       - a role that reaches several dashboards (Executive)
       - roles that reach exactly the one they need (Finance, Marketing, Operations)
       - a role that reaches none, plus one granted to the person (Customer Care)
       - a dashboard a role grants, taken away from one individual (Marketing) */
  await grantRole('executive', 'executive-daily');
  await grantRole('executive', 'sales-operations');
  await grantRole('executive', 'marketing-traffic');
  await grantRole('executive', 'finance-reconciliation');
  await grantRole('executive', 'combined-sales-marketing');

  await grantRole('finance', 'finance-reconciliation');
  await grantRole('finance', 'executive-daily');

  await grantRole('marketing', 'marketing-traffic');
  await grantRole('marketing', 'combined-sales-marketing');

  await grantRole('operations', 'sales-operations');

  /* Customer Insights goes to the roles that already hold sales.dashboard.view
     and would actually use it: Marketing owns acquisition and retention,
     Executive sees everything, Finance cares what repeat business is worth.
  
     Customer Care is the interesting omission, and it is left as it stands
     rather than quietly changed. That role holds sales.order.view and
     sales.customer.view but *no* dashboard permission at all -- deliberately,
     as the account that makes the permission gate visibly true. Granting a
     dashboard to a role that cannot open one would produce an access row that
     looks like access and is not.
  
     If Customer Care should see this dashboard, the fix is one tick in
     Administration -> Roles adding sales.dashboard.view. That is a data change
     that binds on the next request, and it is a decision about what Customer
     Care is for -- not something a seeder should make on Worood's behalf. */
  /* Checkout Recovery is Customer Care's list before it is anyone else's:
     1,495 open checkouts, each with a name, an email and a recovery link. It is
     the only dataset in the module that can be acted on rather than read. */
  /* Store credit is a finance question first -- outstanding credit is a
     liability on the books -- and a customer-care question second, because the
     person on the phone needs to know what the caller is holding. */
  await grantRole('finance', 'store-credit');
  await grantRole('customer-care', 'store-credit');
  await grantRole('executive', 'store-credit');

  await grantRole('customer-care', 'checkout-recovery');
  await grantRole('customer-care', 'customer-insights');

  await grantRole('marketing', 'checkout-recovery');
  await grantRole('operations', 'checkout-recovery');
  await grantRole('executive', 'checkout-recovery');

  await grantRole('marketing', 'customer-insights');
  await grantRole('executive', 'customer-insights');
  await grantRole('finance', 'customer-insights');

  /* One dashboard beyond what her role carries. Deliberately *not* given to
     Customer Care: that role holds no dashboard permission at all, so a grant
     there would be inert -- an access row that looks like access and is not. */
  await query(
    `INSERT INTO sd_user_dashboard_access (user_id, dashboard_id, effect, granted_by)
     VALUES ($1,$2,'GRANT',$3) ON CONFLICT (user_id, dashboard_id) DO UPDATE SET effect = 'GRANT'`,
    [userIds['heba.fayed@worood.co'], dashIds['executive-daily'], userIds['Admin@worood.co']]);

  // ...and the other direction: something her role grants, withheld from her.
  await query(
    `INSERT INTO sd_user_dashboard_access (user_id, dashboard_id, effect, granted_by)
     VALUES ($1,$2,'REVOKE',$3) ON CONFLICT (user_id, dashboard_id) DO UPDATE SET effect = 'REVOKE'`,
    [userIds['nadia@worood.co'], dashIds['combined-sales-marketing'], userIds['Admin@worood.co']]);

  /* notifications, so my-alerts is not empty */
  await query(`DELETE FROM core_notifications WHERE module_key = 'sales-dashboard'`);
  const notify = (email: string, sev: string, title: string, body: string, read = false) => query(
    `INSERT INTO core_notifications (user_id, module_key, severity, title, body, read_at)
     VALUES ($1,'sales-dashboard',$2,$3,$4,$5)`,
    [userIds[email], sev, title, body, read ? new Date() : null]);
  await notify('heba.fayed@worood.co', 'INFO', 'Executive Daily assigned to you',
    'Khalid Hesham gave you individual access to this dashboard.');
  await notify('Yousry@worood.co', 'WARNING', 'Collected is 62% below ordered',
    'Cash on delivery float is unusually high for the last 7 days.');
  await notify('heba.fayed@worood.co', 'CRITICAL', 'Webhook subscription missing',
    'orders/updated was not present at the last watchdog run and has been re-registered.');
  await notify('Kandil@worood.co', 'INFO', 'Executive Daily refreshed',
    'Nightly snapshot completed for the trailing 13 months.', true);

  /* ------------------------------------------------- the Shopify mirror --
   *
   * The seed no longer fills sd_orders or sd_metric_snapshots.
   *
   * It used to load both from JSON captured read-only from the live store,
   * which was the right call while the Dev Dashboard app did not exist: the
   * dashboard could be built and demonstrated against real figures with no
   * credentials. Now that the app exists, seeding them is worse than useless --
   * it puts stale numbers in front of people who have no way to tell them from
   * live ones, and it writes a sync watermark claiming those rows are current.
   *
   * The mirror is derived data. It comes from Shopify, through one door:
   *
   *   npm run seed -- --reset          structure, people, dashboards
   *   POST /sales/admin/sync/backfill   the orders themselves
   *   POST /sales/admin/sync/snapshots  the ShopifyQL figures
   *
   * What is seeded here is what Shopify does not own and cannot replace:
   * dashboards, widget layouts, and who may see them. If the mirror is lost it
   * can be rebuilt in an afternoon; those cannot be rebuilt at all.
   */
  const orderCount = Number((await one(`SELECT COUNT(*) AS n FROM sd_orders`)).n);
  const snapCount = Number((await one(`SELECT COUNT(*) AS n FROM sd_metric_snapshots`)).n);

  /* PENDING, not OK, and no watermark. A watermark is a claim that everything
     up to that instant has been pulled; writing one here would tell the first
     reconciliation that the last day is already covered, and it would skip it.
     The Data & Sync screen shows this as work outstanding, which is exactly
     what it is on a fresh install. */
  await query(
    `INSERT INTO sd_sync_state (shop_id, resource, watermark, last_run_at, last_ok_at, status, records)
     VALUES ($1,'orders',NULL,NULL,NULL,'PENDING',$2),
            ($1,'customers',NULL,NULL,NULL,'PENDING',0),
            ($1,'sales_snapshot',NULL,NULL,NULL,'PENDING',$3),
            ($1,'sessions_snapshot',NULL,NULL,NULL,'PENDING',$3),
            ($1,'webhooks',NULL,NULL,NULL,'PENDING',0)
     ON CONFLICT (shop_id, resource) DO NOTHING`,
    [shop.id, orderCount, snapCount]);

  if (orderCount === 0) {
    console.log('  mirror        empty — run POST /sales/admin/sync/backfill to fill it');
  }

  await report();
  await pool.end();
}


/* ---------------------------------------------------------------- report -- */

async function report() {
  const counts = await query(`
    SELECT 'users' AS t, COUNT(*)::int AS n FROM core_users
    UNION ALL SELECT 'roles', COUNT(*)::int FROM core_roles
    UNION ALL SELECT 'permissions', COUNT(*)::int FROM core_permissions
    UNION ALL SELECT 'rooms', COUNT(*)::int FROM mr_rooms
    UNION ALL SELECT 'reservations', COUNT(*)::int FROM mr_reservations
    UNION ALL SELECT 'orders', COUNT(*)::int FROM sd_orders
    UNION ALL SELECT 'line items', COUNT(*)::int FROM sd_order_line_items
    UNION ALL SELECT 'customers', COUNT(*)::int FROM sd_customers
    UNION ALL SELECT 'refunds', COUNT(*)::int FROM sd_refunds
    UNION ALL SELECT 'snapshots', COUNT(*)::int FROM sd_metric_snapshots
    UNION ALL SELECT 'widgets', COUNT(*)::int FROM sd_widgets
    UNION ALL SELECT 'dashboards', COUNT(*)::int FROM sd_dashboards
    UNION ALL SELECT 'notifications', COUNT(*)::int FROM core_notifications`);
  console.log('\n  seeded');
  for (const c of counts) console.log(`    ${String(c.t).padEnd(14)} ${c.n}`);

  const matrix = await query(`
    SELECT u.email, u.full_name,
           COALESCE(STRING_AGG(DISTINCT r.key, ', '), '-') AS roles,
           (SELECT COUNT(*) FROM sd_dashboards d WHERE d.deleted_at IS NULL
              AND (EXISTS (SELECT 1 FROM core_user_roles ur2
                             JOIN core_role_permissions rp2 ON rp2.role_id = ur2.role_id
                             JOIN core_permissions p2 ON p2.id = rp2.permission_id
                            WHERE ur2.user_id = u.id AND p2.key = 'sales.dashboard.manage')
                OR ((EXISTS (SELECT 1 FROM sd_role_dashboard_access rda
                               JOIN core_user_roles ur3 ON ur3.role_id = rda.role_id
                              WHERE ur3.user_id = u.id AND rda.dashboard_id = d.id)
                     OR EXISTS (SELECT 1 FROM sd_user_dashboard_access uda
                                 WHERE uda.user_id = u.id AND uda.dashboard_id = d.id AND uda.effect='GRANT'))
                    AND NOT EXISTS (SELECT 1 FROM sd_user_dashboard_access uda2
                                     WHERE uda2.user_id = u.id AND uda2.dashboard_id = d.id AND uda2.effect='REVOKE')))
           ) AS dashboards
      FROM core_users u
      LEFT JOIN core_user_roles ur ON ur.user_id = u.id
      LEFT JOIN core_roles r ON r.id = ur.role_id
     GROUP BY u.id, u.email, u.full_name ORDER BY u.full_name`);
  console.log('\n  expected access matrix (password for every account: Worood@2026)');
  console.log(`    ${'employee'.padEnd(26)} ${'role'.padEnd(15)} dashboards`);
  for (const m of matrix) {
    console.log(`    ${(m.full_name + ' <' + m.email + '>').padEnd(26).slice(0, 26)} ${String(m.roles).padEnd(15)} ${m.dashboards}`);
  }
  console.log('');
}

main().catch((e) => { console.error(e); process.exit(1); });