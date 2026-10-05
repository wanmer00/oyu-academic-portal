import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { AuditCtx } from '../../../common/audit/audit-trail.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AttemptService } from '../attempt.service';
import { EligibilityService } from '../eligibility.service';
import { Actor, ExamCommon } from '../exam-common.service';
import { scoreExam, shuffle } from '../exam.rules';
import { OmrQuestion, readSheet } from './omr';
import { sheetSvg } from './omr.layout';

const TIME_REASONS = ['OUTSIDE_ALLOWED_TIME', 'WEEKDAY_NOT_ALLOWED', 'WINDOW_NOT_STARTED'];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
/** Простая безопасная разметка: **жирный**, *курсив*, `код`, x^{2}, x_{i}; всё остальное экранируется */
export function rich(s: string): string {
  return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/\^\{([^}]+)\}/g, '<sup>$1</sup>').replace(/_\{([^}]+)\}/g, '<sub>$1</sub>').replace(/\n/g, '<br>');
}

@Injectable()
export class PaperService {
  constructor(private readonly prisma: PrismaService, private readonly common: ExamCommon, private readonly eligibility: EligibilityService, private readonly attempts: AttemptService) {}

  private async paperExam(examId: string) {
    const e = await this.prisma.exam.findUnique({ where: { id: examId }, include: { subject: { select: { name: true } }, window: true } });
    if (!e) throw new NotFoundException('Exam not found');
    if (e.delivery !== 'PAPER') throw new BadRequestException({ message: 'This is not a paper exam', code: 'NOT_PAPER_EXAM' });
    return e;
  }

  /** Индивидуальные бланки: каждому допущенному студенту — свой случайный набор вопросов и порядок вариантов (как в компьютерном экзамене) */
  async generate(actor: Actor, examId: string, studentIds: string[] | undefined, ctx: AuditCtx) {
    const e = await this.paperExam(examId);
    if (e.window.status !== 'PUBLISHED') throw new ConflictException({ message: 'Window is not published', code: 'WINDOW_NOT_PUBLISHED' });
    const ready = await this.eligibility.readyBank(e);
    if (!ready) throw new ConflictException({ message: 'Question bank is not ready', code: 'BANK_NOT_READY' });
    if (!e.bankVersionId) await this.prisma.exam.updateMany({ where: { id: e.id, bankVersionId: null }, data: { bankVersionId: ready.id } });
    const versionId = (await this.prisma.exam.findUniqueOrThrow({ where: { id: e.id }, select: { bankVersionId: true } })).bankVersionId!;
    const questions = await this.prisma.question.findMany({ where: { versionId }, select: { id: true, options: { select: { id: true } } } });
    const candidates = studentIds ?? (await this.prisma.subjectEnrollment.findMany({ where: { subjectId: e.subjectId, academicYear: e.window.academicYear, term: e.window.term, status: { in: ['ENROLLED', 'RESIT_PAID'] } }, select: { studentId: true } })).map((x) => x.studentId);
    const created: string[] = [], skipped: Array<{ studentId: string; reasons: string[] }> = [];
    for (const studentId of candidates) {
      const el = await this.eligibility.evaluate(examId, studentId);
      const blocking = el.reasons.filter((r) => !TIME_REASONS.includes(r));
      if (blocking.length || !el.enrollmentId) { skipped.push({ studentId, reasons: blocking }); continue; }
      try {
        await this.prisma.$transaction(async (tx) => {
          await this.common.lockStudent(tx, studentId);
          if (await tx.paperAnswerSheet.findUnique({ where: { examId_studentId: { examId, studentId } } })) throw new Error('EXISTS');
          if (el.entryScore != null) await tx.subjectEnrollment.updateMany({ where: { id: el.enrollmentId!, entryScore: null }, data: { entryScore: el.entryScore } });
          const picked = shuffle(questions).slice(0, e.questionCount);
          const sheet = await tx.paperAnswerSheet.create({
            data: {
              examId, studentId, enrollmentId: el.enrollmentId!, sheetCode: `OYU-${randomBytes(4).toString('hex').toUpperCase()}`, bankVersionId: versionId, createdBy: actor.id,
              questions: { create: picked.map((q, i) => ({ questionId: q.id, position: i + 1, optionOrder: shuffle(q.options.map((o) => o.id)) })) },
            },
          });
          await this.common.log(tx, actor, 'paper_sheet_generated', 'PaperAnswerSheet', sheet.id, { examId, studentId, sheetCode: sheet.sheetCode }, ctx);
          created.push(sheet.id);
        });
      } catch (err) {
        if ((err as Error).message === 'EXISTS') skipped.push({ studentId, reasons: ['SHEET_EXISTS'] }); else throw err;
      }
    }
    return { created: created.length, skipped };
  }

