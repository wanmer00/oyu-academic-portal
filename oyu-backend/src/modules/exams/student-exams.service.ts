import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { env } from '../../config/env';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AttemptService } from './attempt.service';
import { EligibilityService } from './eligibility.service';
import { ExamCommon } from './exam-common.service';
import { checkWindow, isoDate, nextAllowedDate } from './exam.rules';
import { ResitService } from './resit.service';
import { RetakeService } from './retake.service';

/** Витрина EXAMS студента: Upcoming / Available / Completed / Resits / Results / Retakes и статусы предметов */
@Injectable()
export class StudentExamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly common: ExamCommon,
    private readonly eligibility: EligibilityService,
    private readonly attempts: AttemptService,
    private readonly resits: ResitService,
    private readonly retakes: RetakeService,
  ) {}

  private async requireStudent(userId: string) {
    const s = await this.prisma.student.findUnique({ where: { userId }, select: { userId: true } });
    if (!s) throw new ForbiddenException('Only students have exams');
  }

  async overview(userId: string, now = new Date()) {
    await this.requireStudent(userId);
    const enrollments = await this.prisma.subjectEnrollment.findMany({ where: { studentId: userId, source: { not: 'DEMO' } }, include: { subject: { select: { id: true, code: true, name: true } } }, orderBy: [{ academicYear: 'desc' }, { updatedAt: 'desc' }] });
    const subjectIds = [...new Set(enrollments.map((e) => e.subjectId))];

    // ── Upcoming / Available ──
    const exams = await this.prisma.exam.findMany({
      where: { subjectId: { in: subjectIds }, window: { status: 'PUBLISHED', title: { not: { startsWith: 'DEMO' } } } },
      include: { subject: { select: { id: true, code: true, name: true } }, window: true }, orderBy: { window: { startDate: 'asc' } },
    });
    const upcoming: unknown[] = [], available: unknown[] = [];
    for (const e of exams) {
      const el = await this.eligibility.evaluate(e.id, userId, now);
      if (el.reasons.some((r) => ['NOT_IN_SCOPE', 'NOT_ENROLLED', 'RESIT_NOT_ELIGIBLE', 'ALREADY_PASSED', 'ATTEMPT_EXISTS', 'RETAKE_REQUIRED', 'ALREADY_TAKEN_FINAL'].includes(r))) continue;
      const w = e.window;
      const dayOk = checkWindow(w, now, { time: false }) === null;
      const timeOk = checkWindow(w, now) === null;
      const row = {
        examId: e.id, subject: e.subject, kind: w.kind, delivery: e.delivery, questions: e.questionCount, durationMin: e.durationMin,
        window: { id: w.id, title: w.title, startDate: isoDate(w.startDate), endDate: isoDate(w.endDate), weekdays: w.allowedWeekdays, startTime: w.startTime, endTime: w.endTime },
        semester: w.academicYear + ' ' + w.term, nextDate: nextAllowedDate(w, now),
        admission: { eligible: el.reasons.filter((r) => !['OUTSIDE_ALLOWED_TIME', 'WEEKDAY_NOT_ALLOWED', 'WINDOW_NOT_STARTED'].includes(r)).length === 0, reasons: el.reasons },
        resitPaymentRequired: el.reasons.includes('RESIT_NOT_PAID'),
        startableNow: timeOk && el.eligible,
      };
      (dayOk ? available : upcoming).push(row); // Available — сегодня разрешённый день окна; причины, мешающие старту, видны в admission
    }

    // ── Completed ──
    const done = await this.prisma.examAttempt.findMany({
      where: { studentId: userId, status: { in: ['SUBMITTED', 'AUTO_SUBMITTED', 'TERMINATED'] } }, orderBy: { submittedAt: 'desc' }, take: 100,
      include: { exam: { select: { id: true, subject: { select: { code: true, name: true } }, window: { select: { title: true, kind: true } } } }, result: { select: { id: true, publishedAt: true, passed: true } } },
    });
    const absent = await this.prisma.examResult.findMany({ where: { studentId: userId, source: 'ABSENT' }, include: { exam: { select: { id: true, subject: { select: { code: true, name: true } }, window: { select: { title: true, kind: true } } } } } });
    const completed = [
      ...done.map((a) => ({ examId: a.examId, attemptId: a.id, subject: a.exam.subject, kind: a.exam.window.kind, window: a.exam.window.title, date: a.submittedAt, status: a.status, resultId: a.result?.publishedAt ? a.result.id : null, awaitingResult: !a.result?.publishedAt })),
      ...absent.map((r) => ({ examId: r.examId, attemptId: null, subject: r.exam!.subject, kind: r.exam!.window.kind, window: r.exam!.window.title, date: r.createdAt, status: 'ABSENT', resultId: r.id, awaitingResult: false })),
    ];

    // ── Results ──
    const results = (await this.prisma.examResult.findMany({ where: { studentId: userId, publishedAt: { not: null } }, orderBy: { createdAt: 'desc' }, include: { exam: { select: { subject: { select: { code: true, name: true } }, window: { select: { title: true } } } } } }))
      .map((r) => ({ ...this.attempts.resultView(r), source: r.source, subject: r.exam?.subject ?? null, window: r.exam?.window.title ?? null }));

    // ── Resits / Retakes ──
    const resit = await this.resits.listForStudent(userId, now);
    const retakeNeeded = enrollments.filter((e) => e.status === 'RETAKE_REQUIRED' || e.status === 'RESIT_FORFEITED' || (e.status === 'RESIT_ELIGIBLE' && resit.items.find((i) => i.enrollmentId === e.id)?.limitReached));
    const retakeRows = [];
    for (const e of retakeNeeded) retakeRows.push({ status: e.status, reason: e.status === 'RETAKE_REQUIRED' ? 'RESIT_FAILED' : e.status === 'RESIT_FORFEITED' ? 'RESIT_MISSED' : 'RESIT_LIMIT', ...(await this.retakes.options(userId, e.id, now)) });
    const registered = await this.prisma.retakeEnrollment.findMany({
      where: { studentId: userId }, orderBy: { createdAt: 'desc' },
      include: { subject: { select: { code: true, name: true } }, summerCourse: { select: { period: { select: { title: true, startDate: true, endDate: true } }, schedule: true } }, offering: { select: { academicYear: true, term: true, course: true, startsAt: true } } },
    });

    // ── Статусы предметов (последний enrollment по предмету) ──
    const latest = new Map<string, (typeof enrollments)[number]>();
    for (const e of enrollments) { const cur = latest.get(e.subjectId); if (!cur || e.academicYear > cur.academicYear || (e.academicYear === cur.academicYear && e.attemptNo > cur.attemptNo)) latest.set(e.subjectId, e); }
    const subjects = [...latest.values()].map((e) => ({ enrollmentId: e.id, subject: e.subject, academicYear: e.academicYear, term: e.term, semester: e.semester, attemptNo: e.attemptNo, status: e.status, source: e.source }));

    return {
      demo: env.DEMO_MODE, serverNow: now, upcoming: upcoming, available: available, completed, results,
      resits: resit, retakes: { required: retakeRows, registered: registered.map((r) => ({ id: r.id, mode: r.mode, status: r.status, subject: r.subject, summer: r.summerCourse ? { title: r.summerCourse.period.title, startDate: isoDate(r.summerCourse.period.startDate), endDate: isoDate(r.summerCourse.period.endDate), schedule: r.summerCourse.schedule } : null, offering: r.offering ? { academicYear: r.offering.academicYear, term: r.offering.term, course: r.offering.course, startsAt: isoDate(r.offering.startsAt) } : null })) },
      subjects,
    };
  }

  /** Детальный результат — только свой и только опубликованный */
  async result(userId: string, resultId: string) {
    const r = await this.prisma.examResult.findFirst({ where: { id: resultId, studentId: userId, publishedAt: { not: null } }, include: { exam: { select: { subject: { select: { code: true, name: true } }, window: { select: { title: true } } } } } });
    if (!r) throw new NotFoundException('Result not found');
    return { ...this.attempts.resultView(r), source: r.source, subject: r.exam?.subject ?? null, window: r.exam?.window.title ?? null };
  }
}
