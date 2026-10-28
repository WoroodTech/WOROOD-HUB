-- 0029_finance_core.sql
-- Finance Requests, phase 1: departments, requests, and the approval chain.
--
-- This replaces a Google Sheet in which each department had its own tab, the
-- status lived in a column, and "who approved it" was a sentence. The tabs
-- become rows, the sentence becomes columns, and the rules that were spread
-- across forty-odd script functions become constraints the database enforces.
--
-- Money is deliberately absent from this migration. Payments arrive in phase 3
-- with their own ledger; this one carries requests as far as "approved and
-- waiting to be paid", which is the whole of the approval problem and none of
-- the financial one.

/* ------------------------------------------------- departments as DATA ---- */
-- The legacy LOGS constant lives in code, so adding a request type means
-- editing and redeploying a script. Here it is a table: Finance adds a type by
-- changing a row. That also means a discrepancy between the archived source and
-- whatever is actually live costs an UPDATE rather than a rebuild.
--
-- `lite` is a flag, not a hierarchy, exactly as the legacy app has it. Office,
-- Workshop and Warehouse are ordinary departments whose requests are handled by
-- Purchases; they are not children of anything. core_departments.parent_id
-- exists and stays NULL, so a tree can be introduced later without touching
-- this schema.

CREATE TABLE fin_departments (
  department_id uuid PRIMARY KEY REFERENCES core_departments(id) ON DELETE RESTRICT,

  -- The legacy page id and three-letter code, kept so references stay
  -- recognisable to people who used the old app and so migrated rows can be
  -- matched back to their source.
  page_key      text NOT NULL UNIQUE,
  code          text NOT NULL UNIQUE,

  -- finance   — straight to the Finance manager
  -- choice    — the requester picks: Finance, or Purchases first
  -- purchases — always goes through Purchases
  route         text NOT NULL,

  -- A lite department never sees money: not an amount, not a vendor, not
  -- transfer details, in any channel. Its requests are costed by Purchases
  -- after approval. Enforced in the projection layer, flagged here.
  lite          boolean NOT NULL DEFAULT false,

  -- What this department may ask for. Empty for lite departments, which
  -- describe what they need in words and let Purchases classify it.
  request_types text[] NOT NULL DEFAULT '{}',

  -- The example text in the description box, per department.
  placeholder   text,
  placeholder_ar text,

  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fin_departments_route_check
    CHECK (route IN ('finance', 'choice', 'purchases')),
  -- A lite department that offers types would be asking its members to classify
  -- spending they are not allowed to see the cost of.
  CONSTRAINT fin_departments_lite_has_no_types
    CHECK (NOT lite OR cardinality(request_types) = 0)
);

CREATE TRIGGER fin_departments_touch BEFORE UPDATE ON fin_departments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

/* ------------------------------------------------------------ requests ---- */

