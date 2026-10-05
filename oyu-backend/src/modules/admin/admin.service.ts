import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RequestStatus, RequestType } from '@prisma/client';

interface AuditCtx { ip?: string | null; userAgent?: string | null }

export const ADMIN_REQUEST_TYPES: RequestType[] = [RequestType.CERTIFICATE, RequestType.TRANSFER, RequestType.OTHER];
// PENDING → решение; решение можно вернуть на пересмотр (PENDING), но не перескочить APPROVED ↔ REJECTED напрямую
export const REQUEST_TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  PENDING: [RequestStatus.APPROVED, RequestStatus.REJECTED],
  APPROVED: [RequestStatus.PENDING],
  REJECTED: [RequestStatus.PENDING],
  // статусы апелляций по экзамену — меняются только workflow апелляции (requests/appeals.service)
  UNDER_REVIEW: [],
  PARTIALLY_APPROVED: [],
  WITHDRAWN: [],
};
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { CreateRoomDto, UpdateRoomDto } from './dto';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async listRequests(status?: RequestStatus, type?: RequestType, scope: 'admin' | 'all' = 'admin', groups: string[] | null = null) {
    const where: Prisma.RequestWhereInput = groups ? { user: { student: { groupName: { in: groups } } } } : {};
    if (status) where.status = status;
    if (type) where.type = type;
    else if (scope === 'admin') where.type = { in: ADMIN_REQUEST_TYPES };
    const items = await this.prisma.request.findMany({
      where,
      include: { user: { select: { loginId: true, fullName: true, role: true, student: { select: { groupName: true } } } }, examAppeal: { select: { id: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return items.map(({ examAppeal, ...r }) => ({
      ...r,
      isExamAppeal: !!examAppeal,
      editable: ADMIN_REQUEST_TYPES.includes(r.type),
      allowedStatuses: ADMIN_REQUEST_TYPES.includes(r.type) ? REQUEST_TRANSITIONS[r.status] : [],
    }));
  }

  /**
   * Руководство меняет только административные заявки (CERTIFICATE / TRANSFER / OTHER)
   * и только по разрешённым переходам. Апелляции (APPEAL) решает преподаватель — здесь read-only.
   */
  async updateRequestStatus(id: string, status: RequestStatus, adminNote: string | undefined, actorId: string, audit: AuditCtx, groups: string[] | null = null) {
    const req = await this.prisma.request.findUnique({ where: { id }, include: { user: { select: { student: { select: { groupName: true } } } } } });
    if (!req) throw new NotFoundException('Request not found');
    // руководство с ограниченной областью решает только заявки студентов своих групп (как и видит в списке)
    if (groups && !groups.includes(req.user.student?.groupName ?? '')) {
      throw new ForbiddenException({ message: 'Outside your area of responsibility', code: 'ORG_SCOPE_DENIED' });
    }
    if (!ADMIN_REQUEST_TYPES.includes(req.type)) {
      throw new ForbiddenException('This request type is handled by the teacher');
    }
    if (!REQUEST_TRANSITIONS[req.status].includes(status)) {
      throw new BadRequestException(`Status transition ${req.status} → ${status} is not allowed`);
    }
    const updated = await this.prisma.request.update({
      where: { id },
      data: { status, adminNote: adminNote ?? null },
    });
    await this.prisma.auditLog.create({
      data: {
        actorId, action: 'request.status_change', targetType: 'Request', targetId: id,
        diff: { type: req.type, from: req.status, to: status, hasNote: !!adminNote },
        ip: audit.ip ?? null, userAgent: audit.userAgent ?? null,
      },
    });
    await this.notifications.notify([updated.userId], {
      type: 'REQUEST',
      title: { az: 'Müraciətin statusu dəyişdi', ru: 'Статус заявки изменён', en: 'Request status updated' },
      message: {
        az: `Status: ${updated.status}${updated.adminNote ? ' — ' + updated.adminNote : ''}`,
        ru: `Статус: ${updated.status}${updated.adminNote ? ' — ' + updated.adminNote : ''}`,
        en: `Status: ${updated.status}${updated.adminNote ? ' — ' + updated.adminNote : ''}`,
      },
      link: 'requests',
    });
    return updated;
  }

  // ───── Rooms ─────
  private async log(actorId: string, action: string, targetType: string, targetId: string | null, diff: Prisma.InputJsonValue, audit: AuditCtx) {
    await this.prisma.auditLog.create({
      data: { actorId, action, targetType, targetId, diff, ip: audit.ip ?? null, userAgent: audit.userAgent ?? null },
    });
  }

  private minutes(t: string) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }

  /** Комнаты + загрузка: занятия в неделю, часы, максимальная группа (для проверки вместимости) */
  async listRooms() {
    const [rooms, slots, groupSizes] = await Promise.all([
      this.prisma.room.findMany({ orderBy: { code: 'asc' } }),
      this.prisma.scheduleSlot.findMany({ where: { roomId: { not: null } }, select: { roomId: true, startTime: true, endTime: true, groupName: true, weekParity: true } }),
      this.prisma.student.groupBy({ by: ['groupName'], _count: { _all: true } }),
    ]);
    const size = new Map(groupSizes.map((g) => [g.groupName, g._count._all]));
    return rooms.map((r) => {
      const mine = slots.filter((s) => s.roomId === r.id);
      const hours = mine.reduce((a, s) => a + (this.minutes(s.endTime) - this.minutes(s.startTime)) / 60 * (s.weekParity === 'BOTH' ? 1 : 0.5), 0);
      const maxGroup = mine.reduce((a, s) => Math.max(a, size.get(s.groupName) ?? 0), 0);
      return { ...r, usage: { slots: mine.length, hoursPerWeek: Math.round(hours * 10) / 10, maxGroupSize: maxGroup, overCapacity: maxGroup > r.capacity } };
    });
  }

  async createRoom(dto: CreateRoomDto, actorId: string, audit: AuditCtx) {
    const exists = await this.prisma.room.findUnique({ where: { code: dto.code } });
    if (exists) throw new ConflictException('Room code already exists');
    const room = await this.prisma.room.create({ data: dto });
    await this.log(actorId, 'room.create', 'Room', room.id, { code: room.code, capacity: room.capacity }, audit);
    return room;
  }

  async updateRoom(id: string, dto: UpdateRoomDto, actorId: string, audit: AuditCtx) {
    const existing = await this.prisma.room.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Room not found');
    const room = await this.prisma.room.update({ where: { id }, data: dto });
    await this.log(actorId, 'room.update', 'Room', id, { code: room.code, fields: Object.keys(dto) }, audit);
    return room;
  }

  async deleteRoom(id: string, actorId: string, audit: AuditCtx) {
    const room = await this.prisma.room.findUnique({ where: { id } });
    if (!room) throw new NotFoundException('Room not found');
    const usage = (await this.prisma.scheduleSlot.count({ where: { roomId: id } })) + (await this.prisma.scheduleLesson.count({ where: { roomId: id } }));
    if (usage > 0) throw new ConflictException({ message: 'Room is used in schedule', slots: usage, code: 'ROOM_IN_USE' });
    await this.prisma.room.delete({ where: { id } });
    await this.log(actorId, 'room.delete', 'Room', id, { code: room.code }, audit);
    return { ok: true };
  }
}
