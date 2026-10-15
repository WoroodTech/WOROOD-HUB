/**
 * The states a webhook event can be in, and the moves between them.
 *
 * Written down in one place because the rules are about to be enforced from
 * three: the worker that claims and completes events, the sweeper that takes
 * back abandoned ones, and the health and replay screens that report them. Three
 * copies of a state machine is three chances to disagree about what DEAD means.
 *
 * This file describes; it does not act. No claim, no retry, no worker -- those
 * are Phase 4, and they will import from here rather than restate it.
 */

export const WEBHOOK_STATES = [
  'PENDING', 'PROCESSING', 'PROCESSED', 'STALE', 'FAILED', 'DEAD',
] as const;
export type WebhookState = typeof WEBHOOK_STATES[number];

/**
 * What each state means, in the terms the system actually uses.
 *
 *   PENDING     Accepted and stored, waiting to be claimed. Where every event
 *               begins, and where a deliberate replay returns one to.
 *
 *   PROCESSING  Claimed. A worker holds it until lease_expires_at. The only
 *               state that is a promise rather than a fact, which is why the
 *               database refuses to store it without an expiry.
 *
 *   PROCESSED   Terminal. The payload was applied.
 *
 *   STALE       Terminal. The payload was older than what is already stored and
 *               was correctly discarded. Not a failure -- Shopify guarantees no
 *               ordering, so this is the system working.
 *
 *   FAILED      The attempt threw. Eligible again at next_attempt_at. Transient
 *               by assumption: a timeout, a lock, a 5xx from Shopify.
 *
 *   DEAD        Terminal. Attempts exhausted. Nothing automatic will touch it
 *               again; it is waiting for a person to look.
 */
export const TERMINAL_STATES: readonly WebhookState[] = ['PROCESSED', 'STALE', 'DEAD'];

export const isTerminal = (s: WebhookState): boolean => TERMINAL_STATES.includes(s);

/**
 * Every move that is allowed, and by implication every move that is not.
 *
 * The ones deliberately absent are worth naming:
 *
 *   PROCESSED -> anything   A successful application is not revisited. A later
 *                           change to the same order arrives as its own event.
 *   STALE -> anything       Staleness only hardens. The stored timestamp moves
 *                           forward, so a payload that lost once loses again.
 *   PENDING -> PROCESSED    Nothing is applied without being claimed first;
 *                           skipping the claim is how two workers do the same
 *                           work and both believe they were alone.
 *   DEAD -> PROCESSING      A dead event is restarted by a person, through
 *                           PENDING, so the decision is recorded as a move
 *                           rather than happening implicitly inside a worker.
 */
export const WEBHOOK_TRANSITIONS: Record<WebhookState, readonly WebhookState[]> = {
  PENDING:    ['PROCESSING'],
  /* Back to PENDING is the sweeper reclaiming an expired lease: the worker that
     held it is gone, and the event has not been attempted as far as anyone can
     tell. FAILED is an attempt that ran and threw. */
  PROCESSING: ['PROCESSED', 'STALE', 'FAILED', 'DEAD', 'PENDING'],
  PROCESSED:  [],
  STALE:      [],
  /* A retry goes through a claim like any other work. DEAD is the attempt
     ceiling being reached. */
  FAILED:     ['PROCESSING', 'DEAD'],
  /* Only a deliberate replay. */
  DEAD:       ['PENDING'],
};

export function canTransition(from: WebhookState, to: WebhookState): boolean {
  return WEBHOOK_TRANSITIONS[from]?.includes(to) ?? false;
}

/* --------------------------------------------------------------- retrying -- */

/**
 * How many times an event is attempted before it is left for a person.
 *
 * Six, spanning roughly eight hours. Long enough to ride out the failures that
 * actually happen -- a Shopify 5xx, a deploy, a lock held too long -- and short
 * enough that a genuinely broken payload surfaces within a working day rather
 * than retrying quietly for a week.
 */
export const MAX_ATTEMPTS = 6;

