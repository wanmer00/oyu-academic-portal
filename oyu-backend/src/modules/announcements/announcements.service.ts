import { Injectable, NotFoundException } from '@nestjs/common';
import { AnnouncementAudience, Role } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { CreateAnnouncementDto, UpdateAnnouncementDto } from './dto';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class AnnouncementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Список для пользователя — фильтрация по аудитории + группе ──
  async listForUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { student: true },
    });
    if (!user) return [];

    const or: any[] = [{ audience: AnnouncementAudience.ALL }];
    if (user.role === Role.STUDENT) {
      or.push({ audience: AnnouncementAudience.STUDENTS });
      if (user.student) or.push({ audience: AnnouncementAudience.GROUP, groupName: user.student.groupName });
    }
    if (user.role === Role.TEACHER) or.push({ audience: AnnouncementAudience.TEACHERS });
    if (user.role === Role.ADMIN || user.role === Role.SUPER_ADMIN) or.push({ audience: AnnouncementAudience.ADMINS });
    const items = await this.prisma.announcement.findMany({
      where: { OR: or },
      include: { reads: { where: { userId } } },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });
    return items.map((a) => ({
      id: a.id,
      title: a.title,
      body: a.body,
      audience: a.audience,
      groupName: a.groupName,
      priority: a.priority,
      pinned: a.pinned,
      createdAt: a.createdAt.toISOString(),
      isRead: a.reads.length > 0,
    }));
  }

  async markRead(userId: string, id: string) {
    const visible = (await this.listForUser(userId)).some((a) => a.id === id);
    if (!visible) throw new NotFoundException('Announcement not found');
    return this.prisma.announcementRead.upsert({
      where: { announcementId_userId: { announcementId: id, userId } },
      update: {},
      create: { announcementId: id, userId },
    });
  }

  async unreadCount(userId: string) {
    const all = await this.listForUser(userId);
    return { count: all.filter((a) => !a.isRead).length };
  }

  // ── Admin Panel ──
  async listAll() {
    return this.prisma.announcement.findMany({
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
  }

  async create(actorId: string, dto: CreateAnnouncementDto, audit: { ip?: string | null; userAgent?: string | null }) {
    const created = await this.prisma.announcement.create({
      data: {
        title: dto.title,
        body: dto.body,
        audience: dto.audience,
        groupName: dto.groupName ?? null,
        priority: dto.priority,
        pinned: dto.pinned,
        createdBy: actorId,
      },
    });
    await this.prisma.auditLog.create({
      data: {
        actorId,
        action: 'announcement.create',
        targetType: 'Announcement',
        targetId: created.id,
        diff: { title: dto.title, audience: dto.audience, priority: dto.priority },
        ip: audit.ip ?? null,
        userAgent: audit.userAgent ?? null,
      },
    });
    const recipients = await this.notifications.userIdsByAudience(dto.audience, dto.groupName);
    await this.notifications.notify(recipients, {
      type: 'ADMINISTRATIVE',
      title: { az: `Yeni elan: ${dto.title}`, ru: `Новое объявление: ${dto.title}`, en: `New announcement: ${dto.title}` },
      message: {
        az: dto.body.slice(0, 200),
        ru: dto.body.slice(0, 200),
        en: dto.body.slice(0, 200),
      },
      link: 'announcements',
    });
    return created;
  }

  async update(actorId: string, id: string, dto: UpdateAnnouncementDto) {
    const existing = await this.prisma.announcement.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Announcement not found');
    return this.prisma.announcement.update({
      where: { id },
      data: {
        ...(dto.title && { title: dto.title }),
        ...(dto.body && { body: dto.body }),
        ...(dto.audience && { audience: dto.audience }),
        ...('groupName' in dto && { groupName: dto.groupName ?? null }),
        ...(dto.priority && { priority: dto.priority }),
        ...('pinned' in dto && { pinned: dto.pinned }),
      },
    });
  }

  async delete(actorId: string, id: string) {
    await this.prisma.announcement.delete({ where: { id } });
    await this.prisma.auditLog.create({
      data: { actorId, action: 'announcement.delete', targetType: 'Announcement', targetId: id },
    });
    return { ok: true };
  }
}
