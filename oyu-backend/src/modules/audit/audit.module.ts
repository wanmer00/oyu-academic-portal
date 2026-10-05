import { Module } from '@nestjs/common';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { AuditCenterController } from './audit.controller';
import { AuditCenterService } from './audit.service';
import { AuditAnomaliesService } from './audit-anomalies.service';

@Module({
  imports: [PrismaModule],
  controllers: [AuditCenterController],
  providers: [AuditCenterService, AuditAnomaliesService],
  exports: [AuditCenterService, AuditAnomaliesService],
})
export class AuditModule {}
