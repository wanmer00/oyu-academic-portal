import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { NotificationType, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/** Текст на трёх языках; получатель видит вариант по своему preferredLang (fallback: az) */
export type L10n = { az: string; ru: string; en: string };

export interface NotifyInput {
  type: NotificationType;
  title: L10n;
  message: L10n;
  link?: string;
}

const pick = (t: L10n, lang: string) => (t as Record<string, string>)[lang] ?? t.az;

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Чтение: пользователь видит ТОЛЬКО свои уведомления ──
  async list(userId: string, q: { type?: NotificationType; unread?: boolean; take?: number }) {
    const where: Prisma.NotificationWhereInput = { userId };
    if (q.type) where.type = q.type;
    if (q.unread) where.readAt = null;
    const items = await this.prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(q.take ?? 50, 100),
    });
    return {
      items: items.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        message: n.message,
        link: n.link,
        createdAt: n.createdAt.toISOString(),
        readAt: n.readAt ? n.readAt.toISOString() : null,
      })),
      unreadCount: await this.unreadCount(userId),
    };
  }

  unreadCount(userId: string) {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }

  async markRead(userId: string, id: string) {
    const res = await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    if (res.count === 0) {
      const exists = await this.prisma.notification.findFirst({ where: { id, userId }, select: { id: true } });
      if (!exists) throw new NotFoundException('Notification not found');
    }
    return { ok: true, unreadCount: await this.unreadCount(userId) };
  }

  async markAllRead(userId: string) {
    const res = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true, updated: res.count, unreadCount: 0 };
  }

  // ── Создание (вызывается из других модулей; сбой уведомления не ломает основную операцию) ──
  async notify(userIds: string[], input: NotifyInput) {
    const ids = Array.from(new Set(userIds.filter(Boolean)));
    if (!ids.length) return 0;
    try {
      const users = await this.prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, preferredLang: true },
      });
      const res = await this.prisma.notification.createMany({
        data: users.map((u) => ({
          userId: u.id,
          type: input.type,
          title: pick(input.title, u.preferredLang),
          message: pick(input.message, u.preferredLang),
          link: input.link ?? null,
        })),
      });
      return res.count;
    } catch (e) {
      this.logger.warn(`notify failed: ${(e as Error).message}`);
      return 0;
    }
  }

  // ── Получатели ──
  async studentIdsByGroup(groupName: string) {
    const rows = await this.prisma.student.findMany({
      where: { groupName, user: { status: 'ACTIVE' } },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  async studentIdsBySubject(subjectId: string) {
    const groups = await this.prisma.scheduleSlot.findMany({
      where: { subjectId },
      select: { groupName: true },
      distinct: ['groupName'],
    });
    if (!groups.length) return [];
    const rows = await this.prisma.student.findMany({
      where: { groupName: { in: groups.map((g) => g.groupName) }, user: { status: 'ACTIVE' } },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  async userIdsByAudience(audience: 'ALL' | 'STUDENTS' | 'TEACHERS' | 'ADMINS' | 'GROUP', groupName?: string | null) {
    if (audience === 'GROUP') return groupName ? this.studentIdsByGroup(groupName) : [];
    const roleMap: Record<string, Role[] | undefined> = {
      ALL: undefined,
      STUDENTS: [Role.STUDENT],
      TEACHERS: [Role.TEACHER],
      ADMINS: [Role.ADMIN, Role.SUPER_ADMIN],
    };
    const roles = roleMap[audience];
    const rows = await this.prisma.user.findMany({
      where: { status: 'ACTIVE', ...(roles ? { role: { in: roles } } : {}) },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}
