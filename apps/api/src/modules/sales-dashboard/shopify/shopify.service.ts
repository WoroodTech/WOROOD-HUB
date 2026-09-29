/**
 * The Shopify integration layer: credentials, rate-limit governance, the GraphQL
 * client, and ShopifyQL.
 *
 * The layer sits behind a `ShopifySource` interface with one implementation,
 * `LiveShopifySource`. There used to be a second that replayed JSON captured
 * read-only from the store, which is what made the dashboards buildable before
 * the Dev Dashboard app existed. It has been removed for deployment: with no
 * credentials the service now refuses to start rather than quietly serving
 * figures from a file.
 *
 * The interface stays. It is what lets `ShopifyHealthTracker` sit in front of
 * every call, and what a sandbox store or a replay for tests would slot into.
 */
import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { config } from '../../../common/config';

/* ------------------------------------------------------------- redis -- */

let redisSingleton: Redis | null = null;
let redisWarned = false;

/**
 * Redis is not optional in this module: the access token, the shared cost
 * bucket and the webhook queue all live in it.
 *
 * It used to be created with `maxRetriesPerRequest: null`, which means retry
 * forever. Paired with an error handler that only logged a warning, a Redis
 * that was not running produced a server that started up looking healthy and
 * then hung the first request that touched it -- no error, no timeout, no
 * response. Diagnosing that from the outside is close to impossible: the
 * symptom is a spinner.
 *
 * Now it fails in seconds and says what is wrong. A wrong answer quickly beats
 * no answer forever, and an operator who reads "Redis is not reachable" fixes
 * it in a minute.
 */
export function redis(): Redis {
  if (!redisSingleton) {
    redisSingleton = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 2,
      connectTimeout: 3_000,

      /* The offline queue stays on, and the timeout is what makes that safe.
       *
       * Turning the queue off was an overcorrection: it fixed the original
       * hang, but it also meant a routine reconnect -- a Redis restart, a
       * dropped socket, the fraction of a second between the two -- failed
       * whatever request happened to be in flight with "Stream isn't
       * writeable". Transient blips should be absorbed, not surfaced.
       *
       * With `commandTimeout` a queued command waits for a reconnection that is
       * actually coming, and gives up after five seconds when one is not. Both
       * failure modes are handled by the same number, and neither is a hang.
       */
      commandTimeout: 5_000,
      retryStrategy: (times) => (times > 20 ? null : Math.min(times * 200, 2_000)),
    });
    redisSingleton.on('error', (e) => {
      // Once, not once per retry: a dead Redis otherwise fills the log with
      // the same line and buries whatever else went wrong.
      if (!redisWarned) {
        redisWarned = true;
        Logger.error(
          `Redis is not reachable at ${config.redisUrl} (${e.message}). ` +
          `The sales module needs it for the Shopify token, the rate-limit ` +
          `governor and the webhook queue.`, 'Shopify');
      }
    });
    redisSingleton.on('ready', () => { redisWarned = false; });
  }
  return redisSingleton;
}

/** Wraps a Redis call so a connection failure reads as one, rather than as an
 *  ioredis stack trace three layers from the cause. */
export async function withRedis<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (/ECONNREFUSED|Stream isn't writeable|Connection is closed|Command timed out|enableOfflineQueue/i.test(e?.message ?? '')) {
      throw new Error(`${what} needs Redis, which is not reachable at ${config.redisUrl}`);
    }
    throw e;
  }
}

/* ------------------------------------------------------ token manager -- */

export interface TokenStatus {
  source: string; expiresAt: string | null; refreshedAt: string | null;
}

@Injectable()
export class TokenManager {
  private readonly log = new Logger('TokenManager');
  private readonly cacheKey = `sales:shopify:token:${config.shopify.shopDomain}`;
  private readonly lockKey = `${this.cacheKey}:lock`;

