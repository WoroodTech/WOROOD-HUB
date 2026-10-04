/**
 * Request shapes for Module 3.
 *
 * The global ValidationPipe runs with `whitelist` and `forbidNonWhitelisted`,
 * so anything not declared here is rejected rather than quietly ignored.
 *
 * Note what is NOT here. There is no `status` field on any update DTO: status
 * moves through named transitions (`start`, `resolve`, `close`) rather than by
 * assignment, because every move has its own preconditions, its own event and
 * its own notification. A settable status column would let a caller skip all
 * three.
 */
import { Type } from 'class-transformer';
import {
  IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength,
} from 'class-validator';

export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

export class CreateTask {
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(8000) description?: string;
  @IsOptional() @IsIn(PRIORITIES as unknown as string[]) priority?: string;

  /** The department being asked. Defaults to the requester's own. */
  @IsOptional() @IsUUID() departmentId?: string;

  /**
   * Raising it for yourself. Skips the queue: requester and assignee are the
   * same person and it opens at ASSIGNED, because waiting for your own manager
   * to hand you back your own note would be theatre.
   */
  @IsOptional() @IsUUID() assignToSelf?: string;

  /**
   * Skip the review step: the work goes straight from being finished to being
   * carried out.
   *
   * Decided here and nowhere else — the database refuses to change it after
   * insert. A ticket whose review requirement could be removed mid-flight has
   * no review requirement, because it would be removed on exactly the tickets
   * where review was about to be inconvenient.
   */
  @IsOptional() @IsBoolean()
  fastTrack?: boolean;
}

export class UpdateRequest {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(8000) description?: string;
  @IsOptional() @IsIn(PRIORITIES as unknown as string[]) priority?: string;
  @IsOptional() @IsUUID() departmentId?: string;
}

export class AssignTask {
  @IsUUID() assigneeId!: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class TransferTask {
  @IsUUID() departmentId!: string;
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class ReasonOnly {
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class ResolveTask {
  @IsString() @MinLength(3) @MaxLength(2000) resolution!: string;
}

export class SetDue {
  /** Null clears it. An instant, stored UTC, shown in the employee's zone. */
  @IsOptional() @IsISO8601() dueAt?: string | null;
}

export class AddComment {
  @IsString() @MinLength(1) @MaxLength(8000) body!: string;
}

export class ManageContributor {
  @IsUUID() userId!: string;
}

export class AddDependency {
  /** The department being asked for the blocking work. */
  @IsUUID() departmentId!: string;
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(8000) description?: string;
  @IsOptional() @IsIn(PRIORITIES as unknown as string[]) priority?: string;
}

export class ListTasksQuery {
  /**
   * Which slice of "mine". These are not filters over one list, they are three
   * different questions, which is why they are named rather than composed:
   *   requested    -- I raised it
   *   assigned     -- it is on me
   *   contributing -- I was brought in
   *   queue        -- unassigned, in a department I manage
   *   department   -- everything in the departments I manage
   *   all          -- everything (needs view-any)
   */
  @IsOptional()
  @IsIn(['requested', 'assigned', 'contributing', 'queue', 'department', 'all'])
  scope?: string;

  @IsOptional() @IsString() @MaxLength(120) q?: string;
  @IsOptional() @IsUUID() departmentId?: string;
  @IsOptional() @IsIn(PRIORITIES as unknown as string[]) priority?: string;
  /** Comma separated, or 'open' / 'closed' as shorthands. */
  @IsOptional() @IsString() @MaxLength(120) status?: string;
  @IsOptional() @IsIn(['true', 'false']) overdue?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize?: number;
}

/** Planning takes a date and nothing else. The note is optional because the
 *  date usually says it all -- "next Tuesday" needs no explanation the way
 *  "on hold" does. */
export class PlanTask {
  @IsISO8601()
  plannedFor!: string;

  @IsOptional() @IsString() @MaxLength(500)
  note?: string;
}

/**
 * A card dropped on another column.
 *
 * The extra fields are optional because a drop cannot know it needs them until
 * it lands: dropping on Planning needs a date, on On hold a reason, on Assigned
 * a person. The API refuses and says which, and the board opens the dialog —
 * rather than the board holding its own copy of which columns need what.
 */
export class MoveTask {
  /* Where a card may be dropped.
  
     IMPLEMENTATION and DONE are absent on purpose and not for want of a
     dialog: approval is the requester's judgement of work they asked for, and
     "it is in place" is something only the person who put it there can say.
     Neither is a manager's to declare by moving a card. */
  @IsIn(['PLANNING', 'ON_HOLD', 'ASSIGNED', 'IN_PROGRESS', 'FOR_REVIEW'])
  to!: string;

  @IsOptional() @IsISO8601() plannedFor?: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsOptional() @IsUUID() assigneeId?: string;
  /** What was done, when dropping on For review. */
  @IsOptional() @IsString() @MinLength(3) @MaxLength(2000) resolution?: string;
}