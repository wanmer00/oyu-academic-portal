import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RequestStatus, Role } from '@prisma/client';
import { z } from 'zod';
import { AuditCtx, AuditTrailService } from '../../common/audit/audit-trail.service';
import { OrgScopeService } from '../../common/rbac/org-scope.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SettingsService } from '../admin/settings.service';
import { ExamCommon, Tx } from '../exams/exam-common.service';
import { EXAM_RULES, evaluateTotals } from '../exams/exam.rules';
import { NotificationsService } from '../notifications/notifications.service';
import { TeacherAccessService } from '../teachers/teacher-access.service';

/**
 * Апелляция по экзамену — специализация существующей заявки (Request.type = APPEAL).
 * Статус — Request.status; ExamAppeal хранит ссылку на результат, снимок спорных вопросов (REFERENCE + SNAPSHOT),
 * решения по вопросам и пересмотр. Итог пересчитывается только здесь, на backend:
 * Exam Score → ExamResult.revised* → Academic Journal FINAL (через GradeHistory) → total / GPA существующими расчётами.
 */

/** Причины спора. Без PARTIAL_CREDIT_ERROR: тесты A–E оцениваются +2 / −1 / 0, частичного балла в исходной оценке нет */
export const APPEAL_REASONS = [
  'SCORING_ERROR', 'ANSWER_MARKED_WRONG_IN_ERROR', 'ANSWER_NOT_RECORDED', 'QUESTION_WORDING_ERROR', 'AMBIGUOUS_WORDING',
  'NO_CORRECT_ANSWER', 'MULTIPLE_CORRECT_ANSWERS', 'TASK_CONTENT_ERROR', 'GRAPHICAL_ERROR', 'PRINTING_ERROR', 'MISSING_TASK', 'TECHNICAL_PROBLEM', 'OTHER',
] as const;
export const ACTIVE = [RequestStatus.PENDING, RequestStatus.UNDER_REVIEW];
const DECIDED: RequestStatus[] = [RequestStatus.APPROVED, RequestStatus.PARTIALLY_APPROVED, RequestStatus.REJECTED];
/** Должности руководства, которые решают эскалированные апелляции (в своей области) */
const DECIDING_POSITIONS = ['RECTOR', 'VICE_RECTOR', 'DEAN', 'HEAD_OF_DEPARTMENT'];

export const AppealItemSchema = z.object({
  position: z.number().int().min(1).max(100),
  reason: z.enum(APPEAL_REASONS),
  explanation: z.string().trim().min(10).max(2000),
});
export const AppealInputSchema = z.object({ resultId: z.string().min(1).max(40), items: z.array(AppealItemSchema).min(1).max(25) }).strict();
export type AppealInput = z.infer<typeof AppealInputSchema>;
export const ItemDecisionSchema = z.object({ newPoints: z.number().int(), comment: z.string().trim().min(3).max(1000) }).strict();
export const DecideSchema = z.object({ note: z.string().trim().max(1000).optional() }).strict();
export const EscalateSchema = z.object({ reason: z.string().trim().min(5).max(1000) }).strict();

type Actor = { id: string; role: Role | string };
type QuestionRow = { position: number; questionId: string; body: string; image: string | null; options: Array<{ id: string; body: string; isCorrect: boolean }>; optionOrder: string[]; selectedId: string | null };

const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? null : Number(d));
const code = (id: string) => 'A-' + id.slice(-6).toUpperCase();

