import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PermissionScope, Prisma, Role, Term } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SettingsService } from '../admin/settings.service';
import { StudentsService } from '../students/students.service';
import { CURRENT_PERIOD, TeacherAccessService } from '../teachers/teacher-access.service';
import {
  JOURNAL_RULES,
  JOURNAL_TYPES,
  JournalStatus,
  SubjectSummary,
  publishedOnly,
  summarizeSubject,
  toLetter,
} from './journal.calc';
import { attendanceRate } from '../attendance/attendance.calc';
import { PeriodService } from './period.service';

/** Кто и с каким scope читает/пишет журнал. caps — права записи (grades.create/update/delete/publish/override). */
export interface Caps {
  create: boolean;
  update: boolean;
  delete: boolean;
  publish: boolean;
  override: boolean;
}
export interface Viewer {
  id: string;
  role: Role;
  scope: PermissionScope;
  caps: Caps;
  /** выставляется, если правка выполнена в закрытом периоде по праву override (попадает в аудит) */
  overridden?: boolean;
}
const canWrite = (v: Viewer) => v.caps.create || v.caps.update;
const SCOPE_ASSIGNED = PermissionScope.ASSIGNED;
const SCOPE_ALL = PermissionScope.ALL;

export interface Filters {
  academicYear?: string;
  term?: Term;
  subjectId?: string;
  groupName?: string;
  teacherId?: string;
  faculty?: string;
  department?: string;
  status?: JournalStatus;
  search?: string;
}

export interface AttendanceView {
  total: number;
  absent: number;
  rate: number | null;
}

export interface JournalRecord extends SubjectSummary {
  key: string;
  student: { id: string; loginId: string; fullName: string; groupName: string; faculty: string };
  subject: { id: string; code: string; name: string; credits: number; color: string | null };
  teachers: string[];
  period: { academicYear: string; term: Term; closed: boolean };
  attendance: AttendanceView | null;
  canEdit: boolean;
}

interface Pair {
  subjectId: string;
  groupName: string;
}

const T = JOURNAL_TYPES as unknown as string[];
const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const r1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

