import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class ListRoomsQueryDto {
  @IsOptional() @IsString() @MaxLength(120) q?: string;
  @IsOptional() @IsUUID() locationId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) minCapacity?: number;
  /** Comma separated equipment keys, e.g. "projector,video-conference". */
  @IsOptional() @IsString() equipment?: string;
  @IsOptional() @IsIn(['ACTIVE', 'MAINTENANCE', 'INACTIVE', 'ALL']) status?: string;
}

export class AvailabilityQueryDto {
  /** Calendar day in the room's local timezone, YYYY-MM-DD. */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date!: string;

  /** Optional exact window the employee wants; HH:mm local. */
  @IsOptional() @Matches(TIME_PATTERN, { message: 'startTime must be HH:mm' }) startTime?: string;

  @Type(() => Number)
  @IsInt()
  @Min(15)
  @Max(720)
  durationMinutes: number = 60;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) minCapacity?: number;
  @IsOptional() @IsUUID() locationId?: string;
  @IsOptional() @IsString() equipment?: string;
}

export class CreateReservationDto {
  @IsUUID() roomId!: string;

  @IsString() @MinLength(3) @MaxLength(190) title!: string;

  @IsOptional() @IsString() @MaxLength(2000) description?: string;

  /** ISO-8601 with offset, e.g. 2026-08-12T09:00:00+03:00 */
  @IsDateString() startsAt!: string;

  @IsDateString() endsAt!: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) attendeeCount?: number;

  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('4', { each: true }) attendeeUserIds?: string[];
}

export class UpdateReservationDto {
  @IsOptional() @IsUUID() roomId?: string;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(190) title?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsDateString() startsAt?: string;
  @IsOptional() @IsDateString() endsAt?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) attendeeCount?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('4', { each: true }) attendeeUserIds?: string[];
}

export class CancelReservationDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class ListReservationsQueryDto {
  @IsOptional() @IsIn(['mine', 'all']) scope?: 'mine' | 'all';
  @IsOptional() @IsIn(['upcoming', 'past', 'all']) period?: 'upcoming' | 'past' | 'all';
  @IsOptional() @IsIn(['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED']) status?: string;
  @IsOptional() @IsUUID() roomId?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class UpsertRoomDto {
  @IsString() @MinLength(2) @MaxLength(32) code!: string;
  @IsString() @MinLength(2) @MaxLength(160) name!: string;
  @IsOptional() @IsString() @MaxLength(160) nameAr?: string;
  @IsUUID() locationId!: string;
  @IsOptional() @IsString() @MaxLength(48) floor?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(1000) capacity!: number;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsString() @MaxLength(255) photoUrl?: string;
  @IsOptional() @IsIn(['ACTIVE', 'MAINTENANCE', 'INACTIVE']) status?: 'ACTIVE' | 'MAINTENANCE' | 'INACTIVE';
  @IsOptional() @Matches(TIME_PATTERN) openingTime?: string;
  @IsOptional() @Matches(TIME_PATTERN) closingTime?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(120) slotMinutes?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(5) minDurationMinutes?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(15) maxDurationMinutes?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) maxAdvanceDays?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(60) bufferMinutes?: number;
  @IsOptional() @IsBoolean() requiresApproval?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) equipmentKeys?: string[];
}
