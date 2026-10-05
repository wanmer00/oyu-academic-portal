import { Body, Controller, Delete, Get, Header, NotFoundException, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { env } from '../../config/env';
import { DemoExamService } from './demo-exam.service';
import { sha256 } from './exam.rules';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { z } from 'zod';
import { AuditCtx } from '../../common/audit/audit-trail.service';
import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { OrgScopeService } from '../../common/rbac/org-scope.service';
import { RequirePermission } from '../../common/rbac/require-permission.decorator';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AttemptService } from './attempt.service';
import { ProctorService, AuthorizeSchema, BulkWorkstationSchema, ReasonSchema, WorkstationSchema } from './proctor.service';
import { ImportSchema, QuestionBankService, QuestionSchema, RejectSchema } from './question-bank.service';
import { ResitService } from './resit.service';
import { ResultFilter, ResultsService } from './results.service';
import { OfferingSchema, RetakeChoiceSchema, RetakeService, SummerCourseSchema, SummerPeriodSchema } from './retake.service';
import { AnswerSchema, RuntimeService, StartSchema, WorkstationGuard } from './runtime.service';
import { StudentExamsService } from './student-exams.service';
import { ExamSchema, ResitWindowSchema, WindowSchema, WindowsService } from './windows.service';

export const ctxOf = (req: Request): AuditCtx => ({ ip: req.ip ?? null, userAgent: (req.headers['user-agent'] as string) ?? null });
const actor = (u: CurrentUserData) => ({ id: u.id, role: u.role });

// ───────────────────────── Студент ─────────────────────────
@Controller('me')
export class StudentExamsController {
  constructor(private readonly svc: StudentExamsService, private readonly resits: ResitService, private readonly retakes: RetakeService, private readonly demo: DemoExamService) {}

  @Get('exams') @RequirePermission('exams.view', { scopes: ['OWN'] })
  overview(@CurrentUser() u: CurrentUserData) { return this.svc.overview(u.id); }

  @Get('exam-results/:id') @RequirePermission('exams.view', { scopes: ['OWN'] })
  result(@CurrentUser() u: CurrentUserData, @Param('id') id: string) { return this.svc.result(u.id, id); }

  /** DEMO: тестовый экзамен без наблюдателя (только DEMO_MODE) */
  @Post('demo-exam/start') @RequirePermission('exams.view', { scopes: ['OWN'] })
  demoStart(@CurrentUser() u: CurrentUserData, @Req() req: Request) { return this.demo.start(actor(u), req.ip, ctxOf(req)); }

  @Post('resits/:id/pay') @RequirePermission('exams.pay', { scopes: ['OWN'] })
  pay(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Body(new ZodValidationPipe(z.object({ simulate: z.literal('FAIL').optional() }))) b: { simulate?: 'FAIL' }, @Req() req: Request) {
    return this.resits.pay(actor(u), id, b, ctxOf(req));
  }

  @Get('retakes/:enrollmentId/options') @RequirePermission('exams.view', { scopes: ['OWN'] })
  options(@CurrentUser() u: CurrentUserData, @Param('enrollmentId') id: string) { return this.retakes.options(u.id, id); }

  @Post('retakes/:enrollmentId/register') @RequirePermission('exams.view', { scopes: ['OWN'] })
  register(@CurrentUser() u: CurrentUserData, @Param('enrollmentId') id: string, @Body(new ZodValidationPipe(RetakeChoiceSchema)) b: z.infer<typeof RetakeChoiceSchema>, @Req() req: Request) {
    return this.retakes.register(actor(u), id, b, ctxOf(req));
  }
}

// ───────────────────────── Преподаватель: My Exams ─────────────────────────
@Controller('teacher')
export class TeacherExamsController {
  constructor(private readonly banks: QuestionBankService, private readonly results: ResultsService) {}

  @Get('exams') @RequirePermission('exams.questions')
  mine(@CurrentUser() u: CurrentUserData) { return this.banks.myExams(u); }

  @Post('question-banks/:subjectId/versions') @RequirePermission('exams.questions')
  createVersion(@CurrentUser() u: CurrentUserData, @Param('subjectId') s: string, @Req() req: Request) { return this.banks.createVersion(actor(u), s, ctxOf(req)); }

