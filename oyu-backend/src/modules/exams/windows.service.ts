import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ExamKind, Prisma, Term } from '@prisma/client';
import { z } from 'zod';
import { AuditCtx } from '../../common/audit/audit-trail.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AttemptService } from './attempt.service';
import { Actor, ExamCommon } from './exam-common.service';
import { addDays, cycleKey, defaultResitWindow, isoDate, localParts, toMinutes } from './exam.rules';

const hhmm = z.string().regex(/^\d{1,2}:\d{2}$/).refine((v) => { try { const m = toMinutes(v); return m >= 0 && m < 1440; } catch { return false; } }, 'Bad time');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const scope = z.object({ facultyId: z.string().optional(), specialtyId: z.string().optional(), groupName: z.string().optional() }).refine((s) => !!(s.facultyId || s.specialtyId || s.groupName), 'Empty scope');

export const WindowSchema = z.object({
  title: z.string().trim().min(3).max(120),
  kind: z.nativeEnum(ExamKind).default('FINAL'),
  academicYear: z.string().regex(/^\d{4}-\d{4}$/),
  term: z.nativeEnum(Term),
  startDate: day,
  endDate: day,
  allowedWeekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  startTime: hhmm,
  endTime: hhmm,
  maxPerWeek: z.number().int().min(1).max(7).default(3),
  questionDeadline: z.string().datetime().optional(),
  finalWindowId: z.string().optional(),
  scopes: z.array(scope).max(100).default([]),
});
export type WindowDto = z.infer<typeof WindowSchema>;
export const ExamSchema = z.object({ subjectId: z.string(), delivery: z.enum(['COMPUTER', 'PAPER']).default('COMPUTER'), questionCount: z.number().int().min(5).max(100).default(25) });
export const ResitWindowSchema = z.object({
  title: z.string().trim().min(3).max(120).optional(),
  startDate: day.optional(), endDate: day.optional(),
  allowedWeekdays: z.array(z.number().int().min(1).max(7)).min(1).optional(),
  startTime: hhmm.optional(), endTime: hhmm.optional(),
});

@Injectable()
export class WindowsService {
  constructor(private readonly prisma: PrismaService, private readonly common: ExamCommon, private readonly attempts: AttemptService) {}

  private check(d: { startDate: string; endDate: string; startTime: string; endTime: string }) {
    if (d.startDate > d.endDate) throw new BadRequestException({ message: 'startDate must not be after endDate', code: 'WINDOW_DATES_INVALID' });
    if (toMinutes(d.startTime) >= toMinutes(d.endTime)) throw new BadRequestException({ message: 'startTime must be before endTime', code: 'WINDOW_TIME_INVALID' });
  }

  private view(w: Prisma.ExamWindowGetPayload<{ include: { scopes: true; _count: { select: { exams: true } } } }>) {
    return {
      id: w.id, title: w.title, kind: w.kind, academicYear: w.academicYear, term: w.term, startDate: isoDate(w.startDate), endDate: isoDate(w.endDate),
      allowedWeekdays: w.allowedWeekdays, startTime: w.startTime, endTime: w.endTime, maxPerWeek: w.maxPerWeek, questionDeadline: w.questionDeadline,
      status: w.status, finalWindowId: w.finalWindowId, version: w.version, scopes: w.scopes, examCount: w._count.exams,
    };
  }

  async list(q: { kind?: string; status?: string }) {
    const rows = await this.prisma.examWindow.findMany({
      where: { title: { not: { startsWith: 'DEMO' } }, ...(q.kind ? { kind: q.kind as ExamKind } : {}), ...(q.status ? { status: q.status as never } : {}) },
      orderBy: [{ startDate: 'desc' }], include: { scopes: true, _count: { select: { exams: true } } },
    });
    return rows.map((w) => this.view(w));
  }

