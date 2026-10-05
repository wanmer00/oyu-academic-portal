import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { env } from '../../../config/env';
import { CurrentUser, CurrentUserData } from '../../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermission } from '../../../common/rbac/require-permission.decorator';
import { AssistantService } from './assistant.service';
import { AIUser } from './ai-context.service';
import { ALL_TOPICS_BY_ROLE, Topic, personaOf } from './topics';

const ALL_TOPICS = Array.from(new Set(Object.values(ALL_TOPICS_BY_ROLE).flat())) as [Topic, ...Topic[]];

const AskSchema = z
  .object({
    message: z.string().trim().min(1).max(1000),
    sessionId: z.string().max(40).nullish().transform((v) => v ?? undefined),
    lang: z.enum(['az', 'ru', 'en']).default('az'),
  })
  .strict();

const ActionSchema = z
  .object({
    topic: z.enum(ALL_TOPICS), // существует ли тема — проверяет zod; принадлежит ли она роли — сервис (403)
    sessionId: z.string().max(40).nullish().transform((v) => v ?? undefined),
    lang: z.enum(['az', 'ru', 'en']).default('az'),
  })
  .strict();

const toAI = (u: CurrentUserData): AIUser => ({ id: u.id, loginId: u.loginId, role: personaOf(u.role), fullName: u.fullName });
const meta = (req: Request) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

// Доступно любой роли (JwtAuthGuard глобальный). Роль и userId берутся ТОЛЬКО из JWT, а не из тела запроса.
@Controller('ai/assistant')
@RequirePermission('ai.use')
@Throttle({ default: { limit: env.RATE_LIMIT_AI_MAX, ttl: 60_000 } })
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Get('config')
  config(@CurrentUser() user: CurrentUserData) {
    return this.assistant.config(toAI(user));
  }

  @Post('ask')
  ask(@CurrentUser() user: CurrentUserData, @Body(new ZodValidationPipe(AskSchema)) dto: z.infer<typeof AskSchema>, @Req() req: Request) {
    return this.assistant.ask(toAI(user), dto.message, dto.lang, dto.sessionId, meta(req));
  }

  @Post('action')
  action(@CurrentUser() user: CurrentUserData, @Body(new ZodValidationPipe(ActionSchema)) dto: z.infer<typeof ActionSchema>, @Req() req: Request) {
    return this.assistant.action(toAI(user), dto.topic, dto.lang, dto.sessionId, meta(req));
  }
}
