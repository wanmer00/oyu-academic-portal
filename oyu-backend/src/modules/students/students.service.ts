import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Term } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { summarizeSubject } from '../journal/journal.calc';
import { PASS_MARK, standingFor, subjectOutcome, weightedGpa } from './academic.calc';
import { emptyCounts, limitOf, maxAbsencesForCredits } from '../attendance/attendance.calc';
import { CURRENT_PERIOD } from '../teachers/teacher-access.service';

type GradeFilters = { academicYear?: string; term?: Term };

@Injectable()
export class StudentsService {
  constructor(private readonly prisma: PrismaService) {}

  private async requireStudent(userId: string) {
    const student = await this.prisma.student.findUnique({ where: { userId } });
    if (!student) throw new ForbiddenException('Only students have access');
    return student;
  }

  async getMyGrades(userId: string, filters: GradeFilters = {}) {
    const student = await this.requireStudent(userId);
    // Студент видит только опубликованные оценки (черновики преподавателя скрыты)
    const where: any = { studentId: student.userId, publishedAt: { not: null } };
    if (filters.academicYear) where.academicYear = filters.academicYear;
    if (filters.term) where.term = filters.term;

    const grades = await this.prisma.grade.findMany({
      where,
      include: {
        subject: { select: { id: true, code: true, name: true, credits: true, color: true, semester: true } },
        teacher: { include: { user: { select: { fullName: true, loginId: true } } } },
      },
      orderBy: [{ academicYear: 'desc' }, { term: 'desc' }, { createdAt: 'desc' }],
    });

    return grades.map((g) => ({
      id: g.id,
      value: Number(g.value),
      maxValue: Number(g.maxValue),
      type: g.type,
      comment: g.comment,
      academicYear: g.academicYear,
      term: g.term,
      semester: g.semester,
      createdAt: g.createdAt.toISOString(),
      subject: g.subject,
      teacher: g.teacher
        ? { fullName: g.teacher.user.fullName, loginId: g.teacher.user.loginId }
        : null,
    }));
  }

  async getMySchedule(userId: string) {
    const student = await this.requireStudent(userId);
    const slots = await this.prisma.scheduleSlot.findMany({
      where: { groupName: student.groupName },
      include: {
        subject: { select: { id: true, code: true, name: true, color: true } },
        teacher: { include: { user: { select: { loginId: true, fullName: true } } } },
      },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });
    return {
      currentWeekParity: currentWeekParity(),
      slots: slots.map((s) => ({
        id: s.id,
        subject: s.subject,
        teacher: s.teacher?.user ? { loginId: s.teacher.user.loginId, fullName: s.teacher.user.fullName } : null,
        groupName: s.groupName,
        dayOfWeek: s.dayOfWeek,
        startTime: s.startTime,
        endTime: s.endTime,
        room: s.room,
        type: s.type,
        shift: s.shift,
        level: s.level,
        weekParity: s.weekParity,
      })),
    };
  }


  async getMyInfo(userId: string) {
    return this.requireStudent(userId);
  }

