-- 0049_finance_request_dashboard.sql
-- A Requests dashboard, built from the same widgets machinery as the Shopify
-- ones so it is arranged and shared the same way.
--
-- A migration rather than a seed addition: seed.ts cannot be run on a live
-- database — it clears every role's permissions before re-inserting them, so
-- running it would revert every grant made by hand since launch.

/* ------------------------------------------------------------ widgets -- */

INSERT INTO sd_widgets
  (key, name, name_ar, description, data_source, kind,
   required_permission, default_width)
VALUES
  ('req-kpi-raised', 'Requests raised', 'الطلبات المقدّمة',
   'How many requests were raised in the range, and what they asked for.',
   'finance.requests', 'kpi', 'finance.report.view', 3),

  -- Counted as things stand, not within the range: "how many are open" is a
  -- question about today, and answering it for last month gives a number
  -- nobody can act on. The widget says so on its face.
  ('req-kpi-open', 'Still open', 'مفتوحة',
   'Requests waiting on somebody right now, split by which desk.',
   'finance.requests', 'kpi', 'finance.report.view', 3),

  ('req-kpi-approved-value', 'Approved value', 'قيمة المعتمد',
   'What Finance approved in the range.',
   'finance.requests', 'kpi', 'finance.report.view', 3),

  -- From payments, not approvals. An approval is a decision; a payment is
  -- the money leaving, and the two differ.
  ('req-kpi-paid', 'Paid out', 'المدفوع',
   'Money that actually went out in the range.',
   'finance.requests', 'kpi', 'finance.report.view', 3),

  ('req-by-department', 'Requests by department', 'الطلبات بالقسم',
   'How many each department raised.',
   'finance.requests', 'bar', 'finance.report.view', 6),

  ('req-spend-by-department', 'Spend by department', 'الإنفاق بالقسم',
   'What each department actually spent — paid, not asked for.',
   'finance.requests', 'bar', 'finance.report.view', 6),

  ('req-over-time', 'Raised and paid', 'المقدّم والمدفوع',
   'Both over time. The gap between them is a queue building up.',
   'finance.requests', 'line', 'finance.report.view', 12),

  ('req-by-state', 'Waiting on', 'في انتظار',
   'Where open requests are sitting.',
   'finance.requests', 'donut', 'finance.report.view', 6),

  ('req-by-type', 'By kind', 'بالنوع',
   'What the requests were for.',
   'finance.requests', 'bar', 'finance.report.view', 6),

  -- The Finance manager's coverage of Purchasing, which the module could not
  -- answer before: what they are holding, for how long, and what it is worth.
  ('req-purchasing-queue', 'With purchasing', 'عند المشتريات',
   'What Purchasing is holding now, with how long each has waited.',
   'finance.requests', 'table', 'finance.report.view', 12),

  ('req-purchasing-decided', 'Purchasing decisions', 'قرارات المشتريات',
   'Approved against rejected, and the money that followed.',
   'finance.requests', 'table', 'finance.report.view', 6),

  ('req-slowest', 'Waiting longest', 'الأطول انتظارًا',
   'The open requests that have waited longest — a list to act on.',
   'finance.requests', 'table', 'finance.report.view', 6)

ON CONFLICT (key) DO UPDATE
  SET name = EXCLUDED.name, name_ar = EXCLUDED.name_ar,
      description = EXCLUDED.description, data_source = EXCLUDED.data_source,
      kind = EXCLUDED.kind, required_permission = EXCLUDED.required_permission,
      default_width = EXCLUDED.default_width;

/* ---------------------------------------------------------- dashboard -- */

-- `is_system` so it appears for everyone with the permission rather than
-- being one person's. No creator, for the same reason: the column pointing at
-- a seeded account is part of why that account could not be deleted.
INSERT INTO sd_dashboards (key, name, name_ar, description, is_system, created_by)
VALUES ('finance-requests', 'Finance requests', 'طلبات المالية',
        'Where requests are, what they cost, and what Purchasing is handling.',
        true, NULL)
ON CONFLICT (key) DO UPDATE
  SET name = EXCLUDED.name, name_ar = EXCLUDED.name_ar,
      description = EXCLUDED.description, is_system = EXCLUDED.is_system;

-- The default arrangement: the four numbers across the top, then the shapes,
-- then the lists. Somebody can rearrange their own copy; this is the start.
INSERT INTO sd_dashboard_widgets (dashboard_id, widget_id, position, width)
SELECT d.id, w.id, x.position, x.width
  FROM sd_dashboards d
  CROSS JOIN (VALUES
    ('req-kpi-raised',          1,  3),
    ('req-kpi-open',            2,  3),
    ('req-kpi-approved-value',  3,  3),
    ('req-kpi-paid',            4,  3),
    ('req-over-time',           5, 12),
    ('req-spend-by-department', 6,  6),
    ('req-by-state',            7,  6),
    ('req-by-department',       8,  6),
    ('req-by-type',             9,  6),
    ('req-purchasing-queue',   10, 12),
    ('req-purchasing-decided', 11,  6),
    ('req-slowest',            12,  6)
  ) AS x(key, position, width)
  JOIN sd_widgets w ON w.key = x.key
 WHERE d.key = 'finance-requests'
ON CONFLICT DO NOTHING;

/* ------------------------------------------------------------- access -- */

-- Whoever can read finance reports can open it. Access is by role here, as it
-- is for the Shopify dashboards.
INSERT INTO sd_role_dashboard_access (role_id, dashboard_id)
SELECT r.id, d.id
  FROM sd_dashboards d
  CROSS JOIN core_roles r
 WHERE d.key = 'finance-requests'
   AND EXISTS (
     SELECT 1 FROM core_role_permissions rp
       JOIN core_permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = r.id
        AND p.key IN ('finance.report.view', 'finance.request.manage')
   )
ON CONFLICT DO NOTHING;