import { Injectable, OnModuleInit, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import { User } from '@prisma/client';
import { I18nContext } from 'nestjs-i18n';

import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { env } from '../../config/env';
import { LoginDto } from './dto';

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;
/**
 * Окно параллельной ротации: две вкладки почти одновременно шлют один и тот же refresh-cookie.
 * Вторая получает 401 (cookie уже обновлён первой — повтор пройдёт), но это НЕ считается кражей токена.
 */
export const REFRESH_REUSE_GRACE_MS = 10_000;

/** '15m' / '7d' → мс (единый парсер для срока refresh-токена в БД и maxAge cookie) */
export function parseDuration(s: string): number {
  const m = s.match(/^(\d+)(s|m|h|d)$/);
  if (!m) return 7 * 24 * 60 * 60 * 1000;
  const mult: Record<string, number> = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  return parseInt(m[1], 10) * mult[m[2]];
}

export interface AuthContext {
  ip?: string | null;
  userAgent?: string | null;
  i18n: I18nContext;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private dummyHash = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async onModuleInit() {
    // Pre-compute dummy hash to mitigate timing attacks when loginId not found.
    this.dummyHash = await argon2.hash('__dummy__', { type: argon2.argon2id });
  }

  // ─────────────────────────────────────────
  // LOGIN
  // ─────────────────────────────────────────
  async login(dto: LoginDto, ctx: AuthContext) {
    const user = await this.prisma.user.findUnique({
      where: { loginId: dto.loginId },
      include: { student: true, teacher: true },
    });

    if (!user) {
      // Keep constant-time: do a real argon2 verify against dummy hash.
      await argon2.verify(this.dummyHash, dto.password).catch(() => false);
      await this.logLogin(null, dto.loginId, false, 'not_found', ctx);
      throw new UnauthorizedException(ctx.i18n.t('auth.invalid_credentials'));
    }

    if (user.status !== 'ACTIVE') {
      await this.logLogin(user.id, dto.loginId, false, 'inactive', ctx);
      throw new UnauthorizedException(ctx.i18n.t('auth.account_inactive'));
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.logLogin(user.id, dto.loginId, false, 'locked', ctx);
      throw new UnauthorizedException(ctx.i18n.t('auth.account_locked'));
    }

    const valid = await argon2.verify(user.passwordHash, dto.password).catch(() => false);
    if (!valid) {
      await this.handleFailedLogin(user);
      await this.logLogin(user.id, dto.loginId, false, 'bad_password', ctx);
      throw new UnauthorizedException(ctx.i18n.t('auth.invalid_credentials'));
    }

    // Успех: сбрасываем счётчик, обновляем lastLoginAt
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    await this.logLogin(user.id, dto.loginId, true, null, ctx);

    return this.issueTokens(user, ctx);
  }

  // ─────────────────────────────────────────
  // REFRESH (с ротацией + детекцией reuse)
  // ─────────────────────────────────────────
  async refresh(token: string | undefined, ctx: AuthContext) {
    if (!token) {
      throw new UnauthorizedException(ctx.i18n.t('auth.no_refresh_token'));
    }
    const tokenHash = this.hashToken(token);

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: { include: { student: true, teacher: true } } },
    });

    if (!stored) {
      throw new UnauthorizedException(ctx.i18n.t('auth.invalid_refresh_token'));
    }

    if (stored.revokedAt && Date.now() - stored.revokedAt.getTime() < REFRESH_REUSE_GRACE_MS && (await this.hasNewerInFamily(stored.family, stored.revokedAt))) {
      // Гонка вкладок: токен только что ротирован легитимно — не отзываем всю семью
      throw new UnauthorizedException(ctx.i18n.t('auth.invalid_refresh_token'));
    }

    if (stored.revokedAt) {
      // Reuse detected — revoke entire token family
      await this.prisma.refreshToken.updateMany({
        where: { family: stored.family, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.logger.warn(
        `Refresh token REUSE detected — user=${stored.userId}, family=${stored.family}`,
      );
      await this.prisma.auditLog.create({
        data: {
          actorId: stored.userId,
          action: 'auth.refresh_reuse_detected',
          targetType: 'RefreshToken',
          targetId: stored.id,
          ip: ctx.ip ?? null,
          userAgent: ctx.userAgent ?? null,
        },
      });
      throw new UnauthorizedException(ctx.i18n.t('auth.refresh_reuse_detected'));
    }

    if (stored.expiresAt < new Date()) {
      throw new UnauthorizedException(ctx.i18n.t('auth.refresh_expired'));
    }

    if (stored.user.status !== 'ACTIVE') {
      throw new UnauthorizedException(ctx.i18n.t('auth.account_inactive'));
    }

    // Rotate: mark old as revoked, issue new in the same family
    // Атомарно: отзываем только если токен ещё не отозван (защита от гонки двух refresh)
    const rotated = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (rotated.count === 0) {
      throw new UnauthorizedException(ctx.i18n.t('auth.invalid_refresh_token'));
    }

    return this.issueTokens(stored.user, ctx, stored.family);
  }

  private async hasNewerInFamily(family: string, since: Date) {
    return (await this.prisma.refreshToken.count({ where: { family, revokedAt: null, createdAt: { gte: new Date(since.getTime() - 1000) } } })) > 0;
  }

  async logout(token: string) {
    if (!token) return;
    const tokenHash = this.hashToken(token);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // ─────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────
  private async issueTokens(user: User, ctx: AuthContext, family?: string) {
    const accessToken = this.jwt.sign(
      { sub: user.id, role: user.role, loginId: user.loginId },
      { secret: env.JWT_ACCESS_SECRET, expiresIn: env.JWT_ACCESS_TTL },
    );

    const refreshRaw = crypto.randomBytes(64).toString('base64url');
    const refreshHash = this.hashToken(refreshRaw);
    const expiresAt = new Date(Date.now() + parseDuration(env.JWT_REFRESH_TTL));
    const newFamily = family ?? crypto.randomUUID();

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: refreshHash,
        family: newFamily,
        userAgent: ctx.userAgent ?? null,
        ip: ctx.ip ?? null,
        expiresAt,
      },
    });

    return {
      accessToken,
      refreshToken: refreshRaw,
      user: this.toPublicUser(user),
    };
  }

  private toPublicUser(user: any) {
    if (!user) return null;
    const { passwordHash, totpSecret, ...safe } = user;
    return safe;
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  // Атомарный инкремент: параллельные попытки подбора не «теряют» неудачи
  private async handleFailedLogin(user: User) {
    const { failedLogins } = await this.prisma.user.update({ where: { id: user.id }, data: { failedLogins: { increment: 1 } }, select: { failedLogins: true } });
    if (failedLogins >= MAX_FAILED_LOGINS) {
      await this.prisma.user.update({ where: { id: user.id }, data: { lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000) } });
    }
  }

  private async logLogin(
    userId: string | null,
    loginId: string,
    success: boolean,
    reason: string | null,
    ctx: AuthContext,
  ) {
    await this.prisma.loginLog.create({
      data: {
        userId,
        loginId,
        success,
        reason,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      },
    });
  }

}
