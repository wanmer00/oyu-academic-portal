import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { Request } from 'express';

import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { RequirePermission } from '../../common/rbac/require-permission.decorator';
import { RequestsService } from './requests.service';
import { CreateRequestDto, CreateRequestSchema, UpdateRequestDto, UpdateRequestSchema } from './dto';
import { AppealsService } from './appeals.service';
import { AppealEditSchema } from './appeals.controller';
import { z } from 'zod';

// ── Доступно любому authed (студент + преподаватель могут подать заявку) ──
@Controller('me/requests')
export class RequestsController {
  constructor(private readonly svc: RequestsService, private readonly appeals: AppealsService) {}

  @Get()
  @RequirePermission('requests.view')
  mine(@CurrentUser() user: CurrentUserData) {
    return this.svc.listMy(user.id);
  }

  @Get('quota')
  @RequirePermission('requests.view')
  quota(@CurrentUser() user: CurrentUserData) {
    return this.svc.dailyQuota(user.id);
  }

  @Get(':id')
  @RequirePermission('requests.view')
  one(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.svc.getMine(user.id, id);
  }

  /** APPEAL по экзамену: изменение до начала рассмотрения */
  @Put(':id/appeal')
  @RequirePermission('requests.create')
  editAppeal(@CurrentUser() user: CurrentUserData, @Param('id') id: string, @Body(new ZodValidationPipe(AppealEditSchema)) dto: z.infer<typeof AppealEditSchema>, @Req() req: Request) {
    return this.appeals.update(user.id, id, dto, { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null });
  }

  /** APPEAL по экзамену: отзыв (только PENDING), история сохраняется */
  @Post(':id/withdraw')
  @RequirePermission('requests.create')
  withdraw(@CurrentUser() user: CurrentUserData, @Param('id') id: string, @Req() req: Request) {
    return this.appeals.withdraw(user.id, id, { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null });
  }

  @Post()
  @RequirePermission('requests.create')
  create(
    @CurrentUser() user: CurrentUserData,
    @Body(new ZodValidationPipe(CreateRequestSchema)) dto: CreateRequestDto,
    @Req() req: Request,
  ) {
    return this.svc.create(user.id, dto, {
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @Patch(':id')
  @RequirePermission('requests.create')
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateRequestSchema)) dto: UpdateRequestDto,
    @Req() req: Request,
  ) {
    return this.svc.updateMine(user.id, id, dto, {
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @Delete(':id')
  @RequirePermission('requests.create')
  remove(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    return this.svc.deleteMine(user.id, id, {
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }
}
