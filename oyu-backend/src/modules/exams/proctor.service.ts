import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { AuditCtx } from '../../common/audit/audit-trail.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AttemptService } from './attempt.service';
import { EligibilityService } from './eligibility.service';
import { Actor, ExamCommon } from './exam-common.service';
import { launchToken, newSecret, sha256 } from './exam.rules';
import { env } from '../../config/env';

export const WorkstationSchema = z.object({ roomId: z.string(), code: z.string().trim().min(1).max(20), allowedCidr: z.string().max(100).nullable().optional() });
export const BulkWorkstationSchema = z.object({ roomId: z.string(), prefix: z.string().trim().max(10).default('PC-'), count: z.number().int().min(1).max(100), allowedCidr: z.string().max(100).nullable().optional() });
export const AuthorizeSchema = z.object({ studentId: z.string(), examId: z.string(), workstationId: z.string(), idChecked: z.literal(true), passportChecked: z.literal(true) });
export const ReasonSchema = z.object({ reason: z.string().trim().min(3).max(300) });

/** Рабочее место онлайн, если опрашивало сервер за последние N секунд (киоск опрашивает раз в ~4 с) */
export const ONLINE_SECONDS = 45;

export function launchSecret() {
  return env.JWT_ACCESS_SECRET + ':exam-launch';
}

