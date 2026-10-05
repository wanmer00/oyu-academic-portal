import { Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AdminExamsController, DemoRuntimeController, ProctorController, RuntimeController, StudentExamsController, TeacherExamsController } from './exams.controller';
import { AttemptService } from './attempt.service';
import { EligibilityService } from './eligibility.service';
import { ExamCommon } from './exam-common.service';
import { ProctorService } from './proctor.service';
import { QuestionBankService } from './question-bank.service';
import { ResitService } from './resit.service';
import { ResultsService } from './results.service';
import { RetakeService } from './retake.service';
import { RuntimeService, WorkstationGuard } from './runtime.service';
import { StudentExamsService } from './student-exams.service';
import { WindowsService } from './windows.service';
import { DemoExamService } from './demo-exam.service';
import { PaperController } from './paper/paper.controller';
import { PaperService } from './paper/paper.service';

/**
 * Фоновые задачи: автосдача истёкших попыток, аннулирование неиспользованных авторизаций,
 * закрытие окон после последнего дня. Каждая операция идемпотентна и безопасна при параллельном запуске.
 */
@Injectable()
export class ExamScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ExamScheduler.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private readonly attempts: AttemptService, private readonly windows: WindowsService) {}

  onModuleInit() {
    if (process.env.EXAM_SCHEDULER === 'off') return;
    this.timer = setInterval(() => void this.tick(), 20_000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const n = await this.attempts.autoSubmitExpired();
      await this.attempts.voidExpiredAuthorizations();
      const c = await this.windows.closeFinished();
      if (n || c) this.log.log(`auto-submitted ${n}, closed windows ${c}`);
    } catch (e) {
      this.log.error((e as Error).message);
    } finally {
      this.running = false;
    }
  }
}

@Module({
  controllers: [StudentExamsController, TeacherExamsController, AdminExamsController, ProctorController, RuntimeController, DemoRuntimeController, PaperController],
  providers: [
    ExamCommon, EligibilityService, AttemptService, WindowsService, QuestionBankService, ProctorService, RuntimeService, WorkstationGuard,
    ResitService, RetakeService, DemoExamService, StudentExamsService, ResultsService, PaperService, ExamScheduler,
  ],
  exports: [ExamCommon, AttemptService, EligibilityService, WindowsService, ResitService, WorkstationGuard],
})
export class ExamsModule {}
