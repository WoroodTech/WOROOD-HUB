/**
 * Shopify webhook receipt and application.
 *
 * Five properties of Shopify's delivery drive every decision here:
 *   1. The whole request must be answered within five seconds.
 *   2. Delivery is NOT guaranteed -- reconciliation is the source of truth.
 *   3. Ordering is NOT guaranteed, within or across topics.
 *   4. Duplicates happen.
 *   5. After eight consecutive failures Shopify DELETES the subscription.
 */
import {
  CanActivate, Controller, ExecutionContext, HttpCode, Injectable, Logger,
  Post, Req, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../../common/config';
import { Public } from '../../../common/auth';
import { query, one } from '../../../common/db';
import { ShopContext } from '../analytics/snapshot.service';
import { WebhookProcessor } from './webhook-processor';

// Re-exported so existing imports keep working; the list itself lives in
// topics.ts, which has no dependencies of its own.
export { WEBHOOK_TOPICS } from './topics';

/** GraphQL enum names are not derivable from the topic strings by any
 *  consistent rule -- note ORDERS_CREATE against ORDERS_UPDATED. */
export const TOPIC_ENUMS: Record<string, string> = {
  'orders/create': 'ORDERS_CREATE',
  'orders/updated': 'ORDERS_UPDATED',
  'orders/paid': 'ORDERS_PAID',
  'orders/cancelled': 'ORDERS_CANCELLED',
  'refunds/create': 'REFUNDS_CREATE',
  'customers/create': 'CUSTOMERS_CREATE',
  'customers/update': 'CUSTOMERS_UPDATE',
  'bulk_operations/finish': 'BULK_OPERATIONS_FINISH',
};

@Injectable()
export class ShopifyHmacGuard implements CanActivate {
  private readonly log = new Logger('ShopifyHmac');

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const provided: string = req.headers['x-shopify-hmac-sha256'] || '';
    // The signature covers the RAW body bytes. A body-parser that has already
    // deserialised and re-serialised the payload produces a digest that never
    // matches, and the error does not point at the cause.
    const raw: Buffer = req.rawBody ?? Buffer.from('');

    const secrets = [config.shopify.clientSecret, config.shopify.previousClientSecret]
      .filter(Boolean);

    const ok = secrets.some((secret) => {
      const digest = createHmac('sha256', secret).update(raw).digest('base64');
      const a = Buffer.from(digest);
      const b = Buffer.from(provided);
      // Length check first: timingSafeEqual throws on a length mismatch.
      return a.length === b.length && timingSafeEqual(a, b);
    });

    if (!ok) {
      const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress;
      this.log.warn(`Rejected webhook with bad HMAC from ${ip}`);
      throw new UnauthorizedException('Invalid webhook signature');
    }
    return true;
  }
}

@Controller('sales/webhooks')
export class WebhooksController {
  constructor(private shops: ShopContext, private processor: WebhookProcessor) {}

  /**
   * Does the absolute minimum: verify, record, enqueue, return. No Shopify
   * call, no aggregation, no business logic on this thread. Target is well
   * under 200ms, because a slow endpoint does not degrade -- it loses the
   * subscription.
   */
  @Public()
  @UseGuards(ShopifyHmacGuard)
  @Post('shopify')
  @HttpCode(200)
  async receive(@Req() req: any) {
    const h = req.headers;
    const shop = await this.shops.get();

    // ON CONFLICT DO NOTHING on the unique webhook_id: a duplicate delivery is
    // absorbed by the database rather than reasoned about in code. event_id is
    // stored for correlation only -- one merchant action fans out to several
    // deliveries that share it, so deduplicating on it would drop real events.
    const inserted = await one(
      `INSERT INTO sd_webhook_events
         (shop_id, webhook_id, event_id, topic, shop_domain, api_version, triggered_at, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT (webhook_id) DO NOTHING
       RETURNING id`,
      [shop.id, h['x-shopify-webhook-id'], h['x-shopify-event-id'] ?? null,
       h['x-shopify-topic'], h['x-shopify-shop-domain'] ?? null,
       h['x-shopify-api-version'] ?? null, h['x-shopify-triggered-at'] ?? null,
       JSON.stringify(req.body ?? {})],
    );

    if (inserted) await this.processor.enqueue(inserted.id);
    return { received: true, duplicate: !inserted };
  }
}

export { WebhookProcessor } from './webhook-processor';