  async get(id: string) {
    const w = await this.prisma.examWindow.findUnique({
      where: { id },
      include: { scopes: true, _count: { select: { exams: true } }, exams: { include: { subject: { select: { id: true, code: true, name: true, credits: true } } }, orderBy: { subject: { name: 'asc' } } } },
    });
    if (!w) throw new NotFoundException('Exam window not found');
    const now = new Date();
    const exams = await Promise.all(w.exams.map(async (e) => {
      const versions = await this.prisma.questionBankVersion.findMany({ where: { bank: { subjectId: e.subjectId } }, orderBy: { version: 'desc' }, take: 5, select: { id: true, version: true, status: true, _count: { select: { questions: true } } } });
      const approved = versions.find((v) => v.status === 'APPROVED') ?? null;
      const latest = versions[0] ?? null;
      const bankStatus = approved ? 'APPROVED' : latest ? latest.status : 'NONE';
      const ready = !!approved && approved._count.questions >= e.questionCount;
      const [attempts, sheets] = await Promise.all([this.prisma.examAttempt.count({ where: { examId: e.id, status: { not: 'VOID' } } }), this.prisma.paperAnswerSheet.count({ where: { examId: e.id } })]);
      return {
        id: e.id, subject: e.subject, delivery: e.delivery, questionCount: e.questionCount, durationMin: e.durationMin, bankVersionId: e.bankVersionId,
        bank: { status: bankStatus, version: (approved ?? latest)?.version ?? null, questions: (approved ?? latest)?._count.questions ?? 0, ready },
        overdue: !ready && now > w.questionDeadline && w.status !== 'CLOSED' && w.status !== 'CANCELLED',
        attempts, sheets,
      };
    }));
    return { ...this.view(w), exams };
  }

  async create(actor: Actor, dto: WindowDto, ctx: AuditCtx) {
    this.check(dto);
    if (dto.kind === 'RESIT') {
      const f = dto.finalWindowId ? await this.prisma.examWindow.findUnique({ where: { id: dto.finalWindowId } }) : null;
      if (!f || f.kind !== 'FINAL') throw new BadRequestException({ message: 'RESIT window requires a FINAL window', code: 'RESIT_NEEDS_FINAL' });
    }
    const deadline = dto.questionDeadline ? new Date(dto.questionDeadline) : new Date(`${addDays(dto.startDate, -14)}T23:59:59+04:00`);
    const w = await this.prisma.$transaction(async (tx) => {
      const row = await tx.examWindow.create({
        data: {
          title: dto.title, kind: dto.kind, academicYear: dto.academicYear, term: dto.term, startDate: new Date(dto.startDate), endDate: new Date(dto.endDate), allowedWeekdays: [...new Set(dto.allowedWeekdays)].sort(),
          startTime: dto.startTime, endTime: dto.endTime, maxPerWeek: dto.maxPerWeek, questionDeadline: deadline, finalWindowId: dto.kind === 'RESIT' ? dto.finalWindowId : null, createdBy: actor.id,
          scopes: { create: dto.scopes },
        },
        include: { scopes: true, _count: { select: { exams: true } } },
      });
      await this.common.log(tx, actor, 'window_created', 'ExamWindow', row.id, { title: row.title, kind: row.kind, start: dto.startDate, end: dto.endDate, weekdays: dto.allowedWeekdays, time: `${dto.startTime}-${dto.endTime}` }, ctx);
      return row;
    });
    return this.view(w);
  }

