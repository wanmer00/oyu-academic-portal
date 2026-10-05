import { Module } from '@nestjs/common';
import { StudentsModule } from '../students/students.module';
import { AttendanceModule } from '../attendance/attendance.module';
import { JournalAuditService } from './journal-audit.service';
import { JournalExportService } from './journal-export.service';
import { JournalWriteService } from './journal-write.service';
import { JournalController } from './journal.controller';
import { JournalService } from './journal.service';

@Module({
  imports: [StudentsModule, AttendanceModule],
  controllers: [JournalController],
  providers: [JournalService, JournalWriteService, JournalAuditService, JournalExportService],
  exports: [JournalService],
})
export class JournalModule {}
