import { Module } from '@nestjs/common';
import { ExamsModule } from '../exams/exams.module';
import { RequestsController } from './requests.controller';
import { RequestsService } from './requests.service';
import { AdminAppealsController, StudentAppealsController, TeacherAppealsController } from './appeals.controller';
import { AppealsService } from './appeals.service';
import { KioskAppealsController } from './kiosk-appeals.controller';

// Апелляция по экзамену — расширение существующих Requests (Request.type = APPEAL), отдельного модуля нет
@Module({
  imports: [ExamsModule],
  controllers: [RequestsController, StudentAppealsController, TeacherAppealsController, AdminAppealsController, KioskAppealsController],
  providers: [RequestsService, AppealsService],
  exports: [RequestsService, AppealsService],
})
export class RequestsModule {}
