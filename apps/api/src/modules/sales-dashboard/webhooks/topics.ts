/**
 * The webhook topics this module subscribes to.
 *
 * In its own file, with no imports, deliberately. It used to live in
 * `webhooks.ts` alongside the controller and the HMAC guard, which meant
 * anything wanting the list -- `SyncService`, to register and to verify --
 * pulled in the controller too. That was harmless until the webhook processor
 * needed `SyncService`, at which point the graph closed into a cycle.
 *
 * A constant that everything needs and that needs nothing is the one thing that
 * should never sit in a file with dependencies.
 */
export const WEBHOOK_TOPICS = [
  'orders/create', 'orders/updated', 'orders/paid', 'orders/cancelled',
  /* Deletion has to be subscribed to explicitly, and it is the one change no
     other mechanism can catch. Reconciliation asks Shopify for orders whose
     `updated_at` moved; a deleted order simply stops appearing, and absence is
     not an event a delta pull can see. Without this topic a deleted order stays
     in the mirror forever. */
  'orders/delete',
  'refunds/create',

  'customers/create', 'customers/update',
  /* Deletion, for the same reason orders/delete is above and with more at
     stake: every customer figure is a ratio over the customer base, so a
     deleted customer keeps inflating the denominator of repeat-purchase rate,
     keeps sitting in a cohort, and keeps their name in the top-customers table
     after they asked to be removed. */
  'customers/delete',

  /* Checkouts, so Checkout Recovery is current rather than up to half an hour
     old. The scheduled pull every thirty minutes stays as the safety net --
     these topics make the list live, they do not replace reconciliation. */
  'checkouts/create', 'checkouts/update', 'checkouts/delete',

  /* Shop settings. Currency and timezone are not decorative: every ShopifyQL
     query aggregates in the shop's timezone, and every money column is labelled
     with its currency. A store that changed either would keep producing figures
     computed on the old setting -- silently, and on a partial day a timezone
     mismatch is worth roughly a factor of two. */
  'shop/update',

  /* Uninstall. Removing the app deletes every subscription, so this is the last
     thing that will ever arrive -- which makes it the only chance to say so out
     loud rather than leaving a dashboard rendering yesterday's numbers with
     nobody aware the pipe was cut. */
  'app/uninstalled',

  'bulk_operations/finish',
];