  @Get('question-banks/versions/:id') @RequirePermission('exams.questions')
  version(@CurrentUser() u: CurrentUserData, @Param('id') id: string) { return this.banks.getVersion(u, id); }

  @Post('question-banks/versions/:id/questions') @RequirePermission('exams.questions')
  add(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Body(new ZodValidationPipe(QuestionSchema)) b: z.infer<typeof QuestionSchema>, @Req() req: Request) { return this.banks.addQuestion(actor(u), id, b, ctxOf(req)); }

  @Put('question-banks/versions/:id/questions/:qid') @RequirePermission('exams.questions')
  update(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Param('qid') qid: string, @Body(new ZodValidationPipe(QuestionSchema)) b: z.infer<typeof QuestionSchema>, @Req() req: Request) { return this.banks.updateQuestion(actor(u), id, qid, b, ctxOf(req)); }

  @Delete('question-banks/versions/:id/questions/:qid') @RequirePermission('exams.questions')
  remove(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Param('qid') qid: string, @Req() req: Request) { return this.banks.deleteQuestion(actor(u), id, qid, ctxOf(req)); }

  @Post('question-banks/versions/:id/import') @RequirePermission('exams.questions')
  import(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Body(new ZodValidationPipe(ImportSchema)) b: z.infer<typeof ImportSchema>, @Req() req: Request) { return this.banks.importQuestions(actor(u), id, b, ctxOf(req)); }

  @Get('question-banks/import-template') @RequirePermission('exams.questions') @Header('Content-Type', 'text/csv; charset=utf-8')
  template() { return this.banks.importTemplate(); }

  @Post('question-banks/versions/:id/submit') @RequirePermission('exams.questions')
  submit(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Req() req: Request) { return this.banks.submit(actor(u), id, ctxOf(req)); }

  @Get('exam-results') @RequirePermission('exams.results')
  teacherResults(@CurrentUser() u: CurrentUserData, @Query('subjectId') subjectId?: string) { return this.results.teacherResults(u.id, subjectId); }
}

// ───────────────────────── Management ─────────────────────────
@Controller('admin')
export class AdminExamsController {
  constructor(
    private readonly windows: WindowsService, private readonly banks: QuestionBankService, private readonly proctors: ProctorService, private readonly results: ResultsService,
    private readonly resits: ResitService, private readonly retakes: RetakeService, private readonly attempts: AttemptService, private readonly org: OrgScopeService, private readonly prisma: PrismaService,
  ) {}

  // окна
  @Get('exam-windows') @RequirePermission('exams.view', { scopes: ['ASSIGNED', 'ALL'] })
  listWindows(@Query('kind') kind?: string, @Query('status') status?: string) { return this.windows.list({ kind, status }); }
  @Get('exam-windows/:id') @RequirePermission('exams.view', { scopes: ['ASSIGNED', 'ALL'] })
  getWindow(@Param('id') id: string) { return this.windows.get(id); }
  @Post('exam-windows') @RequirePermission('exams.manage')
  createWindow(@CurrentUser() u: CurrentUserData, @Body(new ZodValidationPipe(WindowSchema)) b: z.infer<typeof WindowSchema>, @Req() req: Request) { return this.windows.create(actor(u), b, ctxOf(req)); }
  @Put('exam-windows/:id') @RequirePermission('exams.manage')
  updateWindow(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Body(new ZodValidationPipe(WindowSchema.partial())) b: Partial<z.infer<typeof WindowSchema>>, @Req() req: Request) { return this.windows.update(actor(u), id, b, ctxOf(req)); }
  @Post('exam-windows/:id/publish') @RequirePermission('exams.manage')
  publishWindow(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Req() req: Request) { return this.windows.publish(actor(u), id, ctxOf(req)); }
  @Post('exam-windows/:id/close') @RequirePermission('exams.manage')
  closeWindow(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Req() req: Request) { return this.windows.close(actor(u), id, ctxOf(req)); }
  @Post('exam-windows/:id/cancel') @RequirePermission('exams.manage')
  cancelWindow(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Req() req: Request) { return this.windows.cancel(actor(u), id, ctxOf(req)); }
  @Post('exam-windows/:id/resit-window') @RequirePermission('exams.manage')
  resitWindow(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Body(new ZodValidationPipe(ResitWindowSchema)) b: z.infer<typeof ResitWindowSchema>, @Req() req: Request) { return this.windows.createResitWindow(actor(u), id, b, ctxOf(req)); }
  @Post('exam-windows/:id/sync-enrollments') @RequirePermission('exams.manage')
  sync(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Req() req: Request) { return this.windows.syncEnrollments(actor(u), id, ctxOf(req)); }
  @Post('exam-windows/:id/exams') @RequirePermission('exams.manage')
  addExam(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Body(new ZodValidationPipe(ExamSchema)) b: z.infer<typeof ExamSchema>, @Req() req: Request) { return this.windows.addExam(actor(u), id, b, ctxOf(req)); }
  @Delete('exams/:examId') @RequirePermission('exams.manage')
  removeExam(@CurrentUser() u: CurrentUserData, @Param('examId') id: string, @Req() req: Request) { return this.windows.removeExam(actor(u), id, ctxOf(req)); }