@Injectable()
export class ProctorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly common: ExamCommon,
    private readonly eligibility: EligibilityService,
    private readonly attempts: AttemptService,
  ) {}

  // ───────────────────────── Management: рабочие места и проктора ─────────────────────────
  async workstations(roomId?: string) {
    const rows = await this.prisma.examWorkstation.findMany({ where: roomId ? { roomId } : {}, orderBy: [{ room: { code: 'asc' } }, { code: 'asc' }], include: { room: { select: { id: true, code: true, name: true, building: true } } } });
    const state = await this.states(rows.map((r) => r.id));
    return rows.map((w) => ({ id: w.id, code: w.code, room: w.room, isActive: w.isActive, hasKey: !!w.keyHash, allowedCidr: w.allowedCidr, lastSeenAt: w.lastSeenAt, lastSeenIp: w.lastSeenIp, ...state.get(w.id)!, online: this.online(w.lastSeenAt) }));
  }

  /** В демо-режиме все зарегистрированные ПК считаются подключёнными к сети (без открытой страницы киоска) */
  private online(seen: Date | null) { return env.DEMO_MODE || (!!seen && Date.now() - seen.getTime() < ONLINE_SECONDS * 1000); }

  async createWorkstation(actor: Actor, dto: z.infer<typeof WorkstationSchema>, ctx: AuditCtx) {
    if (!(await this.prisma.room.findUnique({ where: { id: dto.roomId }, select: { id: true } }))) throw new NotFoundException('Room not found');
    try {
      const w = await this.prisma.examWorkstation.create({ data: { roomId: dto.roomId, code: dto.code, allowedCidr: dto.allowedCidr ?? null } });
      await this.common.log(null, actor, 'workstation_created', 'ExamWorkstation', w.id, { code: w.code, roomId: w.roomId }, ctx);
      return w;
    } catch { throw new ConflictException({ message: 'Workstation code already exists in this room', code: 'WORKSTATION_EXISTS' }); }
  }

  async createBulk(actor: Actor, dto: z.infer<typeof BulkWorkstationSchema>, ctx: AuditCtx) {
    if (!(await this.prisma.room.findUnique({ where: { id: dto.roomId }, select: { id: true } }))) throw new NotFoundException('Room not found');
    const data = Array.from({ length: dto.count }, (_, i) => ({ roomId: dto.roomId, code: `${dto.prefix}${String(i + 1).padStart(2, '0')}`, allowedCidr: dto.allowedCidr ?? null }));
    const r = await this.prisma.examWorkstation.createMany({ data, skipDuplicates: true });
    await this.common.log(null, actor, 'workstation_created', 'Room', dto.roomId, { bulk: r.count }, ctx);
    return { created: r.count };
  }

  async setActive(actor: Actor, id: string, isActive: boolean, ctx: AuditCtx) {
    const w = await this.prisma.examWorkstation.findUnique({ where: { id } });
    if (!w) throw new NotFoundException('Workstation not found');
    await this.prisma.examWorkstation.update({ where: { id }, data: { isActive } });
    await this.common.log(null, actor, isActive ? 'workstation_enabled' : 'workstation_disabled', 'ExamWorkstation', id, { code: w.code }, ctx);
    return { ok: true };
  }

  /** Новый ключ устройства. Показывается один раз; в БД хранится только sha256 — старый ключ сразу перестаёт работать */
  async rotateKey(actor: Actor, id: string, ctx: AuditCtx) {
    const w = await this.prisma.examWorkstation.findUnique({ where: { id } });
    if (!w) throw new NotFoundException('Workstation not found');
    const key = `wk_${newSecret(32)}`;
    await this.prisma.examWorkstation.update({ where: { id }, data: { keyHash: sha256(key), keyIssuedAt: new Date() } });
    await this.common.log(null, actor, 'workstation_key_rotated', 'ExamWorkstation', id, { code: w.code }, ctx);
    return { key };
  }

  async proctors() {
    const users = await this.prisma.user.findMany({ where: { role: Role.PROCTOR, deletedAt: null }, select: { id: true, loginId: true, fullName: true, status: true, proctorRooms: { select: { room: { select: { id: true, code: true, name: true } } } } }, orderBy: { loginId: 'asc' } });
    return users.map((u) => ({ id: u.id, loginId: u.loginId, fullName: u.fullName, status: u.status, rooms: u.proctorRooms.map((p) => p.room) }));
  }

  async setProctorRooms(actor: Actor, proctorId: string, roomIds: string[], ctx: AuditCtx) {
    const u = await this.prisma.user.findFirst({ where: { id: proctorId, role: Role.PROCTOR } });
    if (!u) throw new NotFoundException('Proctor not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.proctorAssignment.deleteMany({ where: { proctorId } });
      await tx.proctorAssignment.createMany({ data: [...new Set(roomIds)].map((roomId) => ({ proctorId, roomId })) });
      await this.common.log(tx, actor, 'proctor_assigned', 'User', proctorId, { rooms: roomIds }, ctx);
    });
    return { ok: true };
  }

  // ───────────────────────── состояние рабочих мест ─────────────────────────
  /** Статус каждого ПК выводится из попыток: IN_EXAM / WAITING (ожидает студента) / AVAILABLE; без правильных ответов и вопросов */
  private async states(ids: string[]) {
    const now = new Date();
    const live = await this.prisma.examAttempt.findMany({
      where: { workstationId: { in: ids }, OR: [{ status: 'IN_PROGRESS' }, { status: 'AUTHORIZED', authorization: { usedAt: null, revokedAt: null, expiresAt: { gt: now } } }] },
      include: { student: { select: { groupName: true, user: { select: { fullName: true, loginId: true } } } }, exam: { select: { subject: { select: { name: true } }, window: { select: { kind: true } } } }, authorization: { select: { expiresAt: true, id: true } } },
    });
    const by = new Map(live.map((a) => [a.workstationId, a]));
    return new Map(ids.map((id) => {
      const a = by.get(id);
      return [id, {
        state: !a ? 'AVAILABLE' : a.status === 'IN_PROGRESS' ? 'IN_EXAM' : 'WAITING',
        attempt: a ? { id: a.id, status: a.status, kind: a.kind, startedAt: a.startedAt, expiresAt: a.status === 'IN_PROGRESS' ? a.expiresAt : a.authorization.expiresAt, authorizationId: a.authorization.id, subject: a.exam.subject.name, student: { id: a.studentId, fullName: a.student.user.fullName, loginId: a.student.user.loginId, groupName: a.student.groupName } } : null,
      }] as const;
    }));
  }

  // ───────────────────────── Proctor ─────────────────────────
  private async roomIds(user: { id: string; role: string }): Promise<string[] | null> {
    if (user.role !== 'PROCTOR') return null; // ADMIN / SUPER_ADMIN: все аудитории
    return (await this.prisma.proctorAssignment.findMany({ where: { proctorId: user.id }, select: { roomId: true } })).map((r) => r.roomId);
  }

  async myRooms(user: { id: string; role: string }) {
    const ids = await this.roomIds(user);
    const rooms = await this.prisma.room.findMany({ where: { ...(ids ? { id: { in: ids } } : { workstations: { some: {} } }) }, select: { id: true, code: true, name: true, building: true, _count: { select: { workstations: true } } }, orderBy: { code: 'asc' } });
    return rooms.map((r) => ({ id: r.id, code: r.code, name: r.name, building: r.building, workstations: r._count.workstations }));
  }

  private async assertRoom(user: { id: string; role: string }, roomId: string) {
    const ids = await this.roomIds(user);
    if (ids && !ids.includes(roomId)) throw new ForbiddenException({ message: 'This room is not assigned to you', code: 'ROOM_NOT_ASSIGNED' });
  }

  async roomStatus(user: { id: string; role: string }, roomId: string) {
    await this.assertRoom(user, roomId);
    return (await this.workstations(roomId)).map((w) => ({ id: w.id, code: w.code, isActive: w.isActive, online: w.online, state: !w.isActive ? 'DISABLED' : !w.online && w.state === 'AVAILABLE' ? 'OFFLINE' : w.state, attempt: w.attempt }));
  }

  async findStudents(q: string) {
    const s = q.trim();
    if (s.length < 2) return [];
    const rows = await this.prisma.student.findMany({
      where: { user: { status: 'ACTIVE', OR: [{ loginId: { contains: s, mode: 'insensitive' } }, { fullName: { contains: s, mode: 'insensitive' } }] } },
      select: { userId: true, groupName: true, course: true, specialty: true, faculty: true, user: { select: { fullName: true, loginId: true } } }, take: 15, orderBy: { user: { loginId: 'asc' } },
    });
    return rows.map((r) => ({ id: r.userId, fullName: r.user.fullName, loginId: r.user.loginId, groupName: r.groupName, course: r.course, specialty: r.specialty, faculty: r.faculty }));
  }

  /** Экзамены студента, по которым есть окно сегодня, с результатом проверки допуска (причины — коды) */
  async studentExams(studentId: string) {
    const st = await this.prisma.student.findUnique({ where: { userId: studentId }, include: { user: { select: { fullName: true, loginId: true } } } });
    if (!st) throw new NotFoundException('Student not found');
    const enr = await this.prisma.subjectEnrollment.findMany({ where: { studentId, source: { not: 'DEMO' }, status: { in: ['ENROLLED', 'RESIT_PAID'] } }, select: { subjectId: true } });
    const exams = await this.prisma.exam.findMany({
      where: { subjectId: { in: enr.map((e) => e.subjectId) }, window: { status: 'PUBLISHED', title: { not: { startsWith: 'DEMO' } } }, delivery: 'COMPUTER' },
      include: { subject: { select: { name: true, code: true } }, window: { select: { title: true, kind: true, startTime: true, endTime: true } } },
    });
    const out = [];
    for (const e of exams) {
      const r = await this.eligibility.evaluate(e.id, studentId);
      if (r.reasons.includes('NOT_IN_SCOPE') || r.reasons.includes('NOT_ENROLLED') || r.reasons.includes('RESIT_NOT_ELIGIBLE')) continue;
      out.push({ examId: e.id, subject: e.subject, kind: e.window.kind, window: e.window.title, time: `${e.window.startTime}–${e.window.endTime}`, eligible: r.eligible, reasons: r.reasons });
    }
    return { student: { id: st.userId, fullName: st.user.fullName, loginId: st.user.loginId, groupName: st.groupName, course: st.course, specialty: st.specialty }, exams: out };
  }

  /**
   * Авторизация старта: проктор подтвердил личность (студенческий + паспорт), выбрал предмет и ПК.
   * Все проверки повторяются под блокировкой студента; создаётся одноразовое разрешение + попытка AUTHORIZED.
   */
  async authorize(user: { id: string; role: string }, dto: z.infer<typeof AuthorizeSchema>, ip: string | undefined, ctx: AuditCtx) {
    const ws = await this.prisma.examWorkstation.findUnique({ where: { id: dto.workstationId } });
    if (!ws) throw new NotFoundException('Workstation not found');
    await this.assertRoom(user, ws.roomId);
    const exam = await this.prisma.exam.findUnique({ where: { id: dto.examId } });
    if (!exam) throw new NotFoundException('Exam not found');
    const fail = async (code: string, extra: Record<string, unknown> = {}) => {
      await this.common.log(null, user, 'authorization_denied', 'Exam', dto.examId, { studentId: dto.studentId, workstationId: dto.workstationId, code, ...extra }, ctx, 'DENIED');
      throw new ConflictException({ message: 'Authorization denied', code, ...extra });
    };
    if (exam.delivery !== 'COMPUTER') return fail('NOT_COMPUTER_EXAM');
    await this.attempts.voidExpiredAuthorizations(); // просроченные неиспользованные разрешения не блокируют повторную авторизацию
    if (!ws.isActive || !ws.keyHash) return fail('WORKSTATION_UNAVAILABLE');
    if (!this.online(ws.lastSeenAt)) return fail('WORKSTATION_OFFLINE');
    const ttl = this.common.cfg.tokenTtl();

    const result = await this.prisma.$transaction(async (tx) => {
      await this.common.lockStudent(tx, dto.studentId);
      const busy = await tx.examAttempt.findFirst({ where: { workstationId: ws.id, OR: [{ status: 'IN_PROGRESS' }, { status: 'AUTHORIZED', authorization: { usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } }] }, select: { id: true } });
      if (busy) return { denied: 'WORKSTATION_BUSY' as const };
      const now = new Date();
      const el = await this.eligibility.evaluate(dto.examId, dto.studentId, now, { db: tx });
      await tx.examEligibilityCheck.create({ data: { examId: dto.examId, studentId: dto.studentId, eligible: el.eligible, reasons: el.reasons, checkedBy: user.id } });
      await this.common.log(tx, user, 'eligibility_calculated', 'Exam', dto.examId, { studentId: dto.studentId, eligible: el.eligible, reasons: el.reasons }, ctx);
      if (!el.eligible || !el.enrollmentId) return { denied: 'NOT_ELIGIBLE' as const, reasons: el.reasons };
      // зафиксировать версию банка за экзаменом (одна для всех студентов) и Entry Score за предметом
      const bank = await this.eligibility.readyBank(exam, tx);
      if (!bank) return { denied: 'BANK_NOT_READY' as const, reasons: ['BANK_NOT_READY'] };
      if (!exam.bankVersionId) await tx.exam.updateMany({ where: { id: exam.id, bankVersionId: null }, data: { bankVersionId: bank.id } });
      const pinned = (await tx.exam.findUniqueOrThrow({ where: { id: exam.id }, select: { bankVersionId: true } })).bankVersionId!;
      if (el.entryScore != null) await tx.subjectEnrollment.updateMany({ where: { id: el.enrollmentId, entryScore: null }, data: { entryScore: el.entryScore } });
      const window = await tx.examWindow.findUniqueOrThrow({ where: { id: exam.windowId }, select: { version: true } });
      const expiresAt = new Date(now.getTime() + ttl * 1000);
      const auth = await tx.proctorAuthorization.create({
        data: { examId: exam.id, studentId: dto.studentId, proctorId: user.id, workstationId: ws.id, tokenHash: sha256(newSecret(16)), idChecked: dto.idChecked, passportChecked: dto.passportChecked, expiresAt, ip: ip ?? null },
      });
      // токен детерминирован (HMAC от всех привязок) → tokenHash фиксируется после получения id
      const token = launchToken(launchSecret(), { id: auth.id, workstationId: ws.id, studentId: dto.studentId, examId: exam.id, expiresAt });
      await tx.proctorAuthorization.update({ where: { id: auth.id }, data: { tokenHash: sha256(token) } });
      const attempt = await tx.examAttempt.create({
        data: { examId: exam.id, studentId: dto.studentId, enrollmentId: el.enrollmentId, kind: el.kind, authorizationId: auth.id, workstationId: ws.id, bankVersionId: pinned, rulesVersion: exam.rulesVersion, windowVersion: window.version },
      });
      await this.common.log(tx, user, 'student_authorized', 'ExamAttempt', attempt.id, { examId: exam.id, studentId: dto.studentId, idChecked: true, passportChecked: true }, ctx);
      await this.common.log(tx, user, 'workstation_assigned', 'ExamWorkstation', ws.id, { attemptId: attempt.id, code: ws.code }, ctx);
      return { attemptId: attempt.id, authorizationId: auth.id, expiresAt };
    }).catch(async (e) => {
      if (e?.code === 'P2002') return { denied: 'ATTEMPT_EXISTS' as const };
      throw e;
    });
    if ('denied' in result) return fail(String(result.denied), { reasons: (result as { reasons?: string[] }).reasons });
    return { ok: true, ...result, workstation: ws.code };
  }

  async revoke(user: { id: string; role: string }, authorizationId: string, reason: string, ctx: AuditCtx) {
    const a = await this.prisma.proctorAuthorization.findUnique({ where: { id: authorizationId }, include: { workstation: true, attempt: true } });
    if (!a) throw new NotFoundException('Authorization not found');
    await this.assertRoom(user, a.workstation.roomId);
    await this.prisma.$transaction(async (tx) => {
      const u = await tx.proctorAuthorization.updateMany({ where: { id: authorizationId, usedAt: null, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: reason } });
      if (u.count !== 1) throw new ConflictException({ message: 'Authorization is already used or revoked', code: 'AUTHORIZATION_STATE' });
      await tx.examAttempt.updateMany({ where: { authorizationId, status: 'AUTHORIZED' }, data: { status: 'VOID' } });
      await this.common.log(tx, user, 'authorization_revoked', 'ProctorAuthorization', authorizationId, { reason }, ctx);
    });
    return { ok: true };
  }

  /** Экстренное завершение: сохранённые ответы оцениваются, ПК освобождается */
  async terminate(user: { id: string; role: string }, attemptId: string, reason: string, ctx: AuditCtx) {
    const a = await this.prisma.examAttempt.findUnique({ where: { id: attemptId }, include: { workstation: true } });
    if (!a) throw new NotFoundException('Attempt not found');
    await this.assertRoom(user, a.workstation.roomId);
    if (a.status !== 'IN_PROGRESS') throw new BadRequestException({ message: 'Attempt is not in progress', code: 'ATTEMPT_STATE' });
    await this.attempts.finalize(attemptId, 'PROCTOR', user, ctx, { reason });
    return { ok: true };
  }
}
