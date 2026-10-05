import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { z } from 'zod';
import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { Grant, PermissionsService } from '../../common/rbac/permissions.service';
import { CurrentGrant, RequirePermission } from '../../common/rbac/require-permission.decorator';
import { ScopeService } from '../../common/rbac/scope.service';
import { JournalAuditService } from './journal-audit.service';
import { JournalExportService } from './journal-export.service';
import { JournalWriteService } from './journal-write.service';
import {
  AddSeminarSchema,
  AuditQuerySchema,
  BulkSchema,
  CellsSchema,
  CompareQuerySchema,
  DetailQuerySchema,
  ExportQuerySchema,
  ImportSchema,
  MeQuerySchema,
  PeriodPatchSchema,
  PublishSchema,
  RecordsQuerySchema,
  SetComponentSchema,
  UnpublishSchema,
  UpdateGradeSchema,
} from './journal.dto';
import { JournalService, Viewer } from './journal.service';
import { PeriodService } from './period.service';

type Q<T extends z.ZodTypeAny> = z.infer<T>;
const ctxOf = (req: Request) => ({ ip: req.ip ?? null, userAgent: (req.headers['user-agent'] as string) ?? null });
const idParam = z.string().min(1).max(40);

/**
 * Academic Journal — ЕДИНЫЙ модуль для всех ролей.
 * Доступ задают права (grades.*, reports.*, periods.manage, audit.view) и их scope из PermissionsGuard;
 * userId — только из JWT. Объектные ограничения (свои / дети / назначенные пары) применяют сервисы.
 * Посещаемость журнала — /journal/attendance/* (AttendanceModule).
 */
@Controller('journal')
export class JournalController {
  constructor(
    private readonly journal: JournalService,
    private readonly write: JournalWriteService,
    private readonly audit: JournalAuditService,
    private readonly exporter: JournalExportService,
    private readonly periods: PeriodService,
    private readonly perms: PermissionsService,
    private readonly scopes: ScopeService,
  ) {}

  /** Viewer = пользователь + scope текущего права + его права записи */
  private async viewer(u: CurrentUserData, g: Grant): Promise<Viewer> {
    const has = (p: string) => this.perms.has(u.role, p);
    const [create, update, del, publish, override] = await Promise.all([has('grades.create'), has('grades.update'), has('grades.delete'), has('grades.publish'), has('grades.override')]);
    return { id: u.id, role: u.role, scope: g.scope, caps: { create, update, delete: del, publish, override } };
  }

  // ── общее ──
  @Get('meta')
  @RequirePermission('grades.view')
  async meta(@CurrentUser() u: CurrentUserData, @CurrentGrant() g: Grant) {
    const meta = await this.journal.meta(await this.viewer(u, g));
    const attendance = await Promise.all(['attendance.view', 'attendance.create', 'attendance.update', 'attendance.delete', 'attendance.statistics', 'attendance.override', 'reports.view', 'reports.export', 'periods.manage', 'audit.view'].map(async (p) => [p, await this.perms.grant(u.role, p)] as const));
    return { ...meta, permissions: Object.fromEntries(attendance.filter(([, gr]) => gr).map(([p, gr]) => [p, gr!.scope])) };
  }

  // ── Студент (или, по scope, сотрудник): журнал одного студента, только опубликованное ──
  @Get('me')
  @RequirePermission('grades.view')
  async me(@CurrentUser() u: CurrentUserData, @CurrentGrant() g: Grant, @Query(new ZodValidationPipe(MeQuerySchema)) q: Q<typeof MeQuerySchema>) {
    const { studentId, ...period } = q;
    return this.journal.myJournal(await this.scopes.resolveStudentId(u, g, studentId), period);
  }

  @Get('me/subjects/:subjectId')
  @RequirePermission('grades.view')
  async meSubject(
    @CurrentUser() u: CurrentUserData,
    @CurrentGrant() g: Grant,
    @Param('subjectId', new ZodValidationPipe(idParam)) subjectId: string,
    @Query(new ZodValidationPipe(MeQuerySchema)) q: Q<typeof MeQuerySchema>,
  ) {
    const { studentId, ...period } = q;
    return this.journal.myJournalSubject(await this.scopes.resolveStudentId(u, g, studentId), subjectId, period);
  }

