import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TimetableStatus, WeekParity } from '@prisma/client';
import { AuditCtx, AuditTrailService } from '../../common/audit/audit-trail.service';
import { PermissionsService } from '../../common/rbac/permissions.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { PeriodService } from '../journal/period.service';
import { currentWeekParity } from '../students/students.service';
import { CLesson } from './engine/checker';
import { parseTime } from './engine/types';
import { DescribedConflict, TimetableConflictsService } from './timetable.conflicts.service';
import { TTContext, TimetableContextService } from './timetable.context.service';
import { CalendarQuery, CreateLessonDto, LessonsQueryDto, UpdateLessonDto } from './timetable.dto';
import { LessonRow, hhmm, levelOfGroups, slotFor, toCLesson } from './timetable.map';

export interface Actor {
  id: string;
  role: import('@prisma/client').Role;
}

const EDITABLE: TimetableStatus[] = ['DRAFT', 'REVIEW'];
const FIELDS = ['subjectId', 'teacherId', 'roomId', 'groupNames', 'lessonTypeCode', 'dayOfWeek', 'startTime', 'endTime', 'weekParity', 'timeSlotId'] as const;
const FIELD_LABEL: Record<string, string> = { teacherId: 'teacher', roomId: 'room', groupNames: 'groups', lessonTypeCode: 'type', dayOfWeek: 'day', startTime: 'time', endTime: 'time', weekParity: 'parity', subjectId: 'subject', timeSlotId: 'slot' };