  /**
   * The client-credentials token expires after 24 hours (expires_in 86399) and
   * is never visible in the Shopify admin, so this is a real component rather
   * than a configuration value. It is also the component whose failure is least
   * visible and most total: if refresh stops working, the dashboard goes silent
   * at the same time tomorrow.
   */
  async getToken(): Promise<string> {
    if (config.shopify.tokenStrategy === 'offline') return config.shopify.offlineAccessToken;

    const cached = await withRedis('The Shopify token cache', () => redis().get(this.cacheKey));
    if (cached) return JSON.parse(cached).token;

    // Take a lock so a burst of workers causes one HTTP request, not twenty.
    const got = await withRedis('The Shopify token lock',
      () => redis().set(this.lockKey, '1', 'PX', 10_000, 'NX'));
    if (!got) {
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const v = await redis().get(this.cacheKey);
        if (v) return JSON.parse(v).token;
      }
      throw new Error('Timed out waiting for another process to refresh the Shopify token');
    }
    try {
      const res = await fetch(
        `https://${config.shopify.shopDomain}/admin/oauth/access_token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: config.shopify.clientId,
            client_secret: config.shopify.clientSecret,
          }),
        },
      );
      if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
      const body: any = await res.json();
      const expiresIn: number = body.expires_in ?? 86399;
      const record = {
        token: body.access_token,
        refreshedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      };
      // Expire the cache comfortably before Shopify expires the token.
      await redis().set(this.cacheKey, JSON.stringify(record), 'EX', Math.max(expiresIn - 300, 60));
      this.log.log(`Shopify access token refreshed, valid until ${record.expiresAt}`);
      return record.token;
    } finally {
      await redis().del(this.lockKey);
    }
  }

  async invalidate() { await redis().del(this.cacheKey); }

  async status(): Promise<TokenStatus> {
    const cached = await redis().get(this.cacheKey);
    const parsed = cached ? JSON.parse(cached) : null;
    return {
      source: config.shopify.tokenStrategy,
      expiresAt: parsed?.expiresAt ?? null,
      refreshedAt: parsed?.refreshedAt ?? null,
    };
  }
}

/* ------------------------------------------------------ cost governor -- */

export interface GovernorStatus {
  restoreRate: number; available: number | null; maximum: number | null;
  throttledCalls24h: number;
}

/**
 * A shared token bucket in Redis, so the API process and the worker process
 * cannot collectively exceed the plan's restore rate. A per-process limiter
 * would let two processes each behave and still breach the budget together.
 *
 * Bucket capacity is NOT published by Shopify. It is learned from the first
 * real response's throttleStatus rather than assumed -- `maximum` stays null on
 * the health screen until it has actually been measured.
 */
@Injectable()
export class CostGovernor {
  private readonly key = 'sales:shopify:bucket';
  private readonly log = new Logger('CostGovernor');

  private static readonly REFILL_AND_TAKE = `
    local now = tonumber(ARGV[1])
    local rate = tonumber(ARGV[2])
    local cost = tonumber(ARGV[3])
    local cap  = tonumber(redis.call('HGET', KEYS[1], 'cap') or ARGV[4])
    local avail = tonumber(redis.call('HGET', KEYS[1], 'avail') or cap)
    local last  = tonumber(redis.call('HGET', KEYS[1], 'ts') or now)
    avail = math.min(cap, avail + ((now - last) / 1000.0) * rate)
    avail = avail - cost
    redis.call('HSET', KEYS[1], 'avail', avail, 'ts', now, 'cap', cap)
    redis.call('EXPIRE', KEYS[1], 3600)
    return tostring(avail)
  `;

  /** Waits rather than firing and being rejected. Shopify's own guidance is to
   *  compute (needed - available) / restoreRate from throttleStatus. */
  async acquire(estimatedCost = 10): Promise<void> {
    const rate = config.shopify.costRestoreRate;
    const provisionalCap = rate * 10;

    let avail: number;
    try {
      avail = parseFloat(await redis().eval(
        CostGovernor.REFILL_AND_TAKE, 1, this.key,
        String(Date.now()), String(rate), String(estimatedCost), String(provisionalCap),
      ) as string);
    } catch (e: any) {
      /* Redis is the shared bucket, and without it two processes could
       * collectively exceed Shopify's restore rate. But refusing the call
       * outright is the wrong trade: the governor exists to avoid a 429, and a
       * 429 is a retry, while a hard failure here is a dashboard that does not
       * load. Shopify's own limiter is still in front of us and the client
       * already backs off on THROTTLED.
       *
       * So: warn, pause briefly to be a considerate client, and proceed. The
       * token cache above is a different matter -- without it there is no call
       * to make at all, so that one still fails.
       */
      this.log.warn(
        `cost governor unavailable (${e?.message ?? e}) — proceeding without the ` +
        `shared bucket; Shopify's own rate limiting still applies`);
      await new Promise((r) => setTimeout(r, 250));
      return;
    }

    // A negative balance IS the queue: the deficit divided by the restore rate
    // is exactly how long this caller must wait before its points exist.
    if (avail < 0) {
      const waitMs = Math.min((-avail / rate) * 1000, 30_000);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  /** Reconcile the local bucket to what Shopify actually reported. */
  async observe(extensions: any): Promise<void> {
    const t = extensions?.cost?.throttleStatus;
    if (!t) return;
    // Best effort: losing an observation costs accuracy in the bucket, not
    // correctness of the call that just succeeded.
    try {
      await redis().hset(this.key, {
        avail: String(t.currentlyAvailable),
        cap: String(t.maximumAvailable),
        ts: String(Date.now()),
        measured: '1',
      });
    } catch { /* the bucket will re-derive itself on the next successful call */ }
  }

  async markThrottled() {
    const bucket = `sales:shopify:throttled:${new Date().toISOString().slice(0, 13)}`;
    await redis().incr(bucket);
    await redis().expire(bucket, 25 * 3600);
    this.log.warn('Shopify throttled a request');
  }

  async status(): Promise<GovernorStatus> {
    const h = await redis().hgetall(this.key);
    let throttled = 0;
    const now = Date.now();
    for (let i = 0; i < 24; i++) {
      const k = `sales:shopify:throttled:${new Date(now - i * 3600_000).toISOString().slice(0, 13)}`;
      throttled += parseInt((await redis().get(k)) || '0', 10);
    }
    return {
      restoreRate: config.shopify.costRestoreRate,
      available: h.avail ? Math.round(parseFloat(h.avail)) : null,
      // Null until measured: publishing an assumed capacity would be a lie.
      maximum: h.measured === '1' && h.cap ? Math.round(parseFloat(h.cap)) : null,
      throttledCalls24h: throttled,
    };
  }
}

/* ------------------------------------------------------------ sources -- */

export interface ShopifyQlResult {
  columns: { name: string; dataType: string }[];
  rows: string[][];
  droppedColumns?: string[];
}

/**
 * Whether Shopify is answering, and since when it stopped.
 *
 * The dashboards can survive an outage: every figure they show is mirrored in
 * PostgreSQL, so the screen keeps working. What it must not do is keep showing
 * those figures as though they were current. A number that is four hours old
 * and looks live is worse than no number, because somebody will act on it.
 *
 * Two independent triggers, because they catch different failures:
 *
 *   three consecutive failures -- a brief outage, caught in about a minute.
 *     A single blip is not reported: a dropped connection that recovers on the
 *     retry is not something anyone needs to see a banner about.
 *
 *   no success in fifteen minutes -- the reconciliation interval. This catches
 *     the case the counter cannot: jobs that are not running at all, so nothing
 *     is failing because nothing is being attempted. A counter of zero looks
 *     identical to perfect health.
 */
export interface ShopifyHealth {
  live: boolean;
  lastOkAt: string | null;
  /** When the current run of failures began. Null while healthy. */
  degradedSince: string | null;
  consecutiveFailures: number;
  lastError: string | null;
}

@Injectable()
export class ShopifyHealthTracker {
  private lastOk: Date | null = null;
  private degradedSince: Date | null = null;
  private failures = 0;
  private lastError: string | null = null;

  /** Grace at boot: until the first call is made, nothing is wrong yet. */
  private readonly startedAt = new Date();

  private static readonly FAILURE_LIMIT = 3;
  private static readonly SILENCE_MS = 15 * 60_000;

  recordSuccess(): void {
    this.lastOk = new Date();
    this.failures = 0;
    this.degradedSince = null;
    this.lastError = null;
  }

  recordFailure(message: string): void {
    this.failures++;
    this.lastError = message;
    /* Stamped on the first failure of a run, not the third. When the banner
       finally appears it says when the trouble started, not when we decided to
       admit it -- otherwise "unreachable since 14:23" is a minute later than
       the last figure anyone can trust. */
    if (!this.degradedSince) this.degradedSince = new Date();
  }

  get status(): ShopifyHealth {
    const now = Date.now();
    const silent = this.lastOk
      ? now - this.lastOk.getTime() > ShopifyHealthTracker.SILENCE_MS
      /* Never succeeded. Only counts as silence once the service has been up
         long enough to have tried -- the scheduler's first run is 10 seconds
         in, and a fresh boot should not show an outage banner. */
      : now - this.startedAt.getTime() > ShopifyHealthTracker.SILENCE_MS;

    const live = this.failures < ShopifyHealthTracker.FAILURE_LIMIT && !silent;

    return {
      live,
      lastOkAt: this.lastOk?.toISOString() ?? null,
      degradedSince: live ? null : (this.degradedSince ?? this.lastOk ?? this.startedAt).toISOString(),
      consecutiveFailures: this.failures,
      lastError: live ? null : this.lastError,
    };
  }
}

export interface ShopifySource {
  /* Only one implementation now. Kept as a field rather than dropped, because
     callers branch on it to decide whether an operation can reach Shopify at
     all -- and a second source (a sandbox store, a replay for tests) would slot
     in without touching them. */
  readonly kind: 'live';
  graphql<T = any>(q: string, variables?: Record<string, unknown>): Promise<T>;
  shopifyql(q: string): Promise<ShopifyQlResult>;
  orders(): Promise<any[]>;
  /** Prove the connection end to end: credentials, domain and scopes. */
  ping(): Promise<{ shop: string; plan: string; scopes: string[] }>;
}

export class LiveShopifySource implements ShopifySource {
  readonly kind = 'live' as const;
  private readonly log = new Logger('ShopifyClient');

  constructor(
    private tokens: TokenManager,
    private governor: CostGovernor,
    private health: ShopifyHealthTracker,
  ) {}

  async graphql<T = any>(q: string, variables: Record<string, unknown> = {}): Promise<T> {
    const url = `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion}/graphql.json`;
    let refreshedOnce = false;

    /* Six attempts, not five. With the floored backoff above that is roughly a
       minute of patience before giving up, which is the right trade for a
       scheduled capture: finishing late is fine, failing is not. */
    let lastNetworkError: any = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      await this.governor.acquire(10);
      /* An explicit timeout, because Node's fetch has none. Without it a
         Shopify call that never answers holds the request open indefinitely --
         the same class of failure as the Redis hang above, and just as opaque
         from the outside. Thirty seconds is generous for the Admin API; the
         bulk path does its waiting by polling, not by holding a socket. */
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': await this.tokens.getToken(),
          },
          body: JSON.stringify({ query: q, variables }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e: any) {
        /* A transport failure, not a Shopify answer: DNS, a dropped connection,
         * a laptop's wifi, or the thirty-second timeout above.
         *
         * This used to escape the loop entirely. Six retries existed for
         * Shopify's own errors and none for the network, so a momentary blip
         * failed a scheduled capture outright -- observed twice as a bare
         * "fetch failed" with no retry between them. A network that comes back
         * in two seconds should cost two seconds, not a cycle.
         *
         * The last attempt rethrows, so a genuinely unreachable Shopify still
         * surfaces rather than being swallowed into a generic message.
         */
        lastNetworkError = e;
        if (attempt === 5) {
          const msg = `Shopify unreachable after ${attempt + 1} attempts: ${e?.message ?? e}`;
          this.health.recordFailure(msg);
          throw new Error(msg);
        }
        this.log.warn(`network error talking to Shopify (attempt ${attempt + 1}): ${e?.message ?? e}`);
        await this.backoff(attempt);
        continue;
      }

      if (res.status === 401 && !refreshedOnce) {
        refreshedOnce = true;
        await this.tokens.invalidate();
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        await this.governor.markThrottled();
        await this.backoff(attempt);
        continue;
      }

      const body: any = await res.json();
      await this.governor.observe(body.extensions);

      // Shopify signals throttling BOTH as HTTP 429 and as an HTTP 200 whose
      // body carries errors[].extensions.code === 'THROTTLED'. Handling only
      // the first is a classic way to silently lose data under load.
      const throttled = body?.errors?.some?.((e: any) => e?.extensions?.code === 'THROTTLED');
      if (throttled) {
        await this.governor.markThrottled();
        await this.backoff(attempt);
        continue;
      }
      if (body.errors?.length) {
        throw new Error(`Shopify GraphQL error: ${JSON.stringify(body.errors).slice(0, 500)}`);
      }
      this.health.recordSuccess();
      return body.data as T;
    }
    const failure = lastNetworkError
      ? `Shopify request failed after retries (last network error: ${lastNetworkError?.message ?? lastNetworkError})`
      : 'Shopify request failed after retries';
    this.health.recordFailure(failure);
    throw new Error(failure);
  }

