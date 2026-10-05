import { Module } from '@nestjs/common';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { AIController } from './ai.controller';
import { ClaudeService } from './claude.service';
import { AISessionService } from './ai-session.service';
import { GpaWhatIfService } from './features/gpa-whatif.service';
import { RequestDrafterService } from './features/request-drafter.service';
import { TranslateService } from './features/translate.service';
import { MaterialSearchService } from './features/material-search.service';
import { QuestionGenService } from './features/question-gen.service';
import { DropoutRiskService } from './features/dropout-risk.service';
import { AuditAnomalyService } from './features/audit-anomaly.service';
import { AIContextService } from './assistant/ai-context.service';
import { AssistantService } from './assistant/assistant.service';
import { AssistantController } from './assistant/assistant.controller';
import { JournalModule } from '../journal/journal.module';
import { StudentsModule } from '../students/students.module';
import { AssignmentsModule } from '../assignments/assignments.module';
import { RequestsModule } from '../requests/requests.module';
import { PaymentsModule } from '../payments/payments.module';
import { TeachersModule } from '../teachers/teachers.module';
import { AttendanceModule } from '../attendance/attendance.module';
import { AdminModule } from '../admin/admin.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [JournalModule, PrismaModule, StudentsModule, AssignmentsModule, RequestsModule, PaymentsModule, TeachersModule, AttendanceModule, AdminModule, AuditModule],
  controllers: [AIController, AssistantController],
  providers: [
    ClaudeService,
    AISessionService,
    GpaWhatIfService,
    RequestDrafterService,
    TranslateService,
    MaterialSearchService,
    QuestionGenService,
    DropoutRiskService,
    AuditAnomalyService,
    AIContextService,
    AssistantService,
  ],
  exports: [AISessionService, ClaudeService],
})
export class AIModule {}
