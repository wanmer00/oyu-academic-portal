import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AttendanceService } from '../../attendance/attendance.service';
import { StudentsService, currentWeekParity } from '../../students/students.service';
import { AssignmentsService } from '../../assignments/assignments.service';
import { JournalService } from '../../journal/journal.service';
import { RequestsService } from '../../requests/requests.service';
import { PaymentsService } from '../../payments/payments.service';
import { TeachersService } from '../../teachers/teachers.service';
import { TeacherAccessService } from '../../teachers/teacher-access.service';
import { AdminOverviewService } from '../../admin/admin-overview.service';
import { AdminAnalyticsService } from '../../admin/admin-analytics.service';
import { AuditCenterService } from '../../audit/audit.service';
import { AuditAnomaliesService } from '../../audit/audit-anomalies.service';
import { ALL_TOPICS_BY_ROLE, Role, Topic } from './topics';

const NO_CAPS = { create: false, update: false, delete: false, publish: false, override: false };
export interface AIUser { id: string; loginId: string; role: Role; fullName: string }

const round1 = (n: number) => Math.round(n * 10) / 10;
const day = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const cut = (s: string | null | undefined, n: number) => (s ? (s.length > n ? s.slice(0, n) + '…' : s) : null);

/**
 * Собирает КОМПАКТНЫЙ контекст для ассистента.
 * Правила:
 *  1) тема должна принадлежать роли (проверяется ещё раз здесь — defense in depth);
 *  2) данные читаются теми же сервисами, что и обычные эндпоинты роли, с userId из JWT
 *     (студент → только свои данные; преподаватель → только свои пары предмет×группа, и т.д.);
 *  3) в контекст попадают только агрегаты и короткие списки — без паролей, токенов, хешей,
 *     email/телефонов, userAgent и сырых diff аудита.
 */
