import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ExamCommon, Tx } from './exam-common.service';
import { checkWindow, cycleKey, EXAM_RULES, weekRange } from './exam.rules';

export type EligibilityReason =
  | 'EXAM_NOT_FOUND' | 'WINDOW_NOT_PUBLISHED' | 'WINDOW_NOT_STARTED' | 'WINDOW_CLOSED' | 'WEEKDAY_NOT_ALLOWED' | 'OUTSIDE_ALLOWED_TIME'
  | 'NOT_IN_SCOPE' | 'NOT_ENROLLED' | 'ALREADY_PASSED' | 'ALREADY_TAKEN_FINAL' | 'ATTEMPT_EXISTS' | 'WEEKLY_LIMIT'
  | 'BANK_NOT_READY' | 'ENTRY_SCORE_MISSING' | 'RESIT_NOT_ELIGIBLE' | 'RESIT_NOT_PAID' | 'RESIT_WRONG_CYCLE' | 'RETAKE_REQUIRED';

/** Статусы, начиная с которых предмет находится в ветке 25% resit */
export const RESIT_BRANCH = ['RESIT_ELIGIBLE', 'RESIT_PAYMENT_PENDING', 'RESIT_PAID', 'RESIT_FORFEITED'] as const;

export interface EligibilityResult {
  eligible: boolean;
  reasons: EligibilityReason[];
  /** причины, не связанные с временем/днём недели («можно прийти в другой день») */
  blocking: EligibilityReason[];
  examId: string;
  kind: 'FINAL' | 'RESIT';
  enrollmentId: string | null;
  entryScore: number | null;
  resitId: string | null;
}

const TIME_REASONS: EligibilityReason[] = ['OUTSIDE_ALLOWED_TIME', 'WEEKDAY_NOT_ALLOWED', 'WINDOW_NOT_STARTED'];

/**
 * EligibilityService — единственная точка решения «может ли студент сдавать этот экзамен сейчас».
 * Вызывается при показе экзаменов студенту, при авторизации проктором и повторно при погашении токена.
 */
@Injectable()
export class EligibilityService {
  constructor(private readonly prisma: PrismaService, private readonly common: ExamCommon) {}

  /** Утверждённая версия банка с достаточным числом вопросов (или зафиксированная за экзаменом) */
  async readyBank(exam: { bankVersionId: string | null; subjectId: string; questionCount: number }, db: Tx | PrismaService = this.prisma) {
    let v = exam.bankVersionId
      ? await db.questionBankVersion.findUnique({ where: { id: exam.bankVersionId }, include: { _count: { select: { questions: true } } } })
      : await db.questionBankVersion.findFirst({ where: { status: 'APPROVED', bank: { subjectId: exam.subjectId } }, include: { _count: { select: { questions: true } } } });
    if (v && v.status !== 'APPROVED' && v.status !== 'SUPERSEDED') v = null; // зафиксированная версия может быть вытеснена новой — это допустимо
    return v && v._count.questions >= exam.questionCount ? v : null;
  }

