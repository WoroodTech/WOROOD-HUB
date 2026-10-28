/**
 * What the finance API accepts.
 *
 * The rules here are the ones a person could get wrong by typing. Anything that
 * depends on the state of a row -- whether this request may still be edited,
 * whether this person may decide it -- is checked in the service, because a DTO
 * cannot see the database and a check in two places drifts.
 */
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID,
  Max, MaxLength, Min, MinLength,
  ArrayMaxSize, IsArray, Matches, ValidateNested,
} from 'class-validator';

/**
 * Raising a request.
 *
 * Almost everything is optional here and required in `request-form.ts`
 * instead, because what a request must contain depends on where it is going:
 * one bound for Purchases carries no amount, no type and no transfer details,
 * whoever is asking. A DTO cannot see the route, so making these required
 * would reject the Purchases form before the real rules ever ran.
 *
 * There is no departmentId: a request is always for the requester's own
 * department, as it is in the legacy app, where each department has its own
 * page and no way to reach another's.
 *
 * The lengths are the legacy limits -- what the sheet columns and the emails
 * were sized for.
 */
export class CreateRequest {
  @IsOptional() @IsString() @MaxLength(80) type?: string;

  @IsString() @MinLength(1) @MaxLength(300) description!: string;
  @IsOptional() @IsString() @MaxLength(1000) moreDetails?: string;

  @IsDateString() dueDate!: string;

  /* The upper bound is a typo guard rather than a policy: a request for a
     thousand million is a slipped keyboard. */
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0) @Max(1_000_000_000) requestedAmount?: number;

  @IsOptional() @IsString() @MaxLength(60) paymentMethod?: string;
  /** The wallet, InstaPay or account number. */
  @IsOptional() @IsString() @MaxLength(200) accountNumber?: string;
  @IsOptional() @IsString() @MaxLength(120) bankName?: string;
  @IsOptional() @IsString() @MaxLength(100) beneficiaryName?: string;

  /** Only meaningful for a `choice` department; ignored elsewhere. */
  @IsOptional() @IsBoolean() sendToPurchases?: boolean;

  /** false keeps it as a draft, so a long request can be finished later. */
  @IsOptional() @IsBoolean() submit?: boolean;
}

export class UpdateRequest {
  @IsOptional() @IsString() @MaxLength(80) type?: string;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(2000) description?: string;
  @IsOptional() @IsString() @MaxLength(4000) moreDetails?: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01) @Max(100_000_000) requestedAmount?: number;
  @IsOptional() @IsString() @MaxLength(60) paymentMethod?: string;
  @IsOptional() @IsString() @MaxLength(400) paymentDetails?: string;
}

/**
 * What Purchases supplies when it approves a request routed to it.
 *
 * Required at that step and ignored at the others: a request arrives at
 * Purchases with no amount, no type and no transfer details, and must leave it
 * carrying all three or Finance has nothing to pay.
 */
export class PurchasePricing {
  @IsOptional() @IsString() @MaxLength(80) type?: string;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01) @Max(1_000_000_000) requestedAmount?: number;
  @IsOptional() @IsString() @MaxLength(200) vendorName?: string;
  @IsOptional() @IsString() @MaxLength(60) paymentMethod?: string;
  @IsOptional() @IsString() @MaxLength(200) accountNumber?: string;
  @IsOptional() @IsString() @MaxLength(120) bankName?: string;
  @IsOptional() @IsString() @MaxLength(100) beneficiaryName?: string;
}

export class DecideRequest {
  @IsIn(['APPROVED', 'REJECTED']) decision!: 'APPROVED' | 'REJECTED';

  /** Only read at the Purchases step. */
  @IsOptional() @ValidateNested() @Type(() => PurchasePricing) pricing?: PurchasePricing;

  /* Required for a rejection, in the service: being told no without being told
     why is the complaint the legacy app generated most. */
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}

export class RequestFileUpload {
  @IsString() @MaxLength(200) name!: string;
  /* A claim, checked against the file's own first bytes after it arrives. */
  @IsString() @MaxLength(100) type!: string;
  @Type(() => Number) @IsInt() @Min(1) size!: number;
  @IsOptional() @IsIn(['ATTACHMENT', 'RECEIPT']) kind?: 'ATTACHMENT' | 'RECEIPT';
}