@Injectable()
export class AIContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly students: StudentsService,
    private readonly assignments: AssignmentsService,
    private readonly requests: RequestsService,
    private readonly payments: PaymentsService,
    private readonly teachers: TeachersService,
    private readonly access: TeacherAccessService,
    private readonly adminOverview: AdminOverviewService,
    private readonly analytics: AdminAnalyticsService,
    private readonly security: AuditCenterService,
    private readonly anomalies: AuditAnomaliesService,
    private readonly journal: JournalService,
    private readonly attendance: AttendanceService,
  ) {}

  private assertTopic(user: AIUser, topic: Topic) {
    if (!ALL_TOPICS_BY_ROLE[user.role]?.includes(topic)) {
      throw new ForbiddenException(`Topic ${topic} is not available for role ${user.role}`);
    }
  }

  /**
   * Проверка упомянутых Login ID: возвращает разрешённые и запрещённые.
   * STUDENT — только свой; TEACHER — студенты своих групп; ADMIN — любой пользователь;
   * SUPER_ADMIN — любой пользователь, включая разрезы журналов входов и аудита.
   */
  async checkMentions(user: AIUser, loginIds: string[]) {
    const allowed: string[] = [], denied: string[] = [];
    if (!loginIds.length) return { allowed, denied };
    if (user.role === 'STUDENT') {
      for (const id of loginIds) (id === user.loginId ? allowed : denied).push(id);
      return { allowed, denied };
    }
    if (user.role === 'TEACHER') {
      const scope = await this.access.scope(user.id);
      const rows = await this.prisma.user.findMany({ where: { loginId: { in: loginIds } }, select: { loginId: true, student: { select: { groupName: true } } } });
      for (const id of loginIds) {
        const r = rows.find((x) => x.loginId === id);
        (r?.student && scope.groups.includes(r.student.groupName) ? allowed : denied).push(id);
      }
      return { allowed, denied };
    }
    return { allowed: loginIds, denied };
  }

  async build(user: AIUser, topics: Topic[], mentions: string[]) {
    const ctx: Record<string, unknown> = {};
    for (const t of topics) {
      this.assertTopic(user, t);
      ctx[t] = await this.topic(user, t, mentions);
    }
    return ctx;
  }

  private async topic(user: AIUser, t: Topic, mentions: string[]): Promise<unknown> {
    const now = new Date();
    switch (t) {
      // ───────────────────────── STUDENT (только свои данные) ─────────────────────────
      case 's_schedule_today': {
        const { slots, currentWeekParity: parity } = await this.students.getMySchedule(user.id);
        const dow = now.getUTCDay() || 7;
        const today = slots
          .filter((s) => s.dayOfWeek === dow && (s.weekParity === 'BOTH' || s.weekParity === parity))
          .sort((a, b) => a.startTime.localeCompare(b.startTime))
          .map((s) => ({ time: `${s.startTime}-${s.endTime}`, subject: `${s.subject.code} ${s.subject.name}`, room: s.room, type: s.type, teacher: s.teacher?.fullName ?? null }));
        const next = today.length ? null : this.nextStudentDay(slots, parity, now);
        return { date: day(now), weekday: dow, weekParity: parity, classes: today, nextClassDay: next };
      }
      case 's_assignments': {
        const items = await this.assignments.getForStudent(user.id);
        const pending = items.filter((a) => !a.submission || a.submission.status === 'PENDING');
        const overdue = pending.filter((a) => new Date(a.dueDate) < now);
        const upcoming = pending.filter((a) => new Date(a.dueDate) >= now).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
        const map = (a: typeof items[number]) => ({ title: cut(a.title, 60), subject: a.subject.code, due: day(a.dueDate), maxGrade: a.maxGrade });
        return {
          counts: { total: items.length, upcoming: upcoming.length, overdue: overdue.length, submitted: items.length - pending.length, graded: items.filter((a) => a.submission?.status === 'GRADED').length },
          upcoming: upcoming.slice(0, 6).map(map),
          overdue: overdue.slice(0, 4).map(map),
        };
      }
      case 's_gpa': {
        const tr = await this.students.getTranscript(user.id);
        return {
          scale: '4.0; letter from 100-point: A≥90(4.0) B≥75(3.0..3.5) C≥60(2.0..2.5) F<60',
          cumulativeGPA: tr.summary.cumulativeGPA,
          earnedCredits: tr.summary.earnedCredits,
          totalCredits: tr.summary.totalCredits,
          semestersCompleted: tr.summary.semestersCompleted,
          currentSemester: tr.student.currentSemester,
          bySemester: tr.periods.map((p: any) => ({ semester: p.semester, period: `${p.academicYear} ${p.term}`, gpa: round1(p.semesterGPA * 10) / 10, credits: p.totalCredits })),
          currentSubjects: (tr.periods.find((p: any) => p.semester === tr.student.currentSemester)?.subjects || [])
            .map((s: any) => ({ subject: s.subject.code, value: round1(s.finalValue), letter: s.letter, points: s.gradePoints, credits: s.subject.credits }))
            .sort((a: any, b: any) => a.value - b.value).slice(0, 8),
        };
      }
      case 's_grades': {
        const j = await this.journal.myJournal(user.id, {});
        return {
          count: j.items.length,
          formula: 'Final 50 + Midterm 30 + Seminar 20 (average of >=3 seminar answers x 2); only published grades',
          subjects: j.items.map((i) => ({ subject: i.subject.code, final: i.final?.score ?? null, midterm: i.midterm?.score ?? null, seminar: i.seminar.eligible ? i.seminar.score : null, seminarAnswers: i.seminar.count, seminarRequired: i.seminar.required, total: i.total.score, provisional: !i.total.final, status: i.status })),
        };
      }
      case 's_attendance': {
        // единый источник: Academic Journal → Attendance (только собственные данные студента)
        const a = await this.attendance.student({ id: user.id, role: 'STUDENT' as any }, { permission: 'attendance.view', scope: 'OWN' as any }, {});
        return {
          overallRate: a.totals.rate,
          bySubject: a.subjects.map((r) => ({ subject: r.subject.code, classes: r.total, present: r.present, late: r.late, absent: r.absent, excused: r.excused, countedAbsences: r.counted, maxAbsences: r.max, remaining: r.remaining, status: r.status })),
          rule: 'counted = absent + floor(late/2); EXCEEDED when counted >= max',
        };
      }
      case 's_requests': {
        const rs = await this.requests.listMy(user.id);
        const by: Record<string, number> = {};
        rs.forEach((r) => { by[r.status] = (by[r.status] ?? 0) + 1; });
        return { counts: by, pending: rs.filter((r) => r.status === 'PENDING').slice(0, 6).map((r) => ({ type: r.type, created: day(r.createdAt), text: cut(r.description, 80) })),
          recentDecisions: rs.filter((r) => r.status !== 'PENDING').slice(0, 3).map((r) => ({ type: r.type, status: r.status, note: cut(r.adminNote, 80) })) };
      }
      case 's_payments': {
        const p = await this.payments.listForStudent(user.id);
        return { summary: p.summary, open: p.items.filter((x) => x.status !== 'PAID').slice(0, 6).map((x) => ({ type: x.type, amount: x.amount, status: x.status, due: day(x.dueDate), overdue: new Date(x.dueDate) < now })), demoMode: true };
      }

      // ───────────────────────── TEACHER (только свои пары предмет×группа) ─────────────────────────
      case 't_classes': {
        const cl = await this.teachers.getClasses(user.id);
        const res: Record<string, unknown> = {
          classes: cl.map((c) => ({ subject: c.subject?.code, group: c.groupName, students: c.studentsCount, avgGrade: c.averageGrade, attendanceRate: c.attendanceRate, pendingGrading: c.pendingGrading, next: c.nextClass ? `${c.nextClass.date} ${c.nextClass.startTime} ${c.nextClass.room}` : null })),
        };
        if (mentions.length) res.students = await this.teacherStudents(user, mentions);
        return res;
      }
      case 't_missing_grades': {
        const [cl, { records }] = await Promise.all([this.teachers.getClasses(user.id), this.journal.load({ id: user.id, role: 'TEACHER' as any, scope: 'ASSIGNED' as any, caps: NO_CAPS }, {})]);
        const out = cl.map((c) => {
          const rs = records.filter((r) => r.subject.code === c.subject!.code && r.student.groupName === c.groupName);
          const noGrades = rs.filter((r) => !r.final || !r.midterm).map((r) => r.student.fullName);
          const noSeminar = rs.filter((r) => !r.seminar.eligible).map((r) => r.student.fullName);
          return { subject: c.subject!.code, group: c.groupName, students: rs.length, withoutGrades: noGrades.slice(0, 10), withoutGradesCount: noGrades.length, seminarIncomplete: noSeminar.slice(0, 10), seminarIncompleteCount: noSeminar.length, unpublished: rs.filter((r) => r.alerts.includes('UNPUBLISHED')).length, pendingGrading: c.pendingGrading };
        });
        return { classes: out, totalWithoutGrades: out.reduce((a, c) => a + c.withoutGradesCount, 0), totalSeminarIncomplete: out.reduce((a, c) => a + c.seminarIncompleteCount, 0), totalPendingGrading: out.reduce((a, c) => a + c.pendingGrading, 0) };
      }
      case 't_attendance': {
        const a = await this.teachers.getAnalytics(user.id);
        return {
          overallRate: a.overview.attendanceRate,
          byClass: a.classes.map((c: any) => ({ subject: c.subject.code, group: c.groupName, rate: c.attendanceRate })),
          lowAttendanceStudents: a.atRisk.filter((r: any) => r.reasons.includes('low_attendance')).slice(0, 8).map((r: any) => ({ name: r.fullName, subject: r.subject.code, group: r.groupName, rate: r.attendanceRate })),
        };
      }
      case 't_assignments': {
        const [items, cl] = await Promise.all([this.assignments.getForTeacher(user.id), this.teachers.getClasses(user.id)]);
        const expected = new Map<string, number>();
        cl.forEach((c) => expected.set(c.subject!.code, (expected.get(c.subject!.code) ?? 0) + c.studentsCount));
        const rows = items.filter((a) => a.status !== 'DRAFT').map((a) => {
          const exp = expected.get(a.subject.code) ?? 0;
          return { title: cut(a.title, 50), subject: a.subject.code, status: a.status, due: day(a.dueDate), submitted: a.submissionsCount, expected: exp, completion: exp ? Math.round((a.submissionsCount / exp) * 100) : null, toGrade: a.pendingCount };
        });
        return {
          counts: { published: items.filter((a) => a.status === 'PUBLISHED').length, draft: items.filter((a) => a.status === 'DRAFT').length, closed: items.filter((a) => a.status === 'CLOSED').length },
          lowCompletion: rows.filter((r) => r.completion != null && r.completion < 50).sort((a, b) => (a.completion ?? 0) - (b.completion ?? 0)).slice(0, 8),
          dueSoon: rows.filter((r) => r.status === 'PUBLISHED' && r.due && r.due >= day(now)!).sort((a, b) => a.due!.localeCompare(b.due!)).slice(0, 5),
        };
      }
      case 't_activity': {
        const [d, a] = await Promise.all([this.teachers.getDashboard(user.id), this.teachers.getAnalytics(user.id)]);
        const res: Record<string, unknown> = {
          counts: d.counts, pendingGrading: d.pendingGrading.count, submissionsLast7d: d.assignments.submissionsLast7d,
          today: d.today.map((c: any) => ({ subject: c.subject.code, group: c.groupName, time: `${c.startTime}-${c.endTime}`, attendanceMarked: `${c.attendanceMarked}/${c.studentsCount}` })),
          overview: { averageGrade: a.overview.averageGrade, attendanceRate: a.overview.attendanceRate, assignmentCompletion: a.overview.assignmentCompletion, gradesCount: a.overview.gradesCount },
          byClass: a.classes.map((c: any) => ({ subject: c.subject.code, group: c.groupName, avg: c.averageGrade, attendance: c.attendanceRate, completion: c.assignmentCompletion })),
          atRisk: a.atRisk.slice(0, 6).map((r: any) => ({ name: r.fullName, subject: r.subject.code, avg: r.averageGrade, attendance: r.attendanceRate, reasons: r.reasons })),
        };
        if (mentions.length) res.students = await this.teacherStudents(user, mentions);
        return res;
      }
      case 't_requests': {
        const rs = await this.teachers.listRequests(user.id);
        const by: Record<string, number> = {};
        rs.forEach((r) => { by[r.status] = (by[r.status] ?? 0) + 1; });
        return { counts: by, pending: rs.filter((r) => r.status === 'PENDING').slice(0, 6).map((r) => ({ type: r.type, student: r.user.fullName, group: r.user.student?.groupName ?? null, created: day(r.createdAt) })) };
      }

      // ───────────────────────── ADMIN (агрегаты по университету) ─────────────────────────
      case 'l_summary': {
        const d = await this.adminOverview.dashboard();
        return {
          students: d.students, teachers: d.teachers, attendance: d.attendance, academic: d.academic,
          requests: d.requests, payments: d.payments, schedule: d.schedule,
          announcements: { total: d.announcements.total, pinned: d.announcements.pinned },
        };
      }
      case 'l_attendance': {
        const [d, k] = await Promise.all([this.adminOverview.dashboard(), this.adminOverview.kpi(12)]);
        return { rate30d: d.attendance.rate30d, rateAll: d.attendance.rateAll, weekly: k.attendanceTrend.slice(-8).map((w) => ({ week: w.week, rate: w.rate, records: w.total })) };
      }
      case 'l_requests': {
        const [d, k] = await Promise.all([this.adminOverview.dashboard(), this.adminOverview.kpi(12)]);
        const byType: Record<string, Record<string, number>> = {};
        k.requestByType.forEach((r) => { (byType[r.type] ??= {})[r.status] = r.count; });
        return { byStatus: d.requests.byStatus, pendingOlderThan7d: d.requests.pendingOlderThan7d, byType, weekly: k.requestTrend.filter((w) => w.created).slice(-6) };
      }
      case 'l_payments': {
        const [o, k] = await Promise.all([this.analytics.paymentsOverview(), this.adminOverview.kpi(12)]);
        return {
          summary: o.summary, demoMode: true,
          debtByGroup: o.byGroup.slice(0, 5).map((g) => ({ group: g.groupName, debt: g.debt, debtors: g.debtors })),
          weeklyPaid: k.paymentTrend.filter((w) => w.count).slice(-6),
        };
      }
      case 'l_academic': {
        const [d, k] = await Promise.all([this.adminOverview.dashboard(), this.adminOverview.kpi(12)]);
        return { current: d.academic, byTerm: k.academicTrend.map((t) => ({ period: t.period, average: t.average, grades: t.grades, lowShare: t.lowShare })), submissionsWeekly: k.submissionsTrend.filter((w) => w.count).slice(-6) };
      }
      case 'l_person': {
        const users = await this.prisma.user.findMany({ where: { loginId: { in: mentions.slice(0, 3) } }, select: { id: true } });
        const out = [];
        for (const u of users) {
          const p: any = await this.adminOverview.userProfile(u.id);
          out.push({ loginId: p.loginId, name: p.fullName, role: p.role, status: p.status, locked: p.locked, student: p.student ? { group: p.student.groupName, course: p.student.course, level: p.student.level } : null, stats: p.studentStats ?? p.teacherStats ?? null, logins30d: p.activity.logins30d });
        }
        return { users: out };
      }

      // ───────────────────────── SUPER_ADMIN (журналы безопасности, без секретов) ─────────────────────────
      case 'a_security': {
        const o = await this.security.overview();
        return {
          kpi: o.kpi,
          importantEvents: o.importantEvents.slice(0, 8).map((e: any) => ({ action: e.action, severity: e.severity, target: e.targetType, actor: e.actor?.loginId ?? 'system', at: e.createdAt })),
          controls: o.health,
        };
      }
      case 'a_logins': {
        const a = await this.security.loginActivity(24);
        const w = await this.security.loginActivity(168);
        return {
          last24h: a.totals, last7d: w.totals, failedByReason7d: w.failedByReason,
          recentFailed: w.recent.filter((l: any) => !l.success).slice(0, 8).map((l: any) => ({ loginId: l.loginId, reason: l.reason, ip: l.ip, at: l.createdAt })),
        };
      }
      case 'a_anomalies': {
        const r = await this.anomalies.list(168);
        return { counts: r.counts, open: r.items.filter((i) => i.status === 'OPEN').slice(0, 8).map((i) => ({ type: i.type, severity: i.severity, subject: i.subject.id, at: i.at, params: i.params })) };
      }
      case 'a_person': {
        const out = [];
        for (const id of mentions.slice(0, 3)) {
          const l = await this.security.listLoginLogs({ search: id, take: 20 });
          out.push({ loginId: id, loginEvents: l.total, recent: l.items.slice(0, 6).map((x) => ({ success: x.success, reason: x.reason, ip: x.ip, at: x.createdAt })) });
        }
        return { accounts: out };
      }
    }
  }

  /** Студенты, которых преподаватель упомянул по Login ID (уже проверены checkMentions) */
  private async teacherStudents(user: AIUser, loginIds: string[]) {
    const { records } = await this.journal.load({ id: user.id, role: 'TEACHER' as any, scope: 'ASSIGNED' as any, caps: NO_CAPS }, {});
    return records
      .filter((r) => loginIds.includes(r.student.loginId))
      .map((r) => ({ loginId: r.student.loginId, name: r.student.fullName, subject: r.subject.code, group: r.student.groupName, currentGrade: r.performancePct, total: r.total.score, status: r.status, attendanceRate: r.attendance?.rate ?? null }));
  }
  private nextStudentDay(slots: Array<{ dayOfWeek: number; startTime: string; endTime: string; weekParity: string; subject: { code: string; name: string }; room: string }>, _parity: string, now: Date) {
    for (let add = 1; add <= 7; add++) {
      const d = new Date(now.getTime() + add * 86_400_000);
      const dow = d.getUTCDay() || 7;
      const p = currentWeekParity(d);
      const list = slots.filter((s) => s.dayOfWeek === dow && (s.weekParity === 'BOTH' || s.weekParity === p)).sort((a, b) => a.startTime.localeCompare(b.startTime));
      if (list.length) return { date: day(d), weekday: dow, classes: list.map((s) => ({ time: `${s.startTime}-${s.endTime}`, subject: `${s.subject.code} ${s.subject.name}`, room: s.room })) };
    }
    return null;
  }
}
