import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AttendanceStatus, PermissionScope, Prisma, Term } from '@prisma/client';
import { AuditCtx, AuditTrailService } from '../../common/audit/audit-trail.service';
import { Grant, PermissionsService } from '../../common/rbac/permissions.service';
import { Actor, ScopeService } from '../../common/rbac/scope.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { PeriodService } from '../journal/period.service';
import { TeacherAccessService } from '../teachers/teacher-access.service';
import { currentWeekParity } from '../students/students.service';
import { Counts, addStatus, attendanceRate, dayKey, emptyCounts, limitOf, parseClassDay } from './attendance.calc';
import { ClearDto, DayQuery, ExportQuery, MarkDto, ReportQuery, StatsQuery, StudentQuery } from './attendance.dto';

const DAY = 86_400_000;

/**
 * Academic Journal → Attendance. ЕДИНАЯ реализация посещаемости:
 * отметка, просмотр дня, статистика, экспорт, карточка студента (для студента/преподавателя/администратора), отчёты.
 * Доступ: право (PermissionsGuard) + scope (ASSIGNED — пары «предмет × группа» преподавателя, ALL — любой).
 */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeacherAccessService,
    private readonly periods: PeriodService,
    private readonly perms: PermissionsService,
    private readonly scopes: ScopeService,
    private readonly audit: AuditTrailService,
  ) {}

  // ───────────────────────── доступ к паре «предмет × группа» ─────────────────────────
  private async pair(actor: Actor, grant: Grant, subjectCode: string, groupName: string) {
    const subject = await this.prisma.subject.findUnique({ where: { code: subjectCode }, select: { id: true, code: true, name: true, credits: true } });
    if (!subject) throw new NotFoundException('Subject not found');
    if (grant.scope === PermissionScope.ASSIGNED) {
      await this.access.assertCanTeach(actor.id, subject.id, groupName);
    } else if (grant.scope === PermissionScope.ALL) {
      const slot = await this.prisma.scheduleSlot.findFirst({ where: { subjectId: subject.id, groupName }, select: { id: true } });
      if (!slot) throw new NotFoundException({ message: 'This subject is not taught in this group', code: 'NOT_SCHEDULED' });
    } else {
      throw new ForbiddenException({ message: 'Not available for your access level', code: 'SCOPE_DENIED' });
    }
    return subject;
  }

  private async caps(actor: Actor) {
    const has = (p: string) => this.perms.has(actor.role, p);
    const [canCreate, canUpdate, canDelete, canOverride] = await Promise.all([has('attendance.create'), has('attendance.update'), has('attendance.delete'), has('attendance.override')]);
    return { canCreate, canUpdate, canDelete, canOverride };
  }

  /** Закрытый период: правка возможна только с attendance.override */
  private async assertEditable(actor: Actor, date: Date) {
    const period = await this.periods.forDate(date);
    const closed = await this.periods.isClosed(period.academicYear, period.term);
    let override = false;
    if (closed) {
      if (!(await this.perms.has(actor.role, 'attendance.override'))) throw new ForbiddenException({ message: 'Academic period is closed', code: 'PERIOD_CLOSED' });
      override = true;
    }
    return { period, closed, override };
  }

  // ───────────────────────── день занятия ─────────────────────────
  async day(actor: Actor, grant: Grant, q: DayQuery) {
    const subject = await this.pair(actor, grant, q.subjectCode, q.groupName);
    const date = parseClassDay(q.classDate);
    if (!date) throw new BadRequestException('Invalid classDate');

    const calendarEvent = await this.prisma.calendarEvent.findFirst({
      where: {
        OR: [{ groupName: null }, { groupName: q.groupName }],
        AND: [{ eventDate: { lte: date } }, { OR: [{ endDate: { gte: date } }, { endDate: null, eventDate: date }] }],
      },
      orderBy: { eventDate: 'desc' },
    });
    const students = await this.prisma.student.findMany({
      where: { groupName: q.groupName, user: { status: 'ACTIVE' } },
      include: { user: { select: { loginId: true, fullName: true } } },
      orderBy: { user: { fullName: 'asc' } },
    });
    const existing = await this.prisma.attendance.findMany({ where: { subjectId: subject.id, classDate: date, studentId: { in: students.map((s) => s.userId) } } });
    const byStudent = new Map(existing.map((a) => [a.studentId, a.status]));

    const period = await this.periods.forDate(date);
    const dow = date.getUTCDay() || 7;
    const slot = await this.prisma.scheduleSlot.findFirst({
      where: { subjectId: subject.id, groupName: q.groupName, dayOfWeek: dow, weekParity: { in: ['BOTH', currentWeekParity(date)] } },
      select: { id: true },
    });
    const closed = await this.periods.isClosed(period.academicYear, period.term);
    const caps = await this.caps(actor);

    return {
      groupName: q.groupName,
      subject: { id: subject.id, code: subject.code, name: subject.name },
      classDate: date.toISOString(),
      period,
      locked: closed,
      scheduled: !!slot,
      caps: { ...caps, canEditNow: !closed || caps.canOverride },
      calendarEvent: calendarEvent ? { id: calendarEvent.id, type: calendarEvent.type, title: calendarEvent.title, description: calendarEvent.description } : null,
      students: students.map((s) => ({ userId: s.userId, loginId: s.user.loginId, fullName: s.user.fullName, status: byStudent.get(s.userId) ?? null })),
    };
  }

  // ───────────────────────── отметка ─────────────────────────
  async mark(actor: Actor, grant: Grant, dto: MarkDto, ctx: AuditCtx) {
    const subject = await this.pair(actor, grant, dto.subjectCode, dto.groupName);
    const date = parseClassDay(dto.classDate);
    if (!date) throw new BadRequestException('Invalid classDate');
    const endOfToday = new Date();
    endOfToday.setUTCHours(23, 59, 59, 999);
    if (date > endOfToday) throw new BadRequestException({ message: 'Attendance cannot be marked for a future date', code: 'FUTURE_DATE' });
    const { period, override } = await this.assertEditable(actor, date);

    const loginIds = Array.from(new Set(dto.entries.map((e) => e.studentLoginId)));
    if (loginIds.length !== dto.entries.length) throw new BadRequestException({ message: 'Duplicate students in request', code: 'DUPLICATE_ENTRY' });
    const users = await this.prisma.user.findMany({ where: { loginId: { in: loginIds } }, include: { student: true } });
    const byLogin = new Map(users.map((u) => [u.loginId, u]));
    const foreign = dto.entries.filter((e) => {
      const u = byLogin.get(e.studentLoginId);
      return !u || u.student?.groupName !== dto.groupName || u.status !== 'ACTIVE';
    });
    if (foreign.length) throw new ForbiddenException({ message: 'Some students are not in this group', studentLoginIds: foreign.map((f) => f.studentLoginId) });

    const studentIds = dto.entries.map((e) => byLogin.get(e.studentLoginId)!.id);
    const before = await this.prisma.attendance.findMany({ where: { subjectId: subject.id, classDate: date, studentId: { in: studentIds } }, select: { studentId: true, status: true } });
    const oldBy = new Map(before.map((b) => [b.studentId, b.status]));
    const changes = dto.entries
      .map((e) => ({ studentLoginId: e.studentLoginId, studentId: byLogin.get(e.studentLoginId)!.id, old: oldBy.get(byLogin.get(e.studentLoginId)!.id) ?? null, new: e.status }))
      .filter((c) => c.old !== c.new);
    // Изменение уже существующей отметки — отдельное право attendance.update
    if (changes.some((c) => c.old !== null)) await this.perms.require(actor.role, 'attendance.update');

    await this.prisma.$transaction(async (tx) => {
      for (const c of changes) {
        await tx.attendance.upsert({
          where: { studentId_subjectId_classDate: { studentId: c.studentId, subjectId: subject.id, classDate: date } },
          update: { status: c.new, markedBy: actor.id, academicYear: period.academicYear, term: period.term },
          create: { studentId: c.studentId, subjectId: subject.id, classDate: date, status: c.new, markedBy: actor.id, academicYear: period.academicYear, term: period.term },
        });
      }
      if (changes.length) {
        const byStatus: Record<string, number> = {};
        for (const c of changes) byStatus[c.new] = (byStatus[c.new] ?? 0) + 1;
        await this.audit.recordTx(
          tx,
          {
            actorId: actor.id,
            action: 'attendance.mark',
            targetType: 'Attendance',
            extra: {
              groupName: dto.groupName, subjectId: subject.id, subjectCode: subject.code, classDate: date.toISOString(),
              academicYear: period.academicYear, term: period.term, count: changes.length, byStatus, override,
              changes: changes.map((c) => ({ studentLoginId: c.studentLoginId, old: c.old, new: c.new })),
            },
          },
          ctx,
        );
      }
    });
    return { saved: dto.entries.length, changed: changes.length };
  }

  // ───────────────────────── удаление отметки (исправление ошибки) ─────────────────────────
  async clear(actor: Actor, grant: Grant, dto: ClearDto, ctx: AuditCtx) {
    const subject = await this.pair(actor, grant, dto.subjectCode, dto.groupName);
    const date = parseClassDay(dto.classDate);
    if (!date) throw new BadRequestException('Invalid classDate');
    const { period, override } = await this.assertEditable(actor, date);
    const users = await this.prisma.user.findMany({ where: { loginId: { in: dto.studentLoginIds } }, include: { student: true } });
    const ok = users.filter((u) => u.student?.groupName === dto.groupName);
    if (ok.length !== new Set(dto.studentLoginIds).size) throw new ForbiddenException('Some students are not in this group');
    const rows = await this.prisma.attendance.findMany({ where: { subjectId: subject.id, classDate: date, studentId: { in: ok.map((u) => u.id) } }, select: { id: true, studentId: true, status: true } });
    if (!rows.length) return { deleted: 0 };
    const loginById = new Map(ok.map((u) => [u.id, u.loginId]));
    await this.prisma.$transaction(async (tx) => {
      await tx.attendance.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      await this.audit.recordTx(
        tx,
        {
          actorId: actor.id,
          action: 'attendance.delete',
          targetType: 'Attendance',
          extra: {
            groupName: dto.groupName, subjectId: subject.id, subjectCode: subject.code, classDate: date.toISOString(),
            academicYear: period.academicYear, term: period.term, reason: dto.reason ?? null, override,
            changes: rows.map((r) => ({ studentLoginId: loginById.get(r.studentId), old: r.status, new: null })),
          },
        },
        ctx,
      );
    });
    return { deleted: rows.length };
  }

  // ───────────────────────── статистика по предмету × группе ─────────────────────────
  async stats(actor: Actor, grant: Grant, q: StatsQuery) {
    const subject = await this.pair(actor, grant, q.subjectCode, q.groupName);
    const to = q.to ? new Date(q.to) : new Date();
    to.setUTCHours(23, 59, 59, 999);
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * DAY);
    from.setUTCHours(0, 0, 0, 0);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw new BadRequestException('Invalid date range');
    if (to.getTime() - from.getTime() > 400 * DAY) throw new BadRequestException('Date range is too long (max 400 days)');

    const students = await this.prisma.student.findMany({
      where: { groupName: q.groupName, user: { status: 'ACTIVE', ...(q.studentLoginId ? { loginId: q.studentLoginId } : {}) } },
      include: { user: { select: { loginId: true, fullName: true } } },
      orderBy: { user: { fullName: 'asc' } },
    });
    if (q.studentLoginId && !students.length) throw new NotFoundException('Student not found in this group');
    const rows = await this.prisma.attendance.findMany({
      where: { subjectId: subject.id, studentId: { in: students.map((s) => s.userId) }, classDate: { gte: from, lte: to } },
      select: { studentId: true, status: true, classDate: true },
    });
    const per = new Map(students.map((s) => [s.userId, emptyCounts()]));
    const perDate = new Map<string, Counts>();
    for (const r of rows) {
      addStatus(per.get(r.studentId)!, r.status);
      const k = dayKey(r.classDate);
      addStatus(perDate.get(k) ?? perDate.set(k, emptyCounts()).get(k)!, r.status);
    }
    const tot = emptyCounts();
    for (const c of per.values()) for (const k of ['PRESENT', 'LATE', 'ABSENT', 'EXCUSED', 'total'] as const) tot[k] += c[k];

    return {
      groupName: q.groupName,
      subject: { id: subject.id, code: subject.code, name: subject.name },
      from: dayKey(from),
      to: dayKey(to),
      classDays: perDate.size,
      totals: { ...tot, rate: attendanceRate(tot) },
      students: students.map((s) => {
        const c = per.get(s.userId)!;
        const lim = limitOf(c, subject.credits);
        return {
          userId: s.userId, loginId: s.user.loginId, fullName: s.user.fullName,
          present: c.PRESENT, late: c.LATE, absent: c.ABSENT, excused: c.EXCUSED, total: c.total, rate: attendanceRate(c),
          limit: { max: lim.max, counted: lim.counted, exceeded: lim.exceeded },
        };
      }),
      days: Array.from(perDate.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([date, c]) => ({ date, present: c.PRESENT, late: c.LATE, absent: c.ABSENT, excused: c.EXCUSED, total: c.total })),
    };
  }

  // ───────────────────────── CSV ─────────────────────────
  private csvCell(v: unknown): string {
    let s = v == null ? '' : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // защита от формула-инъекции в Excel
    return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  async exportCsv(actor: Actor, grant: Grant, q: ExportQuery, ctx: AuditCtx) {
    const subject = await this.pair(actor, grant, q.subjectCode, q.groupName);
    const where: Prisma.AttendanceWhereInput = { subjectId: subject.id, student: { groupName: q.groupName } };
    if (q.from || q.to) where.classDate = { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) };
    const rows = await this.prisma.attendance.findMany({
      where,
      include: { student: { include: { user: { select: { loginId: true, fullName: true } } } } },
      orderBy: [{ classDate: 'asc' }, { student: { user: { fullName: 'asc' } } }],
      take: 20000,
    });
    await this.audit.record({ actorId: actor.id, action: 'attendance.export', targetType: 'Attendance', extra: { groupName: q.groupName, subjectCode: q.subjectCode, rows: rows.length } }, ctx);
    const header = ['date', 'loginId', 'fullName', 'group', 'subject', 'status'];
    const lines = rows.map((r) => [dayKey(r.classDate), r.student.user.loginId, r.student.user.fullName, q.groupName, subject.code, r.status]);
    return '﻿' + [header, ...lines].map((r) => r.map((c) => this.csvCell(c)).join(',')).join('\r\n') + '\r\n';
  }

  // ───────────────────────── студент: своя посещаемость / дети / любой (по scope) ─────────────────────────
  async student(actor: Actor, grant: Grant, q: StudentQuery) {
    const studentId = await this.scopes.resolveStudentId(actor, grant, q.studentId);
    const st = await this.prisma.student.findUnique({ where: { userId: studentId }, select: { groupName: true, user: { select: { loginId: true, fullName: true } } } });
    if (!st) throw new NotFoundException('Student not found');
    const cur = this.periods.current();
    const period: { academicYear: string; term: Term } = { academicYear: q.academicYear ?? cur.academicYear, term: q.term ?? (cur.term as Term) };

    const [rows, slots] = await Promise.all([
      this.prisma.attendance.findMany({
        where: { studentId, ...period },
        include: { subject: { select: { id: true, code: true, name: true, credits: true, color: true } } },
        orderBy: { classDate: 'desc' },
        take: 2000,
      }),
      this.prisma.scheduleSlot.findMany({ where: { groupName: st.groupName, ...period }, distinct: ['subjectId'], include: { subject: { select: { id: true, code: true, name: true, credits: true, color: true } } } }),
    ]);
    const subjects = new Map<string, { subject: { id: string; code: string; name: string; credits: number; color: string | null }; counts: Counts; records: Array<{ date: string; status: AttendanceStatus }> }>();
    const touch = (s: { id: string; code: string; name: string; credits: number; color: string | null }) =>
      subjects.get(s.id) ?? subjects.set(s.id, { subject: s, counts: emptyCounts(), records: [] }).get(s.id)!;
    for (const sl of slots) touch(sl.subject);
    for (const r of rows) {
      const e = touch(r.subject);
      addStatus(e.counts, r.status);
      e.records.push({ date: dayKey(r.classDate), status: r.status });
    }
    const items = Array.from(subjects.values())
      .sort((a, b) => a.subject.code.localeCompare(b.subject.code))
      .map(({ subject, counts, records }) => {
        const lim = limitOf(counts, subject.credits);
        return {
          subject,
          total: counts.total, present: counts.PRESENT, late: counts.LATE, absent: counts.ABSENT, excused: counts.EXCUSED,
          rate: attendanceRate(counts),
          counted: lim.counted, max: lim.max, remaining: lim.remaining, percentage: lim.percentage, status: lim.status,
          records: records.slice(0, 60),
        };
      });
    const all = emptyCounts();
    for (const i of items) { all.PRESENT += i.present; all.LATE += i.late; all.ABSENT += i.absent; all.EXCUSED += i.excused; all.total += i.total; }
    return {
      student: { id: studentId, loginId: st.user.loginId, fullName: st.user.fullName, groupName: st.groupName },
      period,
      totals: { total: all.total, present: all.PRESENT, late: all.LATE, absent: all.ABSENT, excused: all.EXCUSED, rate: attendanceRate(all) },
      exceeded: items.filter((i) => i.status === 'EXCEEDED').length,
      subjects: items,
    };
  }

  // ───────────────────────── отчёт (Reports → Attendance): группы и недели ─────────────────────────
  async report(actor: Actor, grant: Grant, q: ReportQuery) {
    const to = q.to ? new Date(q.to) : new Date();
    to.setUTCHours(23, 59, 59, 999);
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 56 * DAY);
    from.setUTCHours(0, 0, 0, 0);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw new BadRequestException('Invalid date range');
    if (to.getTime() - from.getTime() > 400 * DAY) throw new BadRequestException('Date range is too long (max 400 days)');

    let groupFilter: string[] | null = null;
    if (grant.scope === PermissionScope.ASSIGNED) {
      const sc = await this.access.scope(actor.id);
      groupFilter = sc.groups;
      if (q.groupName && !groupFilter.includes(q.groupName)) throw new ForbiddenException({ message: 'You do not teach this group', code: 'SCOPE_DENIED' });
    } else if (grant.scope !== PermissionScope.ALL) {
      throw new ForbiddenException({ message: 'Not available for your access level', code: 'SCOPE_DENIED' });
    }
    if (q.groupName) groupFilter = [q.groupName];

    const rows = await this.prisma.attendance.findMany({
      where: { classDate: { gte: from, lte: to }, ...(groupFilter ? { student: { groupName: { in: groupFilter } } } : {}) },
      select: { status: true, classDate: true, studentId: true, subject: { select: { credits: true, id: true } }, student: { select: { groupName: true } } },
    });
    const byGroup = new Map<string, Counts>();
    const byWeek = new Map<string, Counts>();
    const perStudentSubject = new Map<string, { counts: Counts; credits: number; group: string; studentId: string }>();
    const weekStart = (d: Date) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return dayKey(x); };
    const tot = emptyCounts();
    for (const r of rows) {
      addStatus(byGroup.get(r.student.groupName) ?? byGroup.set(r.student.groupName, emptyCounts()).get(r.student.groupName)!, r.status);
      const wk = weekStart(r.classDate);
      addStatus(byWeek.get(wk) ?? byWeek.set(wk, emptyCounts()).get(wk)!, r.status);
      addStatus(tot, r.status);
      const k = r.studentId + '|' + r.subject.id;
      addStatus((perStudentSubject.get(k) ?? perStudentSubject.set(k, { counts: emptyCounts(), credits: r.subject.credits, group: r.student.groupName, studentId: r.studentId }).get(k)!).counts, r.status);
    }
    const exceeded = Array.from(perStudentSubject.values()).filter((e) => limitOf(e.counts, e.credits).exceeded);
    const row = (key: string, c: Counts) => ({ key, total: c.total, present: c.PRESENT, late: c.LATE, absent: c.ABSENT, excused: c.EXCUSED, rate: attendanceRate(c) });
    return {
      from: dayKey(from),
      to: dayKey(to),
      totals: row('all', tot),
      groups: Array.from(byGroup.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([k, c]) => row(k, c)),
      weeks: Array.from(byWeek.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([k, c]) => row(k, c)),
      limitExceeded: { students: new Set(exceeded.map((e) => e.studentId)).size, records: exceeded.length },
    };
  }
}
