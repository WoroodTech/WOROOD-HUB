-- 0003_sales_dashboard.sql
-- Module 2: Sales Dashboard (Shopify). Owns every sd_* table.
-- See WOROOD-HUB-Module-2-Sales-Dashboard.md sections 6.2 - 6.6.

-- A table rather than configuration, so a second Worood store is a row.
CREATE TABLE sd_shops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  myshopify_domain text NOT NULL UNIQUE,
  name text NOT NULL, primary_domain text,
  iana_timezone text NOT NULL DEFAULT 'Africa/Cairo',
  currency_code text NOT NULL DEFAULT 'EGP',
  money_format text, plan_name text,
  api_version text NOT NULL DEFAULT '2026-07',
  -- 100 Standard / 200 Advanced / 1000 Plus. Held as data so a plan change is
  -- a configuration edit rather than a defect.
  cost_restore_rate integer NOT NULL DEFAULT 200,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- webhook_id is the dedup key. Inserts are ON CONFLICT DO NOTHING, so a
-- duplicate delivery is absorbed by the database rather than reasoned about in
-- code. event_id is correlation ONLY: one merchant action fans out to several
-- deliveries that share it, so deduplicating on it would drop real events.
CREATE TABLE sd_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid REFERENCES sd_shops(id),
  webhook_id text NOT NULL UNIQUE,
  event_id text, topic text NOT NULL, shop_domain text, api_version text,
  triggered_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'PENDING',   -- PENDING|PROCESSED|STALE|FAILED
  error text, payload jsonb, payload_trimmed_at timestamptz
);
CREATE INDEX sd_webhook_events_pending_idx ON sd_webhook_events (status, received_at)
  WHERE status IN ('PENDING','FAILED');
CREATE INDEX sd_webhook_events_topic_idx ON sd_webhook_events (topic, received_at DESC);

-- Identifying columns sit in their own group so the retention job can null them
-- in one statement. Shopify Level 2 obliges retention limits and an access log.
CREATE TABLE sd_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES sd_shops(id),
  shopify_gid text NOT NULL UNIQUE,
  orders_count integer NOT NULL DEFAULT 0,
  total_spent numeric(18,4) NOT NULL DEFAULT 0,
  currency_code text, state text,
  first_order_at timestamptz, last_order_at timestamptz,
  -- PROTECTED CUSTOMER DATA (Shopify Level 2) -------------------------------
  display_name text, email text, phone text,
  address_city text, address_province text, address_country text, address_zip text,
  pii_purged_at timestamptz,
  -- -------------------------------------------------------------------------
  shopify_created_at timestamptz, shopify_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sd_customers_shop_idx ON sd_customers (shop_id, last_order_at DESC);

-- shopify_updated_at is what the out-of-order guard compares against: Shopify
-- guarantees no ordering within or across topics, so a later event can arrive
-- first and must not overwrite newer state.
CREATE TABLE sd_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES sd_shops(id),
  shopify_gid text NOT NULL UNIQUE,
  name text NOT NULL, order_number integer,
  customer_id uuid REFERENCES sd_customers(id),
  shopify_created_at timestamptz NOT NULL,
  processed_at timestamptz, cancelled_at timestamptz, cancel_reason text,
  shopify_updated_at timestamptz NOT NULL,
  test boolean NOT NULL DEFAULT false,
  financial_status text, fulfillment_status text,
  source_name text, referrer_source text, tags text[],
  currency_code text NOT NULL, presentment_currency_code text,
  -- Aggregation always uses shop currency; presentment is kept for the order
  -- detail view and for disputes. Summing presentment adds unlike currencies.
  total_price numeric(18,4) NOT NULL DEFAULT 0,
  current_total_price numeric(18,4) NOT NULL DEFAULT 0,
  subtotal_price numeric(18,4) NOT NULL DEFAULT 0,
  current_subtotal_price numeric(18,4) NOT NULL DEFAULT 0,
  total_discounts numeric(18,4) NOT NULL DEFAULT 0,
  total_tax numeric(18,4) NOT NULL DEFAULT 0,
  total_shipping numeric(18,4) NOT NULL DEFAULT 0,
  total_refunded numeric(18,4) NOT NULL DEFAULT 0,
  net_payment numeric(18,4) NOT NULL DEFAULT 0,
  total_outstanding numeric(18,4) NOT NULL DEFAULT 0,
  presentment_total_price numeric(18,4),
  ship_city text, ship_province text, ship_country text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sd_orders_shop_created_idx ON sd_orders (shop_id, shopify_created_at DESC);
CREATE INDEX sd_orders_shop_updated_idx ON sd_orders (shop_id, shopify_updated_at);
CREATE INDEX sd_orders_customer_idx ON sd_orders (customer_id, shopify_created_at DESC);
CREATE INDEX sd_orders_live_idx ON sd_orders (shop_id, shopify_created_at DESC)
  WHERE test = false AND cancelled_at IS NULL;

