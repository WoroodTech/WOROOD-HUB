/**
 * The Warehouse module.
 *
 * Every route is permission-gated, and the gate is an allow-list: a route
 * with no `@Permissions` is unreachable rather than open. The Apps Script's
 * `gate_()` deny-lists two roles instead, which is how an action added later
 * can be reachable by a role never meant to have it.
 *
 * Nothing here catches an error and discards it. The Apps Script has
 * seventy-three empty `catch` blocks, and the cost of that pattern is already
 * known in this portal: an approval column sat empty for a month because the
 * query that filled it failed into one.
 */
import {
  BadRequestException, Body, Controller, Get, Module, Param, ParseUUIDPipe,
  Post, Query,
} from '@nestjs/common';
import { CurrentUser, Permissions, Principal, can } from '../../common/auth';
import { registerHubModule } from '../../core/hub-registry';
import { CoreModule } from '../../core/core.module';
import { WarehouseSheetClient } from './sheets/warehouse-sheet.client';
import { WarehouseReaderService } from './sheets/warehouse-reader.service';
import { WarehouseQueueService } from './sheets/warehouse-queue.service';
import { WarehouseWorker } from './sheets/warehouse-worker';
import { WarehouseTransactionsService, PostInput } from './transactions.service';
import { WarehouseApprovalsService } from './approvals.service';
import { WarehouseDashboardService } from './dashboard.service';
import { WarehouseItemsService, CreateItemInput } from './items.service';

export const WAREHOUSE_PERMISSIONS = {
  VIEW: 'warehouse.view',
  STOCK_VIEW: 'warehouse.stock.view',
  TX_WRITE: 'warehouse.tx.write',
  TX_MANAGE: 'warehouse.tx.manage',
  APPROVAL_DECIDE: 'warehouse.approval.decide',
  ITEM_MANAGE: 'warehouse.item.manage',
  ROLLS_VIEW: 'warehouse.rolls.view',
  ROLLS_RECEIVE: 'warehouse.rolls.receive',
  ROLLS_PLAN: 'warehouse.rolls.plan',
  ROLLS_REPORT: 'warehouse.rolls.report',
  QC_HANDLE: 'warehouse.qc.handle',
  RETURNS_HANDLE: 'warehouse.returns.handle',
  REPORT_VIEW: 'warehouse.report.view',
} as const;

registerHubModule({
  key: 'warehouse',
  name: 'Warehouse',
  nameAr: 'المخزن',
  version: '1.0.0',
  apiPrefix: 'warehouse',
  tablePrefix: 'wh_',
  enabled: true,
  navigation: [
    /*
     * Grouped by the job somebody does, not by the shape of the data.
     *
     * Each entry appears only for a role that can use it — and is refused by
     * the API as well. The screen being hidden is a convenience; the server
     * is what decides.
     */
    { label: 'Warehouse', labelAr: 'المخزن', path: '/warehouse', icon: 'layout-grid',
      requiresAnyPermission: [WAREHOUSE_PERMISSIONS.VIEW] },
    { label: 'Receiving', labelAr: 'الاستلام', path: '/warehouse/receiving', icon: 'down',
      requiresAnyPermission: [WAREHOUSE_PERMISSIONS.TX_WRITE] },
    { label: 'Transfer', labelAr: 'التحويل', path: '/warehouse/transfer', icon: 'list',
      requiresAnyPermission: [WAREHOUSE_PERMISSIONS.TX_WRITE] },
    { label: 'Returns', labelAr: 'المرتجعات', path: '/warehouse/returns', icon: 'list',
      requiresAnyPermission: [WAREHOUSE_PERMISSIONS.TX_WRITE] },
    { label: 'New Orders', labelAr: 'الأوردرات الجديدة', path: '/warehouse/orders', icon: 'list',
      requiresAnyPermission: [WAREHOUSE_PERMISSIONS.TX_WRITE] },
    { label: 'Item Card', labelAr: 'كارت الصنف', path: '/warehouse/item', icon: 'search',
      requiresAnyPermission: [WAREHOUSE_PERMISSIONS.STOCK_VIEW] },
    { label: 'Find / Edit', labelAr: 'بحث / تعديل', path: '/warehouse/find', icon: 'search',
      requiresAnyPermission: [WAREHOUSE_PERMISSIONS.STOCK_VIEW] },
    { label: 'Create new item', labelAr: 'إنشاء صنف', path: '/warehouse/new-item', icon: 'user',
      requiresAnyPermission: [WAREHOUSE_PERMISSIONS.ITEM_MANAGE] },
    { label: 'Approvals', labelAr: 'الموافقات', path: '/warehouse/approvals', icon: 'check',
      requiresAnyPermission: [WAREHOUSE_PERMISSIONS.APPROVAL_DECIDE] },
  ],

  /* Nothing on anybody's home screen yet. The dashboard tiles come with
     phase 2, and an empty portlet would be a box saying nothing. */
  portlets: [],

  /* Declared here as well as granted in 0047, so the Roles screen can list
     them with a description somebody can act on rather than a bare key. */
  permissions: [
    { key: WAREHOUSE_PERMISSIONS.VIEW, description: 'Open the warehouse and see the item catalogue' },
    { key: WAREHOUSE_PERMISSIONS.STOCK_VIEW, description: 'See balances and open an item card' },
    { key: WAREHOUSE_PERMISSIONS.TX_WRITE, description: 'Post a stock movement' },
    { key: WAREHOUSE_PERMISSIONS.TX_MANAGE, description: 'Post Open Balance and Shortage & Over, and edit the ledger directly' },
    { key: WAREHOUSE_PERMISSIONS.APPROVAL_DECIDE, description: 'Decide an edit or delete request' },
    { key: WAREHOUSE_PERMISSIONS.ITEM_MANAGE, description: 'Create an item and edit its details' },
    { key: WAREHOUSE_PERMISSIONS.ROLLS_VIEW, description: 'See the rolls register and job orders' },
    { key: WAREHOUSE_PERMISSIONS.ROLLS_RECEIVE, description: 'Receive, issue, deliver and reconcile rolls' },
    { key: WAREHOUSE_PERMISSIONS.ROLLS_PLAN, description: 'Plan and prioritise rolls' },
    { key: WAREHOUSE_PERMISSIONS.ROLLS_REPORT, description: 'Report production from the workshop' },
    { key: WAREHOUSE_PERMISSIONS.QC_HANDLE, description: 'Run the quality-check chain of custody' },
    { key: WAREHOUSE_PERMISSIONS.RETURNS_HANDLE, description: 'Log and resolve return issues' },
    { key: WAREHOUSE_PERMISSIONS.REPORT_VIEW, description: 'Run movement, top-seller and demand reports' },
  ],
});

