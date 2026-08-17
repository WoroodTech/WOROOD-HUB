/**
 * Seeds a demonstrable WOROOD HUB: departments, roles, permissions and people;
 * a meeting-room inventory with live reservations; the Shopify shop row; the
 * widget catalogue; five dashboards; and the access assignments that make every
 * branch of the resolution rule visible.
 *
 * Idempotent throughout -- safe to run repeatedly. `--reset` truncates first.
 *
 * Shopify data comes from fixtures captured read-only from the real Worood
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

const DEPARTMENTS = ['Executive', 'Sales', 'Marketing', 'Finance', 'Operations', 'Facilities', 'Technology'];

const PERMISSIONS: [string, string, string][] = [
  ['sales.dashboard.view',   'sales-dashboard', 'Open sales dashboards assigned to me'],
  ['sales.dashboard.manage', 'sales-dashboard', 'Create, edit and delete dashboards; see all of them'],
  ['sales.dashboard.assign', 'sales-dashboard', 'Assign dashboards to roles and to individuals'],
  ['sales.order.view',       'sales-dashboard', 'Browse individual orders (no customer identity)'],
  ['sales.customer.view',    'sales-dashboard', 'See customer name, e-mail, phone and address'],
  ['sales.sync.manage',      'sales-dashboard', 'Trigger backfills, inspect sync health, re-register webhooks'],
  ['meeting-rooms.room.manage', 'meeting-rooms', 'Create, edit and retire rooms'],
  ['meeting-rooms.reservation.manage-any', 'meeting-rooms', 'Modify or cancel any reservation'],
  ['core.user.manage', 'core', 'Create employee accounts, change their details and password, assign roles and dashboards'],
  ['core.role.manage', 'core', 'Create roles and decide which permissions each one carries'],
  ['core.audit.view',  'core', 'Read the audit trail'],
];

const ROLES: Record<string, { name: string; nameAr: string; perms: string[] }> = {
  'employee':      { name: 'Employee', nameAr: 'موظف', perms: [] },
  'sales-viewer':  { name: 'Sales Viewer', nameAr: 'مطّلع المبيعات', perms: ['sales.dashboard.view'] },
  'sales-manager': { name: 'Sales Manager', nameAr: 'مدير المبيعات',
                     perms: ['sales.dashboard.view', 'sales.order.view', 'sales.customer.view'] },
  'sales-admin':   { name: 'Sales Administrator', nameAr: 'مسؤول المبيعات',
                     perms: ['sales.dashboard.view', 'sales.order.view', 'sales.customer.view',
                             'sales.dashboard.manage', 'sales.dashboard.assign'] },
  // Exists to prove the permission keys are independent, not hierarchical:
  // this person reaches Data & Sync and nothing else.
  'ops-engineer':  { name: 'Operations Engineer', nameAr: 'مهندس التشغيل', perms: ['sales.sync.manage'] },
  'facilities':    { name: 'Facilities Coordinator', nameAr: 'منسق المرافق',
                     perms: ['meeting-rooms.room.manage', 'meeting-rooms.reservation.manage-any'] },
  'admin':         { name: 'System Administrator', nameAr: 'مدير النظام', perms: PERMISSIONS.map((p) => p[0]) },
};

const USERS: [string, string, string, string, string, string][] = [
  // email, name, name_ar, job title, department, role
  ['omar.khaled@worood.co',   'Omar Khaled',   'عمر خالد',   'Merchandising Assistant', 'Operations', 'employee'],
  ['facilities@worood.co',    'Rania Adel',    'رانيا عادل',  'Facilities Coordinator',  'Facilities', 'facilities'],
  ['hala.mansour@worood.co',  'Hala Mansour',  'هالة منصور',  'Retail Supervisor',       'Sales',      'sales-viewer'],
  ['yara.saleh@worood.co',    'Yara Saleh',    'يارا صالح',   'Sales Manager',           'Sales',      'sales-manager'],
  ['karim.fouad@worood.co',   'Karim Fouad',   'كريم فؤاد',   'Head of Commerce',        'Executive',  'sales-admin'],
  ['nour.hassan@worood.co',   'Nour Hassan',   'نور حسن',     'Platform Engineer',       'Technology', 'ops-engineer'],
  ['admin@worood.co',         'Sherif Wagdy',  'شريف وجدي',   'IT Manager',              'Technology', 'admin'],
];

/* --------------------------------------------------------------- widgets -- */

