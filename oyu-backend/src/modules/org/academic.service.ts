import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SettingsService } from '../admin/settings.service';
import { groupJournalRecords } from '../journal/journal.calc';

export type ItemStatus = 'PASSED' | 'DEBT' | 'IN_PROGRESS' | 'PLANNED' | 'NOT_CHOSEN';
const TYPES = ['SEMINAR', 'MIDTERM', 'FINAL'] as const;
export const PROJECT_TYPES = ['PRACTICE', 'THESIS'] as const;
export const PROJECT_STATUSES = ['PLANNED', 'IN_PROGRESS', 'SUBMITTED', 'DEFENDED', 'COMPLETED'] as const;

/**
 * Академический прогресс бакалавра по учебному плану специальности:
 * кредиты (заработано / 240), статус каждого предмета, задолженности, выборные предметы.
 * Итог предмета — та же формула Academic Journal (Final 50 / Midterm 30 / Seminar 20), проходной балл — настройка journal.passMark.
 */
@Injectable()
export class AcademicService {
  constructor(private readonly prisma: PrismaService, private readonly settings: SettingsService) {}

  async progress(studentId: string) {
    const st = await this.prisma.student.findUnique({ where: { userId: studentId }, include: { user: { select: { fullName: true, loginId: true } } } });
    if (!st) throw new NotFoundException('Student not found');
    const group = await this.prisma.academicGroup.findUnique({
      where: { name: st.groupName },
      include: { specialty: { include: { department: { include: { faculty: true } }, curriculum: { orderBy: [{ semester: 'asc' }, { kind: 'asc' }], include: { subject: { select: { id: true, code: true, name: true, color: true } } } } } } },
    });
    const [grades, choices, examResults] = await Promise.all([
      this.prisma.grade.findMany({ where: { studentId, type: { in: [...TYPES] }, publishedAt: { not: null } }, select: { id: true, type: true, value: true, publishedAt: true, createdAt: true, updatedAt: true, subjectId: true, academicYear: true, term: true, studentId: true } }),
      this.prisma.electiveChoice.findMany({ where: { studentId }, select: { curriculumItemId: true } }),
      // Exam System: официальный итог экзамена (Total >= 51 И Exam >= 17) приоритетнее простого порога по сумме журнала
      this.prisma.examResult.findMany({ where: { studentId, publishedAt: { not: null } }, orderBy: { createdAt: 'asc' }, select: { passed: true, enrollment: { select: { subjectId: true } } } }),
    ]);
    const examBySubject = new Map(examResults.map((r) => [r.enrollment.subjectId, r.passed]));
    const pass = this.settings.passMark;
    // лучшая (последняя) запись Journal по каждому предмету
    const bySubject = new Map<string, { total: number; complete: boolean; period: string }>();
    for (const r of groupJournalRecords(grades)) {
      const prev = bySubject.get(r.subjectId), period = `${r.academicYear} ${r.term}`;
      if (!prev || period > prev.period) bySubject.set(r.subjectId, { total: Number(r.summary.total.score), complete: r.summary.complete, period });
    }
    const base = {
      student: { id: studentId, fullName: st.user.fullName, loginId: st.user.loginId, groupName: st.groupName, course: st.course, semester: st.semester },
      passMark: pass,
    };
    if (!group || !group.specialty.curriculum.length) {
      return { ...base, specialty: group ? this.specView(group.specialty) : null, hasPlan: false, earned: 0, required: group?.specialty.totalCredits ?? 240, percent: 0, semesters: [], debts: [], electives: [] };
    }
    const sp = group.specialty;
    const chosen = new Set(choices.map((c) => c.curriculumItemId));
    // выбор по каждой группе альтернатив: явный выбор, иначе — предмет, по которому уже есть оценки
    const pickByGroup = new Map<string, string | null>();
    for (const c of sp.curriculum.filter((i) => i.electiveGroup)) {
      const g = c.electiveGroup!;
      if (chosen.has(c.id)) pickByGroup.set(g, c.id);
      else if (!pickByGroup.get(g) && bySubject.has(c.subjectId)) pickByGroup.set(g, c.id);
      else if (!pickByGroup.has(g)) pickByGroup.set(g, null);
    }
    const items = sp.curriculum.map((c) => {
      const res = bySubject.get(c.subjectId) ?? null;
      const isElective = !!c.electiveGroup;
      const selected = !isElective || pickByGroup.get(c.electiveGroup!) === c.id;
      let status: ItemStatus;
      if (isElective && !selected) status = pickByGroup.get(c.electiveGroup!) ? 'PLANNED' : 'NOT_CHOSEN';
      else if (c.semester > st.semester) status = 'PLANNED';
      else if (examBySubject.has(c.subjectId)) status = examBySubject.get(c.subjectId) ? 'PASSED' : 'DEBT';
      else if (res && res.complete && res.total >= pass) status = 'PASSED';
      else if (c.semester === st.semester) status = 'IN_PROGRESS';
      else status = 'DEBT';
      return {
        id: c.id, semester: c.semester, credits: c.credits, kind: c.kind, control: c.control, electiveGroup: c.electiveGroup, selected,
        subject: c.subject, total: res ? Math.round(res.total * 10) / 10 : null, complete: res?.complete ?? false, status,
      };
    });
    const counted = items.filter((i) => i.selected);
    const earned = counted.filter((i) => i.status === 'PASSED').reduce((a, i) => a + i.credits, 0);
    const semesters = Array.from(new Set(items.map((i) => i.semester))).sort((a, b) => a - b).map((n) => {
      const own = items.filter((i) => i.semester === n);
      return { semester: n, credits: own.filter((i) => i.selected).reduce((a, i) => a + i.credits, 0), items: own };
    });
    const electiveGroups = Array.from(new Set(items.filter((i) => i.electiveGroup).map((i) => i.electiveGroup!)));
    return {
      ...base,
      specialty: this.specView(sp),
      hasPlan: true,
      earned, required: sp.totalCredits, percent: Math.round((earned / sp.totalCredits) * 1000) / 10,
      semesters,
      debts: counted.filter((i) => i.status === 'DEBT').map((i) => ({ semester: i.semester, subject: i.subject, credits: i.credits, total: i.total })),
      electives: electiveGroups.map((g) => {
        const opts = items.filter((i) => i.electiveGroup === g);
        return { group: g, semester: opts[0].semester, credits: opts[0].credits, chosenId: pickByGroup.get(g) ?? null, locked: opts[0].semester <= st.semester, options: opts.map((o) => ({ id: o.id, subject: o.subject })) };
      }),
    };
  }

