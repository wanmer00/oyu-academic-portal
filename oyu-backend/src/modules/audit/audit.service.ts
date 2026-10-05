import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { env } from '../../config/env';
import { AuditAnomaliesService } from './audit-anomalies.service';
import { scrub, Severity, severityOf, severityWhere } from './severity';

export interface AuditFilters {
  take?: number;
  cursor?: string;
  from?: string;
  to?: string;
  user?: string;
  action?: string;
  targetType?: string;
  severity?: Severity;
  result?: string;
}

export interface LoginFilters {
  take?: number;
  cursor?: string;
  success?: boolean;
  reason?: string;
  from?: string;
  to?: string;
  search?: string;
}

/** 'YYYY-MM-DD' в качестве верхней границы включает весь день */
function parseFrom(v?: string) { return v ? new Date(v.length === 10 ? v + 'T00:00:00.000Z' : v) : undefined; }
function parseTo(v?: string) { return v ? new Date(v.length === 10 ? v + 'T23:59:59.999Z' : v) : undefined; }
function range(from?: string, to?: string) {
  const gte = parseFrom(from), lte = parseTo(to);
  return gte || lte ? { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) } : undefined;
}

@Injectable()
export class AuditCenterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly anomalies: AuditAnomaliesService,
  ) {}

  // ───────────────────────── Audit log ─────────────────────────
  /** Список — без diff/userAgent (чувствительные внутренности только по запросу конкретной записи) */
  async listAuditLogs(p: AuditFilters) {
    const take = Math.min(p.take ?? 50, 200);
    const and: Prisma.AuditLogWhereInput[] = [];
    const created = range(p.from, p.to);
    if (created) and.push({ createdAt: created });
    if (p.action) and.push({ action: { contains: p.action, mode: 'insensitive' } });
    if (p.targetType) and.push({ targetType: p.targetType });
    if (p.result) and.push({ result: p.result });
    if (p.user) {
      and.push({ actor: { OR: [{ loginId: { contains: p.user } }, { fullName: { contains: p.user, mode: 'insensitive' } }] } });
    }
    if (p.severity) and.push(severityWhere(p.severity));
    const where: Prisma.AuditLogWhereInput = and.length ? { AND: and } : {};

    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        take: take + 1,
        ...(p.cursor && { cursor: { id: p.cursor }, skip: 1 }),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true, createdAt: true, action: true, targetType: true, targetId: true, ip: true, result: true,
          actor: { select: { loginId: true, fullName: true, role: true } },
        },
      }),
    ]);
    const hasMore = rows.length > take;
    const slice = hasMore ? rows.slice(0, take) : rows;
    return {
      total,
      items: slice.map((r) => ({ ...r, severity: severityOf(r.action) })),
      nextCursor: hasMore ? slice[slice.length - 1].id : null,
    };
  }

  async getAuditLog(id: string) {
    const r = await this.prisma.auditLog.findUnique({
      where: { id },
      include: { actor: { select: { loginId: true, fullName: true, role: true } } },
    });
    if (!r) throw new NotFoundException('Audit record not found');
    return {
      id: r.id, createdAt: r.createdAt, action: r.action, severity: severityOf(r.action),
      targetType: r.targetType, targetId: r.targetId, ip: r.ip, result: r.result,
      userAgent: r.userAgent ? r.userAgent.slice(0, 200) : null,
      actor: r.actor,
      diff: scrub(r.diff), // секретоподобные ключи скрыты
    };
  }

  /** CSV журнала действий по фильтрам (до 10 000 строк). Сам экспорт фиксируется в аудите. */
  async exportCsv(p: AuditFilters, actorId: string, ctx: { ip?: string | null; userAgent?: string | null }) {
    const and: Prisma.AuditLogWhereInput[] = [];
    const created = range(p.from, p.to);
    if (created) and.push({ createdAt: created });
    if (p.action) and.push({ action: { contains: p.action, mode: 'insensitive' } });
    if (p.targetType) and.push({ targetType: p.targetType });
    if (p.result) and.push({ result: p.result });
    if (p.user) and.push({ actor: { OR: [{ loginId: { contains: p.user } }, { fullName: { contains: p.user, mode: 'insensitive' } }] } });
    if (p.severity) and.push(severityWhere(p.severity));
    const rows = await this.prisma.auditLog.findMany({
      where: and.length ? { AND: and } : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 10000,
      select: { createdAt: true, action: true, targetType: true, targetId: true, result: true, ip: true, diff: true, actor: { select: { loginId: true, fullName: true, role: true } } },
    });
    await this.prisma.auditLog.create({ data: { actorId, action: 'audit.export', targetType: 'AuditLog', diff: { rows: rows.length, filters: { ...p, cursor: undefined, take: undefined } } as Prisma.InputJsonValue, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null } });
    const cell = (v: unknown) => {
      let s = v == null ? '' : String(v);
      if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const header = ['timestamp', 'actor_login_id', 'actor', 'role', 'action', 'severity', 'entity', 'entity_id', 'result', 'old', 'new', 'ip'];
    const lines = rows.map((r) => {
      const d = (scrub(r.diff) ?? {}) as Record<string, unknown>;
      const js = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
      return [r.createdAt.toISOString(), r.actor?.loginId, r.actor?.fullName, r.actor?.role, r.action, severityOf(r.action), r.targetType, r.targetId, r.result, js(d.old), js(d.new), r.ip];
    });
    return '﻿' + [header, ...lines].map((l) => l.map(cell).join(',')).join('\r\n') + '\r\n';
  }

  async auditFacets() {
    const [actions, targets] = await Promise.all([
      this.prisma.auditLog.groupBy({ by: ['action'], _count: { _all: true }, orderBy: { _count: { action: 'desc' } }, take: 60 }),
      this.prisma.auditLog.groupBy({ by: ['targetType'], _count: { _all: true }, orderBy: { _count: { targetType: 'desc' } }, take: 30 }),
    ]);
    return {
      actions: actions.map((a) => ({ action: a.action, count: a._count._all, severity: severityOf(a.action) })),
      targetTypes: targets.map((t) => ({ targetType: t.targetType, count: t._count._all })),
    };
  }

  // ───────────────────────── Login logs ─────────────────────────
  async listLoginLogs(p: LoginFilters) {
    const take = Math.min(p.take ?? 50, 200);
    const where: Prisma.LoginLogWhereInput = {};
    if (p.success !== undefined) where.success = p.success;
    if (p.reason) where.reason = p.reason;
    if (p.search) where.loginId = { contains: p.search };
    const created = range(p.from, p.to);
    if (created) where.createdAt = created;

    const [total, rows] = await Promise.all([
      this.prisma.loginLog.count({ where }),
      this.prisma.loginLog.findMany({
        where,
        take: take + 1,
        ...(p.cursor && { cursor: { id: p.cursor }, skip: 1 }),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: { user: { select: { fullName: true, role: true } } },
      }),
    ]);
    const hasMore = rows.length > take;
    const slice = hasMore ? rows.slice(0, take) : rows;
    return {
      total,
      items: slice.map((l) => ({
        id: l.id, createdAt: l.createdAt, loginId: l.loginId, success: l.success, reason: l.reason, ip: l.ip,
        userAgent: l.userAgent ? l.userAgent.slice(0, 120) : null,
        user: l.user ? { fullName: l.user.fullName, role: l.user.role } : null,
      })),
      nextCursor: hasMore ? slice[slice.length - 1].id : null,
    };
  }

  /** Сводка активности входов: успешные / неуспешные / заблокированные + таймлайн + последние события */
  async loginActivity(hours = 24) {
    const h = Math.min(Math.max(hours, 1), 720);
    const since = new Date(Date.now() - h * 3600_000);
    const now = new Date();
    const logs = await this.prisma.loginLog.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { fullName: true, role: true } } },
    });

    const failed = logs.filter((l) => !l.success);
    const byReason: Record<string, number> = {};
    for (const l of failed) byReason[l.reason ?? 'unknown'] = (byReason[l.reason ?? 'unknown'] ?? 0) + 1;

    const bucketMs = (h <= 48 ? 1 : h <= 168 ? 6 : 24) * 3600_000;
    const start = Math.floor(since.getTime() / bucketMs) * bucketMs;
    const buckets = new Map<number, { t: string; success: number; failed: number }>();
    for (let t = start; t <= now.getTime(); t += bucketMs) buckets.set(t, { t: new Date(t).toISOString(), success: 0, failed: 0 });
    for (const l of logs) {
      const k = Math.floor(l.createdAt.getTime() / bucketMs) * bucketMs;
      const b = buckets.get(k);
      if (b) l.success ? b.success++ : b.failed++;
    }

    const currentlyLocked = await this.prisma.user.count({ where: { lockedUntil: { gt: now } } });
    return {
      windowHours: h,
      totals: {
        events: logs.length,
        successful: logs.length - failed.length,
        failed: failed.length,
        lockedEvents: byReason['locked'] ?? 0,
        currentlyLockedAccounts: currentlyLocked,
        uniqueFailedIps: new Set(failed.map((l) => l.ip).filter(Boolean)).size,
      },
      failedByReason: byReason,
      timeline: Array.from(buckets.values()),
      recent: logs.slice(0, 15).map((l) => ({
        id: l.id, createdAt: l.createdAt, loginId: l.loginId, success: l.success, reason: l.reason, ip: l.ip,
        user: l.user ? { fullName: l.user.fullName, role: l.user.role } : null,
      })),
    };
  }

  async failedLoginsLast24h() {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const grouped = await this.prisma.loginLog.groupBy({
      by: ['loginId', 'reason'],
      where: { success: false, createdAt: { gte: since } },
      _count: { _all: true },
    });
    const totals = await this.prisma.loginLog.count({ where: { success: false, createdAt: { gte: since } } });
    return { total24h: totals, byLoginId: grouped };
  }

  async lockedAccounts() {
    const now = new Date();
    return this.prisma.user.findMany({
      where: { lockedUntil: { gt: now } },
      select: { loginId: true, fullName: true, role: true, failedLogins: true, lockedUntil: true },
    });
  }

  // ───────────────────────── Overview ─────────────────────────
  async overview() {
    const since24 = new Date(Date.now() - 24 * 3600_000);
    const since7d = new Date(Date.now() - 7 * 24 * 3600_000);
    const importantWhere: Prisma.AuditLogWhereInput = { AND: [{ createdAt: { gte: since7d } }, { OR: [severityWhere('critical'), severityWhere('high')] }] };

    const [failed24, recentFailed, locked, importantCount, important, recentAudit, anomalies, deps] = await Promise.all([
      this.prisma.loginLog.count({ where: { success: false, createdAt: { gte: since24 } } }),
      this.prisma.loginLog.findMany({
        where: { success: false }, orderBy: { createdAt: 'desc' }, take: 8,
        select: { id: true, createdAt: true, loginId: true, reason: true, ip: true },
      }),
      this.lockedAccounts(),
      this.prisma.auditLog.count({ where: importantWhere }),
      this.prisma.auditLog.findMany({
        where: importantWhere, orderBy: { createdAt: 'desc' }, take: 8,
        select: { id: true, createdAt: true, action: true, targetType: true, ip: true, actor: { select: { loginId: true, fullName: true } } },
      }),
      this.prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' }, take: 8,
        select: { id: true, createdAt: true, action: true, targetType: true, ip: true, actor: { select: { loginId: true, fullName: true } } },
      }),
      this.anomalies.list(168),
      this.getDependencyReport(),
    ]);

    const cfg = this.getSecurityConfig();
    const open = anomalies.items.filter((a) => a.status === 'OPEN');
    return {
      kpi: {
        failedLogins24h: failed24,
        lockedAccounts: locked.length,
        openAnomalies: open.length,
        criticalOpenAnomalies: open.filter((a) => a.severity === 'critical').length,
        importantEvents7d: importantCount,
      },
      recentFailedLogins: recentFailed,
      lockedAccounts: locked,
      importantEvents: important.map((e) => ({ ...e, severity: severityOf(e.action) })),
      topAnomalies: anomalies.items.filter((a) => a.status === 'OPEN').slice(0, 5),
      anomalyCounts: anomalies.counts,
      recentAudit: recentAudit.map((e) => ({ ...e, severity: severityOf(e.action) })),
      health: {
        auditLog: cfg.audit.auditLog, loginLog: cfg.audit.loginLog,
        refreshRotation: cfg.jwt.refreshRotation, reuseDetection: cfg.jwt.refreshReuseDetection,
        hsts: cfg.transport.hsts, cookieSecure: cfg.transport.cookieSecure,
      },
      dependencies: { total: deps.totalDependencies, dev: deps.totalDevDependencies, critical: Object.keys(deps.criticalSecurityDependencies).length },
    };
  }

  // ── Конфигурация безопасности — публично видимая часть (только чтение; секреты не отдаются) ──
  getSecurityConfig() {
    return {
      password: {
        algorithm: 'argon2id',
        memoryKB: 65536,
        iterations: 3,
        parallelism: 4,
      },
      jwt: {
        accessAlgorithm: 'HS256',
        accessTTL: env.JWT_ACCESS_TTL,
        refreshTTL: env.JWT_REFRESH_TTL,
        refreshStorage: 'HttpOnly cookie + SameSite=Strict',
        refreshRotation: true,
        refreshReuseDetection: true,
      },
      session: {
        lockoutAfterFailedLogins: 5,
        lockoutDurationMinutes: 15,
      },
      transport: {
        hsts: env.NODE_ENV === 'production',
        cookieSecure: env.COOKIE_SECURE,
        tls: env.NODE_ENV === 'production' ? 'enforced by proxy (Railway)' : 'disabled in dev',
      },
      headers: {
        csp: 'strict (self only, no unsafe-inline scripts)',
        xContentTypeOptions: 'nosniff',
        xFrameOptions: 'DENY',
        referrerPolicy: 'strict-origin-when-cross-origin',
      },
      rateLimit: {
        globalPerWindowMs: env.RATE_LIMIT_MAX,
        authLoginPerMinute: env.RATE_LIMIT_AUTH_MAX,
        refreshPerMinute: 30,
      },
      cors: {
        mode: 'whitelist',
        origins: env.FRONTEND_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
        credentials: true,
      },
      audit: {
        auditLog: true,
        loginLog: true,
        gradeChangeHistory: true,
      },
      validation: {
        library: 'zod (strict mode)',
        massAssignmentProtection: true,
        sqlInjectionProtection: 'Prisma parameterized queries',
      },
    };
  }

  // ── Зависимости: читаем package.json + наши security-important пакеты ──
  async getDependencyReport() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../../../package.json');
    const deps = Object.keys(pkg.dependencies || {}).length;
    const devDeps = Object.keys(pkg.devDependencies || {}).length;

    const critical = [
      '@nestjs/core', '@nestjs/jwt', '@nestjs/passport', '@nestjs/throttler',
      '@prisma/client', 'argon2', 'helmet', 'zod', 'passport-jwt', 'cookie-parser',
    ];
    const versions: Record<string, string> = {};
    for (const name of critical) {
      const v = pkg.dependencies?.[name] || pkg.devDependencies?.[name];
      if (v) versions[name] = v;
    }

    return {
      totalDependencies: deps,
      totalDevDependencies: devDeps,
      criticalSecurityDependencies: versions,
      notes: 'Run `npm audit --production` in CI for full vulnerability report.',
    };
  }
}