  async evaluate(examId: string, studentId: string, now = new Date(), opts: { db?: Tx | PrismaService; ignoreAttempt?: string } = {}): Promise<EligibilityResult> {
    const db = opts.db ?? this.prisma;
    const exam = await db.exam.findUnique({ where: { id: examId }, include: { window: { include: { finalWindow: true } } } });
    if (!exam) throw new NotFoundException('Exam not found');
    const w = exam.window;
    const kind = w.kind;
    const reasons: EligibilityReason[] = [];
    const out = (extra: Partial<EligibilityResult> = {}): EligibilityResult => ({
      eligible: reasons.length === 0, reasons, blocking: reasons.filter((r) => !TIME_REASONS.includes(r)), examId, kind, enrollmentId: null, entryScore: null, resitId: null, ...extra,
    });

    const wr = checkWindow(w, now);
    if (wr) reasons.push(wr);

    if (!(await this.common.inScope(w.id, studentId, db))) { reasons.push('NOT_IN_SCOPE'); return out(); }

    // ── enrollment ──
    let enrollment: Awaited<ReturnType<typeof db.subjectEnrollment.findFirst>> = null;
    let resitId: string | null = null;
    if (kind === 'FINAL') {
      enrollment = await db.subjectEnrollment.findFirst({ where: { studentId, subjectId: exam.subjectId, academicYear: w.academicYear, term: w.term }, orderBy: { attemptNo: 'desc' } });
      if (!enrollment) reasons.push('NOT_ENROLLED');
      else if (enrollment.status === 'COMPLETED') reasons.push('ALREADY_PASSED');
      else if (enrollment.status !== 'ENROLLED') reasons.push(enrollment.status === 'RETAKE_REQUIRED' ? 'RETAKE_REQUIRED' : 'ALREADY_TAKEN_FINAL');
    } else {
      const f = w.finalWindow;
      if (!f) { reasons.push('RESIT_WRONG_CYCLE'); return out(); }
      // resit привязан к циклу: зимний предмет — только в зимнем resit-окне, весенний — в летнем (term финального окна совпадает)
      enrollment = await db.subjectEnrollment.findFirst({
        where: { studentId, subjectId: exam.subjectId, term: f.term, academicYear: { lte: f.academicYear }, status: { in: [...RESIT_BRANCH, 'COMPLETED', 'ENROLLED', 'RETAKE_REQUIRED', 'RETAKE_REGISTERED'] } },
        orderBy: [{ academicYear: 'desc' }, { attemptNo: 'desc' }],
      });
      if (!enrollment) reasons.push('NOT_ENROLLED');
      else if (enrollment.status === 'COMPLETED') reasons.push('ALREADY_PASSED');
      else if (enrollment.status === 'RETAKE_REQUIRED' || enrollment.status === 'RETAKE_REGISTERED') reasons.push('RETAKE_REQUIRED');
      else if (enrollment.status === 'ENROLLED') reasons.push('RESIT_NOT_ELIGIBLE');
      else {
        const r = await db.resitEligibility.findUnique({ where: { enrollmentId_cycleKey: { enrollmentId: enrollment.id, cycleKey: cycleKey(f.academicYear, f.term) } } });
        if (!r) reasons.push('RESIT_NOT_ELIGIBLE');
        else if (r.status !== 'PAID') reasons.push(r.status === 'USED' ? 'ATTEMPT_EXISTS' : 'RESIT_NOT_PAID');
        else resitId = r.id;
      }
    }

    // ── попытка уже есть (VOID не считается) ──
    const existing = await db.examAttempt.findFirst({ where: { examId, studentId, status: { not: 'VOID' }, ...(opts.ignoreAttempt ? { id: { not: opts.ignoreAttempt } } : {}) }, select: { id: true } });
    if (existing || (await db.paperAnswerSheet.findFirst({ where: { examId, studentId, status: { in: ['SCANNED', 'MANUAL_REVIEW_REQUIRED', 'VERIFIED', 'SCORED'] } }, select: { id: true } }))) reasons.push('ATTEMPT_EXISTS');

    // ── максимум N финальных экзаменов в неделю (в рамках финального окна) ──
    if (kind === 'FINAL') {
      const { from, to } = weekRange(now);
      const [att, sheets] = await Promise.all([
        db.examAttempt.count({ where: { studentId, kind: 'FINAL', status: { not: 'VOID' }, createdAt: { gte: from, lt: to }, exam: { windowId: w.id }, ...(opts.ignoreAttempt ? { id: { not: opts.ignoreAttempt } } : {}) } }),
        db.paperAnswerSheet.count({ where: { studentId, createdAt: { gte: from, lt: to }, exam: { windowId: w.id } } }),
      ]);
      if (att + sheets >= w.maxPerWeek) reasons.push('WEEKLY_LIMIT');
    }

    if (!(await this.readyBank(exam, db))) reasons.push('BANK_NOT_READY');

    let entry: number | null = null;
    if (enrollment && !reasons.some((r) => ['NOT_ENROLLED', 'ALREADY_PASSED', 'RETAKE_REQUIRED'].includes(r))) {
      entry = enrollment.entryScore != null ? Number(enrollment.entryScore) : await this.common.entryScore(studentId, exam.subjectId, enrollment.academicYear, enrollment.term, db);
      if (entry == null) reasons.push('ENTRY_SCORE_MISSING');
    }
    return out({ enrollmentId: enrollment?.id ?? null, entryScore: entry, resitId });
  }

  /** Сводка для интерфейса: допуск без учёта времени/дня (чтобы показывать «придите в другой день») */
  async preview(examId: string, studentId: string, now = new Date()) {
    return this.evaluate(examId, studentId, now);
  }
}



