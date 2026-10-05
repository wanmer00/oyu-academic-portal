import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';

import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/rbac/require-permission.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { CalendarService } from './calendar.service';
import { CheckEventDto, CheckEventSchema, CreateEventDto, CreateEventSchema, UpdateEventDto, UpdateEventSchema } from './dto';

function audit(req: Request) {
  return { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null };
}

// ── Любой authed видит свой календарь ──
@Controller('me/calendar')
@RequirePermission('calendar.view')
export class MyCalendarController {
  constructor(private readonly svc: CalendarService) {}

  @Get()
  list(
    @CurrentUser() user: CurrentUserData,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.svc.listForUser(user.id, from, to);
  }
}

// ── LEADERSHIP: управление календарём ──
@Controller('admin/calendar')
@RequirePermission('calendar.manage', { requireAll: true })
export class AdminCalendarController {
  constructor(private readonly svc: CalendarService) {}

  @Get()
  list(@Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.listAll(from, to);
  }

  // Проверка конфликтов без сохранения (для формы)
  @Post('check')
  check(@Body(new ZodValidationPipe(CheckEventSchema)) dto: CheckEventDto) {
    return this.svc.check(dto);
  }

  @Post()
  create(
    @CurrentUser() user: CurrentUserData,
    @Body(new ZodValidationPipe(CreateEventSchema)) dto: CreateEventDto,
    @Req() req: Request,
  ) {
    return this.svc.create(user.id, dto, audit(req));
  }

  @Patch(':id')
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateEventSchema)) dto: UpdateEventDto,
    @Req() req: Request,
  ) {
    return this.svc.update(user.id, id, dto, audit(req));
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    return this.svc.delete(user.id, id, audit(req));
  }
}