@Injectable()
export class TimetableLessonsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctxSvc: TimetableContextService,
    private readonly conflicts: TimetableConflictsService,
    private readonly audit: AuditTrailService,
    private readonly perms: PermissionsService,
    private readonly periods: PeriodService,
  ) {}

  // ───────────────────────── чтение ─────────────────────────
  async enrich(rows: LessonRow[], ctx: TTContext) {
    const subjectIds = Array.from(new Set(rows.map((r) => r.subjectId)));
    const subjects = subjectIds.length ? await this.prisma.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, code: true, name: true, color: true } }) : [];
    const sub = new Map(subjects.map((s) => [s.id, s]));
    const roomById = new Map(ctx.roomsAll.map((r) => [r.id, r]));
    return rows.map((r) => {
      const slot = r.timeSlotId ? ctx.slotsAll.find((s) => s.id === r.timeSlotId) : slotFor(ctx, parseTime(r.startTime), parseTime(r.endTime), r.level);
      const type = ctx.lessonTypes.get(r.lessonTypeCode);
      const t = r.teacherId ? ctx.teacherMeta.get(r.teacherId) : undefined;
      const room = r.roomId ? roomById.get(r.roomId) : undefined;
      return {
        id: r.id, versionId: r.versionId, requirementId: r.requirementId,
        subject: sub.get(r.subjectId) ?? { id: r.subjectId, code: '?', name: '?', color: null },
        teacher: t ? { id: t.id, name: t.name, loginId: t.loginId } : null,
        room: room ? { id: room.id, code: room.code, building: room.building, capacity: room.capacity, type: room.type } : null,
        groups: r.groupNames, size: r.groupNames.reduce((a, g) => a + (ctx.groupMeta.get(g)?.size ?? 0), 0),
        type: r.lessonTypeCode, typeName: type?.name ?? r.lessonTypeCode, typeColor: type?.color ?? null,
        day: r.dayOfWeek, timeSlotId: r.timeSlotId, slotCode: slot?.code ?? null, start: r.startTime, end: r.endTime,
        parity: r.weekParity, level: r.level, locked: r.locked, override: r.override, note: r.note,
      };
    });
  }

  private async groupNamesFor(ctx: TTContext, q: { faculty?: string; specialty?: string; level?: string; group?: string }): Promise<string[] | null> {
    if (q.group) return [q.group];
    if (!q.faculty && !q.specialty && !q.level) return null;
    const list = Array.from(ctx.groupMeta.values()).filter((g) => (!q.faculty || g.faculty === q.faculty) && (!q.specialty || g.specialty === q.specialty) && (!q.level || g.level === q.level));
    return list.map((g) => g.name);
  }

  async list(versionId: string, q: LessonsQueryDto) {
    const v = await this.conflicts.version(versionId);
    const ctx = await this.ctxSvc.load(v.academicYear, v.term);
    const and: Prisma.ScheduleLessonWhereInput[] = [{ versionId }];
    const groups = await this.groupNamesFor(ctx, q);
    if (groups) and.push({ groupNames: { hasSome: groups.length ? groups : ['\u0000none'] } });
    if (q.teacherId) and.push({ teacherId: q.teacherId });
    if (q.subjectId) and.push({ subjectId: q.subjectId });
    if (q.roomId) and.push({ roomId: q.roomId });
    if (q.building) and.push({ roomId: { in: ctx.roomsAll.filter((r) => r.building === q.building).map((r) => r.id) } });
    if (q.day) and.push({ dayOfWeek: q.day });
    if (q.type) and.push({ lessonTypeCode: q.type });
    if (q.timeSlotId) and.push({ timeSlotId: q.timeSlotId });
    if (q.fromTime) and.push({ startTime: { gte: q.fromTime } });
    if (q.toTime) and.push({ endTime: { lte: q.toTime } });
    if (q.locked !== undefined) and.push({ locked: q.locked });
    if (q.search) {
      const s = q.search.toLowerCase();
      const matchGroups = Array.from(ctx.groupMeta.keys()).filter((g) => g.toLowerCase().includes(s));
      const matchTeachers = Array.from(ctx.teacherMeta.values()).filter((t) => t.name.toLowerCase().includes(s) || t.loginId.includes(s)).map((t) => t.id);
      const matchRooms = ctx.roomsAll.filter((r) => r.code.toLowerCase().includes(s)).map((r) => r.id);
      and.push({
        OR: [
          { subject: { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { code: { contains: q.search, mode: 'insensitive' } }] } },
          ...(matchGroups.length ? [{ groupNames: { hasSome: matchGroups } }] : []),
          ...(matchTeachers.length ? [{ teacherId: { in: matchTeachers } }] : []),
          ...(matchRooms.length ? [{ roomId: { in: matchRooms } }] : []),
        ],
      });
    }
    const where: Prisma.ScheduleLessonWhereInput = { AND: and };
    const [total, rows] = await Promise.all([
      this.prisma.scheduleLesson.count({ where }),
      this.prisma.scheduleLesson.findMany({ where, orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { page: q.page, pageSize: q.pageSize, total, items: await this.enrich(rows, ctx) };
  }

  /** Все занятия одной сущности (для недельной сетки). Ограничено 1000. */
  async entity(versionId: string, by: 'group' | 'teacher' | 'room' | 'building', value: string) {
    const v = await this.conflicts.version(versionId);
    const ctx = await this.ctxSvc.load(v.academicYear, v.term);
    const where: Prisma.ScheduleLessonWhereInput =
      by === 'group' ? { versionId, groupNames: { has: value } }
      : by === 'teacher' ? { versionId, teacherId: value }
      : by === 'room' ? { versionId, roomId: value }
      : { versionId, roomId: { in: ctx.roomsAll.filter((r) => r.building === value).map((r) => r.id) } };
    const rows = await this.prisma.scheduleLesson.findMany({ where, orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }], take: 1000 });
    return { items: await this.enrich(rows, ctx) };
  }

  /** Развёртка недельного шаблона в даты (месячный/дневной вид). Учитывает чётность недели и события календаря. */
  async calendar(versionId: string, q: ReturnType<typeof CalendarQuery.parse>) {
    const from = new Date(q.from + 'T00:00:00Z'), to = new Date(q.to + 'T00:00:00Z');
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) throw new BadRequestException('Invalid range');
    if ((to.getTime() - from.getTime()) / 86400000 > 92) throw new BadRequestException({ message: 'Range is too long (max 93 days)', code: 'RANGE_TOO_LONG' });
    const v = await this.conflicts.version(versionId);
    const ctx = await this.ctxSvc.load(v.academicYear, v.term);
    const groups = await this.groupNamesFor(ctx, { faculty: q.faculty, group: q.group });
    const where: Prisma.ScheduleLessonWhereInput = {
      versionId,
      ...(groups ? { groupNames: { hasSome: groups.length ? groups : ['\u0000none'] } } : {}),
      ...(q.teacherId ? { teacherId: q.teacherId } : {}),
      ...(q.roomId ? { roomId: q.roomId } : {}),
    };
    const [rows, events] = await Promise.all([
      this.prisma.scheduleLesson.findMany({ where, take: 5000 }),
      this.prisma.calendarEvent.findMany({ where: { eventDate: { lte: to }, OR: [{ endDate: { gte: from } }, { endDate: null, eventDate: { gte: from } }], type: { in: ['HOLIDAY', 'MOURNING', 'LECTURE_CANCELLED'] } } }),
    ]);
    const items = await this.enrich(rows, ctx);
    const out: Array<(typeof items)[number] & { date: string; cancelled: string | null }> = [];
    for (let d = new Date(from); d <= to; d = new Date(d.getTime() + 86400000)) {
      const dow = d.getUTCDay() || 7;
      const parity = currentWeekParity(d);
      const iso = d.toISOString().slice(0, 10);
      for (const it of items) {
        if (it.day !== dow) continue;
        if (it.parity !== 'BOTH' && it.parity !== parity) continue;
        const ev = events.find((e) => {
          const s = e.eventDate.toISOString().slice(0, 10), en = (e.endDate ?? e.eventDate).toISOString().slice(0, 10);
          return iso >= s && iso <= en && (!e.groupName || it.groups.includes(e.groupName));
        });
        out.push({ ...it, date: iso, cancelled: ev ? ev.type : null });
      }
    }
    out.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
    return { items: out };
  }

  // ───────────────────────── изменение ─────────────────────────
  private async editableVersion(versionId: string) {
    const v = await this.conflicts.version(versionId);
    if (!EDITABLE.includes(v.status)) throw new ConflictException({ message: 'Only DRAFT or REVIEW versions can be edited. Create a draft from this version first.', code: 'VERSION_NOT_EDITABLE', status: v.status });
    if (await this.periods.isClosed(v.academicYear, v.term)) throw new ForbiddenException({ message: 'Academic period is closed', code: 'PERIOD_CLOSED' });
    return v;
  }

  private resolveTime(ctx: TTContext, d: { timeSlotId?: string | null; startTime?: string; endTime?: string }) {
    if (d.timeSlotId) {
      const s = ctx.slotsAll.find((x) => x.id === d.timeSlotId);
      if (!s) throw new BadRequestException({ message: 'Unknown time slot', code: 'UNKNOWN_SLOT' });
      return { timeSlotId: s.id, startTime: hhmm(s.start), endTime: hhmm(s.end) };
    }
    return { timeSlotId: null as string | null, startTime: d.startTime!, endTime: d.endTime! };
  }

  private async validateRefs(ctx: TTContext, d: { subjectId: string; teacherId?: string | null; roomId?: string | null; groupNames: string[]; lessonTypeCode: string }) {
    const subject = await this.prisma.subject.findUnique({ where: { id: d.subjectId }, select: { id: true } });
    if (!subject) throw new BadRequestException({ message: 'Unknown subject', code: 'UNKNOWN_SUBJECT' });
    if (d.teacherId && !ctx.teacherMeta.has(d.teacherId)) throw new BadRequestException({ message: 'Unknown or inactive teacher', code: 'UNKNOWN_TEACHER' });
    if (d.roomId && !ctx.roomsAll.some((r) => r.id === d.roomId)) throw new BadRequestException({ message: 'Unknown room', code: 'UNKNOWN_ROOM' });
    for (const g of d.groupNames) if (!ctx.groupMeta.has(g)) throw new BadRequestException({ message: `Unknown group ${g}`, code: 'UNKNOWN_GROUP' });
    if (!ctx.lessonTypes.has(d.lessonTypeCode)) throw new BadRequestException({ message: 'Unknown lesson type', code: 'UNKNOWN_LESSON_TYPE' });
  }

  private async decide(actor: Actor, versionId: string, ctx: TTContext, data: Omit<Prisma.ScheduleLessonUncheckedCreateInput, 'versionId'>, id: string, overrideReason?: string) {
    const proposed: CLesson = { ...toCLesson({ ...(data as unknown as LessonRow), id, versionId }) };
    const { critical, warnings } = await this.conflicts.checkProposed(versionId, proposed, ctx);
    if (critical.length) {
      if (!overrideReason) {
        throw new ConflictException({ message: 'The change would create a conflict', code: 'SCHEDULE_CONFLICT', conflicts: await this.conflicts.describe(critical, ctx, proposed), warnings: await this.conflicts.describe(warnings, ctx, proposed) });
      }
      if (!(await this.perms.has(actor.role, 'schedule.override'))) throw new ForbiddenException({ message: 'Only a user with schedule.override can save a conflicting lesson', code: 'OVERRIDE_FORBIDDEN' });
      return { override: true, critical, warnings };
    }
    return { override: false, critical, warnings };
  }

  async create(actor: Actor, versionId: string, dto: CreateLessonDto, ctxA: AuditCtx) {
    const v = await this.editableVersion(versionId);
    const ctx = await this.ctxSvc.load(v.academicYear, v.term);
    await this.validateRefs(ctx, dto);
    const time = this.resolveTime(ctx, dto);
    const level = levelOfGroups(ctx, dto.groupNames);
    const data = {
      requirementId: dto.requirementId ?? null, sessionIndex: 0, subjectId: dto.subjectId, teacherId: dto.teacherId ?? null, roomId: dto.roomId ?? null, groupNames: dto.groupNames,
      lessonTypeCode: dto.lessonTypeCode, dayOfWeek: dto.dayOfWeek, ...time, weekParity: dto.weekParity as WeekParity, level, locked: false, override: false, note: dto.note ?? null,
    };
    const tmpId = 'new';
    const res = await this.decide(actor, versionId, ctx, data as never, tmpId, dto.overrideReason);
    const row = await this.prisma.$transaction(async (tx) => {
      const r = await tx.scheduleLesson.create({ data: { ...data, versionId, override: res.override } });
      await tx.scheduleVersion.update({ where: { id: versionId }, data: { stats: Prisma.DbNull } });
      await this.audit.recordTx(tx, { actorId: actor.id, action: 'timetable.lesson_create', targetType: 'ScheduleLesson', targetId: r.id, new: this.snap(r), extra: { versionId, version: v.number, override: res.override } }, ctxA);
      if (res.override) await this.audit.recordTx(tx, { actorId: actor.id, action: 'timetable.override', targetType: 'ScheduleLesson', targetId: r.id, new: this.snap(r), extra: { versionId, reason: dto.overrideReason, conflicts: res.critical.map((c) => c.code) } }, ctxA);
      return r;
    });
    return { lesson: (await this.enrich([row], ctx))[0], warnings: await this.conflicts.describe(res.warnings, ctx), overridden: res.override };
  }

  private snap(r: LessonRow) {
    return { subjectId: r.subjectId, teacherId: r.teacherId, roomId: r.roomId, groups: r.groupNames, type: r.lessonTypeCode, day: r.dayOfWeek, start: r.startTime, end: r.endTime, parity: r.weekParity, locked: r.locked };
  }

  async update(actor: Actor, lessonId: string, dto: UpdateLessonDto, ctxA: AuditCtx) {
    const cur = await this.prisma.scheduleLesson.findUnique({ where: { id: lessonId } });
    if (!cur) throw new NotFoundException('Lesson not found');
    const v = await this.editableVersion(cur.versionId);
    const ctx = await this.ctxSvc.load(v.academicYear, v.term);
    // блокировка — отдельное действие, не требует проверки конфликтов
    const contentKeys = Object.keys(dto).filter((k) => !['locked', 'overrideReason', 'note'].includes(k));
    const old = this.snap(cur);
    if (!contentKeys.length) {
      const data: Prisma.ScheduleLessonUpdateInput = {};
      if (dto.locked !== undefined) data.locked = dto.locked;
      if (dto.note !== undefined) data.note = dto.note;
      const row = await this.prisma.$transaction(async (tx) => {
        const r = await tx.scheduleLesson.update({ where: { id: lessonId }, data });
        if (dto.locked !== undefined && dto.locked !== cur.locked) await this.audit.recordTx(tx, { actorId: actor.id, action: dto.locked ? 'timetable.lock' : 'timetable.unlock', targetType: 'ScheduleLesson', targetId: lessonId, old: cur.locked, new: dto.locked, extra: { versionId: cur.versionId } }, ctxA);
        return r;
      });
      return { lesson: (await this.enrich([row], ctx))[0], warnings: [] as DescribedConflict[], overridden: false };
    }
    if (cur.locked && dto.locked !== false) throw new ConflictException({ message: 'The lesson is locked. Unlock it first.', code: 'LESSON_LOCKED' });
    const merged = {
      subjectId: dto.subjectId ?? cur.subjectId,
      teacherId: dto.teacherId !== undefined ? dto.teacherId : cur.teacherId,
      roomId: dto.roomId !== undefined ? dto.roomId : cur.roomId,
      groupNames: dto.groupNames ?? cur.groupNames,
      lessonTypeCode: dto.lessonTypeCode ?? cur.lessonTypeCode,
      dayOfWeek: dto.dayOfWeek ?? cur.dayOfWeek,
      weekParity: (dto.weekParity ?? cur.weekParity) as WeekParity,
    };
    await this.validateRefs(ctx, merged);
    const timeChanged = dto.timeSlotId !== undefined || dto.startTime !== undefined || dto.endTime !== undefined;
    const time = timeChanged
      ? this.resolveTime(ctx, { timeSlotId: dto.timeSlotId, startTime: dto.startTime ?? cur.startTime, endTime: dto.endTime ?? cur.endTime })
      : { timeSlotId: cur.timeSlotId, startTime: cur.startTime, endTime: cur.endTime };
    if (time.startTime >= time.endTime) throw new BadRequestException({ message: 'startTime must be before endTime', code: 'BAD_TIME' });
    const level = levelOfGroups(ctx, merged.groupNames);
    const data = { ...merged, ...time, level, requirementId: cur.requirementId, sessionIndex: cur.sessionIndex, locked: dto.locked ?? cur.locked, override: false, note: dto.note !== undefined ? dto.note : cur.note };
    const res = await this.decide(actor, cur.versionId, ctx, data as never, lessonId, dto.overrideReason);
    const row = await this.prisma.$transaction(async (tx) => {
      const r = await tx.scheduleLesson.update({ where: { id: lessonId }, data: { ...data, override: res.override || cur.override } });
      await tx.scheduleVersion.update({ where: { id: cur.versionId }, data: { stats: Prisma.DbNull } });
      const now = this.snap(r);
      const changed = Array.from(new Set(FIELDS.filter((f) => JSON.stringify((cur as never)[f]) !== JSON.stringify((r as never)[f])).map((f) => FIELD_LABEL[f])));
      await this.audit.recordTx(tx, { actorId: actor.id, action: 'timetable.lesson_update', targetType: 'ScheduleLesson', targetId: lessonId, old, new: now, extra: { versionId: cur.versionId, version: v.number, changed, override: res.override } }, ctxA);
      if (res.override) await this.audit.recordTx(tx, { actorId: actor.id, action: 'timetable.override', targetType: 'ScheduleLesson', targetId: lessonId, new: now, extra: { versionId: cur.versionId, reason: dto.overrideReason, conflicts: res.critical.map((c) => c.code) } }, ctxA);
      return r;
    });
    return { lesson: (await this.enrich([row], ctx))[0], warnings: await this.conflicts.describe(res.warnings, ctx), overridden: res.override };
  }

  async remove(actor: Actor, lessonId: string, ctxA: AuditCtx) {
    const cur = await this.prisma.scheduleLesson.findUnique({ where: { id: lessonId } });
    if (!cur) throw new NotFoundException('Lesson not found');
    await this.editableVersion(cur.versionId);
    if (cur.locked) throw new ConflictException({ message: 'The lesson is locked. Unlock it first.', code: 'LESSON_LOCKED' });
    await this.prisma.$transaction(async (tx) => {
      await tx.scheduleLesson.delete({ where: { id: lessonId } });
      await tx.scheduleVersion.update({ where: { id: cur.versionId }, data: { stats: Prisma.DbNull } });
      await this.audit.recordTx(tx, { actorId: actor.id, action: 'timetable.lesson_delete', targetType: 'ScheduleLesson', targetId: lessonId, old: this.snap(cur), extra: { versionId: cur.versionId } }, ctxA);
    });
    return { deleted: true };
  }

  async bulkLock(actor: Actor, versionId: string, ids: string[], locked: boolean, ctxA: AuditCtx) {
    await this.editableVersion(versionId);
    const res = await this.prisma.$transaction(async (tx) => {
      const r = await tx.scheduleLesson.updateMany({ where: { versionId, id: { in: ids }, locked: !locked }, data: { locked } });
      if (r.count) await this.audit.recordTx(tx, { actorId: actor.id, action: locked ? 'timetable.lock' : 'timetable.unlock', targetType: 'ScheduleVersion', targetId: versionId, new: locked, extra: { count: r.count } }, ctxA);
      return r;
    });
    return { updated: res.count };
  }

  // ───────────────────────── «моё расписание» (опубликованное) ─────────────────────────
  /** Студент — расписание своей группы, преподаватель — свои занятия; даты с учётом чётности недели и событий календаря */
  async myCalendar(actor: Actor, q: { from: string; to: string }) {
    const from = new Date(q.from + 'T00:00:00Z'), to = new Date(q.to + 'T00:00:00Z');
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) throw new BadRequestException('Invalid range');
    if ((to.getTime() - from.getTime()) / 86400000 > 92) throw new BadRequestException({ message: 'Range is too long (max 93 days)', code: 'RANGE_TOO_LONG' });
    const [student, teacher] = await Promise.all([
      this.prisma.student.findUnique({ where: { userId: actor.id }, select: { groupName: true } }),
      this.prisma.teacher.findUnique({ where: { userId: actor.id }, select: { userId: true } }),
    ]);
    if (!student && !teacher) throw new ForbiddenException({ message: 'Only students and teachers have a personal timetable', code: 'NO_PERSONAL_TIMETABLE' });
    const slots = await this.prisma.scheduleSlot.findMany({
      where: student ? { groupName: student.groupName } : { teacherId: actor.id },
      include: { subject: { select: { code: true, name: true, color: true } }, teacher: { select: { user: { select: { fullName: true } } } } },
    });
    const groupNames = Array.from(new Set(slots.map((s) => s.groupName)));
    const events = await this.prisma.calendarEvent.findMany({ where: { eventDate: { lte: to }, OR: [{ endDate: { gte: from } }, { endDate: null, eventDate: { gte: from } }], type: { in: ['HOLIDAY', 'MOURNING', 'LECTURE_CANCELLED'] } } });
    const rooms = await this.prisma.room.findMany({ where: { id: { in: slots.map((s) => s.roomId).filter((x): x is string => !!x) } }, select: { id: true, building: true } });
    const bld = new Map(rooms.map((r) => [r.id, r.building]));
    const out: Array<Record<string, unknown>> = [];
    for (let d = new Date(from); d <= to; d = new Date(d.getTime() + 86400000)) {
      const dow = d.getUTCDay() || 7, parity = currentWeekParity(d), iso = d.toISOString().slice(0, 10);
      for (const s of slots) {
        if (s.dayOfWeek !== dow || (s.weekParity !== 'BOTH' && s.weekParity !== parity)) continue;
        const ev = events.find((e) => {
          const a = e.eventDate.toISOString().slice(0, 10), b = (e.endDate ?? e.eventDate).toISOString().slice(0, 10);
          return iso >= a && iso <= b && (!e.groupName || e.groupName === s.groupName);
        });
        out.push({
          date: iso, start: s.startTime, end: s.endTime, subject: s.subject, type: s.type, room: s.room, building: s.roomId ? bld.get(s.roomId) ?? null : null,
          group: s.groupName, teacher: s.teacher?.user.fullName ?? null, cancelled: ev ? ev.type : null,
          // переход в посещаемость Academic Journal — для преподавателя пары, которую он ведёт
          attendance: teacher && !ev ? { groupName: s.groupName, subjectCode: s.subject.code, classDate: iso } : null,
        });
      }
    }
    out.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.start).localeCompare(String(b.start)));
    void groupNames;
    return { items: out };
  }
}