  // ── Записи журнала: scope ASSIGNED (свои пары) или ALL ──
  @Get('records')
  @RequirePermission('grades.view')
  async records(@CurrentUser() u: CurrentUserData, @CurrentGrant() g: Grant, @Query(new ZodValidationPipe(RecordsQuerySchema)) q: Q<typeof RecordsQuerySchema>) {
    const { page, pageSize, ...filters } = q;
    return this.journal.records(await this.viewer(u, g), filters, page, pageSize);
  }

  @Get('records/:studentId/:subjectId')
  @RequirePermission('grades.view')
  async detail(
    @CurrentUser() u: CurrentUserData,
    @CurrentGrant() g: Grant,
    @Param('studentId', new ZodValidationPipe(idParam)) studentId: string,
    @Param('subjectId', new ZodValidationPipe(idParam)) subjectId: string,
    @Query(new ZodValidationPipe(DetailQuerySchema)) q: Q<typeof DetailQuerySchema>,
  ) {
    return this.journal.recordDetail(await this.viewer(u, g), studentId, subjectId, q);
  }

  @Get('analytics')
  @RequirePermission('reports.view')
  async analytics(@CurrentUser() u: CurrentUserData, @CurrentGrant() g: Grant, @Query(new ZodValidationPipe(RecordsQuerySchema)) q: Q<typeof RecordsQuerySchema>) {
    const { page, pageSize, ...filters } = q;
    void page; void pageSize;
    return this.journal.analytics(await this.viewer(u, g), filters);
  }

  @Get('compare')
  @RequirePermission('reports.view')
  async compare(@CurrentUser() u: CurrentUserData, @CurrentGrant() g: Grant, @Query(new ZodValidationPipe(CompareQuerySchema)) q: Q<typeof CompareQuerySchema>) {
    const { groups, ...rest } = q;
    return this.journal.compare(await this.viewer(u, g), groups.split(',').map((x) => x.trim()).filter(Boolean), rest);
  }

