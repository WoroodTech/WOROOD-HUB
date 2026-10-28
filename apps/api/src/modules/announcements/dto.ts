/**
 * What the API accepts for company news.
 *
 * The validation here is about what a person could plausibly have meant. The
 * rules that depend on the state of a row -- whether replies are open, whether
 * the window makes sense against the one already stored -- live in the service,
 * because a DTO cannot see the database.
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsInt, IsOptional, IsString,
  IsUUID, Max, MaxLength, Min, MinLength,
} from 'class-validator';

export class CreateAnnouncement {
  /* Both languages are optional on their own, and the service refuses a notice
     with neither title. A notice written only in Arabic is perfectly normal
     here and must not be made to carry an empty English field to be accepted. */
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(200) titleAr?: string;
  @IsOptional() @IsString() @MaxLength(8000) body?: string;
  @IsOptional() @IsString() @MaxLength(8000) bodyAr?: string;

  @IsOptional() @IsDateString() publishAt?: string;

  /** An explicit end, for the rare notice tied to a date. */
  @IsOptional() @IsDateString() expiresAt?: string;

  /**
   * How many days it stays on the home page.
   *
   * The question the form asks, because it is the one a person can answer. Zero
   * means it stays until somebody takes it down -- the quarterly awards want
   * that far more often than they want a date.
   */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(365) days?: number;

  @IsOptional() @IsBoolean() pinned?: boolean;
  @IsOptional() @IsBoolean() commentsEnabled?: boolean;
}

export class UpdateAnnouncement extends CreateAnnouncement {}

export class ListAnnouncements {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class RequestImageUpload {
  @IsString() @MaxLength(200) name!: string;
  /* Checked against the accepted list in the service, and then checked again
     against the file's own first bytes after it arrives -- this is a claim, not
     a fact. */
  @IsString() @MaxLength(100) type!: string;
  @Type(() => Number) @IsInt() @Min(1) size!: number;
}

export class ReorderImages {
  @IsArray() @ArrayMaxSize(12) @IsUUID('4', { each: true }) imageIds!: string[];
}

export class CommentOnAnnouncement {
  @IsString() @MinLength(1) @MaxLength(2000) body!: string;
}