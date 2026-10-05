import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AIFeature, PermissionScope, RequestType } from '@prisma/client';
import { RequirePermission } from '../../common/rbac/require-permission.decorator';
import {
  CurrentUser,
  CurrentUserData,
} from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AISessionService } from './ai-session.service';
import { GpaWhatIfService } from './features/gpa-whatif.service';
import { RequestDrafterService } from './features/request-drafter.service';
import { TranslateService } from './features/translate.service';
import { MaterialSearchService } from './features/material-search.service';
import { QuestionGenService } from './features/question-gen.service';
import { DropoutRiskService } from './features/dropout-risk.service';
import { AuditAnomalyService } from './features/audit-anomaly.service';

const gpaSchema = z.object({
  forecast: z.record(z.number().min(0).max(100)),
  note: z.string().max(1000).optional(),
});

const requestSchema = z.object({
  type: z.nativeEnum(RequestType),
  note: z.string().max(2000).optional(),
  subjectCode: z.string().max(30).optional(),
});

const translateSchema = z.object({
  text: z.string().min(1).max(5000),
  source: z.enum(['az', 'en', 'ru']),
});

const searchSchema = z.object({
  query: z.string().min(2).max(400),
  subjectCode: z.string().max(30).optional(),
});

const questionSchema = z.object({
  subjectCode: z.string().min(2).max(30),
  count: z.number().int().min(5).max(50).optional(),
  types: z.array(z.enum(['mcq', 'short', 'essay'])).optional(),
  difficulty: z.enum(['easy', 'medium', 'hard', 'mixed']).optional(),
  topic: z.string().max(200).optional(),
});

const dropoutSchema = z.object({
  minRiskScore: z.number().min(0).max(100).optional(),
  focusCourse: z.number().int().min(1).max(6).optional(),
});

const anomalySchema = z.object({
  hoursBack: z.number().int().min(1).max(720).optional(),
});

const chatSchema = z.object({
  sessionId: z.string().nullish().transform((v) => v ?? undefined),
  message: z.string().min(1).max(4000),
});

