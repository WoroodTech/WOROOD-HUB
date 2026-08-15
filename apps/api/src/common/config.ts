// Side-effect import: fills process.env from .env when nothing else has, so a
// local run behaves like a systemd run. Must precede every read below.
import './load-env';

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgresql://worood:worood_dev@127.0.0.1:5432/worood_hub',
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-only-access-secret-change-me',
    // Short by design. Authorisation that changes often -- which sales
    // dashboards an individual has -- is resolved from PostgreSQL per request
    // and never carried in the token, so unassignment needs no logout.
    accessTtlSeconds: parseInt(process.env.JWT_ACCESS_TTL || '900', 10),
    refreshTtlDays: parseInt(process.env.JWT_REFRESH_TTL_DAYS || '30', 10),
  },

  security: {
    bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '12', 10),
    maxFailedLogins: 5,
    lockoutMinutes: 15,
  },

  shopify: {
    shopDomain: process.env.SHOPIFY_SHOP_DOMAIN || 'worood-designs.myshopify.com',
    apiVersion: process.env.SHOPIFY_API_VERSION || '2026-07',
    clientId: process.env.SHOPIFY_CLIENT_ID || '',
    // Doubles as the webhook HMAC key. This is NOT the access token; confusing
    // the two produces a signature that never verifies and an error that does
    // not point at the cause.
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET || 'dev-webhook-secret',
    // Accepted alongside clientSecret during rotation: Shopify can take up to
    // an hour to start signing with a newly rotated secret.
    previousClientSecret: process.env.SHOPIFY_PREVIOUS_CLIENT_SECRET || '',
    // 'client_credentials' | 'offline' | 'fixture'
    tokenStrategy: process.env.SHOPIFY_TOKEN_STRATEGY || 'fixture',
    offlineAccessToken: process.env.SHOPIFY_OFFLINE_TOKEN || '',
    /** Advanced plan. Configuration, so a plan change is an edit not a defect. */
    costRestoreRate: parseInt(process.env.SHOPIFY_COST_RESTORE_RATE || '200', 10),
    fixtureDir: process.env.SHOPIFY_FIXTURE_DIR ||
      require('node:path').join(__dirname, '../../../../fixtures/shopify'),
  },

  sync: {
    reconcileIntervalMinutes: parseInt(process.env.RECONCILE_MINUTES || '15', 10),
    reconcileOverlapMinutes: 5,
    rawPayloadRetentionDays: parseInt(process.env.RAW_PAYLOAD_RETENTION_DAYS || '30', 10),
    /** Purpose-bound. Shopify sets no maximum; this is Worood's policy value. */
    customerPiiRetentionDays: parseInt(process.env.PII_RETENTION_DAYS || '540', 10),
    /** A dashboard older than this shows a banner instead of a stale figure. */
    staleAfterMinutes: parseInt(process.env.STALE_AFTER_MINUTES || '180', 10),
  },

  portalOrigin: process.env.PORTAL_ORIGIN || 'http://localhost:5173',
};
