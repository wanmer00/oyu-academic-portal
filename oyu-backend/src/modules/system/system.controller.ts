import { Controller, Get, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { z } from 'zod';
import { AuditTrailService } from '../../common/audit/audit-trail.service';
import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { RequirePermission } from '../../common/rbac/require-permission.decorator';
import { env } from '../../config/env';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

const ALL = { requireAll: true } as const;
const SearchQuery = z.object({ q: z.string().trim().min(2).max(60) });
const day = 86400000;

/**
 * Системные инструменты SUPER_ADMIN: состояние системы, активные сессии, глобальный поиск.
 * Показываются только реально измеримые величины — без выдуманных значений.
 */
@Controller('admin')
export class SystemController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditTrailService) {}

  @Get('system/health')
  @RequirePermission('settings.view', ALL)
  async health() {
    const t0 = Date.now();
    let db: { ok: boolean; latencyMs: number | null } = { ok: true, latencyMs: null };
    try { await this.prisma.$queryRaw`SELECT 1`; db.latencyMs = Date.now() - t0; } catch { db = { ok: false, latencyMs: null }; }
    const since = new Date(Date.now() - day);
    const [users, students, teachers, subjects, rooms, audit24h, failedLogins24h, sessions, jobsByStatus, lastFailedJob, lastLogin] = await Promise.all([
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.student.count(),
      this.prisma.teacher.count(),
      this.prisma.subject.count(),
      this.prisma.room.count(),
      this.prisma.auditLog.count({ where: { createdAt: { gte: since } } }),
      this.prisma.loginLog.count({ where: { success: false, createdAt: { gte: since } } }),
      this.prisma.refreshToken.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
      this.prisma.timetableJob.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.timetableJob.findFirst({ where: { status: 'FAILED' }, orderBy: { createdAt: 'desc' }, select: { id: true, error: true, createdAt: true } }),
      this.prisma.loginLog.findFirst({ where: { success: true }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    ]);
    const mem = process.memoryUsage();
    return {
      api: { ok: true, uptimeSec: Math.round(process.uptime()), node: process.version, env: env.NODE_ENV },
      database: db,
      memory: { rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576) },
      counts: { users, students, teachers, subjects, rooms },
      activity: { auditEvents24h: audit24h, failedLogins24h, activeSessions: sessions, lastSuccessfulLogin: lastLogin?.createdAt ?? null },
      backgroundJobs: { byStatus: Object.fromEntries(jobsByStatus.map((j) => [j.status, j._count._all])), lastFailed: lastFailedJob },
      demo: { enabled: env.DEMO_MODE, resetConfigured: !!env.DEMO_RESET_TOKEN },
      ai: { mode: env.ANTHROPIC_API_KEY ? 'live' : 'stub' },
    };
  }

  @Get('sessions')
  @RequirePermission('users.view', ALL)
  async sessions() {
    const rows = await this.prisma.refreshToken.findMany({
      where: { revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, ip: true, userAgent: true, createdAt: true, expiresAt: true, user: { select: { id: true, loginId: true, fullName: true, role: true } } },
    });
    return { items: rows };
  }

  @Post('sessions/:id/revoke')
  @RequirePermission('users.block', ALL)
  async revoke(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Req() req: Request) {
    const t = await this.prisma.refreshToken.findUnique({ where: { id }, select: { id: true, userId: true, revokedAt: true } });
    if (!t) throw new NotFoundException('Session not found');
    await this.prisma.refreshToken.update({ where: { id }, data: { revokedAt: new Date() } });
    await this.audit.record({ actorId: u.id, action: 'session.revoke', targetType: 'RefreshToken', targetId: id, extra: { userId: t.userId } }, { ip: req.ip ?? null, userAgent: (req.headers['user-agent'] as string) ?? null });
    return { ok: true };
  }

  /** Глобальный поиск: небольшие выборки по каждому типу сущностей, поиск на стороне БД */
  @Get('search')
  @RequirePermission('admin.access', ALL)
  async search(@Query(new ZodValidationPipe(SearchQuery)) query: z.infer<typeof SearchQuery>) {
    const q = query.q;
    const c = { contains: q, mode: 'insensitive' as const };
    const [students, teachers, groups, subjects, rooms, requests, announcements] = await Promise.all([
      this.prisma.user.findMany({ where: { role: 'STUDENT', deletedAt: null, OR: [{ fullName: c }, { loginId: c }, { email: c }] }, take: 5, select: { id: true, fullName: true, loginId: true, student: { select: { groupName: true } } } }),
      this.prisma.user.findMany({ where: { role: 'TEACHER', deletedAt: null, OR: [{ fullName: c }, { loginId: c }] }, take: 5, select: { id: true, fullName: true, loginId: true, teacher: { select: { department: true } } } }),
      this.prisma.student.groupBy({ by: ['groupName'], where: { groupName: c }, _count: { _all: true }, orderBy: { groupName: 'asc' }, take: 5 }),
      this.prisma.subject.findMany({ where: { OR: [{ code: c }, { name: c }] }, take: 5, select: { id: true, code: true, name: true, semester: true } }),
      this.prisma.room.findMany({ where: { OR: [{ code: c }, { name: c }, { building: c }] }, take: 5, select: { id: true, code: true, building: true, capacity: true } }),
      this.prisma.request.findMany({ where: { description: c }, take: 5, select: { id: true, type: true, status: true, description: true, user: { select: { fullName: true } } } }),
      this.prisma.announcement.findMany({ where: { OR: [{ title: c }, { body: c }] }, take: 5, select: { id: true, title: true } }),
    ]);
    return {
      results: [
        ...students.map((s) => ({ type: 'student', id: s.id, title: s.fullName, sub: `${s.loginId} · ${s.student?.groupName ?? ''}` })),
        ...teachers.map((s) => ({ type: 'teacher', id: s.id, title: s.fullName, sub: `${s.loginId} · ${s.teacher?.department ?? ''}` })),
        ...groups.map((g) => ({ type: 'group', id: g.groupName, title: g.groupName, sub: `${g._count._all}` })),
        ...subjects.map((s) => ({ type: 'subject', id: s.id, title: `${s.code} · ${s.name}`, sub: `semester ${s.semester}` })),
        ...rooms.map((r) => ({ type: 'room', id: r.id, title: r.code, sub: `${r.building ?? ''} · ${r.capacity}` })),
        ...requests.map((r) => ({ type: 'request', id: r.id, title: r.description.slice(0, 70), sub: `${r.type} · ${r.status} · ${r.user.fullName}` })),
        ...announcements.map((a) => ({ type: 'announcement', id: a.id, title: a.title, sub: '' })),
      ],
    };
  }
}