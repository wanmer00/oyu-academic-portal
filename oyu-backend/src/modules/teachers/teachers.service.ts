import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { RequestStatus, RequestType } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { performanceByStudent } from '../journal/journal.calc';
import { attendanceRate } from '../attendance/attendance.calc';
import { currentWeekParity } from '../students/students.service';
import { CURRENT_PERIOD, TeacherAccessService } from './teacher-access.service';

interface AuditCtx { ip?: string | null; userAgent?: string | null; }

// Заявки, на которые преподаватель вправе отвечать (справки/переводы — зона руководства)
const TEACHER_REQUEST_TYPES: RequestType[] = [RequestType.APPEAL, RequestType.OTHER];

const round1 = (n: number) => Math.round(n * 10) / 10;
const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
/** Средняя текущая успеваемость (%) по студентам — из Academic Journal, а не из «сырых» строк с разными шкалами */
const perfAvg = (rows: Array<Parameters<typeof performanceByStudent>[0][number]>) => {
  const v = Array.from(performanceByStudent(rows).values()).filter((x): x is number => x != null);
  return v.length ? round1(avg(v)!) : null;
};

@Injectable()
export class TeachersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly access: TeacherAccessService,
  ) {}

  // ─────────────────────────── Profile / scope ───────────────────────────
  getMyProfile(userId: string) {
    return this.access.requireTeacher(userId);
  }

  async getMySubjects(userId: string) {
    const scope = await this.access.scope(userId);
    return this.prisma.subject.findMany({
      where: { id: { in: scope.subjectIds } },
      orderBy: { code: 'asc' },
    });
  }

  async getGroupsWithStudents(userId: string) {
    const scope = await this.access.scope(userId);
    if (!scope.groups.length) return [];
    const [students, subjects] = await Promise.all([
      this.prisma.student.findMany({
        where: { groupName: { in: scope.groups }, user: { status: 'ACTIVE' } },
        include: { user: { select: { id: true, loginId: true, fullName: true, email: true } } },
        orderBy: [{ groupName: 'asc' }, { user: { fullName: 'asc' } }],
      }),
      this.prisma.subject.findMany({
        where: { id: { in: scope.subjectIds } },
        select: { id: true, code: true, name: true, color: true },
      }),
    ]);
    const subjById = new Map(subjects.map((s) => [s.id, s]));
    return scope.groups.sort().map((groupName) => ({
      groupName,
      subjects: scope.pairs
        .filter((p) => p.groupName === groupName)
        .map((p) => subjById.get(p.subjectId))
        .filter(Boolean),
      students: students
        .filter((s) => s.groupName === groupName)
        .map((s) => ({
          userId: s.userId,
          loginId: s.user.loginId,
          fullName: s.user.fullName,
          email: s.user.email,
          faculty: s.faculty,
          specialty: s.specialty,
          course: s.course,
          semester: s.semester,
        })),
    }));
  }

  async getTeacherSchedule(userId: string) {
    await this.access.requireTeacher(userId);
    return this.prisma.scheduleSlot.findMany({
      where: { teacherId: userId },
      include: { subject: { select: { id: true, code: true, name: true, color: true } } },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });
  }

  // ─────────────────────────── Classes & Dashboard ───────────────────────────
  private nextOccurrence(slots: Array<{ dayOfWeek: number; startTime: string; endTime: string; room: string; type: string; weekParity: string }>) {
    const now = new Date();
    let best: { date: string; startTime: string; endTime: string; room: string; type: string } | null = null;
    for (let add = 0; add < 15; add++) {
      const d = new Date(now.getTime() + add * 86400000);
      const dow = d.getUTCDay() || 7;
      const parity = currentWeekParity(d);
      const hhmm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
      const cands = slots
        .filter((s) => s.dayOfWeek === dow && (s.weekParity === 'BOTH' || s.weekParity === parity) && (add > 0 || s.endTime > hhmm))
        .sort((a, b) => a.startTime.localeCompare(b.startTime));
      if (cands.length) {
        const s = cands[0];
        best = { date: d.toISOString().slice(0, 10), startTime: s.startTime, endTime: s.endTime, room: s.room, type: s.type };
        break;
      }
    }
    return best;
  }

  async getClasses(teacherId: string) {
    const scope = await this.access.scope(teacherId);
    if (!scope.pairs.length) return [];
    const [subjects, slots, students] = await Promise.all([
      this.prisma.subject.findMany({ where: { id: { in: scope.subjectIds } }, select: { id: true, code: true, name: true, color: true, credits: true } }),
      this.prisma.scheduleSlot.findMany({ where: { teacherId } }),
      this.prisma.student.findMany({ where: { groupName: { in: scope.groups }, user: { status: 'ACTIVE' } }, select: { userId: true, groupName: true } }),
    ]);
    const period = { academicYear: CURRENT_PERIOD.academicYear, term: CURRENT_PERIOD.term };
    const [grades, attendance, pending] = await Promise.all([
      this.prisma.grade.findMany({ where: { subjectId: { in: scope.subjectIds }, studentId: { in: students.map((s) => s.userId) }, ...period }, select: { id: true, type: true, studentId: true, subjectId: true, value: true, publishedAt: true, createdAt: true, updatedAt: true } }),
      this.prisma.attendance.findMany({ where: { subjectId: { in: scope.subjectIds }, studentId: { in: students.map((s) => s.userId) }, ...period }, select: { studentId: true, subjectId: true, status: true } }),
      this.prisma.submission.findMany({
        where: { status: { in: ['SUBMITTED', 'LATE'] }, assignment: { teacherId } },
        select: { studentId: true, assignment: { select: { subjectId: true } } },
      }),
    ]);
    const subjById = new Map(subjects.map((s) => [s.id, s]));
    return scope.pairs
      .map((p) => {
        const ids = new Set(students.filter((s) => s.groupName === p.groupName).map((s) => s.userId));
        const g = grades.filter((x) => x.subjectId === p.subjectId && ids.has(x.studentId));
        const a = attendance.filter((x) => x.subjectId === p.subjectId && ids.has(x.studentId));
        const mine = slots.filter((s) => s.subjectId === p.subjectId && s.groupName === p.groupName);
        return {
          subject: subjById.get(p.subjectId),
          groupName: p.groupName,
          studentsCount: ids.size,
          averageGrade: perfAvg(g),
          attendanceRate: attendanceRate({ total: a.length, ABSENT: a.filter((x) => x.status === 'ABSENT').length }),
          pendingGrading: pending.filter((x) => x.assignment.subjectId === p.subjectId && ids.has(x.studentId)).length,
          slots: mine.map((s) => ({ dayOfWeek: s.dayOfWeek, startTime: s.startTime, endTime: s.endTime, room: s.room, type: s.type, weekParity: s.weekParity })),
          nextClass: this.nextOccurrence(mine),
        };
      })
      .sort((x, y) => (x.subject!.code + x.groupName).localeCompare(y.subject!.code + y.groupName));
  }

  async getDashboard(teacherId: string) {
    const scope = await this.access.scope(teacherId);
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dow = now.getUTCDay() || 7;
    const parity = currentWeekParity(now);

    const [slots, studentsInScope, myAssignments, pendingSubs, recentSubs, requestIds] = await Promise.all([
      this.prisma.scheduleSlot.findMany({
        where: { teacherId, dayOfWeek: dow },
        include: { subject: { select: { id: true, code: true, name: true, color: true } } },
        orderBy: { startTime: 'asc' },
      }),
      this.prisma.student.findMany({ where: { groupName: { in: scope.groups }, user: { status: 'ACTIVE' } }, select: { userId: true, groupName: true } }),
      this.prisma.assignment.findMany({
        where: { teacherId },
        include: { subject: { select: { code: true, name: true } }, submissions: { select: { status: true, submittedAt: true } } },
      }),
      this.prisma.submission.findMany({
        where: { status: { in: ['SUBMITTED', 'LATE'] }, assignment: { teacherId } },
        include: {
          assignment: { select: { id: true, title: true, subject: { select: { code: true, name: true } } } },
          student: { include: { user: { select: { fullName: true, loginId: true } } } },
        },
        orderBy: { submittedAt: 'asc' },
        take: 200,
      }),
      this.prisma.submission.count({ where: { assignment: { teacherId }, submittedAt: { gte: new Date(now.getTime() - 7 * 86400000) } } }),
      this.requestUserFilter(scope.groups),
    ]);

    const todays = slots.filter((s) => s.weekParity === 'BOTH' || s.weekParity === parity);
    const marked = await Promise.all(
      todays.map(async (s) => {
        const ids = studentsInScope.filter((x) => x.groupName === s.groupName).map((x) => x.userId);
        const n = await this.prisma.attendance.count({ where: { subjectId: s.subjectId, classDate: today, studentId: { in: ids } } });
        return { slot: s, studentsCount: ids.length, marked: n };
      }),
    );

    const pendingRequests = requestIds.length
      ? await this.prisma.request.count({ where: { userId: { in: requestIds }, type: { in: TEACHER_REQUEST_TYPES }, status: 'PENDING' } })
      : 0;

    return {
      counts: { subjects: scope.subjectIds.length, groups: scope.groups.length, students: studentsInScope.length },
      today: marked.map((m) => ({
        id: m.slot.id,
        subject: m.slot.subject,
        groupName: m.slot.groupName,
        startTime: m.slot.startTime,
        endTime: m.slot.endTime,
        room: m.slot.room,
        type: m.slot.type,
        studentsCount: m.studentsCount,
        attendanceMarked: m.marked,
      })),
      attendanceToday: {
        classes: marked.length,
        completed: marked.filter((m) => m.studentsCount > 0 && m.marked >= m.studentsCount).length,
        pending: marked.filter((m) => m.marked < m.studentsCount).length,
      },
      pendingGrading: {
        count: pendingSubs.length,
        items: pendingSubs.slice(0, 5).map((s) => ({
          submissionId: s.id,
          assignmentId: s.assignment.id,
          assignmentTitle: s.assignment.title,
          subject: s.assignment.subject,
          student: { fullName: s.student.user.fullName, loginId: s.student.user.loginId },
          submittedAt: s.submittedAt ? s.submittedAt.toISOString() : null,
          status: s.status,
        })),
      },
      assignments: {
        published: myAssignments.filter((a) => a.status === 'PUBLISHED').length,
        draft: myAssignments.filter((a) => a.status === 'DRAFT').length,
        closed: myAssignments.filter((a) => a.status === 'CLOSED').length,
        submissionsLast7d: recentSubs,
        dueSoon: myAssignments
          .filter((a) => a.status === 'PUBLISHED' && a.dueDate >= now)
          .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())
          .slice(0, 4)
          .map((a) => ({
            id: a.id, title: a.title, subject: a.subject, dueDate: a.dueDate.toISOString(),
            submitted: a.submissions.filter((s) => s.status !== 'PENDING').length,
          })),
      },
      requests: { pending: pendingRequests },
    };
  }

  // ─────────────────────────── Analytics ───────────────────────────
  async getAnalytics(teacherId: string, groupName?: string, subjectCode?: string) {
    const scope = await this.access.scope(teacherId);
    let pairs = scope.pairs;
    if (groupName) pairs = pairs.filter((p) => p.groupName === groupName);
    if (subjectCode) {
      const subj = await this.prisma.subject.findUnique({ where: { code: subjectCode } });
      if (!subj) throw new NotFoundException('Subject not found');
      pairs = pairs.filter((p) => p.subjectId === subj.id);
    }
    if ((groupName || subjectCode) && !pairs.length) throw new ForbiddenException('No access to requested class');

    const subjects = await this.prisma.subject.findMany({ where: { id: { in: Array.from(new Set(pairs.map((p) => p.subjectId))) } }, select: { id: true, code: true, name: true } });
    const subjById = new Map(subjects.map((s) => [s.id, s]));
    const period = { academicYear: CURRENT_PERIOD.academicYear, term: CURRENT_PERIOD.term };
    const buckets = [
      { key: '0-59', min: 0, max: 59.999 }, { key: '60-69', min: 60, max: 69.999 }, { key: '70-79', min: 70, max: 79.999 },
      { key: '80-89', min: 80, max: 89.999 }, { key: '90-100', min: 90, max: 100 },
    ];
    const distOf = (vals: number[]) => buckets.map((b) => ({ range: b.key, count: vals.filter((v) => v >= b.min && v <= b.max).length }));

    const classes: any[] = [];
    const allVals: number[] = [];
    const risk: any[] = [];
    let attTotal = 0, attAbsent = 0, asgSlots = 0, asgDone = 0;
    const uniqueStudents = new Set<string>(); // студент, учащийся по нескольким предметам, считается один раз
    const now = new Date();

    for (const p of pairs) {
      const students = await this.prisma.student.findMany({
        where: { groupName: p.groupName, user: { status: 'ACTIVE' } },
        include: { user: { select: { loginId: true, fullName: true } } },
      });
      const ids = students.map((s) => s.userId);
      const [grades, att, assignments] = await Promise.all([
        this.prisma.grade.findMany({ where: { subjectId: p.subjectId, studentId: { in: ids }, ...period }, select: { id: true, type: true, studentId: true, value: true, publishedAt: true, createdAt: true, updatedAt: true } }),
        this.prisma.attendance.findMany({ where: { subjectId: p.subjectId, studentId: { in: ids }, ...period }, select: { studentId: true, status: true } }),
        this.prisma.assignment.findMany({
          where: { subjectId: p.subjectId, status: { not: 'DRAFT' } },
          include: { submissions: { where: { studentId: { in: ids } }, select: { studentId: true, status: true } } },
        }),
      ]);
      const perf = performanceByStudent(grades);
      const vals = Array.from(perf.values()).filter((v): v is number => v != null);
      const absent = att.filter((a) => a.status === 'ABSENT').length;
      const done = assignments.reduce((n, a) => n + a.submissions.filter((s) => s.status !== 'PENDING').length, 0);
      const slotsCount = assignments.length * ids.length;
      const subj = subjById.get(p.subjectId)!;

      classes.push({
        subject: subj, groupName: p.groupName, studentsCount: ids.length,
        averageGrade: vals.length ? round1(avg(vals)!) : null,
        attendanceRate: attendanceRate({ total: att.length, ABSENT: absent }),
        assignmentCompletion: slotsCount ? Math.round((done / slotsCount) * 100) : null,
        distribution: distOf(vals),
      });
      allVals.push(...vals);
      attTotal += att.length; attAbsent += absent; asgSlots += slotsCount; asgDone += done;
      ids.forEach((id) => uniqueStudents.add(id));

      for (const s of students) {
        const sv = perf.get(s.userId) != null ? [perf.get(s.userId)!] : [];
        const sa = att.filter((a) => a.studentId === s.userId);
        const sAvg = sv.length ? avg(sv)! : null;
        const sRate = sa.length ? ((sa.length - sa.filter((a) => a.status === 'ABSENT').length) / sa.length) * 100 : null;
        const overdue = assignments.filter((a) => a.dueDate < now && !a.submissions.some((x) => x.studentId === s.userId && x.status !== 'PENDING')).length;
        const reasons: string[] = [];
        if (sAvg != null && sAvg < 60) reasons.push('low_grade');
        if (sRate != null && sRate < 70) reasons.push('low_attendance');
        if (overdue >= 2) reasons.push('overdue');
        if (reasons.length) {
          risk.push({
            loginId: s.user.loginId, fullName: s.user.fullName, groupName: p.groupName, subject: subj,
            averageGrade: sAvg != null ? round1(sAvg) : null, attendanceRate: sRate != null ? Math.round(sRate) : null, overdue, reasons,
          });
        }
      }
    }

    return {
      filters: { groupName: groupName ?? null, subjectCode: subjectCode ?? null },
      overview: {
        classes: classes.length,
        students: uniqueStudents.size,
        gradesCount: allVals.length,
        averageGrade: allVals.length ? round1(avg(allVals)!) : null,
        attendanceRate: attendanceRate({ total: attTotal, ABSENT: attAbsent }),
        assignmentCompletion: asgSlots ? Math.round((asgDone / asgSlots) * 100) : null,
        distribution: distOf(allVals),
      },
      classes,
      atRisk: risk.sort((a, b) => (a.averageGrade ?? 101) - (b.averageGrade ?? 101)).slice(0, 25),
    };
  }

  // ─────────────────────────── Requests ───────────────────────────
  /** userId студентов из групп преподавателя */
  private async requestUserFilter(groups: string[]): Promise<string[]> {
    if (!groups.length) return [];
    const rows = await this.prisma.student.findMany({ where: { groupName: { in: groups } }, select: { userId: true } });
    return rows.map((r) => r.userId);
  }

  async listRequests(teacherId: string, status?: RequestStatus) {
    const scope = await this.access.scope(teacherId);
    const ids = await this.requestUserFilter(scope.groups);
    if (!ids.length) return [];
    return this.prisma.request.findMany({
      where: { userId: { in: ids }, type: { in: TEACHER_REQUEST_TYPES }, ...(status ? { status } : {}) },
      include: { user: { select: { loginId: true, fullName: true, role: true, student: { select: { groupName: true } } } }, examAppeal: { select: { id: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async replyRequest(teacherUserId: string, id: string, dto: { status: RequestStatus; adminNote?: string }, audit?: AuditCtx) {
    const scope = await this.access.scope(teacherUserId);
    const req = await this.prisma.request.findUnique({
      where: { id },
      include: { user: { select: { student: { select: { groupName: true } } } } },
    });
    if (!req) throw new NotFoundException('Request not found');
    const group = req.user.student?.groupName;
    if (!TEACHER_REQUEST_TYPES.includes(req.type) || !group || !scope.groups.includes(group)) {
      throw new ForbiddenException('This request is not available to you');
    }
    if (await this.prisma.examAppeal.findUnique({ where: { requestId: id }, select: { id: true } })) {
      throw new BadRequestException({ message: 'Exam appeals are decided per question in the appeal review', code: 'USE_APPEAL_REVIEW' });
    }
    const updated = await this.prisma.request.update({
      where: { id },
      data: { status: dto.status, adminNote: dto.adminNote ?? null },
    });
    await this.prisma.auditLog.create({
      data: {
        actorId: teacherUserId,
        action: 'request.reply',
        targetType: 'Request',
        targetId: id,
        diff: { status: dto.status, hasNote: !!dto.adminNote, from: req.status },
        ip: audit?.ip ?? null,
        userAgent: audit?.userAgent ?? null,
      },
    });
    await this.notifications.notify([updated.userId], {
      type: 'REQUEST',
      title: { az: 'Müraciətin statusu dəyişdi', ru: 'Статус заявки изменён', en: 'Request status updated' },
      message: {
        az: `Status: ${updated.status}${updated.adminNote ? ' — ' + updated.adminNote : ''}`,
        ru: `Статус: ${updated.status}${updated.adminNote ? ' — ' + updated.adminNote : ''}`,
        en: `Status: ${updated.status}${updated.adminNote ? ' — ' + updated.adminNote : ''}`,
      },
      link: 'requests',
    });
    return updated;
  }
}