CREATE TABLE fin_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Human-facing identifier, in the legacy shape (PUR-a1b2c3d). Staff quote
  -- these to each other and they appear on Zoho records later.
  reference     text NOT NULL UNIQUE,

  -- Who asked. This never changes, even after Purchases takes the request over,
  -- because every privacy rule is a question about the requesting department.
  department_id uuid NOT NULL REFERENCES core_departments(id),
  requester_id  uuid NOT NULL REFERENCES core_users(id),

  -- The requester's department at the moment of asking, so a later transfer
  -- between departments cannot retrospectively change who may see the request.
  -- The tasks module snapshots the same way.
  requester_department_id uuid REFERENCES core_departments(id),

  -- Which cash-flow bucket this is charged to. The same as department_id for an
  -- ordinary department. For a lite department it becomes Purchases once
  -- Purchases has classified it -- which is what the legacy app expressed by
  -- physically moving the row into the Purchases Log and remembering the origin
  -- in a "Source" column. Two columns say it without moving anything.
  charged_to_department_id uuid REFERENCES core_departments(id),

  type          text,
  description   text NOT NULL,
  more_details  text,
  due_date      date NOT NULL,
  requested_amount numeric(14,2) NOT NULL,

  payment_method  text,
  payment_details text,

  -- finance | purchases — resolved at creation from the department's route and,
  -- for a `choice` department, from what the requester picked.
  route         text NOT NULL,

  /* --- the two states ---
     Approval and payment are different facts about a request and are kept
     apart. The legacy app put them in one column and then needed a second
     column for the approval stage anyway, which is how a request could read
     "Open" while sitting rejected in a pending tab.
     The label people see (Open / In Progress / Partial Pay / Complete) is
     computed from the pair. */
  approval_state text NOT NULL DEFAULT 'DRAFT',
  payment_state  text NOT NULL DEFAULT 'UNPAID',

  -- Who moved it along, and when. One column per step rather than a sentence,
  -- so "waiting for whom" is a query rather than a parse.
  manager_decided_by_id   uuid REFERENCES core_users(id),
  manager_decided_at      timestamptz,
  purchases_decided_by_id uuid REFERENCES core_users(id),
  purchases_decided_at    timestamptz,
  finance_decided_by_id   uuid REFERENCES core_users(id),
  finance_decided_at      timestamptz,

  rejected_by_id uuid REFERENCES core_users(id),
  rejected_at    timestamptz,
  rejection_reason text,

  vendor_name   text,
  vendor_zoho_id text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  deleted_by_id uuid REFERENCES core_users(id),

  CONSTRAINT fin_requests_approval_state_check CHECK (approval_state IN (
    'DRAFT',              -- being written; not submitted
    'MANAGER_PENDING',    -- with the requester's department manager
    'PURCHASES_PENDING',  -- with Purchases
    'FINANCE_PENDING',    -- with the Finance manager
    'APPROVED',           -- the chain is complete; this is "In Progress"
    'REJECTED'
  )),
  CONSTRAINT fin_requests_payment_state_check
    CHECK (payment_state IN ('UNPAID', 'PARTIAL', 'PAID')),
  CONSTRAINT fin_requests_route_check CHECK (route IN ('finance', 'purchases')),

  -- An amount of zero or less is not a request for money.
  CONSTRAINT fin_requests_amount_positive CHECK (requested_amount > 0),

  -- A rejection must say who and when; an approval must have been decided by
  -- Finance. Both are the kind of half-written row that a script can produce
  -- and nobody notices until a report is wrong.
  CONSTRAINT fin_requests_rejection_is_complete
    CHECK (approval_state <> 'REJECTED'
           OR (rejected_by_id IS NOT NULL AND rejected_at IS NOT NULL)),
  CONSTRAINT fin_requests_approval_is_complete
    CHECK (approval_state <> 'APPROVED'
           OR (finance_decided_by_id IS NOT NULL AND finance_decided_at IS NOT NULL))
);

CREATE TRIGGER fin_requests_touch BEFORE UPDATE ON fin_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- "What is waiting for me." Partial, because decided requests are the majority
-- after a few months and none of them belongs in an approvals queue.
CREATE INDEX fin_requests_pending_idx
  ON fin_requests (approval_state, department_id, created_at)
  WHERE approval_state IN ('MANAGER_PENDING', 'PURCHASES_PENDING', 'FINANCE_PENDING')
    AND deleted_at IS NULL;

