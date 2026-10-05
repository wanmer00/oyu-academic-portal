import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { PaymentStatus, PaymentType } from '@prisma/client';

import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/rbac/require-permission.decorator';
import { PaymentsService } from './payments.service';

@Controller('me/payments')
export class StudentPaymentsController {
  constructor(private readonly svc: PaymentsService) {}

  @Get()
  @RequirePermission('payments.view')
  list(@CurrentUser() user: CurrentUserData) {
    return this.svc.listForStudent(user.id);
  }

  @Post(':id/pay')
  @RequirePermission('payments.pay')
  payMock(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.svc.payMock(user.id, id);
  }
}

@Controller('admin/payments')
@RequirePermission('payments.view', { requireAll: true })
export class AdminPaymentsController {
  constructor(private readonly svc: PaymentsService) {}

  @Get()
  list(
    @Query('status') status?: PaymentStatus,
    @Query('type') type?: PaymentType,
    @Query('take') take?: string,
  ) {
    return this.svc.listAll({ status, type, take: take ? parseInt(take, 10) : undefined });
  }
}