CREATE TABLE sd_order_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES sd_orders(id) ON DELETE CASCADE,
  shopify_gid text NOT NULL UNIQUE,
  product_gid text, variant_gid text,
  title text NOT NULL, variant_title text, sku text,
  quantity integer NOT NULL DEFAULT 0,
  current_quantity integer NOT NULL DEFAULT 0,
  original_total numeric(18,4) NOT NULL DEFAULT 0,
  discounted_total numeric(18,4) NOT NULL DEFAULT 0
);
CREATE INDEX sd_order_line_items_order_idx ON sd_order_line_items (order_id);
CREATE INDEX sd_order_line_items_product_idx ON sd_order_line_items (product_gid);

CREATE TABLE sd_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES sd_orders(id) ON DELETE CASCADE,
  shopify_gid text NOT NULL UNIQUE,
  total_refunded numeric(18,4) NOT NULL DEFAULT 0,
  currency_code text, note text,
  shopify_created_at timestamptz NOT NULL
);
CREATE INDEX sd_refunds_order_idx ON sd_refunds (order_id);

CREATE TABLE sd_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES sd_shops(id),
  shopify_gid text NOT NULL UNIQUE,
  title text NOT NULL, handle text, status text,
  product_type text, vendor text, total_inventory integer, image_url text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sd_sync_state (
  shop_id uuid NOT NULL REFERENCES sd_shops(id),
  resource text NOT NULL,
  watermark timestamptz, last_run_at timestamptz, last_ok_at timestamptz,
  status text NOT NULL DEFAULT 'IDLE',
  error text, records integer NOT NULL DEFAULT 0,
  PRIMARY KEY (shop_id, resource)
);

-- JSONB metrics so a new ShopifyQL column needs no migration. The unique key
-- makes re-capture an idempotent upsert, which is what lets the nightly job
-- correct thirteen months of history without duplicating anything.
CREATE TABLE sd_metric_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES sd_shops(id),
  schema_name text NOT NULL,   -- sales | sessions | traffic | customers
  grain text NOT NULL,         -- hour | day | total
  bucket_start timestamptz NOT NULL,
  bucket_timezone text NOT NULL DEFAULT 'Africa/Cairo',
  dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  dimensions_hash text GENERATED ALWAYS AS (md5(dimensions::text)) STORED,
  metrics jsonb NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  is_final boolean NOT NULL DEFAULT false,
  CONSTRAINT sd_metric_snapshots_unique
    UNIQUE (shop_id, schema_name, grain, bucket_start, dimensions_hash)
);
CREATE INDEX sd_metric_snapshots_read_idx ON sd_metric_snapshots (shop_id, schema_name, grain, bucket_start DESC);
CREATE INDEX sd_metric_snapshots_dims_idx ON sd_metric_snapshots USING gin (dimensions);

-- Composition. A "combined" dashboard needs no special-casing: it is another
-- row here whose widgets happen to be reused from two areas.
CREATE TABLE sd_widgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL, name_ar text, description text,
  data_source text NOT NULL,
  kind text NOT NULL,   -- kpi | line | bar | donut | table | funnel
  default_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  required_permission text,
  min_width integer NOT NULL DEFAULT 3,
  max_width integer NOT NULL DEFAULT 12,
  default_width integer NOT NULL DEFAULT 6,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sd_dashboards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL, name_ar text, description text,
  is_system boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES core_users(id),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sd_dashboard_widgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id uuid NOT NULL REFERENCES sd_dashboards(id) ON DELETE CASCADE,
  widget_id uuid NOT NULL REFERENCES sd_widgets(id),
  position integer NOT NULL,
  width integer NOT NULL DEFAULT 6,
  config_override jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (dashboard_id, position)
);
CREATE INDEX sd_dashboard_widgets_dash_idx ON sd_dashboard_widgets (dashboard_id, position);

CREATE TABLE sd_role_dashboard_access (
  role_id uuid NOT NULL REFERENCES core_roles(id) ON DELETE CASCADE,
  dashboard_id uuid NOT NULL REFERENCES sd_dashboards(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, dashboard_id)
);

-- 'REVOKE' is what lets an individual be removed from a dashboard their role
-- otherwise grants -- the draft's model could only express that by changing
-- the role, which would affect everyone holding it.
CREATE TABLE sd_user_dashboard_access (
  user_id uuid NOT NULL REFERENCES core_users(id) ON DELETE CASCADE,
  dashboard_id uuid NOT NULL REFERENCES sd_dashboards(id) ON DELETE CASCADE,
  effect text NOT NULL DEFAULT 'GRANT',
  granted_by uuid REFERENCES core_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, dashboard_id),
  CONSTRAINT sd_user_dashboard_access_effect CHECK (effect IN ('GRANT','REVOKE'))
);

CREATE TRIGGER sd_shops_updated BEFORE UPDATE ON sd_shops FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER sd_orders_updated BEFORE UPDATE ON sd_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER sd_customers_updated BEFORE UPDATE ON sd_customers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER sd_dashboards_updated BEFORE UPDATE ON sd_dashboards FOR EACH ROW EXECUTE FUNCTION set_updated_at();
