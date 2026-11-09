-- 0044_finance_all_departments.sql
-- Every department can raise a finance request, Finance included.
--
-- Nine departments were configured in 0029 and the rest were not, so anybody
-- in Finance, Operations, Executive, Sales or Facilities opening New Request
-- was told their department does not raise them. Finance being unable to ask
-- for its own spending is the odd one: the team that pays everything had no
-- way to record what it spends on itself.
--
-- Added with the same shape as the general departments: `choice` routing, so
-- the requester decides whether it needs a purchase order, and a plain type
-- list rather than the department-specific ones the original nine carry.

INSERT INTO fin_departments
  (department_id, page_key, code, route, lite, request_types, placeholder, placeholder_ar)
SELECT d.id, v.page_key, v.code, v.route, v.lite, v.types, v.ph, v.ph_ar
  FROM (VALUES
    ('Finance',    'finance',    'FIN', 'choice', false,
       ARRAY['Finance Expenses', 'Subscription', 'Other'],
       'e.g. Accounting software - annual licence',
       'مثال: برنامج محاسبة - رخصة سنوية'),
    ('Operations', 'operations', 'OPS', 'choice', false,
       ARRAY['Operations Expenses', 'Other'],
       'e.g. Courier account - monthly top-up',
       'مثال: حساب شحن - شحن شهري'),
    ('Executive',  'executive',  'EXC', 'choice', false,
       ARRAY['Executive Expenses', 'Other'],
       'e.g. Travel - client visit',
       'مثال: سفر - زيارة عميل'),
    ('Sales',      'sales',      'SLS', 'choice', false,
       ARRAY['Sales Expenses', 'Other'],
       'e.g. Trade show - stand rental',
       'مثال: معرض - إيجار جناح'),
    ('Facilities', 'facilities', 'FAC', 'choice', false,
       ARRAY['Facilities Expenses', 'Other'],
       'e.g. Air conditioning - annual service',
       'مثال: تكييف - صيانة سنوية')
  ) AS v(dept_name, page_key, code, route, lite, types, ph, ph_ar)
  JOIN core_departments d ON d.name = v.dept_name
 WHERE NOT EXISTS (
   SELECT 1 FROM fin_departments f WHERE f.department_id = d.id
 );

-- Any department added to the portal after this one, so nobody is blocked
-- again by a row that was never written. `choice` and a plain type list are
-- the safe default: the requester picks the route, and Finance can refine the
-- configuration afterwards.
INSERT INTO fin_departments
  (department_id, page_key, code, route, lite, request_types, placeholder, placeholder_ar)
SELECT d.id,
       -- A page key and code derived from the name. Both are only identifiers;
       -- the code is what the Google Sheet mapping keys off, so a department
       -- added this way needs a tab before its requests reach the sheet.
       lower(regexp_replace(d.name, '[^a-zA-Z0-9]+', '-', 'g')),
       upper(substring(regexp_replace(d.name, '[^a-zA-Z]', '', 'g') from 1 for 3)),
       'choice', false,
       ARRAY['Other'],
       'e.g. what the money is for',
       'مثال: ما هو الغرض من المبلغ'
  FROM core_departments d
 WHERE NOT EXISTS (SELECT 1 FROM fin_departments f WHERE f.department_id = d.id)
   -- A three-letter code has to be unique, and a clash would mean two
   -- departments writing to one another's sheet tab.
   AND NOT EXISTS (
     SELECT 1 FROM fin_departments f2
      WHERE f2.code = upper(substring(regexp_replace(d.name, '[^a-zA-Z]', '', 'g') from 1 for 3))
   );