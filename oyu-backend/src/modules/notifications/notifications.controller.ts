import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { NotificationType } from '@prisma/client';
import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';

const listQuery = z.object({
  type: z.nativeEnum(NotificationType).optional(),
  unread: z.enum(['true', 'false']).optional(),
  take: z.coerce.number().int().min(1).max(100).optional(),
});

// Доступно всем ролям, но каждый видит только СВОИ уведомления (userId берётся из JWT)
@Controller('me/notifications')
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserData, @Query() query: unknown) {
    const q = listQuery.parse(query);
    return this.svc.list(user.id, { type: q.type, unread: q.unread === 'true', take: q.take });
  }

  @Get('unread-count')
  async unread(@CurrentUser() user: CurrentUserData) {
    return { count: await this.svc.unreadCount(user.id) };
  }

  @Post('read-all')
  readAll(@CurrentUser() user: CurrentUserData) {
    return this.svc.markAllRead(user.id);
  }

  @Post(':id/read')
  read(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.svc.markRead(user.id, id);
  }
}