  async update(actor: Actor, id: string, dto: Partial<WindowDto>, ctx: AuditCtx) {
    const cur = await this.prisma.examWindow.findUnique({ where: { id }, include: { scopes: true } });
    if (!cur) throw new NotFoundException('Exam window not found');
    if (cur.status === 'CLOSED' || cur.status === 'CANCELLED') throw new ConflictException({ message: 'Window is closed', code: 'WINDOW_CLOSED' });
    const next = {
      title: dto.title ?? cur.title, startDate: dto.startDate ?? isoDate(cur.startDate), endDate: dto.endDate ?? isoDate(cur.endDate),
      startTime: dto.startTime ?? cur.startTime, endTime: dto.endTime ?? cur.endTime,
    };
    this.check(next);
    if ((dto.academicYear && dto.academicYear !== cur.academicYear) || (dto.term && dto.term !== cur.term)) {
      const used = await this.prisma.examAttempt.count({ where: { exam: { windowId: id } } });
      if (used) throw new ConflictException({ message: 'Cycle cannot be changed after attempts exist', code: 'WINDOW_HAS_ATTEMPTS' });
    }
    const data: Prisma.ExamWindowUpdateInput = {
      title: next.title, startDate: new Date(next.startDate), endDate: new Date(next.endDate), startTime: next.startTime, endTime: next.endTime,
      ...(dto.allowedWeekdays ? { allowedWeekdays: [...new Set(dto.allowedWeekdays)].sort() } : {}),
      ...(dto.maxPerWeek ? { maxPerWeek: dto.maxPerWeek } : {}),
      ...(dto.questionDeadline ? { questionDeadline: new Date(dto.questionDeadline) } : {}),
      ...(dto.academicYear ? { academicYear: dto.academicYear } : {}), ...(dto.term ? { term: dto.term } : {}),
      version: { increment: 1 },
    };
    await this.prisma.$transaction(async (tx) => {
      if (dto.scopes) { await tx.examWindowScope.deleteMany({ where: { windowId: id } }); await tx.examWindowScope.createMany({ data: dto.scopes.map((s) => ({ ...s, windowId: id })) }); }
      await tx.examWindow.update({ where: { id }, data });
      await this.common.log(tx, actor, 'window_changed', 'ExamWindow', id, {
        old: { start: isoDate(cur.startDate), end: isoDate(cur.endDate), weekdays: cur.allowedWeekdays, time: `${cur.startTime}-${cur.endTime}`, maxPerWeek: cur.maxPerWeek },
        new: { start: next.startDate, end: next.endDate, weekdays: dto.allowedWeekdays ?? cur.allowedWeekdays, time: `${next.startTime}-${next.endTime}`, maxPerWeek: dto.maxPerWeek ?? cur.maxPerWeek },
      }, ctx);
    });
    return this.get(id);
  }

  async publish(actor: Actor, id: string, ctx: AuditCtx) {
    const w = await this.prisma.examWindow.findUnique({ where: { id }, include: { exams: true } });
    if (!w) throw new NotFoundException('Exam window not found');
    if (w.status !== 'DRAFT') throw new ConflictException({ message: 'Only a draft window can be published', code: 'WINDOW_STATE' });
    if (!w.exams.length) throw new BadRequestException({ message: 'Add at least one exam first', code: 'WINDOW_EMPTY' });
    await this.prisma.$transaction(async (tx) => {
      await tx.examWindow.update({ where: { id }, data: { status: 'PUBLISHED' } });
      await this.common.log(tx, actor, 'window_published', 'ExamWindow', id, { exams: w.exams.length }, ctx);
    });
    if (w.kind === 'FINAL') await this.syncEnrollments(actor, id, ctx);
    return this.get(id);
  }

  async cancel(actor: Actor, id: string, ctx: AuditCtx) {
    const w = await this.prisma.examWindow.findUnique({ where: { id } });
    if (!w) throw new NotFoundException('Exam window not found');
    if (w.status === 'CLOSED' || w.status === 'CANCELLED') throw new ConflictException({ message: 'Window is closed', code: 'WINDOW_CLOSED' });
    const used = await this.prisma.examAttempt.count({ where: { exam: { windowId: id }, status: { not: 'VOID' } } });
    if (used) throw new ConflictException({ message: 'Window already has attempts and cannot be cancelled', code: 'WINDOW_HAS_ATTEMPTS' });
    await this.prisma.$transaction(async (tx) => {
      await tx.examWindow.update({ where: { id }, data: { status: 'CANCELLED' } });
      await this.common.log(tx, actor, 'window_cancelled', 'ExamWindow', id, {}, ctx);
    });
    return this.get(id);
  }

