import { Module } from '@nestjs/common';
import { CoreModule } from '../../core/core.module';
import './descriptor';                    // side effect: registers the module
import { ShopifyService, TokenManager, CostGovernor } from './shopify/shopify.service';
import { ShopContext, SnapshotService } from './analytics/snapshot.service';
import { MetricsService } from './metrics/metrics.service';
import { AccessService } from './dashboards/access.service';
import { DashboardsController } from './dashboards/dashboards.controller';
import { PortletsController } from './portlets/portlets.controller';
import { WebhooksController, WebhookProcessor } from './webhooks/webhooks';
import { SyncController, SyncService } from './sync/sync.service';
import { BackfillService } from './sync/backfill.service';
import { SalesScheduler } from './sync/scheduler.service';
import { SalesGateway } from './realtime/sales.gateway';

/**
 * Module 2, wired into the application root with two lines. Nothing in the core
 * platform, the meeting-rooms module or the portal shell is edited -- the one
 * exception being permission-gated portlets, which is a core capability this
 * module needed and every later module will want (see hub-registry.ts).
 */
@Module({
  imports: [CoreModule],
  controllers: [DashboardsController, PortletsController, WebhooksController, SyncController],
  providers: [
    TokenManager, CostGovernor, ShopifyService,
    ShopContext, SnapshotService, MetricsService, AccessService,
    WebhookProcessor, SyncService, BackfillService, SalesScheduler, SalesGateway,
  ],
  exports: [ShopContext, SnapshotService, SyncService, BackfillService, MetricsService],
})
export class SalesDashboardModule {}