/**
 * How long to wait before attempt number `attempts + 1`.
 *
 * Fixed steps rather than a computed curve, because the useful property is that
 * somebody can read them: half a minute, two minutes, ten, an hour, six.
 *
 * The jitter matters more than the shape. A Shopify incident fails every event
 * in flight at once, and without it they would all come back at the same
 * instant, fail together, and do it again -- a thundering herd the system
 * inflicts on itself while the thing it depends on is already unwell.
 */
const BACKOFF_SECONDS = [30, 120, 600, 3600, 21600];

export function retryDelaySeconds(attempts: number, jitter = Math.random()): number {
  const base = BACKOFF_SECONDS[Math.min(Math.max(attempts, 1), BACKOFF_SECONDS.length) - 1];
  // +/-20%, so a batch that failed together comes back spread out.
  return Math.round(base * (0.8 + jitter * 0.4));
}

/** Where a failed attempt lands: another try, or a person. */
export function afterFailure(attempts: number): { state: WebhookState; retryInSeconds: number | null } {
  return attempts >= MAX_ATTEMPTS
    ? { state: 'DEAD', retryInSeconds: null }
    : { state: 'FAILED', retryInSeconds: retryDelaySeconds(attempts) };
}

/* ------------------------------------------------------- worker predicates -- */

/**
 * Which events a worker may take.
 *
 * Kept here as the exact text the claim will use, so the predicate and the
 * partial index that serves it (sd_webhook_events_claimable_idx) are written
 * next to each other and stay the same shape. A claim whose predicate drifts
 * from its index still works and quietly becomes a sequential scan of every
 * webhook ever received.
 *
 * `next_attempt_at IS NOT NULL` is the unscheduled case: failures from before
 * the lifecycle existed, and anything a person has parked. They stay visible
 * and countable without being swept into a worker's first run.
 */
export const CLAIMABLE_PREDICATE =
  `status IN ('PENDING','FAILED') AND next_attempt_at IS NOT NULL AND next_attempt_at <= now()`;

/** Claims whose holder has gone away. */
export const EXPIRED_LEASE_PREDICATE =
  `status = 'PROCESSING' AND lease_expires_at <= now()`;

/**
 * How long a claim is held before it may be taken over.
 *
 * Generous relative to the work, which is one Shopify read and a handful of
 * writes. The cost of being too short is two workers doing the same event; the
 * cost of being too long is a delay after a crash. The first is a correctness
 * problem and the second is a latency one, so this errs long -- and the worker
 * renews the lease for anything genuinely slow.
 */
export const LEASE_SECONDS = 120;

/* ------------------------------------------- the contract Phase 4 must keep -- */

/**
 * The order the worker must do things in.
 *
 * Stated as four steps because the interesting property is not any one of them
 * but where the line between them falls:
 *
 *   1. CLAIM      one conditional UPDATE: PENDING|FAILED -> PROCESSING, setting
 *                 lease_owner and lease_expires_at, RETURNING id. No row means
 *                 somebody else took it; move on to the next event.
 *
 *   2. APPLY      write the payload into the mirror. Unconditional on the
 *                 lease, and that is deliberate -- see below.
 *
 *   3. COMPLETE   one conditional UPDATE, guarded by OWNED_CLAIM_PREDICATE.
 *                 No row means the lease was lost: log, and stop.
 *
 *   4. ANNOUNCE   everything outside the database -- publish, snapshot refresh,
 *                 hydration. Only reached when step 3 returned a row.
 *
 * Step 2 runs without re-checking the lease, which looks wrong and is not. Any
 * check there would be a read followed by a write with nothing holding the row
 * between them: the same read-then-write race Phases 1 and 2 removed from this
 * codebase twice. The protection for step 2 is not ownership, it is that every
 * write it makes carries its own guard and converges on the same result however
 * many workers perform it. Attempting it from a worker that has already lost
 * its claim is harmless; attempting it twice is harmless.
 *
 * Step 3 is where ownership matters, because a status is not idempotent in that
 * way. It is a single value, and the last writer wins: a stalled worker waking
 * after its lease expired would otherwise overwrite PROCESSED with FAILED,
 * resurrect an event another worker retired, or reset attempts so a payload
 * that cannot succeed never reaches DEAD.
 *
 * Step 4 sits after step 3 so that losing the lease costs nothing visible. The
 * worker that still owns the event announces it; the one that lost it is
 * silent.
 */

