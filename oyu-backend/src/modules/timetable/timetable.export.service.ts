import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { AuditCtx, AuditTrailService } from '../../common/audit/audit-trail.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { TimetableConflictsService } from './timetable.conflicts.service';
import { TimetableContextService } from './timetable.context.service';
import { Actor, TimetableLessonsService } from './timetable.lessons.service';

type Lang = 'az' | 'ru' | 'en';
const L: Record<Lang, { days: string[]; cols: string[]; sheet: string; grid: string; parity: Record<string, string> }> = {
  ru: { days: ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'], cols: ['День', 'Начало', 'Конец', 'Пара', 'Код предмета', 'Предмет', 'Тип', 'Группы', 'Преподаватель', 'Аудитория', 'Корпус', 'Неделя', 'Зафиксировано'], sheet: 'Расписание', grid: 'Сетка', parity: { BOTH: 'каждая', UPPER: 'верхняя', LOWER: 'нижняя' } },
  az: { days: ['', 'B.e.', 'Ç.a.', 'Çər', 'C.a.', 'Cümə', 'Şən', 'Baz'], cols: ['Gün', 'Başlama', 'Bitmə', 'Cüt', 'Fənn kodu', 'Fənn', 'Növ', 'Qruplar', 'Müəllim', 'Otaq', 'Korpus', 'Həftə', 'Sabitlənib'], sheet: 'Cədvəl', grid: 'Şəbəkə', parity: { BOTH: 'hər', UPPER: 'üst', LOWER: 'alt' } },
  en: { days: ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], cols: ['Day', 'Start', 'End', 'Slot', 'Subject code', 'Subject', 'Type', 'Groups', 'Teacher', 'Room', 'Building', 'Week', 'Locked'], sheet: 'Timetable', grid: 'Grid', parity: { BOTH: 'every', UPPER: 'upper', LOWER: 'lower' } },
};

@Injectable()
export class TimetableExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctxSvc: TimetableContextService,
    private readonly conflicts: TimetableConflictsService,
    private readonly lessons: TimetableLessonsService,
    private readonly audit: AuditTrailService,
  ) {}

  private cell(v: unknown): string {
    let s = v == null ? '' : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // защита от формула-инъекции
    return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  async export(actor: Actor, versionId: string, q: { format: 'csv' | 'xlsx'; by: string; value?: string; day?: number; lang?: Lang }, ctxA: AuditCtx) {
    const v = await this.conflicts.version(versionId);
    const ctx = await this.ctxSvc.load(v.academicYear, v.term);
    const lang: Lang = q.lang && L[q.lang] ? q.lang : 'ru';
    const T = L[lang];
    const and: Prisma.ScheduleLessonWhereInput[] = [{ versionId }];
    const need = (x?: string) => { if (!x) throw new BadRequestException({ message: 'value is required for this export', code: 'VALUE_REQUIRED' }); return x; };
    if (q.by === 'group') and.push({ groupNames: { has: need(q.value) } });
    else if (q.by === 'teacher') and.push({ teacherId: need(q.value) });
    else if (q.by === 'room') and.push({ roomId: need(q.value) });
    else if (q.by === 'faculty') and.push({ groupNames: { hasSome: Array.from(ctx.groupMeta.values()).filter((g) => g.faculty === need(q.value)).map((g) => g.name) } });
    else if (q.by === 'day') and.push({ dayOfWeek: Number(q.day ?? q.value) });
    const rows = await this.prisma.scheduleLesson.findMany({ where: { AND: and }, orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }], take: 60000 });
    const items = await this.lessons.enrich(rows, ctx);
    const data = items.map((i) => [T.days[i.day], i.start, i.end, i.slotCode ?? '', i.subject.code, i.subject.name, i.typeName, i.groups.join(', '), i.teacher?.name ?? '', i.room?.code ?? '', i.room?.building ?? '', T.parity[i.parity] ?? i.parity, i.locked ? '✓' : '']);
    await this.audit.record({ actorId: actor.id, action: 'timetable.export', targetType: 'ScheduleVersion', targetId: versionId, new: { format: q.format, by: q.by, rows: data.length }, extra: { version: v.number } }, ctxA);

    const base = `timetable-v${v.number}${q.by !== 'all' ? '-' + q.by : ''}`;
    if (q.format === 'csv') {
      const csv = '﻿' + [T.cols, ...data].map((r) => r.map((c) => this.cell(c)).join(',')).join('\r\n') + '\r\n';
      return { filename: base + '.csv', mime: 'text/csv; charset=utf-8', body: Buffer.from(csv, 'utf8') };
    }
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Odlar Yurdu University';
    const ws = wb.addWorksheet(T.sheet, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.addRow(T.cols);
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    for (const r of data) ws.addRow(r);
    const widths = [8, 8, 8, 8, 14, 32, 16, 24, 28, 12, 12, 10, 14];
    ws.columns.forEach((c, i) => (c.width = widths[i] ?? 14));
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: T.cols.length } };
    // для одной сущности (группа / преподаватель / аудитория) добавляем недельную сетку
    if (['group', 'teacher', 'room'].includes(q.by)) {
      const g = wb.addWorksheet(T.grid);
      const days = ctx.config.workingDays;
      g.addRow(['', ...days.map((d) => T.days[d])]);
      g.getRow(1).font = { bold: true };
      const slots = ctx.slotsAll.filter((s) => s.shift !== null || true).sort((a, b) => a.start - b.start);
      for (const s of slots) {
        const hh = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        const cells = days.map((d) => items.filter((i) => i.day === d && i.start === hh(s.start)).map((i) => `${i.subject.code} ${i.typeName}${i.room ? ' · ' + i.room.code : ''}${q.by === 'group' && i.teacher ? ' · ' + i.teacher.name : ''}${q.by !== 'group' ? ' · ' + i.groups.join('+') : ''}`).join('\n'));
        if (cells.some(Boolean)) g.addRow([`${s.code} ${hh(s.start)}–${hh(s.end)}`, ...cells]);
      }
      g.columns.forEach((c) => (c.width = 30));
      g.eachRow((row) => row.eachCell((c) => (c.alignment = { wrapText: true, vertical: 'top' })));
    }
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    return { filename: base + '.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: buf };
  }
}