  async addExam(actor: Actor, windowId: string, dto: z.infer<typeof ExamSchema>, ctx: AuditCtx) {
    const w = await this.prisma.examWindow.findUnique({ where: { id: windowId } });
    if (!w) throw new NotFoundException('Exam window not found');
    if (w.status === 'CLOSED' || w.status === 'CANCELLED') throw new ConflictException({ message: 'Window is closed', code: 'WINDOW_CLOSED' });
    if (!(await this.prisma.subject.findUnique({ where: { id: dto.subjectId }, select: { id: true } }))) throw new NotFoundException('Subject not found');
    const dup = await this.prisma.exam.findUnique({ where: { windowId_subjectId: { windowId, subjectId: dto.subjectId } } });
    if (dup) throw new ConflictException({ message: 'Subject is already in this window', code: 'EXAM_EXISTS' });
    const e = await this.prisma.$transaction(async (tx) => {
      const row = await tx.exam.create({ data: { windowId, subjectId: dto.subjectId, delivery: dto.delivery, questionCount: dto.questionCount, durationMin: this.common.cfg.duration() } });
      await this.common.log(tx, actor, 'exam_created', 'Exam', row.id, { windowId, subjectId: dto.subjectId, delivery: dto.delivery }, ctx);
      return row;
    });
    if (w.status === 'PUBLISHED' && w.kind === 'FINAL') await this.syncEnrollments(actor, windowId, ctx);
    return e;
  }

  async removeExam(actor: Actor, examId: string, ctx: AuditCtx) {
    const e = await this.prisma.exam.findUnique({ where: { id: examId }, include: { window: true } });
    if (!e) throw new NotFoundException('Exam not found');
    const used = await this.prisma.examAttempt.count({ where: { examId, status: { not: 'VOID' } } }) + (await this.prisma.paperAnswerSheet.count({ where: { examId } }));
    if (used) throw new ConflictException({ message: 'Exam already has attempts', code: 'EXAM_HAS_ATTEMPTS' });
    await this.prisma.$transaction(async (tx) => {
      await tx.examAttempt.deleteMany({ where: { examId, status: 'VOID' } });
      await tx.proctorAuthorization.deleteMany({ where: { examId } });
      await tx.exam.delete({ where: { id: examId } });
      await this.common.log(tx, actor, 'exam_deleted', 'Exam', examId, { windowId: e.windowId, subjectId: e.subjectId }, ctx);
    });
    return { ok: true };
  }