@Controller('ai')
@RequirePermission('ai.use')
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class AIController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly session: AISessionService,
    private readonly gpa: GpaWhatIfService,
    private readonly requestDrafter: RequestDrafterService,
    private readonly translate: TranslateService,
    private readonly materialSearch: MaterialSearchService,
    private readonly questionGen: QuestionGenService,
    private readonly dropoutRisk: DropoutRiskService,
    private readonly auditAnomaly: AuditAnomalyService,
  ) {}

  // ── STUDENT ──
  @Post('gpa-whatif')
  @RequirePermission('ai.use', { scopes: [PermissionScope.OWN] })
  async gpaWhatif(
    @CurrentUser() user: CurrentUserData,
    @Body() body: unknown,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    const input = gpaSchema.parse(body);
    return this.gpa.run(user, input, ip, req.headers['user-agent']);
  }

  @Post('request-draft')
  @RequirePermission('ai.use', { scopes: [PermissionScope.OWN] })
  async draftRequest(
    @CurrentUser() user: CurrentUserData,
    @Body() body: unknown,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    const input = requestSchema.parse(body);
    return this.requestDrafter.run(user, input, ip, req.headers['user-agent']);
  }

  @Post('material-search')
  @RequirePermission('ai.use', { scopes: [PermissionScope.OWN] })
  async search(
    @CurrentUser() user: CurrentUserData,
    @Body() body: unknown,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    const input = searchSchema.parse(body);
    return this.materialSearch.run(user, input, ip, req.headers['user-agent']);
  }

  // ── преподаватель / администратор (scope ASSIGNED или ALL) ──
  @Post('question-gen')
  @RequirePermission('ai.use', { scopes: [PermissionScope.ASSIGNED, PermissionScope.ALL] })
  async questions(
    @CurrentUser() user: CurrentUserData,
    @Body() body: unknown,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    const input = questionSchema.parse(body);
    return this.questionGen.run(user, input, ip, req.headers['user-agent']);
  }

  // ── аналитика отчислений: reports.view на все данные ──
  @Post('dropout-risk')
  @RequirePermission('reports.view', { requireAll: true })
  async dropout(
    @CurrentUser() user: CurrentUserData,
    @Body() body: unknown,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    const input = dropoutSchema.parse(body);
    return this.dropoutRisk.run(user, input, ip, req.headers['user-agent']);
  }

  // ── TRANSLATE (сотрудники: не студенческий scope OWN) ──
  @Post('translate')
  @RequirePermission('ai.use', { scopes: [PermissionScope.ASSIGNED, PermissionScope.ALL] })
  async tr(
    @CurrentUser() user: CurrentUserData,
    @Body() body: unknown,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    const input = translateSchema.parse(body);
    return this.translate.run(user, input, ip, req.headers['user-agent']);
  }

  // ── AI-анализ журнала действий: audit.view ──
  @Post('audit-anomaly')
  @RequirePermission('audit.view', { requireAll: true })
  async anomaly(
    @CurrentUser() user: CurrentUserData,
    @Body() body: unknown,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    const input = anomalySchema.parse(body);
    return this.auditAnomaly.run(user, input, ip, req.headers['user-agent']);
  }

  // ── TUTOR CHAT — свободный диалог с AI (все роли) ──
  @Post('chat')
  async chat(
    @CurrentUser() user: CurrentUserData,
    @Body() body: unknown,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    const input = chatSchema.parse(body);

    // Подтянуть историю если есть sessionId
    let prior: { role: 'user' | 'assistant'; content: string }[] = [];
    if (input.sessionId) {
      const h = await this.session.loadHistory(input.sessionId, user.id, 30);
      if (h) prior = h.prior;
    }

    // Контекст-осведомлённая system-prompt
    const roleLabel = ({ STUDENT: 'tələbə', TEACHER: 'müəllim', ADMIN: 'administrator', SUPER_ADMIN: 'baş administrator' } as Record<string, string>)[user.role] || user.role;
    const system = [
      'Sən Academic Portal universitet sisteminin AI-assistentisən.',
      `Hazırkı istifadəçi: ${user.fullName || ''} (${roleLabel}, Login ID: ${user.loginId}).`,
      'Cavabları Azərbaycan dilində ver, əgər istifadəçi rus və ya ingilis dilində yazırsa — həmin dildə cavab ver.',
      'Azərbaycan dilini latinə (ə→e, ö→o, ü→u, ç→c, ş→s, ğ→g, ı→i) və orfoqrafik səhvlərlə də başa düş.',
      'İstifadəçinin rolu ilə məhdudlaşan mövzularda kömək et: qiymətlər, cədvəl, tapşırıqlar, davamiyyət, GPA, materiallar, müraciətlər.',
      'Qısa və konkret cavab ver (2-6 cümlə). Zəruri yerdə Markdown istifadə et (**bold**, `code`).',
      'Real şəxsi məlumatları, şifrələri və ya həssas sistem konfiqurasiyasını verme.',
    ].join(' ');

    const result = await this.session.runAndLog({
      userId: user.id,
      feature: AIFeature.TUTOR_CHAT,
      sessionId: input.sessionId,
      title: input.sessionId ? undefined : input.message.slice(0, 80),
      system,
      userMessage: input.message,
      priorMessages: prior,
      ip,
      userAgent: req.headers['user-agent'],
      temperature: 0.5,
    });

    return {
      sessionId: result.sessionId,
      text: result.text,
      stub: result.stub,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      latencyMs: result.latencyMs,
    };
  }

  // ── История собственных сессий (любая роль видит СВОИ) ──
  @Get('my-sessions')
  async mySessions(@CurrentUser() user: CurrentUserData) {
    const items = await this.prisma.aIChatSession.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        feature: true,
        title: true,
        totalTokens: true,
        flagged: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return { items };
  }

  @Get('my-sessions/:id')
  async mySession(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    const item = await this.prisma.aIChatSession.findFirst({
      where: { id, userId: user.id },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!item) return { item: null };
    return { item };
  }
}