/**
 * Still ours, and still live. Both halves are needed: `lease_owner = $OWNER`
 * stops a worker finalizing an event that has since been reclaimed and given
 * to somebody else, and `lease_expires_at > now()` stops it finalizing one
 * whose lease simply ran out and is waiting for the sweeper.
 *
 *   UPDATE sd_webhook_events
 *      SET status = $3, processed_at = now(), last_attempt_at = now(),
 *          attempts = attempts + 1, error = $4,
 *          next_attempt_at = $5, lease_owner = NULL, lease_expires_at = NULL
 *    WHERE id = $1
 *      AND status = 'PROCESSING'
 *      AND lease_owner = $2
 *      AND lease_expires_at > now()
 *    RETURNING id;
 *
 * The same three conditions guard a lease renewal, so a worker cannot extend a
 * claim that has already been taken from it.
 */
export const OWNED_CLAIM_PREDICATE =
  `status = 'PROCESSING' AND lease_owner = $OWNER AND lease_expires_at > now()`;

/**
 * Two different kinds of safety, which the steps above keep apart.
 *
 * DATABASE WRITES (step 2) are safe to repeat because each is written to be.
 * They need no lease, and a second application changes nothing:
 *
 *   the order row      guarded by `shopify_updated_at >= stored`, so the same
 *                      payload is a no-op and an older one is refused (Phase 2)
 *   line items         upserted on Shopify's line id; pruned only against a
 *                      list known to be complete (Phase 2)
 *   refunds            upserted on Shopify's refund id, assigned rather than
 *                      added, so the amount converges instead of doubling
 *   customer spend     recomputed from the customer's own orders, never
 *                      incremented
 *
 * EXTERNAL EFFECTS (step 4) are not idempotent in the same way and are not
 * treated as though they were. They are gated on proven ownership instead:
 *
 *   websocket publish  a nudge to refetch, carrying no payload; a duplicate
 *                      costs a browser one extra request
 *   snapshot refresh   debounced, so several calls collapse into one
 *   hydration          a Shopify read, then the step-2 path again -- an extra
 *                      API call against the rate limit, changing nothing
 *
 * None of those can do damage, which is why at-least-once is acceptable here:
 * the process can still die between steps 3 and 4, and the event is then
 * recorded as finished with its announcement never sent. The snapshot catches
 * up on its own schedule.
 *
 * What this argument does NOT cover is anything that leaves a mark outside this
 * system -- an email, a message to a customer, a payment. None exists on this
 * path today. Adding one to step 4 would need its own idempotency key, and
 * adding one to step 2 would be wrong outright, because step 2 is explicitly
 * allowed to run more than once and from a worker that no longer owns the
 * event.
 */
export const AT_LEAST_ONCE = true;

/**
 * Taking back abandoned work.
 *
 * The sweeper's reclaim is conditional for the same reason step 3 is: between
 * selecting expired leases and updating them, a worker may renew. As one
 * conditional UPDATE, the renewal either happens first -- and the reclaim
 * matches nothing -- or second, and fails its own ownership check.
 *
 *   UPDATE sd_webhook_events
 *      SET status = 'PENDING', lease_owner = NULL, lease_expires_at = NULL,
 *          next_attempt_at = now()
 *    WHERE status = 'PROCESSING' AND lease_expires_at <= now();
 *
 * Back to PENDING rather than FAILED, and attempts is not incremented: as far
 * as anyone can tell the attempt never ran. Counting it would push events
 * toward DEAD for the crime of having been on a host that died.
 *
 * That does mean an event whose payload reliably kills its worker is reclaimed
 * for ever rather than reaching DEAD. Phase 4 should bound it -- a reclaim
 * count, or counting an expired lease toward attempts after the first couple --
 * and that decision belongs with the worker, not here.
 */
export const RECLAIM_TO: WebhookState = 'PENDING';