export class AddNote {
  @IsString() @MinLength(1) @MaxLength(2000) body!: string;
  /** Finance and Purchases only; checked in the service. */
  @IsOptional() @IsBoolean() internal?: boolean;
}

export class ListRequests {
  /* Boolean("false") is true, so Type(() => Boolean) would read ?mine=false as
     a request for somebody's own list. A query string carries words, and only
     the word "true" means true. */
  @IsOptional() @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  mine?: boolean;
  @IsOptional() @IsUUID('4') departmentId?: string;
  @IsOptional() @IsIn(['open', 'approved', 'rejected']) state?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

/**
 * Asking to change an approved request.
 *
 * Every field is optional except the reason: an edit says what should be
 * different, and leaving something out means leaving it alone. The reason is
 * required because somebody is being asked to agree to a different number and
 * needs to know what changed about the world.
 */
export class RequestEdit {
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01) @Max(1_000_000_000) newAmount?: number;

  @IsOptional() @IsString() @MaxLength(300) newDescription?: string;
  @IsOptional() @IsString() @MaxLength(1000) newMoreDetails?: string;
  @IsOptional() @IsDateString() newDueDate?: string;
  @IsOptional() @IsString() @MaxLength(60) newPaymentMethod?: string;
  @IsOptional() @IsString() @MaxLength(200) newAccountNumber?: string;
  @IsOptional() @IsString() @MaxLength(120) newBankName?: string;
  @IsOptional() @IsString() @MaxLength(100) newBeneficiaryName?: string;

  @IsString() @MinLength(1) @MaxLength(1000) reason!: string;
}

/**
 * Recording a payment.
 *
 * `idempotencyKey` is generated by the browser for each attempt, so a double
 * click or a retry after a timeout carries the same key and becomes one
 * payment rather than two. It is required: a payment endpoint without one is
 * a double-payment waiting for a slow network.
 */
export class RecordPayment {
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01) @Max(1_000_000_000) amount!: number;

  @IsOptional() @IsDateString() paidAt?: string;
  @IsOptional() @IsString() @MaxLength(200) reference?: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsOptional() @IsUUID('4') receiptFileId?: string;

  @IsString() @MinLength(8) @MaxLength(100) idempotencyKey!: string;

  /* Which Zoho accounts the money moves between. Optional so a payment can
     still be recorded with Zoho switched off; the queue then says what it
     could not post rather than the payment being refused. */
  @IsOptional() @IsString() @MaxLength(64) zohoPaidThroughAccountId?: string;
  @IsOptional() @IsString() @MaxLength(64) zohoExpenseAccountId?: string;
  @IsOptional() @IsString() @MaxLength(64) zohoToAccountId?: string;
  @IsOptional() @IsString() @MaxLength(64) zohoBranchId?: string;
}

export class ReversePayment {
  @IsString() @MinLength(1) @MaxLength(1000) reason!: string;
}

export class CashFlowQuery {
  /** The month, as YYYY-MM. */
  @Matches(/^\d{4}-\d{2}$/, { message: 'month must be YYYY-MM' }) month!: string;

  /**
   * `accurate` uses the real payment dates and is the default. `legacy`
   * reproduces the spreadsheet exactly, including its habit of treating an
   * earlier part payment as not yet having happened -- kept for checking the
   * migration against figures Finance already has.
   */
  @IsOptional() @IsIn(['legacy', 'accurate']) method?: 'legacy' | 'accurate';
}

export class PurchaseOrderLineDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) quantity!: number;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) rate!: number;
}

/**
 * A draft purchase order.
 *
 * `reference` is accepted and then ignored when Zoho can answer: the
 * supplier's own numbering has to stay continuous, and whatever the form is
 * holding is however old the page has been open.
 */
export class DraftPurchaseOrder {
  @IsString() @MaxLength(64) vendorId!: string;
  @IsString() @MaxLength(200) vendorName!: string;
  @IsOptional() @IsString() @MaxLength(100) reference?: string;

  @IsArray() @ArrayMaxSize(40) @ValidateNested({ each: true })
  @Type(() => PurchaseOrderLineDto) lines!: PurchaseOrderLineDto[];
}