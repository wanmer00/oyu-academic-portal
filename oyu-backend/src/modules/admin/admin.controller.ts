import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { RequestStatus, RequestType, Term } from '@prisma/client';
import { z } from 'zod';

import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { RequirePermission } from '../../common/rbac/require-permission.decorator';
import { AdminService } from './admin.service';
import { AdminAnalyticsService } from './admin-analytics.service';
import { AdminOverviewService } from './admin-overview.service';
import { OrgScopeService } from '../../common/rbac/org-scope.service';
import { CreateRoomDto, CreateRoomSchema, UpdateRoomDto, UpdateRoomSchema } from './dto';

const UpdateRequestSchema = z
  .object({
    status: z.nativeEnum(RequestStatus),
    adminNote: z.string().max(500).optional(),
  })
  .strict();

const RequestsQuery = z.object({
  status: z.nativeEnum(RequestStatus).optional(),
  type: z.nativeEnum(RequestType).optional(),
  scope: z.enum(['admin', 'all']).default('admin'),
});
const KpiQuery = z.object({ weeks: z.coerce.number().int().min(4).max(52).default(12) });
const auditCtx = (req: Request) => ({ ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null });

/** Эти обработчики не ограничивают данные по scope — поэтому требуется scope ALL */
const ALL = { requireAll: true } as const;

/**
 * Admin Panel: операционные разделы (dashboard, KPI, schedule, rooms, requests, analytics).
 * Доступ — по правам (PermissionsGuard), роль в коде не проверяется.
 */
@Controller('admin')
export class AdminController {
  constructor(
    private readonly org: OrgScopeService,
    private readonly admin: AdminService,
    private readonly overview: AdminOverviewService,
    private readonly analytics: AdminAnalyticsService,
  ) {}

  // ─── Dashboard / KPI ───
  @Get('dashboard')
  @RequirePermission('admin.access', ALL)
  async dashboard(@CurrentUser() u: CurrentUserData) { return this.overview.dashboard(await this.org.forUser(u)); }

  @Get('kpi')
  @RequirePermission('reports.view', ALL)
  async kpi(@CurrentUser() u: CurrentUserData, @Query(new ZodValidationPipe(KpiQuery)) q: z.infer<typeof KpiQuery>) { return this.overview.kpi(q.weeks, (await this.org.forUser(u)).groups); }

  // ─── Analytics ───
  @Get('analytics/heatmap')
  @RequirePermission('reports.view', ALL)
  heatmap() { return this.analytics.groupHeatmap(); }

  @Get('analytics/dropout-risk')
  @RequirePermission('reports.view', ALL)
  dropoutRisk(@Query('minScore') minScore?: string) {
    const ms = minScore ? parseInt(minScore, 10) : 40;
    return this.analytics.dropoutRisk(Number.isFinite(ms) ? ms : 40);
  }

  @Get('analytics/teacher-stats')
  @RequirePermission('reports.view', ALL)
  teacherStats() { return this.analytics.teacherStats(); }

  @Get('analytics/payments-overview')
  @RequirePermission('payments.view', ALL)
  paymentsOverview() { return this.analytics.paymentsOverview(); }

  @Get('analytics/schedule-conflicts')
  @RequirePermission('schedule.view', ALL)
  scheduleConflicts(@Query('academicYear') ay?: string, @Query('term') term?: Term) {
    return this.analytics.scheduleConflicts(ay, term as any);
  }

  // ─── Requests ───
  @Get('requests')
  @RequirePermission('requests.view', ALL)
  async requests(@CurrentUser() u: CurrentUserData, @Query(new ZodValidationPipe(RequestsQuery)) q: z.infer<typeof RequestsQuery>) {
    return this.admin.listRequests(q.status, q.type, q.scope, (await this.org.forUser(u)).groups);
  }

  @Patch('requests/:id')
  @RequirePermission('requests.review', ALL)
  async updateRequest(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateRequestSchema)) dto: z.infer<typeof UpdateRequestSchema>,
    @Req() req: Request,
  ) {
    return this.admin.updateRequestStatus(id, dto.status, dto.adminNote, user.id, auditCtx(req), (await this.org.forUser(user)).groups);
  }

  // ─── Rooms ───
  @Get('rooms')
  @RequirePermission('schedule.view', ALL)
  rooms() { return this.admin.listRooms(); }

  @Post('rooms')
  @RequirePermission('schedule.create', ALL)
  createRoom(@CurrentUser() user: CurrentUserData, @Body(new ZodValidationPipe(CreateRoomSchema)) dto: CreateRoomDto, @Req() req: Request) {
    return this.admin.createRoom(dto, user.id, auditCtx(req));
  }

  @Patch('rooms/:id')
  @RequirePermission('schedule.update', ALL)
  updateRoom(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateRoomSchema)) dto: UpdateRoomDto,
    @Req() req: Request,
  ) {
    return this.admin.updateRoom(id, dto, user.id, auditCtx(req));
  }

  @Delete('rooms/:id')
  @RequirePermission('schedule.delete', ALL)
  deleteRoom(@CurrentUser() user: CurrentUserData, @Param('id') id: string, @Req() req: Request) {
    return this.admin.deleteRoom(id, user.id, auditCtx(req));
  }
}
