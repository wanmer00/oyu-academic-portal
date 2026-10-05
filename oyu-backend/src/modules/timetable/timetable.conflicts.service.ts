import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { CLesson, CheckResult, Conflict, checkLessons } from './engine/checker';
import { TTContext, TimetableContextService } from './timetable.context.service';
import { checkInputFor, hhmm, toCLesson, toCRequirement } from './timetable.map';

export interface DescribedConflict extends Omit<Conflict, 'entity'> {
  entity?: { type: string; id: string; name: string | null };
  items: Array<{ lessonId: string; subject: string; subjectName: string; groups: string[]; teacher: string | null; room: string | null; day: number; start: string; end: string }>;
}

export interface VersionStats {
  lessons: number;
  groups: number;
  teachers: number;
  roomsUsed: number;
  critical: number;
  warnings: number;
  softCost: number;
  compliancePct: number;
  byCode: Record<string, number>;
  checkedAt: string;
}

@Injectable()
export class TimetableConflictsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctxSvc: TimetableContextService,
  ) {}

  async version(versionId: string) {
    const v = await this.prisma.scheduleVersion.findUnique({ where: { id: versionId } });
    if (!v) throw new NotFoundException('Schedule version not found');
    return v;
  }

  /** Полная проверка версии (все hard + soft). Результат сводки кладётся в ScheduleVersion.stats */
  async check(versionId: string, persist = true): Promise<{ result: CheckResult; ctx: TTContext; stats: VersionStats }> {
    const v = await this.version(versionId);
    const ctx = await this.ctxSvc.load(v.academicYear, v.term);
    const [lessons, reqs] = await Promise.all([
      this.prisma.scheduleLesson.findMany({ where: { versionId } }),
      this.prisma.lessonRequirement.findMany({ where: { academicYear: v.academicYear, term: v.term, isActive: true } }),
    ]);
    const result = checkLessons(checkInputFor(ctx, lessons.map(toCLesson), reqs.map(toCRequirement)));
    const stats: VersionStats = {
      lessons: lessons.length,
      groups: new Set(lessons.flatMap((l) => l.groupNames)).size,
      teachers: new Set(lessons.map((l) => l.teacherId).filter(Boolean)).size,
      roomsUsed: new Set(lessons.map((l) => l.roomId).filter(Boolean)).size,
      critical: result.summary.criticalCount,
      warnings: result.summary.warningCount,
      softCost: result.summary.softCost,
      compliancePct: result.summary.compliancePct,
      byCode: result.summary.byCode,
      checkedAt: new Date().toISOString(),
    };
    if (persist) await this.prisma.scheduleVersion.update({ where: { id: versionId }, data: { stats: stats as unknown as Prisma.InputJsonValue } });
    return { result, ctx, stats };
  }

  /** Подписи сущностей и участвующих занятий — для понятных сообщений в интерфейсе */
  async describe(conflicts: Conflict[], ctx: TTContext, proposed?: CLesson & { id: string }): Promise<DescribedConflict[]> {
    const lessonIds = Array.from(new Set(conflicts.flatMap((c) => c.lessonIds.slice(0, 4))));
    const lessons = lessonIds.length
      ? await this.prisma.scheduleLesson.findMany({ where: { id: { in: lessonIds } }, include: { subject: { select: { code: true, name: true } } } })
      : [];
    const byId = new Map(lessons.map((l) => [l.id, l]));
    // предложенное (ещё не сохранённое) занятие описывается его новыми значениями, а не записью из БД
    const propSubject = proposed ? await this.prisma.subject.findUnique({ where: { id: proposed.subjectId }, select: { code: true, name: true } }) : null
    const reqIds = Array.from(new Set(conflicts.filter((c) => c.entity?.type === 'requirement').map((c) => c.entity!.id)));
    const reqs = reqIds.length ? await this.prisma.lessonRequirement.findMany({ where: { id: { in: reqIds } }, include: { subject: { select: { code: true, name: true } } } }) : [];
    const reqName = new Map(reqs.map((r) => [r.id, `${r.subject.code} · ${r.lessonTypeCode} · ${r.groupNames.join(', ')}`]));
    const roomById = new Map(ctx.roomsAll.map((r) => [r.id, r]));
    const nameOf = (e: Conflict['entity']): string | null => {
      if (!e) return null;
      if (e.type === 'teacher') return ctx.teacherMeta.get(e.id)?.name ?? null;
      if (e.type === 'room') return roomById.get(e.id)?.code ?? null;
      if (e.type === 'group') return e.id;
      if (e.type === 'requirement') return reqName.get(e.id) ?? null;
      return null;
    };
    return conflicts.map((c) => ({
      code: c.code, severity: c.severity, params: c.params, cost: c.cost, lessonIds: c.lessonIds,
      entity: c.entity ? { type: c.entity.type, id: c.entity.id, name: nameOf(c.entity) } : undefined,
      items: c.lessonIds.slice(0, 4).map((id) => (proposed && id === proposed.id && propSubject ? ({ id, subject: propSubject, groupNames: proposed.groups, teacherId: proposed.teacherId, roomId: proposed.roomId, dayOfWeek: proposed.day, startTime: hhmm(proposed.start), endTime: hhmm(proposed.end) } as unknown as NonNullable<ReturnType<typeof byId.get>>) : byId.get(id))).filter((x): x is NonNullable<typeof x> => !!x).map((l) => ({
        lessonId: l.id, subject: l.subject.code, subjectName: l.subject.name, groups: l.groupNames,
        teacher: l.teacherId ? ctx.teacherMeta.get(l.teacherId)?.name ?? null : null, room: l.roomId ? roomById.get(l.roomId)?.code ?? null : null,
        day: l.dayOfWeek, start: l.startTime, end: l.endTime,
      })),
    }));
  }

  async report(versionId: string, q: { severity?: 'critical' | 'warning'; code?: string; take: number; refresh?: boolean }) {
    const { result, ctx, stats } = await this.check(versionId, true);
    let list = q.severity === 'critical' ? result.critical : q.severity === 'warning' ? result.warnings : [...result.critical, ...result.warnings];
    if (q.code) list = list.filter((c) => c.code === q.code);
    const shown = list.slice(0, q.take);
    return { stats, byCode: result.summary.byCode, total: list.length, truncated: list.length > shown.length, items: await this.describe(shown, ctx) };
  }

  /**
   * Быстрая проверка одного предложенного занятия: сравнивается только с занятиями версии,
   * которые делят с ним день и ресурс (преподаватель, аудитория, группы).
   */
  async checkProposed(versionId: string, proposed: CLesson & { id: string }, ctx: TTContext) {
    const rows = await this.prisma.scheduleLesson.findMany({
      where: {
        versionId,
        dayOfWeek: proposed.day,
        id: { not: proposed.id },
        OR: [
          ...(proposed.teacherId ? [{ teacherId: proposed.teacherId }] : []),
          ...(proposed.roomId ? [{ roomId: proposed.roomId }] : []),
          { groupNames: { hasSome: proposed.groups } },
        ],
      },
    });
    const all = [...rows.map(toCLesson), proposed];
    const res = checkLessons({ ...checkInputFor(ctx, all, []), softLimit: 500 });
    const mine = (c: Conflict) => c.lessonIds.includes(proposed.id);
    return { critical: res.critical.filter(mine), warnings: res.warnings.filter(mine) };
  }
}
