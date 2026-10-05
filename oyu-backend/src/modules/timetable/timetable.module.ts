import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { TimetableBootstrapService } from './timetable.bootstrap.service';
import { TimetableConfigService } from './timetable.config.service';
import { TimetableConflictsService } from './timetable.conflicts.service';
import { TimetableContextService } from './timetable.context.service';
import { TimetableController } from './timetable.controller';
import { TimetableExportService } from './timetable.export.service';
import { TimetableJobsService } from './timetable.jobs.service';
import { TimetableLessonsService } from './timetable.lessons.service';
import { TimetableRequirementsService } from './timetable.requirements.service';
import { TimetableVersionsService } from './timetable.versions.service';

@Module({
  imports: [NotificationsModule],
  controllers: [TimetableController],
  providers: [
    TimetableContextService, TimetableConflictsService, TimetableConfigService, TimetableRequirementsService, TimetableVersionsService,
    TimetableLessonsService, TimetableJobsService, TimetableExportService, TimetableBootstrapService,
  ],
  exports: [TimetableContextService, TimetableConflictsService, TimetableBootstrapService],
})
export class TimetableModule {}
