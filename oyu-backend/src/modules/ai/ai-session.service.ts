import { Injectable, Logger } from '@nestjs/common';
import { AIFeature } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ClaudeService, ClaudeCallInput, ClaudeCallResult } from './claude.service';

export interface LogAICallInput {
  userId: string;
  feature: AIFeature;
  sessionId?: string;
  title?: string;
  system?: string;
  userMessage: string;
  priorMessages?: { role: 'user' | 'assistant'; content: string }[];
  maxTokens?: number;
  temperature?: number;
  ip?: string;
  userAgent?: string;
  meta?: Record<string, unknown>;
}

export interface LogAICallOutput {
  sessionId: string;
  text: string;
  stub: boolean;
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

/**
 * Все AI-запросы идут через этот сервис:
 * создаёт/продолжает AIChatSession, логирует оба сообщения (user + assistant)
 * в AIChatMessage, обновляет счётчики. IT-аудитор видит ВСЁ.
 */
@Injectable()
export class AISessionService {
  private readonly logger = new Logger(AISessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly claude: ClaudeService,
  ) {}

  async runAndLog(input: LogAICallInput): Promise<LogAICallOutput> {
    // 1. Создать или получить сессию
    let session = input.sessionId
      ? await this.prisma.aIChatSession.findFirst({
          where: { id: input.sessionId, userId: input.userId },
        })
      : null;

    if (!session) {
      session = await this.prisma.aIChatSession.create({
        data: {
          userId: input.userId,
          feature: input.feature,
          title: input.title || input.userMessage.slice(0, 100),
          ip: input.ip,
          userAgent: input.userAgent,
        },
      });
    }

    // 2. Залогировать пользовательский запрос
    await this.prisma.aIChatMessage.create({
      data: { sessionId: session.id, role: 'user', content: input.userMessage },
    });

    // 3. Сконструировать messages и вызвать Claude
    const messages: ClaudeCallInput['messages'] = [
      ...(input.priorMessages || []),
      { role: 'user', content: input.userMessage },
    ];
    const result: ClaudeCallResult = await this.claude.call({
      system: input.system,
      messages,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
    });

    // 4. Залогировать ответ ассистента
    await this.prisma.aIChatMessage.create({
      data: {
        sessionId: session.id,
        role: 'assistant',
        content: result.text,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        model: result.model,
        stub: result.stub,
        latencyMs: result.latencyMs,
      },
    });

    // 5. Обновить счётчики и — для GPA/translate/etc — авто-флаг если подозрительно
    const flagReason = this.autoFlagReason(input, result);
    await this.prisma.aIChatSession.update({
      where: { id: session.id },
      data: {
        totalTokens: { increment: result.tokensIn + result.tokensOut },
        costUsdMilli: { increment: this.estimateCostMilli(result.tokensIn, result.tokensOut) },
        ...(flagReason && !session.flagged ? { flagged: true, flagReason, flaggedAt: new Date() } : {}),
      },
    });

    return {
      sessionId: session.id,
      text: result.text,
      stub: result.stub,
      model: result.model,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      latencyMs: result.latencyMs,
    };
  }

  /** Логирует обмен без вызова модели (ответ собран из данных). Сессия/сообщения — как у runAndLog. */
  async logExchange(input: { userId: string; feature: AIFeature; sessionId?: string; title?: string; userMessage: string; assistantText: string; ip?: string; userAgent?: string }): Promise<string> {
    let session = input.sessionId
      ? await this.prisma.aIChatSession.findFirst({ where: { id: input.sessionId, userId: input.userId } })
      : null;
    if (!session) {
      session = await this.prisma.aIChatSession.create({
        data: { userId: input.userId, feature: input.feature, title: input.title || input.userMessage.slice(0, 100), ip: input.ip, userAgent: input.userAgent },
      });
    }
    await this.prisma.aIChatMessage.createMany({
      data: [
        { sessionId: session.id, role: 'user', content: input.userMessage },
        { sessionId: session.id, role: 'assistant', content: input.assistantText, stub: false, model: 'data-engine' },
      ],
    });
    await this.prisma.aIChatSession.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
    return session.id;
  }

  /**
   * Авто-детектор подозрительных разговоров для IT-аудитора.
   * Простые эвристики (в будущем — отдельный Claude-классификатор).
   */
  private autoFlagReason(input: LogAICallInput, result: ClaudeCallResult): string | null {
    const text = (input.userMessage + ' ' + result.text).toLowerCase();
    // jailbreak / prompt-injection попытки
    if (/ignore (all|prior|previous) instructions|act as|jailbreak|sudo|override your/i.test(text)) {
      return 'possible prompt-injection';
    }
    // утечка PII
    if (/\b\d{7,}\b.*(password|şifrə|пароль)/i.test(text)) {
      return 'potential PII leak';
    }
    // массивный промпт
    if (input.userMessage.length > 5000) {
      return 'oversized prompt (possible abuse)';
    }
    return null;
  }

  /** Грубая оценка стоимости в тысячных долларах. */
  private estimateCostMilli(tokensIn: number, tokensOut: number): number {
    // Claude Sonnet 4.5: ~$3/Mtok input, $15/Mtok output
    const inUsd = (tokensIn / 1_000_000) * 3;
    const outUsd = (tokensOut / 1_000_000) * 15;
    return Math.round((inUsd + outUsd) * 1000);
  }

  /** Для тьютор-режима: подтянуть историю диалога. */
  async loadHistory(sessionId: string, userId: string, limit = 20) {
    const session = await this.prisma.aIChatSession.findFirst({
      where: { id: sessionId, userId },
      include: {
        messages: { orderBy: { createdAt: 'asc' }, take: limit },
      },
    });
    if (!session) return null;
    const prior = session.messages.map((m) => ({
      role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.content,
    }));
    return { session, prior };
  }
}