@Controller('warehouse')
export class WarehouseController {
  constructor(
    private readonly reader: WarehouseReaderService,
    private readonly queue: WarehouseQueueService,
    private readonly txs: WarehouseTransactionsService,
    private readonly approvals: WarehouseApprovalsService,
    private readonly sheet: WarehouseSheetClient,
    private readonly dashboard: WarehouseDashboardService,
    private readonly itemsSvc: WarehouseItemsService,
  ) {}

  /* ---------------------------------------------------------- items -- */

  /** What the create-item form offers, and what is already in use. */
  @Get('items/options')
  @Permissions(WAREHOUSE_PERMISSIONS.ITEM_MANAGE)
  itemOptions() { return this.itemsSvc.options(); }

  /** What the sheet would compute, without creating anything. */
  @Post('items/preview')
  @Permissions(WAREHOUSE_PERMISSIONS.ITEM_MANAGE)
  previewItem(@Body() dto: CreateItemInput) { return this.itemsSvc.preview(dto); }

  @Post('items')
  @Permissions(WAREHOUSE_PERMISSIONS.ITEM_MANAGE)
  createItem(@CurrentUser() p: Principal, @Body() dto: CreateItemInput) {
    return this.itemsSvc.create(p, dto);
  }

  /* ----------------------------------------------------- dashboard -- */

  /** The four tiles, with the negative balances listed rather than counted. */
  @Get('dashboard/tiles')
  @Permissions(WAREHOUSE_PERMISSIONS.STOCK_VIEW)
  tiles() { return this.dashboard.tiles(); }

  /**
   * The charts, in the shapes the portal's own chart components take.
   *
   * One route rather than four: the screen draws them together, and four
   * round trips for one view is three too many.
   */
  @Get('dashboard/charts')
  @Permissions(WAREHOUSE_PERMISSIONS.STOCK_VIEW)
  async charts(@Query('warehouse') warehouse?: string) {
    const [trend, byWarehouse, byLocation, low] = await Promise.all([
      this.dashboard.movementTrend(),
      this.dashboard.stockByWarehouse(),
      warehouse ? this.dashboard.stockByLocation(warehouse) : Promise.resolve(null),
      this.dashboard.runningLow(),
    ]);
    return { trend, byWarehouse, byLocation, low };
  }

  /* ----------------------------------------------------- reference -- */

  /** The item catalogue, for the pickers. */
  @Get('items')
  @Permissions(WAREHOUSE_PERMISSIONS.VIEW)
  items() { return this.reader.items(); }

