/**
 * Talking to Zoho Books.
 *
 * Two jobs, kept apart from everything that decides *what* to send: holding a
 * usable access token, and making one HTTP call. Nothing here knows what a
 * request or a payment is.
 *
 * The mode is the most important thing in this file. `off` makes every call a
 * no-op, `dry` builds the exact body and logs it without sending, and `live`
 * sends. The legacy app has the same three and it is the reason this can be
 * tested at all: a dry run proves the bodies are right against real
 * configuration without creating anything in the accounts.
 */
import { Injectable, Logger } from '@nestjs/common';
import { config } from '../../../common/config';

export type ZohoMode = 'off' | 'dry' | 'live';

export class ZohoError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Zoho's own numeric code, where it gave one. */
    readonly zohoCode?: number,
    /** Whether trying again later could reasonably succeed. */
    readonly retryable = false,
  ) {
    super(message);
  }
}

/**
 * The access token.
 *
 * Zoho issues one that lasts an hour against a refresh token that does not
 * expire. Refreshing is rate-limited, so the token is held for its lifetime
 * and a refresh already in flight is joined rather than started again -- which
 * is what stops a burst of queued events from asking for several tokens at
 * once.
 *
 * Cached in the process rather than in Redis, because Redis lives in the
 * sales-dashboard module and reaching into it would tie Finance to Shopify for
 * no reason. The cost is one refresh per process per hour, which is nothing
 * against the allowance.
 */
@Injectable()
export class ZohoTokenManager {
  private readonly log = new Logger('ZohoToken');
  private cached: { token: string; expiresAt: number } | null = null;
  private inFlight: Promise<string> | null = null;