const WIDGETS: Array<{
  key: string; name: string; nameAr: string; kind: string; dataSource: string;
  width: number; description: string; permission?: string;
}> = [
  { key: 'kpi-total-sales', name: 'Total sales', nameAr: 'إجمالي المبيعات', kind: 'kpi', dataSource: 'sales.snapshot', width: 3,
    description: 'Net sales plus shipping, taxes and duties, exactly as Shopify defines it.' },
  { key: 'kpi-orders', name: 'Orders', nameAr: 'الطلبات', kind: 'kpi', dataSource: 'sales.snapshot', width: 3,
    description: 'Order count, each order counted once regardless of item count.' },
  { key: 'kpi-aov', name: 'Average order value', nameAr: 'متوسط قيمة الطلب', kind: 'kpi', dataSource: 'sales.snapshot', width: 3,
    description: 'Gross sales less discounts, divided by orders — Shopify’s own formula.' },
  { key: 'kpi-gross-sales', name: 'Gross sales', nameAr: 'المبيعات الإجمالية', kind: 'kpi', dataSource: 'sales.snapshot', width: 3,
    description: 'Top-line revenue before discounts and returns.' },
  { key: 'kpi-discounts', name: 'Discounts', nameAr: 'الخصومات', kind: 'kpi', dataSource: 'sales.snapshot', width: 3,
    description: 'Amount taken off sales revenue through discounts.' },
  { key: 'kpi-returns', name: 'Returns and reversals', nameAr: 'المرتجعات', kind: 'kpi', dataSource: 'sales.snapshot', width: 3,
    description: 'Value removed through refunds, returns, cancellations and edits. Derived, because this store’s ShopifyQL schema does not expose the column.' },
  { key: 'kpi-net-sales', name: 'Net sales', nameAr: 'صافي المبيعات', kind: 'kpi', dataSource: 'sales.snapshot', width: 3,
    description: 'Gross sales less discounts and reversals, before shipping and tax.' },
  { key: 'kpi-sessions', name: 'Sessions', nameAr: 'الجلسات', kind: 'kpi', dataSource: 'sessions.snapshot', width: 3,
    description: 'Online store sessions, bot traffic excluded.' },
  { key: 'kpi-conversion', name: 'Conversion rate', nameAr: 'معدل التحويل', kind: 'kpi', dataSource: 'sessions.snapshot', width: 3,
    description: 'Share of sessions that completed checkout.' },
  { key: 'kpi-collected', name: 'Collected', nameAr: 'المحصّل', kind: 'kpi', dataSource: 'orders.mirror', width: 3,
    description: 'Money actually received. On a cash-on-delivery store this sits well below sales.' },
  { key: 'kpi-outstanding', name: 'Outstanding with couriers', nameAr: 'مستحق لدى المندوبين', kind: 'kpi', dataSource: 'orders.mirror', width: 3,
    description: 'Ordered but not yet collected — the cash-on-delivery float.' },
  { key: 'chart-sales-trend', name: 'Sales trend', nameAr: 'اتجاه المبيعات', kind: 'line', dataSource: 'sales.snapshot', width: 8,
    description: 'Total and net sales over the selected range.' },
  { key: 'chart-orders-trend', name: 'Orders per day', nameAr: 'الطلبات يومياً', kind: 'bar', dataSource: 'sales.snapshot', width: 4,
    description: 'Order volume per bucket.' },
  { key: 'chart-sessions-trend', name: 'Sessions and conversion', nameAr: 'الجلسات والتحويل', kind: 'line', dataSource: 'sessions.snapshot', width: 8,
    description: 'Traffic against conversion rate on one timeline.' },
  { key: 'donut-traffic-sources', name: 'Traffic sources', nameAr: 'مصادر الزيارات', kind: 'donut', dataSource: 'traffic.snapshot', width: 4,
    description: 'Where sessions came from over the last 30 days.' },
  { key: 'donut-devices', name: 'Sessions by device', nameAr: 'الجلسات حسب الجهاز', kind: 'donut', dataSource: 'sessions.snapshot', width: 4,
    description: 'Desktop, mobile and tablet split.' },
  { key: 'table-top-products', name: 'Top products', nameAr: 'أفضل المنتجات', kind: 'table', dataSource: 'sales.snapshot', width: 6,
    description: 'Best sellers by total sales over 90 days.' },
  { key: 'table-top-countries', name: 'Sessions by country', nameAr: 'الجلسات حسب الدولة', kind: 'table', dataSource: 'sessions.snapshot', width: 6,
    description: 'Where visitors are, and how well each converts.' },
  { key: 'table-recent-orders', name: 'Recent orders', nameAr: 'أحدث الطلبات', kind: 'table', dataSource: 'orders.mirror', width: 12,
    description: 'The latest orders from the mirror. Customer columns require sales.customer.view.',
    permission: 'sales.order.view' },
  { key: 'funnel-conversion', name: 'Conversion funnel', nameAr: 'مسار التحويل', kind: 'funnel', dataSource: 'sessions.snapshot', width: 4,
    description: 'Sessions through cart, checkout and purchase.' },
];