/** Чтение Journal: одна логика для всех ролей, доступ определяется viewer.role и scope. */
@Injectable()
export class JournalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeacherAccessService,
    private readonly periods: PeriodService,
    private readonly students: StudentsService,
    private readonly settings: SettingsService,
  ) {}

  resolvePeriod(q: { academicYear?: string; term?: Term }) {
    return q.academicYear && q.term ? { academicYear: q.academicYear, term: q.term } : { ...CURRENT_PERIOD, term: CURRENT_PERIOD.term as Term };
  }

  // ───────────────────────── meta ─────────────────────────
  async meta(viewer: Viewer) {
    const periods = await this.periods.list();
    const cur = this.periods.current();
    const base = {
      role: viewer.role,
      rules: {
        finalMax: JOURNAL_RULES.FINAL_MAX,
        midtermMax: JOURNAL_RULES.MIDTERM_MAX,
        seminarMax: JOURNAL_RULES.SEMINAR_MAX,
        seminarAnswerMax: JOURNAL_RULES.SEMINAR_ANSWER_MAX,
        seminarMinAnswers: JOURNAL_RULES.SEMINAR_MIN_ANSWERS,
        totalMax: JOURNAL_RULES.TOTAL_MAX,
        passMark: this.settings.passMark,
        lowAttendance: this.settings.lowAttendance,
      },
      periods: periods.map((p) => ({ id: p.id, academicYear: p.academicYear, term: p.term, status: p.status, current: p.academicYear === cur.academicYear && p.term === cur.term })),
      currentPeriod: { academicYear: cur.academicYear, term: cur.term },
    };

    const caps = { ...viewer.caps, canWrite: canWrite(viewer), scope: viewer.scope };
    if (viewer.scope === SCOPE_ASSIGNED) {
      const scope = await this.access.scope(viewer.id);
      const subjects = await this.prisma.subject.findMany({ where: { id: { in: scope.subjectIds } }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } });
      const faculties = await this.prisma.student.findMany({ where: { groupName: { in: scope.groups } }, distinct: ['faculty'], select: { faculty: true } });
      // руководство с областью (декан / зав. кафедрой / тьютор) получает те же списки, что и scope ALL, но в пределах своих групп
      const tRows = await this.prisma.teacher.findMany({ where: { scheduleSlots: { some: { groupName: { in: scope.groups } } } }, select: { userId: true, department: true, user: { select: { fullName: true } } }, orderBy: { user: { fullName: 'asc' } } });
      return { ...base, caps, scope: { subjects, groups: scope.groups.sort(), pairs: scope.pairs, faculties: faculties.map((f) => f.faculty).sort(), teachers: tRows.map((t) => ({ id: t.userId, fullName: t.user.fullName, department: t.department })), departments: Array.from(new Set(tRows.map((t) => t.department))).sort() } };
    }
    if (viewer.scope === SCOPE_ALL) {
      const [subjects, groups, teachers, faculties, departments] = await Promise.all([
        this.prisma.subject.findMany({ select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } }),
        this.prisma.student.findMany({ distinct: ['groupName'], select: { groupName: true }, orderBy: { groupName: 'asc' } }),
        this.prisma.teacher.findMany({ select: { userId: true, department: true, user: { select: { fullName: true } } }, orderBy: { user: { fullName: 'asc' } } }),
        this.prisma.student.findMany({ distinct: ['faculty'], select: { faculty: true }, orderBy: { faculty: 'asc' } }),
        this.prisma.teacher.findMany({ distinct: ['department'], select: { department: true }, orderBy: { department: 'asc' } }),
      ]);
      return {
        ...base,
        caps,
        scope: {
          subjects,
          groups: groups.map((g) => g.groupName),
          teachers: teachers.map((t) => ({ id: t.userId, fullName: t.user.fullName, department: t.department })),
          faculties: faculties.map((f) => f.faculty),
          departments: departments.map((d) => d.department),
        },
      };
    }
    return { ...base, caps };
  }

  // ───────────────────────── core loader (scope ASSIGNED / ALL) ─────────────────────────
  async load(viewer: Viewer, f: Filters): Promise<{ period: { academicYear: string; term: Term }; closed: boolean; records: JournalRecord[] }> {
    if (viewer.scope !== SCOPE_ASSIGNED && viewer.scope !== SCOPE_ALL) throw new ForbiddenException({ message: 'Journal records are not available for your access level', code: 'SCOPE_DENIED' });
    const period = this.resolvePeriod(f);
    const periodRow = await this.periods.get(period.academicYear, period.term);
    const closed = periodRow?.status === 'CLOSED';

    // 1) допустимые пары (предмет × группа)
    let slotPairs: Pair[] = [];
    let groupsScope: string[] | null = null; // null = без ограничения по группе
    let gradePairsAllowed = false;

    if (viewer.scope === SCOPE_ASSIGNED) {
      const scope = await this.access.scope(viewer.id);
      if (f.subjectId && !scope.subjectIds.includes(f.subjectId)) throw new ForbiddenException('You do not teach this subject');
      if (f.groupName && !scope.groups.includes(f.groupName)) throw new ForbiddenException('You do not teach this group');
      slotPairs = scope.pairs.filter((p) => (!f.subjectId || p.subjectId === f.subjectId) && (!f.groupName || p.groupName === f.groupName));
      if (f.subjectId && f.groupName && !slotPairs.length) throw new ForbiddenException('You do not teach this subject in this group');
      groupsScope = Array.from(new Set(slotPairs.map((p) => p.groupName)));
    } else {
      const slots = await this.prisma.scheduleSlot.findMany({
        where: {
          academicYear: period.academicYear,
          term: period.term,
          ...(f.subjectId ? { subjectId: f.subjectId } : {}),
          ...(f.groupName ? { groupName: f.groupName } : {}),
          ...(f.teacherId ? { teacherId: f.teacherId } : {}),
          ...(f.department ? { teacher: { department: f.department } } : {}),
        },
        distinct: ['subjectId', 'groupName'],
        select: { subjectId: true, groupName: true },
      });
      slotPairs = slots;
      gradePairsAllowed = !f.teacherId && !f.department;
    }

    // 2) студенты в области видимости
    const studentWhere: Prisma.StudentWhereInput = {
      user: {
        status: 'ACTIVE',
        ...(f.search ? { OR: [{ fullName: { contains: f.search, mode: 'insensitive' } }, { loginId: { contains: f.search } }] } : {}),
      },
      ...(f.faculty ? { faculty: f.faculty } : {}),
    };
    if (groupsScope) studentWhere.groupName = { in: groupsScope };
    else if (f.groupName) studentWhere.groupName = f.groupName;
    else if (!gradePairsAllowed) studentWhere.groupName = { in: Array.from(new Set(slotPairs.map((p) => p.groupName))) };

    const students = await this.prisma.student.findMany({
      where: studentWhere,
      select: { userId: true, groupName: true, faculty: true, user: { select: { loginId: true, fullName: true } } },
      orderBy: [{ groupName: 'asc' }, { user: { fullName: 'asc' } }],
      take: 6000,
    });
    if (!students.length) return { period, closed, records: [] };
    const ids = students.map((s) => s.userId);

    // 3) оценки периода (только типы формулы)
    const subjectFilter = f.subjectId ? { subjectId: f.subjectId } : viewer.scope === SCOPE_ASSIGNED ? { subjectId: { in: Array.from(new Set(slotPairs.map((p) => p.subjectId))) } } : {};
    const grades = await this.prisma.grade.findMany({
      where: { studentId: { in: ids }, academicYear: period.academicYear, term: period.term, type: { in: T as any }, ...subjectFilter },
      select: { id: true, studentId: true, subjectId: true, type: true, value: true, publishedAt: true, createdAt: true, updatedAt: true, teacherId: true, comment: true },
    });

    // 4) пары: расписание (+ пары, где уже есть оценки — для архивных периодов, только руководство)
    const groupByStudent = new Map(students.map((s) => [s.userId, s.groupName]));
    const pairKey = (subjectId: string, groupName: string) => subjectId + '|' + groupName;
    const pairs = new Set(slotPairs.map((p) => pairKey(p.subjectId, p.groupName)));
    if (gradePairsAllowed) for (const g of grades) pairs.add(pairKey(g.subjectId, groupByStudent.get(g.studentId)!));

    const subjectIds = Array.from(new Set(Array.from(pairs).map((k) => k.split('|')[0])));
    const [subjects, attendanceRows, slotTeachers] = await Promise.all([
      this.prisma.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, code: true, name: true, credits: true, color: true } }),
      this.prisma.attendance.groupBy({
        by: ['studentId', 'subjectId', 'status'],
        where: { studentId: { in: ids }, subjectId: { in: subjectIds }, academicYear: period.academicYear, term: period.term },
        _count: { _all: true },
      }),
      this.prisma.scheduleSlot.findMany({
        where: { academicYear: period.academicYear, term: period.term, subjectId: { in: subjectIds }, teacherId: { not: null } },
        distinct: ['subjectId', 'groupName', 'teacherId'],
        select: { subjectId: true, groupName: true, teacher: { select: { user: { select: { fullName: true } } } } },
      }),
    ]);
    const subjectById = new Map(subjects.map((s) => [s.id, s]));
    const teachersByPair = new Map<string, string[]>();
    for (const s of slotTeachers) {
      const k = pairKey(s.subjectId, s.groupName);
      const arr = teachersByPair.get(k) ?? [];
      const name = s.teacher?.user.fullName;
      if (name && !arr.includes(name)) arr.push(name);
      teachersByPair.set(k, arr);
    }
    const gradesByKey = new Map<string, typeof grades>();
    for (const g of grades) {
      const k = g.studentId + '|' + g.subjectId;
      (gradesByKey.get(k) ?? gradesByKey.set(k, []).get(k)!).push(g);
    }
    const attByKey = new Map<string, { total: number; absent: number }>();
    for (const a of attendanceRows) {
      const k = a.studentId + '|' + a.subjectId;
      const cur = attByKey.get(k) ?? { total: 0, absent: 0 };
      cur.total += a._count._all;
      if (a.status === 'ABSENT') cur.absent += a._count._all;
      attByKey.set(k, cur);
    }

    const records: JournalRecord[] = [];
    for (const s of students) {
      for (const subjectId of subjectIds) {
        if (!pairs.has(pairKey(subjectId, s.groupName))) continue;
        const subject = subjectById.get(subjectId);
        if (!subject) continue;
        const rows = gradesByKey.get(s.userId + '|' + subjectId) ?? [];
        const summary = summarizeSubject(rows, { periodClosed: closed, lowTotal: this.settings.passMark });
        const att = attByKey.get(s.userId + '|' + subjectId);
        records.push({
          ...summary,
          key: s.userId + ':' + subjectId,
          student: { id: s.userId, loginId: s.user.loginId, fullName: s.user.fullName, groupName: s.groupName, faculty: s.faculty },
          subject,
          teachers: teachersByPair.get(pairKey(subjectId, s.groupName)) ?? [],
          period: { ...period, closed },
          attendance: att ? { total: att.total, absent: att.absent, rate: attendanceRate({ total: att.total, ABSENT: att.absent }) } : null,
          canEdit: canWrite(viewer) && (!closed || viewer.caps.override),
        });
      }
    }
    const filtered = f.status ? records.filter((r) => r.status === f.status) : records;
    return { period, closed, records: filtered };
  }

  // ───────────────────────── листинг + сводка (scope ASSIGNED / ALL) ─────────────────────────
  async records(viewer: Viewer, f: Filters, page: number, pageSize: number) {
    const { period, closed, records } = await this.load(viewer, f);
    const start = (page - 1) * pageSize;
    return {
      period: { ...period, closed },
      page,
      pageSize,
      total: records.length,
      items: records.slice(start, start + pageSize),
      summary: this.summarizeRecords(records),
    };
  }

  summarizeRecords(records: JournalRecord[]) {
    const students = new Set(records.map((r) => r.student.id));
    const subjects = new Set(records.map((r) => r.subject.id));
    const complete = records.filter((r) => r.total.final);
    const rates = records.map((r) => r.attendance?.rate).filter((x): x is number => x != null);
    const lowAtt = records.filter((r) => r.attendance?.rate != null && r.attendance.rate < this.settings.lowAttendance);
    const failing = complete.filter((r) => Number(r.total.exact) < this.settings.passMark);
    const atRisk = new Set([...lowAtt, ...failing].map((r) => r.student.id));
    const count = (st: JournalStatus) => records.filter((r) => r.status === st).length;
    return {
      students: students.size,
      subjects: subjects.size,
      records: records.length,
      averageTotal: r1(avg(complete.map((r) => Number(r.total.exact)))),
      provisional: count('PROVISIONAL'),
      ready: count('READY'),
      published: count('PUBLISHED') + count('LOCKED'),
      locked: count('LOCKED'),
      missingGrades: records.filter((r) => !r.final || !r.midterm).length,
      seminarIncomplete: records.filter((r) => !r.seminar.eligible).length,
      lowAttendance: lowAtt.length,
      averageAttendance: r1(avg(rates)),
      atRisk: atRisk.size,
      completion: records.length ? Math.round((complete.length / records.length) * 100) : null,
    };
  }

  // ───────────────────────── детали записи (scope ASSIGNED / ALL) ─────────────────────────
  async recordDetail(viewer: Viewer, studentId: string, subjectId: string, q: { academicYear?: string; term?: Term }) {
    const student = await this.prisma.student.findUnique({ where: { userId: studentId }, select: { groupName: true } });
    if (!student) throw new NotFoundException('Student not found');
    if (viewer.scope === SCOPE_ASSIGNED) await this.access.assertCanTeach(viewer.id, subjectId, student.groupName);
    else if (viewer.scope !== SCOPE_ALL) throw new ForbiddenException({ message: 'Not available for your access level', code: 'SCOPE_DENIED' });

    const { records } = await this.load(viewer, { ...q, subjectId, groupName: student.groupName });
    const rec = records.find((r) => r.student.id === studentId && r.subject.id === subjectId);
    if (!rec) throw new NotFoundException('Journal record not found');

    const period = this.resolvePeriod(q);
    const events = await this.prisma.auditLog.findMany({
      where: {
        action: { startsWith: 'journal.' },
        AND: [
          { diff: { path: ['studentId'], equals: studentId } },
          { diff: { path: ['subjectId'], equals: subjectId } },
          { diff: { path: ['academicYear'], equals: period.academicYear } },
          { diff: { path: ['term'], equals: period.term } },
        ],
      },
      include: { actor: { select: { loginId: true, fullName: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const attendance = await this.prisma.attendance.findMany({
      where: { studentId, subjectId, academicYear: period.academicYear, term: period.term },
      orderBy: { classDate: 'desc' },
      take: 60,
      select: { classDate: true, status: true },
    });
    return {
      record: rec,
      history: events.map((e) => this.eventView(e)),
      attendanceLog: attendance.map((a) => ({ date: a.classDate.toISOString().slice(0, 10), status: a.status })),
    };
  }

  private eventView(e: { id: string; action: string; createdAt: Date; diff: Prisma.JsonValue; actor: { loginId: string; fullName: string; role: Role } | null }) {
    const d = (e.diff ?? {}) as Record<string, any>;
    return {
      id: e.id,
      action: e.action,
      at: e.createdAt.toISOString(),
      actor: e.actor ? { loginId: e.actor.loginId, fullName: e.actor.fullName, role: e.actor.role } : null,
      component: d.component ?? null,
      old: d.old ?? null,
      new: d.new ?? null,
      max: d.max ?? null,
      reason: d.reason ?? null,
      answerNo: d.answerNo ?? null,
    };
  }

  // ───────────────────────── STUDENT ─────────────────────────
  private async studentSubjects(userId: string, period: { academicYear: string; term: Term }) {
    const st = await this.prisma.student.findUnique({ where: { userId }, select: { groupName: true } });
    if (!st) throw new ForbiddenException('Only students have a personal journal');
    const [graded, slots] = await Promise.all([
      this.prisma.grade.findMany({ where: { studentId: userId, ...period, type: { in: T as any }, publishedAt: { not: null } }, distinct: ['subjectId'], select: { subjectId: true } }),
      this.prisma.scheduleSlot.findMany({ where: { groupName: st.groupName, ...period }, distinct: ['subjectId'], select: { subjectId: true } }),
    ]);
    return Array.from(new Set([...graded.map((g) => g.subjectId), ...slots.map((s) => s.subjectId)]));
  }

  /** Только собственный журнал: userId берётся из JWT, опубликованные оценки */
  async myJournal(userId: string, q: { academicYear?: string; term?: Term }) {
    const period = this.resolvePeriod(q);
    const periodRow = await this.periods.get(period.academicYear, period.term);
    const closed = periodRow?.status === 'CLOSED';
    const subjectIds = await this.studentSubjects(userId, period);
    const [subjects, rows, att, transcript] = await Promise.all([
      this.prisma.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, code: true, name: true, credits: true, color: true }, orderBy: { code: 'asc' } }),
      this.prisma.grade.findMany({
        where: { studentId: userId, subjectId: { in: subjectIds }, ...period, type: { in: T as any } },
        select: { id: true, subjectId: true, type: true, value: true, publishedAt: true, createdAt: true, updatedAt: true, comment: true },
      }),
      this.prisma.attendance.groupBy({ by: ['subjectId', 'status'], where: { studentId: userId, subjectId: { in: subjectIds }, ...period }, _count: { _all: true } }),
      this.students.getTranscript(userId),
    ]);
    const visible = publishedOnly(rows);
    const attBySubject = new Map<string, { total: number; absent: number }>();
    for (const a of att) {
      const cur = attBySubject.get(a.subjectId) ?? { total: 0, absent: 0 };
      cur.total += a._count._all;
      if (a.status === 'ABSENT') cur.absent += a._count._all;
      attBySubject.set(a.subjectId, cur);
    }
    const items = subjects.map((s) => {
      const sum = summarizeSubject(visible.filter((r) => r.subjectId === s.id), { periodClosed: closed, lowTotal: this.settings.passMark });
      const a = attBySubject.get(s.id);
      return {
        subject: s,
        ...sum,
        letter: sum.complete ? toLetter(Number(sum.total.exact)) : null,
        attendance: a ? { total: a.total, absent: a.absent, rate: attendanceRate({ total: a.total, ABSENT: a.absent }) } : null,
      };
    });
    const done = items.filter((i) => i.complete);
    const attAll = Array.from(attBySubject.values()).reduce((s, x) => ({ total: s.total + x.total, absent: s.absent + x.absent }), { total: 0, absent: 0 });
    const semGpa = transcript.periods.find((p) => p.academicYear === period.academicYear && p.term === period.term)?.semesterGPA ?? null;
    return {
      period: { ...period, closed },
      cards: {
        gpa: transcript.summary.cumulativeGPA,
        semesterGpa: semGpa,
        averageScore: r1(avg(done.map((i) => Number(i.total.exact)))),
        attendance: attendanceRate({ total: attAll.total, ABSENT: attAll.absent }),
        completedSubjects: done.length,
        totalSubjects: items.length,
      },
      items,
    };
  }

  async myJournalSubject(userId: string, subjectId: string, q: { academicYear?: string; term?: Term }) {
    const period = this.resolvePeriod(q);
    const all = await this.myJournal(userId, q);
    const item = all.items.find((i) => i.subject.id === subjectId);
    if (!item) throw new NotFoundException('Subject not found in your journal');
    // История изменений своих опубликованных оценок (без имён авторов)
    const hist = await this.prisma.gradeHistory.findMany({
      where: { grade: { studentId: userId, subjectId, ...period, type: { in: T as any }, publishedAt: { not: null } } },
      include: { grade: { select: { type: true, createdAt: true } } },
      orderBy: { changedAt: 'desc' },
      take: 60,
    });
    return {
      period: all.period,
      ...item,
      history: hist.map((h) => ({ at: h.changedAt.toISOString(), component: h.grade.type, old: Number(h.oldValue), new: Number(h.newValue), reason: h.reason })),
    };
  }

  // ───────────────────────── Аналитика (reports.view) ─────────────────────────
  async analytics(viewer: Viewer, f: Filters) {
    const { period, closed, records } = await this.load(viewer, f);
    const complete = records.filter((r) => r.total.final);
    const passed = complete.filter((r) => Number(r.total.exact) >= this.settings.passMark);
    const bands = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 } as Record<string, number>;
    for (const r of complete) bands[toLetter(Number(r.total.exact))]++;

    const attBand = (lo: number, hi: number) => {
      const rs = complete.filter((r) => r.attendance?.rate != null && r.attendance.rate >= lo && r.attendance.rate < hi);
      return { from: lo, to: hi === 101 ? 100 : hi, records: rs.length, averageTotal: r1(avg(rs.map((r) => Number(r.total.exact)))) };
    };

    const bySubject = new Map<string, JournalRecord[]>();
    for (const r of records) (bySubject.get(r.subject.id) ?? bySubject.set(r.subject.id, []).get(r.subject.id)!).push(r);

    return {
      period: { ...period, closed },
      summary: this.summarizeRecords(records),
      averages: {
        total: { value: r1(avg(complete.map((r) => Number(r.total.exact)))), max: JOURNAL_RULES.TOTAL_MAX },
        final: { value: r1(avg(records.filter((r) => r.final).map((r) => r.final!.score))), max: JOURNAL_RULES.FINAL_MAX },
        midterm: { value: r1(avg(records.filter((r) => r.midterm).map((r) => r.midterm!.score))), max: JOURNAL_RULES.MIDTERM_MAX },
        seminar: { value: r1(avg(records.filter((r) => r.seminar.eligible).map((r) => r.seminar.score!))), max: JOURNAL_RULES.SEMINAR_MAX },
      },
      seminarCompletionRate: records.length ? Math.round((records.filter((r) => r.seminar.eligible).length / records.length) * 100) : null,
      passRate: complete.length ? Math.round((passed.length / complete.length) * 100) : null,
      passMark: this.settings.passMark,
      missingGradeRate: records.length ? Math.round((records.filter((r) => !r.final || !r.midterm).length / records.length) * 100) : null,
      distribution: bands,
      attendanceRelation: [attBand(0, this.settings.lowAttendance), attBand(this.settings.lowAttendance, 90), attBand(90, 101)],
      bySubject: Array.from(bySubject.entries())
        .map(([, rs]) => {
          const c = rs.filter((r) => r.total.final);
          return {
            subject: { id: rs[0].subject.id, code: rs[0].subject.code, name: rs[0].subject.name },
            records: rs.length,
            averageTotal: r1(avg(c.map((r) => Number(r.total.exact)))),
            completion: Math.round((c.length / rs.length) * 100),
            seminarCompletion: Math.round((rs.filter((r) => r.seminar.eligible).length / rs.length) * 100),
          };
        })
        .sort((a, b) => a.subject.code.localeCompare(b.subject.code)),
    };
  }

  async compare(viewer: Viewer, groups: string[], f: Filters) {
    const uniq = Array.from(new Set(groups)).slice(0, 8);
    const out = [];
    for (const g of uniq) {
      const { records } = await this.load(viewer, { ...f, groupName: g });
      const s = this.summarizeRecords(records);
      out.push({
        groupName: g,
        students: s.students,
        averageTotal: s.averageTotal,
        averageAttendance: s.averageAttendance,
        seminarCompletion: records.length ? Math.round((records.filter((r) => r.seminar.eligible).length / records.length) * 100) : null,
        provisional: s.provisional,
        missingGrades: s.missingGrades,
        atRisk: s.atRisk,
      });
    }
    return { period: this.resolvePeriod(f), groups: out };
  }
}
