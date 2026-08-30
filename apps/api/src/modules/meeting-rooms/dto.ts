/**
 * Request shapes for the booking flow.
 *
 * The global ValidationPipe runs with `whitelist` and `forbidNonWhitelisted`,
 * so anything not declared here is rejected rather than quietly ignored --
 * a typo'd field name fails loudly instead of silently not applying.
 */

import { Type } from 'class-transformer';
import { BOOKING_LIMITS } from './slots';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional,
  IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength,
} from 'class-validator';

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ListRoomsQuery {
  @IsOptional() @IsString() @MaxLength(120) q?: string;
  @IsOptional() @IsUUID() locationId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) minCapacity?: number;
  /** Comma separated equipment keys, e.g. "projector,video-conference". */
  @IsOptional() @IsString() @MaxLength(300) equipment?: string;
  @IsOptional() @IsIn(['ACTIVE', 'MAINTENANCE', 'INACTIVE', 'ALL']) status?: string;
}

export class AvailabilityQuery {
  /** Calendar day in the location's own timezone, YYYY-MM-DD. Not an instant:
   *  "Tuesday" means Tuesday in Cairo, whatever the caller's clock says. */
  @Matches(DATE, { message: 'date must be YYYY-MM-DD' }) date!: string;

  /** The exact time asked for. Required now: this endpoint answers "is this
   *  window free", and without a start time there is no window to answer
   *  about. Any HH:mm is accepted -- the five-minute step in the portal is a
   *  picker convenience, not a rule, so 10:23 is a legitimate request. */
  @Matches(TIME, { message: 'startTime must be HH:mm' }) startTime!: string;

  @Type(() => Number) @IsInt()
  @Min(BOOKING_LIMITS.MIN_MINUTES) @Max(BOOKING_LIMITS.MAX_MINUTES)
  durationMinutes: number = 60;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) minCapacity?: number;
  @IsOptional() @IsUUID() locationId?: string;
  @IsOptional() @IsString() @MaxLength(300) equipment?: string;
  @IsOptional() @IsUUID() roomId?: string;
  @IsOptional() @IsString() @MaxLength(2000) roomIds?: string;
}

export class CreateReservation {
  @IsUUID() roomId!: string;
  @IsString() @MinLength(3) @MaxLength(190) title!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;

  /** ISO-8601 *with offset*, e.g. 2026-08-18T09:00:00+03:00. An instant, not a
   *  wall-clock reading -- the portal always sends the offset. */
  @IsDateString() startsAt!: string;
  @IsDateString() endsAt!: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) attendeeCount?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID(undefined, { each: true }) attendeeUserIds?: string[];
}

export class UpdateReservation {
  @IsOptional() @IsUUID() roomId?: string;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(190) title?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsDateString() startsAt?: string;
  @IsOptional() @IsDateString() endsAt?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) attendeeCount?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID(undefined, { each: true }) attendeeUserIds?: string[];
}

export class RespondToInvitation {
  @IsIn(['ACCEPTED', 'DECLINED']) response!: 'ACCEPTED' | 'DECLINED';
}

export class CancelReservation {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class ListReservationsQuery {
  /** `mine` is anything you organise *or* were invited to -- a meeting someone
   *  booked for you is one of yours. `invited` narrows to the ones where you
   *  are a guest; `all` needs the manage-any permission. */
  @IsOptional() @IsIn(['mine', 'invited', 'organised', 'all']) scope?: 'mine' | 'invited' | 'organised' | 'all';
  @IsOptional() @IsIn(['upcoming', 'past', 'all']) period?: 'upcoming' | 'past' | 'all';
  @IsOptional() @IsIn(['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED']) status?: string;
  @IsOptional() @IsUUID() roomId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class UpsertRoom {
  @IsString() @MinLength(2) @MaxLength(32) code!: string;
  @IsString() @MinLength(2) @MaxLength(160) name!: string;
  @IsOptional() @IsString() @MaxLength(160) nameAr?: string;
  @IsUUID() locationId!: string;
  @IsOptional() @IsString() @MaxLength(48) floor?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(1000) capacity!: number;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsString() @MaxLength(255) photoUrl?: string;
  @IsOptional() @IsIn(['ACTIVE', 'MAINTENANCE', 'INACTIVE']) status?: 'ACTIVE' | 'MAINTENANCE' | 'INACTIVE';
  @IsOptional() @Matches(TIME) opensAt?: string;
  @IsOptional() @Matches(TIME) closesAt?: string;
  /* No slot grid and no per-room minimum or maximum length any more: an
     employee picks a start time and a duration, and the only limits are the
     system-wide ones in BOOKING_LIMITS. Opening hours, the booking horizon and
     the changeover buffer are still the room's own. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) maxAdvanceDays?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(60) bufferMinutes?: number;
  @IsOptional() @IsBoolean() requiresApproval?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(24) @IsString({ each: true }) equipmentKeys?: string[];
}

export class RoomCalendarQuery {
  @Matches(DATE, { message: 'date must be YYYY-MM-DD' }) date!: string;
}