const DASHBOARDS: Array<{ key: string; name: string; nameAr: string; description: string;
                          system: boolean; widgets: [string, number][] }> = [
  { key: 'executive-daily', name: 'Executive Daily', nameAr: 'اللوحة التنفيذية اليومية', system: true,
    description: 'The headline view: what sold, how much, and where it came from.',
    widgets: [['kpi-total-sales', 3], ['kpi-orders', 3], ['kpi-aov', 3], ['kpi-conversion', 3],
              ['chart-sales-trend', 8], ['donut-traffic-sources', 4], ['table-top-products', 12]] },
  { key: 'sales-operations', name: 'Sales Operations', nameAr: 'عمليات المبيعات', system: true,
    description: 'Order flow and cash collection for a cash-on-delivery business.',
    widgets: [['kpi-orders', 4], ['kpi-collected', 4], ['kpi-outstanding', 4],
              ['chart-orders-trend', 12], ['table-recent-orders', 12]] },
  { key: 'marketing-traffic', name: 'Marketing and Traffic', nameAr: 'التسويق والزيارات', system: true,
    description: 'Where visitors come from and how far they get.',
    widgets: [['kpi-sessions', 6], ['kpi-conversion', 6], ['chart-sessions-trend', 8],
              ['funnel-conversion', 4], ['donut-traffic-sources', 4], ['donut-devices', 4],
              ['table-top-countries', 4]] },
  { key: 'finance-reconciliation', name: 'Finance Reconciliation', nameAr: 'تسوية الحسابات', system: true,
    description: 'The sales build-up in Shopify’s own vocabulary, for reconciling against the admin.',
    widgets: [['kpi-gross-sales', 3], ['kpi-discounts', 3], ['kpi-returns', 3], ['kpi-net-sales', 3],
              ['kpi-total-sales', 3],
              ['chart-sales-trend', 12], ['table-recent-orders', 12]] },
  // Required no special-casing. A "combined" dashboard is just another row
  // reusing widgets from two areas -- which is the whole point of the model.
  { key: 'combined-sales-marketing', name: 'Combined Sales and Marketing', nameAr: 'المبيعات والتسويق معاً', system: false,
    description: 'A hybrid view built by picking existing widgets from two areas — no new code.',
    widgets: [['kpi-total-sales', 4], ['kpi-sessions', 4], ['kpi-conversion', 4],
              ['chart-sales-trend', 8], ['chart-sessions-trend', 4],
              ['donut-traffic-sources', 4], ['table-top-products', 8]] },
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
    equipment: string[]; opensAt?: string; closesAt?: string; slot?: number;
    min?: number; max?: number; buffer?: number; approval?: boolean; status?: string;
    description?: string;
  }
  /* `--reset` truncates mr_equipment, which migration 0004 populated. The
     catalogue is reference data, not demo data, so the seed restores it rather
     than leaving the fittings filter with nothing to offer. */
  const EQUIPMENT: [string, string, string, string][] = [
    ['projector', 'Projector', 'جهاز عرض', 'video'],
    ['video-conference', 'Video conference', 'اجتماع مرئي', 'users'],
    ['whiteboard', 'Whiteboard', 'سبورة', 'edit'],
    ['display', 'Wall display', 'شاشة', 'monitor'],
    ['speakerphone', 'Speakerphone', 'هاتف مؤتمرات', 'phone'],
    ['accessible', 'Step-free access', 'وصول ميسر', 'accessible'],
  ];
  for (const [key, name, nameAr, icon] of EQUIPMENT) {
    await query(
      `INSERT INTO mr_equipment (key, name, name_ar, icon) VALUES ($1,$2,$3,$4)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, name_ar = EXCLUDED.name_ar,
                                       icon = EXCLUDED.icon`, [key, name, nameAr, icon]);
  }

  const ROOMS: SeedRoom[] = [
    { code: 'NILE', name: 'Nile Boardroom', nameAr: 'قاعة النيل', capacity: 14, floor: '3',
      equipment: ['projector', 'video-conference', 'whiteboard'], buffer: 10,
      description: 'The board table. Video conference unit is fixed, not portable.' },
    { code: 'PAPYRUS', name: 'Papyrus', nameAr: 'بردي', capacity: 8, floor: '3',
      equipment: ['display', 'whiteboard'] },
    { code: 'LOTUS', name: 'Lotus', nameAr: 'لوتس', capacity: 6, floor: '2',
      equipment: ['display'] },
    { code: 'JASMINE', name: 'Jasmine', nameAr: 'ياسمين', capacity: 4, floor: '2',
      equipment: ['whiteboard'], slot: 15, min: 15, max: 120,
      description: 'Huddle room. Fifteen-minute bookings, two hours maximum.' },
    { code: 'TRAINING', name: 'Training Hall', nameAr: 'قاعة التدريب', capacity: 30, floor: '1',
      equipment: ['projector', 'speakerphone', 'accessible'], slot: 60, min: 60, max: 480, buffer: 30,
      opensAt: '08:00', closesAt: '17:00',
      description: 'Hour-long blocks only. Half an hour of changeover is reserved either side.' },
    { code: 'STUDIO', name: 'Studio', nameAr: 'الاستوديو', capacity: 5, floor: '1',
      equipment: ['display', 'speakerphone'], approval: true,
      description: 'Photography studio. Bookings are held until Facilities approve them.' },
  ];

  const roomIds: string[] = [];
  for (const r of ROOMS) {
    const row = await one(
      `INSERT INTO mr_rooms (code, location_id, name, name_ar, capacity, floor, description,
         status, opens_at, closes_at, slot_minutes, min_duration_minutes,
         max_duration_minutes, buffer_minutes, requires_approval)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'ACTIVE'),COALESCE($9::time,'08:00'),
               COALESCE($10::time,'18:00'),COALESCE($11,30),COALESCE($12,30),
               COALESCE($13,480),COALESCE($14,0),COALESCE($15,false))
       ON CONFLICT (code) DO UPDATE SET
         name = EXCLUDED.name, name_ar = EXCLUDED.name_ar, capacity = EXCLUDED.capacity,
         floor = EXCLUDED.floor, description = EXCLUDED.description,
         opens_at = EXCLUDED.opens_at, closes_at = EXCLUDED.closes_at,
         slot_minutes = EXCLUDED.slot_minutes, min_duration_minutes = EXCLUDED.min_duration_minutes,
         max_duration_minutes = EXCLUDED.max_duration_minutes,
         buffer_minutes = EXCLUDED.buffer_minutes, requires_approval = EXCLUDED.requires_approval
       RETURNING id`,
      [r.code, loc.id, r.name, r.nameAr, r.capacity, r.floor, r.description ?? null,
       r.status ?? null, r.opensAt ?? null, r.closesAt ?? null, r.slot ?? null,
       r.min ?? null, r.max ?? null, r.buffer ?? null, r.approval ?? null]);
    roomIds.push(row.id);

    // Equipment is a join now, not an array on the row: replace the set rather
    // than accumulating duplicates across re-runs.
    await query(`DELETE FROM mr_room_equipment WHERE room_id = $1`, [row.id]);
    await query(
      `INSERT INTO mr_room_equipment (room_id, equipment_id)
       SELECT $1, id FROM mr_equipment WHERE key = ANY($2)
       ON CONFLICT DO NOTHING`, [row.id, r.equipment]);
  }

  // One blackout, so availability has something to refuse that is not a
  // booking -- the two are different states and the UI says so differently.
  await query(`DELETE FROM mr_room_blackouts`);
  {
    // 09:00-13:00 Cairo, two days out. Computed here rather than with
    // date_trunc(now()) because the server's clock may be UTC, and a blackout
    // that lands four hours off the maintenance window is worse than none.
    const day = DateTime.now().setZone(TZ).plus({ days: 2 }).startOf('day');
    await query(
      `INSERT INTO mr_room_blackouts (room_id, starts_at, ends_at, reason)
       VALUES ($1,$2,$3,'Projector replacement')`,
      [roomIds[4], day.set({ hour: 9 }).toJSDate(), day.set({ hour: 13 }).toJSDate()]);
  }

  // Reservations relative to now, so the home dashboard always has a "next
  // meeting" and some rooms genuinely free right now.
  await query(`DELETE FROM mr_reservations`);
  const now = DateTime.now().setZone(TZ);
  const meetings: Array<[string, string, number, number, number, number]> = [
    // organiser email index into USERS, title, dayOffset, startHour, durationMins, roomIndex
    ['omar.khaled@worood.co',  'Autumn range review',        0, now.hour + 2, 60, 1] as any,
    ['omar.khaled@worood.co',  'Supplier catch-up',          1, 11, 45, 2] as any,
    ['yara.saleh@worood.co',   'Weekly sales stand-up',      0, now.hour + 1, 30, 0] as any,
    ['yara.saleh@worood.co',   'Courier performance review', 2, 13, 60, 0] as any,
    ['karim.fouad@worood.co',  'Board pre-read',             1, 9,  90, 0] as any,
    ['hala.mansour@worood.co', 'Store visit debrief',        0, now.hour + 3, 45, 3] as any,
    ['nour.hassan@worood.co',  'Shopify app cut-over plan',  3, 10, 60, 2] as any,
    ['facilities@worood.co',   'Quarterly safety briefing',  4, 14, 120, 4] as any,
  ];
  let reservations = 0;
  for (let i = 0; i < meetings.length; i++) {
    const [email, title, dayOffset, hour, mins, roomIx] = meetings[i];
    const start = now.plus({ days: dayOffset }).set({ hour: Math.min(hour, 17), minute: 0, second: 0, millisecond: 0 });
    const end = start.plus({ minutes: mins });
    try {
      await query(
        `INSERT INTO mr_reservations (reference, room_id, organizer_id, title, starts_at, ends_at, attendees)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [`MR-${String(1001 + i)}`, roomIds[roomIx], userIds[email], title,
         start.toJSDate(), end.toJSDate(), 2 + (i % 6)]);
      reservations++;
    } catch (e: any) {
      // 23P01 is the exclusion constraint doing its job. Skip and move on --
      // the guarantee is the database's, not the seeder's.
      if (e.code !== '23P01') throw e;
    }
  }

  /* Guests on the seeded meetings, so the invitations portlet and the reply
     buttons have something real to show on a fresh install -- and so at least
     one person logs in to find a meeting they did not book. */
  await query(`DELETE FROM mr_reservation_attendees`);
  const GUESTS: Array<[string, string[], string]> = [
    // organiser email, guest emails, their response
    ['yara.saleh@worood.co',   ['omar.khaled@worood.co', 'hala.mansour@worood.co'], 'INVITED'],
    ['karim.fouad@worood.co',  ['yara.saleh@worood.co', 'nour.hassan@worood.co'],   'ACCEPTED'],
    ['facilities@worood.co',   ['omar.khaled@worood.co'],                            'DECLINED'],
    ['omar.khaled@worood.co',  ['facilities@worood.co'],                             'INVITED'],
  ];
  let invitations = 0;
  for (const [organiser, guests, response] of GUESTS) {
    const meeting = await one(
      `SELECT id FROM mr_reservations
        WHERE organizer_id = $1 AND status = 'CONFIRMED' AND starts_at > now()
        ORDER BY starts_at ASC LIMIT 1`, [userIds[organiser]]);
    if (!meeting) continue;
    for (const guest of guests) {
      if (!userIds[guest]) continue;
      await query(
        `INSERT INTO mr_reservation_attendees (reservation_id, user_id, response, responded_at)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [meeting.id, userIds[guest], response,
         response === 'INVITED' ? null : new Date()]);
      invitations++;
    }
    // The headcount should agree with the guest list plus the organiser.
    await query(
      `UPDATE mr_reservations SET attendees = GREATEST(attendees, $2) WHERE id = $1`,
      [meeting.id, guests.length + 1]);
  }
  console.log(`    invitations   ${invitations}`);

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
      [d.key, d.name, d.nameAr, d.description, d.system, userIds['admin@worood.co']]);
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

  await grantRole('sales-viewer', 'executive-daily');
  await grantRole('sales-viewer', 'marketing-traffic');
  await grantRole('sales-manager', 'executive-daily');
  await grantRole('sales-manager', 'sales-operations');
  await grantRole('sales-manager', 'marketing-traffic');

  // An individual addition beyond her role...
  await query(
    `INSERT INTO sd_user_dashboard_access (user_id, dashboard_id, effect, granted_by)
     VALUES ($1,$2,'GRANT',$3) ON CONFLICT (user_id, dashboard_id) DO UPDATE SET effect = 'GRANT'`,
    [userIds['yara.saleh@worood.co'], dashIds['finance-reconciliation'], userIds['admin@worood.co']]);
  // ...and an individual removal from something her role grants.
  await query(
    `INSERT INTO sd_user_dashboard_access (user_id, dashboard_id, effect, granted_by)
     VALUES ($1,$2,'REVOKE',$3) ON CONFLICT (user_id, dashboard_id) DO UPDATE SET effect = 'REVOKE'`,
    [userIds['hala.mansour@worood.co'], dashIds['marketing-traffic'], userIds['admin@worood.co']]);

  /* notifications, so my-alerts is not empty */
  await query(`DELETE FROM core_notifications WHERE module_key = 'sales-dashboard'`);
  const notify = (email: string, sev: string, title: string, body: string, read = false) => query(
    `INSERT INTO core_notifications (user_id, module_key, severity, title, body, read_at)
     VALUES ($1,'sales-dashboard',$2,$3,$4,$5)`,
    [userIds[email], sev, title, body, read ? new Date() : null]);
  await notify('yara.saleh@worood.co', 'INFO', 'Finance Reconciliation assigned to you',
    'Karim Fouad gave you individual access to this dashboard.');
  await notify('yara.saleh@worood.co', 'WARNING', 'Collected is 62% below ordered',
    'Cash on delivery float is unusually high for the last 7 days.');
  await notify('nour.hassan@worood.co', 'CRITICAL', 'Webhook subscription missing',
    'orders/updated was not present at the last watchdog run and has been re-registered.');
  await notify('hala.mansour@worood.co', 'INFO', 'Executive Daily refreshed',
    'Nightly snapshot completed for the trailing 13 months.', true);

  /* Shopify mirror and snapshots from the captured fixtures */
  const existingOrders = Number((await one(`SELECT COUNT(*) AS n FROM sd_orders`)).n);
  let orderCount = existingOrders;
  if (existingOrders === 0) orderCount = await loadOrders(shop.id);

  const existingSnaps = Number((await one(`SELECT COUNT(*) AS n FROM sd_metric_snapshots`)).n);
  let snapCount = existingSnaps;
  if (existingSnaps === 0) snapCount = await loadSnapshots(shop.id);

  await query(
    `INSERT INTO sd_sync_state (shop_id, resource, watermark, last_run_at, last_ok_at, status, records)
     VALUES ($1,'orders',now(),now(),now(),'OK',$2), ($1,'customers',now(),now(),now(),'OK',0),
            ($1,'sales_snapshot',now(),now(),now(),'OK',$3), ($1,'sessions_snapshot',now(),now(),now(),'OK',$3),
            ($1,'webhooks',now(),now(),now(),'OK',8)
     ON CONFLICT (shop_id, resource) DO UPDATE
       SET watermark = now(), last_run_at = now(), last_ok_at = now(), status = 'OK',
           records = EXCLUDED.records`,
    [shop.id, orderCount, snapCount]);

  await report();
  await pool.end();
}

