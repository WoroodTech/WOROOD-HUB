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
  Body, Controller, Delete, Get, Module, Param, ParseUUIDPipe, Patch, Post, Put, Query,
} from '@nestjs/common';
import { CurrentUser, Permissions, Principal } from '../../common/auth';
import { registerHubModule } from '../../core/hub-registry';
import { CoreModule } from '../../core/core.module';
import { CORE_PERMISSIONS } from './permissions';
import {
  CreateUser, ListUsersQuery, SetPassword, SetRolePermissions,
  SetDepartmentManager, SetUserDashboards, UpdateUser, UpsertRole,
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

@Controller('admin')
export class AdministrationController {
  constructor(
    private readonly users: AdminUsersService,
    private readonly roles: AdminRolesService,
    private readonly depts: AdminDepartmentsService,
  ) {}

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
  providers: [AdminUsersService, AdminRolesService, AdminDepartmentsService],
})
export class AdministrationModule {}
