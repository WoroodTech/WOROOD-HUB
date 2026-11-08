/**
 * The administration console.
 *
 * It is registered as a hub module like any other, even though it administers
 * the platform rather than extending it. That is not a category error, it is
 * the point: the sidebar is built from module descriptors, so anything wanting
 * navigation declares it the same way. Administration gets no special path
 * through the shell, and its links are permission-gated by exactly the same
 * mechanism as everyone else's.
 *
 * Every route is behind `core.user.manage` or `core.role.manage`. Only the
 * `admin` role carries them, and migration 0005 is what puts them there --
 * hardcoded once, because a system with no way in cannot be administered into
 * having one.
 */

import {
  Body, Controller, Delete, Get, Module, Param, ParseUUIDPipe, Patch, Post, Put,
  Query, Req,
} from '@nestjs/common';
import { IsEmail, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Permissions, Principal, Public } from '../../common/auth';
import { registerHubModule } from '../../core/hub-registry';
import { CoreModule } from '../../core/core.module';
import { CORE_PERMISSIONS } from './permissions';
import { SignupService } from './signup.service';
import {
  CreateUser, ListUsersQuery, SetPassword, SetRolePermissions,
  SetDepartmentManager, SetUserDashboards, UpdateUser, UpsertRole,CreateDepartment
} from './dto';
import { AdminUsersService } from './users.service';
import { AdminRolesService } from './roles.service';
import { AdminDepartmentsService } from './departments.service';

export const ADMINISTRATION_MODULE = registerHubModule({
  key: 'administration',
  name: 'Administration',
  nameAr: 'الإدارة',
  version: '1.0.0',
  apiPrefix: '/api/v1/admin',
  tablePrefix: 'core_',
  enabled: true,
  navigation: [
    { label: 'People', labelAr: 'الموظفون', path: '/admin/people', icon: 'users',
      requiresAnyPermission: [CORE_PERMISSIONS.USER_MANAGE] },
    { label: 'Roles', labelAr: 'الأدوار', path: '/admin/roles', icon: 'lock',
      requiresAnyPermission: [CORE_PERMISSIONS.ROLE_MANAGE] },
    /* Its own entry rather than a tab under People: these are not people yet,
       and a queue nobody can see is a queue nobody clears. */
    { label: 'Account requests', labelAr: 'طلبات الحسابات',
      path: '/admin/signups', icon: 'user',
      requiresAnyPermission: ['core.signup.review'] },
    /* Added with Module 3, which made the org chart load-bearing: who runs a
       department decides who may hand work out, and until this screen it could
       only be changed in SQL. */
    { label: 'Departments', labelAr: 'الإدارات', path: '/admin/departments', icon: 'globe',
      requiresAnyPermission: [CORE_PERMISSIONS.USER_MANAGE] },
  ],
  // Nothing on the home screen: administration is a place you go, not a thing
  // that should be watching you from your dashboard every morning.
  portlets: [],
  permissions: [
    { key: CORE_PERMISSIONS.USER_MANAGE,
      description: 'Create employee accounts, change their details and password, assign roles and dashboards' },
    { key: CORE_PERMISSIONS.ROLE_MANAGE,
      description: 'Create roles and decide which permissions each one carries' },
    { key: CORE_PERMISSIONS.AUDIT_VIEW, description: 'Read the audit trail' },
  ],
});

/** The address of whoever is at the keyboard, behind the proxy. */
const ipOf = (req: any) =>
  (req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || '')
    .trim() || null;

/**
 * Asking for an account.
 *
 * Validated here rather than only in the service, because this form is open
 * to the internet: everything arriving is a string somebody chose, and the
 * first thing that should happen to it is being checked.
 */
class SignupRequestDto {
  @IsEmail({}, { message: 'That does not look like an e-mail address.' })
  @MaxLength(254)
  email!: string;

