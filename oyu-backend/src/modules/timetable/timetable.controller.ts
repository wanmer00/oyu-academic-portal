import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { Request, Response } from 'express';
import { z } from 'zod';
import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { RequirePermission } from '../../common/rbac/require-permission.decorator';
import { TimetableConfigService } from './timetable.config.service';
import { TimetableConflictsService } from './timetable.conflicts.service';
import { TimetableExportService } from './timetable.export.service';
import { TimetableJobsService } from './timetable.jobs.service';
import { TimetableLessonsService } from './timetable.lessons.service';
import { TimetableRequirementsService } from './timetable.requirements.service';
import { TimetableVersionsService } from './timetable.versions.service';
import {
  BuildRequirementsSchema, BulkLockSchema, CalendarQuery, ConfigPatchSchema, ConflictsQuery, CreateLessonSchema, CreateVersionSchema, ExportQuery, GenerateSchema,
  ImportRequirementsSchema, LessonTypePatchSchema, LessonTypeSchema, LessonsQuery, MyAvailabilitySchema, PeriodQuery, RequirementPatchSchema, RequirementSchema, RequirementsQuery,
  RuleSchema, RulesQuery, TimeSlotPatchSchema, TimeSlotSchema, UpdateLessonSchema, VersionPatchSchema, VersionsQuery,
} from './timetable.dto';

type Q<T extends z.ZodTypeAny> = z.infer<T>;
const ctxOf = (req: Request) => ({ ip: req.ip ?? null, userAgent: (req.headers['user-agent'] as string) ?? null });
const idPipe = new ZodValidationPipe(z.string().min(1).max(40));
const ALL = { requireAll: true } as const;

/**
 * Admin Panel → Расписание. Все маршруты проверяются по правам schedule.* (PermissionsGuard);
 * просмотр административных данных — scope ALL. Личное расписание студента/преподавателя — /timetable/me/calendar.
 */
@Controller('timetable')
export class TimetableController {
  constructor(
    private readonly config: TimetableConfigService,
    private readonly requirements: TimetableRequirementsService,
    private readonly versions: TimetableVersionsService,
    private readonly lessons: TimetableLessonsService,
    private readonly conflicts: TimetableConflictsService,
    private readonly jobs: TimetableJobsService,
    private readonly exporter: TimetableExportService,
  ) {}

  // ═══════════ справочники и настройки ═══════════
  @Get('refs')
  @RequirePermission('schedule.view', ALL)
  refs(@Query(new ZodValidationPipe(PeriodQuery)) q: Q<typeof PeriodQuery>) { return this.config.refs(q.academicYear, q.term); }

  @Get('config')
  @RequirePermission('schedule.view', ALL)
  getConfig(@Query(new ZodValidationPipe(PeriodQuery)) q: Q<typeof PeriodQuery>) { return this.config.getConfig(q.academicYear, q.term); }

  @Patch('config')
  @RequirePermission('schedule.settings', ALL)
  patchConfig(@CurrentUser() u: CurrentUserData, @Query(new ZodValidationPipe(PeriodQuery)) q: Q<typeof PeriodQuery>, @Body(new ZodValidationPipe(ConfigPatchSchema)) dto: Q<typeof ConfigPatchSchema>, @Req() req: Request) {
    return this.config.patchConfig(u, q.academicYear, q.term, dto, ctxOf(req));
  }

  @Get('time-slots')
  @RequirePermission('schedule.view', ALL)
  slots() { return this.config.timeSlots(); }

  @Post('time-slots')
  @RequirePermission('schedule.settings', ALL)
  createSlot(@CurrentUser() u: CurrentUserData, @Body(new ZodValidationPipe(TimeSlotSchema)) dto: Q<typeof TimeSlotSchema>, @Req() req: Request) { return this.config.createSlot(u, dto, ctxOf(req)); }

  @Patch('time-slots/:id')
  @RequirePermission('schedule.settings', ALL)
  patchSlot(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string, @Body(new ZodValidationPipe(TimeSlotPatchSchema)) dto: Q<typeof TimeSlotPatchSchema>, @Req() req: Request) { return this.config.patchSlot(u, id, dto, ctxOf(req)); }

