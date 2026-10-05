import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { Request } from 'express';

import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/rbac/require-permission.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AnnouncementsService } from './announcements.service';
import { CreateAnnouncementDto, CreateAnnouncementSchema, UpdateAnnouncementDto, UpdateAnnouncementSchema } from './dto';

@Controller('me/announcements')
@RequirePermission('announcements.view')
export class MyAnnouncementsController {
  constructor(private readonly svc: AnnouncementsService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserData) {
    return this.svc.listForUser(user.id);
  }

  @Get('unread')
  unread(@CurrentUser() user: CurrentUserData) {
    return this.svc.unreadCount(user.id);
  }

  @Post(':id/read')
  markRead(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.svc.markRead(user.id, id);
  }
}

@Controller('admin/announcements')
@RequirePermission('announcements.manage', { requireAll: true })
export class AdminAnnouncementsController {
  constructor(private readonly svc: AnnouncementsService) {}

  @Get()
  listAll() {
    return this.svc.listAll();
  }

  @Post()
  create(
    @CurrentUser() user: CurrentUserData,
    @Body(new ZodValidationPipe(CreateAnnouncementSchema)) dto: CreateAnnouncementDto,
    @Req() req: Request,
  ) {
    return this.svc.create(user.id, dto, { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null });
  }

  @Patch(':id')
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateAnnouncementSchema)) dto: UpdateAnnouncementDto,
  ) {
    return this.svc.update(user.id, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.svc.delete(user.id, id);
  }
}
