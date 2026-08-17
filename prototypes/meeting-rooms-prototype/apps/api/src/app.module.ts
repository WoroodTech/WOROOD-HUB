import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { DatabaseModule } from './common/database.module';
import { JwtAuthGuard, PermissionsGuard } from './common/auth';
import { AllExceptionsFilter } from './common/exception.filter';
import { AuditModule } from './core/audit/audit.module';
import { AuthModule } from './core/auth/auth.module';
import { HubModule } from './core/hub/hub.module';
import { UsersModule } from './core/users/users.module';

/* ---------------------------------------------------------------------------
 * FEATURE MODULES
 * ---------------------------------------------------------------------------
 * Registering a new WOROOD HUB module is a two-line change here plus its own
 * folder and migration file. Nothing else in the platform is touched.
 * ------------------------------------------------------------------------ */
import './modules/meeting-rooms/meeting-rooms.descriptor'; // side effect: registers the descriptor
import { MeetingRoomsModule } from './modules/meeting-rooms/meeting-rooms.module';

@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),

    // Core platform
    AuthModule,
    UsersModule,
    HubModule,

    // Feature modules
    MeetingRoomsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