  private specView(sp: { id: string; code: string; name: string; totalCredits: number; durationYears: number; department: { name: string; faculty: { name: string } } }) {
    return { id: sp.id, code: sp.code, name: sp.name, totalCredits: sp.totalCredits, durationYears: sp.durationYears, department: sp.department.name, faculty: sp.department.faculty.name };
  }

  /** Выбор выборного предмета: только для будущих семестров; в группе альтернатив — один выбор */
  async chooseElective(studentId: string, itemId: string) {
    const st = await this.prisma.student.findUnique({ where: { userId: studentId }, select: { groupName: true, semester: true } });
    if (!st) throw new ForbiddenException('Only students can choose electives');
    const item = await this.prisma.curriculumItem.findUnique({ where: { id: itemId }, include: { specialty: { include: { groups: { select: { name: true } } } } } });
    if (!item || !item.electiveGroup) throw new NotFoundException('Elective not found');
    if (!item.specialty.groups.some((g) => g.name === st.groupName)) throw new ForbiddenException('This elective is not in your curriculum');
    if (item.semester <= st.semester) throw new BadRequestException({ message: 'Electives of the current or past semesters cannot be changed', code: 'ELECTIVE_LOCKED' });
    const siblings = await this.prisma.curriculumItem.findMany({ where: { specialtyId: item.specialtyId, electiveGroup: item.electiveGroup }, select: { id: true } });
    await this.prisma.$transaction([
      this.prisma.electiveChoice.deleteMany({ where: { studentId, curriculumItemId: { in: siblings.map((s) => s.id) } } }),
      this.prisma.electiveChoice.create({ data: { studentId, curriculumItemId: itemId } }),
    ]);
    return this.progress(studentId);
  }

