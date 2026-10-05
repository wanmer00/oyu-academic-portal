import { Body, Controller, Get, Param, Patch, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { RequestStatus } from '@prisma/client';
import { z } from 'zod';

import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { RequirePermission } from '../../common/rbac/require-permission.decorator';
import { TeachersService } from './teachers.service';
import { AnalyticsQuerySchema, ReplyRequestDto, ReplyRequestSchema } from './dto';

const StatusQuery = z.object({ status: z.nativeEnum(RequestStatus).optional() });
type Q<T extends z.ZodTypeAny> = z.infer<T>;

function auditCtx(req: Request) {
  return { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null };
}

// Рабочее место преподавателя: данные строго его пар «предмет × группа» (TeacherAccessService, scope ASSIGNED).
// Посещаемость и оценки — в Academic Journal (/journal/*), здесь их нет.
@Controller('teacher')
export class TeachersController {
  constructor(private readonly teachers: TeachersService) {}

  @Get('me')
  @RequirePermission('groups.view')
  me(@CurrentUser() user: CurrentUserData) {
    return this.teachers.getMyProfile(user.id);
  }

  @Get('dashboard')
  @RequirePermission('groups.view')
  dashboard(@CurrentUser() user: CurrentUserData) {
    return this.teachers.getDashboard(user.id);
  }

  @Get('classes')
  @RequirePermission('groups.view')
  classes(@CurrentUser() user: CurrentUserData) {
    return this.teachers.getClasses(user.id);
  }

  @Get('subjects')
  @RequirePermission('subjects.view')
  subjects(@CurrentUser() user: CurrentUserData) {
    return this.teachers.getMySubjects(user.id);
  }

  @Get('groups')
  @RequirePermission('groups.view')
  groups(@CurrentUser() user: CurrentUserData) {
    return this.teachers.getGroupsWithStudents(user.id);
  }

  @Get('schedule')
  @RequirePermission('schedule.view')
  schedule(@CurrentUser() user: CurrentUserData) {
    return this.teachers.getTeacherSchedule(user.id);
  }

  @Get('analytics')
  @RequirePermission('reports.view')
  analytics(@CurrentUser() user: CurrentUserData, @Query(new ZodValidationPipe(AnalyticsQuerySchema)) q: Q<typeof AnalyticsQuerySchema>) {
    return this.teachers.getAnalytics(user.id, q.groupName, q.subjectCode);
  }

  // ── Requests (только заявки студентов из групп преподавателя, типы APPEAL/OTHER) ──
  @Get('requests')
  @RequirePermission('requests.review')
  listRequests(@CurrentUser() user: CurrentUserData, @Query(new ZodValidationPipe(StatusQuery)) q: Q<typeof StatusQuery>) {
    return this.teachers.listRequests(user.id, q.status);
  }

  @Patch('requests/:id')
  @RequirePermission('requests.review')
  replyRequest(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReplyRequestSchema)) dto: ReplyRequestDto,
    @Req() req: Request,
  ) {
    return this.teachers.replyRequest(user.id, id, dto, auditCtx(req));
  }
}
