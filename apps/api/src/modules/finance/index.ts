import { Module } from '@nestjs/common';
import { CoreModule } from '../../core/core.module';
import { FinanceController, FINANCE_MODULE } from './finance.module';
import { FinanceRequestsService } from './requests.service';
import { FinanceEditsService } from './edits.service';
import { FinanceFilesService } from './files.service';
import { FinancePaymentsService } from './payments.service';
import { ZohoBooksClient, ZohoTokenManager } from './zoho/books-client';
import { ZohoQueueService } from './zoho/zoho-queue.service';
import { ZohoWorker } from './zoho/zoho-worker';
import { ZohoAccountsService } from './zoho/accounts.service';
import { CashFlowService } from './cashflow.service';
import { PurchaseOrdersService } from './zoho/purchase-orders.service';
import { FinanceImportService } from './migration/import.service';

export { FINANCE_MODULE };

@Module({
  imports: [CoreModule],
  controllers: [FinanceController],
  providers: [FinanceRequestsService, FinanceEditsService, FinanceFilesService,
             FinancePaymentsService, ZohoTokenManager, ZohoBooksClient,
             ZohoQueueService, ZohoWorker, ZohoAccountsService, CashFlowService, PurchaseOrdersService, FinanceImportService],
  exports: [FinanceRequestsService, FinanceEditsService, FinanceFilesService,
           FinancePaymentsService, ZohoQueueService, ZohoWorker, ZohoAccountsService, CashFlowService, PurchaseOrdersService, FinanceImportService],
})
export class FinanceModule {}