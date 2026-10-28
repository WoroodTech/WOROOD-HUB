import { Module } from '@nestjs/common';
import { CoreModule } from '../../core/core.module';
import { AnnouncementsController, ANNOUNCEMENTS_MODULE } from './announcements.module';
import { AnnouncementsService } from './announcements.service';

export { ANNOUNCEMENTS_MODULE };

@Module({
  imports: [CoreModule],
  controllers: [AnnouncementsController],
  providers: [AnnouncementsService],
  exports: [AnnouncementsService],
})
export class AnnouncementsModule {}