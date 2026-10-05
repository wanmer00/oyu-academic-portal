import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { CheckEventDto, CreateEventDto, UpdateEventDto } from './dto';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class CalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Список для любого пользователя: общие + специфичные для группы (если студент) ──
  async listForUser(userId: string, from?: string, to?: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { student: true },
    });
    if (!user) return [];

    const where: any = {};
    // Сотрудники — только общие (groupName=null); студент — общие + своей группы
    if (user.role === Role.STUDENT && user.student) {
      where.OR = [{ groupName: null }, { groupName: user.student.groupName }];
    } else {
      where.groupName = null;
    }

    if (from || to) {
      where.AND = [];
      if (from) where.AND.push({ eventDate: { gte: new Date(from) } });
      if (to)   where.AND.push({ eventDate: { lte: new Date(to) } });
    }

    return this.prisma.calendarEvent.findMany({
      where,
      orderBy: { eventDate: 'asc' },
      take: 300,
    });
  }

  // ── Admin Panel: все события ──
  async listAll(from?: string, to?: string) {
    const where: any = {};
    if (from || to) {
      where.AND = [];
      if (from) where.AND.push({ eventDate: { gte: new Date(from) } });
      if (to)   where.AND.push({ eventDate: { lte: new Date(to) } });
    }
    return this.prisma.calendarEvent.findMany({
      where,
      orderBy: { eventDate: 'asc' },
      take: 500,
    });
  }

  // ─── Конфликты ───
  // Проверяется то, что реально хранится в модели:
  //  ROOM_EVENT   — другое событие в той же аудитории, пересекающееся по датам и времени (блокирует)
  //  ROOM_CLASS   — регулярное занятие в этой аудитории в этот день недели и время (блокирует, если не allowScheduleOverlap)
  //  GROUP_CLASS  — у группы в это время занятие (предупреждение)
  //  GROUP_EVENT  — у группы в этот день уже есть событие (предупреждение)
  async findConflicts(ev: {
    eventDate: Date; endDate: Date | null; startTime: string | null; endTime: string | null;
    roomCode: string | null; groupName: string | null;
  }, excludeId?: string) {
    const blocking: Array<Record<string, unknown>> = [];
    const warnings: Array<Record<string, unknown>> = [];
    const start = new Date(ev.eventDate); start.setUTCHours(0, 0, 0, 0);
    const end = new Date(ev.endDate ?? ev.eventDate); end.setUTCHours(23, 59, 59, 999);
    const timesOverlap = (s1?: string | null, e1?: string | null, s2?: string | null, e2?: string | null) =>
      !s1 || !e1 || !s2 || !e2 ? true : s1 < e2 && s2 < e1; // событие без времени = весь день

    const others = await this.prisma.calendarEvent.findMany({
      where: {
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
        eventDate: { lte: end },
        OR: [{ endDate: { gte: start } }, { endDate: null, eventDate: { gte: start } }],
      },
      select: { id: true, title: true, type: true, eventDate: true, startTime: true, endTime: true, roomCode: true, groupName: true },
    });
    for (const o of others) {
      if (ev.roomCode && o.roomCode === ev.roomCode && timesOverlap(ev.startTime, ev.endTime, o.startTime, o.endTime)) {
        blocking.push({ kind: 'ROOM_EVENT', id: o.id, title: o.title, date: o.eventDate.toISOString().slice(0, 10), startTime: o.startTime, endTime: o.endTime, roomCode: o.roomCode });
      } else if (ev.groupName && o.groupName === ev.groupName && timesOverlap(ev.startTime, ev.endTime, o.startTime, o.endTime)) {
        warnings.push({ kind: 'GROUP_EVENT', id: o.id, title: o.title, date: o.eventDate.toISOString().slice(0, 10) });
      }
    }

    // Регулярные занятия — по дням недели внутри периода события (максимум 7 разных дней)
    const days = new Set<number>();
    for (let t = start.getTime(); t <= end.getTime() && days.size < 7; t += 86_400_000) days.add(new Date(t).getUTCDay() || 7);
    if ((ev.roomCode || ev.groupName) && days.size) {
      const slots = await this.prisma.scheduleSlot.findMany({
        where: {
          dayOfWeek: { in: Array.from(days) },
          OR: [...(ev.roomCode ? [{ room: ev.roomCode }] : []), ...(ev.groupName ? [{ groupName: ev.groupName }] : [])],
        },
        include: { subject: { select: { code: true } } },
      });
      for (const s of slots) {
        if (!timesOverlap(ev.startTime, ev.endTime, s.startTime, s.endTime)) continue;
        const info = { kind: '', slotId: s.id, subject: s.subject.code, groupName: s.groupName, dayOfWeek: s.dayOfWeek, startTime: s.startTime, endTime: s.endTime, roomCode: s.room, weekParity: s.weekParity };
        if (ev.roomCode && s.room === ev.roomCode) blocking.push({ ...info, kind: 'ROOM_CLASS' });
        else if (ev.groupName && s.groupName === ev.groupName) warnings.push({ ...info, kind: 'GROUP_CLASS' });
      }
    }
    return { blocking, warnings };
  }

  private async resolveAndCheck(
    merged: { eventDate: Date; endDate: Date | null; startTime: string | null; endTime: string | null; roomCode: string | null; groupName: string | null },
    allowScheduleOverlap: boolean | undefined,
    excludeId?: string,
  ) {
    if (merged.roomCode) {
      const room = await this.prisma.room.findUnique({ where: { code: merged.roomCode } });
      if (!room) throw new NotFoundException('Room not found: ' + merged.roomCode);
    }
    if (merged.groupName) {
      const n = await this.prisma.student.count({ where: { groupName: merged.groupName } });
      if (!n) throw new NotFoundException('Group not found: ' + merged.groupName);
    }
    const c = await this.findConflicts(merged, excludeId);
    const hard = c.blocking.filter((b) => b.kind === 'ROOM_EVENT' || (b.kind === 'ROOM_CLASS' && !allowScheduleOverlap));
    if (hard.length) throw new ConflictException({ message: 'Calendar conflicts detected', conflicts: hard, warnings: c.warnings });
    return c;
  }

  async check(dto: CheckEventDto) {
    const merged = {
      eventDate: new Date(dto.eventDate), endDate: dto.endDate ? new Date(dto.endDate) : null,
      startTime: dto.startTime ?? null, endTime: dto.endTime ?? null, roomCode: dto.roomCode || null, groupName: dto.groupName || null,
    };
    return this.findConflicts(merged, dto.excludeId);
  }

  async create(actorId: string, dto: CreateEventDto, audit: { ip?: string | null; userAgent?: string | null }) {
    const merged = {
      eventDate: new Date(dto.eventDate), endDate: dto.endDate ? new Date(dto.endDate) : null,
      startTime: dto.startTime ?? null, endTime: dto.endTime ?? null, roomCode: dto.roomCode || null, groupName: dto.groupName || null,
    };
    const conflicts = await this.resolveAndCheck(merged, dto.allowScheduleOverlap);
    const created = await this.prisma.calendarEvent.create({
      data: {
        eventDate: merged.eventDate,
        endDate: merged.endDate,
        type: dto.type,
        title: dto.title,
        description: dto.description ?? null,
        groupName: merged.groupName,
        level: dto.level ?? null,
        startTime: merged.startTime,
        endTime: merged.endTime,
        roomCode: merged.roomCode,
        createdBy: actorId,
      },
    });
    await this.prisma.auditLog.create({
      data: {
        actorId,
        action: 'calendar.create',
        targetType: 'CalendarEvent',
        targetId: created.id,
        diff: { type: dto.type, title: dto.title, date: dto.eventDate, room: merged.roomCode, overlapsClass: conflicts.blocking.length > 0 },
        ip: audit.ip ?? null,
        userAgent: audit.userAgent ?? null,
      },
    });
    const recipients = await this.notifications.userIdsByAudience(
      dto.groupName ? 'GROUP' : 'STUDENTS',
      dto.groupName,
    );
    const day = created.eventDate.toISOString().slice(0, 10);
    await this.notifications.notify(recipients, {
      type: 'SCHEDULE',
      title: { az: 'Təqvimdə yeni hadisə', ru: 'Новое событие в календаре', en: 'New calendar event' },
      message: {
        az: `${dto.title} — ${day}`,
        ru: `${dto.title} — ${day}`,
        en: `${dto.title} — ${day}`,
      },
      link: 'calendar',
    });
    return { ...created, warnings: conflicts.warnings };
  }

  async update(actorId: string, id: string, dto: UpdateEventDto, audit: { ip?: string | null; userAgent?: string | null }) {
    const existing = await this.prisma.calendarEvent.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Event not found');
    const merged = {
      eventDate: dto.eventDate ? new Date(dto.eventDate) : existing.eventDate,
      endDate: 'endDate' in dto ? (dto.endDate ? new Date(dto.endDate) : null) : existing.endDate,
      startTime: 'startTime' in dto ? dto.startTime ?? null : existing.startTime,
      endTime: 'endTime' in dto ? dto.endTime ?? null : existing.endTime,
      roomCode: 'roomCode' in dto ? dto.roomCode || null : existing.roomCode,
      groupName: 'groupName' in dto ? dto.groupName || null : existing.groupName,
    };
    if ((merged.startTime && !merged.endTime) || (!merged.startTime && merged.endTime) || (merged.startTime && merged.endTime && merged.startTime >= merged.endTime)) {
      throw new BadRequestException('Invalid time range');
    }
    if (merged.endDate && merged.endDate < merged.eventDate) throw new BadRequestException('endDate must not be before eventDate');
    const conflicts = await this.resolveAndCheck(merged, dto.allowScheduleOverlap, id);
    const updated = await this.prisma.calendarEvent.update({
      where: { id },
      data: {
        eventDate: merged.eventDate,
        endDate: merged.endDate,
        startTime: merged.startTime,
        endTime: merged.endTime,
        roomCode: merged.roomCode,
        groupName: merged.groupName,
        ...(dto.type && { type: dto.type }),
        ...(dto.title && { title: dto.title }),
        ...('description' in dto && { description: dto.description ?? null }),
        ...('level' in dto && { level: dto.level ?? null }),
      },
    });
    const { allowScheduleOverlap, ...fields } = dto;
    await this.prisma.auditLog.create({
      data: {
        actorId,
        action: 'calendar.update',
        targetType: 'CalendarEvent',
        targetId: id,
        diff: { fields: Object.keys(fields) },
        ip: audit.ip ?? null,
        userAgent: audit.userAgent ?? null,
      },
    });
    return { ...updated, warnings: conflicts.warnings };
  }

  async delete(actorId: string, id: string, audit: { ip?: string | null; userAgent?: string | null }) {
    const existing = await this.prisma.calendarEvent.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Event not found');
    await this.prisma.calendarEvent.delete({ where: { id } });
    await this.prisma.auditLog.create({
      data: {
        actorId,
        action: 'calendar.delete',
        targetType: 'CalendarEvent',
        targetId: id,
        diff: { title: existing.title, date: existing.eventDate.toISOString().slice(0, 10) },
        ip: audit.ip ?? null,
        userAgent: audit.userAgent ?? null,
      },
    });
    return { ok: true };
  }
}
