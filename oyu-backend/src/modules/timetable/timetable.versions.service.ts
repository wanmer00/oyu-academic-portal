import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, Shift, Term, TimetableStatus } from '@prisma/client';
import { AuditCtx, AuditTrailService } from '../../common/audit/audit-trail.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PeriodService } from '../journal/period.service';
import { TimetableConflictsService } from './timetable.conflicts.service';
import { TimetableContextService } from './timetable.context.service';
import { Actor } from './timetable.lessons.service';
import { LessonRow } from './timetable.map';

const CHUNK = 1000;
const slotShift = (s: string | null | undefined): Shift => (s === '1' || !s ? 'SHIFT_1' : 'SHIFT_2');

@Injectable()
export class TimetableVersionsService {
  private readonly log = new Logger('Timetable');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditTrailService,
    private readonly conflicts: TimetableConflictsService,
    private readonly ctxSvc: TimetableContextService,
    private readonly notifications: NotificationsService,
    private readonly periods: PeriodService,
  ) {}

  async list(q: { academicYear?: string; term?: Term; status?: TimetableStatus }) {
    const rows = await this.prisma.scheduleVersion.findMany({
      where: { ...(q.academicYear ? { academicYear: q.academicYear } : {}), ...(q.term ? { term: q.term } : {}), ...(q.status ? { status: q.status } : {}) },
      orderBy: [{ academicYear: 'desc' }, { term: 'asc' }, { number: 'desc' }],
      take: 200,
    });
    const userIds = Array.from(new Set(rows.flatMap((r) => [r.createdBy, r.publishedBy]).filter((x): x is string => !!x)));
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true, loginId: true } }) : [];
    const u = new Map(users.map((x) => [x.id, x]));
    const counts = await this.prisma.scheduleLesson.groupBy({ by: ['versionId'], where: { versionId: { in: rows.map((r) => r.id) } }, _count: { _all: true } });
    const cnt = new Map(counts.map((c) => [c.versionId, c._count._all]));
    return rows.map((r) => ({
      id: r.id, academicYear: r.academicYear, term: r.term, number: r.number, name: r.name, status: r.status, parentId: r.parentId, note: r.note, stats: r.stats,
      lessons: cnt.get(r.id) ?? 0, createdAt: r.createdAt, createdBy: r.createdBy ? u.get(r.createdBy) ?? null : null, publishedAt: r.publishedAt, publishedBy: r.publishedBy ? u.get(r.publishedBy) ?? null : null,
    }));
  }

  async get(id: string) {
    const v = await this.conflicts.version(id);
    return (await this.list({ academicYear: v.academicYear, term: v.term })).find((x) => x.id === id)!;
  }

  private async nextNumber(tx: Prisma.TransactionClient, academicYear: string, term: Term) {
    const last = await tx.scheduleVersion.aggregate({ where: { academicYear, term }, _max: { number: true } });
    return (last._max.number ?? 0) + 1;
  }

  /** Копирует занятия одной версии в другую (новые id). Возвращает число скопированных. */
  async cloneLessons(tx: Prisma.TransactionClient, fromId: string, toId: string): Promise<number> {
    const rows = await tx.scheduleLesson.findMany({ where: { versionId: fromId } });
    for (let i = 0; i < rows.length; i += CHUNK) {
      await tx.scheduleLesson.createMany({
        data: rows.slice(i, i + CHUNK).map(({ id, versionId, createdAt, updatedAt, ...rest }) => ({ ...rest, versionId: toId })),
      });
    }
    return rows.length;
  }

  /** Новый черновик: пустой либо копия существующей версии (в том числе опубликованной или архивной — «откат») */
  async createDraft(actor: Actor, dto: { academicYear: string; term: Term; fromVersionId?: string | null; name?: string; note?: string }, ctxA: AuditCtx, action = 'timetable.version_create') {
    if (await this.periods.isClosed(dto.academicYear, dto.term)) throw new ForbiddenException({ message: 'Academic period is closed', code: 'PERIOD_CLOSED' });
    const from = dto.fromVersionId ? await this.conflicts.version(dto.fromVersionId) : null;
    if (from && (from.academicYear !== dto.academicYear || from.term !== dto.term)) throw new BadRequestException({ message: 'Source version belongs to another period', code: 'PERIOD_MISMATCH' });
    return this.prisma.$transaction(async (tx) => {
      const number = await this.nextNumber(tx, dto.academicYear, dto.term);
      const v = await tx.scheduleVersion.create({ data: { academicYear: dto.academicYear, term: dto.term, number, name: dto.name ?? null, note: dto.note ?? null, parentId: from?.id ?? null, status: 'DRAFT', createdBy: actor.id } });
      const copied = from ? await this.cloneLessons(tx, from.id, v.id) : 0;
      await this.audit.recordTx(tx, { actorId: actor.id, action, targetType: 'ScheduleVersion', targetId: v.id, new: { number, from: from?.number ?? null, lessons: copied }, extra: { academicYear: dto.academicYear, term: dto.term } }, ctxA);
      return v;
    }, { timeout: 120_000 });
  }

  async restore(actor: Actor, id: string, ctxA: AuditCtx) {
    const from = await this.conflicts.version(id);
    return this.createDraft(actor, { academicYear: from.academicYear, term: from.term, fromVersionId: id, name: `Restore v${from.number}` }, ctxA, 'timetable.version_restore');
  }

  async patch(actor: Actor, id: string, dto: { name?: string | null; note?: string | null }) {
    await this.conflicts.version(id);
    return this.prisma.scheduleVersion.update({ where: { id }, data: { ...(dto.name !== undefined ? { name: dto.name } : {}), ...(dto.note !== undefined ? { note: dto.note } : {}) } });
  }

  private async transition(actor: Actor, id: string, from: TimetableStatus[], to: TimetableStatus, action: string, ctxA: AuditCtx, extra: Record<string, unknown> = {}) {
    const v = await this.conflicts.version(id);
    if (!from.includes(v.status)) throw new ConflictException({ message: `Version is ${v.status}; allowed: ${from.join(', ')}`, code: 'BAD_STATE', status: v.status });
    await this.prisma.$transaction(async (tx) => {
      await tx.scheduleVersion.update({ where: { id }, data: { status: to, ...(to === 'ARCHIVED' ? { archivedAt: new Date() } : {}) } });
      await this.audit.recordTx(tx, { actorId: actor.id, action, targetType: 'ScheduleVersion', targetId: id, old: v.status, new: to, extra: { number: v.number, ...extra } }, ctxA);
    });
    return this.get(id);
  }

  submitReview(actor: Actor, id: string, ctxA: AuditCtx) { return this.transition(actor, id, ['DRAFT'], 'REVIEW', 'timetable.version_review', ctxA); }
  backToDraft(actor: Actor, id: string, ctxA: AuditCtx) { return this.transition(actor, id, ['REVIEW'], 'DRAFT', 'timetable.version_draft', ctxA); }
  archive(actor: Actor, id: string, ctxA: AuditCtx) { return this.transition(actor, id, ['DRAFT', 'REVIEW'], 'ARCHIVED', 'timetable.version_archive', ctxA); }

  // ───────────────────────── публикация ─────────────────────────
  async publish(actor: Actor, id: string, ctxA: AuditCtx) {
    const v = await this.conflicts.version(id);
    if (v.status !== 'DRAFT' && v.status !== 'REVIEW') throw new ConflictException({ message: `Only DRAFT or REVIEW can be published (now ${v.status})`, code: 'BAD_STATE', status: v.status });
    if (await this.periods.isClosed(v.academicYear, v.term)) throw new ForbiddenException({ message: 'Academic period is closed', code: 'PERIOD_CLOSED' });

    // финальная проверка HARD-ограничений: любой критический конфликт блокирует публикацию
    const { result, ctx, stats } = await this.conflicts.check(id, true);
    if (result.critical.length) {
      throw new UnprocessableEntityException({
        message: `Publishing is impossible. ${result.critical.length} critical conflict(s) found.`,
        code: 'PUBLISH_BLOCKED', critical: result.critical.length, warnings: result.warnings.length, byCode: result.summary.byCode,
        sample: await this.conflicts.describe(result.critical.slice(0, 5), ctx),
      });
    }
    const lessons = await this.prisma.scheduleLesson.findMany({ where: { versionId: id } });
    const roomById = new Map(ctx.roomsAll.map((r) => [r.id, r]));
    const slotById = new Map(ctx.slotsAll.map((s) => [s.id, s]));
    const prev = await this.prisma.scheduleVersion.findFirst({ where: { academicYear: v.academicYear, term: v.term, status: 'PUBLISHED', id: { not: id } } });

    const slots: Prisma.ScheduleSlotCreateManyInput[] = [];
    for (const l of lessons) {
      const slot = l.timeSlotId ? slotById.get(l.timeSlotId) : ctx.slotsAll.find((s) => `${String(Math.floor(s.start / 60)).padStart(2, '0')}:${String(s.start % 60).padStart(2, '0')}` === l.startTime);
      const room = l.roomId ? roomById.get(l.roomId) : undefined;
      for (const g of l.groupNames) {
        slots.push({
          subjectId: l.subjectId, teacherId: l.teacherId, roomId: l.roomId, room: room?.code ?? '—', groupName: g, dayOfWeek: l.dayOfWeek, startTime: l.startTime, endTime: l.endTime,
          type: l.lessonTypeCode, shift: slotShift(slot?.shift), level: l.level, weekParity: l.weekParity, academicYear: v.academicYear, term: v.term,
          lessonId: l.id, streamKey: l.groupNames.length > 1 ? l.id : null,
        });
      }
    }
    const diff = prev ? await this.diff(prev.id, id, 0) : null;

    await this.prisma.$transaction(async (tx) => {
      if (prev) await tx.scheduleVersion.update({ where: { id: prev.id }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
      await tx.scheduleVersion.update({ where: { id }, data: { status: 'PUBLISHED', publishedAt: new Date(), publishedBy: actor.id } });
      await tx.scheduleSlot.deleteMany({ where: { academicYear: v.academicYear, term: v.term } });
      for (let i = 0; i < slots.length; i += CHUNK) await tx.scheduleSlot.createMany({ data: slots.slice(i, i + CHUNK) });
      await this.audit.recordTx(tx, {
        actorId: actor.id, action: 'timetable.publish', targetType: 'ScheduleVersion', targetId: id, old: prev ? { publishedVersion: prev.number } : null, new: { publishedVersion: v.number },
        extra: { academicYear: v.academicYear, term: v.term, lessons: lessons.length, slots: slots.length, warnings: result.warnings.length, compliancePct: stats.compliancePct, changes: diff?.summary ?? null },
      }, ctxA);
    }, { timeout: 180_000, maxWait: 20_000 });

    this.ctxSvc.invalidate();
    void this.notifyChanged(prev?.id ?? null, id, v.academicYear).catch((e) => this.log.warn('notify failed: ' + e?.message));
    return { version: await this.get(id), published: lessons.length, slots: slots.length, warnings: result.warnings.length, changes: diff?.summary ?? null };
  }

  /** Уведомления только тем, чьё расписание изменилось (студенты затронутых групп и преподаватели) */
  private async notifyChanged(prevId: string | null, newId: string, academicYear: string) {
    const d = await this.diff(prevId, newId, 0, true);
    const groups = Array.from(d.touchedGroups);
    const teachers = Array.from(d.touchedTeachers);
    if (!groups.length && !teachers.length) return;
    const students = groups.length ? await this.prisma.student.findMany({ where: { groupName: { in: groups }, user: { status: 'ACTIVE' } }, select: { userId: true } }) : [];
    const ids = Array.from(new Set([...students.map((s) => s.userId), ...teachers]));
    for (let i = 0; i < ids.length; i += 500) {
      await this.notifications.notify(ids.slice(i, i + 500), {
        type: 'SCHEDULE',
        title: { az: 'Cədvəl yeniləndi', ru: 'Расписание обновлено', en: 'Timetable updated' },
        message: { az: `${academicYear}: dərs cədvəliniz dəyişdi. Yeni cədvələ baxın.`, ru: `${academicYear}: ваше расписание изменилось. Посмотрите новое расписание.`, en: `${academicYear}: your timetable has changed. Please check the new schedule.` },
        link: 'schedule',
      });
    }
  }

  // ───────────────────────── сравнение версий ─────────────────────────
  async diff(aId: string | null, bId: string, sample = 100, touched = false) {
    const [a, b]: [LessonRow[], LessonRow[]] = await Promise.all([
      aId ? this.prisma.scheduleLesson.findMany({ where: { versionId: aId } }) : Promise.resolve([] as LessonRow[]),
      this.prisma.scheduleLesson.findMany({ where: { versionId: bId } }),
    ]);
    const key = (l: (typeof a)[number]) => (l.requirementId ? `${l.requirementId}#${l.sessionIndex}` : `x:${l.subjectId}|${l.lessonTypeCode}|${l.groupNames.join('+')}|${l.dayOfWeek}|${l.startTime}`);
    const am = new Map(a.map((l) => [key(l), l])), bm = new Map(b.map((l) => [key(l), l]));
    const added: typeof b = [], removed: typeof a = [], changed: Array<{ key: string; before: (typeof a)[number]; after: (typeof b)[number]; fields: string[] }> = [];
    for (const [k, l] of bm) {
      const o = am.get(k);
      if (!o) { added.push(l); continue; }
      const fields: string[] = [];
      if (o.dayOfWeek !== l.dayOfWeek) fields.push('day');
      if (o.startTime !== l.startTime || o.endTime !== l.endTime) fields.push('time');
      if (o.roomId !== l.roomId) fields.push('room');
      if (o.teacherId !== l.teacherId) fields.push('teacher');
      if (o.groupNames.join() !== l.groupNames.join()) fields.push('groups');
      if (o.weekParity !== l.weekParity) fields.push('parity');
      if (fields.length) changed.push({ key: k, before: o, after: l, fields });
    }
    for (const [k, l] of am) if (!bm.has(k)) removed.push(l);
    const touchedGroups = new Set<string>(), touchedTeachers = new Set<string>();
    if (touched) {
      for (const l of [...added, ...removed, ...changed.flatMap((c) => [c.before, c.after])]) { l.groupNames.forEach((g) => touchedGroups.add(g)); if (l.teacherId) touchedTeachers.add(l.teacherId); }
    }
    const brief = (l: (typeof a)[number]) => ({ id: l.id, subjectId: l.subjectId, groups: l.groupNames, teacherId: l.teacherId, roomId: l.roomId, day: l.dayOfWeek, start: l.startTime, end: l.endTime, type: l.lessonTypeCode });
    return {
      summary: { added: added.length, removed: removed.length, changed: changed.length, unchanged: b.length - added.length - changed.length },
      added: added.slice(0, sample).map(brief), removed: removed.slice(0, sample).map(brief),
      changed: changed.slice(0, sample).map((c) => ({ key: c.key, fields: c.fields, before: brief(c.before), after: brief(c.after) })),
      touchedGroups, touchedTeachers,
    };
  }

  async diffApi(aId: string, bId: string) {
    const d = await this.diff(aId, bId, 150);
    const v = await this.conflicts.version(bId);
    const ctx = await this.ctxSvc.load(v.academicYear, v.term);
    type Brief = (typeof d.added)[number];
    const all: Brief[] = [...d.added, ...d.removed, ...d.changed.flatMap((c) => [c.before, c.after])];
    const subs = await this.prisma.subject.findMany({ where: { id: { in: Array.from(new Set(all.map((l) => l.subjectId))) } }, select: { id: true, code: true } });
    const code = new Map(subs.map((x) => [x.id, x.code]));
    const rooms = new Map(ctx.roomsAll.map((r) => [r.id, r.code]));
    const named = (l: Brief) => ({ ...l, subject: code.get(l.subjectId) ?? '?', teacher: l.teacherId ? ctx.teacherMeta.get(l.teacherId)?.name ?? null : null, room: l.roomId ? rooms.get(l.roomId) ?? null : null });
    return { summary: d.summary, added: d.added.map(named), removed: d.removed.map(named), changed: d.changed.map((c) => ({ key: c.key, fields: c.fields, before: named(c.before), after: named(c.after) })) };
  }

  /** Сводка по расписанию для главной страницы (без тяжёлых проверок) */
  async overview(versionId: string) {
    const v = await this.conflicts.version(versionId);
    const ctx = await this.ctxSvc.load(v.academicYear, v.term);
    const [lessons, byDay, byType] = await Promise.all([
      this.prisma.scheduleLesson.count({ where: { versionId } }),
      this.prisma.scheduleLesson.groupBy({ by: ['dayOfWeek'], where: { versionId }, _count: { _all: true } }),
      this.prisma.scheduleLesson.groupBy({ by: ['lessonTypeCode'], where: { versionId }, _count: { _all: true } }),
    ]);
    const [g, t, r] = await Promise.all([
      this.prisma.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(DISTINCT g) AS n FROM "ScheduleLesson", unnest("groupNames") AS g WHERE "versionId" = ${versionId}`,
      this.prisma.scheduleLesson.findMany({ where: { versionId, teacherId: { not: null } }, distinct: ['teacherId'], select: { teacherId: true } }),
      this.prisma.scheduleLesson.findMany({ where: { versionId, roomId: { not: null } }, distinct: ['roomId'], select: { roomId: true } }),
    ]);
    return {
      version: await this.get(versionId),
      lessons, groups: Number(g[0]?.n ?? 0), teachers: t.length, roomsUsed: r.length,
      totals: { groups: ctx.groups.length, teachers: ctx.teachers.length, rooms: ctx.rooms.length },
      byDay: byDay.map((d) => ({ day: d.dayOfWeek, count: d._count._all })), byType: byType.map((x) => ({ type: x.lessonTypeCode, count: x._count._all })),
    };
  }
}