  async sheets(examId: string) {
    const rows = await this.prisma.paperAnswerSheet.findMany({
      where: { examId }, orderBy: { student: { user: { fullName: 'asc' } } },
      include: { student: { select: { groupName: true, user: { select: { fullName: true, loginId: true } } } }, result: { select: { id: true, total: true, passed: true, publishedAt: true } }, _count: { select: { scans: true } } },
    });
    return rows.map((s) => ({ id: s.id, sheetCode: s.sheetCode, status: s.status, scans: s._count.scans, student: { fullName: s.student.user.fullName, loginId: s.student.user.loginId, groupName: s.student.groupName }, result: s.result ? { id: s.result.id, total: Number(s.result.total), passed: s.result.passed, published: !!s.result.publishedAt } : null }));
  }

  async review() {
    const rows = await this.prisma.paperAnswerSheet.findMany({
      where: { status: 'MANUAL_REVIEW_REQUIRED' }, orderBy: { updatedAt: 'asc' }, take: 200,
      include: { exam: { select: { subject: { select: { name: true } } } }, student: { select: { groupName: true, user: { select: { fullName: true, loginId: true } } } }, questions: { select: { flags: true, reviewed: true } } },
    });
    return rows.map((s) => ({ id: s.id, sheetCode: s.sheetCode, subject: s.exam.subject.name, student: { fullName: s.student.user.fullName, loginId: s.student.user.loginId, groupName: s.student.groupName }, flagged: s.questions.filter((q) => q.flags.some((f) => f !== 'EMPTY') || q.flags.includes('NO_SCAN' as never)).length, pending: s.questions.filter((q) => !q.reviewed && q.flags.some((f) => f === 'DOUBLE' || f === 'LOW_CONFIDENCE' || f === 'NO_SCAN')).length }));
  }

  // ───────────────────────── печать ─────────────────────────
  private async sheetData(sheetId: string) {
    const s = await this.prisma.paperAnswerSheet.findUnique({
      where: { id: sheetId },
      include: {
        exam: { include: { subject: { select: { name: true } }, window: { select: { kind: true, title: true } } } }, student: { select: { groupName: true, user: { select: { fullName: true, loginId: true } } } },
        questions: { orderBy: { position: 'asc' }, include: { question: { select: { body: true, options: { select: { id: true, body: true } } } } } },
      },
    });
    if (!s) throw new NotFoundException('Sheet not found');
    return s;
  }

  private html(parts: string[]): string {
    return `<!doctype html><html><head><meta charset="utf-8"><title>Exam papers</title><style>
      @page{size:A4;margin:14mm} body{font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#111} .page{page-break-after:always} .page:last-child{page-break-after:auto}
      h2{margin:0 0 4px;font-size:18px} .meta{color:#444;margin-bottom:12px} .q{margin:0 0 12px;break-inside:avoid} .q b.n{display:inline-block;min-width:26px} .o{margin:2px 0 2px 30px}
      .sheet svg{width:100%;height:auto;max-height:262mm} code{background:#eee;padding:0 3px}
      @media screen{body{background:#eee} .page{background:#fff;max-width:820px;margin:12px auto;padding:20px}}
    </style></head><body>${parts.join('')}<script>window.addEventListener('load',function(){setTimeout(function(){window.print()},300)})</script></body></html>`;
  }

  private sheetParts(s: Awaited<ReturnType<PaperService['sheetData']>>): string[] {
    const meta = `${esc(s.exam.subject.name)} · ${esc(s.student.user.fullName)} (${esc(s.student.user.loginId)}) · ${esc(s.sheetCode)}`;
    const booklet = `<div class="page"><h2>${esc(s.exam.window.title)}</h2><div class="meta">${meta}</div>` + s.questions.map((q) => {
      const byId = new Map(q.question.options.map((o) => [o.id, o.body]));
      return `<div class="q"><b class="n">${q.position}.</b>${rich(q.question.body)}` + q.optionOrder.map((id, i) => `<div class="o"><b>${'ABCDE'[i]})</b> ${rich(byId.get(id) ?? '')}</div>`).join('') + '</div>';
    }).join('') + '</div>';
    const sheet = `<div class="page sheet">${sheetSvg({ title: 'ANSWER SHEET', subject: s.exam.subject.name, studentName: s.student.user.fullName, studentId: s.student.user.loginId, groupName: s.student.groupName, examId: s.examId, sheetCode: s.sheetCode, kind: s.exam.window.kind })}</div>`;
    return [booklet, sheet];
  }

