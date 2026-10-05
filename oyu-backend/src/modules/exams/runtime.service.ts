import { BadRequestException, CanActivate, ConflictException, ExecutionContext, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';
import { AuditCtx } from '../../common/audit/audit-trail.service';
import { env } from '../../config/env';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AttemptService } from './attempt.service';
import { EligibilityService } from './eligibility.service';
import { Actor, ExamCommon } from './exam-common.service';
import { checkWindow, ipInNetworks, launchToken, safeEqual, sha256, shuffle } from './exam.rules';
import { launchSecret } from './proctor.service';

export const StartSchema = z.object({ token: z.string().min(20).max(200) });
export const AnswerSchema = z.object({ optionId: z.string().nullable(), seq: z.number().int().min(1).max(1_000_000) });

/**
 * Рабочее место: заголовок X-Workstation-Key (ключ выдаётся Management и хранится на киоск-ПК), активный ПК и допустимая сеть.
 * Студент ключа не имеет, поэтому открыть экзамен дома или с другого устройства невозможно.
 */
@Injectable()
export class WorkstationGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const key = String(req.headers['x-workstation-key'] ?? '');
    if (!key) throw new UnauthorizedException({ message: 'Workstation key required', code: 'WORKSTATION_KEY_REQUIRED' });
    const ws = await this.prisma.examWorkstation.findUnique({ where: { keyHash: sha256(key) } });
    if (!ws || !ws.isActive) throw new ForbiddenException({ message: 'Unknown or disabled workstation', code: 'WORKSTATION_FORBIDDEN' });
    const nets = [...(env.EXAM_ALLOWED_NETWORKS ?? '').split(','), ...(ws.allowedCidr ?? '').split(',')].map((x) => x.trim()).filter(Boolean);
    if (nets.length && !ipInNetworks(req.ip, nets)) throw new ForbiddenException({ message: 'Network not allowed', code: 'NETWORK_NOT_ALLOWED' });
    await this.prisma.examWorkstation.update({ where: { id: ws.id }, data: { lastSeenAt: new Date(), lastSeenIp: req.ip ?? null } });
    req.workstation = ws;
    return true;
  }
}

