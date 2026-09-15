-- 0011_abandoned_checkouts.sql
-- Carts and checkouts people started and did not finish.
--
-- Shopify tracks abandonment at three different points -- browsing a product,
-- adding to a cart, and reaching checkout -- and they are not the same event.
-- Someone who filled in their address and stopped at payment is a phone call
-- worth making; someone who looked at a product and left is not. Collapsing the
-- two into one "abandoned" number is the reason abandonment reports usually go
-- unread.
--
-- A checkout is only *abandoned* in Shopify's sense once the customer has
-- entered contact information, which is what makes this table useful to
-- customer care: every row has someone reachable and a recovery URL.
--
-- `completed_at` is what separates abandoned from recovered. Shopify returns
-- both from the same query, and the recovery rate -- how many of these turned
-- into orders -- is the figure that says whether anyone is acting on them.
--
-- Retention: these rows carry the same protected customer data as an order, so
-- they fall under the same retention job. `pii_purged_at` mirrors sd_customers
-- rather than inventing a second convention.

CREATE TABLE IF NOT EXISTS sd_abandoned_checkouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES sd_shops(id),
  shopify_gid text NOT NULL UNIQUE,

  -- Where the customer stopped. Shopify's Abandonment object distinguishes
  -- these; the abandonedCheckouts query only ever returns CHECKOUT, so the
  -- column is here for when the browse and cart stages are pulled too.
  stage text NOT NULL DEFAULT 'CHECKOUT'
    CHECK (stage IN ('BROWSE', 'CART', 'CHECKOUT')),

  shopify_created_at timestamptz NOT NULL,
  shopify_updated_at timestamptz,
  -- Non-null means the customer came back and bought. The row stays either way.
  completed_at timestamptz,

  customer_id uuid REFERENCES sd_customers(id) ON DELETE SET NULL,
  total_price numeric(18,4) NOT NULL DEFAULT 0,
  currency_code text,
  line_item_count integer NOT NULL DEFAULT 0,

  -- PROTECTED CUSTOMER DATA (Shopify Level 2) ---------------------------------
  -- Denormalised from the checkout rather than read through customer_id,
  -- because an abandoned checkout often has no customer record at all: contact
  -- details were entered, an account was never made. Without these columns the
  -- most actionable rows in the table would be anonymous.
  contact_email text,
  contact_phone text,
  contact_name text,
  ship_city text, ship_country text,
  recovery_url text,
  pii_purged_at timestamptz,
  -- ---------------------------------------------------------------------------

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Every widget reads by shop and date, most filtered to still-abandoned.
CREATE INDEX IF NOT EXISTS sd_abandoned_recent_idx
  ON sd_abandoned_checkouts (shop_id, shopify_created_at DESC);

-- The open ones are the working list, and they are the minority once a store
-- recovers well -- so a partial index stays small and serves the screen people
-- actually sit in front of.
CREATE INDEX IF NOT EXISTS sd_abandoned_open_idx
  ON sd_abandoned_checkouts (shop_id, shopify_created_at DESC)
  WHERE completed_at IS NULL;

CREATE TRIGGER sd_abandoned_updated
  BEFORE UPDATE ON sd_abandoned_checkouts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Its own watermark, so a failed abandonment pull does not roll back the order
-- watermark and re-fetch 92,000 orders.
INSERT INTO sd_sync_state (shop_id, resource, status)
SELECT id, 'abandoned_checkouts', 'PENDING' FROM sd_shops
ON CONFLICT (shop_id, resource) DO NOTHING;