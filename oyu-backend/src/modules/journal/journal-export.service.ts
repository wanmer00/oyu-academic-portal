import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { Filters, JournalService, Viewer } from './journal.service';
import { AuditCtx } from './period.service';

const csvCell = (v: unknown): string => {
  let s = v == null ? '' : String(v);
  // защита от CSV/формула-инъекции при открытии в Excel
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const toCsv = (header: string[], rows: unknown[][]) => '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

/** Экспорт учитывает выбранные фильтры и роль (teacher — только своя область; leadership — широкая). */
@Injectable()
export class JournalExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: JournalService,
  ) {}

  async export(viewer: Viewer, f: Filters, kind: 'records' | 'answers', ctx: AuditCtx) {
    const { period, records } = await this.journal.load(viewer, f);
    await this.prisma.auditLog.create({
      data: {
        actorId: viewer.id,
        action: 'journal.export',
        targetType: 'Grade',
        diff: { kind, rows: records.length, academicYear: period.academicYear, term: period.term, subjectId: f.subjectId ?? null, groupName: f.groupName ?? null, status: f.status ?? null },
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      },
    });
    if (kind === 'answers') {
      const rows: unknown[][] = [];
      for (const r of records) {
        r.seminar.answers.forEach((a, i) =>
          rows.push([r.student.loginId, r.student.fullName, r.student.groupName, r.subject.code, period.academicYear, period.term, i + 1, a.score, a.published ? 'published' : 'draft', a.createdAt?.slice(0, 10) ?? '', a.comment ?? '']),
        );
      }
      return toCsv(['student_id', 'student', 'group', 'subject', 'academic_year', 'term', 'answer_no', 'score_of_10', 'state', 'date', 'comment'], rows);
    }
    return toCsv(
      ['student_id', 'student', 'group', 'faculty', 'subject', 'academic_year', 'term', 'seminar_answers', 'seminar_count', 'seminar_score_of_20', 'midterm_of_30', 'final_of_50', 'total_of_100', 'total_state', 'status', 'attendance_percent'],
      records.map((r) => [
        r.student.loginId,
        r.student.fullName,
        r.student.groupName,
        r.student.faculty,
        r.subject.code,
        period.academicYear,
        period.term,
        r.seminar.answers.map((a) => a.score).join('; '),
        r.seminar.count,
        r.seminar.eligible ? r.seminar.score : 'PENDING',
        r.midterm?.score ?? '',
        r.final?.score ?? '',
        r.total.score,
        r.total.final ? 'FINAL' : 'PROVISIONAL',
        r.status,
        r.attendance?.rate ?? '',
      ]),
    );
  }
}