  @Get('export')
  @RequirePermission('reports.export')
  async export(
    @CurrentUser() u: CurrentUserData,
    @CurrentGrant() g: Grant,
    @Query(new ZodValidationPipe(ExportQuerySchema)) q: Q<typeof ExportQuerySchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { kind, ...filters } = q;
    const csv = await this.exporter.export(await this.viewer(u, g), filters, kind, ctxOf(req));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="journal-${kind}.csv"`, 'Cache-Control': 'no-store' });
    return csv;
  }

  // ── Запись: grades.create / update / delete / publish ──
  @Post('seminar-answers')
  @RequirePermission('grades.create')
  async addSeminar(@CurrentUser() u: CurrentUserData, @CurrentGrant() g: Grant, @Body(new ZodValidationPipe(AddSeminarSchema)) dto: Q<typeof AddSeminarSchema>, @Req() req: Request) {
    return this.write.addSeminar(await this.viewer(u, g), dto, ctxOf(req));
  }

  @Put('components')
  @RequirePermission('grades.create')
  async setComponent(@CurrentUser() u: CurrentUserData, @CurrentGrant() g: Grant, @Body(new ZodValidationPipe(SetComponentSchema)) dto: Q<typeof SetComponentSchema>, @Req() req: Request) {
    return this.write.setComponent(await this.viewer(u, g), dto, ctxOf(req));
  }

  @Patch('grades/:id')
  @RequirePermission('grades.update')
  async updateGrade(
    @CurrentUser() u: CurrentUserData,
    @CurrentGrant() g: Grant,
    @Param('id', new ZodValidationPipe(idParam)) id: string,
    @Body(new ZodValidationPipe(UpdateGradeSchema)) dto: Q<typeof UpdateGradeSchema>,
    @Req() req: Request,
  ) {
    return this.write.updateGrade(await this.viewer(u, g), id, dto, ctxOf(req));
  }

  @Delete('grades/:id')
  @RequirePermission('grades.delete')
  async deleteGrade(
    @CurrentUser() u: CurrentUserData,
    @CurrentGrant() g: Grant,
    @Param('id', new ZodValidationPipe(idParam)) id: string,
    @Query('reason', new ZodValidationPipe(z.string().trim().max(500).optional())) reason: string | undefined,
    @Req() req: Request,
  ) {
    return this.write.deleteGrade(await this.viewer(u, g), id, reason, ctxOf(req));
  }

  @Post('cells')
  @RequirePermission('grades.create')
  async cells(@CurrentUser() u: CurrentUserData, @CurrentGrant() g: Grant, @Body(new ZodValidationPipe(CellsSchema)) dto: Q<typeof CellsSchema>, @Req() req: Request) {
    return this.write.applyCells(await this.viewer(u, g), dto, ctxOf(req));
  }

  @Post('publish')
  @RequirePermission('grades.publish')
  async publish(@CurrentUser() u: CurrentUserData, @CurrentGrant() g: Grant, @Body(new ZodValidationPipe(PublishSchema)) dto: Q<typeof PublishSchema>, @Req() req: Request) {
    return this.write.publish(await this.viewer(u, g), dto, ctxOf(req));
  }

  @Post('unpublish')
  @RequirePermission('grades.publish')
  async unpublish(@CurrentUser() u: CurrentUserData, @CurrentGrant() g: Grant, @Body(new ZodValidationPipe(UnpublishSchema)) dto: Q<typeof UnpublishSchema>, @Req() req: Request) {
    return this.write.unpublish(await this.viewer(u, g), dto, ctxOf(req));
  }

  @Post('bulk/preview')
  @RequirePermission('grades.create')
  async bulkPreview(@CurrentUser() u: CurrentUserData, @CurrentGrant() g: Grant, @Body(new ZodValidationPipe(BulkSchema)) dto: Q<typeof BulkSchema>) {
    return this.write.bulkPreview(await this.viewer(u, g), dto);
  }

  @Post('bulk')
  @RequirePermission('grades.create')
  async bulk(@CurrentUser() u: CurrentUserData, @CurrentGrant() g: Grant, @Body(new ZodValidationPipe(BulkSchema)) dto: Q<typeof BulkSchema>, @Req() req: Request) {
    return this.write.bulkApply(await this.viewer(u, g), dto, ctxOf(req));
  }

  @Post('import/preview')
  @RequirePermission('grades.create')
  async importPreview(@CurrentUser() u: CurrentUserData, @CurrentGrant() g: Grant, @Body(new ZodValidationPipe(ImportSchema)) dto: Q<typeof ImportSchema>) {
    return this.write.importPreview(await this.viewer(u, g), dto);
  }

  @Post('import')
  @RequirePermission('grades.create')
  async importApply(@CurrentUser() u: CurrentUserData, @CurrentGrant() g: Grant, @Body(new ZodValidationPipe(ImportSchema)) dto: Q<typeof ImportSchema>, @Req() req: Request) {
    return this.write.importApply(await this.viewer(u, g), dto, ctxOf(req));
  }

  // ── Блокировка периода (periods.manage) ──
  @Patch('periods/:id')
  @RequirePermission('periods.manage', { requireAll: true })
  period(
    @CurrentUser() u: CurrentUserData,
    @Param('id', new ZodValidationPipe(idParam)) id: string,
    @Body(new ZodValidationPipe(PeriodPatchSchema)) dto: Q<typeof PeriodPatchSchema>,
    @Req() req: Request,
  ) {
    return this.periods.setStatus(u.id, id, dto.status, dto.reason, ctxOf(req));
  }

  // ── Read-only история изменений (audit.view) ──
  @Get('audit')
  @RequirePermission('audit.view', { requireAll: true })
  auditFeed(@Query(new ZodValidationPipe(AuditQuerySchema)) q: Q<typeof AuditQuerySchema>) {
    return this.audit.feed(q);
  }

  @Get('audit/stats')
  @RequirePermission('audit.view', { requireAll: true })
  auditStats() {
    return this.audit.stats();
  }
}