-- "My requests", and a department's list.
CREATE INDEX fin_requests_requester_idx
  ON fin_requests (requester_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX fin_requests_department_idx
  ON fin_requests (department_id, created_at DESC) WHERE deleted_at IS NULL;

-- The cash-flow report groups by the bucket and the due date.
CREATE INDEX fin_requests_charged_idx
  ON fin_requests (charged_to_department_id, due_date)
  WHERE deleted_at IS NULL AND approval_state = 'APPROVED';

/* ----------------------------------------------------------- approvals ---- */
-- Every decision, kept forever and never updated.
--
-- The legacy app wrote the latest decision into a column, so the previous one
-- was gone: a request rejected by a manager, re-submitted and approved looked
-- exactly like one approved first time. An append-only trail answers "what
-- happened to this request" without anybody having to remember.

CREATE TABLE fin_request_approvals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid NOT NULL REFERENCES fin_requests(id) ON DELETE CASCADE,

  step        text NOT NULL,   -- MANAGER | PURCHASES | FINANCE
  decision    text NOT NULL,   -- APPROVED | REJECTED
  decided_by_id uuid NOT NULL REFERENCES core_users(id),
  reason      text,

  -- What the amount was when this decision was taken, so an approval cannot be
  -- quietly re-used for a different number later.
  amount_at_decision numeric(14,2),

  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fin_request_approvals_step_check
    CHECK (step IN ('MANAGER', 'PURCHASES', 'FINANCE')),
  CONSTRAINT fin_request_approvals_decision_check
    CHECK (decision IN ('APPROVED', 'REJECTED'))
);

CREATE INDEX fin_request_approvals_request_idx
  ON fin_request_approvals (request_id, created_at);

/* --------------------------------------------------------------- notes ---- */
-- The conversation on a request: the reason attached to a decision, the
-- justification for an edit, and anything anyone adds.

CREATE TABLE fin_request_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid NOT NULL REFERENCES fin_requests(id) ON DELETE CASCADE,
  author_id   uuid NOT NULL REFERENCES core_users(id),
  body        text NOT NULL,

  -- A note the requester must not see, for Finance and Purchases to talk about
  -- a request among themselves. The legacy app neutralised notes for lite
  -- departments by rewriting their text, which meant the real note was lost.
  internal    boolean NOT NULL DEFAULT false,

  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,

  CONSTRAINT fin_request_notes_body_check CHECK (length(btrim(body)) > 0)
);

CREATE INDEX fin_request_notes_request_idx
  ON fin_request_notes (request_id, created_at) WHERE deleted_at IS NULL;

/* --------------------------------------------------------- permissions ---- */
-- Four permissions, not a department name. In the legacy app, authority came
-- from the string in somebody's department column: being in "purchases" made
-- you Purchases. That is why an operations manager who needed to approve one
-- request had to be moved into another department.

INSERT INTO core_permissions (key, module_key, description) VALUES
  ('finance.request.manage', 'finance',
   'Edit, reject and administer any finance request'),
  ('finance.purchases.decide', 'finance',
   'Approve requests routed to Purchases, and classify what lite departments asked for'),
  ('finance.payment.record', 'finance',
   'Record payments against approved requests'),
  ('finance.report.view', 'finance',
   'Read finance reports and every request, without being able to change anything')
ON CONFLICT (key) DO NOTHING;

/* ------------------------------------------------- departments as rows ---- */
-- The nine departments of the legacy app, mapped onto this portal's own.
--
-- Five of them have no row in core_departments yet. They are created here
-- rather than by hand so that development, staging and production all end up
-- with the same thing, and so the step is recorded in core_migrations.
--
-- Matched by name, because core_departments has no unique constraint on it: if
-- a name already exists the row is left alone, and only the Arabic name is
-- filled in where it is missing.

-- All nine are listed, not only the five that production is missing. Core
-- departments are created by a seed rather than by a migration, so a fresh
-- database has none of them: listing only the missing five would leave a new
-- developer's database with four departments silently unconfigured for
-- finance, and the symptom would be a request form with half its options.
-- Matching by name means production's existing rows are left exactly as they
-- are, and every environment ends up with the same nine either way.

