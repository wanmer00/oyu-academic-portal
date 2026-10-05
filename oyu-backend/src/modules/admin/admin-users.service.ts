import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import { AuditCtx, AuditTrailService } from '../../common/audit/audit-trail.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AdminOverviewService } from './admin-overview.service';
import { CreateUserDto, UpdateUserDto } from './admin-people.dto';

export interface ActorRef {
  id: string;
  role: Role;
}

/** Администраторами управляет только SUPER_ADMIN */
const ADMIN_TIER: Role[] = [Role.ADMIN, Role.SUPER_ADMIN];
/** Роли без профиля студента/преподавателя — между ними можно менять роль */
const PROFILELESS: Role[] = [Role.ADMIN, Role.SUPER_ADMIN, Role.PROCTOR];

export const tempPassword = () => {
  // 14 символов: буквы/цифры без похожих (O/0, l/1), гарантированно есть буква и цифра
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const d = '23456789';
  const pick = (s: string) => s[crypto.randomInt(s.length)];
  const chars = [pick(a), pick(d), ...Array.from({ length: 12 }, () => pick(a + d))];
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
};

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditTrailService,
    private readonly overview: AdminOverviewService,
  ) {}

  // ───────────────────────── чтение ─────────────────────────
  list(q: Parameters<AdminOverviewService['listUsers']>[0], groups: string[] | null = null) {
    return this.overview.listUsers(q, groups);
  }

  /** Руководство с ограниченной областью работает только со студентами своих групп и их преподавателями (не с другими сотрудниками) */
  async assertInScope(groups: string[] | null, id: string) {
    if (!groups) return;
    const u = await this.prisma.user.findUnique({ where: { id }, select: { student: { select: { groupName: true } }, teacher: { select: { userId: true } } } });
    if (!u) throw new NotFoundException('User not found');
    const inScope = u.student ? groups.includes(u.student.groupName) : u.teacher ? (await this.prisma.scheduleSlot.count({ where: { teacherId: id, groupName: { in: groups } } })) > 0 : false;
    if (!inScope) throw new ForbiddenException({ message: 'Outside your area of responsibility', code: 'ORG_SCOPE_DENIED' });
  }

  get(id: string) {
    return this.overview.userProfile(id);
  }

  // ───────────────────────── вспомогательное ─────────────────────────
  hash(pw: string) {
    return argon2.hash(pw, { type: argon2.argon2id });
  }

  /** Свободный Login ID: префикс роли + случайные цифры */
  async freeLoginId(role: Role): Promise<string> {
    const prefix: Record<string, string> = { STUDENT: '01', TEACHER: '09', ADMIN: '01', SUPER_ADMIN: '00', PROCTOR: '05' };
    for (let i = 0; i < 20; i++) {
      const id = (prefix[role] ?? '01') + String(crypto.randomInt(0, 100_000_000)).padStart(8, '0');
      if (!(await this.prisma.user.findUnique({ where: { loginId: id }, select: { id: true } }))) return id;
    }
    throw new ConflictException('Could not allocate Login ID');
  }

  async assertUnique(loginId: string | undefined, email: string, exceptId?: string) {
    const clash = await this.prisma.user.findFirst({
      where: { id: exceptId ? { not: exceptId } : undefined, OR: [{ email }, ...(loginId ? [{ loginId }] : [])] },
      select: { loginId: true, email: true },
    });
    if (clash) throw new ConflictException({ message: clash.email === email ? 'Email already in use' : 'Login ID already in use', code: clash.email === email ? 'EMAIL_TAKEN' : 'LOGIN_ID_TAKEN' });
  }

  private async target(id: string) {
    const u = await this.prisma.user.findUnique({ where: { id }, select: { id: true, loginId: true, role: true, status: true, fullName: true, email: true, phone: true, preferredLang: true } });
    if (!u) throw new NotFoundException('User not found');
    return u;
  }

  /** Обычный ADMIN не трогает администраторов; никто не меняет себя по чувствительным операциям */
  private guard(actor: ActorRef, t: { id: string; role: Role }, opts: { self?: boolean } = {}) {
    if (opts.self !== false && actor.id === t.id) throw new ForbiddenException({ message: 'You cannot perform this action on your own account', code: 'SELF_ACTION' });
    if (ADMIN_TIER.includes(t.role) && actor.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException({ message: 'Only SUPER_ADMIN can manage administrators', code: 'ADMIN_TIER_ONLY' });
    }
  }

  private async assertNotLastSuperAdmin(t: { id: string; role: Role }) {
    if (t.role !== Role.SUPER_ADMIN) return;
    const others = await this.prisma.user.count({ where: { role: Role.SUPER_ADMIN, status: UserStatus.ACTIVE, id: { not: t.id } } });
    if (!others) throw new ForbiddenException({ message: 'The last active SUPER_ADMIN cannot be removed', code: 'LAST_SUPER_ADMIN' });
  }

  private revokeTokens(tx: Prisma.TransactionClient, userId: string) {
    return tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  // ───────────────────────── создание ─────────────────────────
  async create(actor: ActorRef, dto: CreateUserDto, ctx: AuditCtx) {
    if (ADMIN_TIER.includes(dto.role as Role) && actor.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException({ message: 'Only SUPER_ADMIN can create administrators', code: 'ADMIN_TIER_ONLY' });
    }
    await this.assertUnique(dto.loginId, dto.email);
    const loginId = dto.loginId ?? (await this.freeLoginId(dto.role as Role));
    const pw = dto.password ?? tempPassword();
    const user = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: { loginId, email: dto.email, fullName: dto.fullName, role: dto.role as Role, phone: dto.phone ?? null, preferredLang: dto.preferredLang ?? 'az', passwordHash: await this.hash(pw) },
        select: { id: true, loginId: true, email: true, fullName: true, role: true, status: true },
      });
      await this.audit.recordTx(tx, { actorId: actor.id, action: 'user.create', targetType: 'User', targetId: u.id, new: { loginId: u.loginId, email: u.email, role: u.role, fullName: u.fullName } }, ctx);
      return u;
    });
    return { user, temporaryPassword: dto.password ? undefined : pw };
  }

  // ───────────────────────── изменение профиля ─────────────────────────
  async update(actor: ActorRef, id: string, dto: UpdateUserDto, ctx: AuditCtx) {
    const t = await this.target(id);
    this.guard(actor, t, { self: false });
    if (dto.email && dto.email !== t.email) await this.assertUnique(undefined, dto.email, id);
    const old: Record<string, unknown> = {};
    const next: Record<string, unknown> = {};
    for (const k of ['fullName', 'email', 'phone', 'preferredLang'] as const) {
      if (dto[k] !== undefined && dto[k] !== (t as any)[k]) { old[k] = (t as any)[k]; next[k] = dto[k]; }
    }
    if (!Object.keys(next).length) return this.get(id);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: next as Prisma.UserUpdateInput });
      await this.audit.recordTx(tx, { actorId: actor.id, action: 'user.update', targetType: 'User', targetId: id, old, new: next, extra: { loginId: t.loginId } }, ctx);
    });
    return this.get(id);
  }

  // ───────────────────────── блокировка / восстановление ─────────────────────────
  async block(actor: ActorRef, id: string, reason: string, ctx: AuditCtx) {
    const t = await this.target(id);
    this.guard(actor, t);
    if (t.status === UserStatus.SUSPENDED) return { id, status: t.status };
    if (t.status !== UserStatus.ACTIVE) throw new BadRequestException({ message: 'Only active users can be blocked', code: 'BAD_STATE' });
    await this.assertNotLastSuperAdmin(t);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { status: UserStatus.SUSPENDED } });
      await this.revokeTokens(tx, id);
      await this.audit.recordTx(tx, { actorId: actor.id, action: 'user.block', targetType: 'User', targetId: id, old: t.status, new: UserStatus.SUSPENDED, extra: { reason, loginId: t.loginId } }, ctx);
    });
    return { id, status: UserStatus.SUSPENDED };
  }

  async unblock(actor: ActorRef, id: string, ctx: AuditCtx) {
    const t = await this.target(id);
    this.guard(actor, t, { self: false });
    if (t.status !== UserStatus.SUSPENDED) throw new BadRequestException({ message: 'User is not blocked', code: 'BAD_STATE' });
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { status: UserStatus.ACTIVE, failedLogins: 0, lockedUntil: null } });
      await this.audit.recordTx(tx, { actorId: actor.id, action: 'user.unblock', targetType: 'User', targetId: id, old: t.status, new: UserStatus.ACTIVE, extra: { loginId: t.loginId } }, ctx);
    });
    return { id, status: UserStatus.ACTIVE };
  }

  /** Мягкое удаление: данные (оценки, посещаемость, аудит) сохраняются, вход закрыт */
  async remove(actor: ActorRef, id: string, reason: string | undefined, ctx: AuditCtx) {
    const t = await this.target(id);
    this.guard(actor, t);
    if (t.status === UserStatus.DELETED) return { id, status: t.status };
    await this.assertNotLastSuperAdmin(t);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { status: UserStatus.DELETED, deletedAt: new Date() } });
      await this.revokeTokens(tx, id);
      await this.audit.recordTx(tx, { actorId: actor.id, action: 'user.delete', targetType: 'User', targetId: id, old: t.status, new: UserStatus.DELETED, extra: { reason: reason ?? null, loginId: t.loginId, role: t.role } }, ctx);
    });
    return { id, status: UserStatus.DELETED };
  }

  async restore(actor: ActorRef, id: string, ctx: AuditCtx) {
    const t = await this.target(id);
    this.guard(actor, t, { self: false });
    if (t.status !== UserStatus.DELETED && t.status !== UserStatus.ARCHIVED) throw new BadRequestException({ message: 'Only deleted or archived users can be restored', code: 'BAD_STATE' });
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { status: UserStatus.ACTIVE, deletedAt: null } });
      await this.audit.recordTx(tx, { actorId: actor.id, action: 'user.restore', targetType: 'User', targetId: id, old: t.status, new: UserStatus.ACTIVE, extra: { loginId: t.loginId } }, ctx);
    });
    return { id, status: UserStatus.ACTIVE };
  }

  async resetPassword(actor: ActorRef, id: string, password: string | undefined, ctx: AuditCtx) {
    const t = await this.target(id);
    this.guard(actor, t, { self: false });
    const pw = password ?? tempPassword();
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { passwordHash: await this.hash(pw), failedLogins: 0, lockedUntil: null } });
      await this.revokeTokens(tx, id);
      await this.audit.recordTx(tx, { actorId: actor.id, action: 'user.password_reset', targetType: 'User', targetId: id, extra: { loginId: t.loginId } }, ctx);
    });
    return { id, temporaryPassword: password ? undefined : pw };
  }

  // ───────────────────────── роли (roles.assign) ─────────────────────────
  async changeRole(actor: ActorRef, id: string, role: Role, reason: string, ctx: AuditCtx) {
    const t = await this.target(id);
    this.guard(actor, t);
    if (role === t.role) return { id, role };
    if (!PROFILELESS.includes(t.role) || !PROFILELESS.includes(role)) {
      throw new BadRequestException({ message: 'Roles STUDENT and TEACHER are tied to a profile and cannot be assigned here', code: 'ROLE_CHANGE_UNSUPPORTED' });
    }
    if (ADMIN_TIER.includes(role) && actor.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException({ message: 'Only SUPER_ADMIN can grant administrator roles', code: 'ADMIN_TIER_ONLY' });
    }
    if (t.role === Role.SUPER_ADMIN) await this.assertNotLastSuperAdmin(t);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { role } });
      await this.audit.recordTx(tx, { actorId: actor.id, action: 'user.role_change', targetType: 'User', targetId: id, old: t.role, new: role, extra: { reason, loginId: t.loginId } }, ctx);
    });
    return { id, role };
  }
}