  /*
   * Eight characters and more than one kind of thing in them.
   *
   * Not a wall of rules: a long list of requirements pushes people towards
   * the one password they already use everywhere, which is worse than a short
   * one they chose for this.
   */
  @IsString()
  @MinLength(8, { message: 'Use at least 8 characters.' })
  @MaxLength(200)
  @Matches(/(?=.*[a-zA-Z])(?=.*[0-9!@#$%^&*(),.?":{}|<>_\-])/, {
    message: 'Mix letters with at least one number or symbol.',
  })
  password!: string;

  @IsString()
  @MinLength(2, { message: 'Tell us your name.' })
  @MaxLength(120)
  fullName!: string;

  /* A uuid from the list we served a moment ago. Anything else is a tampered
     form rather than somebody making a mistake. */
  @IsUUID('4', { message: 'Choose a department from the list.' })
  departmentId!: string;
}

class SignupRejectDto {
  @IsString()
  @MinLength(3, { message: 'Give a reason — it is sent to them.' })
  @MaxLength(500)
  reason!: string;
}

@Controller('admin')
export class AdministrationController {
  constructor(
    private readonly users: AdminUsersService,
    private readonly roles: AdminRolesService,
    private readonly depts: AdminDepartmentsService,
    private readonly signup: SignupService,
  ) {}

  /* ------------------------------------------------------- sign-ups ---- */
  /*
   * The form is open to anyone who can reach the portal. That is the design:
   * approval is the gate, not the form. What it costs is handled in the
   * service — one answer whatever happens, a ceiling per hour, and nothing
   * becoming a user until somebody says so.
   */

  /** The departments the sign-up form offers. Public: it is on the form. */
  @Public() @Get('signup/departments')
  signupDepartments() { return this.signup.departments(); }

  @Public() @Post('signup')
  requestAccount(@Body() dto: SignupRequestDto, @Req() req: any) {
    return this.signup.request(dto, ipOf(req));
  }

  @Get('signup/pending')
  @Permissions('core.signup.review')
  pendingSignups(@CurrentUser() p: Principal) { return this.signup.pending(p); }

  @Get('signup/decided')
  @Permissions('core.signup.review')
  decidedSignups(@CurrentUser() p: Principal) { return this.signup.decided(p); }

  @Post('signup/:id/approve')
  @Permissions('core.signup.review')
  approveSignup(@CurrentUser() p: Principal,
                @Param('id', ParseUUIDPipe) id: string) {
    return this.signup.approve(p, id);
  }

  @Post('signup/:id/reject')
  @Permissions('core.signup.review')
  rejectSignup(@CurrentUser() p: Principal,
               @Param('id', ParseUUIDPipe) id: string,
               @Body() dto: SignupRejectDto) {
    return this.signup.reject(p, id, dto.reason);
  }

  /* --------------------------------------------------------------- people */

  @Get('users')
  @Permissions(CORE_PERMISSIONS.USER_MANAGE)
  listUsers(@Query() q: ListUsersQuery) { return this.users.list(q); }

  @Get('users/:id')
  @Permissions(CORE_PERMISSIONS.USER_MANAGE)
  getUser(@Param('id', ParseUUIDPipe) id: string) { return this.users.get(id); }

  @Post('users')
  @Permissions(CORE_PERMISSIONS.USER_MANAGE)
  createUser(@CurrentUser() p: Principal, @Body() dto: CreateUser) {
    return this.users.create(p, dto);
  }

  /** Name, e-mail, job title, department, locale, status and roles -- one
   *  endpoint, because they are one form and a partial save is a lie. */
  @Patch('users/:id')
  @Permissions(CORE_PERMISSIONS.USER_MANAGE)
  updateUser(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUser) {
    return this.users.update(p, id, dto);
  }

  /** Separate from the profile form on purpose: a password is not a field you
   *  should be able to change by accident while fixing a job title. */
  @Post('users/:id/password')
  @Permissions(CORE_PERMISSIONS.USER_MANAGE)
  setPassword(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetPassword) {
    return this.users.setPassword(p, id, dto);
  }

  @Put('users/:id/dashboards')
  @Permissions(CORE_PERMISSIONS.USER_MANAGE)
  setDashboards(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetUserDashboards) {
    return this.users.setDashboards(p, id, dto);
  }

