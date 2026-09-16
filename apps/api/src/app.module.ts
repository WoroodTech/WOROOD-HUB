import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CoreModule } from './core/core.module';
import { AdministrationModule } from './modules/administration/administration.module';
import { MeetingRoomsModule } from './modules/meeting-rooms/meeting-rooms.module';
import { SalesDashboardModule } from './modules/sales-dashboard/sales-dashboard.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { JwtAuthGuard, PermissionsGuard } from './common/auth';

/**
 * The application root. A feature module is two lines: the import above and the
 * entry below. Adding one changes nothing else -- the navigation, the dashboard
 * grid and the permission rows all come from the module's own descriptor.
 *
 * Guards are global and ordered: identity first, then authorisation.
 */
@Module({
  imports: [CoreModule, AdministrationModule, MeetingRoomsModule, SalesDashboardModule, TasksModule],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