  // проверка вопросов
  @Get('question-reviews') @RequirePermission('exams.review')
  queue(@CurrentUser() u: CurrentUserData, @Query('status') status?: string) { return this.banks.queue(u, status); }
  @Get('question-reviews/:id') @RequirePermission('exams.review')
  reviewDetail(@CurrentUser() u: CurrentUserData, @Param('id') id: string) { return this.banks.reviewDetail(u, id); }
  @Post('question-reviews/:id/claim') @RequirePermission('exams.review')
  claim(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Req() req: Request) { return this.banks.claim(u, id, ctxOf(req)); }
  @Post('question-reviews/:id/approve') @RequirePermission('exams.review')
  approve(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Req() req: Request) { return this.banks.approve(u, id, ctxOf(req)); }
  @Post('question-reviews/:id/reject') @RequirePermission('exams.review')
  reject(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Body(new ZodValidationPipe(RejectSchema)) b: z.infer<typeof RejectSchema>, @Req() req: Request) { return this.banks.reject(u, id, b.reason, ctxOf(req)); }

  // рабочие места, проктора
  @Get('exam-workstations') @RequirePermission('exams.manage')
  workstations(@Query('roomId') roomId?: string) { return this.proctors.workstations(roomId); }
  @Post('exam-workstations') @RequirePermission('exams.manage')
  addWs(@CurrentUser() u: CurrentUserData, @Body(new ZodValidationPipe(WorkstationSchema)) b: z.infer<typeof WorkstationSchema>, @Req() req: Request) { return this.proctors.createWorkstation(actor(u), b, ctxOf(req)); }
  @Post('exam-workstations/bulk') @RequirePermission('exams.manage')
  bulkWs(@CurrentUser() u: CurrentUserData, @Body(new ZodValidationPipe(BulkWorkstationSchema)) b: z.infer<typeof BulkWorkstationSchema>, @Req() req: Request) { return this.proctors.createBulk(actor(u), b, ctxOf(req)); }
  @Post('exam-workstations/:id/active') @RequirePermission('exams.manage')
  wsActive(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Body(new ZodValidationPipe(z.object({ isActive: z.boolean() }))) b: { isActive: boolean }, @Req() req: Request) { return this.proctors.setActive(actor(u), id, b.isActive, ctxOf(req)); }
  @Post('exam-workstations/:id/rotate-key') @RequirePermission('exams.manage')
  rotate(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Req() req: Request) { return this.proctors.rotateKey(actor(u), id, ctxOf(req)); }
  @Get('exam-proctors') @RequirePermission('exams.manage')
  proctorList() { return this.proctors.proctors(); }
  @Put('exam-proctors/:id/rooms') @RequirePermission('exams.manage')
  proctorRooms(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Body(new ZodValidationPipe(z.object({ roomIds: z.array(z.string()).max(50) }))) b: { roomIds: string[] }, @Req() req: Request) { return this.proctors.setProctorRooms(actor(u), id, b.roomIds, ctxOf(req)); }

  // результаты и аналитика
  @Get('exam-results') @RequirePermission('exams.results')
  async resultList(@CurrentUser() u: CurrentUserData, @Query() q: ResultFilter) { return this.results.list(q, (await this.org.forUser(u)).groups); }
  @Get('exam-analytics') @RequirePermission('exams.results')
  async analytics(@CurrentUser() u: CurrentUserData, @Query() q: ResultFilter) { return this.results.analytics(q, (await this.org.forUser(u)).groups); }
  @Post('exam-results/publish') @RequirePermission('exams.manage')
  publish(@CurrentUser() u: CurrentUserData, @Body(new ZodValidationPipe(z.object({ ids: z.array(z.string()).min(1).max(1000) }))) b: { ids: string[] }, @Req() req: Request) { return this.attempts.publish(b.ids, actor(u), ctxOf(req)).then((n) => ({ published: n })); }

