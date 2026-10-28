import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CoreModule } from './core/core.module';
import { AdministrationModule } from './modules/administration/administration.module';
import { MeetingRoomsModule } from './modules/meeting-rooms/meeting-rooms.module';
import { SalesDashboardModule } from './modules/sales-dashboard/sales-dashboard.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { AnnouncementsModule } from './modules/announcements';
import { FinanceModule } from './modules/finance';
import { JwtAuthGuard, PermissionsGuard } from './common/auth';
import { config } from './common/config';

/**
 * The application root. A feature module is two lines: the import above and the
 * entry below. Adding one changes nothing else -- the navigation, the dashboard
 * grid and the permission rows all come from the module's own descriptor.
 *
 * Guards are global and ordered: identity first, then authorisation.
 */
@Module({
  /* Tasks is imported conditionally, which is the difference between a module
     that is off and one that is merely hidden: Nest never constructs it, so its
     controllers are not mounted and its scheduler -- which sends SLA and
     escalation mail -- is never instantiated. Nothing else in the application
     imports it, so leaving it out costs nothing elsewhere. */
  imports: [
    CoreModule, AdministrationModule, MeetingRoomsModule, SalesDashboardModule,
    AnnouncementsModule, FinanceModule,
    ...(config.tasks.enabled ? [TasksModule] : []),
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}