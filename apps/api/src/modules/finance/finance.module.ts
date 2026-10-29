/**
 * Finance requests.
 *
 * Phase 1: raising a request and moving it through the approval chain. Money,
 * attachments, the edit chain and Zoho all arrive later and all hang off these
 * same rows.
 *
 * Note what is *not* here: there is no "Purchases" department check anywhere.
 * Authority comes from permissions, so the person who approves purchasing
 * requests is whoever Finance says it is, rather than whoever happens to sit in
 * a department with that name.
 */
import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query,
} from '@nestjs/common';
import { CurrentUser, Permissions, type Principal } from '../../common/auth';
import { registerHubModule } from '../../core/hub-registry';
import { FinanceRequestsService } from './requests.service';
import { FinanceEditsService } from './edits.service';
import { FinanceFilesService } from './files.service';
import { FinancePaymentsService } from './payments.service';
import { ZohoQueueService } from './zoho/zoho-queue.service';
import { ZohoAccountsService } from './zoho/accounts.service';
import { CashFlowService } from './cashflow.service';
import { PurchaseOrdersService } from './zoho/purchase-orders.service';
import { FinanceImportService } from './migration/import.service';
import {
  AddNote, CreateRequest, DecideRequest, ListRequests, RequestEdit,
  CashFlowQuery, DraftPurchaseOrder, RecordPayment, RequestFileUpload,
  ReversePayment, UpdateRequest,
} from './dto';

export const FINANCE_MODULE = registerHubModule({
  key: 'finance',
  name: 'Finance Requests',
  nameAr: 'طلبات المالية',
  version: '1.0.0',
  apiPrefix: '/api/v1/finance',
  tablePrefix: 'fin_',
  enabled: true,
  navigation: [
    /* Raising a request is for everybody: no permission on these two. */
    { label: 'My Requests', labelAr: 'طلباتي', path: '/finance', icon: 'layout-grid' },
    { label: 'New Request', labelAr: 'طلب جديد', path: '/finance/new', icon: 'plus' },
    /* Only for people who can actually decide something: a department manager
       (authority that is a row, not a permission) or Finance or Purchases. An
       ordinary employee has nothing in this queue and should not be shown a
       tab suggesting somebody is waiting on them. */
    { label: 'Approvals', labelAr: 'الموافقات', path: '/finance/approvals', icon: 'check',
      requiresDepartmentManager: true,
      requiresAnyPermission: ['finance.request.manage', 'finance.purchases.decide'] },
    /* One page, two audiences: a department manager sees his department, and
       Finance sees everything. The list is filtered server-side by the same
       visibility rule either way, so the page does not need to know which it
       is showing -- and a manager had no way at all to see his department's
       requests before, which meant an edit reached him only as a bell. */
    { label: 'Cash Flow', labelAr: 'التدفق النقدي', path: '/finance/cash-flow',
      icon: 'trending-up',
      requiresAnyPermission: ['finance.report.view', 'finance.request.manage'] },
    { label: 'To Pay', labelAr: 'للدفع', path: '/finance/pay', icon: 'receipt',
      requiresAnyPermission: ['finance.payment.record'] },
    { label: 'All Requests', labelAr: 'كل الطلبات', path: '/finance/all', icon: 'database',
      requiresDepartmentManager: true,
      requiresAnyPermission: ['finance.request.manage', 'finance.report.view',
                              'finance.purchases.decide'] },
  ],
  portlets: [
    { key: 'finance-approvals', title: 'Waiting for you', titleAr: 'بانتظارك',
      width: 6, order: 3 },
  ],
  permissions: [
    { key: 'finance.request.manage',
      description: 'Edit, reject and administer any finance request' },
    { key: 'finance.purchases.decide',
      description: 'Approve requests routed to Purchases, and classify what lite departments asked for' },
    { key: 'finance.payment.record',
      description: 'Record payments against approved requests' },
    { key: 'finance.report.view',
      description: 'Read finance reports and every request, without being able to change anything' },
  ],
});