  @Delete('time-slots/:id')
  @RequirePermission('schedule.settings', ALL)
  deleteSlot(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string, @Req() req: Request) { return this.config.deleteSlot(u, id, ctxOf(req)); }

  @Get('lesson-types')
  @RequirePermission('schedule.view', ALL)
  types() { return this.config.lessonTypes(); }

  @Post('lesson-types')
  @RequirePermission('schedule.settings', ALL)
  createType(@CurrentUser() u: CurrentUserData, @Body(new ZodValidationPipe(LessonTypeSchema)) dto: Q<typeof LessonTypeSchema>, @Req() req: Request) { return this.config.createType(u, dto, ctxOf(req)); }

  @Patch('lesson-types/:id')
  @RequirePermission('schedule.settings', ALL)
  patchType(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string, @Body(new ZodValidationPipe(LessonTypePatchSchema)) dto: Q<typeof LessonTypePatchSchema>, @Req() req: Request) { return this.config.patchType(u, id, dto, ctxOf(req)); }

  @Delete('lesson-types/:id')
  @RequirePermission('schedule.settings', ALL)
  deleteType(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string, @Req() req: Request) { return this.config.deleteType(u, id, ctxOf(req)); }

  @Get('rules')
  @RequirePermission('schedule.view', ALL)
  rules(@Query(new ZodValidationPipe(RulesQuery)) q: Q<typeof RulesQuery>) { return this.config.listRules(q); }

  @Post('rules')
  @RequirePermission('schedule.settings', ALL)
  createRule(@CurrentUser() u: CurrentUserData, @Body(new ZodValidationPipe(RuleSchema)) dto: Q<typeof RuleSchema>, @Req() req: Request) { return this.config.createRule(u, dto, ctxOf(req)); }

  @Patch('rules/:id')
  @RequirePermission('schedule.settings', ALL)
  patchRule(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string, @Body(new ZodValidationPipe(RuleSchema.innerType().partial().strict())) dto: Partial<Q<typeof RuleSchema>>, @Req() req: Request) { return this.config.patchRule(u, id, dto, ctxOf(req)); }

  @Delete('rules/:id')
  @RequirePermission('schedule.settings', ALL)
  deleteRule(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string, @Req() req: Request) { return this.config.deleteRule(u, id, ctxOf(req)); }

  /** Преподаватель указывает свои пожелания по времени (мягкие правила, учитываются при генерации) */
  @Get('availability/me')
  @RequirePermission('schedule.availability')
  myAvailability(@CurrentUser() u: CurrentUserData) { return this.config.myAvailability(u.id); }

  @Put('availability/me')
  @RequirePermission('schedule.availability')
  setMyAvailability(@CurrentUser() u: CurrentUserData, @Body(new ZodValidationPipe(MyAvailabilitySchema)) dto: Q<typeof MyAvailabilitySchema>, @Req() req: Request) { return this.config.setMyAvailability(u, dto, ctxOf(req)); }

  // ═══════════ нагрузка (учебный план на период) ═══════════
  @Get('requirements')
  @RequirePermission('schedule.view', ALL)
  listRequirements(@Query(new ZodValidationPipe(RequirementsQuery.extend({ versionId: z.string().max(40).optional() }))) q: Q<typeof RequirementsQuery> & { versionId?: string }) { return this.requirements.list(q); }

  @Post('requirements')
  @RequirePermission('schedule.settings', ALL)
  createRequirement(@CurrentUser() u: CurrentUserData, @Body(new ZodValidationPipe(RequirementSchema)) dto: Q<typeof RequirementSchema>, @Req() req: Request) { return this.requirements.create(u, dto, ctxOf(req)); }

  @Post('requirements/build')
  @RequirePermission('schedule.settings', ALL)
  buildRequirements(@CurrentUser() u: CurrentUserData, @Body(new ZodValidationPipe(BuildRequirementsSchema)) dto: Q<typeof BuildRequirementsSchema>, @Req() req: Request) { return this.requirements.build(u, dto, ctxOf(req)); }

