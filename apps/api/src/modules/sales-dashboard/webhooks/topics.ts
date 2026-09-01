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
  'refunds/create', 'customers/create', 'customers/update',
  'bulk_operations/finish',
];