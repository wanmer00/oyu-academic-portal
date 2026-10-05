import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditCtx } from '../../common/audit/audit-trail.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { Actor, ExamCommon, Tx } from './exam-common.service';
import { evaluateTotals, letterFor, scoreExam } from './exam.rules';

export type FinishedBy = 'STUDENT' | 'SYSTEM' | 'PROCTOR';

/**
 * Завершение попытки, оценивание и переходы Final → Resit → Retake.
 * Оценка считается только на backend из неизменяемого снапшота и сохранённых ответов.
 */
@Injectable()
export class AttemptService {
  private readonly log = new Logger(AttemptService.name);
  constructor(private readonly prisma: PrismaService, private readonly common: ExamCommon) {}

  /** Атомарно завершает IN_PROGRESS-попытку. Повторный вызов безопасен (вернёт null, результат уже создан). */
  async finalize(attemptId: string, by: FinishedBy, actor: Actor | null = null, ctx: AuditCtx = {}, extra: { reason?: string } = {}) {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const cur = await tx.examAttempt.findUnique({ where: { id: attemptId }, select: { status: true, expiresAt: true } });
      if (!cur || cur.status !== 'IN_PROGRESS') return null;
      // клиентская сдача после истечения времени считается автосдачей по времени окончания
      const late = !!cur.expiresAt && now >= cur.expiresAt;
      const effectiveBy: FinishedBy = by === 'STUDENT' && late ? 'SYSTEM' : by;
      const status = effectiveBy === 'PROCTOR' ? 'TERMINATED' : effectiveBy === 'SYSTEM' ? 'AUTO_SUBMITTED' : 'SUBMITTED';
      const upd = await tx.examAttempt.updateMany({
        where: { id: attemptId, status: 'IN_PROGRESS' },
        data: { status, submittedAt: late && cur.expiresAt ? cur.expiresAt : now, submittedBy: effectiveBy, terminateReason: extra.reason ?? null },
      });
      if (upd.count !== 1) return null;
      const attempt = await tx.examAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { questions: true, enrollment: true, exam: { include: { window: true } } } });
      const opts = await tx.questionOption.findMany({ where: { questionId: { in: attempt.questions.map((q) => q.questionId) } }, select: { id: true, questionId: true, isCorrect: true } });
      const correctByQuestion = new Map(opts.filter((o) => o.isCorrect).map((o) => [o.questionId, o.id]));
      const answers = attempt.questions.map((q) => (q.selectedOptionId == null ? 'SKIP' : q.selectedOptionId === correctByQuestion.get(q.questionId) ? 'CORRECT' : 'WRONG') as 'CORRECT' | 'WRONG' | 'SKIP');
      const entry = attempt.enrollment.entryScore != null ? Number(attempt.enrollment.entryScore) : (await this.common.entryScore(attempt.studentId, attempt.exam.subjectId, attempt.enrollment.academicYear, attempt.enrollment.term, tx)) ?? 0;
      const score = scoreExam({ answers, entryScore: entry }, { passTotal: this.common.cfg.passTotal(), minExam: this.common.cfg.minExam() });
      const result = await tx.examResult.create({
        data: {
          attemptId, examId: attempt.examId, studentId: attempt.studentId, enrollmentId: attempt.enrollmentId, kind: attempt.kind, source: 'COMPUTER',
          correct: score.correct, wrong: score.wrong, skipped: score.skipped, examScore: score.examScore, entryScore: score.entryScore, total: score.total, letter: score.letter,
          passed: score.passed, failReason: score.failReason, rulesVersion: attempt.rulesVersion,
        },
      });
      await this.common.log(tx, actor, effectiveBy === 'STUDENT' ? 'submitted' : effectiveBy === 'SYSTEM' ? 'auto_submitted' : 'terminated', 'ExamAttempt', attemptId, { examId: attempt.examId, studentId: attempt.studentId, by: effectiveBy, reason: extra.reason ?? null }, ctx);
      await this.common.log(tx, null, 'result_generated', 'ExamResult', result.id, { attemptId, examScore: score.examScore, total: score.total, passed: score.passed, failReason: score.failReason }, ctx);
      await this.applyOutcome(tx, attempt.enrollment, attempt.kind, score.passed, attempt.studentId);
      if (this.common.cfg.instantResult()) await this.publishTx(tx, [result.id], null, ctx);
      return result;
    });
  }

  /** Конечный автомат статуса предмета после экзамена */
  async applyOutcome(tx: Tx, enrollment: { id: string; status: string }, kind: 'FINAL' | 'RESIT', passed: boolean, studentId: string) {
    if (kind === 'FINAL') {
      await tx.subjectEnrollment.update({ where: { id: enrollment.id }, data: { status: passed ? 'COMPLETED' : 'RESIT_ELIGIBLE' } });
      return;
    }
    await tx.subjectEnrollment.update({ where: { id: enrollment.id }, data: { status: passed ? 'COMPLETED' : 'RETAKE_REQUIRED' } });
    const r = await tx.resitEligibility.findFirst({ where: { enrollmentId: enrollment.id, studentId, status: 'PAID' }, orderBy: { createdAt: 'desc' } });
    if (r) await tx.resitEligibility.update({ where: { id: r.id }, data: { status: 'USED' } });
  }

  /** Публикация результатов: видны студенту, итог записывается в Journal как FINAL */
  async publishTx(tx: Tx, resultIds: string[], actor: Actor | null, ctx: AuditCtx) {
    const rows = await tx.examResult.findMany({ where: { id: { in: resultIds }, publishedAt: null }, include: { enrollment: true, exam: { select: { subjectId: true, subject: { select: { name: true } } } } } });
    for (const r of rows) {
      await tx.examResult.update({ where: { id: r.id }, data: { publishedAt: new Date() } });
      if (r.source !== 'ABSENT' && r.exam) {
        // DEMO-тест пишется в Journal по реальному циклу предмета студента (отдельный «год» теста в журнал не попадает)
        const target = r.enrollment.source === 'DEMO'
          ? await tx.subjectEnrollment.findFirst({ where: { studentId: r.studentId, subjectId: r.exam.subjectId, source: { not: 'DEMO' } }, orderBy: { academicYear: 'desc' } })
          : r.enrollment;
        if (target) await this.common.writeFinalToJournal(tx, { studentId: r.studentId, subjectId: r.exam.subjectId, academicYear: target.academicYear, term: target.term, semester: target.semester, examScore: Number(r.examScore), reason: `Exam ${r.kind} result ${r.id}${r.enrollment.source === 'DEMO' ? ' (demo practice)' : ''}` });
      }
      await this.common.log(tx, actor, 'result_published', 'ExamResult', r.id, { studentId: r.studentId, passed: r.passed }, ctx);
    }
    // уведомления вне гонок транзакции — после коммита было бы идеальнее, но ошибка уведомления не критична
    for (const r of rows) {
      void this.common.notify([r.studentId], 'ACADEMIC',
        { az: 'İmtahan nəticəsi', ru: 'Результат экзамена', en: 'Exam result' },
        { az: `${r.exam?.subject.name}: ${Number(r.total)} (${r.letter}) — ${r.passed ? 'keçdi' : 'keçmədi'}`, ru: `${r.exam?.subject.name}: ${Number(r.total)} (${r.letter}) — ${r.passed ? 'сдан' : 'не сдан'}`, en: `${r.exam?.subject.name}: ${Number(r.total)} (${r.letter}) — ${r.passed ? 'passed' : 'failed'}` }, 'exams');
    }
    return rows.length;
  }

  async publish(resultIds: string[], actor: Actor, ctx: AuditCtx) {
    return this.prisma.$transaction((tx) => this.publishTx(tx, resultIds, actor, ctx));
  }

  /** Автосдача всех истёкших попыток (вызывается планировщиком и при обращении к попытке) */
  async autoSubmitExpired(now = new Date()): Promise<number> {
    const due = await this.prisma.examAttempt.findMany({ where: { status: 'IN_PROGRESS', expiresAt: { lte: now } }, select: { id: true }, take: 200 });
    let n = 0;
    for (const a of due) {
      try { if (await this.finalize(a.id, 'SYSTEM')) n++; } catch (e) { this.log.error(`auto-submit ${a.id}: ${(e as Error).message}`); }
    }
    return n;
  }

  /** Авторизации без START: истёк токен — попытка VOID (не считается), рабочее место освобождается */
  async voidExpiredAuthorizations(now = new Date()): Promise<number> {
    const due = await this.prisma.examAttempt.findMany({ where: { status: 'AUTHORIZED', authorization: { usedAt: null, expiresAt: { lte: now } } }, select: { id: true, authorizationId: true } });
    for (const a of due) {
      await this.prisma.$transaction(async (tx) => {
        const u = await tx.examAttempt.updateMany({ where: { id: a.id, status: 'AUTHORIZED' }, data: { status: 'VOID' } });
        if (u.count) {
          await tx.proctorAuthorization.update({ where: { id: a.authorizationId }, data: { revokedAt: now, revokeReason: 'EXPIRED' } });
          await this.common.log(tx, null, 'authorization_expired', 'ProctorAuthorization', a.authorizationId, { attemptId: a.id });
        }
      });
    }
    return due.length;
  }

  /** Результат для отображения (без утечки правильных ответов) */
  /** Действующий результат: после апелляции — пересмотренные баллы (исходные остаются в original) */
  resultView(r: { id: string; kind: string; correct: number; wrong: number; skipped: number; examScore: Prisma.Decimal; entryScore: Prisma.Decimal; total: Prisma.Decimal; letter: string; passed: boolean; failReason: string | null; createdAt: Date; publishedAt: Date | null; revisedExamScore?: Prisma.Decimal | null; revisedTotal?: Prisma.Decimal | null; revisedLetter?: string | null; revisedPassed?: boolean | null; revisedAt?: Date | null }) {
    const rev = !!r.revisedAt;
    const exam = Number(rev ? r.revisedExamScore : r.examScore), total = Number(rev ? r.revisedTotal : r.total), passed = rev ? !!r.revisedPassed : r.passed;
    return {
      id: r.id, kind: r.kind, correct: r.correct, wrong: r.wrong, skipped: r.skipped,
      examScore: exam, examMax: 50, entryScore: Number(r.entryScore), total, totalMax: 100,
      letter: rev ? r.revisedLetter ?? letterFor(total) : r.letter, passed, failReason: passed ? null : rev ? evaluateTotals(Number(r.entryScore), exam).failReason : r.failReason,
      original: rev ? { examScore: Number(r.examScore), total: Number(r.total), letter: r.letter, passed: r.passed } : null, revisedAt: r.revisedAt ?? null,
      minExamScore: this.common.cfg.minExam(), passTotal: this.common.cfg.passTotal(),
      createdAt: r.createdAt, publishedAt: r.publishedAt,
    };
  }
}