  /** Окно пересдач: по умолчанию ровно через неделю после окончания финального, будни, то же время; можно переопределить */
  async createResitWindow(actor: Actor, finalId: string, dto: z.infer<typeof ResitWindowSchema>, ctx: AuditCtx) {
    const f = await this.prisma.examWindow.findUnique({ where: { id: finalId }, include: { scopes: true, exams: true } });
    if (!f || f.kind !== 'FINAL') throw new NotFoundException('Final window not found');
    const existing = await this.prisma.examWindow.findFirst({ where: { finalWindowId: finalId, status: { not: 'CANCELLED' } } });
    if (existing) throw new ConflictException({ message: 'This final window already has a resit window', code: 'RESIT_WINDOW_EXISTS' });
    const d = defaultResitWindow(f);
    const spec = { ...d, ...Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)) } as typeof d & { title?: string };
    this.check(spec);
    const term: Term = f.term === 'SPRING' ? 'SUMMER' : f.term; // весенние предметы пересдаются летом
    const w = await this.prisma.$transaction(async (tx) => {
      const row = await tx.examWindow.create({
        data: {
          title: spec.title ?? `${f.title} — 25% resit`, kind: 'RESIT', academicYear: f.academicYear, term, startDate: new Date(spec.startDate), endDate: new Date(spec.endDate),
          allowedWeekdays: spec.allowedWeekdays, startTime: spec.startTime, endTime: spec.endTime, maxPerWeek: f.maxPerWeek, questionDeadline: new Date(`${addDays(spec.startDate, -7)}T23:59:59+04:00`),
          finalWindowId: f.id, createdBy: actor.id, scopes: { create: f.scopes.map((s) => ({ facultyId: s.facultyId, specialtyId: s.specialtyId, groupName: s.groupName })) },
          exams: { create: f.exams.map((e) => ({ subjectId: e.subjectId, delivery: e.delivery, questionCount: e.questionCount, durationMin: e.durationMin })) },
        },
        include: { scopes: true, _count: { select: { exams: true } } },
      });
      await this.common.log(tx, actor, 'window_created', 'ExamWindow', row.id, { kind: 'RESIT', finalWindowId: f.id, start: spec.startDate, end: spec.endDate }, ctx);
      return row;
    });
    return this.view(w);
  }

  /** Зачисляет студентов области окна на предметы экзаменов (по учебному плану и текущему семестру студента) */
  async syncEnrollments(actor: Actor | null, windowId: string, ctx: AuditCtx = {}) {
    const w = await this.prisma.examWindow.findUnique({ where: { id: windowId }, include: { exams: true, scopes: true } });
    if (!w || w.kind !== 'FINAL') return { created: 0 };
    let created = 0;
    const subjectIds = w.exams.map((e) => e.subjectId);
    const students = await this.prisma.student.findMany({ where: { user: { status: 'ACTIVE' } }, select: { userId: true, groupName: true, semester: true } });
    const groups = await this.prisma.academicGroup.findMany({ select: { name: true, specialty: { select: { id: true, department: { select: { facultyId: true } }, curriculum: { where: { subjectId: { in: subjectIds } }, select: { id: true, subjectId: true, semester: true, electiveGroup: true } } } } } });
    const gmap = new Map(groups.map((g) => [g.name, g]));
    const choices = await this.prisma.electiveChoice.findMany({ select: { studentId: true, curriculumItemId: true } });
    const chosen = new Set(choices.map((c) => `${c.studentId}|${c.curriculumItemId}`));
    const done = await this.prisma.subjectEnrollment.findMany({ where: { subjectId: { in: subjectIds }, status: 'COMPLETED' }, select: { studentId: true, subjectId: true } });
    const doneSet = new Set(done.map((d) => `${d.studentId}|${d.subjectId}`));
    const rows: Prisma.SubjectEnrollmentCreateManyInput[] = [];
    for (const s of students) {
      const g = gmap.get(s.groupName);
      if (!g) continue;
      if (!(await this.inScopeCached(w.scopes, g))) continue;
      for (const item of g.specialty.curriculum) {
        if (item.semester !== s.semester) continue;
        if (item.electiveGroup && !chosen.has(`${s.userId}|${item.id}`)) continue;
        if (doneSet.has(`${s.userId}|${item.subjectId}`)) continue;
        rows.push({ studentId: s.userId, subjectId: item.subjectId, academicYear: w.academicYear, term: w.term, semester: s.semester, source: 'CURRICULUM', status: 'ENROLLED' });
      }
    }
    for (let i = 0; i < rows.length; i += 500) created += (await this.prisma.subjectEnrollment.createMany({ data: rows.slice(i, i + 500), skipDuplicates: true })).count;
    if (created) await this.common.log(null, actor, 'enrollments_synced', 'ExamWindow', windowId, { created }, ctx);
    return { created };
  }

  private async inScopeCached(scopes: Array<{ facultyId: string | null; specialtyId: string | null; groupName: string | null }>, g: { name: string; specialty: { id: string; department: { facultyId: string } } }) {
    if (!scopes.length) return true;
    return scopes.some((s) => s.groupName === g.name || s.specialtyId === g.specialty.id || s.facultyId === g.specialty.department.facultyId);
  }

  /**
   * Закрытие окна. FINAL: студенты без попытки получают результат ABSENT (= провал, дальше как после обычного провала).
   * RESIT: неиспользованные resit сгорают (RESIT_FORFEITED); следующая возможность — resit-окно того же семестра в следующем цикле.
   */
  async close(actor: Actor | null, id: string, ctx: AuditCtx = {}) {
    const w = await this.prisma.examWindow.findUnique({ where: { id }, include: { exams: true, finalWindow: true, scopes: true } });
    if (!w) throw new NotFoundException('Exam window not found');
    if (w.status === 'CLOSED' || w.status === 'CANCELLED') return { closed: false };
    await this.attempts.autoSubmitExpired();
    await this.attempts.voidExpiredAuthorizations();
    let absent = 0, forfeited = 0;
    await this.prisma.$transaction(async (tx) => {
      if (w.kind === 'FINAL') {
        for (const e of w.exams) {
          const enrollments = await tx.subjectEnrollment.findMany({ where: { subjectId: e.subjectId, academicYear: w.academicYear, term: w.term, status: 'ENROLLED' } });
          for (const en of enrollments) {
            if (!(await this.common.inScope(w.id, en.studentId, tx))) continue;
            const live = await tx.examAttempt.count({ where: { examId: e.id, studentId: en.studentId, status: { not: 'VOID' } } }) + (await tx.paperAnswerSheet.count({ where: { examId: e.id, studentId: en.studentId } }));
            if (live) continue;
            const entry = en.entryScore != null ? Number(en.entryScore) : (await this.common.entryScore(en.studentId, e.subjectId, en.academicYear, en.term, tx)) ?? 0;
            const r = await tx.examResult.create({ data: { examId: e.id, studentId: en.studentId, enrollmentId: en.id, kind: 'FINAL', source: 'ABSENT', correct: 0, wrong: 0, skipped: 0, examScore: 0, entryScore: entry, total: entry, letter: 'F', passed: false, failReason: 'ABSENT', rulesVersion: e.rulesVersion, publishedAt: new Date() } });
            await this.attempts.applyOutcome(tx, en, 'FINAL', false, en.studentId);
            await this.common.log(tx, actor, 'student_absent', 'ExamResult', r.id, { examId: e.id, studentId: en.studentId }, ctx);
            absent++;
          }
        }
      } else if (w.finalWindow) {
        const f = w.finalWindow, key = cycleKey(f.academicYear, f.term);
        for (const e of w.exams) {
          const en = await tx.subjectEnrollment.findMany({ where: { subjectId: e.subjectId, term: f.term, academicYear: { lte: f.academicYear }, status: { in: ['RESIT_ELIGIBLE', 'RESIT_PAYMENT_PENDING', 'RESIT_PAID'] } } });
          for (const x of en) {
            const used = await tx.examAttempt.count({ where: { examId: e.id, studentId: x.studentId, status: { not: 'VOID' } } });
            if (used) continue;
            await tx.resitEligibility.updateMany({ where: { enrollmentId: x.id, cycleKey: key, status: { in: ['ELIGIBLE', 'PAYMENT_PENDING', 'PAID'] } }, data: { status: 'FORFEITED' } });
            await tx.subjectEnrollment.update({ where: { id: x.id }, data: { status: 'RESIT_FORFEITED' } });
            await this.common.log(tx, actor, 'resit_forfeited', 'SubjectEnrollment', x.id, { windowId: w.id, studentId: x.studentId, wasPaid: x.status === 'RESIT_PAID' }, ctx);
            forfeited++;
          }
        }
      }
      await tx.examWindow.update({ where: { id }, data: { status: 'CLOSED' } });
      await this.common.log(tx, actor, 'window_closed', 'ExamWindow', id, { absent, forfeited }, ctx);
    }, { timeout: 60000 });
    return { closed: true, absent, forfeited };
  }

  /** Планировщик: закрывает окна, чей последний день уже прошёл (по Asia/Baku) */
  async closeFinished(now = new Date()) {
    const today = localParts(now).date;
    const due = await this.prisma.examWindow.findMany({ where: { status: 'PUBLISHED', endDate: { lt: new Date(`${today}T00:00:00Z`) } }, select: { id: true } });
    for (const w of due) await this.close(null, w.id);
    return due.length;
  }
}
