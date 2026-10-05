import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SettingsService } from './settings.service';
import { OrgScope } from '../../common/rbac/org-scope.service';
import { groupJournalRecords } from '../journal/journal.calc';
import { attendanceRate } from '../attendance/attendance.calc';
import { currentWeekParity } from '../students/students.service';

const DAY = 86_400_000;
const round1 = (n: number) => Math.round(n * 10) / 10;
/** Средний итог /100 по завершённым записям Journal */
const journalAvg = (rows: Parameters<typeof groupJournalRecords>[0]) => {
  const t = groupJournalRecords(rows).filter((g) => g.summary.complete).map((g) => Number(g.summary.total.exact));
  return t.length ? round1(t.reduce((a, b) => a + b, 0) / t.length) : null;
};
const mondayOf = (d: Date) => {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() || 7) - 1));
  return x;
};
const TERM_ORDER: Record<string, number> = { FALL: 1, SPRING: 2, SUMMER: 3 };
/** Действия, относящиеся к администрированию (для ленты на дашборде) */
const ADMIN_ACTION_PREFIXES = ['user.', 'student.', 'teacher.', 'group.', 'subject.', 'rbac.', 'settings.', 'schedule.', 'room.', 'calendar.', 'announcement.', 'request.', 'journal.period', 'attendance.delete', 'attendance.mark', 'journal.grade', 'journal.publish', 'journal.unpublish'];

/**
 * Сводка и тренды для руководства — только агрегаты реальных таблиц.
 * Если данных нет, соответствующий ряд возвращается пустым (UI не рисует график).
 */
@Injectable()
export class AdminOverviewService {
  constructor(private readonly prisma: PrismaService, private readonly settings: SettingsService) {}

  // ───────────────────────── Dashboard ─────────────────────────
  /** scope — область руководства (декан/зав. кафедрой/тьютор видят только свои группы) */
  async dashboard(scope?: OrgScope) {
    const g = scope?.groups ?? null;
    const sw: Prisma.StudentWhereInput = g ? { groupName: { in: g } } : {};
    const byStudent = g ? { student: { groupName: { in: g } } } : {};
    const slotW: Prisma.ScheduleSlotWhereInput = g ? { groupName: { in: g } } : {};
    const now = new Date();
    const since7 = new Date(now.getTime() - 7 * DAY);
    const since30 = new Date(now.getTime() - 30 * DAY);
    const dow = now.getUTCDay() || 7;
    const parity = currentWeekParity(now);

    const [
      usersByRole, usersByStatus, studentsByLevel, groups,
      att30, attAll, journalRows, grades7, subs7, asgActive,
      reqByStatus, reqPendingOld,
      payByStatus, overdue,
      slotsTotal, slotsToday, rooms, teachersWithSlots, teachersTotal,
      annTotal, annPinned, annRecent,
      active7d, gradesDraft, periodsOpen, recentActions,
    ] = await Promise.all([
      this.prisma.user.groupBy({ by: ['role'], where: { status: { not: 'DELETED' } }, _count: { _all: true } }),
      this.prisma.user.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.student.groupBy({ by: ['level'], where: sw, _count: { _all: true } }),
      this.prisma.student.groupBy({ by: ['groupName'], where: sw, _count: { _all: true } }),
      this.prisma.attendance.groupBy({ by: ['status'], where: { classDate: { gte: since30 }, ...byStudent }, _count: { _all: true } }),
      this.prisma.attendance.groupBy({ by: ['status'], where: byStudent, _count: { _all: true } }),
      this.prisma.grade.findMany({ where: { type: { in: ['SEMINAR', 'MIDTERM', 'FINAL'] }, publishedAt: { not: null }, ...byStudent }, select: { id: true, type: true, value: true, publishedAt: true, createdAt: true, updatedAt: true, subjectId: true, academicYear: true, term: true, studentId: true } }),
      this.prisma.grade.count({ where: { createdAt: { gte: since7 }, ...byStudent } }),
      this.prisma.submission.count({ where: { submittedAt: { gte: since7 }, ...byStudent } }),
      this.prisma.assignment.count({ where: { status: 'PUBLISHED', dueDate: { gte: now } } }),
      this.prisma.request.groupBy({ by: ['status'], where: g ? { user: byStudent } : {}, _count: { _all: true } }),
      this.prisma.request.count({ where: { status: 'PENDING', createdAt: { lt: new Date(now.getTime() - 7 * DAY) }, ...(g ? { user: byStudent } : {}) } }),
      this.prisma.payment.groupBy({ by: ['status'], where: byStudent, _count: { _all: true }, _sum: { amount: true } }),
      this.prisma.payment.aggregate({ where: { status: { in: ['PENDING', 'PROCESSING', 'FAILED'] }, dueDate: { lt: now }, ...byStudent }, _count: { _all: true }, _sum: { amount: true } }),
      this.prisma.scheduleSlot.count({ where: slotW }),
      this.prisma.scheduleSlot.count({ where: { dayOfWeek: dow, weekParity: { in: ['BOTH', parity] }, ...slotW } }),
      this.prisma.room.count(),
      this.prisma.scheduleSlot.findMany({ where: { teacherId: { not: null }, ...slotW }, distinct: ['teacherId'], select: { teacherId: true } }),
      this.prisma.teacher.count(),
      this.prisma.announcement.count(),
      this.prisma.announcement.count({ where: { pinned: true } }),
      this.prisma.announcement.findMany({ orderBy: { createdAt: 'desc' }, take: 4, select: { id: true, title: true, audience: true, priority: true, createdAt: true } }),
      this.prisma.user.count({ where: { status: 'ACTIVE', lastLoginAt: { gte: since7 } } }),
      this.prisma.grade.count({ where: { type: { in: ['SEMINAR', 'MIDTERM', 'FINAL'] }, publishedAt: null } }),
      this.prisma.academicPeriod.count({ where: { status: 'OPEN' } }),
      // последние административные действия (без diff): кто, что, над чем, результат
      this.prisma.auditLog.findMany({
        where: { OR: ADMIN_ACTION_PREFIXES.map((p) => ({ action: { startsWith: p } })) },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, createdAt: true, action: true, targetType: true, result: true, actor: { select: { fullName: true, loginId: true, role: true } } },
      }),
    ]);