  // 25% resit и платежи
  @Get('exam-resits') @RequirePermission('exams.payments')
  async resitList(@CurrentUser() u: CurrentUserData, @Query('status') status?: string, @Query('cycle') cycle?: string) { return this.resits.adminList({ status, cycle }, (await this.org.forUser(u)).groups); }
  @Post('exam-resits/:id/refund') @RequirePermission('exams.payments')
  refund(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Body(new ZodValidationPipe(ReasonSchema)) b: { reason: string }, @Req() req: Request) { return this.resits.refund(actor(u), id, b.reason, ctxOf(req)); }

  // retake, предложения предметов, летние курсы
  @Get('exam-retakes') @RequirePermission('exams.retakes')
  async retakeList(@CurrentUser() u: CurrentUserData, @Query('status') status?: string) { return this.retakes.adminList({ status }, (await this.org.forUser(u)).groups); }
  @Get('subject-offerings') @RequirePermission('exams.retakes')
  offerings(@Query('subjectId') subjectId?: string, @Query('academicYear') academicYear?: string) { return this.retakes.listOfferings({ subjectId, academicYear }); }
  @Post('subject-offerings') @RequirePermission('exams.manage')
  addOffering(@CurrentUser() u: CurrentUserData, @Body(new ZodValidationPipe(OfferingSchema)) b: z.infer<typeof OfferingSchema>, @Req() req: Request) { return this.retakes.createOffering(actor(u), b, ctxOf(req)); }
  @Put('subject-offerings/:id') @RequirePermission('exams.manage')
  patchOffering(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Body(new ZodValidationPipe(z.object({ isAvailable: z.boolean().optional(), enrollmentClosesAt: z.string().nullable().optional() }))) b: { isAvailable?: boolean; enrollmentClosesAt?: string | null }, @Req() req: Request) { return this.retakes.updateOffering(actor(u), id, b, ctxOf(req)); }
  @Get('summer-retakes') @RequirePermission('exams.retakes')
  summer() { return this.retakes.summerPeriods(); }
  @Post('summer-retakes') @RequirePermission('exams.manage')
  addPeriod(@CurrentUser() u: CurrentUserData, @Body(new ZodValidationPipe(SummerPeriodSchema)) b: z.infer<typeof SummerPeriodSchema>, @Req() req: Request) { return this.retakes.createPeriod(actor(u), b, ctxOf(req)); }
  @Post('summer-retakes/:id/courses') @RequirePermission('exams.manage')
  addCourse(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Body(new ZodValidationPipe(SummerCourseSchema)) b: z.infer<typeof SummerCourseSchema>, @Req() req: Request) { return this.retakes.addCourse(actor(u), id, b, ctxOf(req)); }
  @Post('summer-retakes/:id/status') @RequirePermission('exams.manage')
  periodStatus(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Body(new ZodValidationPipe(z.object({ status: z.enum(['OPEN', 'CLOSED']) }))) b: { status: 'OPEN' | 'CLOSED' }, @Req() req: Request) { return this.retakes.setPeriodStatus(actor(u), id, b.status, ctxOf(req)); }

  // журнал аудита экзаменов (только чтение)
  @Get('exam-audit') @RequirePermission('exams.audit')
  async audit(@Query('action') action?: string, @Query('entity') entity?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('take') take?: string) {
    const rows = await this.prisma.auditLog.findMany({
      where: { action: action ? { startsWith: `exam.${action}` } : { startsWith: 'exam.' }, ...(entity ? { targetType: entity } : {}), ...(from || to ? { createdAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(`${to}T23:59:59Z`) } : {}) } } : {}) },
      orderBy: { createdAt: 'desc' }, take: Math.min(Number(take) || 200, 500), include: { actor: { select: { loginId: true, fullName: true, role: true } } },
    });
    return rows.map((r) => ({ id: r.id, at: r.createdAt, action: r.action, entity: r.targetType, entityId: r.targetId, result: r.result, ip: r.ip, actor: r.actor ? { loginId: r.actor.loginId, fullName: r.actor.fullName, role: r.actor.role } : null, meta: r.diff }));
  }
}