@Controller('finance')
export class FinanceController {
  constructor(
    private readonly requests: FinanceRequestsService,
    private readonly edits: FinanceEditsService,
    private readonly files: FinanceFilesService,
    private readonly payments: FinancePaymentsService,
    private readonly zoho: ZohoQueueService,
    private readonly zohoAccounts: ZohoAccountsService,
    private readonly cashflow: CashFlowService,
    private readonly purchaseOrders: PurchaseOrdersService,
    private readonly imports: FinanceImportService,
  ) {}

  /** Everything the new-request form needs: the person's own department, the
   *  bank list, and which fields to show. */
  @Get('request-form')
  requestForm(@CurrentUser() p: Principal) {
    return this.requests.requestForm(p);
  }

  @Get('requests')
  list(@CurrentUser() p: Principal, @Query() q: ListRequests) {
    return this.requests.list(p, q);
  }

  /**
   * Everything waiting for this person: new requests and changes to approved
   * ones, in one answer.
   *
   * They were two endpoints, and the approvals page only read the first -- so
   * a change asked for on an approved request reached its approver as a
   * notification and nowhere else. Anything waiting on somebody belongs in the
   * one place they look.
   */
  @Get('approvals')
  async queue(@CurrentUser() p: Principal) {
    const [requests, edits] = await Promise.all([
      this.requests.approvalsQueue(p),
      this.edits.queue(p),
    ]);
    return { ...requests, edits };
  }

  @Get('requests/:id')
  get(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.requests.get(p, id);
  }

  /* Raising a request needs no permission: every employee may ask for money.
     What happens to the request afterwards is where authority applies. */
  @Post('requests')
  create(@CurrentUser() p: Principal, @Body() dto: CreateRequest) {
    return this.requests.create(p, dto);
  }

  @Post('requests/:id/submit')
  submit(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.requests.submit(p, id);
  }

  @Patch('requests/:id')
  update(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string,
         @Body() dto: UpdateRequest) {
    return this.requests.update(p, id, dto);
  }

  /* One endpoint for all three steps. No @Permissions decorator, deliberately:
     a department manager holds no finance permission, and which step a person
     may take depends on the state the request is in. The service decides, and
     it is the only place that can. */
  @Post('requests/:id/decide')
  decide(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string,
         @Body() dto: DecideRequest) {
    return this.requests.decide(p, id, dto.decision, dto.reason, dto.pricing);
  }

  @Delete('requests/:id')
  remove(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.requests.remove(p, id);
  }

  /* ------------------------------------------------------- changes ----- */
  /* No @Permissions on any of these: asking for a change is for the person who
     raised the request, and deciding one depends on the step it is at --
     a department manager holds no finance permission. The service decides. */

  /** Ask to change a request that has already been approved. */
  @Post('requests/:id/edits')
  requestEdit(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string,
              @Body() dto: RequestEdit) {
    return this.edits.request(p, id, dto);
  }

  @Get('requests/:id/edits')
  editsFor(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.edits.forRequest(p, id);
  }

  /** Changes waiting on this person. */
  @Get('edits')
  editQueue(@CurrentUser() p: Principal) {
    return this.edits.queue(p);
  }

  @Post('edits/:editId/decide')
  decideEdit(@CurrentUser() p: Principal,
             @Param('editId', ParseUUIDPipe) editId: string,
             @Body() dto: DecideRequest) {
    return this.edits.decide(p, editId, dto.decision, dto.reason);
  }

  @Post('edits/:editId/withdraw')
  withdrawEdit(@CurrentUser() p: Principal,
               @Param('editId', ParseUUIDPipe) editId: string) {
    return this.edits.withdraw(p, editId);
  }

  /* -------------------------------------------------------- payments ---- */
  /* Recording a payment needs finance.payment.record, checked in the service
     as well: the decorator is the first gate, not the only one. */

  @Get('payments/outstanding')
  outstanding(@CurrentUser() p: Principal) {
    return this.payments.outstanding(p);
  }

