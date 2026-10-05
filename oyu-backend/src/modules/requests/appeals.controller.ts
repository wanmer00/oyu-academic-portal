import { Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { z } from 'zod';
import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { RequirePermission } from '../../common/rbac/require-permission.decorator';
import { AppealInputSchema, AppealsService, DecideSchema, EscalateSchema, ItemDecisionSchema } from './appeals.service';

const ctxOf = (req: Request) => ({ ip: req.ip ?? null, userAgent: (req.headers['user-agent'] as string) ?? null });
const actor = (u: CurrentUserData) => ({ id: u.id, role: u.role });
/** очередь рассмотрения — только сотрудникам (scope ASSIGNED / ALL); OWN (студент) сюда не проходит */
const STAFF = { scopes: ['ASSIGNED', 'ALL'] as Array<'ASSIGNED' | 'ALL'> };

/** Студент: Exam Review по опубликованному результату + статус окна апелляции для dashboard */
@Controller('me')
export class StudentAppealsController {
  constructor(private readonly svc: AppealsService) {}

  @Get('exam-results/:id/review') @RequirePermission('appeals.view', { scopes: ['OWN'] })
  review(@CurrentUser() u: CurrentUserData, @Param('id') id: string) { return this.svc.review(u.id, id); }

  @Get('exam-appeals/summary') @RequirePermission('appeals.view', { scopes: ['OWN'] })
  summary(@CurrentUser() u: CurrentUserData) { return this.svc.dashboard(u.id); }
}

/** Общие действия рассмотрения — один сервис, область доступа определяется ролью (teacher: свои пары, руководство: своя область) */
abstract class StaffAppeals {
  constructor(protected readonly svc: AppealsService) {}

  @Get() @RequirePermission('appeals.view', STAFF)
  list(@CurrentUser() u: CurrentUserData, @Query() q: Record<string, string>) { return this.svc.list(actor(u), q); }

  @Get('analytics') @RequirePermission('appeals.view', STAFF)
  analytics(@CurrentUser() u: CurrentUserData) { return this.svc.analytics(actor(u)); }

  @Get(':id') @RequirePermission('appeals.view', STAFF)
  detail(@CurrentUser() u: CurrentUserData, @Param('id') id: string) { return this.svc.detail(actor(u), id); }

  @Post(':id/start') @RequirePermission('appeals.review')
  start(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Req() req: Request) { return this.svc.start(actor(u), id, ctxOf(req)); }

  @Post(':id/escalate') @RequirePermission('appeals.review')
  escalate(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Body(new ZodValidationPipe(EscalateSchema)) b: z.infer<typeof EscalateSchema>, @Req() req: Request) { return this.svc.escalate(actor(u), id, b.reason, ctxOf(req)); }

  @Put(':id/items/:itemId') @RequirePermission('appeals.adjust_grade')
  item(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Param('itemId') itemId: string, @Body(new ZodValidationPipe(ItemDecisionSchema)) b: z.infer<typeof ItemDecisionSchema>, @Req() req: Request) { return this.svc.decideItem(actor(u), id, itemId, b, ctxOf(req)); }

  @Post(':id/decide') @RequirePermission('appeals.decide')
  decide(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Body(new ZodValidationPipe(DecideSchema)) b: z.infer<typeof DecideSchema>, @Req() req: Request) { return this.svc.decide(actor(u), id, b.note, ctxOf(req)); }
}

@Controller('teacher/requests/appeals')
export class TeacherAppealsController extends StaffAppeals {
  constructor(svc: AppealsService) { super(svc); }
}

@Controller('admin/requests/appeals')
export class AdminAppealsController extends StaffAppeals {
  constructor(svc: AppealsService) { super(svc); }
}

export const AppealEditSchema = AppealInputSchema.omit({ resultId: true });