  /** Warehouses and the locations inside each. */
  @Get('warehouses')
  @Permissions(WAREHOUSE_PERMISSIONS.VIEW)
  warehouses() { return this.reader.warehouses(); }

  /** The nine kinds of movement, with what each one needs. */
  @Get('types')
  @Permissions(WAREHOUSE_PERMISSIONS.TX_WRITE)
  types() { return this.txs.types(); }

  /** The colour, kind and material tables an item code is built from. */
  @Get('coding')
  @Permissions(WAREHOUSE_PERMISSIONS.ITEM_MANAGE)
  coding() { return this.reader.codingTables(); }

  /* -------------------------------------------------------- stock -- */

  @Get('balances')
  @Permissions(WAREHOUSE_PERMISSIONS.STOCK_VIEW)
  balances() { return this.reader.balances(); }

  /** One item, everywhere it sits. */
  @Get('item/:name/balances')
  @Permissions(WAREHOUSE_PERMISSIONS.STOCK_VIEW)
  itemBalances(@Param('name') name: string) {
    return this.reader.itemBalances(decodeURIComponent(name));
  }

  @Get('movements')
  @Permissions(WAREHOUSE_PERMISSIONS.STOCK_VIEW)
  movements(@Query() q: {
    item?: string; warehouse?: string; kind?: string;
    order?: string; patch?: string; limit?: string;
  }) {
    return this.reader.movements({
      item: q.item, warehouse: q.warehouse, kind: q.kind,
      order: q.order, patch: q.patch,
      limit: q.limit ? Number(q.limit) : undefined,
    });
  }

  /* ------------------------------------------------------ posting -- */

  /**
   * Post a movement.
   *
   * `warehouse.tx.manage` is read here and passed down rather than checked
   * inside the service, so the two permissions stay visible together: one
   * opens the route, the other opens the two kinds that can move a balance
   * with nothing physical behind them.
   */
  @Post('post')
  @Permissions(WAREHOUSE_PERMISSIONS.TX_WRITE)
  post(@CurrentUser() p: Principal, @Body() dto: PostInput) {
    if (!dto || typeof dto !== 'object') {
      throw new BadRequestException('Nothing to post.');
    }
    return this.txs.post(p, dto, can(p, WAREHOUSE_PERMISSIONS.TX_MANAGE));
  }

  /* ---------------------------------------------------- approvals -- */

  /**
   * Ask for a row to be changed or removed.
   *
   * Open to anybody who can post: correcting your own mistake is part of
   * posting. What is gated is deciding, below.
   */
  @Post('approvals')
  @Permissions(WAREHOUSE_PERMISSIONS.TX_WRITE)
  requestChange(@CurrentUser() p: Principal, @Body() dto: {
    kind: 'EDIT' | 'DELETE';
    rowNumber: number;
    changes?: Record<string, string | number>;
    reason?: string;
  }) {
    return this.approvals.request(p, dto);
  }

  @Get('approvals')
  @Permissions(WAREHOUSE_PERMISSIONS.APPROVAL_DECIDE)
  pendingApprovals() { return this.approvals.pending(); }

  @Post('approvals/:id/decide')
  @Permissions(WAREHOUSE_PERMISSIONS.APPROVAL_DECIDE)
  decide(@CurrentUser() p: Principal,
         @Param('id', ParseUUIDPipe) id: string,
         @Body() dto: { approve: boolean; note?: string }) {
    return this.approvals.decide(p, id, !!dto?.approve, dto?.note);
  }

  /* -------------------------------------------------------- health -- */

  /**
   * Whether movements are reaching the sheet.
   *
   * Worth its own screen: the queue holding is invisible otherwise — posting
   * keeps working, and nothing says the sheet has stopped receiving.
   */
  @Get('sheet/health')
  @Permissions(WAREHOUSE_PERMISSIONS.TX_MANAGE)
  sheetHealth() { return this.queue.health(); }

  /** Drop the cached reads, so the next request goes to the sheet. */
  @Post('sheet/refresh')
  @Permissions(WAREHOUSE_PERMISSIONS.STOCK_VIEW)
  async refresh() {
    await this.reader.invalidate();
    return { ok: true };
  }
}

@Module({
  imports: [CoreModule],
  controllers: [WarehouseController],
  providers: [
    WarehouseSheetClient, WarehouseReaderService, WarehouseQueueService,
    WarehouseWorker, WarehouseTransactionsService, WarehouseApprovalsService,
    WarehouseDashboardService, WarehouseItemsService,
  ],
  exports: [
    WarehouseSheetClient, WarehouseReaderService, WarehouseQueueService,
    WarehouseTransactionsService, WarehouseApprovalsService,
  ],
})
export class WarehouseModule {}