    const rate = (rows: Array<{ status: string; _count: { _all: number } }>) =>
      attendanceRate({ total: rows.reduce((a, r) => a + r._count._all, 0), ABSENT: rows.find((r) => r.status === 'ABSENT')?._count._all ?? 0 });
    const byStatus = <T extends { status: string; _count: { _all: number } }>(rows: T[]) =>
      Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
    const conflicts = await this.countConflicts(g);

    return {
      scope: scope && scope.groups ? { kind: scope.kind, position: scope.position, label: scope.label, groups: scope.groups } : { kind: 'ALL', position: scope?.position ?? null },
      students: {
        total: g ? groups.reduce((a, r) => a + r._count._all, 0) : usersByRole.find((r) => r.role === Role.STUDENT)?._count._all ?? 0,
        byLevel: Object.fromEntries(studentsByLevel.map((r) => [r.level, r._count._all])),
        groups: groups.length,
      },
      teachers: { total: g ? teachersWithSlots.length : teachersTotal, withSchedule: teachersWithSlots.length },
      users: {
        byRole: Object.fromEntries(usersByRole.map((r) => [r.role, r._count._all])),
        byStatus: Object.fromEntries(usersByStatus.map((r) => [r.status, r._count._all])),
        active7d,
      },
      journal: { published: journalRows.length, drafts: gradesDraft, openPeriods: periodsOpen },
      recentActions: recentActions.map((a) => ({ id: a.id, at: a.createdAt.toISOString(), action: a.action, entity: a.targetType, result: a.result, actor: a.actor ? { fullName: a.actor.fullName, loginId: a.actor.loginId, role: a.actor.role } : null })),
      attendance: { rate30d: rate(att30), rateAll: rate(attAll), records30d: att30.reduce((a, r) => a + r._count._all, 0) },
      academic: {
        averageGrade: journalAvg(journalRows),
        gradesTotal: journalRows.length,
        grades7d: grades7,
        submissions7d: subs7,
        activeAssignments: asgActive,
      },
      requests: { byStatus: byStatus(reqByStatus), pendingOlderThan7d: reqPendingOld },
      payments: {
        byStatus: Object.fromEntries(payByStatus.map((r) => [r.status, { count: r._count._all, amount: Math.round(Number(r._sum.amount ?? 0)) }])),
        overdue: { count: overdue._count._all, amount: Math.round(Number(overdue._sum.amount ?? 0)) },
      },
      schedule: { slots: slotsTotal, today: slotsToday, rooms, conflicts },
      announcements: { total: annTotal, pinned: annPinned, recent: annRecent },
    };
  }

  private async countConflicts(g: string[] | null = null) {
    const all = await this.prisma.scheduleSlot.findMany({
      select: { id: true, dayOfWeek: true, startTime: true, endTime: true, weekParity: true, academicYear: true, term: true, teacherId: true, roomId: true, groupName: true },
    });
    // конфликт учитывается, если хотя бы одно из двух занятий относится к области
    const inScope = (s: { groupName: string }) => !g || g.includes(s.groupName);
    const slots = all;
    let n = 0;
    for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i], b = slots[j];
      if (a.dayOfWeek !== b.dayOfWeek || a.academicYear !== b.academicYear || a.term !== b.term) continue;
      if (!(a.weekParity === 'BOTH' || b.weekParity === 'BOTH' || a.weekParity === b.weekParity)) continue;
      if (!(a.startTime < b.endTime && b.startTime < a.endTime)) continue;
      if (!inScope(a) && !inScope(b)) continue;
      if ((a.teacherId && a.teacherId === b.teacherId) || (a.roomId && a.roomId === b.roomId) || a.groupName === b.groupName) n++;
    }
    return n;
  }

  // ───────────────────────── KPI / trends ─────────────────────────
  async kpi(weeks = 12, g: string[] | null = null) {
    const sw: Prisma.StudentWhereInput = g ? { groupName: { in: g } } : {};
    const byStudent = g ? { student: { groupName: { in: g } } } : {};
    const w = Math.min(Math.max(weeks, 4), 52);
    const now = new Date();
    const start = mondayOf(new Date(now.getTime() - (w - 1) * 7 * DAY));
    const weekKeys: string[] = [];
    for (let t = start.getTime(); t <= now.getTime(); t += 7 * DAY) weekKeys.push(new Date(t).toISOString().slice(0, 10));
    const wk = (d: Date) => mondayOf(d).toISOString().slice(0, 10);

    // Enrollment — текущий срез (исторических дат зачисления в модели нет)
    const [byLevel, byCourse, byGroup, byStatus] = await Promise.all([
      this.prisma.student.groupBy({ by: ['level'], where: sw, _count: { _all: true } }),
      this.prisma.student.groupBy({ by: ['course'], where: sw, _count: { _all: true }, orderBy: { course: 'asc' } }),
      this.prisma.student.groupBy({ by: ['groupName', 'level'], where: sw, _count: { _all: true }, orderBy: { groupName: 'asc' } }),
      this.prisma.user.groupBy({ by: ['status'], where: { role: 'STUDENT', ...(g ? { student: sw } : {}) }, _count: { _all: true } }),
    ]);

    // Attendance — недельные ряды по дате занятия. Занятия идут семестрами (с каникулами),
    // поэтому берём последние N недель, в которых реально были отметки, а не календарные недели.
    const attRows = await this.prisma.attendance.findMany({ where: byStudent, select: { classDate: true, status: true } });
    const attMap = new Map<string, { total: number; present: number; late: number; absent: number; excused: number }>();
    for (const r of attRows) {
      const k = wk(r.classDate);
      const e = attMap.get(k) ?? { total: 0, present: 0, late: 0, absent: 0, excused: 0 };
      e.total++;
      if (r.status === 'PRESENT') e.present++; else if (r.status === 'LATE') e.late++; else if (r.status === 'ABSENT') e.absent++; else e.excused++;
      attMap.set(k, e);
    }
    const attendanceTrend = Array.from(attMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-w)
      .map(([week, e]) => ({ week, ...e, rate: attendanceRate({ total: e.total, ABSENT: e.absent }) }));

    // Academic — средний % по семестрам (academicYear+term) + распределение
    const grades = await this.prisma.grade.findMany({ where: { type: { in: ['SEMINAR', 'MIDTERM', 'FINAL'] }, publishedAt: { not: null }, ...byStudent }, select: { id: true, type: true, value: true, publishedAt: true, createdAt: true, updatedAt: true, subjectId: true, academicYear: true, term: true, studentId: true } });
    const byTerm = new Map<string, { academicYear: string; term: string; sum: number; n: number; low: number }>();
    for (const g of groupJournalRecords(grades)) {
      if (!g.summary.complete) continue; // средний балл считается по завершённым записям Journal (итог /100)
      const k = g.academicYear + '|' + g.term;
      const e = byTerm.get(k) ?? { academicYear: g.academicYear, term: g.term, sum: 0, n: 0, low: 0 };
      const p = Number(g.summary.total.exact);
      e.sum += p; e.n++; if (p < this.settings.passMark) e.low++;
      byTerm.set(k, e);
    }
    const academicTrend = Array.from(byTerm.values())
      .sort((a, b) => a.academicYear.localeCompare(b.academicYear) || TERM_ORDER[a.term] - TERM_ORDER[b.term])
      .map((e) => ({ period: e.academicYear + ' ' + e.term, academicYear: e.academicYear, term: e.term, average: round1(e.sum / e.n), grades: e.n, lowShare: Math.round((e.low / e.n) * 100) }));
    const since = start;
    const subs = await this.prisma.submission.findMany({ where: { submittedAt: { gte: since }, ...byStudent }, select: { submittedAt: true, status: true } });
    const subsMap = new Map(weekKeys.map((k) => [k, 0]));
    for (const s of subs) { const k = wk(s.submittedAt!); if (subsMap.has(k)) subsMap.set(k, subsMap.get(k)! + 1); }

    // Requests — создано по неделям + текущий статус по типам
    const reqs = await this.prisma.request.findMany({ where: { createdAt: { gte: since }, ...(g ? { user: byStudent } : {}) }, select: { createdAt: true, status: true, type: true } });
    const reqMap = new Map(weekKeys.map((k) => [k, { created: 0, pending: 0, approved: 0, rejected: 0 }]));
    for (const r of reqs) {
      const e = reqMap.get(wk(r.createdAt)); if (!e) continue;
      e.created++;
      if (r.status === 'PENDING') e.pending++; else if (r.status === 'APPROVED') e.approved++; else e.rejected++;
    }
    const reqByType = await this.prisma.request.groupBy({ by: ['type', 'status'], where: g ? { user: byStudent } : {}, _count: { _all: true } });

    // Payments — оплачено по неделям (paidAt) и сумма
    const paid = await this.prisma.payment.findMany({ where: { status: 'PAID', paidAt: { gte: since }, ...byStudent }, select: { paidAt: true, amount: true } });
    const payMap = new Map(weekKeys.map((k) => [k, { count: 0, amount: 0 }]));
    for (const p of paid) { const e = payMap.get(wk(p.paidAt!)); if (e) { e.count++; e.amount += Number(p.amount); } }
    const payStatus = await this.prisma.payment.groupBy({ by: ['status'], where: byStudent, _count: { _all: true }, _sum: { amount: true } });

    return {
      weeks: w,
      enrollment: {
        note: 'snapshot', // исторических дат зачисления нет — только текущий срез
        byLevel: byLevel.map((r) => ({ level: r.level, count: r._count._all })),
        byCourse: byCourse.map((r) => ({ course: r.course, count: r._count._all })),
        byGroup: byGroup.map((r) => ({ groupName: r.groupName, level: r.level, count: r._count._all })),
        byStatus: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
      },
      attendanceTrend,
      academicTrend,
      submissionsTrend: subs.length ? weekKeys.map((k) => ({ week: k, count: subsMap.get(k)! })) : [],
      requestTrend: reqs.length ? weekKeys.map((k) => ({ week: k, ...reqMap.get(k)! })) : [],
      requestByType: reqByType.map((r) => ({ type: r.type, status: r.status, count: r._count._all })),
      paymentTrend: paid.length ? weekKeys.map((k) => ({ week: k, count: payMap.get(k)!.count, amount: Math.round(payMap.get(k)!.amount) })) : [],
      paymentByStatus: payStatus.map((r) => ({ status: r.status, count: r._count._all, amount: Math.round(Number(r._sum.amount ?? 0)) })),
    };
  }

  // ───────────────────────── Users ─────────────────────────
  async listUsers(p: { role?: Role; status?: UserStatus; search?: string; take?: number; cursor?: string; locked?: boolean }, groups: string[] | null = null) {
    const take = Math.min(p.take ?? 50, 200);
    // ограниченная область руководства: только студенты своих групп и преподаватели, ведущие в них занятия
    const where: Prisma.UserWhereInput = groups ? { AND: [{ OR: [{ student: { groupName: { in: groups } } }, { teacher: { scheduleSlots: { some: { groupName: { in: groups } } } } }] }] } : {};
    if (p.role) where.role = p.role;
    where.status = p.status ? p.status : { not: 'DELETED' };
    if (p.locked) where.lockedUntil = { gt: new Date() };
    if (p.search) {
      where.OR = [
        { fullName: { contains: p.search, mode: 'insensitive' } },
        { loginId: { contains: p.search } },
        { email: { contains: p.search, mode: 'insensitive' } },
        { student: { groupName: { contains: p.search, mode: 'insensitive' } } },
      ];
    }
    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        take: take + 1,
        ...(p.cursor && { cursor: { id: p.cursor }, skip: 1 }),
        orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
        select: {
          id: true, loginId: true, email: true, fullName: true, role: true, status: true, lastLoginAt: true, createdAt: true, lockedUntil: true,
          student: { select: { groupName: true, level: true, course: true } },
          teacher: { select: { department: true, title: true } },
        },
      }),
    ]);
    const hasMore = rows.length > take;
    const items = (hasMore ? rows.slice(0, take) : rows).map(({ lockedUntil, ...u }) => ({ ...u, locked: !!lockedUntil && lockedUntil > new Date() }));
    return { total, items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  /** Профиль пользователя для руководства — без хеша пароля, TOTP-секрета и токенов */
  async userProfile(id: string) {
    const u = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true, loginId: true, email: true, fullName: true, phone: true, role: true, status: true,
        preferredLang: true, lastLoginAt: true, createdAt: true, lockedUntil: true, failedLogins: true,
        student: { select: { faculty: true, specialty: true, groupName: true, course: true, semester: true, level: true } },
        teacher: { select: { department: true, title: true, experience: true } },
      },
    });
    if (!u) throw new NotFoundException('User not found');
    const since30 = new Date(Date.now() - 30 * DAY);
    const [logins30, failed30, requests] = await Promise.all([
      this.prisma.loginLog.count({ where: { userId: u.id, success: true, createdAt: { gte: since30 } } }),
      this.prisma.loginLog.count({ where: { loginId: u.loginId, success: false, createdAt: { gte: since30 } } }),
      this.prisma.request.findMany({ where: { userId: u.id }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, type: true, status: true, createdAt: true } }),
    ]);
    const extra: Record<string, unknown> = {};
    if (u.student) {
      const [grades, att, pay] = await Promise.all([
        this.prisma.grade.findMany({ where: { studentId: u.id, type: { in: ['SEMINAR', 'MIDTERM', 'FINAL'] }, publishedAt: { not: null } }, select: { id: true, type: true, value: true, publishedAt: true, createdAt: true, updatedAt: true, subjectId: true, academicYear: true, term: true, studentId: true } }),
        this.prisma.attendance.groupBy({ by: ['status'], where: { studentId: u.id }, _count: { _all: true } }),
        this.prisma.payment.aggregate({ where: { studentId: u.id, status: { in: ['PENDING', 'PROCESSING', 'FAILED'] } }, _sum: { amount: true } }),
      ]);
      const total = att.reduce((a, r) => a + r._count._all, 0);
      const absent = att.find((r) => r.status === 'ABSENT')?._count._all ?? 0;
      extra.studentStats = {
        gradesCount: grades.length,
        averageGrade: journalAvg(grades),
        attendanceRate: attendanceRate({ total, ABSENT: absent }),
        debtAzn: Math.round(Number(pay._sum.amount ?? 0)),
      };
    }
    if (u.teacher) {
      const slots = await this.prisma.scheduleSlot.findMany({ where: { teacherId: u.id }, include: { subject: { select: { code: true } } } });
      extra.teacherStats = {
        slots: slots.length,
        subjects: Array.from(new Set(slots.map((s) => s.subject.code))).sort(),
        groups: Array.from(new Set(slots.map((s) => s.groupName))).sort(),
      };
    }
    const { lockedUntil, ...rest } = u;
    return { ...rest, locked: !!lockedUntil && lockedUntil > new Date(), lockedUntil, activity: { logins30d: logins30, failedLogins30d: failed30 }, recentRequests: requests, ...extra };
  }
}
