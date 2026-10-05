import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { TeacherAccessService } from '../teachers/teacher-access.service';

export interface ResultFilter {
  windowId?: string; kind?: string; subjectId?: string; groupName?: string; specialtyId?: string; facultyId?: string;
  academicYear?: string; term?: string; status?: string; from?: string; to?: string;
}

const avg = (a: number[]) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 100) / 100 : null);

/** Результаты и аналитика для Management (в пределах области руководства) и преподавателя (только после публикации) */
@Injectable()
export class ResultsService {
  constructor(private readonly prisma: PrismaService, private readonly access: TeacherAccessService) {}

  /** Пересечение фильтров по структуре с областью руководства → список групп (null — без ограничений) */
  private async groupsFor(q: ResultFilter, orgGroups: string[] | null): Promise<string[] | null> {
    let g: string[] | null = orgGroups;
    const restrict = (names: string[]) => { g = g ? g.filter((x) => names.includes(x)) : names; };
    if (q.groupName) restrict([q.groupName]);
    if (q.specialtyId) restrict((await this.prisma.academicGroup.findMany({ where: { specialtyId: q.specialtyId }, select: { name: true } })).map((x) => x.name));
    if (q.facultyId) restrict((await this.prisma.academicGroup.findMany({ where: { specialty: { department: { facultyId: q.facultyId } } }, select: { name: true } })).map((x) => x.name));
    return g;
  }