@Injectable()
export class RuntimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly common: ExamCommon,
    private readonly eligibility: EligibilityService,
    private readonly attempts: AttemptService,
  ) {}

  /** Состояние рабочего места: ожидание студента / идёт экзамен / только что завершён / простой */
  async state(wsId: string, ctx: AuditCtx) {
    const now = new Date();
    const live = await this.prisma.examAttempt.findFirst({ where: { workstationId: wsId, status: 'IN_PROGRESS' } });
    if (live) {
      if (live.expiresAt && live.expiresAt <= now) await this.attempts.finalize(live.id, 'SYSTEM', null, ctx);
      else return { state: 'IN_PROGRESS' as const, attemptId: live.id };
    }
    const pending = await this.prisma.examAttempt.findFirst({
      where: { workstationId: wsId, status: 'AUTHORIZED', authorization: { usedAt: null, revokedAt: null, expiresAt: { gt: now } } },
      include: { authorization: true, student: { select: { groupName: true, user: { select: { fullName: true, loginId: true } } } }, exam: { select: { durationMin: true, questionCount: true, subject: { select: { name: true } }, window: { select: { kind: true } } } } },
    });
    if (pending) {
      const a = pending.authorization;
      return {
        state: 'WAITING' as const, attemptId: pending.id, expiresAt: a.expiresAt,
        launchToken: launchToken(launchSecret(), { id: a.id, workstationId: wsId, studentId: pending.studentId, examId: pending.examId, expiresAt: a.expiresAt }),
        student: { fullName: pending.student.user.fullName, loginId: pending.student.user.loginId, groupName: pending.student.groupName },
        exam: { subject: pending.exam.subject.name, kind: pending.exam.window.kind, durationMin: pending.exam.durationMin, questions: pending.exam.questionCount },
      };
    }
    const last = await this.prisma.examAttempt.findFirst({ where: { workstationId: wsId, status: { in: ['SUBMITTED', 'AUTO_SUBMITTED', 'TERMINATED'] }, submittedAt: { gt: new Date(now.getTime() - 120_000) } }, orderBy: { submittedAt: 'desc' }, select: { id: true } });
    if (last) return { state: 'FINISHED' as const, attemptId: last.id };
    return { state: 'IDLE' as const };
  }

  /** START EXAM: погашение одноразового токена, повторная проверка окна и допуска, создание неизменяемого снапшота */
  async start(wsId: string, token: string, ctx: AuditCtx) {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const attempt = await tx.examAttempt.findFirst({ where: { workstationId: wsId, status: 'AUTHORIZED' }, include: { authorization: true, exam: { include: { window: true } } }, orderBy: { createdAt: 'desc' } });
      if (!attempt) throw new ConflictException({ message: 'No authorization for this workstation', code: 'NO_AUTHORIZATION' });
      const a = attempt.authorization;
      const expected = launchToken(launchSecret(), { id: a.id, workstationId: wsId, studentId: attempt.studentId, examId: attempt.examId, expiresAt: a.expiresAt });
      if (!safeEqual(token, expected) || a.tokenHash !== sha256(token)) throw new ForbiddenException({ message: 'Invalid launch token', code: 'TOKEN_INVALID' });
      // одноразовость: атомарное погашение
      const used = await tx.proctorAuthorization.updateMany({ where: { id: a.id, usedAt: null, revokedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
      if (used.count !== 1) throw new ConflictException({ message: 'Authorization expired, used or revoked', code: 'TOKEN_USED_OR_EXPIRED' });
      // время погашения тоже должно попадать в окно (11:59 → 12:01 уже нельзя)
      const reason = checkWindow(attempt.exam.window, now);
      if (reason) throw new ConflictException({ message: 'Exam window does not allow starting now', code: reason });
      const el = await this.eligibility.evaluate(attempt.examId, attempt.studentId, now, { db: tx, ignoreAttempt: attempt.id });
      if (!el.eligible) throw new ConflictException({ message: 'Student is not eligible', code: 'NOT_ELIGIBLE', reasons: el.reasons });
      const versionId = attempt.bankVersionId ?? attempt.exam.bankVersionId;
      if (!versionId) throw new ConflictException({ message: 'Question bank is not ready', code: 'BANK_NOT_READY' });
      const questions = await tx.question.findMany({ where: { versionId }, select: { id: true, options: { select: { id: true } } } });
      if (questions.length < attempt.exam.questionCount) throw new ConflictException({ message: 'Not enough approved questions', code: 'BANK_NOT_READY' });
      // сервер выбирает N случайных вопросов, перемешивает порядок вопросов и вариантов
      const picked = shuffle(questions).slice(0, attempt.exam.questionCount);
      await tx.examAttemptQuestion.createMany({ data: picked.map((q, i) => ({ attemptId: attempt.id, questionId: q.id, position: i + 1, optionOrder: shuffle(q.options.map((o) => o.id)) })) });
      const expiresAt = new Date(now.getTime() + attempt.exam.durationMin * 60_000);
      await tx.examAttempt.update({ where: { id: attempt.id }, data: { status: 'IN_PROGRESS', startedAt: now, expiresAt } });
      await tx.examWorkstation.update({ where: { id: wsId }, data: { lastSeenAt: now } });
      await this.common.log(tx, { id: attempt.studentId, role: 'STUDENT' }, 'started', 'ExamAttempt', attempt.id, { examId: attempt.examId, workstationId: wsId, questions: picked.length, bankVersionId: versionId }, ctx);
      return { attemptId: attempt.id };
    });
  }

  /** Попытка рабочего места (только своя: привязка по ПК) */
  private async current(wsId: string) {
    const a = await this.prisma.examAttempt.findFirst({ where: { workstationId: wsId, status: 'IN_PROGRESS' } });
    if (!a) throw new NotFoundException({ message: 'No exam in progress on this workstation', code: 'NO_ACTIVE_ATTEMPT' });
    return a;
  }

  /** Состояние попытки для киоска: вопросы и варианты без признака правильности; refresh возвращает тот же набор */
  async attemptView(wsId: string, ctx: AuditCtx) {
    let a = await this.current(wsId);
    if (a.expiresAt && a.expiresAt <= new Date()) { await this.attempts.finalize(a.id, 'SYSTEM', null, ctx); throw new ConflictException({ message: 'Time is over', code: 'TIME_EXPIRED' }); }
    const full = await this.prisma.examAttempt.findUniqueOrThrow({
      where: { id: a.id },
      include: { exam: { select: { durationMin: true, questionCount: true, subject: { select: { name: true, code: true } }, window: { select: { kind: true, title: true } } } }, student: { select: { user: { select: { fullName: true } } } }, questions: { orderBy: { position: 'asc' }, include: { question: { select: { body: true, image: true, options: { select: { id: true, body: true } } } } } } },
    });
    a = full;
    return {
      attemptId: full.id, subject: full.exam.subject, kind: full.exam.window.kind, window: full.exam.window.title, student: full.student.user.fullName,
      startedAt: full.startedAt, expiresAt: full.expiresAt, serverNow: new Date(), durationMin: full.exam.durationMin,
      questions: full.questions.map((q) => {
        const byId = new Map(q.question.options.map((o) => [o.id, o.body]));
        return { position: q.position, body: q.question.body, image: q.question.image, selectedOptionId: q.selectedOptionId, seq: q.seq, options: q.optionOrder.map((id, i) => ({ id, label: 'ABCDE'[i], body: byId.get(id) ?? '' })) };
      }),
    };
  }

  /** Автосохранение одного ответа. optionId=null — SKIP. Старые (меньший seq) запросы игнорируются. */
  async saveAnswer(wsId: string, position: number, dto: z.infer<typeof AnswerSchema>, ctx: AuditCtx) {
    const a = await this.current(wsId);
    const now = new Date();
    if (a.expiresAt && a.expiresAt <= now) { await this.attempts.finalize(a.id, 'SYSTEM', null, ctx); throw new ConflictException({ message: 'Time is over', code: 'TIME_EXPIRED' }); }
    const q = await this.prisma.examAttemptQuestion.findUnique({ where: { attemptId_position: { attemptId: a.id, position } } });
    if (!q) throw new NotFoundException('Question not found');
    if (dto.optionId != null && !q.optionOrder.includes(dto.optionId)) throw new BadRequestException({ message: 'Option does not belong to this question', code: 'OPTION_INVALID' });
    const u = await this.prisma.examAttemptQuestion.updateMany({ where: { id: q.id, seq: { lt: dto.seq } }, data: { selectedOptionId: dto.optionId, answeredAt: now, seq: dto.seq } });
    if (u.count) await this.common.log(null, { id: a.studentId, role: 'STUDENT' }, 'answer_saved', 'ExamAttempt', a.id, { position, skip: dto.optionId == null }, ctx);
    return { ok: true, saved: u.count === 1, serverNow: now, expiresAt: a.expiresAt };
  }

  async submit(wsId: string, ctx: AuditCtx) {
    const a = await this.current(wsId);
    const r = await this.attempts.finalize(a.id, 'STUDENT', { id: a.studentId, role: 'STUDENT' }, ctx);
    return this.resultFor(wsId, r?.attemptId ?? a.id);
  }

  /** Результат для экрана киоска (если включён instantResult) */
  async resultFor(wsId: string, attemptId?: string) {
    const a = await this.prisma.examAttempt.findFirst({ where: { workstationId: wsId, ...(attemptId ? { id: attemptId } : {}), status: { in: ['SUBMITTED', 'AUTO_SUBMITTED', 'TERMINATED'] } }, orderBy: { submittedAt: 'desc' }, include: { result: true, exam: { select: { subject: { select: { name: true } } } } } });
    if (!a?.result) throw new NotFoundException('Result not found');
    if (!a.result.publishedAt) return { published: false, subject: a.exam.subject.name, status: a.status };
    const openAt = new Date(a.result.publishedAt.getTime() + this.common.cfg.appealDelayHours() * 3600_000);
    const appeal = { openAt, deadline: new Date(openAt.getTime() + this.common.cfg.appealWindowHours() * 3600_000) };
    return { published: true, subject: a.exam.subject.name, status: a.status, ...this.attempts.resultView(a.result), appeal };
  }

  /** Подтверждение для проктора/логов не требуется; метод оставлен для явного закрытия экрана результата */
  actor(a: { studentId: string }): Actor { return { id: a.studentId, role: 'STUDENT' }; }
}