  @Get('requests/:id/payments')
  paymentsFor(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.forRequest(p, id);
  }

  @Post('requests/:id/payments')
  @Permissions('finance.payment.record')
  recordPayment(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string,
                @Body() dto: RecordPayment) {
    return this.payments.record(p, id, dto);
  }

  @Post('payments/:paymentId/reverse')
  @Permissions('finance.payment.record')
  reversePayment(@CurrentUser() p: Principal,
                 @Param('paymentId', ParseUUIDPipe) paymentId: string,
                 @Body() dto: ReversePayment) {
    return this.payments.reverse(p, paymentId, dto.reason);
  }

  /* ------------------------------------------------------- cash flow ---- */
  /* The forecast Finance works from. Behind a permission: it is every
     department's spending on one screen, which is not something a department
     member should see. */

  @Get('cash-flow')
  @Permissions('finance.report.view', 'finance.request.manage')
  cashFlow(@CurrentUser() p: Principal, @Query() q: CashFlowQuery) {
    return this.cashflow.forMonth(p, q.month, q.method ?? 'accurate');
  }

  /** The two methods side by side, for deciding which to adopt. */
  @Get('cash-flow/compare')
  @Permissions('finance.report.view', 'finance.request.manage')
  cashFlowCompare(@CurrentUser() p: Principal, @Query() q: CashFlowQuery) {
    return this.cashflow.compare(p, q.month);
  }

  /* -------------------------------------------------- purchase orders ---- */
  /* A draft purchase order goes into Zoho before a supplier is paid, and the
     payment is recorded as an advance against it. Draft only: approving one
     is a decision taken in Zoho. */

  @Get('vendors')
  @Permissions('finance.purchases.decide', 'finance.request.manage')
  vendors(@CurrentUser() p: Principal) {
    return this.purchaseOrders.vendors(p);
  }

  @Post('vendors/sync')
  @Permissions('finance.request.manage')
  syncVendors(@CurrentUser() p: Principal) {
    return this.purchaseOrders.syncVendors(p);
  }

  /** What this supplier's next reference should be, from their own bills. */
  @Get('vendors/:vendorId/next-reference')
  @Permissions('finance.purchases.decide', 'finance.request.manage')
  nextReference(@CurrentUser() p: Principal, @Param('vendorId') vendorId: string) {
    return this.purchaseOrders.suggestReference(p, vendorId);
  }

  @Get('requests/:id/purchase-order')
  purchaseOrder(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.purchaseOrders.forRequest(p, id);
  }

  @Post('requests/:id/purchase-order')
  @Permissions('finance.purchases.decide', 'finance.request.manage')
  draftPurchaseOrder(@CurrentUser() p: Principal,
                     @Param('id', ParseUUIDPipe) id: string,
                     @Body() dto: DraftPurchaseOrder) {
    return this.purchaseOrders.draft(p, id, dto);
  }

  /**
   * Why no email arrived.
   *
   * There are five separate reasons a notification can be silent, and from the
   * outside they all look identical: the flag is off, the address is missing,
   * SES refuses, the recipient has no permission so was never in the list, or
   * the link would have pointed at localhost. Guessing between them costs an
   * afternoon; this says which.
   *
   * Sends a real email when `to` is given, so the answer is "it arrived" or
   * "SES said this", not "it should work".
   */
  @Get('mail-check')
  @Permissions('finance.request.manage')
  async mailCheck(@CurrentUser() p: Principal, @Query('to') to?: string) {
    return this.requests.mailCheck(p, to);
  }

  /* ------------------------------------------------------- migration ---- */
  /* Reading an export writes nothing live; promoting is the separate step
     that does. Both need finance.request.manage, and nothing here ever writes
     back to the spreadsheet. */

  @Post('migration/read')
  @Permissions('finance.request.manage')
  readImport(@CurrentUser() p: Principal,
             @Body() dto: { sourceName: string; rows: any[] }) {
    return this.imports.read(p, dto.sourceName, dto.rows);
  }