@Injectable()
export class AppealsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly common: ExamCommon,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly access: TeacherAccessService,
    private readonly org: OrgScopeService,
    private readonly auditTrail: AuditTrailService,
  ) {}

  /** Существующий AuditLog: кто, когда, что, было/стало, причина (без секретов) */
  private log(tx: Tx, actor: Actor, action: string, entity: string, id: string, meta: Record<string, unknown>, ctx: AuditCtx) {
    return this.auditTrail.recordTx(tx, { actorId: actor.id, action, targetType: entity, targetId: id, extra: { ...meta, role: actor.role } }, ctx);
  }

  // ───────────────────────── данные экзамена ─────────────────────────
  /** Вопросы результата из неизменяемого снапшота: компьютерная попытка или бумажный бланк */
  private async questions(db: Tx | PrismaService, result: { attemptId: string | null; sheetId: string | null }): Promise<QuestionRow[]> {
    const include = { question: { select: { body: true, image: true, options: { select: { id: true, body: true, isCorrect: true } } } } };
    if (result.attemptId) {
      const rows = await db.examAttemptQuestion.findMany({ where: { attemptId: result.attemptId }, orderBy: { position: 'asc' }, include });
      return rows.map((r) => ({ position: r.position, questionId: r.questionId, body: r.question.body, image: r.question.image, options: r.question.options, optionOrder: r.optionOrder, selectedId: r.selectedOptionId }));
    }
    if (result.sheetId) {
      const rows = await db.paperSheetQuestion.findMany({ where: { sheetId: result.sheetId }, orderBy: { position: 'asc' }, include });
      return rows.map((r) => ({ position: r.position, questionId: r.questionId, body: r.question.body, image: r.question.image, options: r.question.options, optionOrder: r.optionOrder, selectedId: r.finalOptionId }));
    }
    return [];
  }

  /** Оценка вопроса по правилам экзамена: верно +2, неверно −1, пропуск 0 */
  private grade(q: QuestionRow) {
    const correct = q.options.find((o) => o.isCorrect)?.id ?? null;
    const state = q.selectedId == null ? 'SKIP' : q.selectedId === correct ? 'CORRECT' : 'WRONG';
    const points = state === 'CORRECT' ? EXAM_RULES.CORRECT : state === 'WRONG' ? EXAM_RULES.WRONG : EXAM_RULES.SKIP;
    const label = q.selectedId ? 'ABCDE'[q.optionOrder.indexOf(q.selectedId)] ?? null : null;
    const answerText = q.selectedId ? q.options.find((o) => o.id === q.selectedId)?.body ?? null : null;
    return { state, points, max: EXAM_RULES.CORRECT, label, answerText, correctId: correct };
  }

  /** Окно апелляции: policy из настроек, отсчёт от публикации результата */
  window(publishedAt: Date | null) {
    if (!publishedAt) return null;
    const openAt = new Date(publishedAt.getTime() + this.settings.get('exam.appealDelayHours') * 3600_000);
    return { openAt, deadline: new Date(openAt.getTime() + this.settings.get('exam.appealWindowHours') * 3600_000) };
  }

  private async ownResult(studentId: string, resultId: string, db: Tx | PrismaService = this.prisma) {
    const r = await db.examResult.findFirst({
      where: { id: resultId, studentId, publishedAt: { not: null } },
      include: { exam: { select: { id: true, subjectId: true, subject: { select: { code: true, name: true } }, window: { select: { title: true, kind: true, academicYear: true, term: true } } } }, attempt: { select: { startedAt: true, submittedAt: true } } },
    });
    if (!r) throw new NotFoundException('Result not found');
    return r;
  }

  /** Право подать апелляцию сейчас + причина, если нельзя (проверяется и при показе, и при подаче) */
  private async eligibility(result: { id: string; source: string; publishedAt: Date | null }, now = new Date(), db: Tx | PrismaService = this.prisma) {
    const w = this.window(result.publishedAt);
    const appeals = await db.examAppeal.findMany({ where: { resultId: result.id }, include: { request: { select: { status: true } } }, orderBy: { createdAt: 'desc' } });
    const active = appeals.find((a) => !a.withdrawnAt);
    let reason: string | null = null;
    if (!['COMPUTER', 'PAPER'].includes(result.source)) reason = 'APPEAL_NOT_AVAILABLE';
    else if (!w) reason = 'RESULT_NOT_PUBLISHED';
    else if (active && ACTIVE.includes(active.request.status as never)) reason = 'APPEAL_ACTIVE';
    else if (active) reason = 'APPEAL_ALREADY_DECIDED'; // правило: одна рассмотренная апелляция на результат; отозванную можно подать заново
    else if (now < w.openAt) reason = 'APPEAL_NOT_OPEN';
    else if (now > w.deadline) reason = 'APPEAL_CLOSED';
    return { canAppeal: !reason, reason, openAt: w?.openAt ?? null, deadline: w?.deadline ?? null, activeRequestId: active?.requestId ?? null };
  }

  // ───────────────────────── студент: просмотр экзамена ─────────────────────────
  /** Exam Review: вопросы, свой ответ, баллы, статус; правильный ответ студенту не показывается */
  async review(studentId: string, resultId: string) {
    const r = await this.ownResult(studentId, resultId);
    const qs = await this.questions(this.prisma, r);
    const appeal = await this.prisma.examAppeal.findFirst({ where: { resultId, withdrawnAt: null }, include: { items: true, request: { select: { id: true, status: true } } } });
    const disputed = new Map((appeal?.items ?? []).map((i) => [i.position, i]));
    const el = await this.eligibility(r);
    return {
      result: {
        id: r.id, kind: r.kind, source: r.source, subject: r.exam?.subject ?? null, window: r.exam?.window.title ?? null, date: r.attempt?.submittedAt ?? r.createdAt, publishedAt: r.publishedAt,
        examScore: num(r.examScore), examMax: EXAM_RULES.MAX_EXAM_SCORE, entryScore: num(r.entryScore), total: num(r.total), letter: r.letter, passed: r.passed,
        revised: r.revisedAt ? { examScore: num(r.revisedExamScore), total: num(r.revisedTotal), letter: r.revisedLetter, passed: r.revisedPassed, at: r.revisedAt } : null,
      },
      questions: qs.map((q) => {
        const g = this.grade(q), d = disputed.get(q.position);
        return {
          position: q.position, text: q.body, image: q.image, answerLabel: g.label, answerText: g.answerText, state: g.state, points: g.points, maxPoints: g.max,
          disputed: !!d, appeal: d ? { reason: d.reason, outcome: d.outcome, newPoints: d.newPoints, comment: d.decidedAt ? d.reviewerComment : null } : null,
        };
      }),
      appeal: { ...el, reasons: APPEAL_REASONS, request: appeal ? { id: appeal.request.id, code: code(appeal.request.id), status: appeal.request.status } : null },
    };
  }

  // ───────────────────────── студент: подача / изменение / отзыв ─────────────────────────
  private async buildItems(db: Tx | PrismaService, result: { attemptId: string | null; sheetId: string | null }, input: AppealInput['items']) {
    const positions = input.map((i) => i.position);
    if (new Set(positions).size !== positions.length) throw new BadRequestException({ message: 'Duplicate questions', code: 'APPEAL_DUPLICATE_ITEM' });
    const qs = await this.questions(db, result);
    if (!qs.length) throw new BadRequestException({ message: 'This exam has no question data', code: 'APPEAL_NOT_AVAILABLE' });
    return input.map((i) => {
      const q = qs.find((x) => x.position === i.position);
      if (!q) throw new BadRequestException({ message: `Question ${i.position} does not exist`, code: 'APPEAL_ITEM_INVALID' });
      const g = this.grade(q);
      // снимок на момент подачи: номер, текст вопроса, ответ студента, начисленные баллы (правильный ответ не сохраняется)
      return { position: q.position, questionId: q.questionId, reason: i.reason, explanation: i.explanation, questionText: q.body.slice(0, 4000), answerText: g.label ? `${g.label}) ${g.answerText ?? ''}`.slice(0, 1000) : null, answerState: g.state, awardedPoints: g.points, maxPoints: g.max };
    });
  }

  /** Создание: обычная Request (type = APPEAL) + ExamAppeal + спорные вопросы. Вызывается из RequestsService.create */
  async create(studentId: string, input: AppealInput, description: string | undefined, ctx: AuditCtx) {
    const st = await this.prisma.student.findUnique({ where: { userId: studentId }, select: { groupName: true } });
    if (!st) throw new ForbiddenException('Only students can appeal exam results');
    const out = await this.prisma.$transaction(async (tx) => {
      await this.common.lockStudent(tx, studentId);
      const r = await this.ownResult(studentId, input.resultId, tx);
      const el = await this.eligibility(r, new Date(), tx);
      if (!el.canAppeal) throw new ConflictException({ message: 'Appeal is not available', code: el.reason, openAt: el.openAt, deadline: el.deadline });
      const items = await this.buildItems(tx, r, input.items);
      const subject = r.exam?.subject.name ?? '';
      const req = await tx.request.create({ data: { userId: studentId, type: 'APPEAL', description: (description?.trim() || `${subject} — ${items.length} question(s): ${items.map((i) => 'Q' + i.position).join(', ')}`).slice(0, 2000) } });
      const appeal = await tx.examAppeal.create({
        data: {
          requestId: req.id, resultId: r.id, studentId, subjectId: r.exam?.subjectId ?? '', originalExamScore: r.revisedExamScore ?? r.examScore, entryScore: r.entryScore, originalTotal: r.revisedTotal ?? r.total,
          appealOpenAt: el.openAt!, appealDeadline: el.deadline!, items: { create: items },
        },
      });
      await this.log(tx, { id: studentId, role: 'STUDENT' }, 'appeal.submit', 'Request', req.id, { resultId: r.id, appealId: appeal.id, items: items.map((i) => ({ q: i.position, reason: i.reason, awarded: i.awardedPoints })) }, ctx);
      return { req, appeal, subjectId: r.exam?.subjectId ?? null, subject, group: st.groupName };
    }).catch((e) => {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ message: 'An active appeal already exists', code: 'APPEAL_ACTIVE' });
      throw e;
    });
    await this.notifications.notify([studentId], { type: 'REQUEST', title: { az: 'Apellyasiya göndərildi', ru: 'Апелляция отправлена', en: 'Your appeal was submitted' }, message: { az: out.subject, ru: out.subject, en: out.subject }, link: 'requests' }).catch(() => undefined);
    if (out.subjectId) {
      const teachers = await this.prisma.scheduleSlot.findMany({ where: { subjectId: out.subjectId, groupName: out.group, teacherId: { not: null } }, distinct: ['teacherId'], select: { teacherId: true } });
      const ids = teachers.map((t) => t.teacherId!).filter(Boolean);
      if (ids.length) await this.notifications.notify(ids, { type: 'REQUEST', title: { az: 'Yeni imtahan apellyasiyası', ru: 'Новая апелляция по экзамену', en: 'New exam appeal submitted' }, message: { az: out.subject, ru: out.subject, en: out.subject }, link: 't-requests' }).catch(() => undefined);
    }
    return { ...out.req, appeal: { id: out.appeal.id, code: code(out.req.id) } };
  }

  /** Изменение до начала рассмотрения (PENDING): спорные вопросы, причины, объяснения */
  async update(studentId: string, requestId: string, input: Omit<AppealInput, 'resultId'>, ctx: AuditCtx) {
    return this.prisma.$transaction(async (tx) => {
      const a = await tx.examAppeal.findUnique({ where: { requestId }, include: { request: true, result: true, items: true } });
      if (!a || a.studentId !== studentId) throw new NotFoundException('Appeal not found');
      if (a.request.status !== 'PENDING') throw new ConflictException({ message: 'The appeal can no longer be edited', code: 'APPEAL_LOCKED' });
      if (new Date() > a.appealDeadline) throw new ConflictException({ message: 'Appeal period has ended', code: 'APPEAL_CLOSED' });
      const items = await this.buildItems(tx, a.result, input.items);
      await tx.examAppealItem.deleteMany({ where: { appealId: a.id } });
      await tx.examAppealItem.createMany({ data: items.map((i) => ({ ...i, appealId: a.id })) });
      await this.log(tx, { id: studentId, role: 'STUDENT' }, 'appeal.update', 'Request', requestId, { old: a.items.map((i) => ({ q: i.position, reason: i.reason })), new: items.map((i) => ({ q: i.position, reason: i.reason })) }, ctx);
      return { ok: true };
    });
  }

  /** Отзыв: только PENDING; данные не удаляются (статус WITHDRAWN) */
  async withdraw(studentId: string, requestId: string, ctx: AuditCtx) {
    return this.prisma.$transaction(async (tx) => {
      const a = await tx.examAppeal.findUnique({ where: { requestId }, include: { request: true } });
      if (!a || a.studentId !== studentId) throw new NotFoundException('Appeal not found');
      if (a.request.status !== 'PENDING') throw new ConflictException({ message: 'Only a pending appeal can be withdrawn', code: 'APPEAL_LOCKED' });
      await tx.examAppeal.update({ where: { id: a.id }, data: { withdrawnAt: new Date() } });
      await tx.request.update({ where: { id: requestId }, data: { status: 'WITHDRAWN' } });
      await this.log(tx, { id: studentId, role: 'STUDENT' }, 'appeal.withdraw', 'Request', requestId, { from: 'PENDING', to: 'WITHDRAWN' }, ctx);
      return { ok: true, status: 'WITHDRAWN' };
    });
  }

  // ───────────────────────── область доступа сотрудника ─────────────────────────
  /** Teacher — свои пары предмет×группа; руководство — группы своей области; SUPER_ADMIN / ректор — всё */
  private async scopeWhere(user: Actor): Promise<Prisma.ExamAppealWhereInput> {
    if (!['TEACHER', 'ADMIN', 'SUPER_ADMIN'].includes(String(user.role))) return { id: '__none__' }; // студент / наблюдатель — не сотрудники рассмотрения
    if (user.role === 'TEACHER') {
      const sc = await this.access.scope(user.id);
      if (!sc.pairs.length) return { id: '__none__' };
      const studentsByGroup = await this.prisma.student.findMany({ where: { groupName: { in: sc.groups } }, select: { userId: true, groupName: true } });
      return { OR: sc.pairs.map((p) => ({ subjectId: p.subjectId, studentId: { in: studentsByGroup.filter((s) => s.groupName === p.groupName).map((s) => s.userId) } })) };
    }
    const os = await this.org.forUser(user as { id: string; role: Role });
    if (!os.groups) return {};
    const ids = (await this.prisma.student.findMany({ where: { groupName: { in: os.groups } }, select: { userId: true } })).map((s) => s.userId);
    return { studentId: { in: ids } };
  }

  private async staffAppeal(user: Actor, requestId: string) {
    const a = await this.prisma.examAppeal.findFirst({ where: { requestId, ...(await this.scopeWhere(user)) }, include: { request: true, items: { orderBy: { position: 'asc' } }, result: true } });
    if (!a) throw new NotFoundException('Appeal not found');
    return a;
  }

  /** Кто может решать: преподаватель — неэскалированные; руководство (ректор, проректор, декан, зав. кафедрой) — эскалированные; SUPER_ADMIN — любые */
  private async assertCanDecide(user: Actor, a: { escalatedAt: Date | null }) {
    if (user.role === 'SUPER_ADMIN') return;
    if (user.role === 'TEACHER') {
      if (a.escalatedAt) throw new ForbiddenException({ message: 'The appeal was escalated to leadership', code: 'APPEAL_ESCALATED' });
      return;
    }
    if (user.role === 'ADMIN') {
      const u = await this.prisma.user.findUnique({ where: { id: user.id }, select: { position: true } });
      if (!a.escalatedAt) throw new ForbiddenException({ message: 'Leadership decides only escalated appeals', code: 'APPEAL_NOT_ESCALATED' });
      if (!u?.position || !DECIDING_POSITIONS.includes(u.position)) throw new ForbiddenException({ message: 'Your position cannot decide appeals', code: 'APPEAL_DECIDE_FORBIDDEN' });
      return;
    }
    throw new ForbiddenException({ message: 'Not allowed', code: 'APPEAL_DECIDE_FORBIDDEN' });
  }

  /** Взять на рассмотрение и передать руководству может только первичный проверяющий (преподаватель) или SUPER_ADMIN; руководство до эскалации — только просмотр */
  private assertReviewer(user: Actor) {
    if (user.role !== 'TEACHER' && user.role !== 'SUPER_ADMIN') throw new ForbiddenException({ message: 'Only the reviewing teacher can do this', code: 'APPEAL_REVIEWER_ONLY' });
  }

  // ───────────────────────── сотрудник: список / детали ─────────────────────────
  async list(user: Actor, q: { status?: string; escalated?: string; subjectId?: string; facultyId?: string; departmentId?: string; groupName?: string; student?: string; teacherId?: string; academicYear?: string; term?: string; from?: string; to?: string }) {
    const and: Prisma.ExamAppealWhereInput[] = [await this.scopeWhere(user)];
    if (q.status) and.push({ request: { status: q.status as RequestStatus } });
    if (q.escalated === 'true') and.push({ escalatedAt: { not: null }, decidedAt: null, withdrawnAt: null });
    if (q.subjectId) and.push({ subjectId: q.subjectId });
    if (q.from || q.to) and.push({ createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(`${q.to}T23:59:59Z`) } : {}) } });
    if (q.academicYear || q.term) and.push({ result: { exam: { window: { ...(q.academicYear ? { academicYear: q.academicYear } : {}), ...(q.term ? { term: q.term as never } : {}) } } } });
    if (q.groupName || q.facultyId || q.student) {
      const ids = (await this.prisma.student.findMany({ where: { ...(q.groupName ? { groupName: q.groupName } : {}), ...(q.facultyId ? { groupName: { in: (await this.prisma.academicGroup.findMany({ where: { specialty: { department: { facultyId: q.facultyId } } }, select: { name: true } })).map((g) => g.name) } } : {}), ...(q.student ? { user: { OR: [{ fullName: { contains: q.student, mode: 'insensitive' } }, { loginId: { contains: q.student, mode: 'insensitive' } }] } } : {}) }, select: { userId: true } })).map((s) => s.userId);
      and.push({ studentId: { in: ids } });
    }
    if (q.departmentId) and.push({ subjectId: { in: (await this.prisma.subject.findMany({ where: { departmentId: q.departmentId }, select: { id: true } })).map((s) => s.id) } });
    if (q.teacherId) and.push({ subjectId: { in: (await this.prisma.scheduleSlot.findMany({ where: { teacherId: q.teacherId }, distinct: ['subjectId'], select: { subjectId: true } })).map((s) => s.subjectId) } });
    const rows = await this.prisma.examAppeal.findMany({
      where: { AND: and }, orderBy: { createdAt: 'desc' }, take: 300,
      include: { request: { select: { id: true, status: true, createdAt: true, user: { select: { fullName: true, loginId: true, student: { select: { groupName: true } } } } } }, items: { select: { position: true }, orderBy: { position: 'asc' } }, result: { select: { exam: { select: { subject: { select: { code: true, name: true } }, window: { select: { title: true, kind: true } } } } } } },
    });
    return rows.map((a) => ({
      requestId: a.requestId, code: code(a.requestId), status: a.request.status, submittedAt: a.request.createdAt, deadline: a.appealDeadline, escalated: !!a.escalatedAt, outcome: a.outcome,
      student: { fullName: a.request.user.fullName, loginId: a.request.user.loginId, groupName: a.request.user.student?.groupName ?? null },
      subject: a.result.exam?.subject ?? null, exam: a.result.exam?.window.title ?? null, kind: a.result.exam?.window.kind ?? null,
      disputed: a.items.map((i) => 'Q' + i.position), originalExamScore: num(a.originalExamScore), revisedExamScore: num(a.revisedExamScore),
    }));
  }

  /** Детали для проверяющего: снимок + текущий вопрос, ответ студента и правильный вариант (reviewer видит ключ) */
  async detail(user: Actor, requestId: string) {
    const a = await this.staffAppeal(user, requestId);
    const qs = await this.questions(this.prisma, a.result);
    const st = await this.prisma.user.findUnique({ where: { id: a.studentId }, select: { fullName: true, loginId: true, student: { select: { groupName: true } } } });
    const exam = await this.prisma.exam.findFirst({ where: { results: { some: { id: a.resultId } } }, select: { subject: { select: { code: true, name: true } }, window: { select: { title: true, kind: true } } } });
    return {
      ...(await this.view(a)), student: { fullName: st?.fullName, loginId: st?.loginId, groupName: st?.student?.groupName ?? null }, subject: exam?.subject ?? null, exam: exam?.window.title ?? null, kind: exam?.window.kind ?? null,
      items: a.items.map((i) => {
        const q = qs.find((x) => x.position === i.position);
        const correct = q?.options.find((o) => o.isCorrect);
        return { ...this.itemView(i), correctAnswer: q && correct ? `${'ABCDE'[q.optionOrder.indexOf(correct.id)]}) ${correct.body}` : null, minPoints: i.answerState === 'SKIP' ? 0 : EXAM_RULES.WRONG };
      }),
      permissions: { canDecide: await this.assertCanDecide(user, a).then(() => true, () => false), canReview: user.role === 'TEACHER' || user.role === 'SUPER_ADMIN' },
    };
  }

  private itemView(i: { id: string; position: number; reason: string; explanation: string; questionText: string; answerText: string | null; answerState: string; awardedPoints: number; maxPoints: number; newPoints: number | null; outcome: string | null; reviewerComment: string | null; decidedAt: Date | null }) {
    return { id: i.id, position: i.position, reason: i.reason, explanation: i.explanation, questionText: i.questionText, answerText: i.answerText, answerState: i.answerState, awardedPoints: i.awardedPoints, maxPoints: i.maxPoints, newPoints: i.newPoints, outcome: i.outcome, reviewerComment: i.reviewerComment, decidedAt: i.decidedAt };
  }

  private async view(a: Prisma.ExamAppealGetPayload<{ include: { request: true } }>) {
    const status = a.request.status;
    const timeline = [
      { step: 'SUBMITTED', at: a.request.createdAt },
      { step: 'RECEIVED', at: a.request.createdAt },
      ...(a.reviewStartedAt ? [{ step: 'UNDER_REVIEW', at: a.reviewStartedAt }] : []),
      ...(a.escalatedAt ? [{ step: 'ESCALATED', at: a.escalatedAt }] : []),
      ...(a.decidedAt ? [{ step: 'DECISION', at: a.decidedAt }] : []),
      ...(a.withdrawnAt ? [{ step: 'WITHDRAWN', at: a.withdrawnAt }] : []),
    ];
    return {
      requestId: a.requestId, code: code(a.requestId), status, submittedAt: a.request.createdAt, appealOpenAt: a.appealOpenAt, deadline: a.appealDeadline,
      originalExamScore: num(a.originalExamScore), entryScore: num(a.entryScore), originalTotal: num(a.originalTotal), revisedExamScore: num(a.revisedExamScore), revisedTotal: num(a.revisedTotal),
      outcome: a.outcome, decisionNote: a.decisionNote, escalated: !!a.escalatedAt, escalationReason: a.escalationReason, timeline,
    };
  }

  /** Студент: детали своей апелляции (без правильных ответов) */
  async mine(studentId: string, requestId: string) {
    const a = await this.prisma.examAppeal.findUnique({ where: { requestId }, include: { request: true, items: { orderBy: { position: 'asc' } }, result: { select: { exam: { select: { subject: { select: { code: true, name: true } }, window: { select: { title: true, kind: true } } } } } } } });
    if (!a || a.studentId !== studentId) return null;
    return { ...(await this.view(a)), resultId: a.resultId, subject: a.result.exam?.subject ?? null, exam: a.result.exam?.window.title ?? null, items: a.items.map((i) => this.itemView(i)), canWithdraw: a.request.status === 'PENDING' };
  }

  // ───────────────────────── рассмотрение ─────────────────────────
  async start(user: Actor, requestId: string, ctx: AuditCtx) {
    this.assertReviewer(user);
    const a = await this.staffAppeal(user, requestId);
    if (a.request.status !== 'PENDING') throw new ConflictException({ message: 'Appeal is not pending', code: 'APPEAL_STATE' });
    await this.prisma.$transaction(async (tx) => {
      const u = await tx.request.updateMany({ where: { id: requestId, status: 'PENDING' }, data: { status: 'UNDER_REVIEW' } });
      if (u.count !== 1) throw new ConflictException({ message: 'Appeal is not pending', code: 'APPEAL_STATE' });
      await tx.examAppeal.update({ where: { id: a.id }, data: { reviewStartedAt: new Date(), reviewerId: user.id } });
      await this.log(tx, user, 'appeal.review', 'Request', requestId, { from: 'PENDING', to: 'UNDER_REVIEW' }, ctx);
    });
    await this.notifications.notify([a.studentId], { type: 'REQUEST', title: { az: 'Apellyasiya baxılır', ru: 'Апелляция на рассмотрении', en: 'Your appeal is under review' }, message: { az: code(requestId), ru: code(requestId), en: code(requestId) }, link: 'requests' }).catch(() => undefined);
    return this.detail(user, requestId);
  }

  /** Решение по одному вопросу: новый балл в пределах вопроса (−1 только если был дан ответ … максимум 2) + комментарий */
  async decideItem(user: Actor, requestId: string, itemId: string, dto: z.infer<typeof ItemDecisionSchema>, ctx: AuditCtx) {
    const a = await this.staffAppeal(user, requestId);
    await this.assertCanDecide(user, a);
    if (!ACTIVE.includes(a.request.status as never) || a.decidedAt || a.withdrawnAt) throw new ConflictException({ message: 'Appeal is already decided', code: 'APPEAL_STATE' });
    const item = a.items.find((i) => i.id === itemId);
    if (!item) throw new NotFoundException('Item not found');
    const min = item.answerState === 'SKIP' ? 0 : EXAM_RULES.WRONG;
    if (dto.newPoints < min || dto.newPoints > item.maxPoints) throw new BadRequestException({ message: `New points must be between ${min} and ${item.maxPoints}`, code: 'APPEAL_POINTS_RANGE', min, max: item.maxPoints });
    const outcome = dto.newPoints === item.awardedPoints ? 'REJECTED' : dto.newPoints < item.awardedPoints ? 'DECREASED' : dto.newPoints === item.maxPoints ? 'UPHELD' : 'PARTIALLY_UPHELD';
    await this.prisma.$transaction(async (tx) => {
      if (a.request.status === 'PENDING') {
        await tx.request.update({ where: { id: requestId }, data: { status: 'UNDER_REVIEW' } });
        await tx.examAppeal.update({ where: { id: a.id }, data: { reviewStartedAt: new Date(), reviewerId: user.id } });
      }
      await tx.examAppealItem.update({ where: { id: itemId }, data: { newPoints: dto.newPoints, outcome, reviewerComment: dto.comment, decidedAt: new Date(), decidedById: user.id } });
      await this.log(tx, user, 'appeal.item.decision', 'ExamAppealItem', itemId, { requestId, question: item.position, old: item.newPoints ?? item.awardedPoints, new: dto.newPoints, awarded: item.awardedPoints, outcome, reason: dto.comment }, ctx);
    });
    return this.detail(user, requestId);
  }

  async escalate(user: Actor, requestId: string, reason: string, ctx: AuditCtx) {
    this.assertReviewer(user);
    const a = await this.staffAppeal(user, requestId);
    if (!ACTIVE.includes(a.request.status as never) || a.escalatedAt) throw new ConflictException({ message: 'Appeal cannot be escalated', code: 'APPEAL_STATE' });
    await this.prisma.$transaction(async (tx) => {
      await tx.request.update({ where: { id: requestId }, data: { status: 'UNDER_REVIEW' } });
      await tx.examAppeal.update({ where: { id: a.id }, data: { escalatedAt: new Date(), escalatedById: user.id, escalationReason: reason, reviewStartedAt: a.reviewStartedAt ?? new Date() } });
      await this.log(tx, user, 'appeal.escalate', 'Request', requestId, { reason }, ctx);
    });
    // руководство области: декан факультета группы студента и зав. кафедрой предмета
    const st = await this.prisma.student.findUnique({ where: { userId: a.studentId }, select: { groupName: true } });
    const g = st ? await this.prisma.academicGroup.findUnique({ where: { name: st.groupName }, select: { specialty: { select: { department: { select: { facultyId: true } } } } } }) : null;
    const subj = await this.prisma.subject.findUnique({ where: { id: a.subjectId }, select: { departmentId: true, name: true } });
    const leaders = await this.prisma.user.findMany({ where: { status: 'ACTIVE', OR: [{ position: 'DEAN', facultyId: g?.specialty.department.facultyId ?? '__' }, { position: 'HEAD_OF_DEPARTMENT', departmentId: subj?.departmentId ?? '__' }] }, select: { id: true } });
    if (leaders.length) await this.notifications.notify(leaders.map((l) => l.id), { type: 'REQUEST', title: { az: 'Apellyasiya rəhbərliyə yönləndirildi', ru: 'Апелляция передана руководству', en: 'Appeal escalated for review' }, message: { az: `${code(requestId)} · ${subj?.name ?? ''}`, ru: `${code(requestId)} · ${subj?.name ?? ''}`, en: `${code(requestId)} · ${subj?.name ?? ''}` }, link: 'requests' }).catch(() => undefined);
    return this.detail(user, requestId);
  }

  /**
   * Итоговое решение: все спорные вопросы решены → общий результат вычисляется, Exam Score пересчитывается,
   * FINAL в Academic Journal обновляется через GradeHistory, статус предмета приводится в соответствие, всё — в AuditLog.
   */
  async decide(user: Actor, requestId: string, note: string | undefined, ctx: AuditCtx) {
    const a = await this.staffAppeal(user, requestId);
    await this.assertCanDecide(user, a);
    if (!ACTIVE.includes(a.request.status as never) || a.decidedAt || a.withdrawnAt) throw new ConflictException({ message: 'Appeal is already decided', code: 'APPEAL_STATE' });
    const pending = a.items.filter((i) => i.newPoints == null);
    if (pending.length) throw new ConflictException({ message: 'Decide every disputed question first', code: 'APPEAL_ITEMS_PENDING', positions: pending.map((i) => i.position) });
    const delta = a.items.reduce((s, i) => s + (i.newPoints! - i.awardedPoints), 0);
    const increased = a.items.filter((i) => i.newPoints! > i.awardedPoints);
    const outcome: RequestStatus = !increased.length ? 'REJECTED' : a.items.every((i) => i.outcome === 'UPHELD') ? 'APPROVED' : 'PARTIALLY_APPROVED';
    const r = a.result;
    const baseExam = Number(r.revisedExamScore ?? r.examScore);
    const revisedExam = Math.max(-EXAM_RULES.QUESTIONS, Math.min(EXAM_RULES.MAX_EXAM_SCORE, baseExam + delta));
    const ev = evaluateTotals(Number(r.entryScore), revisedExam, { passTotal: this.common.cfg.passTotal(), minExam: this.common.cfg.minExam() });
    const summary = a.items.map((i) => `Q${i.position}: ${i.awardedPoints} → ${i.newPoints} (${i.outcome})`).join('; ');
    const enrollment = await this.prisma.subjectEnrollment.findUniqueOrThrow({ where: { id: r.enrollmentId } });
    await this.prisma.$transaction(async (tx) => {
      if (delta !== 0) {
        await tx.examResult.update({ where: { id: r.id }, data: { revisedExamScore: revisedExam, revisedTotal: ev.total, revisedLetter: ev.letter, revisedPassed: ev.passed, revisedAt: new Date(), revisedByAppealId: a.id } });
        // Academic Journal: меняется ТОЛЬКО компонент FINAL (0..50); Midterm и Seminar не трогаются; total и GPA считают существующие расчёты
        const target = enrollment.source === 'DEMO' ? await tx.subjectEnrollment.findFirst({ where: { studentId: r.studentId, subjectId: a.subjectId, source: { not: 'DEMO' } }, orderBy: { academicYear: 'desc' } }) : enrollment;
        const before = target ? await tx.grade.findFirst({ where: { studentId: r.studentId, subjectId: a.subjectId, academicYear: target.academicYear, term: target.term, type: 'FINAL' }, orderBy: { updatedAt: 'desc' }, select: { value: true } }) : null;
        if (target) await this.common.writeFinalToJournal(tx, { studentId: r.studentId, subjectId: a.subjectId, academicYear: target.academicYear, term: target.term, semester: target.semester, examScore: revisedExam, reason: `Appeal ${code(requestId)}: ${summary}`.slice(0, 500) });
        await this.log(tx, user, 'grade.adjust', 'ExamResult', r.id, { requestId, appealId: a.id, old: { examScore: baseExam, total: Number(r.revisedTotal ?? r.total), passed: r.revisedPassed ?? r.passed, journalFinal: before ? Number(before.value) : null }, new: { examScore: revisedExam, total: ev.total, letter: ev.letter, passed: ev.passed, journalFinal: Math.max(0, revisedExam) }, reason: summary }, ctx);
        await this.syncEnrollment(tx, enrollment, r.kind, r.revisedPassed ?? r.passed, ev.passed, user, ctx);
      }
      await tx.examAppeal.update({ where: { id: a.id }, data: { outcome, revisedExamScore: delta !== 0 ? revisedExam : null, revisedTotal: delta !== 0 ? ev.total : null, decisionNote: note ?? null, decidedAt: new Date(), decidedById: user.id } });
      await tx.request.update({ where: { id: requestId }, data: { status: outcome, adminNote: (note ? note + ' — ' : '') + summary } });
      await this.log(tx, user, 'appeal.decide', 'Request', requestId, { outcome, original: baseExam, revised: revisedExam, delta, note: note ?? null }, ctx);
      await this.log(tx, user, 'appeal.close', 'Request', requestId, { status: outcome }, ctx);
    });
    const msg = delta !== 0 ? `${baseExam} → ${revisedExam} / 50` : `${baseExam} / 50`;
    await this.notifications.notify([a.studentId], { type: 'REQUEST', title: { az: 'Apellyasiya üzrə qərar hazırdır', ru: 'Решение по апелляции готово', en: 'Your appeal decision is ready' }, message: { az: msg, ru: msg, en: msg }, link: 'requests' }).catch(() => undefined);
    if (delta !== 0) await this.notifications.notify([a.studentId], { type: 'ACADEMIC', title: { az: 'İmtahan balı apellyasiyadan sonra dəyişdi', ru: 'Балл за экзамен изменён после апелляции', en: 'Your exam score was changed after appeal' }, message: { az: msg, ru: msg, en: msg }, link: 'exams' }).catch(() => undefined);
    return this.detail(user, requestId);
  }

  /** Статус предмета после пересмотра (если изменился PASS/FAIL) */
  private async syncEnrollment(tx: Tx, en: { id: string; status: string }, kind: 'FINAL' | 'RESIT', wasPassed: boolean, nowPassed: boolean, user: Actor, ctx: AuditCtx) {
    if (wasPassed === nowPassed) return;
    let next: string | null = null;
    if (nowPassed && ['RESIT_ELIGIBLE', 'RESIT_PAYMENT_PENDING', 'RESIT_FORFEITED', 'RETAKE_REQUIRED'].includes(en.status)) next = 'COMPLETED';
    if (!nowPassed && en.status === 'COMPLETED') next = kind === 'FINAL' ? 'RESIT_ELIGIBLE' : 'RETAKE_REQUIRED';
    if (!next) return;
    await tx.subjectEnrollment.update({ where: { id: en.id }, data: { status: next as never } });
    if (next === 'COMPLETED') await tx.resitEligibility.updateMany({ where: { enrollmentId: en.id, status: { in: ['ELIGIBLE', 'PAYMENT_PENDING'] } }, data: { status: 'FORFEITED' } });
    await this.log(tx, user, 'appeal.enrollment_status', 'SubjectEnrollment', en.id, { old: en.status, new: next }, ctx);
  }

  // ───────────────────────── аналитика ─────────────────────────
  async analytics(user: Actor) {
    const where = await this.scopeWhere(user);
    const rows = await this.prisma.examAppeal.findMany({ where, include: { request: { select: { status: true, createdAt: true } }, items: { select: { reason: true, position: true, questionId: true, questionText: true } } } });
    const by = (s: string) => rows.filter((r) => r.request.status === s).length;
    const decided = rows.filter((r) => r.decidedAt);
    const avgHours = decided.length ? Math.round((decided.reduce((s, r) => s + (r.decidedAt!.getTime() - r.request.createdAt.getTime()), 0) / decided.length / 3600_000) * 10) / 10 : null;
    const reasons = new Map<string, number>(), questions = new Map<string, { text: string; count: number }>();
    for (const r of rows) for (const i of r.items) {
      reasons.set(i.reason, (reasons.get(i.reason) ?? 0) + 1);
      const q = questions.get(i.questionId) ?? { text: i.questionText.slice(0, 140), count: 0 };
      q.count++; questions.set(i.questionId, q);
    }
    return {
      totals: { submitted: rows.length, pending: by('PENDING'), underReview: by('UNDER_REVIEW'), approved: by('APPROVED'), partiallyApproved: by('PARTIALLY_APPROVED'), rejected: by('REJECTED'), withdrawn: by('WITHDRAWN'), escalated: rows.filter((r) => r.escalatedAt && !r.decidedAt && !r.withdrawnAt).length },
      averageReviewHours: avgHours,
      topReasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count })),
      topQuestions: [...questions.values()].sort((a, b) => b.count - a.count).slice(0, 10),
    };
  }

  /** Сводка для student dashboard: опубликованные результаты и состояние окна апелляции */
  async dashboard(studentId: string) {
    const rows = await this.prisma.examResult.findMany({ where: { studentId, publishedAt: { not: null }, source: { in: ['COMPUTER', 'PAPER'] } }, orderBy: { publishedAt: 'desc' }, take: 5, include: { exam: { select: { subject: { select: { name: true } }, window: { select: { kind: true } } } } } });
    const out = [];
    for (const r of rows) {
      const el = await this.eligibility(r);
      out.push({ resultId: r.id, subject: r.exam?.subject.name ?? '', kind: r.exam?.window.kind ?? r.kind, examScore: num(r.revisedExamScore ?? r.examScore), total: num(r.revisedTotal ?? r.total), letter: r.revisedLetter ?? r.letter, passed: r.revisedPassed ?? r.passed, publishedAt: r.publishedAt, appeal: el });
    }
    return out;
  }

  isDecided(status: RequestStatus) { return DECIDED.includes(status); }
}