/* --------------------------------------------------------- fixture loads -- */

async function loadOrders(shopId: string): Promise<number> {
  const fix = readFix('orders_recent.json');
  if (!fix?.orders?.length) { console.log('  no order fixture found — mirror left empty'); return 0; }
  const money = (bag: any) => num(bag?.shopMoney?.amount);
  let n = 0;

  for (const o of fix.orders) {
    let customerId: string | null = null;
    if (o.customer?.id) {
      const c = await one(
        `INSERT INTO sd_customers (shop_id, shopify_gid, orders_count, display_name, email, phone,
            address_city, address_province, address_country, address_zip,
            shopify_created_at, shopify_updated_at, last_order_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),$12)
         ON CONFLICT (shopify_gid) DO UPDATE SET
           orders_count = EXCLUDED.orders_count, display_name = EXCLUDED.display_name,
           email = EXCLUDED.email,
           last_order_at = GREATEST(sd_customers.last_order_at, EXCLUDED.last_order_at)
         RETURNING id`,
        [shopId, o.customer.id, o.customer.numberOfOrders ?? 0, o.customer.displayName ?? null,
         o.customer.email ?? null, o.customer.phone ?? null,
         o.shippingAddress?.city ?? null, o.shippingAddress?.province ?? null,
         o.shippingAddress?.country ?? null, o.shippingAddress?.zip ?? null,
         o.customer.createdAt ?? null, new Date(o.createdAt)]);
      customerId = c.id;
    }

    const row = await one(
      `INSERT INTO sd_orders (shop_id, shopify_gid, name, order_number, customer_id,
          shopify_created_at, processed_at, cancelled_at, cancel_reason, shopify_updated_at,
          test, financial_status, fulfillment_status, source_name, tags,
          currency_code, presentment_currency_code,
          total_price, current_total_price, subtotal_price, current_subtotal_price,
          total_discounts, total_tax, total_shipping, total_refunded, net_payment,
          total_outstanding, presentment_total_price, ship_city, ship_province, ship_country)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
               $22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
       ON CONFLICT (shopify_gid) DO NOTHING RETURNING id`,
      [shopId, o.id, o.name, parseInt(String(o.name).replace(/\D/g, ''), 10) || null, customerId,
       new Date(o.createdAt), o.processedAt ?? null, o.cancelledAt ?? null, o.cancelReason ?? null,
       new Date(o.updatedAt ?? o.createdAt), !!o.test,
       o.displayFinancialStatus ?? null, o.displayFulfillmentStatus ?? null,
       o.sourceName ?? null, o.tags ?? [],
       o.currencyCode ?? 'EGP', o.presentmentCurrencyCode ?? null,
       money(o.totalPriceSet), money(o.currentTotalPriceSet), money(o.subtotalPriceSet),
       money(o.currentSubtotalPriceSet), money(o.totalDiscountsSet), money(o.totalTaxSet),
       money(o.totalShippingPriceSet), money(o.totalRefundedSet), money(o.netPaymentSet),
       money(o.totalOutstandingSet), num(o.totalPriceSet?.presentmentMoney?.amount),
       o.shippingAddress?.city ?? null, o.shippingAddress?.province ?? null,
       o.shippingAddress?.country ?? null]);
    if (!row) continue;

    for (const li of o.lineItems?.nodes ?? []) {
      await query(
        `INSERT INTO sd_order_line_items (order_id, shopify_gid, product_gid, variant_gid,
            title, variant_title, sku, quantity, current_quantity, original_total, discounted_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (shopify_gid) DO NOTHING`,
        [row.id, li.id, li.product?.id ?? null, li.variant?.id ?? null, li.title,
         li.variant?.title ?? null, li.sku ?? null, li.quantity ?? 0,
         li.currentQuantity ?? li.quantity ?? 0, money(li.originalTotalSet), money(li.discountedTotalSet)]);
    }
    for (const rf of o.refunds ?? []) {
      await query(
        `INSERT INTO sd_refunds (order_id, shopify_gid, total_refunded, shopify_created_at)
         VALUES ($1,$2,$3,$4) ON CONFLICT (shopify_gid) DO NOTHING`,
        [row.id, rf.id, money(rf.totalRefundedSet), rf.createdAt]);
    }
    n++;
  }
  return n;
}

