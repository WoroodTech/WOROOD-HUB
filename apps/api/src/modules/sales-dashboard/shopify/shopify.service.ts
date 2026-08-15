/**
 * The Shopify integration layer: credentials, rate-limit governance, the GraphQL
 * client, and ShopifyQL.
 *
 * The whole layer sits behind a `ShopifySource` interface with two
 * implementations. `LiveShopifySource` talks to Shopify. `FixtureShopifySource`
 * replays data captured from the real Worood store. Swapping between them is
 * one line in the constructor, driven by config -- which is what makes this
 * buildable and testable before the Dev Dashboard app exists.
 */
import { Injectable, Logger } from '@nestjs/common';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Redis from 'ioredis';
import { config } from '../../../common/config';

/* ------------------------------------------------------------- redis -- */

let redisSingleton: Redis | null = null;
export function redis(): Redis {
  if (!redisSingleton) {
    redisSingleton = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    redisSingleton.on('error', (e) => Logger.warn(`redis: ${e.message}`, 'Shopify'));
  }
  return redisSingleton;
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
    if (config.shopify.tokenStrategy === 'fixture') return 'fixture-token';
    if (config.shopify.tokenStrategy === 'offline') return config.shopify.offlineAccessToken;

    const cached = await redis().get(this.cacheKey);
    if (cached) return JSON.parse(cached).token;

    // Take a lock so a burst of workers causes one HTTP request, not twenty.
    const got = await redis().set(this.lockKey, '1', 'PX', 10_000, 'NX');
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
    if (config.shopify.tokenStrategy === 'fixture') {
      return { source: 'fixture (no live credentials)', expiresAt: null, refreshedAt: null };
    }
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
    const avail = parseFloat(await redis().eval(
      CostGovernor.REFILL_AND_TAKE, 1, this.key,
      String(Date.now()), String(rate), String(estimatedCost), String(provisionalCap),
    ) as string);

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
    await redis().hset(this.key, {
      avail: String(t.currentlyAvailable),
      cap: String(t.maximumAvailable),
      ts: String(Date.now()),
      measured: '1',
    });
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

export interface ShopifySource {
  readonly kind: 'live' | 'fixture';
  graphql<T = any>(q: string, variables?: Record<string, unknown>): Promise<T>;
  shopifyql(q: string): Promise<ShopifyQlResult>;
  orders(): Promise<any[]>;
}

const FIXTURES = config.shopify.fixtureDir;
const readFixture = (name: string): any | null => {
  const p = join(FIXTURES, name);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};

/**
 * Replays data captured read-only from worood-designs.myshopify.com. Fixture
 * mode deliberately returns NO `extensions.cost`: fabricating a throttleStatus
 * would teach the governor a bucket capacity nobody ever measured.
 */
export class FixtureShopifySource implements ShopifySource {
  readonly kind = 'fixture' as const;

  async graphql<T = any>(): Promise<T> {
    throw new Error('Fixture mode does not serve arbitrary GraphQL; use orders() or shopifyql()');
  }

  async orders(): Promise<any[]> {
    return readFixture('orders_recent.json')?.orders ?? [];
  }

  /**
   * Matched on FROM <schema> plus TIMESERIES <grain> / GROUP BY <dimension>,
   * never on exact string equality -- a captured query and a runtime query
   * differ in whitespace and date range but mean the same thing.
   */
  async shopifyql(q: string): Promise<ShopifyQlResult> {
    const lower = q.toLowerCase();
    const from = /from\s+(\w+)/.exec(lower)?.[1] ?? '';
    const grain = /timeseries\s+(\w+)/.exec(lower)?.[1] ?? null;
    const groupBy = /group\s+by\s+([\w_]+)/.exec(lower)?.[1] ?? null;

    const candidates: string[] = [];
    if (from === 'sales' && grain) candidates.push(`sales_${grain}ly.json`, `sales_${grain}.json`);
    if (from === 'sessions' && grain) candidates.push(`sessions_${grain}ly.json`, `sessions_${grain}.json`);
    if (from === 'sales' && groupBy === 'product_title') candidates.push('top_products_90d.json', 'top_products.json');
    if (from === 'sales' && groupBy?.includes('referrer')) candidates.push('order_referrers_30d.json', 'traffic_sources_30d.json');
    if (from === 'sessions' && groupBy === 'referrer_source') candidates.push('traffic_sources_30d.json');
    if (from === 'sessions' && groupBy === 'session_device_type') candidates.push('sessions_by_device_30d.json');
    if (from === 'sessions' && groupBy === 'session_country') candidates.push('sessions_by_country_30d.json');
    if (from === 'fulfillments') candidates.push('fulfillment_30d.json');

    for (const name of candidates) {
      const f = readFixture(name);
      if (!f) continue;
      const payload = f.sessions_by_referrer ?? f.by_device ?? f;
      if (payload?.columns && payload?.rows) {
        return { columns: payload.columns, rows: payload.rows, droppedColumns: f.droppedColumns };
      }
    }
    return { columns: [], rows: [] };
  }
}

export class LiveShopifySource implements ShopifySource {
  readonly kind = 'live' as const;
  private readonly log = new Logger('ShopifyClient');

  constructor(private tokens: TokenManager, private governor: CostGovernor) {}

  async graphql<T = any>(q: string, variables: Record<string, unknown> = {}): Promise<T> {
    const url = `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion}/graphql.json`;
    let refreshedOnce = false;

    for (let attempt = 0; attempt < 5; attempt++) {
      await this.governor.acquire(10);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': await this.tokens.getToken(),
        },
        body: JSON.stringify({ query: q, variables }),
      });

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
      return body.data as T;
    }
    throw new Error('Shopify request failed after retries');
  }

  /** Backoff starts at one second, Shopify's documented recommendation, with
   *  full jitter so a fleet does not retry in lockstep. */
  private backoff(attempt: number) {
    const ceiling = Math.min(1000 * 2 ** attempt, 16_000);
    return new Promise((r) => setTimeout(r, Math.random() * ceiling));
  }

  async orders(): Promise<any[]> {
    throw new Error('Live order paging runs through BackfillService, not here');
  }

  async shopifyql(q: string): Promise<ShopifyQlResult> {
    const data = await this.graphql<any>(
      `query($q: String!) {
         shopifyqlQuery(query: $q) {
           __typename
           ... on TableResponse {
             tableData { columns { name dataType } rowData }
             parseErrors { code message }
           }
         }
       }`, { q },
    );
    const r = data?.shopifyqlQuery;
    // ShopifyQL reports syntax problems as a populated parseErrors array inside
    // an HTTP 200, not as a GraphQL error. Check it explicitly or failures pass
    // unnoticed and the dashboard quietly shows nothing.
    if (r?.parseErrors?.length) {
      throw new Error(`ShopifyQL parse error: ${r.parseErrors.map((e: any) => e.message).join('; ')}`);
    }
    return { columns: r?.tableData?.columns ?? [], rows: r?.tableData?.rowData ?? [] };
  }
}

@Injectable()
export class ShopifyService {
  readonly source: ShopifySource;
  constructor(readonly tokens: TokenManager, readonly governor: CostGovernor) {
    // One line to go live. Everything downstream is written against the
    // interface, so nothing else changes when credentials exist.
    this.source = config.shopify.tokenStrategy === 'fixture'
      ? new FixtureShopifySource()
      : new LiveShopifySource(tokens, governor);
  }
}