  private where(q: ResultFilter, groups: string[] | null): Prisma.ExamResultWhereInput {
    return {
      enrollment: { source: { not: 'DEMO' } },
      ...(q.kind ? { kind: q.kind as never } : {}),
      ...(q.status === 'PASSED' ? { passed: true } : q.status === 'FAILED' ? { passed: false } : q.status === 'ABSENT' ? { source: 'ABSENT' } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(`${q.to}T23:59:59Z`) } : {}) } } : {}),
      ...(groups ? { student: { groupName: { in: groups } } } : {}),
      exam: { ...(q.windowId ? { windowId: q.windowId } : {}), ...(q.subjectId ? { subjectId: q.subjectId } : {}), ...(q.academicYear || q.term ? { window: { ...(q.academicYear ? { academicYear: q.academicYear } : {}), ...(q.term ? { term: q.term as never } : {}) } } : {}) },
    };
  }

  async list(q: ResultFilter, orgGroups: string[] | null) {
    const groups = await this.groupsFor(q, orgGroups);
    const rows = await this.prisma.examResult.findMany({
      where: this.where(q, groups), orderBy: { createdAt: 'desc' }, take: 1000,
      include: { student: { select: { groupName: true, user: { select: { fullName: true, loginId: true } } } }, exam: { select: { subject: { select: { code: true, name: true } }, window: { select: { title: true, academicYear: true, term: true } } } } },
    });
    return rows.map((r) => ({
      id: r.id, kind: r.kind, source: r.source, student: { fullName: r.student.user.fullName, loginId: r.student.user.loginId, groupName: r.student.groupName },
      subject: r.exam?.subject ?? null, window: r.exam?.window.title ?? null, entryScore: Number(r.entryScore), examScore: Number(r.revisedExamScore ?? r.examScore), total: Number(r.revisedTotal ?? r.total), letter: r.revisedLetter ?? r.letter, passed: r.revisedPassed ?? r.passed, failReason: (r.revisedPassed ?? r.passed) ? null : r.failReason, revised: !!r.revisedAt,
      correct: r.correct, wrong: r.wrong, skipped: r.skipped, date: r.createdAt, published: !!r.publishedAt,
    }));
  }

  /** Результаты, ожидающие публикации */
  async pending(orgGroups: string[] | null) {
    return this.list({}, orgGroups).then((r) => r.filter((x) => !x.published));
  }

  async analytics(q: ResultFilter, orgGroups: string[] | null) {
    const groups = await this.groupsFor(q, orgGroups);
    const exams = await this.prisma.exam.findMany({
      where: { ...(q.windowId ? { windowId: q.windowId } : {}), ...(q.subjectId ? { subjectId: q.subjectId } : {}), window: { ...(q.kind ? { kind: q.kind as never } : {}), ...(q.academicYear ? { academicYear: q.academicYear } : {}), ...(q.term ? { term: q.term as never } : {}) } },
      select: { id: true, subjectId: true, windowId: true, subject: { select: { name: true } }, window: { select: { kind: true, academicYear: true, term: true, status: true } } },
    });
    const examIds = exams.map((e) => e.id);
    const studentFilter = groups ? { student: { groupName: { in: groups } } } : {};
    const results = await this.prisma.examResult.findMany({ where: { examId: { in: examIds }, enrollment: { source: { not: 'DEMO' } }, ...studentFilter }, select: { examId: true, source: true, passed: true, examScore: true, total: true, letter: true, studentId: true, kind: true, revisedAt: true, revisedExamScore: true, revisedTotal: true, revisedLetter: true, revisedPassed: true } })
      // действующий результат (после апелляции — пересмотренный)
      .then((rs) => rs.map((r) => (r.revisedAt ? { ...r, examScore: r.revisedExamScore!, total: r.revisedTotal!, letter: r.revisedLetter!, passed: !!r.revisedPassed } : r)));
    const attempts = await this.prisma.examAttempt.groupBy({ by: ['status'], where: { examId: { in: examIds }, status: { not: 'VOID' }, ...studentFilter }, _count: { _all: true } });
    const active = attempts.filter((a) => a.status === 'IN_PROGRESS' || a.status === 'AUTHORIZED').reduce((s, a) => s + a._count._all, 0);

    // студенты, которым предстоит/предстояло сдавать: enrollments предметов окон (FINAL) в цикле окна
    const finals = exams.filter((e) => e.window.kind === 'FINAL');
    let invited = 0;
    for (const key of new Set(finals.map((e) => `${e.subjectId}|${e.window.academicYear}|${e.window.term}`))) {
      const [subjectId, academicYear, term] = key.split('|');
      invited += await this.prisma.subjectEnrollment.count({ where: { subjectId, academicYear, term: term as never, attemptNo: 1, ...studentFilter } });
    }
    const taken = results.filter((r) => r.source !== 'ABSENT');
    const dist: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };
    for (const r of taken) dist[r.letter] = (dist[r.letter] ?? 0) + 1;
    const bySubject = new Map<string, { subject: string; taken: number; failed: number }>();
    for (const r of results) {
      const e = exams.find((x) => x.id === r.examId); if (!e) continue;
      const s = bySubject.get(e.subjectId) ?? { subject: e.subject.name, taken: 0, failed: 0 };
      s.taken++; if (!r.passed) s.failed++;
      bySubject.set(e.subjectId, s);
    }
    const [resitCounts, payments, retakeRequired] = await Promise.all([
      this.prisma.resitEligibility.groupBy({ by: ['status'], where: { ...studentFilter }, _count: { _all: true } }),
      this.prisma.payment.groupBy({ by: ['status'], where: { type: 'RETAKE', ...studentFilter }, _count: { _all: true }, _sum: { amount: true } }),
      this.prisma.subjectEnrollment.count({ where: { status: 'RETAKE_REQUIRED', ...studentFilter } }),
    ]);
    const eligibleResit = await this.prisma.subjectEnrollment.count({ where: { status: { in: ['RESIT_ELIGIBLE', 'RESIT_PAYMENT_PENDING', 'RESIT_PAID'] }, ...studentFilter } });
    const absent = results.filter((r) => r.source === 'ABSENT').length;
    return {
      totals: { invited, completed: taken.length, active, absent, notTaken: Math.max(0, invited - taken.length - active - absent), passed: taken.filter((r) => r.passed).length, failed: results.filter((r) => !r.passed).length },
      averages: { examScore: avg(taken.map((r) => Number(r.examScore))), total: avg(taken.map((r) => Number(r.total))) },
      grades: dist,
      subjectFailure: [...bySubject.values()].map((s) => ({ ...s, rate: s.taken ? Math.round((s.failed / s.taken) * 1000) / 10 : 0 })).sort((a, b) => b.rate - a.rate),
      resit: { eligible: eligibleResit, byStatus: Object.fromEntries(resitCounts.map((r) => [r.status, r._count._all])) },
      payments: payments.map((p) => ({ status: p.status, count: p._count._all, amount: Number(p._sum.amount ?? 0) })),
      retakeRequired,
    };
  }

  // ───────────────────────── преподаватель ─────────────────────────
  /** Преподаватель видит результаты своих предметов только после публикации */
  async teacherResults(userId: string, subjectId?: string) {
    const sc = await this.access.scope(userId);
    if (subjectId && !sc.subjectIds.includes(subjectId)) throw new ForbiddenException('You do not teach this subject');
    const rows = await this.prisma.examResult.findMany({
      where: { publishedAt: { not: null }, enrollment: { source: { not: 'DEMO' } }, exam: { subjectId: subjectId ?? { in: sc.subjectIds } }, student: { groupName: { in: sc.groups } } },
      orderBy: { createdAt: 'desc' }, take: 1000,
      include: { student: { select: { groupName: true, user: { select: { fullName: true, loginId: true } } } }, exam: { select: { subject: { select: { code: true, name: true } }, window: { select: { title: true } } } } },
    });
    return rows.map((r) => ({
      id: r.id, kind: r.kind, student: { fullName: r.student.user.fullName, loginId: r.student.user.loginId, groupName: r.student.groupName }, subject: r.exam?.subject, window: r.exam?.window.title,
      examScore: Number(r.revisedExamScore ?? r.examScore), total: Number(r.revisedTotal ?? r.total), letter: r.revisedLetter ?? r.letter, passed: r.revisedPassed ?? r.passed, source: r.source, date: r.createdAt, revised: !!r.revisedAt,
    }));
  }
}
