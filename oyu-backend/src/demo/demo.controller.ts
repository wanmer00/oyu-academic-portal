import { Controller, ForbiddenException, Get, Headers, NotFoundException, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { timingSafeEqual } from 'crypto';
import { env } from '../config/env';
import { CurrentUser, CurrentUserData } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RequirePermission } from '../common/rbac/require-permission.decorator';
import { DemoResetService } from './demo-reset.service';

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

@Controller('demo')
export class DemoController {
  constructor(private readonly reset: DemoResetService) {}

  /** Публичная информация: это демо-стенд (для баннера и мониторинга) */
  @Public()
  @Get('status')
  status() {
    return { demo: env.DEMO_MODE };
  }

  /**
   * Сброс демо-базы. Доступен только владельцу инфраструктуры: DEMO_MODE=true, роль SUPER_ADMIN
   * и секрет из окружения (DEMO_RESET_TOKEN) в заголовке X-Demo-Reset-Token. Публичный SUPER_ADMIN-аккаунт демо
   * этот секрет не знает, поэтому посетитель сбросить базу не может.
   */
  @Post('reset')
  @RequirePermission('settings.update')
  async doReset(@CurrentUser() user: CurrentUserData, @Headers('x-demo-reset-token') token?: string) {
    if (!env.DEMO_MODE) throw new NotFoundException();
    if (user.role !== Role.SUPER_ADMIN) throw new ForbiddenException({ message: 'Only the owner can reset the demo', code: 'DEMO_RESET_FORBIDDEN' });
    if (!env.DEMO_RESET_TOKEN) throw new ForbiddenException({ message: 'Demo reset is not enabled on this deployment', code: 'DEMO_RESET_DISABLED' });
    if (!token || !same(token, env.DEMO_RESET_TOKEN)) throw new ForbiddenException({ message: 'Invalid reset token', code: 'DEMO_RESET_FORBIDDEN' });
    return this.reset.reset();
  }
}