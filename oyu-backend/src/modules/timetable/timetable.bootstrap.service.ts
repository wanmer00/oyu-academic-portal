import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { WeekParity } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/**
 * При первом запуске переносит уже существующее (живое) расписание ScheduleSlot в систему версий:
 * создаётся опубликованная версия v1, нагрузка (LessonRequirement) и занятия (ScheduleLesson).
 * Идемпотентно: период, у которого уже есть версия, не трогается.
 */
@Injectable()
export class TimetableBootstrapService implements OnModuleInit {
  private readonly log = new Logger('Timetable');
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    try {
      await this.importExisting();
    } catch (e: any) {
      this.log.error('Baseline import failed: ' + (e?.message ?? e));
    }
  }

  async importExisting() {
    const periods = await this.prisma.scheduleSlot.groupBy({ by: ['academicYear', 'term'], _count: { _all: true } });
    for (const p of periods) {
      if (await this.prisma.scheduleVersion.count({ where: { academicYear: p.academicYear, term: p.term } })) continue;
      const slots = await this.prisma.scheduleSlot.findMany({ where: { academicYear: p.academicYear, term: p.term } });
      const types = new Set((await this.prisma.lessonType.findMany({ select: { code: true } })).map((t) => t.code));
      const timeSlots = await this.prisma.timeSlot.findMany();

      // слоты одного потока (streamKey) объединяются в одно занятие
      const groups = new Map<string, typeof slots>();
      for (const s of slots) { const k = s.streamKey ?? s.id; (groups.get(k) ?? groups.set(k, []).get(k)!).push(s); }

      await this.prisma.$transaction(async (tx) => {
        const v = await tx.scheduleVersion.create({ data: { academicYear: p.academicYear, term: p.term, number: 1, name: 'Initial timetable', status: 'PUBLISHED', publishedAt: new Date(), note: 'Created automatically from the current live schedule' } });
        const reqs = new Map<string, { id: string; count: number }>();
        const lessonRows: Array<Parameters<typeof tx.scheduleLesson.create>[0]['data']> = [];
        for (const list of groups.values()) {
          const s = list[0];
          const type = types.has(s.type) ? s.type : 'other';
          const groupNames = Array.from(new Set(list.map((x) => x.groupName))).sort();
          const rk = [s.subjectId, groupNames.join('+'), type, s.teacherId ?? '', s.weekParity].join('|');
          let r = reqs.get(rk);
          if (!r) {
            const created = await tx.lessonRequirement.create({ data: { academicYear: p.academicYear, term: p.term, subjectId: s.subjectId, groupNames, teacherId: s.teacherId, lessonTypeCode: type, sessionsPerWeek: 0, weekParity: s.weekParity as WeekParity, level: s.level } });
            r = { id: created.id, count: 0 };
            reqs.set(rk, r);
          }
          const ts = timeSlots.find((t) => t.startTime === s.startTime && t.endTime === s.endTime);
          lessonRows.push({
            versionId: v.id, requirementId: r.id, sessionIndex: r.count++, subjectId: s.subjectId, teacherId: s.teacherId, roomId: s.roomId, groupNames, lessonTypeCode: type,
            dayOfWeek: s.dayOfWeek, timeSlotId: ts?.id ?? null, startTime: s.startTime, endTime: s.endTime, weekParity: s.weekParity, level: s.level,
          } as never);
        }
        for (const r of reqs.values()) { await tx.lessonRequirement.update({ where: { id: r.id }, data: { sessionsPerWeek: r.count } }); }
        await tx.scheduleLesson.createMany({ data: lessonRows as never });
      });
      this.log.log(`Imported ${slots.length} live slots of ${p.academicYear} ${p.term} into schedule version v1`);
    }
  }
}
