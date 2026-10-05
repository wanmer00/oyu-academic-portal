import { Body, Controller, Delete, Get, Post, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { z } from 'zod';
import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { Grant } from '../../common/rbac/permissions.service';
import { CurrentGrant, RequirePermission } from '../../common/rbac/require-permission.decorator';
import { AttendanceService } from './attendance.service';
import { ClearSchema, DayQuerySchema, ExportQuerySchema, MarkSchema, ReportQuerySchema, StatsQuerySchema, StudentQuerySchema } from './attendance.dto';

type Q<T extends z.ZodTypeAny> = z.infer<T>;
const ctxOf = (req: Request) => ({ ip: req.ip ?? null, userAgent: (req.headers['user-agent'] as string) ?? null });

/**
 * Academic Journal → Attendance. Единственный API посещаемости.
 * Право проверяет PermissionsGuard, scope (свои / дети / назначенные / все) — AttendanceService.
 */
@Controller('journal/attendance')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get('day')
  @RequirePermission('attendance.view')
  day(@CurrentUser() u: CurrentUserData, @CurrentGrant() g: Grant, @Query(new ZodValidationPipe(DayQuerySchema)) q: Q<typeof DayQuerySchema>) {
    return this.attendance.day(u, g, q);
  }

  @Post()
  @RequirePermission('attendance.create')
  mark(@CurrentUser() u: CurrentUserData, @CurrentGrant() g: Grant, @Body(new ZodValidationPipe(MarkSchema)) dto: Q<typeof MarkSchema>, @Req() req: Request) {
    return this.attendance.mark(u, g, dto, ctxOf(req));
  }

  @Delete()
  @RequirePermission('attendance.delete')
  clear(@CurrentUser() u: CurrentUserData, @CurrentGrant() g: Grant, @Body(new ZodValidationPipe(ClearSchema)) dto: Q<typeof ClearSchema>, @Req() req: Request) {
    return this.attendance.clear(u, g, dto, ctxOf(req));
  }

  @Get('stats')
  @RequirePermission('attendance.statistics')
  stats(@CurrentUser() u: CurrentUserData, @CurrentGrant() g: Grant, @Query(new ZodValidationPipe(StatsQuerySchema)) q: Q<typeof StatsQuerySchema>) {
    return this.attendance.stats(u, g, q);
  }

  @Get('export.csv')
  @RequirePermission('reports.export')
  async export(
    @CurrentUser() u: CurrentUserData,
    @CurrentGrant() g: Grant,
    @Query(new ZodValidationPipe(ExportQuerySchema)) q: Q<typeof ExportQuerySchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const csv = await this.attendance.exportCsv(u, g, q, ctxOf(req));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="attendance.csv"', 'Cache-Control': 'no-store' });
    return csv;
  }

  /** Посещаемость студента: студент — своя, преподаватель — своих групп, администратор — любого */
  @Get('student')
  @RequirePermission('attendance.view')
  student(@CurrentUser() u: CurrentUserData, @CurrentGrant() g: Grant, @Query(new ZodValidationPipe(StudentQuerySchema)) q: Q<typeof StudentQuerySchema>) {
    return this.attendance.student(u, g, q);
  }

  @Get('report')
  @RequirePermission('reports.view')
  report(@CurrentUser() u: CurrentUserData, @CurrentGrant() g: Grant, @Query(new ZodValidationPipe(ReportQuerySchema)) q: Q<typeof ReportQuerySchema>) {
    return this.attendance.report(u, g, q);
  }
}