  @Post('requirements/import')
  @RequirePermission('schedule.settings', ALL)
  importRequirements(@CurrentUser() u: CurrentUserData, @Body(new ZodValidationPipe(ImportRequirementsSchema)) dto: Q<typeof ImportRequirementsSchema>, @Req() req: Request) { return this.requirements.import(u, dto, ctxOf(req)); }

  @Patch('requirements/:id')
  @RequirePermission('schedule.settings', ALL)
  patchRequirement(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string, @Body(new ZodValidationPipe(RequirementPatchSchema)) dto: Q<typeof RequirementPatchSchema>, @Req() req: Request) { return this.requirements.patch(u, id, dto, ctxOf(req)); }

  @Delete('requirements/:id')
  @RequirePermission('schedule.settings', ALL)
  deleteRequirement(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string, @Req() req: Request) { return this.requirements.remove(u, id, ctxOf(req)); }

  // ═══════════ версии расписания ═══════════
  @Get('versions')
  @RequirePermission('schedule.view', ALL)
  listVersions(@Query(new ZodValidationPipe(VersionsQuery)) q: Q<typeof VersionsQuery>) { return this.versions.list(q); }

  @Post('versions')
  @RequirePermission('schedule.create', ALL)
  createVersion(@CurrentUser() u: CurrentUserData, @Body(new ZodValidationPipe(CreateVersionSchema)) dto: Q<typeof CreateVersionSchema>, @Req() req: Request) { return this.versions.createDraft(u, dto, ctxOf(req)); }

  @Get('versions/:id')
  @RequirePermission('schedule.view', ALL)
  getVersion(@Param('id', idPipe) id: string) { return this.versions.get(id); }

  @Get('versions/:id/overview')
  @RequirePermission('schedule.view', ALL)
  overview(@Param('id', idPipe) id: string) { return this.versions.overview(id); }

  @Patch('versions/:id')
  @RequirePermission('schedule.update', ALL)
  patchVersion(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string, @Body(new ZodValidationPipe(VersionPatchSchema)) dto: Q<typeof VersionPatchSchema>) { return this.versions.patch(u, id, dto); }

  @Post('versions/:id/review')
  @RequirePermission('schedule.update', ALL)
  review(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string, @Req() req: Request) { return this.versions.submitReview(u, id, ctxOf(req)); }

  @Post('versions/:id/draft')
  @RequirePermission('schedule.update', ALL)
  draft(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string, @Req() req: Request) { return this.versions.backToDraft(u, id, ctxOf(req)); }

  @Post('versions/:id/archive')
  @RequirePermission('schedule.update', ALL)
  archive(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string, @Req() req: Request) { return this.versions.archive(u, id, ctxOf(req)); }

  @Post('versions/:id/restore')
  @RequirePermission('schedule.create', ALL)
  restore(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string, @Req() req: Request) { return this.versions.restore(u, id, ctxOf(req)); }

  @Post('versions/:id/publish')
  @RequirePermission('schedule.publish', ALL)
  publish(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string, @Req() req: Request) { return this.versions.publish(u, id, ctxOf(req)); }

  @Get('versions/:id/diff')
  @RequirePermission('schedule.view', ALL)
  diff(@Param('id', idPipe) id: string, @Query('against', idPipe) against: string) { return this.versions.diffApi(against, id); }

  // ═══════════ занятия версии ═══════════
  @Get('versions/:id/lessons')
  @RequirePermission('schedule.view', ALL)
  listLessons(@Param('id', idPipe) id: string, @Query(new ZodValidationPipe(LessonsQuery)) q: Q<typeof LessonsQuery>) { return this.lessons.list(id, q); }

  @Get('versions/:id/entity')
  @RequirePermission('schedule.view', ALL)
  entity(@Param('id', idPipe) id: string, @Query(new ZodValidationPipe(z.object({ by: z.enum(['group', 'teacher', 'room', 'building']), value: z.string().min(1).max(60) }))) q: { by: 'group' | 'teacher' | 'room' | 'building'; value: string }) { return this.lessons.entity(id, q.by, q.value); }