  @Delete('users/:id')
  @Permissions(CORE_PERMISSIONS.USER_MANAGE)
  removeUser(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.remove(p, id);
  }

  /* ------------------------------------------------------------ reference */

  @Get('departments')
  @Permissions(CORE_PERMISSIONS.USER_MANAGE)
  async departments() { return { departments: await this.users.departments() }; }

  @Get('dashboards')
  @Permissions(CORE_PERMISSIONS.USER_MANAGE)
  async dashboards() { return { dashboards: await this.users.dashboards() }; }

  /* ---------------------------------------------------- department heads */

  @Get('departments/overview')
  @Permissions(CORE_PERMISSIONS.USER_MANAGE)
  departmentOverview() { return this.depts.list(); }
  
  @Post('departments')
  @Permissions(CORE_PERMISSIONS.USER_MANAGE)
  createDepartment(@CurrentUser() p: Principal, @Body() dto: CreateDepartment) {
    return this.depts.create(p, dto);
  }

  @Get('departments/:id/candidates')
  @Permissions(CORE_PERMISSIONS.USER_MANAGE)
  async departmentCandidates(@Param('id', ParseUUIDPipe) id: string) {
    return { candidates: await this.depts.candidates(id) };
  }

  @Post('departments/:id/managers')
  @Permissions(CORE_PERMISSIONS.USER_MANAGE)
  addManager(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string,
             @Body() dto: SetDepartmentManager) {
    return this.depts.addManager(p, id, dto.userId);
  }

  @Delete('departments/:id/managers/:userId')
  @Permissions(CORE_PERMISSIONS.USER_MANAGE)
  removeManager(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string,
                @Param('userId', ParseUUIDPipe) userId: string) {
    return this.depts.removeManager(p, id, userId);
  }

  /* ---------------------------------------------------------------- roles */

  /* Readable with either permission: the people screen has to show which roles
     exist to assign them, without granting the right to edit what they do. */
  @Get('roles')
  @Permissions(CORE_PERMISSIONS.ROLE_MANAGE, CORE_PERMISSIONS.USER_MANAGE)
  listRoles() { return this.roles.list(); }

  @Get('roles/:id')
  @Permissions(CORE_PERMISSIONS.ROLE_MANAGE, CORE_PERMISSIONS.USER_MANAGE)
  getRole(@Param('id', ParseUUIDPipe) id: string) { return this.roles.get(id); }

  @Get('roles/:id/holders')
  @Permissions(CORE_PERMISSIONS.ROLE_MANAGE, CORE_PERMISSIONS.USER_MANAGE)
  async roleHolders(@Param('id', ParseUUIDPipe) id: string) {
    return { holders: await this.roles.holders(id) };
  }

  @Get('permissions')
  @Permissions(CORE_PERMISSIONS.ROLE_MANAGE, CORE_PERMISSIONS.USER_MANAGE)
  permissions() { return this.roles.permissionCatalogue(); }

  @Post('roles')
  @Permissions(CORE_PERMISSIONS.ROLE_MANAGE)
  createRole(@CurrentUser() p: Principal, @Body() dto: UpsertRole) {
    return this.roles.create(p, dto);
  }

  @Patch('roles/:id')
  @Permissions(CORE_PERMISSIONS.ROLE_MANAGE)
  updateRole(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpsertRole) {
    return this.roles.update(p, id, dto);
  }

  @Put('roles/:id/permissions')
  @Permissions(CORE_PERMISSIONS.ROLE_MANAGE)
  setRolePermissions(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetRolePermissions) {
    return this.roles.setPermissions(p, id, dto);
  }

  @Delete('roles/:id')
  @Permissions(CORE_PERMISSIONS.ROLE_MANAGE)
  removeRole(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.roles.remove(p, id);
  }
}

@Module({
  imports: [CoreModule],
  controllers: [AdministrationController],
  providers: [AdminUsersService, AdminRolesService, AdminDepartmentsService,
              SignupService],
})
export class AdministrationModule {}