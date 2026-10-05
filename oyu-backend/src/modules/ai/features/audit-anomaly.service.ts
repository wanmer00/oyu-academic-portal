import { Injectable } from '@nestjs/common';
import { AIFeature } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AISessionService } from '../ai-session.service';
import { CurrentUserData } from '../../../common/decorators/current-user.decorator';

export interface AuditAnomalyInput {
  hoursBack?: number; // default 24
}

@Injectable()
export class AuditAnomalyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly session: AISessionService,
  ) {}

  async run(user: CurrentUserData, input: AuditAnomalyInput, ip?: string, userAgent?: string) {
    // доступ к AI-анализу журнала действий проверяет контроллер по праву audit.view
    const hours = Math.min(Math.max(input.hoursBack ?? 24, 1), 24 * 30);
    const since = new Date(Date.now() - hours * 3_600_000);

    // Agregates
    const [loginFailures, loginSuccess, recentAudit, ipFrequency] = await Promise.all([
      this.prisma.loginLog.count({ where: { success: false, createdAt: { gte: since } } }),
      this.prisma.loginLog.count({ where: { success: true, createdAt: { gte: since } } }),
      this.prisma.auditLog.findMany({
        where: { createdAt: { gte: since } },
        include: { actor: { select: { loginId: true, role: true } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      this.prisma.loginLog.groupBy({
        by: ['ip'],
        where: { createdAt: { gte: since }, success: false },
        _count: { _all: true },
        orderBy: { _count: { ip: 'desc' } },
        take: 10,
      }),
    ]);

    // Простые эвристики (показываем ИИ уже-детектированные паттерны)
    const topIps = ipFrequency.map((r) => ({ ip: r.ip || '—', failures: r._count._all }));
    const actionsByUser: Record<string, { role: string; count: number }> = {};
    for (const a of recentAudit) {
      const key = a.actor?.loginId || '(unknown)';
      if (!actionsByUser[key]) actionsByUser[key] = { role: a.actor?.role || '?', count: 0 };
      actionsByUser[key].count++;
    }
    const busiestUsers = Object.entries(actionsByUser)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([loginId, v]) => ({ loginId, role: v.role, actions: v.count }));

    const system = [
      'Sən Academic Portalın təhlükəsizlik analitikisən.',
      'Aşağıda son müəyyən saat ərzində audit log və login statistikası var.',
      'Anomaliyaları tap və prioritetləşdir:',
      '- Bir IP-dən çox uğursuz giriş (brute-force)',
      '- Qeyri-adi saatlarda fəallıq (gecə)',
      '- Qeyri-adi həcmdə əməliyyat bir istifadəçidən',
      '- Role escalation cəhdləri',
      'Çıxış — markdown:',
      '- "Kritik", "Orta", "Aşağı" səviyyəli bölmələrə ayır',
      '- Hər punkt üçün: nədir + niyə şübhəlidir + tövsiyə',
      '- Əgər heç nə tapılmırsa — "Anomaliya aşkar edilmədi" yaz.',
    ].join(' ');

    const userMessage = [
      `# Son ${hours} saat`,
      `Uğurlu giriş: ${loginSuccess}, uğursuz: ${loginFailures}`,
      `Audit log qeydləri (ilk 200-dən): ${recentAudit.length}`,
      '',
      '## Ən çox uğursuz girişi olan IP-lər:',
      ...(topIps.length ? topIps.map((i) => `- ${i.ip}: ${i.failures} dəfə`) : ['(yoxdur)']),
      '',
      '## Ən fəal istifadəçilər (audit log üzrə):',
      ...(busiestUsers.length
        ? busiestUsers.map((u) => `- ${u.loginId} (${u.role}): ${u.actions} əməliyyat`)
        : ['(yoxdur)']),
      '',
      '## Son 20 audit qeyd (nümunə):',
      ...recentAudit
        .slice(0, 20)
        .map(
          (a) =>
            `- [${new Date(a.createdAt).toISOString()}] ${a.actor?.loginId || '?'} → ${a.action} ${a.targetType}${a.targetId ? '/' + a.targetId.slice(0, 8) : ''}`,
        ),
    ].join('\n');

    const res = await this.session.runAndLog({
      userId: user.id,
      feature: AIFeature.AUDIT_ANALYSIS,
      title: `Audit anomaly scan (${hours}h)`,
      system,
      userMessage,
      ip,
      userAgent,
      maxTokens: 2200,
    });

    return {
      ...res,
      stats: {
        hours,
        loginSuccess,
        loginFailures,
        topIps,
        busiestUsers,
      },
    };
  }
}