  async getToken(): Promise<string> {
    /* Thirty seconds of margin: a token that expires mid-flight produces a 401
       on a call that was about to create a payment, which is the worst moment
       for an avoidable failure. */
    if (this.cached && this.cached.expiresAt - Date.now() > 30_000) {
      return this.cached.token;
    }
    /* A refresh is already happening: wait for it rather than starting a
       second. Several queued events hitting an expired token at once is the
       normal case, not an unusual one. */
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.refresh().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async refresh(): Promise<string> {
    {
      const dc = config.zoho.dc || 'com';
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: config.zoho.refreshToken,
        client_id: config.zoho.clientId,
        client_secret: config.zoho.clientSecret,
      });

      const res = await fetch(`https://accounts.zoho.${dc}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const json: any = await res.json().catch(() => ({}));

      if (!res.ok || !json.access_token) {
        /* Deliberately vague: the response can echo parts of the request, and
           this message ends up in logs. */
        throw new ZohoError(res.status,
          `Zoho refused to refresh the token (${json.error ?? res.status})`,
          undefined, res.status >= 500);
      }

      const ttl = Number(json.expires_in ?? 3600) * 1000;
      this.cached = { token: json.access_token, expiresAt: Date.now() + ttl };

      this.log.log('refreshed the Zoho access token');
      return json.access_token;
    }
  }
}

@Injectable()
export class ZohoBooksClient {
  private readonly log = new Logger('ZohoBooks');

  constructor(private readonly tokens: ZohoTokenManager) {}

  get mode(): ZohoMode {
    return (config.zoho.mode as ZohoMode) ?? 'off';
  }

  get configured(): boolean {
    return !!(config.zoho.clientId && config.zoho.clientSecret
      && config.zoho.refreshToken && config.zoho.organizationId);
  }

  private get base(): string {
    return `https://www.zohoapis.${config.zoho.dc || 'com'}/books/v3`;
  }

  /**
   * One call.
   *
   * In `dry` the body is built, logged and not sent, and a fake id comes back
   * so the rest of the flow can be exercised end to end. The caller cannot
   * tell the difference, which is the point: a dry run proves the bodies
   * without a special code path that only runs in tests.
   */
  async call(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    opts: { body?: unknown; query?: Record<string, string> } = {},
  ): Promise<any> {
    if (this.mode === 'off') {
      throw new ZohoError(503, 'The Zoho connection is switched off on this server.');
    }
    if (!this.configured) {
      throw new ZohoError(503, 'Zoho Books is not configured on this server.');
    }

    const query = new URLSearchParams({
      organization_id: config.zoho.organizationId,
      ...(opts.query ?? {}),
    });
    const url = `${this.base}${path}?${query}`;

    /*
     * Dry means "do not write", not "do not read".
     *
     * Short-circuiting every call made reads return a stub too, so the account
     * sync came back with nothing and looked exactly like a connection to an
     * empty organisation -- while a raw fetch against the same credentials
     * returned forty-six bank accounts. Hours went into the wrong question.
     *
     * A GET changes nothing in anybody's books, so it always goes through.
     * Only the calls that would create something are held back.
     */
    if (this.mode === 'dry' && method !== 'GET') {
      this.log.log(`[dry] ${method} ${path} ${JSON.stringify(opts.body ?? {})}`);
      return { dry: true, [idFieldFor(path)]: `dry-${Date.now()}` };
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Zoho-oauthtoken ${await this.tokens.getToken()}`,
          'Content-Type': 'application/json',
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e: any) {
      /* A timeout is not a failure, it is an unknown: the call may well have
         succeeded. Marked retryable, and the retry looks for the record by its
         reference before creating anything. */
      throw new ZohoError(0, `Zoho did not answer: ${e?.message ?? e}`, undefined, true);
    }

    const json: any = await res.json().catch(() => ({}));

    const code = Number(json?.code);

    /*
     * Zoho reports failure two ways, and only one of them is an HTTP status.
     *
     * A great many of its errors come back as 200 with a non-zero `code` in
     * the body -- "you are not authorised for this organisation" among them.
     * Checking only res.ok let those through as success with an empty list,
     * which is how a connection to the wrong organisation looked exactly like
     * an organisation with no accounts in it. Zero means success; anything
     * else is an error whatever the status line says.
     */
    if (!res.ok || (Number.isFinite(code) && code !== 0)) {
      throw new ZohoError(
        res.status,
        json?.message ?? `Zoho refused the request (${res.status})`,
        Number.isFinite(code) ? code : undefined,
        /* Worth trying again: rate limited, or Zoho itself is unwell. A 400
           or an authorisation code means it will fail the same way next time. */
        res.status === 429 || res.status >= 500,
      );
    }
    return json;
  }

  /**
   * Every page of a list, not just the first.
   *
   * Zoho returns at most 200 rows per page and says so only in a
   * `page_context` block that is easy to ignore -- and ignoring it is silent:
   * a chart of accounts with 250 entries comes back looking like one with 200,
   * and the 50 that are missing are missing from a dropdown rather than from
   * an error message.
   *
   * Capped at 25 pages. A list longer than five thousand rows means something
   * is wrong with the question being asked, and walking forever is a worse
   * failure than stopping.
   */
  async listAll(
    path: string, listKey: string, query: Record<string, string> = {},
  ): Promise<any[]> {
    const out: any[] = [];
    for (let page = 1; page <= 25; page++) {
      const res = await this.call('GET', path, {
        query: { ...query, page: String(page), per_page: '200' },
      });
      const rows = res?.[listKey];
      if (!Array.isArray(rows) || rows.length === 0) break;
      out.push(...rows);

      /* Zoho's own answer to "is there more". Trusted over counting rows,
         because a final page that happens to hold exactly 200 would otherwise
         look like a full one and cost a pointless extra call -- and worse, a
         short page in the middle would stop the walk early. */
      if (res?.page_context?.has_more_page !== true) break;
    }
    return out;
  }

  /**
   * Is there already a record carrying this reference?
   *
   * The answer to the failure nobody can prevent: Zoho created the record and
   * the reply never arrived, so a retry would create a second one. Looking
   * first turns an unknown into either "adopt it" or "create it".
   */
  async findByReference(kind: string, reference: string): Promise<string | null> {
    /* Runs in dry mode as well: it is a read, and letting it answer honestly
       means a dry run exercises the duplicate check rather than skipping it.
       In dry mode nothing was ever posted, so the honest answer is usually
       "no" -- which is the point. */
    try {
      const out = await this.call('GET', `/${kind}`, { query: { reference_number: reference } });
      const list = out?.[kind] ?? [];
      const hit = Array.isArray(list) ? list[0] : null;
      return hit ? (hit[idFieldFor(`/${kind}`)] ?? hit.id ?? null) : null;
    } catch (e: any) {
      /* A failed lookup must not look like "not found", which would licence
         creating a duplicate. Reported as retryable instead. */
      throw new ZohoError(e?.status ?? 0,
        `Could not check whether ${reference} already exists: ${e?.message ?? e}`,
        undefined, true);
    }
  }

  /**
   * What can this token actually see?
   *
   * Asked of `/organizations`, the one call that takes no organisation id, so
   * it answers "whose books am I connected to" rather than "is this
   * organisation reachable".
   *
   * With one caveat that cost an afternoon: `/organizations` needs a scope of
   * its own, and it is not among the module scopes a posting integration
   * otherwise requires. A refusal here therefore means EITHER that the account
   * has no access to Books OR merely that nobody granted the scope for asking
   * -- and those are completely different problems. `diagnose()` below is the
   * one to trust, because it tries the endpoints actually used.
   */
  async whoAmI(): Promise<{
    reachable: boolean;
    organizations: { id: string; name: string; isDefault: boolean }[];
    configuredOrgId: string;
    configuredOrgVisible: boolean;
    message?: string;
  }> {
    const configuredOrgId = config.zoho.organizationId;
    try {
      /* Deliberately not through call(): that attaches organization_id to
         every request, and the point here is to ask without one. */
      const res = await fetch(
        `https://www.zohoapis.${config.zoho.dc || 'com'}/books/v3/organizations`,
        {
          headers: { Authorization: `Zoho-oauthtoken ${await this.tokens.getToken()}` },
          signal: AbortSignal.timeout(20_000),
        });
      const json: any = await res.json().catch(() => ({}));
      const code = Number(json?.code);
      if (!res.ok || (Number.isFinite(code) && code !== 0)) {
        return {
          reachable: false, organizations: [], configuredOrgId,
          configuredOrgVisible: false,
          message: json?.message ?? `Zoho answered ${res.status}`,
        };
      }
      const orgs = (json?.organizations ?? []).map((o: any) => ({
        id: String(o.organization_id),
        name: o.name,
        isDefault: !!o.is_default_org,
      }));
      return {
        reachable: true,
        organizations: orgs,
        configuredOrgId,
        configuredOrgVisible: orgs.some((o) => o.id === configuredOrgId),
      };
    } catch (e: any) {
      return {
        reachable: false, organizations: [], configuredOrgId,
        configuredOrgVisible: false,
        message: e?.message ?? String(e),
      };
    }
  }

