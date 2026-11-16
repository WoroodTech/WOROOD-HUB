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
import { WarehouseInsightsService } from './insights.service';
import { WarehouseRollsService } from './rolls.service';
import { WarehouseStagesService } from './stages.service';
import { WarehouseQcService } from './qc.service';
import { WarehouseReturnsService } from './returns.service';
import { WarehouseDocumentsService } from './documents.service';
import { WarehouseCostingService } from './costing.service';
import { WarehouseOrdersService } from './orders.service';
import { WarehouseReportsService } from './reports.service';

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
    /* Posting a return movement. The issues screen below is a different
       job that shares the word. */
    { label: 'Returns', labelAr: 'المرتجعات', path: '/warehouse/return', icon: 'list',
      requiresAnyPermission: [WAREHOUSE_PERMISSIONS.TX_WRITE] },
    { label: 'New Orders', labelAr: 'الأوردرات الجديدة', path: '/warehouse/orders', icon: 'list',
      requiresAnyPermission: [WAREHOUSE_PERMISSIONS.TX_WRITE] },
    { label: 'Templates', labelAr: 'القوالب', path: '/warehouse/templates', icon: 'list',
      requiresAnyPermission: [WAREHOUSE_PERMISSIONS.STOCK_VIEW] },
    { label: 'Item Card', labelAr: 'كارت الصنف', path: '/warehouse/item', icon: 'search',
      requiresAnyPermission: [WAREHOUSE_PERMISSIONS.STOCK_VIEW] },
    { label: 'Find / Edit', labelAr: 'بحث / تعديل', path: '/warehouse/find', icon: 'search',
      requiresAnyPermission: [WAREHOUSE_PERMISSIONS.STOCK_VIEW] },
    { label: 'Create new item', labelAr: 'إنشاء صنف', path: '/warehouse/new-item', icon: 'user',
      requiresAnyPermission: [WAREHOUSE_PERMISSIONS.ITEM_MANAGE] },
    { label: 'Rolls', labelAr: 'الرولات', path: '/warehouse/rolls', icon: 'list',
      requiresAnyPermission: [WAREHOUSE_PERMISSIONS.ROLLS_VIEW] },
    { label: 'Quality Check', labelAr: 'فحص الجودة', path: '/warehouse/qc', icon: 'check',
      requiresAnyPermission: [WAREHOUSE_PERMISSIONS.QC_HANDLE] },
    { label: 'Return Issues', labelAr: 'مشاكل المرتجعات', path: '/warehouse/issues',
      icon: 'list', requiresAnyPermission: [WAREHOUSE_PERMISSIONS.RETURNS_HANDLE] },
    { label: 'Patch Log', labelAr: 'سجل الباتشات', path: '/warehouse/patches',
      icon: 'list', requiresAnyPermission: [WAREHOUSE_PERMISSIONS.STOCK_VIEW] },
    { label: 'Reports', labelAr: 'التقارير', path: '/warehouse/reports',
      icon: 'chart', requiresAnyPermission: [WAREHOUSE_PERMISSIONS.REPORT_VIEW] },
    { label: 'Planning', labelAr: 'التخطيط', path: '/warehouse/planning',
      icon: 'chart', requiresAnyPermission: [WAREHOUSE_PERMISSIONS.ROLLS_PLAN] },
    { label: 'QR Label', labelAr: 'ملصق QR', path: '/warehouse/labels',
      icon: 'layout-grid', requiresAnyPermission: [WAREHOUSE_PERMISSIONS.STOCK_VIEW] },
    { label: 'Documents', labelAr: 'المستندات', path: '/warehouse/documents',
      icon: 'list', requiresAnyPermission: [WAREHOUSE_PERMISSIONS.STOCK_VIEW] },
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
    private readonly insights: WarehouseInsightsService,
    private readonly rolls: WarehouseRollsService,
    private readonly stages: WarehouseStagesService,
    private readonly qc: WarehouseQcService,
    private readonly returns: WarehouseReturnsService,
    private readonly docs: WarehouseDocumentsService,
    private readonly costing: WarehouseCostingService,
    private readonly orders: WarehouseOrdersService,
    private readonly reports: WarehouseReportsService,
  ) {}

  /* --------------------------------------------------------- reports -- */

  /** The ranges people open most, so the screen can offer them. */
  @Get('reports/presets')
  @Permissions(WAREHOUSE_PERMISSIONS.REPORT_VIEW)
  reportPresets() { return this.reports.presets(); }

  /** What sold, when, from where, and what came back. */
  @Get('reports')
  @Permissions(WAREHOUSE_PERMISSIONS.REPORT_VIEW)
  report(@Query() q: { from: string; to: string; fresh?: string }) {
    return this.reports.build({ from: q.from, to: q.to }, q.fresh === 'true');
  }

  /* ------------------------------------------------- new orders ----- */

  /** The patch number this one will carry. */
  @Get('orders/next-patch')
  @Permissions(WAREHOUSE_PERMISSIONS.TX_WRITE)
  nextPatch() { return this.orders.nextPatch(); }

  /**
   * One Shopify order and its items.
   *
   * The point of the screen: a reference is typed and the lines arrive,
   * rather than being read off a printed sheet and typed back in.
   */
  @Get('orders/lookup')
  @Permissions(WAREHOUSE_PERMISSIONS.TX_WRITE)
  lookupOrder(@Query('reference') reference: string) {
    return this.orders.lookup(reference);
  }

  /** Post the whole patch — all of it, or none. */
  @Post('orders/patch')
  @Permissions(WAREHOUSE_PERMISSIONS.TX_WRITE)
  postPatch(@CurrentUser() p: Principal, @Body() dto: any) {
    return this.orders.postPatch(p, dto);
  }

  /** The printable sheet for a patch. */
  @Get('orders/template')
  @Permissions(WAREHOUSE_PERMISSIONS.STOCK_VIEW)
  orderTemplate(@Query('patch') patch: string) {
    return this.orders.template(patch);
  }

  /* --------------------------------------------- costing & planning -- */

  /** The planning constants — pieces per metre, and the allowances. */
  @Get('settings')
  @Permissions(WAREHOUSE_PERMISSIONS.ROLLS_PLAN)
  settings() { return this.costing.settings(); }

  /**
   * Admin only, as in the Apps Script: `unitsPerMeter` decides what every
   * open job order is measured against.
   */
  @Post('settings')
  @Permissions(WAREHOUSE_PERMISSIONS.TX_MANAGE)
  setSettings(@CurrentUser() p: Principal, @Body() dto: Record<string, number>) {
    return this.costing.setSettings(p, can(p, 'admin.full'), dto);
  }

  @Get('costs')
  @Permissions(WAREHOUSE_PERMISSIONS.REPORT_VIEW)
  costs() { return this.costing.costs(); }

  @Post('costs')
  @Permissions(WAREHOUSE_PERMISSIONS.TX_MANAGE)
  setCosts(@CurrentUser() p: Principal, @Body() dto: any) {
    return this.costing.setCosts(p, can(p, WAREHOUSE_PERMISSIONS.TX_MANAGE), dto);
  }

  /** Cost per piece for a month, against what it sold for. */
  @Get('costs/report')
  @Permissions(WAREHOUSE_PERMISSIONS.REPORT_VIEW)
  costReport(@Query('month') month?: string) {
    return this.costing.costReport(month);
  }

  /** What to make next, from 26 weeks of sales. */
  @Get('demand')
  @Permissions(WAREHOUSE_PERMISSIONS.ROLLS_PLAN)
  demand(@Query('weeks') weeks?: string) {
    return this.costing.demandPlan(weeks ? Number(weeks) : undefined);
  }

  /* ------------------------------------------------------ QR labels -- */

  /** What goes on each label. The browser renders them. */
  @Post('labels')
  @Permissions(WAREHOUSE_PERMISSIONS.STOCK_VIEW)
  labels(@Body() dto: any) { return this.docs.labels(dto); }

  /* ----------------------------------------------------- documents -- */

  @Get('documents')
  @Permissions(WAREHOUSE_PERMISSIONS.STOCK_VIEW)
  documents(@Query('type') type?: string) {
    return this.docs.documents({ type });
  }

  /**
   * Reserve a serial before printing.
   *
   * The Apps Script leaves this open to anybody signed in, so any account
   * can burn through the Q.C and W.Q counters. Here it needs the permission
   * to post stock, because that is who prints these papers.
   */
  @Post('documents/reserve')
  @Permissions(WAREHOUSE_PERMISSIONS.TX_WRITE)
  reserveDoc(@CurrentUser() p: Principal, @Body() dto: any) {
    return this.docs.reserve(p, dto);
  }

  @Post('documents/printed')
  @Permissions(WAREHOUSE_PERMISSIONS.TX_WRITE)
  recordPrint(@CurrentUser() p: Principal, @Body() dto: { serial: string }) {
    return this.docs.recordPrint(p, dto?.serial);
  }

  @Get('documents/handovers')
  @Permissions(WAREHOUSE_PERMISSIONS.ROLLS_VIEW)
  handovers(@Query('operationOrder') oo?: string) {
    return this.docs.handovers(oo);
  }

  /* --------------------------------------------------- return issues -- */

  @Get('returns')
  @Permissions(WAREHOUSE_PERMISSIONS.RETURNS_HANDLE)
  issues(@Query() q: { status?: string; q?: string }) {
    return this.returns.issues(q);
  }

  /** The red number on the tab. */
  @Get('returns/count')
  @Permissions(WAREHOUSE_PERMISSIONS.RETURNS_HANDLE)
  openIssues() { return this.returns.openCount(); }

  @Post('returns')
  @Permissions(WAREHOUSE_PERMISSIONS.RETURNS_HANDLE)
  logIssue(@CurrentUser() p: Principal, @Body() dto: any) {
    return this.returns.logIssue(p, dto);
  }

  @Post('returns/update')
  @Permissions(WAREHOUSE_PERMISSIONS.RETURNS_HANDLE)
  updateIssue(@CurrentUser() p: Principal, @Body() dto: any) {
    return this.returns.updateIssue(p, dto);
  }

  /* ------------------------------------------------------- patch log -- */

  @Get('patches')
  @Permissions(WAREHOUSE_PERMISSIONS.STOCK_VIEW)
  patches(@Query('status') status?: string) {
    return this.returns.patches({ status });
  }

  @Get('patches/:patch/comments')
  @Permissions(WAREHOUSE_PERMISSIONS.STOCK_VIEW)
  patchComments(@Param('patch') patch: string) {
    return this.returns.comments(decodeURIComponent(patch));
  }

  @Post('patches/comment')
  @Permissions(WAREHOUSE_PERMISSIONS.TX_WRITE)
  patchComment(@CurrentUser() p: Principal,
               @Body() dto: { patch: string; comment: string }) {
    return this.returns.comment(p, dto?.patch, dto?.comment);
  }

  @Post('patches/status')
  @Permissions(WAREHOUSE_PERMISSIONS.TX_WRITE)
  patchStatus(@CurrentUser() p: Principal,
              @Body() dto: { patch: string; status: 'Open' | 'Closed' }) {
    return this.returns.setPatchStatus(p, dto?.patch, dto?.status);
  }

  /* ------------------------------------------------- quality check -- */

  /**
   * The batches this person may see.
   *
   * Two cycles share the tab — Q.C for Worood Quality, W.Q for Workshop
   * Quality — and each team sees its own. Managers see both.
   */
  @Get('qc')
  @Permissions(WAREHOUSE_PERMISSIONS.QC_HANDLE)
  qcBatches(@Query('cycle') cycle?: string) {
    const c = cycle === 'Q' || cycle === 'W' ? cycle : 'A';
    return this.qc.batches(c);
  }

  @Get('qc/:serial')
  @Permissions(WAREHOUSE_PERMISSIONS.QC_HANDLE)
  qcBatch(@Param('serial') serial: string) {
    return this.qc.batch(decodeURIComponent(serial));
  }

  /** Quality counts what arrived. */
  @Post('qc/receive')
  @Permissions(WAREHOUSE_PERMISSIONS.QC_HANDLE)
  qcReceive(@CurrentUser() p: Principal, @Body() dto: any) {
    return this.qc.receive(p, dto);
  }

  /** Quality hands pieces back. Nothing reaches the ledger yet. */
  @Post('qc/hand-back')
  @Permissions(WAREHOUSE_PERMISSIONS.QC_HANDLE)
  qcHandBack(@CurrentUser() p: Principal, @Body() dto: any) {
    return this.qc.handBack(p, dto);
  }

  @Post('qc/recall')
  @Permissions(WAREHOUSE_PERMISSIONS.QC_HANDLE)
  qcRecall(@CurrentUser() p: Principal,
           @Body() dto: { serial: string; round: number; reason?: string }) {
    return this.qc.recall(p, dto?.serial, dto?.round, dto?.reason);
  }

  /**
   * The warehouse keeper counts and confirms. This is where stock moves —
   * which is why it needs the warehouse's permission, not quality's.
   */
  @Post('qc/confirm')
  @Permissions(WAREHOUSE_PERMISSIONS.TX_WRITE)
  qcConfirm(@CurrentUser() p: Principal, @Body() dto: any) {
    return this.qc.confirm(p, dto);
  }

  @Post('qc/short')
  @Permissions(WAREHOUSE_PERMISSIONS.QC_HANDLE)
  qcShort(@CurrentUser() p: Principal, @Body() dto: any) {
    return this.qc.markShort(p, dto);
  }

  /* ------------------------------------------------ workshop stages -- */

  /** One job order's whole workshop picture: cutting, lots, totals. */
  @Get('rolls/jobs/:oo/stages')
  @Permissions(WAREHOUSE_PERMISSIONS.ROLLS_VIEW)
  stageOverview(@Param('oo') oo: string) {
    return this.stages.overview(decodeURIComponent(oo));
  }

  @Post('stages/cut/start')
  @Permissions(WAREHOUSE_PERMISSIONS.ROLLS_REPORT)
  startCutting(@CurrentUser() p: Principal, @Body() dto: { operationOrder: string }) {
    return this.stages.startCutting(p, dto?.operationOrder);
  }

  @Post('stages/cut/lot')
  @Permissions(WAREHOUSE_PERMISSIONS.ROLLS_REPORT)
  releaseLot(@CurrentUser() p: Principal, @Body() dto: any) {
    return this.stages.releaseLot(p, dto);
  }

  @Post('stages/cut/end')
  @Permissions(WAREHOUSE_PERMISSIONS.ROLLS_REPORT)
  endCutting(@CurrentUser() p: Principal, @Body() dto: { operationOrder: string }) {
    return this.stages.endCutting(p, dto?.operationOrder);
  }

  @Post('stages/production/send')
  @Permissions(WAREHOUSE_PERMISSIONS.ROLLS_REPORT)
  sendToQuality(@CurrentUser() p: Principal, @Body() dto: any) {
    return this.stages.sendToQuality(p, dto);
  }

  /** Workshop quality's count, and the difference it produces. */
  @Post('stages/quality/count')
  @Permissions(WAREHOUSE_PERMISSIONS.QC_HANDLE)
  countLot(@CurrentUser() p: Principal, @Body() dto: any) {
    return this.stages.count(p, dto);
  }

  @Post('stages/quality/handover')
  @Permissions(WAREHOUSE_PERMISSIONS.QC_HANDLE)
  handOver(@CurrentUser() p: Principal, @Body() dto: any) {
    return this.stages.handOver(p, dto);
  }

  /* ---------------------------------------------------------- rolls -- */

  @Get('rolls')
  @Permissions(WAREHOUSE_PERMISSIONS.ROLLS_VIEW)
  rollsList(@Query() q: { status?: string; operationOrder?: string }) {
    return this.rolls.rolls(q);
  }

  @Get('rolls/jobs')
  @Permissions(WAREHOUSE_PERMISSIONS.ROLLS_VIEW)
  jobOrders(@Query('status') status?: string) {
    return this.rolls.jobOrders({ status });
  }

  @Get('rolls/jobs/:oo/batches')
  @Permissions(WAREHOUSE_PERMISSIONS.ROLLS_VIEW)
  batches(@Param('oo') oo: string) {
    return this.rolls.batches(decodeURIComponent(oo));
  }

  /* Each step is a different part of the business, so each has its own
     permission rather than one that opens the whole cycle. */

  @Post('rolls/receive')
  @Permissions(WAREHOUSE_PERMISSIONS.ROLLS_RECEIVE)
  receiveRoll(@CurrentUser() p: Principal, @Body() dto: any) {
    return this.rolls.receive(p, dto);
  }

  @Post('rolls/plan')
  @Permissions(WAREHOUSE_PERMISSIONS.ROLLS_PLAN)
  planRoll(@CurrentUser() p: Principal, @Body() dto: any) {
    return this.rolls.plan(p, dto);
  }

  @Post('rolls/issue')
  @Permissions(WAREHOUSE_PERMISSIONS.ROLLS_RECEIVE)
  issueRolls(@CurrentUser() p: Principal, @Body() dto: any) {
    return this.rolls.issue(p, dto);
  }

  /** The workshop's own step. */
  @Post('rolls/report')
  @Permissions(WAREHOUSE_PERMISSIONS.ROLLS_REPORT)
  reportProduction(@CurrentUser() p: Principal, @Body() dto: any) {
    return this.rolls.report(p, dto);
  }

  @Post('rolls/receive-batch')
  @Permissions(WAREHOUSE_PERMISSIONS.ROLLS_RECEIVE)
  receiveBatch(@CurrentUser() p: Principal, @Body() dto: any) {
    return this.rolls.receiveBatch(p, dto);
  }

  /** Closing is a manager's call: it is the step that cannot be undone. */
  @Post('rolls/close')
  @Permissions(WAREHOUSE_PERMISSIONS.TX_MANAGE)
  closeJob(@CurrentUser() p: Principal, @Body() dto: { operationOrder: string; note?: string }) {
    return this.rolls.close(p, dto?.operationOrder, dto?.note);
  }

  /* ------------------------------------------------------- insights -- */

  /** Each warehouse broken down by what is inside it, with shares. */
  @Get('dashboard/warehouses')
  @Permissions(WAREHOUSE_PERMISSIONS.STOCK_VIEW)
  warehouseDetail() { return this.insights.warehouseDetail(); }

  /** One item as a card per warehouse, for the search box. */
  @Get('dashboard/find')
  @Permissions(WAREHOUSE_PERMISSIONS.STOCK_VIEW)
  findItem(@Query('item') item: string) {
    if (!String(item ?? '').trim()) {
      throw new BadRequestException('Which item?');
    }
    return this.insights.findItem(item);
  }

  /** How long the sellable stock lasts at the last week's pace. */
  @Get('dashboard/run-out')
  @Permissions(WAREHOUSE_PERMISSIONS.STOCK_VIEW)
  runOut() { return this.insights.runOutForecast(); }

  /** Stock by collection, optionally within one warehouse. */
  @Get('dashboard/collections')
  @Permissions(WAREHOUSE_PERMISSIONS.STOCK_VIEW)
  collections(@Query('warehouse') warehouse?: string) {
    return this.insights.byCollection(warehouse || undefined);
  }

  /** The items with the most pieces sitting in WH-04. */
  @Get('dashboard/defects')
  @Permissions(WAREHOUSE_PERMISSIONS.STOCK_VIEW)
  defects() { return this.insights.mostDefects(); }

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

  /** The serial a receiving would get, so the form can show it. */
  @Get('next-serial')
  @Permissions(WAREHOUSE_PERMISSIONS.TX_WRITE)
  nextSerial(@Query('type') type: string) { return this.txs.nextSerial(type); }

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
    WarehouseDashboardService, WarehouseItemsService, WarehouseInsightsService,
    WarehouseRollsService, WarehouseStagesService, WarehouseQcService,
    WarehouseReturnsService, WarehouseDocumentsService, WarehouseCostingService,
    WarehouseOrdersService, WarehouseReportsService,
  ],
  exports: [
    WarehouseSheetClient, WarehouseReaderService, WarehouseQueueService,
    WarehouseTransactionsService, WarehouseApprovalsService,
  ],
})
export class WarehouseModule {}