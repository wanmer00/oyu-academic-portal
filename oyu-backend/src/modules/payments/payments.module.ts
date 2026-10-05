import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { AdminPaymentsController, StudentPaymentsController } from './payments.controller';

@Module({
  controllers: [StudentPaymentsController, AdminPaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
