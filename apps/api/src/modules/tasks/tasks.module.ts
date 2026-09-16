/**
 * Module 3: Tasks & Tickets.
 *
 * Internal only. An employee raises a request, it lands on a department, that
 * department's manager gives it to somebody, and that person does it.
 *
 * There is no `kind` column and no second code path. A task for yourself is a
 * ticket whose requester and assignee are the same person; a request to your
 * own colleague is a ticket addressed to your own department. Every branch not
 * created here is a branch that cannot drift.
 *
 * Every path the descriptor advertises has an endpoint below and a screen in
 * the portal. Module 1 shipped three navigation entries with nothing behind
 * them and all three rendered Not Found -- the contract makes adding a link a
 * one-line change, which is exactly why nothing catches the missing half.
 */
import {
  Body, Controller, Delete, Get, Module, Param, ParseUUIDPipe, Patch, Post, Query,
} from '@nestjs/common';
import { CurrentUser, Permissions, Principal } from '../../common/auth';
import { registerHubModule } from '../../core/hub-registry';
import { CoreModule } from '../../core/core.module';
import { TASK_PERMISSIONS } from './permissions';
import { TasksService } from './tasks.service';
import { TasksScheduler } from './scheduler.service';
import {
  AddComment, AddDependency, AssignTask, CreateTask, ListTasksQuery,
  ManageContributor, ReasonOnly, ResolveTask, SetDue, TransferTask, UpdateRequest,
} from './dto';

export const TASKS_MODULE = registerHubModule({
  key: 'tasks',
  name: 'Tasks & Tickets',
  nameAr: 'المهام والتذاكر',
  version: '1.0.0',
  apiPrefix: '/api/v1/tasks',
  tablePrefix: 'tk_',
  enabled: true,

  navigation: [
    { label: 'Tasks & Tickets', labelAr: 'المهام والتذاكر', path: '/tasks', icon: 'check' },
    /* ASSIGN is derived from managing a department rather than granted by a
       role, so this entry appears for managers without anybody assigning them
       anything. See loadPrincipal. */
    { label: 'Department Queue', labelAr: 'طابور الإدارة', path: '/tasks/queue', icon: 'list',
      requiresAnyPermission: [TASK_PERMISSIONS.ASSIGN] },
    { label: 'All Tickets', labelAr: 'كل التذاكر', path: '/tasks/all', icon: 'database',
      requiresAnyPermission: [TASK_PERMISSIONS.VIEW_ANY] },
  ],

  /* No permission gate on the first two: every employee raises tickets and
     every employee can be given one. The queue is gated because an employee
     who manages nothing would see a card that is empty for ever. */
  portlets: [
    { key: 'awaiting-assignment', title: 'Awaiting Assignment', titleAr: 'بانتظار التوزيع',
      width: 4, order: 12, requiresAnyPermission: [TASK_PERMISSIONS.ASSIGN] },
    { key: 'assigned-to-me', title: 'Assigned to Me', titleAr: 'المسند لي', width: 4, order: 15 },
    { key: 'my-requests', title: 'My Requests', titleAr: 'طلباتي', width: 4, order: 45 },
  ],

  permissions: [
    { key: TASK_PERMISSIONS.ASSIGN, description: 'Assign and redirect work in a department I manage' },
    { key: TASK_PERMISSIONS.VIEW_ANY, description: 'Read every ticket in the company' },
    { key: TASK_PERMISSIONS.MANAGE_ANY, description: 'Act on any ticket regardless of department' },
    { key: TASK_PERMISSIONS.REPORT_VIEW, description: 'Ticket reporting by department and ageing' },
  ],
});

/* -------------------------------------------------------------- portlets -- */

@Controller('tasks/portlets')
export class TasksPortletsController {
  constructor(private readonly tasks: TasksService) {}

  @Get(':key')
  portlet(@CurrentUser() p: Principal, @Param('key') key: string) {
    return this.tasks.portlet(p, key);
  }
}

/* ------------------------------------------------------------------ main -- */

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService, private readonly scheduler: TasksScheduler) {}

  /* Pickers. Departments with no manager are filtered out at source rather
     than shown and refused: offering a destination nothing can come back from
     is worse than not offering it. */
  @Get('departments')
  departments(@CurrentUser() p: Principal) { return this.tasks.departments(p); }

  @Get('departments/:id/people')
  people(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.tasks.assignable(p, id);
  }

  @Get()
  list(@CurrentUser() p: Principal, @Query() q: ListTasksQuery) { return this.tasks.list(p, q); }

  @Get('counts')
  counts(@CurrentUser() p: Principal) { return this.tasks.counts(p); }

  @Post()
  create(@CurrentUser() p: Principal, @Body() dto: CreateTask) { return this.tasks.create(p, dto); }

  /* :id is last among the GETs so it cannot swallow 'departments' or 'counts'. */
  @Get(':id')
  detail(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.tasks.detail(p, id);
  }

  @Patch(':id')
  update(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRequest) {
    return this.tasks.updateRequest(p, id, dto);
  }

  /* Transitions are named rather than a settable status field, because each
     has its own preconditions, its own event and its own notification. */
  @Post(':id/assign')
  assign(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignTask) {
    return this.tasks.assign(p, id, dto);
  }

  @Post(':id/transfer')
  transfer(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TransferTask) {
    return this.tasks.transfer(p, id, dto);
  }

  @Post(':id/reject')
  reject(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonOnly) {
    return this.tasks.reject(p, id, dto);
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonOnly) {
    return this.tasks.cancel(p, id, dto);
  }

  @Post(':id/start')
  start(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.tasks.start(p, id);
  }

  @Post(':id/due')
  due(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetDue) {
    return this.tasks.setDue(p, id, dto);
  }

  @Post(':id/resolve')
  resolve(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveTask) {
    return this.tasks.resolve(p, id, dto);
  }

  @Post(':id/confirm')
  confirm(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.tasks.confirm(p, id);
  }

  @Post(':id/reject-resolution')
  rejectResolution(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonOnly) {
    return this.tasks.rejectResolution(p, id, dto);
  }

  @Post(':id/reopen')
  reopen(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonOnly) {
    return this.tasks.reopen(p, id, dto);
  }

  @Post(':id/comments')
  comment(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddComment) {
    return this.tasks.comment(p, id, dto);
  }

  @Post(':id/contributors')
  addContributor(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ManageContributor) {
    return this.tasks.addContributor(p, id, dto);
  }

  @Delete(':id/contributors/:userId')
  removeContributor(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string,
                    @Param('userId', ParseUUIDPipe) userId: string) {
    return this.tasks.removeContributor(p, id, userId);
  }

  @Post(':id/dependencies')
  addDependency(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddDependency) {
    return this.tasks.addDependency(p, id, dto);
  }

  @Delete(':id/dependencies/:linkId')
  removeDependency(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string,
                   @Param('linkId', ParseUUIDPipe) linkId: string) {
    return this.tasks.removeDependency(p, id, linkId);
  }

  /* Run the sweep now. The interval covers normal operation; this exists so
     lateness can be demonstrated, and tested, without waiting a quarter of an
     hour for the clock. */
  @Post('admin/sweep')
  @Permissions(TASK_PERMISSIONS.MANAGE_ANY)
  sweep() { return this.scheduler.sweep(); }
}

@Module({
  imports: [CoreModule],
  controllers: [TasksPortletsController, TasksController],
  providers: [TasksService, TasksScheduler],
})
export class TasksModule {}