  async printSheet(sheetId: string) { return this.html(this.sheetParts(await this.sheetData(sheetId))); }
  async printExam(examId: string) {
    await this.paperExam(examId);
    const ids = await this.prisma.paperAnswerSheet.findMany({ where: { examId, status: 'GENERATED' }, select: { id: true }, orderBy: { student: { user: { fullName: 'asc' } } } });
    const parts: string[] = [];
    for (const { id } of ids) parts.push(...this.sheetParts(await this.sheetData(id)));
    return this.html(parts.length ? parts : ['<p>No sheets to print</p>']);
  }

  // ───────────────────────── скан и OMR ─────────────────────────
  async upload(actor: Actor, sheetId: string, mimeType: string, b64: string, ctx: AuditCtx) {
    if (!/^image\/(png|jpeg|webp|tiff)$/.test(mimeType)) throw new BadRequestException({ message: 'Unsupported image type', code: 'SCAN_FORMAT' });
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 1000 || buf.length > 12_000_000) throw new BadRequestException({ message: 'Bad scan size', code: 'SCAN_SIZE' });
    const sheet = await this.prisma.paperAnswerSheet.findUnique({ where: { id: sheetId }, include: { questions: { orderBy: { position: 'asc' } } } });
    if (!sheet) throw new NotFoundException('Sheet not found');
    if (sheet.status === 'SCORED') throw new ConflictException({ message: 'Sheet is already scored', code: 'SHEET_SCORED' });
    await this.common.log(null, actor, 'paper_scan_uploaded', 'PaperAnswerSheet', sheetId, { bytes: buf.length, mimeType }, ctx);
    const omr = await readSheet(buf);
    const needReview = !omr.ok || omr.questions.some((q) => q.flags.includes('DOUBLE') || q.flags.includes('LOW_CONFIDENCE')) || omr.questions.filter((q) => q.flags.includes('EMPTY')).length >= 22;
    await this.prisma.$transaction(async (tx) => {
      await tx.paperScan.create({ data: { sheetId, mimeType, data: buf, quality: omr.quality, note: omr.error ?? null, uploadedBy: actor.id } });
      for (const q of sheet.questions) {
        const r: OmrQuestion | undefined = omr.questions.find((x) => x.position === q.position);
        const single = r && r.filled.length === 1 ? r.filled[0] : null;
        await tx.paperSheetQuestion.update({
          where: { id: q.id },
          data: {
            detectedIndex: single, confidence: r?.confidence ?? 0, flags: omr.ok ? (r?.flags ?? []) : ['LOW_CONFIDENCE'], reviewed: false,
            // однозначный ответ принимается; пусто / двойной / сомнительный → SKIP до решения сотрудника
            finalOptionId: omr.ok && single != null && !r!.flags.includes('LOW_CONFIDENCE') ? q.optionOrder[single] : null,
            correctedBy: null, correctedAt: null,
          },
        });
      }
      await tx.paperAnswerSheet.update({ where: { id: sheetId }, data: { status: needReview ? 'MANUAL_REVIEW_REQUIRED' : 'VERIFIED' } });
      await this.common.log(tx, actor, 'omr_result_generated', 'PaperAnswerSheet', sheetId, { ok: omr.ok, error: omr.error ?? null, quality: omr.quality, needReview, flagged: omr.questions.filter((q) => q.flags.some((f) => f !== 'EMPTY')).length }, ctx);
    });
    if (!needReview) await this.confirm(actor, sheetId, ctx);
    return this.detail(sheetId);
  }

  async detail(sheetId: string) {
    const s = await this.sheetData(sheetId);
    const scans = await this.prisma.paperScan.findMany({ where: { sheetId }, select: { id: true, mimeType: true, quality: true, note: true, createdAt: true }, orderBy: { createdAt: 'desc' } });
    const letter = (q: (typeof s.questions)[number], id: string | null) => (id ? 'ABCDE'[q.optionOrder.indexOf(id)] ?? null : null);
    return {
      id: s.id, sheetCode: s.sheetCode, status: s.status, subject: s.exam.subject.name, student: { fullName: s.student.user.fullName, loginId: s.student.user.loginId, groupName: s.student.groupName }, scans,
      questions: s.questions.map((q) => ({ position: q.position, detected: q.detectedIndex == null ? null : 'ABCDE'[q.detectedIndex], confidence: q.confidence == null ? null : Number(q.confidence), flags: q.flags, reviewed: q.reviewed, final: letter(q, q.finalOptionId), correctedBy: q.correctedBy })),
    };
  }

  async scanImage(sheetId: string) {
    const scan = await this.prisma.paperScan.findFirst({ where: { sheetId }, orderBy: { createdAt: 'desc' } });
    if (!scan) throw new NotFoundException('No scan');
    return { mimeType: scan.mimeType, data: Buffer.from(scan.data) };
  }

  /** Ручная правка распознанного ответа. Каждое изменение — в Audit Log (было → стало, причина) */
  async correct(actor: Actor, sheetId: string, position: number, letter: string | null, reason: string, ctx: AuditCtx) {
    const sheet = await this.prisma.paperAnswerSheet.findUnique({ where: { id: sheetId } });
    if (!sheet) throw new NotFoundException('Sheet not found');
    if (!['MANUAL_REVIEW_REQUIRED', 'VERIFIED'].includes(sheet.status)) throw new ConflictException({ message: 'Sheet cannot be edited in this state', code: 'SHEET_STATE' });
    const q = await this.prisma.paperSheetQuestion.findUnique({ where: { sheetId_position: { sheetId, position } } });
    if (!q) throw new NotFoundException('Question not found');
    if (letter != null && !'ABCDE'.includes(letter)) throw new BadRequestException({ message: 'Letter must be A–E or null', code: 'LETTER_INVALID' });
    const before = q.finalOptionId ? 'ABCDE'[q.optionOrder.indexOf(q.finalOptionId)] : null;
    await this.prisma.$transaction(async (tx) => {
      await tx.paperSheetQuestion.update({ where: { id: q.id }, data: { finalOptionId: letter == null ? null : q.optionOrder['ABCDE'.indexOf(letter)], reviewed: true, correctedBy: actor.id, correctedAt: new Date() } });
      await this.common.log(tx, actor, 'answer_manually_corrected', 'PaperAnswerSheet', sheetId, { position, before, after: letter, detected: q.detectedIndex == null ? null : 'ABCDE'[q.detectedIndex], flags: q.flags, reason }, ctx);
    });
    return this.detail(sheetId);
  }

  /** Подтверждение бланка: все сомнительные вопросы проверены → оценивание тем же scoring engine */
  async confirm(actor: Actor, sheetId: string, ctx: AuditCtx) {
    const sheet = await this.prisma.paperAnswerSheet.findUnique({ where: { id: sheetId }, include: { questions: true, enrollment: true, exam: true } });
    if (!sheet) throw new NotFoundException('Sheet not found');
    if (sheet.status === 'SCORED') return this.detail(sheetId);
    if (!['MANUAL_REVIEW_REQUIRED', 'VERIFIED'].includes(sheet.status)) throw new ConflictException({ message: 'Upload a scan first', code: 'SHEET_STATE' });
    const pending = sheet.questions.filter((q) => !q.reviewed && q.flags.some((f) => f === 'DOUBLE' || f === 'LOW_CONFIDENCE' || f === 'NO_SCAN'));
    if (pending.length) throw new ConflictException({ message: 'Review all flagged questions first', code: 'REVIEW_PENDING', positions: pending.map((q) => q.position) });
    const opts = await this.prisma.questionOption.findMany({ where: { questionId: { in: sheet.questions.map((q) => q.questionId) }, isCorrect: true }, select: { id: true, questionId: true } });
    const correct = new Map(opts.map((o) => [o.questionId, o.id]));
    const answers = sheet.questions.map((q) => (q.finalOptionId == null ? 'SKIP' : q.finalOptionId === correct.get(q.questionId) ? 'CORRECT' : 'WRONG') as 'CORRECT' | 'WRONG' | 'SKIP');
    await this.prisma.$transaction(async (tx) => {
      const entry = sheet.enrollment.entryScore != null ? Number(sheet.enrollment.entryScore) : (await this.common.entryScore(sheet.studentId, sheet.exam.subjectId, sheet.enrollment.academicYear, sheet.enrollment.term, tx)) ?? 0;
      const score = scoreExam({ answers, entryScore: entry }, { passTotal: this.common.cfg.passTotal(), minExam: this.common.cfg.minExam() });
      const kind = (await tx.examWindow.findUniqueOrThrow({ where: { id: sheet.exam.windowId }, select: { kind: true } })).kind;
      const r = await tx.examResult.create({
        data: { sheetId, examId: sheet.examId, studentId: sheet.studentId, enrollmentId: sheet.enrollmentId, kind, source: 'PAPER', correct: score.correct, wrong: score.wrong, skipped: score.skipped, examScore: score.examScore, entryScore: score.entryScore, total: score.total, letter: score.letter, passed: score.passed, failReason: score.failReason, rulesVersion: sheet.exam.rulesVersion },
      });
      await tx.paperAnswerSheet.update({ where: { id: sheetId }, data: { status: 'SCORED' } });
      await this.attempts.applyOutcome(tx, sheet.enrollment, kind, score.passed, sheet.studentId);
      await this.common.log(tx, actor, 'result_generated', 'ExamResult', r.id, { sheetId, source: 'PAPER', examScore: score.examScore, total: score.total, passed: score.passed, failReason: score.failReason }, ctx);
      if (this.common.cfg.instantResult()) await this.attempts.publishTx(tx, [r.id], actor, ctx);
    });
    return this.detail(sheetId);
  }
}
