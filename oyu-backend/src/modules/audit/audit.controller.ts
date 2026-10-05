import { Body, Controller, Get, Param, Patch, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { AIFeature, FindingStatus, Role } from '@prisma/client';
import { z } from 'zod';

import { RequirePermission } from '../../common/rbac/require-permission.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { AuditCenterService } from './audit.service';
import { AuditAnomaliesService } from './audit-anomalies.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

const isDate = (v: string) => !Number.isNaN(Date.parse(v.length === 10 ? v + 'T00:00:00Z' : v));
const dateStr = z.string().max(40).refine(isDate, 'invalid date');
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const take = z.coerce.number().int().min(1).max(200);

const HoursQuery = z.object({ hours: z.coerce.number().int().min(1).max(720).optional() });
const AuditQuery = z.object({
  take: take.optional(),
  cursor: z.string().max(40).optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
  user: z.string().trim().max(60).optional(),
  action: z.string().trim().max(80).optional(),
  targetType: z.string().trim().max(60).optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  result: z.enum(['SUCCESS', 'DENIED', 'FAILED']).optional(),
});
const LoginQuery = z.object({
  take: take.optional(),
  cursor: z.string().max(40).optional(),
  success: bool.optional(),
  reason: z.enum(['bad_password', 'locked', 'not_found', 'inactive']).optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
  search: z.string().trim().max(20).optional(),
});
const AnomalyListQuery = z.object({
  hours: z.coerce.number().int().min(1).max(720).default(168),
  type: z.enum(['BRUTE_FORCE_IP', 'TARGETED_ACCOUNT', 'PARALLEL_SESSIONS', 'UNUSUAL_HOUR_LOGIN', 'MASS_ACTIVITY', 'TOKEN_REUSE', 'ACCOUNT_LOCKED']).optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  status: z.nativeEnum(FindingStatus).optional(),
});
const AnomalyReviewSchema = z
  .object({ key: z.string().min(3).max(200), status: z.nativeEnum(FindingStatus), note: z.string().trim().max(500).optional() })
  .strict();

// Admin Panel → Audit Log. Чтение — audit.view, разбор аномалий/флаги — audit.review, выгрузка — audit.export.
// Обработчики не ограничивают данные по scope, поэтому требуется scope ALL.
@Controller('admin/audit')
@RequirePermission('audit.view', { requireAll: true })
export class AuditCenterController {
  constructor(
    private readonly security: AuditCenterService,
    private readonly anomalies: AuditAnomaliesService,
    private readonly prisma: PrismaService,
  ) {}

  // ─── Anomaly detection ───
  @Get('anomalies/overview')
  anomaliesOverview(@Query('hours') hours?: string) {
    const h = hours ? parseInt(hours, 10) : 24;
    return this.anomalies.overview(Number.isFinite(h) ? Math.min(720, Math.max(1, h)) : 24);
  }

  @Get('anomalies/login')
  loginAnomalies(@Query('hours') hours?: string) {
    const h = hours ? parseInt(hours, 10) : 168;
    return this.anomalies.loginAnomalies(Number.isFinite(h) ? Math.min(720, Math.max(1, h)) : 168);
  }

  @Get('anomalies/mass-export')
  massExport(@Query('hours') hours?: string) {
    const h = hours ? parseInt(hours, 10) : 24;
    return this.anomalies.massExportAnomalies(Number.isFinite(h) ? Math.min(720, Math.max(1, h)) : 24);
  }

  @Get('anomalies/critical-changes')
  criticalChanges(@Query('hours') hours?: string) {
    const h = hours ? parseInt(hours, 10) : 168;
    return this.anomalies.criticalChanges(Number.isFinite(h) ? Math.min(720, Math.max(1, h)) : 168);
  }

  @Get('config')
  config() {
    return this.security.getSecurityConfig();
  }

  @Get('dependencies')
  dependencies() {
    return this.security.getDependencyReport();
  }

  // ─── Overview / anomalies (actionable) ───
  @Get('overview')
  overview() {
    return this.security.overview();
  }

  @Get('anomalies')
  anomalyList(@Query(new ZodValidationPipe(AnomalyListQuery)) q: z.infer<typeof AnomalyListQuery>) {
    return this.anomalies.list(q.hours, { type: q.type, severity: q.severity, status: q.status });
  }

  // Аудитор может менять ТОЛЬКО статус разбора аномалии. Конфигурацию безопасности менять нельзя нигде.
  @Patch('anomalies/review')
  @RequirePermission('audit.review', { requireAll: true })
  reviewAnomaly(
    @CurrentUser() user: CurrentUserData,
    @Body(new ZodValidationPipe(AnomalyReviewSchema)) dto: z.infer<typeof AnomalyReviewSchema>,
    @Req() req: Request,
  ) {
    return this.anomalies.review(dto.key, dto.status, dto.note, user.id, { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null });
  }

  // ─── Audit log ───
  @Get('audit-logs')
  auditLogs(@Query(new ZodValidationPipe(AuditQuery)) q: z.infer<typeof AuditQuery>) {
    return this.security.listAuditLogs(q);
  }

  @Get('audit-logs/export.csv')
  @RequirePermission('audit.export', { requireAll: true })
  async exportAuditLogs(
    @CurrentUser() user: CurrentUserData,
    @Query(new ZodValidationPipe(AuditQuery)) q: z.infer<typeof AuditQuery>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const csv = await this.security.exportCsv(q, user.id, { ip: req.ip ?? null, userAgent: (req.headers['user-agent'] as string) ?? null });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="audit-log.csv"', 'Cache-Control': 'no-store' });
    return csv;
  }

  @Get('audit-logs/facets')
  auditFacets() {
    return this.security.auditFacets();
  }

  @Get('audit-logs/:id')
  auditLog(@Param('id') id: string) {
    return this.security.getAuditLog(id);
  }

  // ─── Login activity ───
  @Get('login-logs')
  loginLogs(@Query(new ZodValidationPipe(LoginQuery)) q: z.infer<typeof LoginQuery>) {
    return this.security.listLoginLogs(q);
  }

  @Get('login-activity')
  loginActivity(@Query(new ZodValidationPipe(HoursQuery)) q: z.infer<typeof HoursQuery>) {
    return this.security.loginActivity(q.hours ?? 24);
  }

  @Get('failed-logins-24h')
  failedLogins() {
    return this.security.failedLoginsLast24h();
  }

  @Get('locked-accounts')
  lockedAccounts() {
    return this.security.lockedAccounts();
  }

  // ═══════════════════════════════════════════════════════════════
  //   AI-CHATS — IT-аудитор видит ВСЕ диалоги всех пользователей с AI
  // ═══════════════════════════════════════════════════════════════

  @Get('ai-chats/stats')
  async aiChatsStats() {
    const since24h = new Date(Date.now() - 24 * 3_600_000);
    const since7d = new Date(Date.now() - 7 * 24 * 3_600_000);

    const [total, last24h, last7d, flagged, byFeature, topUsers, costAgg] = await Promise.all([
      this.prisma.aIChatSession.count(),
      this.prisma.aIChatSession.count({ where: { createdAt: { gte: since24h } } }),
      this.prisma.aIChatSession.count({ where: { createdAt: { gte: since7d } } }),
      this.prisma.aIChatSession.count({ where: { flagged: true } }),
      this.prisma.aIChatSession.groupBy({
        by: ['feature'],
        _count: { _all: true },
        _sum: { totalTokens: true, costUsdMilli: true },
      }),
      this.prisma.aIChatSession.groupBy({
        by: ['userId'],
        _count: { _all: true },
        _sum: { totalTokens: true },
        orderBy: { _count: { userId: 'desc' } },
        take: 10,
      }),
      this.prisma.aIChatSession.aggregate({
        _sum: { totalTokens: true, costUsdMilli: true },
      }),
    ]);

    const userDetails = await this.prisma.user.findMany({
      where: { id: { in: topUsers.map((u) => u.userId) } },
      select: { id: true, loginId: true, role: true, fullName: true },
    });
    const userMap = new Map(userDetails.map((u) => [u.id, u]));

    return {
      total,
      last24h,
      last7d,
      flagged,
      totalTokens: costAgg._sum.totalTokens ?? 0,
      totalCostUsd: ((costAgg._sum.costUsdMilli ?? 0) / 1000).toFixed(3),
      byFeature: byFeature.map((f) => ({
        feature: f.feature,
        sessions: f._count._all,
        tokens: f._sum.totalTokens ?? 0,
        costUsd: ((f._sum.costUsdMilli ?? 0) / 1000).toFixed(3),
      })),
      topUsers: topUsers.map((u) => ({
        user: userMap.get(u.userId) ?? { id: u.userId, loginId: '?', role: '?', fullName: '?' },
        sessions: u._count._all,
        tokens: u._sum.totalTokens ?? 0,
      })),
    };
  }

  @Get('ai-chats')
  async aiChats(
    @Query('take') take?: string,
    @Query('cursor') cursor?: string,
    @Query('feature') feature?: string,
    @Query('flagged') flagged?: string,
    @Query('search') search?: string,
    @Query('role') role?: string,
  ) {
    const limit = Math.min(Math.max(parseInt(take ?? '30', 10), 1), 100);
    const where: any = {};
    if (feature && Object.values(AIFeature).includes(feature as AIFeature)) where.feature = feature;
    if (flagged === 'true') where.flagged = true;
    if (flagged === 'false') where.flagged = false;
    if (role && (Object.values(Role) as string[]).includes(role)) {
      where.user = { role };
    }
    if (search && search.trim()) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { user: { fullName: { contains: search, mode: 'insensitive' } } },
        { user: { loginId: { contains: search } } },
        { messages: { some: { content: { contains: search, mode: 'insensitive' } } } },
      ];
    }

    const items = await this.prisma.aIChatSession.findMany({
      where,
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { loginId: true, role: true, fullName: true } },
        _count: { select: { messages: true } },
        messages: { take: 1, orderBy: { createdAt: 'asc' }, select: { content: true } },
      },
    });

    const hasMore = items.length > limit;
    const slice = hasMore ? items.slice(0, limit) : items;
    return {
      items: slice.map((s) => ({
        id: s.id,
        user: s.user,
        feature: s.feature,
        title: s.title,
        messageCount: s._count.messages,
        totalTokens: s.totalTokens,
        costUsd: (s.costUsdMilli / 1000).toFixed(3),
        flagged: s.flagged,
        flagReason: s.flagReason,
        firstMessage: s.messages[0]?.content?.slice(0, 200) ?? '',
        ip: s.ip,
        createdAt: s.createdAt,
      })),
      nextCursor: hasMore ? slice[slice.length - 1].id : null,
    };
  }

  @Get('ai-chats/:id')
  async aiChat(@Param('id') id: string) {
    const item = await this.prisma.aIChatSession.findUnique({
      where: { id },
      include: {
        user: { select: { loginId: true, role: true, fullName: true, email: true } },
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
    return { item };
  }

  @Patch('ai-chats/:id/flag')
  @RequirePermission('audit.review', { requireAll: true })
  async flagAiChat(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: CurrentUserData,
  ) {
    const parsed = z.object({
      flagged: z.boolean(),
      reason: z.string().max(500).optional(),
    }).parse(body);

    const item = await this.prisma.aIChatSession.update({
      where: { id },
      data: {
        flagged: parsed.flagged,
        flagReason: parsed.flagged ? parsed.reason ?? 'manually flagged' : null,
        flaggedAt: parsed.flagged ? new Date() : null,
        flaggedById: parsed.flagged ? user.id : null,
      },
    });
    return { item };
  }

  // Возвращает фактические security headers, полученные этим же запросом.
  // Позволяет IT-аудитору наглядно увидеть что отдаёт сервер.
  @Get('headers-snapshot')
  headersSnapshot(@Req() req: Request) {
    const incoming = {
      host: req.headers.host,
      origin: req.headers.origin,
      userAgent: req.headers['user-agent'],
      xForwardedFor: req.headers['x-forwarded-for'],
    };
    return {
      requestReceivedHeaders: incoming,
      note: 'Response headers сервера видны во вкладке Network браузера. Ключевые: Strict-Transport-Security, Content-Security-Policy, X-Content-Type-Options, X-Frame-Options, Referrer-Policy.',
    };
  }
}
