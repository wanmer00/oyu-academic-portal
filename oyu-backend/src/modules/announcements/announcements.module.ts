import { Module } from '@nestjs/common';
import { AnnouncementsService } from './announcements.service';
import { AdminAnnouncementsController, MyAnnouncementsController } from './announcements.controller';

@Module({
  controllers: [MyAnnouncementsController, AdminAnnouncementsController],
  providers: [AnnouncementsService],
  exports: [AnnouncementsService],
})
export class AnnouncementsModule {}
