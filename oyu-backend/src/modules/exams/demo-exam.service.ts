import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditCtx } from '../../common/audit/audit-trail.service';
import { env } from '../../config/env';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AttemptService } from './attempt.service';
import { Actor, ExamCommon } from './exam-common.service';
import { launchToken, newSecret, sha256, shuffle } from './exam.rules';
import { launchSecret } from './proctor.service';

export const DEMO_TITLE = 'DEMO practice';

/**
 * ТОЛЬКО DEMO_MODE: тестовый экзамен «из дома» без наблюдателя. Студент одним кликом получает свободный демо-ПК
 * и случайные вопросы из любого утверждённого банка. Тест изолирован: отдельное окно, отдельный год и отдельная запись
 * зачисления (source=DEMO) — реальные экзамены, статусы предметов, оплаты и журнал не затрагиваются.
 */
@Injectable()
export class DemoExamService {
  constructor(private readonly prisma: PrismaService, private readonly common: ExamCommon, private readonly attempts: AttemptService) {}

  async start(user: Actor, ip: string | undefined, ctx: AuditCtx) {
    if (!env.DEMO_MODE) throw new NotFoundException();
    const st = await this.prisma.student.findUnique({ where: { userId: user.id }, select: { userId: true } });
    if (!st) throw new NotFoundException('Only students');
    await this.attempts.voidExpiredAuthorizations();

    // свободный демо-ПК с известным демо-ключом
    const all = await this.prisma.examWorkstation.findMany({ where: { isActive: true, keyHash: { not: null } }, include: { room: { select: { code: true } } }, orderBy: [{ room: { code: 'asc' } }, { code: 'asc' }] });
    const busy = new Set((await this.prisma.examAttempt.findMany({ where: { OR: [{ status: 'IN_PROGRESS' }, { status: 'AUTHORIZED', authorization: { usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } }] }, select: { workstationId: true } })).map((a) => a.workstationId));
    const ws = all.find((w) => !busy.has(w.id) && sha256(`wk_demo_${w.room.code}_${w.code}`) === w.keyHash);
    if (!ws) throw new ConflictException({ message: 'All demo computers are busy', code: 'WORKSTATION_BUSY' });

    // случайный утверждённый банк с достаточным числом вопросов
    const banks = await this.prisma.questionBankVersion.findMany({ where: { status: 'APPROVED' }, select: { id: true, bank: { select: { subjectId: true } }, _count: { select: { questions: true } } } });
    const ok = banks.filter((b) => b._count.questions >= 25);
    if (!ok.length) throw new ConflictException({ message: 'No approved question banks', code: 'BANK_NOT_READY' });
    const bank = shuffle(ok)[0]; // случайные вопросы из любого банка
    // предмет теста — один из собственных предметов студента (результат попадёт в его Academic Journal)
    const mine = await this.prisma.subjectEnrollment.findMany({ where: { studentId: user.id, source: { not: 'DEMO' }, status: 'ENROLLED' }, select: { subjectId: true, entryScore: true, academicYear: true, term: true } });
    const own = mine.length ? shuffle(mine)[0] : null;
    const subjectId = own?.subjectId ?? bank.bank.subjectId;
    const entry = own ? (own.entryScore != null ? Number(own.entryScore) : (await this.common.entryScore(user.id, own.subjectId, own.academicYear, own.term)) ?? 40) : 40;

    const n = await this.prisma.examWindow.count({ where: { title: { startsWith: DEMO_TITLE } } });
    const y = 2100 + n; // уникальный «учебный год» на каждый запуск — тесты не мешают друг другу и реальным циклам
    const year = `${y}-${y + 1}`;
    const ttl = this.common.cfg.tokenTtl();

    const out = await this.prisma.$transaction(async (tx) => {
      const window = await tx.examWindow.create({
        data: { title: `${DEMO_TITLE} #${n + 1}`, kind: 'FINAL', academicYear: year, term: 'FALL', startDate: new Date('2000-01-01'), endDate: new Date('2999-12-31'), allowedWeekdays: [1, 2, 3, 4, 5, 6, 7], startTime: '00:00', endTime: '23:59', maxPerWeek: 7, questionDeadline: new Date('2000-01-01'), status: 'PUBLISHED' },
      });
      const exam = await tx.exam.create({ data: { windowId: window.id, subjectId, delivery: 'COMPUTER', durationMin: this.common.cfg.duration(), bankVersionId: bank.id } });
      const en = await tx.subjectEnrollment.create({ data: { studentId: user.id, subjectId, academicYear: year, term: 'FALL', semester: 1, source: 'DEMO', status: 'ENROLLED', entryScore: entry } });
      const now = new Date(), expiresAt = new Date(now.getTime() + ttl * 1000);
      const auth = await tx.proctorAuthorization.create({ data: { examId: exam.id, studentId: user.id, proctorId: (await tx.user.findFirstOrThrow({ where: { role: { in: ['PROCTOR', 'SUPER_ADMIN'] } }, select: { id: true } })).id, workstationId: ws.id, tokenHash: sha256(newSecret(16)), idChecked: true, passportChecked: true, expiresAt, ip: ip ?? null } });
      await tx.proctorAuthorization.update({ where: { id: auth.id }, data: { tokenHash: sha256(launchToken(launchSecret(), { id: auth.id, workstationId: ws.id, studentId: user.id, examId: exam.id, expiresAt })) } });
      const attempt = await tx.examAttempt.create({ data: { examId: exam.id, studentId: user.id, enrollmentId: en.id, kind: 'FINAL', authorizationId: auth.id, workstationId: ws.id, bankVersionId: bank.id, rulesVersion: exam.rulesVersion, windowVersion: 1 } });
      await this.common.log(tx, user, 'demo_exam_started', 'ExamAttempt', attempt.id, { workstation: ws.code, bankVersionId: bank.id }, ctx);
      return { attemptId: attempt.id, subjectId };
    });
    const subject = await this.prisma.subject.findUnique({ where: { id: out.subjectId }, select: { name: true } });
    return { ok: true, key: `wk_demo_${ws.room.code}_${ws.code}`, workstation: `${ws.room.code} · ${ws.code}`, subject: subject?.name ?? '', attemptId: out.attemptId };
  }
}
