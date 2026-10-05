import { Injectable, NotFoundException } from '@nestjs/common';
import { FindingStatus } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/**
 * Security anomaly detection.
 * Простые эвристики поверх LoginLog / AuditLog:
 *  - Brute-force: много fail-логинов с одного IP / на один loginId за окно
 *  - Parallel sessions: один user с разных IP за ≤ N минут
 *  - Unusual hours: успешный логин в нестандартное время (23:00-06:00) для этого юзера
 *  - Mass exports: много READ-операций на чувствительные ресурсы за короткое окно
 *  - Critical changes: изменения GRADE / PAYMENT / ROLE / USER за окно
 *  - Privilege escalation: попытки доступа к ресурсам не своей роли (FAILED action)
 */
@Injectable()
export class AuditAnomaliesService {
  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────────────────────────────────────────
  // 89/90/91: Логины — brute-force, параллельные сессии, нестандартное время
  // ─────────────────────────────────────────────────────────────
  async loginAnomalies(hoursBack = 168) {
    const since = new Date(Date.now() - hoursBack * 3600 * 1000);
    const logs = await this.prisma.loginLog.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { loginId: true, fullName: true, role: true } } },
    });

    // Brute-force by IP
    const failByIp = new Map<string, number>();
    const failByLogin = new Map<string, number>();
    for (const l of logs) {
      if (!l.success) {
        if (l.ip) failByIp.set(l.ip, (failByIp.get(l.ip) || 0) + 1);
        failByLogin.set(l.loginId, (failByLogin.get(l.loginId) || 0) + 1);
      }
    }
    const bruteForceIps = Array.from(failByIp.entries())
      .filter(([, n]) => n >= 5)
      .map(([ip, n]) => ({ ip, failedAttempts: n }))
      .sort((a, b) => b.failedAttempts - a.failedAttempts);

    const targetedAccounts = Array.from(failByLogin.entries())
      .filter(([, n]) => n >= 5)
      .map(([loginId, n]) => ({ loginId, failedAttempts: n }))
      .sort((a, b) => b.failedAttempts - a.failedAttempts);

    // Parallel sessions: для каждого user — успешные логины с разных IP в пределах 10 минут
    const successByUser = new Map<string, Array<{ ip: string | null; createdAt: Date; loginId: string; fullName: string }>>();
    for (const l of logs) {
      if (!l.success || !l.userId) continue;
      const arr = successByUser.get(l.userId) || [];
      arr.push({ ip: l.ip, createdAt: l.createdAt, loginId: l.loginId, fullName: l.user?.fullName || '' });
      successByUser.set(l.userId, arr);
    }
    const parallelSessions: Array<{ loginId: string; fullName: string; ips: string[]; withinMinutes: number; at: Date }> = [];
    for (const [, arr] of successByUser) {
      arr.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      for (let i = 1; i < arr.length; i++) {
        const a = arr[i - 1], b = arr[i];
        if (a.ip && b.ip && a.ip !== b.ip) {
          const dtMin = (b.createdAt.getTime() - a.createdAt.getTime()) / 60000;
          if (dtMin <= 10) {
            parallelSessions.push({
              loginId: b.loginId,
              fullName: b.fullName,
              ips: [a.ip, b.ip],
              withinMinutes: Math.round(dtMin),
              at: b.createdAt,
            });
          }
        }
      }
    }

    // Unusual-hour logins (23:00-06:00 local-ish UTC+4)
    const unusualHourLogins = logs
      .filter((l) => {
        if (!l.success) return false;
        const h = (l.createdAt.getUTCHours() + 4) % 24;
        return h >= 23 || h < 6;
      })
      .map((l) => ({
        loginId: l.loginId,
        fullName: l.user?.fullName || '',
        role: l.user?.role || null,
        ip: l.ip,
        at: l.createdAt,
        hourLocal: (l.createdAt.getUTCHours() + 4) % 24,
      }));

    return {
      windowHours: hoursBack,
      totals: {
        loginEvents: logs.length,
        failedTotal: logs.filter((l) => !l.success).length,
        successTotal: logs.filter((l) => l.success).length,
      },
      bruteForceIps,
      targetedAccounts,
      parallelSessions: parallelSessions.slice(0, 50),
      unusualHourLogins: unusualHourLogins.slice(0, 50),
    };
  }

  // ─────────────────────────────────────────────────────────────
  // 98: Массовые выгрузки / READ-операций
  // ─────────────────────────────────────────────────────────────
  async massExportAnomalies(hoursBack = 24) {
    const since = new Date(Date.now() - hoursBack * 3600 * 1000);
    const logs = await this.prisma.auditLog.findMany({
      where: { createdAt: { gte: since } },
      include: { actor: { select: { loginId: true, fullName: true, role: true } } },
    });

    const byUser = new Map<string, { loginId: string; fullName: string; role: string; total: number; reads: number; targets: Map<string, number> }>();
    for (const l of logs) {
      const k = l.actorId || 'unknown';
      if (!byUser.has(k)) byUser.set(k, {
        loginId: l.actor?.loginId || '—',
        fullName: l.actor?.fullName || '—',
        role: l.actor?.role || '—',
        total: 0, reads: 0, targets: new Map(),
      });
      const e = byUser.get(k)!;
      e.total++;
      if (/READ|LIST|EXPORT|DOWNLOAD/i.test(l.action)) e.reads++;
      e.targets.set(l.targetType, (e.targets.get(l.targetType) || 0) + 1);
    }

    const items = Array.from(byUser.values())
      .filter((u) => u.reads >= 30 || u.total >= 100)
      .map((u) => ({
        loginId: u.loginId,
        fullName: u.fullName,
        role: u.role,
        totalActions: u.total,
        readActions: u.reads,
        topTargets: Array.from(u.targets.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, n]) => ({ target: t, count: n })),
      }))
      .sort((a, b) => b.readActions - a.readActions);

    return { windowHours: hoursBack, items };
  }

  // ─────────────────────────────────────────────────────────────
  // 107: Изменения критических данных (Grade / Payment / User role)
  // ─────────────────────────────────────────────────────────────
  async criticalChanges(hoursBack = 168) {
    const since = new Date(Date.now() - hoursBack * 3600 * 1000);

    const [auditLogs, gradeHistory] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: {
          createdAt: { gte: since },
          OR: [
            { targetType: 'Grade' },
            { targetType: 'Payment' },
            { targetType: 'User', action: { contains: 'ROLE' } },
            { targetType: 'User', action: { contains: 'STATUS' } },
            { action: { contains: 'GRADE' } },
            { action: { contains: 'PAYMENT' } },
          ],
        },
        include: { actor: { select: { loginId: true, fullName: true, role: true } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      this.prisma.gradeHistory.findMany({
        where: { changedAt: { gte: since } },
        include: {
          grade: {
            include: {
              student: { include: { user: { select: { loginId: true, fullName: true } } } },
              subject: { select: { code: true, name: true } },
            },
          },
        },
        orderBy: { changedAt: 'desc' },
        take: 100,
      }),
    ]);

    return {
      windowHours: hoursBack,
      auditEvents: auditLogs.map((l) => ({
        action: l.action,
        targetType: l.targetType,
        targetId: l.targetId,
        actorLoginId: l.actor?.loginId || null,
        actorName: l.actor?.fullName || null,
        actorRole: l.actor?.role || null,
        ip: l.ip,
        diff: l.diff,
        at: l.createdAt,
      })),
      gradeChanges: gradeHistory.map((h) => ({
        gradeId: h.gradeId,
        studentLoginId: h.grade.student.user.loginId,
        studentName: h.grade.student.user.fullName,
        subject: `${h.grade.subject.code} · ${h.grade.subject.name}`,
        oldValue: Number(h.oldValue),
        newValue: Number(h.newValue),
        delta: Number(h.newValue) - Number(h.oldValue),
        changedBy: h.changedBy,
        reason: h.reason,
        at: h.changedAt,
      })),
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Сводный обзор аномалий — для AI «дай аномалии»
  // ─────────────────────────────────────────────────────────────
  async overview(hoursBack = 24) {
    const [login, mass, crit] = await Promise.all([
      this.loginAnomalies(hoursBack),
      this.massExportAnomalies(hoursBack),
      this.criticalChanges(hoursBack),
    ]);
    return {
      windowHours: hoursBack,
      bruteForceIpsCount: login.bruteForceIps.length,
      targetedAccountsCount: login.targetedAccounts.length,
      parallelSessionsCount: login.parallelSessions.length,
      unusualHourLoginsCount: login.unusualHourLogins.length,
      massExportsCount: mass.items.length,
      criticalChangesCount: crit.auditEvents.length + crit.gradeChanges.length,
      gradeChangesCount: crit.gradeChanges.length,
      details: { login, mass, crit },
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Actionable-список аномалий: anomaly → reason → time → subject → status.
  // Каждая запись выводится из LoginLog/AuditLog/User (никаких выдуманных находок);
  // статус — решение аудитора, хранится в SecurityFindingReview по детерминированному ключу.
  // ─────────────────────────────────────────────────────────────
  async list(hoursBack = 168, filters: { type?: AnomalyType; severity?: AnomalySeverity; status?: FindingStatus } = {}) {
    const since = new Date(Date.now() - hoursBack * 3600 * 1000);
    const now = new Date();
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const items: AnomalyItem[] = [];

    const logs = await this.prisma.loginLog.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'asc' } });

    // 1) Brute-force по IP и целевые аккаунты
    const byIp = new Map<string, { n: number; last: Date; accounts: Set<string> }>();
    const byLogin = new Map<string, { n: number; last: Date; ips: Set<string> }>();
    for (const l of logs) {
      if (l.success) continue;
      if (l.ip) {
        const e = byIp.get(l.ip) ?? { n: 0, last: l.createdAt, accounts: new Set<string>() };
        e.n++; e.last = l.createdAt; e.accounts.add(l.loginId); byIp.set(l.ip, e);
      }
      const o = byLogin.get(l.loginId) ?? { n: 0, last: l.createdAt, ips: new Set<string>() };
      o.n++; o.last = l.createdAt; if (l.ip) o.ips.add(l.ip); byLogin.set(l.loginId, o);
    }
    for (const [ip, e] of byIp) {
      if (e.n < 5) continue;
      items.push({ key: `BRUTE_FORCE_IP:${ip}:${day(e.last)}`, type: 'BRUTE_FORCE_IP', severity: e.n >= 20 ? 'critical' : 'high', at: e.last,
        subject: { kind: 'ip', id: ip }, params: { count: e.n, accounts: e.accounts.size } });
    }
    for (const [loginId, e] of byLogin) {
      if (e.n < 5) continue;
      items.push({ key: `TARGETED_ACCOUNT:${loginId}:${day(e.last)}`, type: 'TARGETED_ACCOUNT', severity: 'high', at: e.last,
        subject: { kind: 'account', id: loginId }, params: { count: e.n, ips: e.ips.size } });
    }

    // 2) Параллельные сессии: успешные входы одного пользователя с разных IP ≤ 10 минут
    const okByUser = new Map<string, Array<{ ip: string | null; at: Date; loginId: string }>>();
    for (const l of logs) {
      if (!l.success || !l.userId) continue;
      const arr = okByUser.get(l.userId) ?? []; arr.push({ ip: l.ip, at: l.createdAt, loginId: l.loginId }); okByUser.set(l.userId, arr);
    }
    for (const arr of okByUser.values()) {
      for (let i = 1; i < arr.length; i++) {
        const a = arr[i - 1], b = arr[i];
        const dt = (b.at.getTime() - a.at.getTime()) / 60000;
        if (a.ip && b.ip && a.ip !== b.ip && dt <= 10) {
          items.push({ key: `PARALLEL_SESSIONS:${b.loginId}:${b.at.toISOString().slice(0, 16)}`, type: 'PARALLEL_SESSIONS', severity: 'medium', at: b.at,
            subject: { kind: 'account', id: b.loginId }, params: { ips: [a.ip, b.ip], withinMinutes: Math.round(dt) } });
        }
      }
    }

    // 3) Входы в нестандартное время (23:00–06:00, UTC+4) — агрегируем по аккаунту и дню
    const unusual = new Map<string, { n: number; last: Date; loginId: string }>();
    for (const l of logs) {
      if (!l.success) continue;
      const h = (l.createdAt.getUTCHours() + 4) % 24;
      if (!(h >= 23 || h < 6)) continue;
      const k = `${l.loginId}:${day(l.createdAt)}`;
      const e = unusual.get(k) ?? { n: 0, last: l.createdAt, loginId: l.loginId };
      e.n++; e.last = l.createdAt; unusual.set(k, e);
    }
    for (const [k, e] of unusual) {
      items.push({ key: `UNUSUAL_HOUR_LOGIN:${k}`, type: 'UNUSUAL_HOUR_LOGIN', severity: 'low', at: e.last,
        subject: { kind: 'account', id: e.loginId }, params: { count: e.n } });
    }

    // 4) Массовая активность пользователя в аудите
    const mass = await this.massExportAnomalies(hoursBack);
    if (mass.items.length) {
      const users = await this.prisma.user.findMany({ where: { loginId: { in: mass.items.map((m) => m.loginId) } }, select: { id: true, loginId: true } });
      const last = await this.prisma.auditLog.groupBy({ by: ['actorId'], where: { actorId: { in: users.map((u) => u.id) }, createdAt: { gte: since } }, _max: { createdAt: true } });
      const lastByLogin = new Map(users.map((u) => [u.loginId, last.find((x) => x.actorId === u.id)?._max.createdAt ?? now]));
      for (const m of mass.items) {
        const at = lastByLogin.get(m.loginId) ?? now;
        items.push({ key: `MASS_ACTIVITY:${m.loginId}:${day(at)}`, type: 'MASS_ACTIVITY', severity: 'medium', at,
          subject: { kind: 'account', id: m.loginId }, params: { total: m.totalActions, reads: m.readActions } });
      }
    }

    // 5) Повторное использование refresh-токена (детект кражи) — прямое событие аудита
    const reuse = await this.prisma.auditLog.findMany({
      where: { action: 'auth.refresh_reuse_detected', createdAt: { gte: since } },
      include: { actor: { select: { loginId: true } } }, orderBy: { createdAt: 'desc' }, take: 100,
    });
    for (const r of reuse) {
      items.push({ key: `TOKEN_REUSE:${r.id}`, type: 'TOKEN_REUSE', severity: 'critical', at: r.createdAt,
        subject: { kind: 'account', id: r.actor?.loginId ?? 'unknown' }, params: { ip: r.ip ?? null } });
    }

    // 6) Сейчас заблокированные аккаунты
    const locked = await this.prisma.user.findMany({
      where: { lockedUntil: { gt: now } },
      select: { loginId: true, failedLogins: true, lockedUntil: true },
    });
    for (const u of locked) {
      const lastFail = byLogin.get(u.loginId)?.last ?? u.lockedUntil!;
      items.push({ key: `ACCOUNT_LOCKED:${u.loginId}:${u.lockedUntil!.toISOString().slice(0, 13)}`, type: 'ACCOUNT_LOCKED', severity: 'medium', at: lastFail,
        subject: { kind: 'account', id: u.loginId }, params: { failedLogins: u.failedLogins, lockedUntil: u.lockedUntil!.toISOString() } });
    }

    // Имена аккаунтов + решения аудитора
    const loginIds = Array.from(new Set(items.filter((i) => i.subject.kind === 'account').map((i) => i.subject.id)));
    const named = loginIds.length ? await this.prisma.user.findMany({ where: { loginId: { in: loginIds } }, select: { loginId: true, fullName: true, role: true } }) : [];
    const nameByLogin = new Map(named.map((u) => [u.loginId, u]));
    const reviews = items.length ? await this.prisma.securityFindingReview.findMany({ where: { key: { in: items.map((i) => i.key) } } }) : [];
    const reviewByKey = new Map(reviews.map((r) => [r.key, r]));
    const reviewerIds = Array.from(new Set(reviews.map((r) => r.reviewedById).filter(Boolean))) as string[];
    const reviewers = reviewerIds.length ? await this.prisma.user.findMany({ where: { id: { in: reviewerIds } }, select: { id: true, fullName: true } }) : [];
    const reviewerName = new Map(reviewers.map((u) => [u.id, u.fullName]));

    const rank: Record<AnomalySeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    let out = items.map((i) => {
      const r = reviewByKey.get(i.key);
      const u = i.subject.kind === 'account' ? nameByLogin.get(i.subject.id) : undefined;
      return {
        key: i.key, type: i.type, severity: i.severity, at: i.at.toISOString(),
        subject: { ...i.subject, name: u?.fullName ?? null, role: u?.role ?? null },
        params: i.params,
        status: (r?.status ?? 'OPEN') as FindingStatus,
        note: r?.note ?? null,
        reviewedAt: r ? r.reviewedAt.toISOString() : null,
        reviewedBy: r?.reviewedById ? reviewerName.get(r.reviewedById) ?? null : null,
      };
    });

    const counts = {
      total: out.length,
      byStatus: {} as Record<string, number>,
      bySeverity: {} as Record<string, number>,
      byType: {} as Record<string, number>,
    };
    for (const i of out) {
      counts.byStatus[i.status] = (counts.byStatus[i.status] ?? 0) + 1;
      counts.bySeverity[i.severity] = (counts.bySeverity[i.severity] ?? 0) + 1;
      counts.byType[i.type] = (counts.byType[i.type] ?? 0) + 1;
    }
    if (filters.type) out = out.filter((i) => i.type === filters.type);
    if (filters.severity) out = out.filter((i) => i.severity === filters.severity);
    if (filters.status) out = out.filter((i) => i.status === filters.status);
    out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.at.localeCompare(a.at));
    return { windowHours: hoursBack, counts, items: out.slice(0, 300) };
  }

  /** Решение аудитора по аномалии. Ключ должен соответствовать реально вычисленной аномалии. */
  async review(key: string, status: FindingStatus, note: string | undefined, actorId: string, audit: { ip?: string | null; userAgent?: string | null }) {
    const current = await this.list(720);
    const found = current.items.find((i) => i.key === key);
    if (!found) throw new NotFoundException('Anomaly not found in the last 30 days');
    await this.prisma.securityFindingReview.upsert({
      where: { key },
      update: { status, note: note ?? null, reviewedById: actorId, reviewedAt: new Date() },
      create: { key, type: found.type, status, note: note ?? null, reviewedById: actorId },
    });
    await this.prisma.auditLog.create({
      data: {
        actorId, action: 'security.anomaly_review', targetType: 'SecurityFinding', targetId: key,
        diff: { type: found.type, from: found.status, to: status, hasNote: !!note },
        ip: audit.ip ?? null, userAgent: audit.userAgent ?? null,
      },
    });
    return { key, status, note: note ?? null };
  }
}

export type AnomalyType = 'BRUTE_FORCE_IP' | 'TARGETED_ACCOUNT' | 'PARALLEL_SESSIONS' | 'UNUSUAL_HOUR_LOGIN' | 'MASS_ACTIVITY' | 'TOKEN_REUSE' | 'ACCOUNT_LOCKED';
export type AnomalySeverity = 'critical' | 'high' | 'medium' | 'low';
interface AnomalyItem {
  key: string; type: AnomalyType; severity: AnomalySeverity; at: Date;
  subject: { kind: 'account' | 'ip'; id: string };
  params: Record<string, unknown>;
}