  /** Задолженности студентов в пределах области (groups=null — все) */
  async debts(groups: string[] | null) {
    const students = await this.prisma.student.findMany({ where: { ...(groups ? { groupName: { in: groups } } : {}), user: { status: 'ACTIVE' } }, select: { userId: true }, orderBy: { groupName: 'asc' } });
    const out = [];
    for (const s of students) {
      const p = await this.progress(s.userId);
      if (p.debts.length) out.push({ student: p.student, specialty: p.specialty?.name ?? null, earned: p.earned, required: p.required, debts: p.debts });
    }
    return { total: out.length, items: out };
  }

  // ───────── практика и выпускные работы ─────────
  async projects(q: { type?: string; status?: string; groupName?: string }, groups: string[] | null) {
    const where: Prisma.StudentProjectWhereInput = {
      ...(q.type ? { type: q.type } : {}), ...(q.status ? { status: q.status } : {}),
      student: { ...(groups ? { groupName: { in: groups } } : {}), ...(q.groupName ? { groupName: q.groupName } : {}) },
    };
    const rows = await this.prisma.studentProject.findMany({
      where, orderBy: [{ type: 'asc' }, { student: { groupName: 'asc' } }],
      include: { student: { select: { groupName: true, course: true, user: { select: { fullName: true, loginId: true } } } }, supervisor: { select: { user: { select: { fullName: true } } } } },
      take: 500,
    });
    return rows.map((r) => this.projectView(r));
  }

  async myProjects(studentId: string) {
    const rows = await this.prisma.studentProject.findMany({ where: { studentId }, orderBy: { startDate: 'asc' }, include: { student: { select: { groupName: true, course: true, user: { select: { fullName: true, loginId: true } } } }, supervisor: { select: { user: { select: { fullName: true } } } } } });
    return rows.map((r) => this.projectView(r));
  }

  async updateProject(id: string, dto: { title?: string; organization?: string | null; status?: string; grade?: number | null; note?: string | null; supervisorId?: string | null }, groups: string[] | null) {
    const cur = await this.prisma.studentProject.findUnique({ where: { id }, include: { student: { select: { groupName: true } } } });
    if (!cur) throw new NotFoundException('Project not found');
    if (groups && !groups.includes(cur.student.groupName)) throw new ForbiddenException({ message: 'Outside your area of responsibility', code: 'ORG_SCOPE_DENIED' });
    const row = await this.prisma.studentProject.update({ where: { id }, data: dto, include: { student: { select: { groupName: true, course: true, user: { select: { fullName: true, loginId: true } } } }, supervisor: { select: { user: { select: { fullName: true } } } } } });
    return { before: { status: cur.status, grade: cur.grade == null ? null : Number(cur.grade), title: cur.title }, after: this.projectView(row) };
  }

  private projectView(r: { id: string; type: string; title: string; organization: string | null; status: string; grade: Prisma.Decimal | null; note: string | null; startDate: Date | null; endDate: Date | null; supervisorId: string | null; student: { groupName: string; course: number; user: { fullName: string; loginId: string } }; supervisor: { user: { fullName: string } } | null; studentId: string }) {
    return {
      id: r.id, type: r.type, title: r.title, organization: r.organization, status: r.status, grade: r.grade == null ? null : Number(r.grade), note: r.note,
      startDate: r.startDate, endDate: r.endDate, supervisorId: r.supervisorId, supervisor: r.supervisor?.user.fullName ?? null,
      student: { id: r.studentId, fullName: r.student.user.fullName, loginId: r.student.user.loginId, groupName: r.student.groupName, course: r.student.course },
    };
  }
}
