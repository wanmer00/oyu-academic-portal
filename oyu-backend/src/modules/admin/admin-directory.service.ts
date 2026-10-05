import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PermissionScope, Prisma, Role, UserStatus } from '@prisma/client';
import { AuditCtx, AuditTrailService } from '../../common/audit/audit-trail.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AttendanceService } from '../attendance/attendance.service';
import { JournalService } from '../journal/journal.service';
import { CURRENT_PERIOD } from '../teachers/teacher-access.service';
import {
  AssignTeacherDto, CreateStudentDto, CreateSubjectDto, CreateTeacherDto, StudentsQuery, SubjectsQuery, TeachersQuery,
  UpdateStudentDto, UpdateSubjectDto, UpdateTeacherDto,
} from './admin-people.dto';
import { ActorRef, AdminUsersService, tempPassword } from './admin-users.service';

const ALL_GRANT = { permission: 'attendance.view', scope: PermissionScope.ALL };
const DAY = 86_400_000;

/** Справочники Admin Panel: студенты, преподаватели и их назначения, группы, предметы. */
@Injectable()
export class AdminDirectoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditTrailService,
    private readonly users: AdminUsersService,
    private readonly attendance: AttendanceService,
    private readonly journal: JournalService,
  ) {}

  // ═════════════════════════ STUDENTS ═════════════════════════
  /** groups — область руководства (null = без ограничений) */
  async listStudents(q: StudentsQuery, groups: string[] | null = null) {
    const take = Math.min(q.take ?? 50, 200);
    const where: Prisma.StudentWhereInput = {
      user: {
        status: q.status ? (q.status as UserStatus) : { in: [UserStatus.ACTIVE, UserStatus.SUSPENDED] },
        ...(q.search ? { OR: [{ fullName: { contains: q.search, mode: 'insensitive' } }, { loginId: { contains: q.search } }, { email: { contains: q.search, mode: 'insensitive' } }] } : {}),
      },
      ...(q.groupName ? { groupName: groups && !groups.includes(q.groupName) ? '\u0000none' : q.groupName } : groups ? { groupName: { in: groups } } : {}),
      ...(q.course ? { course: q.course } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.student.count({ where }),
      this.prisma.student.findMany({
        where,
        take: take + 1,
        ...(q.cursor && { cursor: { userId: q.cursor }, skip: 1 }),
        orderBy: [{ user: { fullName: 'asc' } }, { userId: 'asc' }],
        select: {
          userId: true, faculty: true, specialty: true, groupName: true, course: true, semester: true, level: true, birthDate: true,
          user: { select: { loginId: true, fullName: true, email: true, phone: true, status: true, lastLoginAt: true } },
        },
      }),
    ]);
    const hasMore = rows.length > take;
    const items = (hasMore ? rows.slice(0, take) : rows).map((s) => ({
      id: s.userId, loginId: s.user.loginId, fullName: s.user.fullName, email: s.user.email, phone: s.user.phone, status: s.user.status, lastLoginAt: s.user.lastLoginAt,
      faculty: s.faculty, specialty: s.specialty, groupName: s.groupName, course: s.course, semester: s.semester, level: s.level, birthDate: s.birthDate,
    }));
    return { total, items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  async getStudent(id: string) {
    const s = await this.prisma.student.findUnique({
      where: { userId: id },
      select: {
        userId: true, faculty: true, specialty: true, groupName: true, course: true, semester: true, level: true, birthDate: true,
        user: { select: { loginId: true, fullName: true, email: true, phone: true, status: true, preferredLang: true, lastLoginAt: true, createdAt: true } },
      },
    });
    if (!s) throw new NotFoundException('Student not found');
    const [att, jr] = await Promise.all([
      this.attendance.student({ id: 'admin', role: Role.ADMIN }, ALL_GRANT, { studentId: id }),
      this.journal.myJournal(id, {}),
    ]);
    return {
      id: s.userId, ...s.user, faculty: s.faculty, specialty: s.specialty, groupName: s.groupName, course: s.course, semester: s.semester, level: s.level, birthDate: s.birthDate,
      attendance: { period: att.period, totals: att.totals, exceeded: att.exceeded },
      journal: { period: jr.period, cards: jr.cards },
    };
  }

  async createStudent(actor: ActorRef, dto: CreateStudentDto, ctx: AuditCtx) {
    await this.users.assertUnique(dto.loginId, dto.email);
    const loginId = dto.loginId ?? (await this.users.freeLoginId(Role.STUDENT));
    const pw = dto.password ?? tempPassword();
    const passwordHash = await this.users.hash(pw);
    const created = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          loginId, email: dto.email, fullName: dto.fullName, role: Role.STUDENT, phone: dto.phone ?? null, preferredLang: dto.preferredLang ?? 'az', passwordHash,
          student: { create: { faculty: dto.faculty, specialty: dto.specialty, groupName: dto.groupName, course: dto.course, semester: dto.semester, level: dto.level, birthDate: dto.birthDate ? new Date(dto.birthDate) : null } },
        },
        select: { id: true, loginId: true, fullName: true, email: true },
      });
      await this.audit.recordTx(tx, { actorId: actor.id, action: 'student.create', targetType: 'Student', targetId: u.id, new: { loginId: u.loginId, fullName: u.fullName, groupName: dto.groupName, course: dto.course, level: dto.level } }, ctx);
      return u;
    });
    return { student: created, temporaryPassword: dto.password ? undefined : pw };
  }

  async updateStudent(actor: ActorRef, id: string, dto: UpdateStudentDto, ctx: AuditCtx) {
    const cur = await this.prisma.student.findUnique({ where: { userId: id }, include: { user: { select: { loginId: true, fullName: true, email: true, phone: true, status: true } } } });
    if (!cur) throw new NotFoundException('Student not found');
    if (cur.user.status === UserStatus.DELETED) throw new BadRequestException({ message: 'Student is deleted', code: 'BAD_STATE' });
    if (dto.email && dto.email !== cur.user.email) await this.users.assertUnique(undefined, dto.email, id);
    const old: Record<string, unknown> = {};
    const next: Record<string, unknown> = {};
    const userData: Record<string, unknown> = {};
    const stData: Record<string, unknown> = {};
    for (const k of ['fullName', 'email', 'phone'] as const) {
      if (dto[k] !== undefined && dto[k] !== cur.user[k]) { old[k] = cur.user[k]; next[k] = dto[k]; userData[k] = dto[k]; }
    }
    for (const k of ['faculty', 'specialty', 'groupName', 'course', 'semester', 'level'] as const) {
      if (dto[k] !== undefined && dto[k] !== (cur as any)[k]) { old[k] = (cur as any)[k]; next[k] = dto[k]; stData[k] = dto[k]; }
    }
    if (dto.birthDate !== undefined) {
      const nb = dto.birthDate ? new Date(dto.birthDate) : null;
      if ((nb?.getTime() ?? null) !== (cur.birthDate?.getTime() ?? null)) { old.birthDate = cur.birthDate?.toISOString().slice(0, 10) ?? null; next.birthDate = dto.birthDate; stData.birthDate = nb; }
    }
    if (!Object.keys(next).length) return this.getStudent(id);
    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(userData).length) await tx.user.update({ where: { id }, data: userData });
      if (Object.keys(stData).length) await tx.student.update({ where: { userId: id }, data: stData });
      await this.audit.recordTx(tx, { actorId: actor.id, action: 'student.update', targetType: 'Student', targetId: id, old, new: next, extra: { loginId: cur.user.loginId } }, ctx);
    });
    return this.getStudent(id);
  }

  async archiveStudent(actor: ActorRef, id: string, archive: boolean, reason: string | undefined, ctx: AuditCtx) {
    const s = await this.prisma.student.findUnique({ where: { userId: id }, select: { user: { select: { status: true, loginId: true } } } });
    if (!s) throw new NotFoundException('Student not found');
    const from = s.user.status;
    if (archive) {
      if (from !== UserStatus.ACTIVE && from !== UserStatus.SUSPENDED) throw new BadRequestException({ message: 'Only active students can be archived', code: 'BAD_STATE' });
    } else if (from !== UserStatus.ARCHIVED) {
      throw new BadRequestException({ message: 'Student is not archived', code: 'BAD_STATE' });
    }
    const to = archive ? UserStatus.ARCHIVED : UserStatus.ACTIVE;
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { status: to } });
      if (archive) await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.recordTx(tx, { actorId: actor.id, action: archive ? 'student.archive' : 'student.unarchive', targetType: 'Student', targetId: id, old: from, new: to, extra: { reason: reason ?? null, loginId: s.user.loginId } }, ctx);
    });
    return { id, status: to };
  }

  // ═════════════════════════ TEACHERS ═════════════════════════
  private readonly teacherSelect = {
    userId: true, department: true, title: true, experience: true,
    user: { select: { loginId: true, fullName: true, email: true, phone: true, status: true, lastLoginAt: true } },
    scheduleSlots: { select: { subjectId: true, groupName: true, academicYear: true, term: true, subject: { select: { code: true, name: true } } } },
  } satisfies Prisma.TeacherSelect;

  private toTeacherRow(t: Prisma.TeacherGetPayload<{ select: AdminDirectoryService['teacherSelect'] }>) {
    const cur = t.scheduleSlots.filter((s) => s.academicYear === CURRENT_PERIOD.academicYear && s.term === CURRENT_PERIOD.term);
    const pairs = new Map(cur.map((s) => [s.subjectId + '|' + s.groupName, { subjectCode: s.subject.code, subjectName: s.subject.name, groupName: s.groupName }]));
    return {
      userId: t.userId, loginId: t.user.loginId, fullName: t.user.fullName, email: t.user.email, phone: t.user.phone, status: t.user.status, lastLoginAt: t.user.lastLoginAt,
      department: t.department, title: t.title, experience: t.experience, slots: cur.length,
      pairs: Array.from(pairs.values()).sort((a, b) => (a.subjectCode + a.groupName).localeCompare(b.subjectCode + b.groupName)),
    };
  }

  async listTeachers(q: TeachersQuery = {}, groups: string[] | null = null) {
    const rows = await this.prisma.teacher.findMany({
      where: {
        ...(groups ? { scheduleSlots: { some: { groupName: { in: groups } } } } : {}),
        ...(q.department ? { department: q.department } : {}),
        user: {
          status: q.status ? (q.status as UserStatus) : { in: [UserStatus.ACTIVE, UserStatus.SUSPENDED] },
          ...(q.search ? { OR: [{ fullName: { contains: q.search, mode: 'insensitive' } }, { loginId: { contains: q.search } }] } : {}),
        },
      },
      orderBy: { user: { fullName: 'asc' } },
      select: this.teacherSelect,
    });
    return rows.map((t) => this.toTeacherRow(t));
  }

  async getTeacher(id: string) {
    const t = await this.prisma.teacher.findUnique({ where: { userId: id }, select: this.teacherSelect });
    if (!t) throw new NotFoundException('Teacher not found');
    return this.toTeacherRow(t);
  }
  async createTeacher(actor: ActorRef, dto: CreateTeacherDto, ctx: AuditCtx) {
    await this.users.assertUnique(dto.loginId, dto.email);
    const loginId = dto.loginId ?? (await this.users.freeLoginId(Role.TEACHER));
    const pw = dto.password ?? tempPassword();
    const passwordHash = await this.users.hash(pw);
    const created = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          loginId, email: dto.email, fullName: dto.fullName, role: Role.TEACHER, phone: dto.phone ?? null, preferredLang: dto.preferredLang ?? 'az', passwordHash,
          teacher: { create: { department: dto.department, title: dto.title, experience: dto.experience } },
        },
        select: { id: true, loginId: true, fullName: true, email: true },
      });
      await this.audit.recordTx(tx, { actorId: actor.id, action: 'teacher.create', targetType: 'Teacher', targetId: u.id, new: { loginId: u.loginId, fullName: u.fullName, department: dto.department, title: dto.title } }, ctx);
      return u;
    });
    return { teacher: created, temporaryPassword: dto.password ? undefined : pw };
  }

  async updateTeacher(actor: ActorRef, id: string, dto: UpdateTeacherDto, ctx: AuditCtx) {
    const cur = await this.prisma.teacher.findUnique({ where: { userId: id }, include: { user: { select: { loginId: true, fullName: true, email: true, phone: true } } } });
    if (!cur) throw new NotFoundException('Teacher not found');
    if (dto.email && dto.email !== cur.user.email) await this.users.assertUnique(undefined, dto.email, id);
    const old: Record<string, unknown> = {};
    const next: Record<string, unknown> = {};
    const userData: Record<string, unknown> = {};
    const tData: Record<string, unknown> = {};
    for (const k of ['fullName', 'email', 'phone'] as const) {
      if (dto[k] !== undefined && dto[k] !== cur.user[k]) { old[k] = cur.user[k]; next[k] = dto[k]; userData[k] = dto[k]; }
    }
    for (const k of ['department', 'title', 'experience'] as const) {
      if (dto[k] !== undefined && dto[k] !== cur[k]) { old[k] = cur[k]; next[k] = dto[k]; tData[k] = dto[k]; }
    }
    if (Object.keys(next).length) {
      await this.prisma.$transaction(async (tx) => {
        if (Object.keys(userData).length) await tx.user.update({ where: { id }, data: userData });
        if (Object.keys(tData).length) await tx.teacher.update({ where: { userId: id }, data: tData });
        await this.audit.recordTx(tx, { actorId: actor.id, action: 'teacher.update', targetType: 'Teacher', targetId: id, old, new: next, extra: { loginId: cur.user.loginId } }, ctx);
      });
    }
    return this.getTeacher(id);
  }

  private overlaps(a: { dayOfWeek: number; startTime: string; endTime: string; weekParity: string }, b: { dayOfWeek: number; startTime: string; endTime: string; weekParity: string }) {
    if (a.dayOfWeek !== b.dayOfWeek) return false;
    if (!(a.weekParity === 'BOTH' || b.weekParity === 'BOTH' || a.weekParity === b.weekParity)) return false;
    return a.startTime < b.endTime && b.startTime < a.endTime;
  }

  /** Назначение преподавателя на пару «предмет × группа» = перепривязка занятий этой пары в расписании (teachers.assign) */
  async assignTeacher(actor: ActorRef, teacherId: string, dto: AssignTeacherDto, ctx: AuditCtx) {
    const teacher = await this.prisma.teacher.findUnique({ where: { userId: teacherId }, select: { user: { select: { loginId: true, fullName: true, status: true } } } });
    if (!teacher) throw new NotFoundException('Teacher not found');
    if (teacher.user.status !== UserStatus.ACTIVE) throw new BadRequestException({ message: 'Teacher is not active', code: 'BAD_STATE' });
    const subject = await this.prisma.subject.findUnique({ where: { code: dto.subjectCode }, select: { id: true, code: true, isActive: true } });
    if (!subject) throw new NotFoundException('Subject not found');
    const period = { academicYear: dto.academicYear ?? CURRENT_PERIOD.academicYear, term: dto.term ?? CURRENT_PERIOD.term };
    const slots = await this.prisma.scheduleSlot.findMany({ where: { subjectId: subject.id, groupName: dto.groupName, ...period, ...(dto.type ? { type: dto.type } : {}) }, include: { teacher: { select: { user: { select: { loginId: true } } } } } });
    if (!slots.length) throw new NotFoundException({ message: 'No schedule slots for this subject and group. Create them in Schedule first.', code: 'NO_SLOTS' });

    const mine = await this.prisma.scheduleSlot.findMany({ where: { teacherId, ...period, id: { notIn: slots.map((s) => s.id) } } });
    const conflicts = slots.flatMap((s) => mine.filter((m) => this.overlaps(s, m)).map((m) => ({ slotId: s.id, dayOfWeek: s.dayOfWeek, time: `${s.startTime}-${s.endTime}`, withSlotId: m.id, withGroup: m.groupName })));
    if (conflicts.length) throw new ConflictException({ message: 'The teacher has overlapping classes', code: 'TEACHER_CONFLICT', conflicts });

    const before = Array.from(new Set(slots.map((s) => s.teacher?.user.loginId ?? null)));
    await this.prisma.$transaction(async (tx) => {
      await tx.scheduleSlot.updateMany({ where: { id: { in: slots.map((s) => s.id) } }, data: { teacherId } });
      await this.audit.recordTx(tx, { actorId: actor.id, action: 'teacher.assign', targetType: 'ScheduleSlot', targetId: null, old: before, new: teacher.user.loginId, extra: { subjectCode: subject.code, groupName: dto.groupName, slots: slots.length, ...period } }, ctx);
    });
    return { assigned: slots.length, teacher: teacher.user.loginId };
  }

  async unassignTeacher(actor: ActorRef, teacherId: string, dto: AssignTeacherDto, ctx: AuditCtx) {
    const teacher = await this.prisma.teacher.findUnique({ where: { userId: teacherId }, select: { user: { select: { loginId: true } } } });
    if (!teacher) throw new NotFoundException('Teacher not found');
    const subject = await this.prisma.subject.findUnique({ where: { code: dto.subjectCode }, select: { id: true, code: true } });
    if (!subject) throw new NotFoundException('Subject not found');
    const period = { academicYear: dto.academicYear ?? CURRENT_PERIOD.academicYear, term: dto.term ?? CURRENT_PERIOD.term };
    const where = { teacherId, subjectId: subject.id, groupName: dto.groupName, ...period, ...(dto.type ? { type: dto.type } : {}) };
    const n = await this.prisma.scheduleSlot.count({ where });
    if (!n) throw new NotFoundException({ message: 'This teacher is not assigned to the pair', code: 'NOT_ASSIGNED' });
    await this.prisma.$transaction(async (tx) => {
      await tx.scheduleSlot.updateMany({ where, data: { teacherId: null } });
      await this.audit.recordTx(tx, { actorId: actor.id, action: 'teacher.unassign', targetType: 'ScheduleSlot', old: teacher.user.loginId, new: null, extra: { subjectCode: subject.code, groupName: dto.groupName, slots: n, ...period } }, ctx);
    });
    return { unassigned: n };
  }

  // ═════════════════════════ GROUPS ═════════════════════════
  async listGroups(scope: string[] | null = null) {
    const from = new Date(Date.now() - 30 * DAY).toISOString();
    const [students, slots, rep] = await Promise.all([
      this.prisma.student.groupBy({ by: ['groupName', 'level'], where: { user: { status: { in: [UserStatus.ACTIVE, UserStatus.SUSPENDED] } } }, _count: { _all: true } }),
      this.prisma.scheduleSlot.findMany({ where: { academicYear: CURRENT_PERIOD.academicYear, term: CURRENT_PERIOD.term }, select: { groupName: true, teacherId: true, subjectId: true } }),
      this.attendance.report({ id: 'admin', role: Role.ADMIN }, ALL_GRANT, { from }),
    ]);
    const archived = await this.prisma.student.groupBy({ by: ['groupName'], where: { user: { status: UserStatus.ARCHIVED } }, _count: { _all: true } });
    const rate = new Map(rep.groups.map((g) => [g.key, g.rate]));
    const arch = new Map(archived.map((g) => [g.groupName, g._count._all]));
    return students
      .filter((g) => !scope || scope.includes(g.groupName))
      .map((g) => {
        const mine = slots.filter((s) => s.groupName === g.groupName);
        return {
          groupName: g.groupName, level: g.level, studentsCount: g._count._all, archivedCount: arch.get(g.groupName) ?? 0,
          teachers: new Set(mine.map((s) => s.teacherId).filter(Boolean)).size, subjects: new Set(mine.map((s) => s.subjectId)).size,
          attendanceRate30d: rate.get(g.groupName) ?? null,
        };
      })
      .sort((a, b) => a.groupName.localeCompare(b.groupName));
  }

  async getGroup(name: string) {
    const [members, slots] = await Promise.all([
      this.prisma.student.findMany({
        where: { groupName: name },
        orderBy: { user: { fullName: 'asc' } },
        select: { userId: true, course: true, level: true, user: { select: { loginId: true, fullName: true, status: true } } },
      }),
      this.prisma.scheduleSlot.findMany({
        where: { groupName: name, academicYear: CURRENT_PERIOD.academicYear, term: CURRENT_PERIOD.term },
        select: { subject: { select: { id: true, code: true, name: true } }, teacher: { select: { user: { select: { loginId: true, fullName: true } } } }, type: true },
      }),
    ]);
    if (!members.length && !slots.length) throw new NotFoundException('Group not found');
    const pairs = new Map<string, { subject: { id: string; code: string; name: string }; teachers: Set<string>; types: Set<string> }>();
    for (const s of slots) {
      const e = pairs.get(s.subject.id) ?? pairs.set(s.subject.id, { subject: s.subject, teachers: new Set(), types: new Set() }).get(s.subject.id)!;
      if (s.teacher) e.teachers.add(`${s.teacher.user.fullName} (${s.teacher.user.loginId})`);
      e.types.add(s.type);
    }
    return {
      groupName: name,
      members: members.map((m) => ({ id: m.userId, loginId: m.user.loginId, fullName: m.user.fullName, status: m.user.status, course: m.course, level: m.level })),
      subjects: Array.from(pairs.values()).map((p) => ({ ...p.subject, teachers: Array.from(p.teachers), types: Array.from(p.types) })).sort((a, b) => a.code.localeCompare(b.code)),
    };
  }

  /** groups.update: переименование группы во всех таблицах, где группа хранится строкой */
  async renameGroup(actor: ActorRef, name: string, newName: string, ctx: AuditCtx) {
    if (newName === name) throw new BadRequestException({ message: 'New name equals the current one', code: 'SAME_NAME' });
    const [exists, clash] = await Promise.all([
      this.prisma.student.count({ where: { groupName: name } }),
      this.prisma.student.count({ where: { groupName: newName } }),
    ]);
    if (!exists) throw new NotFoundException('Group not found');
    if (clash) throw new ConflictException({ message: 'A group with this name already exists', code: 'GROUP_EXISTS' });
    const res = await this.prisma.$transaction(async (tx) => {
      const [students, slots, events, announcements] = await Promise.all([
        tx.student.updateMany({ where: { groupName: name }, data: { groupName: newName } }),
        tx.scheduleSlot.updateMany({ where: { groupName: name }, data: { groupName: newName } }),
        tx.calendarEvent.updateMany({ where: { groupName: name }, data: { groupName: newName } }),
        tx.announcement.updateMany({ where: { groupName: name }, data: { groupName: newName } }),
      ]);
      const affected = { students: students.count, slots: slots.count, events: events.count, announcements: announcements.count };
      await this.audit.recordTx(tx, { actorId: actor.id, action: 'group.update', targetType: 'Group', targetId: newName, old: name, new: newName, extra: { affected } }, ctx);
      return affected;
    });
    return { groupName: newName, affected: res };
  }

  // ═════════════════════════ SUBJECTS ═════════════════════════
  async listSubjects(q: SubjectsQuery = {}) {
    const rows = await this.prisma.subject.findMany({
      where: { ...(q.active !== undefined ? { isActive: q.active } : {}), ...(q.search ? { OR: [{ code: { contains: q.search, mode: 'insensitive' } }, { name: { contains: q.search, mode: 'insensitive' } }] } : {}) },
      orderBy: { code: 'asc' },
      include: { _count: { select: { schedules: true, grades: true, attendance: true, assignments: true, materials: true } } },
    });
    return rows.map(({ _count, ...s }) => ({ ...s, usage: { slots: _count.schedules, grades: _count.grades, attendance: _count.attendance, assignments: _count.assignments, materials: _count.materials } }));
  }

  async createSubject(actor: ActorRef, dto: CreateSubjectDto, ctx: AuditCtx) {
    const code = dto.code.toUpperCase();
    if (await this.prisma.subject.findUnique({ where: { code }, select: { id: true } })) throw new ConflictException({ message: 'Subject code already exists', code: 'SUBJECT_EXISTS' });
    const s = await this.prisma.$transaction(async (tx) => {
      const created = await tx.subject.create({ data: { code, name: dto.name, credits: dto.credits, semester: dto.semester, description: dto.description ?? null, color: dto.color ?? null } });
      await this.audit.recordTx(tx, { actorId: actor.id, action: 'subject.create', targetType: 'Subject', targetId: created.id, new: { code, name: dto.name, credits: dto.credits, semester: dto.semester } }, ctx);
      return created;
    });
    return s;
  }

  async updateSubject(actor: ActorRef, id: string, dto: UpdateSubjectDto, ctx: AuditCtx) {
    const cur = await this.prisma.subject.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException('Subject not found');
    const old: Record<string, unknown> = {};
    const next: Record<string, unknown> = {};
    for (const k of ['name', 'credits', 'semester', 'description', 'color', 'isActive'] as const) {
      if (dto[k] !== undefined && dto[k] !== (cur as any)[k]) { old[k] = (cur as any)[k]; next[k] = dto[k]; }
    }
    if (!Object.keys(next).length) return cur;
    return this.prisma.$transaction(async (tx) => {
      const s = await tx.subject.update({ where: { id }, data: next as Prisma.SubjectUpdateInput });
      await this.audit.recordTx(tx, { actorId: actor.id, action: 'subject.update', targetType: 'Subject', targetId: id, old, new: next, extra: { code: cur.code } }, ctx);
      return s;
    });
  }

  async deleteSubject(actor: ActorRef, id: string, ctx: AuditCtx) {
    const cur = await this.prisma.subject.findUnique({ where: { id }, include: { _count: { select: { schedules: true, grades: true, attendance: true, assignments: true, materials: true } } } });
    if (!cur) throw new NotFoundException('Subject not found');
    const usage = { slots: cur._count.schedules, grades: cur._count.grades, attendance: cur._count.attendance, assignments: cur._count.assignments, materials: cur._count.materials };
    if (Object.values(usage).some((n) => n > 0)) {
      throw new ConflictException({ message: 'Subject is in use and cannot be deleted. Deactivate it instead.', code: 'SUBJECT_IN_USE', usage });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.subject.delete({ where: { id } });
      await this.audit.recordTx(tx, { actorId: actor.id, action: 'subject.delete', targetType: 'Subject', targetId: id, old: { code: cur.code, name: cur.name } }, ctx);
    });
    return { deleted: true };
  }
}