async function loadSnapshots(shopId: string): Promise<number> {
  let n = 0;
  const upsert = async (schema: string, grain: string, bucket: Date,
                        dims: Record<string, string>, metrics: Record<string, number>,
                        isFinal: boolean) => {
    await query(
      `INSERT INTO sd_metric_snapshots (shop_id, schema_name, grain, bucket_start,
          bucket_timezone, dimensions, metrics, is_final)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)
       ON CONFLICT ON CONSTRAINT sd_metric_snapshots_unique
       DO UPDATE SET metrics = EXCLUDED.metrics, is_final = EXCLUDED.is_final, captured_at = now()`,
      [shopId, schema, grain, bucket, TZ, JSON.stringify(dims), JSON.stringify(metrics), isFinal]);
    n++;
  };

  const records = (f: any) => {
    if (!f?.columns || !f?.rows) return [];
    const names = f.columns.map((c: any) => c.name);
    return f.rows.map((row: any) =>
      Object.fromEntries(names.map((nm: string, i: number) =>
        [nm, Array.isArray(row) ? row[i] : row[nm]])));
  };

  const nowTz = DateTime.now().setZone(TZ);

  // Time series. Day buckets are shop-local dates; hour buckets are UTC
  // instants. Both are normalised to an absolute instant here, so no widget can
  // mix a Cairo day with a UTC hour -- a three-hour offset that can look like a
  // factor of two on a partial current day.
  for (const [file, schema, grain] of [
    ['sales_daily.json', 'sales', 'day'], ['sales_hourly.json', 'sales', 'hour'],
    ['sessions_daily.json', 'sessions', 'day'], ['sessions_hourly.json', 'sessions', 'hour'],
  ] as const) {
    for (const rec of records(readFix(file))) {
      const raw = rec[grain] ?? Object.values(rec)[0];
      if (!raw) continue;
      const dt = grain === 'day'
        ? DateTime.fromISO(String(raw).slice(0, 10), { zone: TZ }).startOf('day')
        : DateTime.fromISO(String(raw), { zone: 'utc' });
      if (!dt.isValid) continue;
      const metrics: Record<string, number> = {};
      for (const [k, v] of Object.entries(rec)) if (k !== grain) metrics[k] = num(v);
      const isFinal = grain === 'day' ? dt < nowTz.startOf('day') : dt < DateTime.utc().startOf('hour');
      await upsert(schema, grain, dt.toJSDate(), {}, metrics, isFinal);
    }
  }

  // Dimensional breakdowns share one bucket_start so a batch can be read back
  // whole; identifying them by captured_at would collapse them to one slice.
  const bucket = DateTime.utc().startOf('hour').toJSDate();
  for (const [file, schema, dim] of [
    ['top_products_90d.json', 'sales', 'product_title'],
    ['traffic_sources_30d.json', 'traffic', 'referrer_source'],
    ['sessions_by_device_30d.json', 'sessions', 'session_device_type'],
    ['sessions_by_country_30d.json', 'sessions', 'session_country'],
  ] as const) {
    const f = readFix(file);
    const payload = f?.columns ? f : (f?.sessions_by_referrer ?? f?.by_device ?? f?.by_country ?? f);
    for (const rec of records(payload)) {
      const label = rec[dim] ?? Object.values(rec)[0];
      if (label === undefined || label === null) continue;
      const metrics: Record<string, number> = {};
      for (const [k, v] of Object.entries(rec)) if (k !== dim) metrics[k] = num(v);
      await upsert(schema, 'total', bucket, { [dim]: String(label) }, metrics, true);
    }
  }
  return n;
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