  // ─────────────────────────────────────────
  // SUBJECT DAYS — детальный список дат занятий по конкретному предмету
  // с attendance и календарными событиями (праздники, траур)
  // ─────────────────────────────────────────
  async getSubjectDays(
    userId: string,
    subjectCode: string,
    filters: { academicYear?: string; term?: Term } = {},
  ) {
    const student = await this.requireStudent(userId);
    const academicYear = filters.academicYear || CURRENT_PERIOD.academicYear;
    const term: Term = filters.term || (CURRENT_PERIOD.term as Term);

    const subject = await this.prisma.subject.findUnique({ where: { code: subjectCode } });
    if (!subject) throw new NotFoundException('Subject not found');

    // Слоты предмета для группы студента в этом семестре
    const slots = await this.prisma.scheduleSlot.findMany({
      where: {
        subjectId: subject.id,
        groupName: student.groupName,
        academicYear,
        term,
      },
      include: { teacher: { include: { user: { select: { loginId: true, fullName: true } } } } },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });

    // Период семестра (примерные границы)
    const periods: Record<string, Record<string, [string, string]>> = {
      '2023-2024': { FALL: ['2023-09-15', '2024-01-20'], SPRING: ['2024-02-01', '2024-06-15'] },
      '2024-2025': { FALL: ['2024-09-15', '2025-01-20'], SPRING: ['2025-02-01', '2025-06-15'] },
      '2025-2026': { FALL: ['2025-09-15', '2026-01-20'], SPRING: ['2026-02-01', '2026-06-15'] },
      '2026-2027': { FALL: ['2026-09-14', '2027-01-22'], SPRING: ['2027-02-01', '2027-06-15'] },
    };
    const range = periods[academicYear]?.[term] ?? ['2026-09-14', '2027-01-22'];
    const startDate = new Date(range[0] + 'T00:00:00Z');
    const endDateFull = new Date(range[1] + 'T23:59:59Z');
    const today = new Date();
    // Показываем до сегодня + 14 дней (чтобы видеть ближайшие будущие занятия)
    const cap = new Date(today.getTime() + 14 * 86400000);
    const endDate = cap < endDateFull ? cap : endDateFull;

    // Записи посещаемости
    const attendance = await this.prisma.attendance.findMany({
      where: {
        studentId: student.userId,
        subjectId: subject.id,
        classDate: { gte: startDate, lte: endDateFull },
      },
    });
    const attByDate = new Map<string, string>();
    for (const a of attendance) {
      attByDate.set(dateKey(a.classDate), a.status);
    }

    // Календарные события в этом периоде (общие и для группы)
    const events = await this.prisma.calendarEvent.findMany({
      where: {
        AND: [
          { eventDate: { lte: endDate } },
          { OR: [{ endDate: { gte: startDate } }, { AND: [{ endDate: null }, { eventDate: { gte: startDate } }] }] },
        ],
        OR: [{ groupName: null }, { groupName: student.groupName }],
      },
    });
    const eventCovers = (ev: typeof events[number], d: Date) => {
      const dKey = dateKey(d);
      const s = dateKey(ev.eventDate);
      const e = ev.endDate ? dateKey(ev.endDate) : s;
      return dKey >= s && dKey <= e;
    };

    // Идем по всем дням семестра, фильтруем по расписанию + weekParity
    const days: Array<{
      date: string;
      dayOfWeek: number;
      weekParity: 'UPPER' | 'LOWER';
      isPast: boolean;
      slot: {
        startTime: string;
        endTime: string;
        room: string;
        type: string;
        weekParity: string;
        teacher: { loginId: string; fullName: string } | null;
      };
      attendanceStatus: string | null;
      calendarEvent: {
        id: string;
        type: string;
        title: string;
        description: string | null;
        roomCode?: string | null;
        startTime?: string | null;
        endTime?: string | null;
      } | null;
    }> = [];

    for (let d = new Date(startDate); d <= endDate; d = new Date(d.getTime() + 86400000)) {
      const dow = d.getUTCDay() || 7; // Mon=1..Sun=7
      const dayParity = currentWeekParity(d);
      const matchingSlots = slots.filter(
        (s) => s.dayOfWeek === dow && (s.weekParity === 'BOTH' || s.weekParity === dayParity),
      );
      if (!matchingSlots.length) continue;

      const dayKey = dateKey(d);
      const ev = events.find((e) => eventCovers(e, d));
      const status = attByDate.get(dayKey) ?? null;
      const isPast = d < today;

      for (const slot of matchingSlots) {
        days.push({
          date: d.toISOString(),
          dayOfWeek: dow,
          weekParity: dayParity,
          isPast,
          slot: {
            startTime: slot.startTime,
            endTime: slot.endTime,
            room: slot.room,
            type: slot.type,
            weekParity: slot.weekParity,
            teacher: slot.teacher?.user
              ? { loginId: slot.teacher.user.loginId, fullName: slot.teacher.user.fullName }
              : null,
          },
          attendanceStatus: status,
          calendarEvent: ev
            ? {
                id: ev.id,
                type: ev.type,
                title: ev.title,
                description: ev.description,
                roomCode: (ev as any).roomCode ?? null,
                startTime: (ev as any).startTime ?? null,
                endTime: (ev as any).endTime ?? null,
              }
            : null,
        });
      }
    }

    // Attendance summary для шапки страницы
    const summary = {
      total: days.filter((x) => !x.calendarEvent || (x.calendarEvent.type !== 'HOLIDAY' && x.calendarEvent.type !== 'MOURNING')).length,
      present: days.filter((x) => x.attendanceStatus === 'PRESENT').length,
      absent:  days.filter((x) => x.attendanceStatus === 'ABSENT').length,
      late:    days.filter((x) => x.attendanceStatus === 'LATE').length,
      excused: days.filter((x) => x.attendanceStatus === 'EXCUSED').length,
      holidays: days.filter((x) => x.calendarEvent && (x.calendarEvent.type === 'HOLIDAY' || x.calendarEvent.type === 'MOURNING')).length,
      maxAbsences: maxAbsencesForCredits(subject.credits),
    };
    const lim = limitOf({ ...emptyCounts(), ABSENT: summary.absent, LATE: summary.late }, subject.credits);
    Object.assign(summary, { countedAbsences: lim.counted, remaining: lim.remaining, percentage: lim.percentage, status: lim.status });

    // ── Оценки с историей ──
    const grades = await this.prisma.grade.findMany({
      where: {
        studentId: student.userId,
        subjectId: subject.id,
        academicYear,
        term,
        publishedAt: { not: null },
      },
      include: {
        teacher: { include: { user: { select: { loginId: true, fullName: true } } } },
        history: { orderBy: { changedAt: 'desc' } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // ── Материалы ──
    const materials = await this.prisma.material.findMany({
      where: { subjectId: subject.id },
      include: { teacher: { include: { user: { select: { fullName: true } } } } },
      orderBy: { createdAt: 'desc' },
    });

    // ── Задания ──
    const assignments = await this.prisma.assignment.findMany({
      where: { subjectId: subject.id },
      include: {
        submissions: { where: { studentId: student.userId } },
        teacher: { include: { user: { select: { loginId: true, fullName: true } } } },
      },
      orderBy: { dueDate: 'asc' },
    });

    // ── Преподаватели предмета (уникальные из slots) ──
    const teacherSet = new Map<string, { type: string; loginId: string; fullName: string; weekParity: string }>();
    for (const s of slots) {
      if (!s.teacher?.user) continue;
      const key = s.teacher.userId + '|' + s.type;
      if (!teacherSet.has(key)) {
        teacherSet.set(key, {
          type: s.type,
          loginId: s.teacher.user.loginId,
          fullName: s.teacher.user.fullName,
          weekParity: s.weekParity,
        });
      }
    }

    return {
      subject: {
        id: subject.id,
        code: subject.code,
        name: subject.name,
        credits: subject.credits,
        color: subject.color,
        semester: subject.semester,
        description: subject.description,
      },
      academicYear,
      term,
      period: { start: startDate.toISOString(), end: endDateFull.toISOString() },
      summary,
      days,
      teachers: Array.from(teacherSet.values()),
      schedule: slots.map((s) => ({
        dayOfWeek: s.dayOfWeek,
        startTime: s.startTime,
        endTime: s.endTime,
        room: s.room,
        type: s.type,
        shift: s.shift,
        weekParity: s.weekParity,
        teacher: s.teacher?.user ? { loginId: s.teacher.user.loginId, fullName: s.teacher.user.fullName } : null,
      })),
      grades: grades.map((g) => ({
        id: g.id,
        value: Number(g.value),
        maxValue: Number(g.maxValue),
        type: g.type,
        comment: g.comment,
        createdAt: g.createdAt.toISOString(),
        updatedAt: g.updatedAt.toISOString(),
        teacher: g.teacher?.user
          ? { fullName: g.teacher.user.fullName, loginId: g.teacher.user.loginId }
          : null,
        history: g.history.map((h) => ({
          oldValue: Number(h.oldValue),
          newValue: Number(h.newValue),
          changedBy: h.changedBy,
          reason: h.reason,
          changedAt: h.changedAt.toISOString(),
        })),
      })),
      materials: materials.map((m) => ({
        id: m.id,
        title: m.title,
        type: m.type,
        url: m.url,
        fileName: m.fileName,
        createdAt: m.createdAt.toISOString(),
        teacher: m.teacher?.user?.fullName ?? null,
      })),
      assignments: assignments.map((a) => {
        const sub = a.submissions[0];
        return {
          id: a.id,
          title: a.title,
          description: a.description,
          dueDate: a.dueDate.toISOString(),
          maxGrade: Number(a.maxGrade),
          createdAt: a.createdAt.toISOString(),
          teacher: a.teacher?.user
            ? { loginId: a.teacher.user.loginId, fullName: a.teacher.user.fullName }
            : null,
          submission: sub
            ? {
                id: sub.id,
                status: sub.status,
                grade: sub.grade == null ? null : Number(sub.grade),
                feedback: sub.feedback,
                fileName: sub.fileName,
                studentNotes: sub.studentNotes,
                submittedAt: sub.submittedAt ? sub.submittedAt.toISOString() : null,
                gradedAt: sub.gradedAt ? sub.gradedAt.toISOString() : null,
              }
            : null,
        };
      }),
    };
  }

  // ─────────────────────────────────────────
  // SUBJECTS OVERVIEW — всё по каждому предмету за семестр на одной странице:
  // преподаватели, расписание, оценки, посещаемость (с лимитом), материалы, задания
  // ─────────────────────────────────────────
  async getSubjectsOverview(
    userId: string,
    filters: { academicYear?: string; term?: Term } = {},
  ) {
    const student = await this.requireStudent(userId);
    const academicYear = filters.academicYear || CURRENT_PERIOD.academicYear;
    const term = filters.term || (CURRENT_PERIOD.term as Term);
    const isCurrent = academicYear === CURRENT_PERIOD.academicYear && term === CURRENT_PERIOD.term;

    // Собираем список предметов этого семестра.
    //  - для текущего семестра — из расписания группы
    //  - для прошлых — из grades студента с этим academicYear/term
    let subjectIds: string[] = [];
    if (isCurrent) {
      const slots = await this.prisma.scheduleSlot.findMany({
        where: { groupName: student.groupName, academicYear, term },
        distinct: ['subjectId'],
        select: { subjectId: true },
      });
      subjectIds = slots.map((s) => s.subjectId);
    } else {
      const gr = await this.prisma.grade.findMany({
        where: { studentId: student.userId, academicYear, term, publishedAt: { not: null } },
        distinct: ['subjectId'],
        select: { subjectId: true },
      });
      subjectIds = gr.map((g) => g.subjectId);
    }
    if (subjectIds.length === 0) {
      return { academicYear, term, subjects: [] };
    }

    const [subjects, slots, grades, attendance, materials, assignments] = await Promise.all([
      this.prisma.subject.findMany({ where: { id: { in: subjectIds } } }),
      this.prisma.scheduleSlot.findMany({
        where: { subjectId: { in: subjectIds }, groupName: student.groupName, academicYear, term },
        include: {
          teacher: { include: { user: { select: { loginId: true, fullName: true } } } },
        },
        orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
      }),
      this.prisma.grade.findMany({
        where: { studentId: student.userId, subjectId: { in: subjectIds }, academicYear, term, publishedAt: { not: null } },
        include: { teacher: { include: { user: { select: { loginId: true, fullName: true } } } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.attendance.findMany({
        where: { studentId: student.userId, subjectId: { in: subjectIds }, academicYear, term },
        orderBy: { classDate: 'desc' },
      }),
      this.prisma.material.findMany({
        where: { subjectId: { in: subjectIds } },
        include: { teacher: { include: { user: { select: { fullName: true } } } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.assignment.findMany({
        where: { subjectId: { in: subjectIds } },
        include: {
          submissions: { where: { studentId: student.userId } },
        },
        orderBy: { dueDate: 'asc' },
      }),
    ]);

    const subjectMap = new Map(subjects.map((s) => [s.id, s]));
    const result = subjectIds
      .map((id) => {
        const subject = subjectMap.get(id);
        if (!subject) return null;

        const subjectSlots = slots.filter((x) => x.subjectId === id);

        // Список преподавателей — unique по teacherId + type
        const teacherMap = new Map<string, { type: string; loginId: string; fullName: string; weekParity: string }>();
        for (const s of subjectSlots) {
          if (!s.teacher?.user) continue;
          const key = s.teacher.userId + '|' + s.type;
          if (!teacherMap.has(key)) {
            teacherMap.set(key, {
              type: s.type,
              loginId: s.teacher.user.loginId,
              fullName: s.teacher.user.fullName,
              weekParity: s.weekParity,
            });
          }
        }

        const subjectAttendance = attendance.filter((x) => x.subjectId === id);
        const subjectGrades = grades.filter((x) => x.subjectId === id);
        const subjectMaterials = materials.filter((x) => x.subjectId === id);
        const subjectAssignments = assignments.filter((x) => x.subjectId === id);

        // Attendance stats + лимит
        const present = subjectAttendance.filter((x) => x.status === 'PRESENT').length;
        const absent  = subjectAttendance.filter((x) => x.status === 'ABSENT').length;
        const late    = subjectAttendance.filter((x) => x.status === 'LATE').length;
        const excused = subjectAttendance.filter((x) => x.status === 'EXCUSED').length;
        const lim = limitOf({ ...emptyCounts(), PRESENT: present, ABSENT: absent, LATE: late, EXCUSED: excused, total: subjectAttendance.length }, subject.credits);
        const { max: maxAbsences, counted: countedAbsences, remaining, percentage, status: attStatus } = lim;

        return {
          subject: {
            id: subject.id,
            code: subject.code,
            name: subject.name,
            credits: subject.credits,
            color: subject.color,
            semester: subject.semester,
            description: subject.description,
          },
          teachers: Array.from(teacherMap.values()),
          schedule: subjectSlots.map((s) => ({
            dayOfWeek: s.dayOfWeek,
            startTime: s.startTime,
            endTime: s.endTime,
            room: s.room,
            type: s.type,
            shift: s.shift,
            weekParity: s.weekParity,
            teacher: s.teacher?.user
              ? { loginId: s.teacher.user.loginId, fullName: s.teacher.user.fullName }
              : null,
          })),
          // Итог предмета по Academic Journal (Final 50 + Midterm 30 + Seminar 20); только опубликованное
          journal: (({ final, midterm, seminar, total, status, performancePct }) => ({ final, midterm, seminar: { count: seminar.count, required: seminar.required, eligible: seminar.eligible, score: seminar.score }, total, status, performancePct }))(summarizeSubject(subjectGrades)),
          grades: subjectGrades.map((g) => ({
            id: g.id,
            value: Number(g.value),
            maxValue: Number(g.maxValue),
            type: g.type,
            comment: g.comment,
            createdAt: g.createdAt.toISOString(),
            teacher: g.teacher?.user
              ? { fullName: g.teacher.user.fullName, loginId: g.teacher.user.loginId }
              : null,
          })),
          attendance: {
            total: subjectAttendance.length,
            present,
            absent,
            late,
            excused,
            countedAbsences,
            maxAbsences,
            remaining,
            percentage,
            status: attStatus,
            records: subjectAttendance.slice(0, 30).map((a) => ({
              classDate: a.classDate.toISOString(),
              status: a.status,
            })),
          },
          materials: subjectMaterials.map((m) => ({
            id: m.id,
            title: m.title,
            type: m.type,
            url: m.url,
            fileName: m.fileName,
            createdAt: m.createdAt.toISOString(),
            teacher: m.teacher?.user?.fullName ?? null,
          })),
          assignments: subjectAssignments.map((a) => {
            const sub = a.submissions[0];
            return {
              id: a.id,
              title: a.title,
              description: a.description,
              dueDate: a.dueDate.toISOString(),
              maxGrade: Number(a.maxGrade),
              submission: sub
                ? {
                    id: sub.id,
                    status: sub.status,
                    grade: sub.grade == null ? null : Number(sub.grade),
                    submittedAt: sub.submittedAt ? sub.submittedAt.toISOString() : null,
                  }
                : null,
            };
          }),
        };
      })
      .filter(Boolean);

    return { academicYear, term, isCurrent, subjects: result };
  }

  // ─────────────────────────────────────────
  // TRANSCRIPT — академический отчёт
  // Источник итоговой оценки предмета — Academic Journal (Final 50 + Midterm 30 + Seminar 20).
  // В транскрипт и GPA попадают только ЗАВЕРШЁННЫЕ и ОПУБЛИКОВАННЫЕ предметы; незавершённые — в inProgress.
  // Шкала «буква / GPA / зачёт кредитов» — academic.calc (официальная mapping journal.calc, проходной 51).
  // ─────────────────────────────────────────
  async getTranscript(userId: string) {
    const student = await this.requireStudent(userId);

    const allGrades = await this.prisma.grade.findMany({
      where: { studentId: student.userId, publishedAt: { not: null }, type: { in: ['SEMINAR', 'MIDTERM', 'FINAL'] } },
      include: {
        subject: { select: { id: true, code: true, name: true, credits: true, color: true } },
      },
      orderBy: [{ academicYear: 'asc' }, { term: 'asc' }, { createdAt: 'asc' }],
    });

    const keyOf = (ay: string, t: Term) => ay + '|' + t;
    const buckets = new Map<
      string,
      {
        academicYear: string;
        term: Term;
        semester: number;
        subjectMap: Map<string, { subject: { id: string; code: string; name: string; credits: number; color: string | null }; rows: typeof allGrades }>;
      }
    >();

    for (const g of allGrades) {
      const k = keyOf(g.academicYear, g.term);
      let bucket = buckets.get(k);
      if (!bucket) {
        bucket = { academicYear: g.academicYear, term: g.term, semester: g.semester, subjectMap: new Map() };
        buckets.set(k, bucket);
      }
      let sb = bucket.subjectMap.get(g.subjectId);
      if (!sb) {
        sb = { subject: g.subject, rows: [] };
        bucket.subjectMap.set(g.subjectId, sb);
      }
      sb.rows.push(g);
    }

    const order = { FALL: 0, SPRING: 1, SUMMER: 2 };
    const periods = Array.from(buckets.values())
      .sort((a, b) => (a.academicYear !== b.academicYear ? a.academicYear.localeCompare(b.academicYear) : order[a.term] - order[b.term]))
      .map((b) => {
        const all = Array.from(b.subjectMap.values()).map((sb) => ({ sb, sum: summarizeSubject(sb.rows) }));
        const subjects = all
          .filter((x) => x.sum.complete)
          .map(({ sb, sum }) => {
            const value = Number(sum.total.exact);
            const out = subjectOutcome(value);
            return {
              subject: sb.subject,
              finalValue: Number(value.toFixed(2)),
              hasFinal: true,
              attemptsCount: sb.rows.length,
              letter: out.letter,
              gradePoints: out.gradePoints,
              passed: out.passed,
              creditsEarned: out.passed ? sb.subject.credits : 0,
              components: { final: sum.final!.score, midterm: sum.midterm!.score, seminar: sum.seminar.score },
            };
          });
        const inProgress = all
          .filter((x) => !x.sum.complete)
          .map(({ sb, sum }) => ({
            subject: sb.subject,
            status: sum.status,
            provisionalTotal: sum.total.score,
            seminarAnswers: sum.seminar.count,
            seminarRequired: sum.seminar.required,
          }));

        const totalCredits = subjects.reduce((s, x) => s + x.subject.credits, 0);
        const semesterGPA = weightedGpa(subjects.map((x) => ({ credits: x.subject.credits, gradePoints: x.gradePoints }))) ?? 0;
        const earnedCredits = subjects.reduce((s, x) => s + x.creditsEarned, 0);

        return {
          academicYear: b.academicYear,
          term: b.term,
          semester: b.semester,
          subjects,
          inProgress,
          totalCredits,
          earnedCredits,
          semesterGPA,
        };
      })
      .filter((p) => p.subjects.length > 0 || p.inProgress.length > 0);

    // Cumulative GPA — взвешенное по кредитам по всем завершённым предметам
    const totalCreditsAll = periods.reduce((s, p) => s + p.totalCredits, 0);
    const cumulativeGPA = weightedGpa(periods.flatMap((p) => p.subjects.map((x) => ({ credits: x.subject.credits, gradePoints: x.gradePoints })))) ?? 0;
    const earnedCreditsAll = periods.reduce((s, p) => s + p.earnedCredits, 0);

    return {
      student: {
        userId: student.userId,
        groupName: student.groupName,
        faculty: student.faculty,
        specialty: student.specialty,
        course: student.course,
        currentSemester: student.semester,
      },
      periods,
      summary: {
        totalCredits: totalCreditsAll,
        earnedCredits: earnedCreditsAll,
        cumulativeGPA,
        totalSubjects: periods.reduce((s, p) => s + p.subjects.length, 0),
        inProgressSubjects: periods.reduce((s, p) => s + p.inProgress.length, 0),
        semestersCompleted: periods.filter((p) => p.semester < student.semester).length,
      },
    };
  }

  /**
   * Официальная академическая сводка — единственный источник GPA для всех student UI (дашборд, транскрипт, модалки).
   * Строится из того же транскрипта, поэтому «GPA на дашборде ≠ GPA в транскрипте» невозможно.
   * semesterGpa — последний семестр, где есть завершённые предметы; null-значения = данных ещё нет.
   */
  async academicSummary(userId: string) {
    const tr = await this.getTranscript(userId);
    const graded = tr.periods.filter((p) => p.subjects.length > 0);
    const last = graded[graded.length - 1] ?? null;
    const cumulativeGpa = graded.length ? tr.summary.cumulativeGPA : null;
    return {
      cumulativeGpa,
      semesterGpa: last ? last.semesterGPA : null,
      semester: last ? { academicYear: last.academicYear, term: last.term, semester: last.semester } : null,
      earnedCredits: tr.summary.earnedCredits,
      totalCredits: tr.summary.totalCredits,
      completedSubjects: tr.summary.totalSubjects,
      inProgressSubjects: tr.summary.inProgressSubjects,
      academicStanding: standingFor(cumulativeGpa),
      passMark: PASS_MARK,
    };
  }
}
// ── Formatting helpers ──
function dateKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

// ── Current week parity by ISO week number ──
export function currentWeekParity(date: Date = new Date()): 'UPPER' | 'LOWER' {
  // ISO week number
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return weekNum % 2 === 1 ? 'UPPER' : 'LOWER';
}