INSERT INTO core_departments (name, name_ar)
SELECT v.name, v.name_ar
  FROM (VALUES
    ('Purchases',      'المشتريات'),
    ('Marketing',      'التسويق'),
    ('Customer Care',  'خدمة العملاء'),
    ('Technology',     'التقنية'),
    ('P.R',            'العلاقات العامة'),
    ('Human Resource', 'الموارد البشرية'),
    ('Office',         'المكتب'),
    ('Workshop',       'الورشة'),
    ('Warehouse',      'المخزن')
  ) AS v(name, name_ar)
 WHERE NOT EXISTS (SELECT 1 FROM core_departments d WHERE d.name = v.name);

-- Arabic names for the departments that already existed without one. The portal
-- is bilingual and a request form that shows half its departments in English
-- is not usable in Arabic.
UPDATE core_departments d SET name_ar = v.name_ar
  FROM (VALUES
    ('Marketing',      'التسويق'),
    ('Customer Care',  'خدمة العملاء'),
    ('Technology',     'التقنية'),
    ('Finance',        'المالية'),
    ('Operations',     'العمليات'),
    ('Executive',      'الإدارة العليا'),
    ('Sales',          'المبيعات'),
    ('Facilities',     'المرافق')
  ) AS v(name, name_ar)
 WHERE d.name = v.name AND (d.name_ar IS NULL OR btrim(d.name_ar) = '');

-- The routing configuration itself, matched to whichever core_departments row
-- carries each name. Customer Support and Tech are this portal's Customer Care
-- and Technology: the same departments under the names the portal uses.

INSERT INTO fin_departments
  (department_id, page_key, code, route, lite, request_types, placeholder, placeholder_ar)
SELECT d.id, v.page_key, v.code, v.route, v.lite, v.types, v.ph, v.ph_ar
  FROM (VALUES
    ('Purchases',     'purchases', 'PUR', 'finance',   false,
       ARRAY['Petty Cash', 'Vendors Payments'],
       'e.g. Vendor payment - supplier name', 'مثال: دفعة مورّد - اسم المورّد'),
    ('Marketing',     'marketing', 'MKT', 'choice',    false,
       ARRAY['Models', 'Stylist', 'Photographer', 'Videographer', 'Other'],
       'e.g. Photoshoot - model fee', 'مثال: جلسة تصوير - أجر عارضة'),
    ('Customer Care', 'support',   'CSP', 'choice',    false,
       ARRAY['Subscription', 'Other'],
       'e.g. Helpdesk tool - monthly plan', 'مثال: أداة دعم - اشتراك شهري'),
    ('Technology',    'tech',      'TEC', 'choice',    false,
       ARRAY['Tech Expenses', 'Other'],
       'e.g. Server renewal - software licence', 'مثال: تجديد خادم - رخصة برنامج'),
    ('P.R',           'pr',        'PRX', 'choice',    false,
       ARRAY['Local Influencer', 'Blogger', 'Agency Payment', 'Other', 'Event Budget Exp'],
       'e.g. Event hosting - influencer fee', 'مثال: تنظيم فعالية - أجر مؤثر'),
    ('Human Resource','hr',        'HRX', 'choice',    false,
       ARRAY['HR Expenses', 'Other'],
       'e.g. Staff training - course fee', 'مثال: تدريب موظفين - رسوم دورة'),
    ('Office',        'operation', 'OFC', 'purchases', true,  ARRAY[]::text[],
       'e.g. Office cleaning - monthly', 'مثال: نظافة المكتب - شهري'),
    ('Workshop',      'workshop',  'WKS', 'purchases', true,  ARRAY[]::text[],
       'e.g. Machine spare part - supplier', 'مثال: قطعة غيار ماكينة - المورّد'),
    ('Warehouse',     'warehouse', 'WRH', 'purchases', true,  ARRAY[]::text[],
       'e.g. Packaging material - supplier', 'مثال: مواد تغليف - المورّد')
  ) AS v(dept_name, page_key, code, route, lite, types, ph, ph_ar)
  JOIN core_departments d ON d.name = v.dept_name
 WHERE NOT EXISTS (SELECT 1 FROM fin_departments f WHERE f.page_key = v.page_key);