  @Get('migration/:batchId')
  @Permissions('finance.request.manage')
  reviewImport(@CurrentUser() p: Principal,
               @Param('batchId', ParseUUIDPipe) batchId: string) {
    return this.imports.review(p, batchId);
  }

  @Post('migration/:batchId/promote')
  @Permissions('finance.request.manage')
  promoteImport(@CurrentUser() p: Principal,
                @Param('batchId', ParseUUIDPipe) batchId: string,
                @Body() dto: { force?: boolean }) {
    return this.imports.promote(p, batchId, { force: dto?.force });
  }

  @Post('migration/:batchId/discard')
  @Permissions('finance.request.manage')
  discardImport(@CurrentUser() p: Principal,
                @Param('batchId', ParseUUIDPipe) batchId: string) {
    return this.imports.discard(p, batchId);
  }

  /* ------------------------------------------------------------ zoho ---- */
  /* What is stuck, and putting it back. No payload is exposed: the bodies
     carry account ids and supplier details, and an operations screen needs to
     know what failed and why, not what was in it. */

  /**
   * What this Zoho connection can actually see.
   *
   * The first thing to run when something is wrong: it answers "whose books
   * am I connected to", which is the question that distinguishes a wrong
   * organisation id from a token granted by the wrong person -- and those look
   * identical from every other endpoint.
   */
  /**
   * Try every endpoint the integration needs, and report what came back.
   *
   * Read-only, and makes no inference: it shows the HTTP status, Zoho's own
   * code and message, and the row count, per endpoint. The first thing to run
   * when a connection does not behave — one of these lines is always the
   * answer, and none of them is a guess.
   */
  @Get('zoho/diagnose')
  @Permissions('finance.request.manage')
  zohoDiagnose() {
    return this.zohoAccounts.diagnose();
  }

  @Get('zoho/whoami')
  @Permissions('finance.request.manage')
  zohoWhoAmI() {
    return this.zohoAccounts.whoAmI();
  }

  /** The accounts a payment form offers, grouped by what each is for. */
  @Get('zoho/accounts')
  @Permissions('finance.payment.record')
  zohoAccountList() {
    return this.zohoAccounts.forPicker();
  }

  /** Refresh the cache from Zoho. Read-only against Zoho. */
  @Post('zoho/accounts/sync')
  @Permissions('finance.request.manage')
  syncZohoAccounts() {
    return this.zohoAccounts.sync();
  }

  @Get('zoho/health')
  @Permissions('finance.request.manage')
  zohoHealth() {
    return this.zoho.health();
  }

  @Post('zoho/events/:eventId/retry')
  @Permissions('finance.request.manage')
  retryZoho(@CurrentUser() p: Principal,
            @Param('eventId', ParseUUIDPipe) eventId: string) {
    return this.zoho.retry(p, eventId);
  }

  /* ---------------------------------------------------------- files ---- */
  /* Who may upload and who may download is decided in the service: it is
     narrower than who may see the request, because a quotation names a
     supplier and a receipt carries bank details. */

  @Get('requests/:id/files')
  listFiles(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.files.list(p, id);
  }

  @Post('requests/:id/files')
  requestFileUpload(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string,
                    @Body() dto: RequestFileUpload) {
    return this.files.requestUpload(p, id, dto);
  }

  @Post('files/:fileId/confirm')
  confirmFile(@CurrentUser() p: Principal, @Param('fileId', ParseUUIDPipe) fileId: string) {
    return this.files.confirm(p, fileId);
  }

  @Delete('files/:fileId')
  removeFile(@CurrentUser() p: Principal, @Param('fileId', ParseUUIDPipe) fileId: string) {
    return this.files.remove(p, fileId);
  }

  @Post('requests/:id/notes')
  addNote(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string,
          @Body() dto: AddNote) {
    return this.requests.addNote(p, id, dto.body, dto.internal ?? false);
  }
}