// ───────────────────────── Проктор ─────────────────────────
@Controller('proctor')
export class ProctorController {
  constructor(private readonly svc: ProctorService) {}

  @Get('rooms') @RequirePermission('exams.proctor')
  rooms(@CurrentUser() u: CurrentUserData) { return this.svc.myRooms(u); }
  @Get('rooms/:id/status') @RequirePermission('exams.proctor')
  status(@CurrentUser() u: CurrentUserData, @Param('id') id: string) { return this.svc.roomStatus(u, id); }
  @Get('students') @RequirePermission('exams.proctor')
  students(@Query('q') q = '') { return this.svc.findStudents(q); }
  @Get('students/:id/exams') @RequirePermission('exams.proctor')
  studentExams(@Param('id') id: string) { return this.svc.studentExams(id); }
  @Post('authorizations') @RequirePermission('exams.proctor')
  authorize(@CurrentUser() u: CurrentUserData, @Body(new ZodValidationPipe(AuthorizeSchema)) b: z.infer<typeof AuthorizeSchema>, @Req() req: Request) { return this.svc.authorize(u, b, req.ip, ctxOf(req)); }
  @Delete('authorizations/:id') @RequirePermission('exams.proctor')
  revoke(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Body(new ZodValidationPipe(ReasonSchema)) b: { reason: string }, @Req() req: Request) { return this.svc.revoke(u, id, b.reason, ctxOf(req)); }
  @Post('attempts/:id/terminate') @RequirePermission('exams.proctor')
  terminate(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Body(new ZodValidationPipe(ReasonSchema)) b: { reason: string }, @Req() req: Request) { return this.svc.terminate(u, id, b.reason, ctxOf(req)); }
}

// ───────────────────────── Киоск (рабочее место) ─────────────────────────
@Public()
@SkipThrottle()
@UseGuards(WorkstationGuard)
@Controller('exam-runtime')
export class RuntimeController {
  constructor(private readonly svc: RuntimeService) {}

  @Get('state') async state(@Req() req: Request & { workstation: { id: string; code: string } }) { return { ...(await this.svc.state(req.workstation.id, ctxOf(req))), workstation: { code: req.workstation.code } }; }
  @Post('start') start(@Req() req: Request & { workstation: { id: string } }, @Body(new ZodValidationPipe(StartSchema)) b: z.infer<typeof StartSchema>) { return this.svc.start(req.workstation.id, b.token, ctxOf(req)); }
  @Get('attempt') attempt(@Req() req: Request & { workstation: { id: string } }) { return this.svc.attemptView(req.workstation.id, ctxOf(req)); }
  @Put('answers/:position') answer(@Req() req: Request & { workstation: { id: string } }, @Param('position') p: string, @Body(new ZodValidationPipe(AnswerSchema)) b: z.infer<typeof AnswerSchema>) { return this.svc.saveAnswer(req.workstation.id, Number(p), b, ctxOf(req)); }
  @Post('submit') submit(@Req() req: Request & { workstation: { id: string } }) { return this.svc.submit(req.workstation.id, ctxOf(req)); }
  @Get('result') result(@Req() req: Request & { workstation: { id: string } }) { return this.svc.resultFor(req.workstation.id); }
}

// ───────────────────────── DEMO: подключение киоска «из дома» ─────────────────────────
/** Только при DEMO_MODE=true: список демо-ПК с их публичными демо-ключами, чтобы протестировать экзамен с любого устройства. В боевом режиме — 404. */
@Public()
@Controller('exam-runtime-demo')
export class DemoRuntimeController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('workstations')
  async list() {
    if (!env.DEMO_MODE) throw new NotFoundException();
    const rows = await this.prisma.examWorkstation.findMany({ where: { isActive: true }, include: { room: { select: { code: true } } }, orderBy: [{ room: { code: 'asc' } }, { code: 'asc' }] });
    return rows.map((w) => ({ room: w.room.code, code: w.code, key: `wk_demo_${w.room.code}_${w.code}` })).filter((w, i) => sha256(w.key) === rows[i].keyHash);
  }
}