  /** Backoff starts at one second, Shopify's documented recommendation, with
   *  full jitter so a fleet does not retry in lockstep. */
  /**
   * Exponential backoff with a floor.
   *
   * This was full jitter -- `Math.random() * ceiling` -- which allows a sleep
   * of nearly zero at any attempt. Five retries could therefore finish in six
   * seconds, and against a cost bucket that refills at 200 points a second that
   * is not long enough for an expensive ShopifyQL query to become affordable.
   * The observed failure was five throttles in six seconds and then a give-up.
   *
   * Half the window is fixed and half is jittered: each attempt is guaranteed
   * to wait longer than the last, while the random half still spreads out
   * callers that were throttled together.
   */
  private backoff(attempt: number) {
    const ceiling = Math.min(1000 * 2 ** attempt, 16_000);
    const wait = ceiling / 2 + Math.random() * (ceiling / 2);
    return new Promise((r) => setTimeout(r, wait));
  }

  async orders(): Promise<any[]> {
    throw new Error('Live order paging runs through BackfillService, not here');
  }

  async shopifyql(q: string): Promise<ShopifyQlResult> {
    /* The response shape changed. Through 2026-04 this was a union and the
       table arrived behind `... on TableResponse`, with `rowData` and
       structured parseErrors. In 2026-07 the fragment is gone -- the type does
       not exist, so the whole query is rejected with `undefinedType` rather
       than returning partial data -- the rows field is `rows`, and parseErrors
       is a plain list of strings. */
    const data = await this.graphql<any>(
      `query($q: String!) {
         shopifyqlQuery(query: $q) {
           tableData { columns { name dataType displayName } rows }
           parseErrors
         }
       }`, { q },
    );
    const r = data?.shopifyqlQuery;

    // ShopifyQL reports syntax problems as a populated parseErrors array inside
    // an HTTP 200, not as a GraphQL error. Check it explicitly or failures pass
    // unnoticed and the dashboard quietly shows nothing.
    if (r?.parseErrors?.length) {
      // Strings now, objects before 2026-07. Handle both so a version bump in
      // either direction does not turn a readable error into "[object Object]".
      const messages = r.parseErrors.map((e: any) =>
        typeof e === 'string' ? e : (e?.message ?? JSON.stringify(e)));
      throw new Error(`ShopifyQL parse error: ${messages.join('; ')}`);
    }

    /* A null field is not an empty result, and conflating the two is how this
       layer used to fail invisibly: `?? []` turned "Shopify refused" into
       "there were no sales", the capture job wrote zero rows, the endpoint
       answered 200, and the dashboard showed nothing with no error anywhere.
       The usual cause is a missing read_reports scope or a token that is not
       what it claims to be -- both worth saying out loud. */
    if (r == null) {
      throw new Error(
        'ShopifyQL returned no response object. The usual causes are a missing ' +
        'read_reports scope, or an access token that is not valid for this shop.');
    }
    if (!r.tableData) {
      throw new Error('ShopifyQL returned a table response with no tableData');
    }

    return { columns: r.tableData.columns ?? [], rows: r.tableData.rows ?? [] };
  }

  /**
   * A cheap round trip that proves the credentials, the domain and the scopes
   * all line up, without writing anything. Exists because "200 and no rows" is
   * indistinguishable from "everything works, the shop had a quiet day" until
   * something asks Shopify who it thinks you are.
   */
  async ping(): Promise<{ shop: string; plan: string; scopes: string[] }> {
    const data = await this.graphql<any>(
      `{ shop { name myshopifyDomain plan { displayName } }
         currentAppInstallation { accessScopes { handle } } }`);
    if (!data?.shop) throw new Error('Shopify accepted the call but returned no shop');
    return {
      shop: `${data.shop.name} (${data.shop.myshopifyDomain})`,
      plan: data.shop.plan?.displayName ?? 'unknown',
      scopes: (data.currentAppInstallation?.accessScopes ?? []).map((s: any) => s.handle),
    };
  }
}

@Injectable()
export class ShopifyService {
  readonly source: ShopifySource;
  constructor(
    readonly tokens: TokenManager,
    readonly governor: CostGovernor,
    readonly health: ShopifyHealthTracker,
  ) {
    this.source = new LiveShopifySource(tokens, governor, health);
  }
}