  @Get('versions/:id/calendar')
  @RequirePermission('schedule.view', ALL)
  calendar(@Param('id', idPipe) id: string, @Query(new ZodValidationPipe(CalendarQuery)) q: Q<typeof CalendarQuery>) { return this.lessons.calendar(id, q); }

  @Post('versions/:id/lessons')
  @RequirePermission('schedule.create', ALL)
  createLesson(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string, @Body(new ZodValidationPipe(CreateLessonSchema)) dto: Q<typeof CreateLessonSchema>, @Req() req: Request) { return this.lessons.create(u, id, dto, ctxOf(req)); }

  @Post('versions/:id/lessons/lock')
  @RequirePermission('schedule.update', ALL)
  bulkLock(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string, @Body(new ZodValidationPipe(BulkLockSchema)) dto: Q<typeof BulkLockSchema>, @Req() req: Request) { return this.lessons.bulkLock(u, id, dto.ids, dto.locked, ctxOf(req)); }

  @Patch('lessons/:lessonId')
  @RequirePermission('schedule.update', ALL)
  updateLesson(@CurrentUser() u: CurrentUserData, @Param('lessonId', idPipe) lessonId: string, @Body(new ZodValidationPipe(UpdateLessonSchema)) dto: Q<typeof UpdateLessonSchema>, @Req() req: Request) { return this.lessons.update(u, lessonId, dto, ctxOf(req)); }

  @Delete('lessons/:lessonId')
  @RequirePermission('schedule.delete', ALL)
  deleteLesson(@CurrentUser() u: CurrentUserData, @Param('lessonId', idPipe) lessonId: string, @Req() req: Request) { return this.lessons.remove(u, lessonId, ctxOf(req)); }

  // ═══════════ конфликты ═══════════
  @Get('versions/:id/conflicts')
  @RequirePermission('schedule.view', ALL)
  conflictsOf(@Param('id', idPipe) id: string, @Query(new ZodValidationPipe(ConflictsQuery)) q: Q<typeof ConflictsQuery>) { return this.conflicts.report(id, q); }

  // ═══════════ генерация (фоновые задачи) ═══════════
  @Post('jobs')
  @RequirePermission('schedule.generate', ALL)
  generate(@CurrentUser() u: CurrentUserData, @Body(new ZodValidationPipe(GenerateSchema)) dto: Q<typeof GenerateSchema>, @Req() req: Request) { return this.jobs.enqueue(u, dto, ctxOf(req)); }

  @Get('jobs')
  @RequirePermission('schedule.view', ALL)
  listJobs(@Query(new ZodValidationPipe(PeriodQuery.partial())) q: Partial<Q<typeof PeriodQuery>>) { return this.jobs.list(q); }

  @Get('jobs/:id')
  @RequirePermission('schedule.view', ALL)
  job(@Param('id', idPipe) id: string) { return this.jobs.get(id); }

  @Post('jobs/:id/cancel')
  @RequirePermission('schedule.generate', ALL)
  cancel(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string, @Req() req: Request) { return this.jobs.cancel(u, id, ctxOf(req)); }

  // ═══════════ экспорт ═══════════
  @Get('versions/:id/export')
  @RequirePermission('schedule.export', ALL)
  async export(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string, @Query(new ZodValidationPipe(ExportQuery)) q: Q<typeof ExportQuery>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const f = await this.exporter.export(u, id, q, ctxOf(req));
    res.set({ 'Content-Type': f.mime, 'Content-Disposition': `attachment; filename="${f.filename}"`, 'Cache-Control': 'no-store' });
    return new StreamableFile(f.body);
  }

  // ═══════════ личное расписание ═══════════
  @Get('me/calendar')
  @RequirePermission('schedule.view')
  myCalendar(@CurrentUser() u: CurrentUserData, @Query(new ZodValidationPipe(z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))) q: { from: string; to: string }) { return this.lessons.myCalendar(u, q); }
}
