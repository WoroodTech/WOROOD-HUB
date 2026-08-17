/**
 * Request shapes for the administration console.
 *
 * The global ValidationPipe runs with `whitelist` and `forbidNonWhitelisted`,
 * so a field not declared here is rejected rather than ignored. That matters
 * more on this module than anywhere else: a typo'd `roleIds` silently doing
 * nothing would look exactly like a permission change that did not take.
 */

import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsOptional, IsString,
  IsUUID, Matches, MaxLength, MinLength,
} from 'class-validator';

/** Long enough to matter, and the only rule -- an arbitrary character-class
 *  requirement pushes people towards `Password1!` and a sticky note. */
export const MIN_PASSWORD = 12;

export class ListUsersQuery {
  @IsOptional() @IsString() @MaxLength(120) q?: string;
  @IsOptional() @IsIn(['ACTIVE', 'SUSPENDED', 'ALL']) status?: string;
  @IsOptional() @IsUUID() roleId?: string;
  @IsOptional() @IsUUID() departmentId?: string;
}

export class CreateUser {
  @IsEmail({}, { message: 'That is not a valid e-mail address' })
  @MaxLength(190)
  email!: string;

  @IsString() @MinLength(2) @MaxLength(160) fullName!: string;
  @IsOptional() @IsString() @MaxLength(160) fullNameAr?: string;
  @IsOptional() @IsString() @MaxLength(160) jobTitle?: string;
  @IsOptional() @IsUUID() departmentId?: string;
  @IsOptional() @IsString() @MaxLength(64) timezone?: string;
  @IsOptional() @IsIn(['en', 'ar']) locale?: string;

  @IsString() @MinLength(MIN_PASSWORD, {
    message: `The password must be at least ${MIN_PASSWORD} characters`,
  }) @MaxLength(200) password!: string;

  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID(undefined, { each: true }) roleIds?: string[];
}

export class UpdateUser {
  @IsOptional() @IsEmail({}, { message: 'That is not a valid e-mail address' }) @MaxLength(190) email?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(160) fullName?: string;
  @IsOptional() @IsString() @MaxLength(160) fullNameAr?: string;
  @IsOptional() @IsString() @MaxLength(160) jobTitle?: string;
  @IsOptional() @IsUUID() departmentId?: string;
  @IsOptional() @IsString() @MaxLength(64) timezone?: string;
  @IsOptional() @IsIn(['en', 'ar']) locale?: string;
  @IsOptional() @IsIn(['ACTIVE', 'SUSPENDED']) status?: 'ACTIVE' | 'SUSPENDED';
  /** The complete set, not an addition -- sending `[]` removes every role. */
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID(undefined, { each: true }) roleIds?: string[];
}

export class SetPassword {
  @IsString() @MinLength(MIN_PASSWORD, {
    message: `The password must be at least ${MIN_PASSWORD} characters`,
  }) @MaxLength(200) password!: string;

  /** Ending their other sessions is the safe default; an administrator
   *  resetting a forgotten password for someone sitting next to them can
   *  turn it off. */
  @IsOptional() @IsBoolean() endOtherSessions?: boolean;
}

export class DashboardAssignment {
  @IsUUID() dashboardId!: string;
  @IsIn(['GRANT', 'REVOKE']) effect!: 'GRANT' | 'REVOKE';
}

export class SetUserDashboards {
  /** The complete set of individual overrides for this person. Role-derived
   *  access is untouched -- that is edited on the role, not on the person. */
  @IsArray() @ArrayMaxSize(200) @Type(() => DashboardAssignment) assignments!: DashboardAssignment[];
}

export class UpsertRole {
  @IsString() @MinLength(2) @MaxLength(48)
  @Matches(/^[a-z][a-z0-9-]*$/, {
    message: 'The key must be lower-case letters, digits and hyphens, starting with a letter',
  })
  key!: string;

  @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(120) nameAr?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) permissionKeys?: string[];
}

export class SetRolePermissions {
  @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) permissionKeys!: string[];
}