  /**
   * One probe per endpoint the integration uses, reporting raw results.
   *
   * Every call is a GET, so nothing is created or changed. The point is to see
   * which calls the granted scopes actually allow -- a scope list can be
   * accepted at grant time with some entries silently dropped, and the only
   * way to know is to try each one.
   */
  async diagnose(): Promise<{
    organizationId: string;
    dataCentre: string;
    mode: string;
    tokenRefreshed: boolean;
    tokenError: string | null;
    probes: ZohoProbe[];
  }> {
    const organizationId = config.zoho.organizationId;
    const dc = config.zoho.dc || 'com';

    let tokenRefreshed = false;
    let token = '';
    let tokenError: string | null = null;
    try {
      token = await this.tokens.getToken();
      tokenRefreshed = true;
    } catch (e: any) {
      tokenError = e?.message ?? String(e);
      return { organizationId, dataCentre: dc, mode: this.mode,
               tokenRefreshed, tokenError, probes: [] };
    }

    const targets: { path: string; what: string; listKey: string; withOrg: boolean }[] = [
      { path: '/organizations', what: 'which books this token can see',
        listKey: 'organizations', withOrg: false },
      { path: '/bankaccounts', what: 'the accounts money is paid from',
        listKey: 'bankaccounts', withOrg: true },
      { path: '/chartofaccounts', what: 'the expense accounts',
        listKey: 'chartofaccounts', withOrg: true },
      { path: '/contacts', what: 'suppliers', listKey: 'contacts', withOrg: true },
      { path: '/expenses', what: 'existing expenses', listKey: 'expenses', withOrg: true },
    ];

    const probes: ZohoProbe[] = [];
    for (const t of targets) {
      const query = new URLSearchParams(t.withOrg ? { organization_id: organizationId } : {});
      const url = `https://www.zohoapis.${dc}/books/v3${t.path}`
        + (query.toString() ? `?${query}` : '');
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
          signal: AbortSignal.timeout(20_000),
        });
        const json: any = await res.json().catch(() => ({}));
        const code = Number(json?.code);
        const list = json?.[t.listKey];
        probes.push({
          endpoint: t.path, what: t.what,
          httpStatus: res.status,
          zohoCode: Number.isFinite(code) ? code : null,
          message: json?.message ?? null,
          rows: Array.isArray(list) ? list.length : null,
          ok: res.ok && (!Number.isFinite(code) || code === 0),
        });
      } catch (e: any) {
        probes.push({
          endpoint: t.path, what: t.what, httpStatus: null, zohoCode: null,
          message: e?.message ?? String(e), rows: null, ok: false,
        });
      }
    }

    return { organizationId, dataCentre: dc, mode: this.mode,
             tokenRefreshed, tokenError: null, probes };
  }
}

/**
 * Try every endpoint the integration needs and report exactly what came back.
 *
 * Written after a diagnosis went wrong. `whoAmI` asks `/organizations`, which
 * needs a scope the posting integration has no other use for -- so a missing
 * scope there was reported as "this account cannot see Zoho Books", sending
 * somebody off to recreate a connection that was fine.
 *
 * This makes no inference at all. It reports the HTTP status, Zoho's own code
 * and message, and how many rows came back, per endpoint. Reading five lines
 * of that is quicker than reasoning about one conclusion that might be wrong.
 */
export interface ZohoProbe {
  endpoint: string;
  what: string;
  httpStatus: number | null;
  zohoCode: number | null;
  message: string | null;
  rows: number | null;
  ok: boolean;
}

function idFieldFor(path: string): string {
  if (path.startsWith('/expenses')) return 'expense_id';
  if (path.startsWith('/vendorpayments')) return 'vendor_payment_id';
  if (path.startsWith('/banktransactions')) return 'transaction_id';
  if (path.startsWith('/purchaseorders')) return 'purchaseorder_id';
  return 'id';
}