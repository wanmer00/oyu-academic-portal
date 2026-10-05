import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Grade, GradeType, PermissionScope, Prisma, Role, Term } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { L10n, NotificationsService } from '../notifications/notifications.service';
import { PermissionsService } from '../../common/rbac/permissions.service';
import { AttendanceService } from '../attendance/attendance.service';
import { TeacherAccessService } from '../teachers/teacher-access.service';
import { COMPONENT_MAX, JOURNAL_RULES, JOURNAL_TYPES, JournalComponent, summarizeSubject } from './journal.calc';
import { BulkDto, ImportDto } from './journal.dto';
import { Caps, JournalService, Viewer } from './journal.service';
import { AuditCtx, PeriodService } from './period.service';

type Actor = Viewer;
type Period = { academicYear: string; term: Term };
type Tx = Prisma.TransactionClient;

interface Target {
  student: { userId: string; groupName: string; loginId: string; fullName: string };
  subject: { id: string; code: string; name: string };
}
interface AuditEvent {
  action: string;
  targetId: string | null;
  diff: Record<string, unknown>;
}
type Note =
  | { kind: 'CHANGED'; studentId: string; subjectName: string; component: JournalComponent; old: number | null; new: number | null; reason?: string | null }
  | { kind: 'PUBLISHED'; studentId: string; subjectId: string; subjectName: string; types: Set<string> };

const TYPES = JOURNAL_TYPES as unknown as string[];
const twoDec = (v: number) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
const MAX_ANSWERS = 50;

function assertScore(kind: JournalComponent, score: unknown): asserts score is number {
  const max = COMPONENT_MAX[kind];
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > max || !twoDec(score)) {
    throw new BadRequestException({ message: `Score must be a number between 0 and ${max} (max 2 decimals)`, code: 'SCORE_OUT_OF_RANGE', field: kind, max });
  }
}
function needReason(published: boolean, reason?: string | null) {
  if (published && (!reason || reason.trim().length < 3)) {
    throw new BadRequestException({ message: 'A reason is required to change a published grade', code: 'REASON_REQUIRED' });
  }
}
const l = (az: string, ru: string, en: string): L10n => ({ az, ru, en });
const COMPONENT_LABEL: Record<JournalComponent, L10n> = {
  FINAL: l('Yekun imtahan', 'Финальный экзамен', 'Final exam'),
  MIDTERM: l('Aralıq imtahan', 'Midterm', 'Midterm'),
  SEMINAR: l('Seminar cavabı', 'Ответ на семинаре', 'Seminar answer'),
};

@Injectable()
export class JournalWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeacherAccessService,
    private readonly periods: PeriodService,
    private readonly notifications: NotificationsService,
    private readonly read: JournalService,
    private readonly attendance: AttendanceService,
    private readonly perms: PermissionsService,
  ) {}

  // ───────────────────────── доступ ─────────────────────────
  /**
   * Запись оценок — по праву grades.* и его scope: ASSIGNED (пары «предмет × группа» преподавателя) или ALL (администратор).
   * OWN / отсутствие права — запись невозможна.
   */
  private assertWriteScope(actor: Actor) {
    if (actor.scope !== PermissionScope.ASSIGNED && actor.scope !== PermissionScope.ALL) {
      throw new ForbiddenException({ message: 'Not available for your access level', code: 'SCOPE_DENIED' });
    }
  }

  private assertCap(actor: Actor, cap: keyof Caps) {
    if (!actor.caps[cap]) throw new ForbiddenException({ message: 'Insufficient permissions', code: 'PERMISSION_DENIED', permission: `grades.${cap}` });
  }

  /** Доступ к паре «предмет × группа»: ASSIGNED — из расписания преподавателя; ALL — пара должна существовать в расписании */
  private async assertPair(actor: Actor, subjectId: string, groupName: string) {
    if (actor.scope === PermissionScope.ASSIGNED) {
      await this.access.assertCanTeach(actor.id, subjectId, groupName);
      return;
    }
    if (actor.scope === PermissionScope.ALL) {
      const slot = await this.prisma.scheduleSlot.findFirst({ where: { subjectId, groupName }, select: { id: true } });
      if (!slot) throw new ForbiddenException({ message: 'This subject is not taught in this group', code: 'NOT_SCHEDULED' });
      return;
    }
    throw new ForbiddenException({ message: 'Not available for your access level', code: 'SCOPE_DENIED' });
  }

  /** Grade.teacherId ссылается на Teacher: администратор не записывается как «преподаватель оценки» */
  private teacherRef(actor: Actor): { teacherId?: string } {
    return actor.role === Role.TEACHER ? { teacherId: actor.id } : {};
  }

  private async targetFor(actor: Actor, studentId: string, subjectId: string): Promise<Target> {
    this.assertWriteScope(actor);
    const [student, subject] = await Promise.all([
      this.prisma.student.findUnique({ where: { userId: studentId }, select: { userId: true, groupName: true, user: { select: { loginId: true, fullName: true, status: true } } } }),
      this.prisma.subject.findUnique({ where: { id: subjectId }, select: { id: true, code: true, name: true } }),
    ]);
    if (!student || student.user.status !== 'ACTIVE') throw new NotFoundException('Student not found');
    if (!subject) throw new NotFoundException('Subject not found');
    await this.assertPair(actor, subjectId, student.groupName);
    return { student: { userId: student.userId, groupName: student.groupName, loginId: student.user.loginId, fullName: student.user.fullName }, subject };
  }

  /** Закрытый период правится только с grades.override; факт override попадает в аудит */
  private async openPeriod(period: Period, actor: Actor) {
    await this.periods.requireExisting(period.academicYear, period.term);
    if (await this.periods.isClosed(period.academicYear, period.term)) {
      if (!actor.caps.override) throw new ForbiddenException({ message: 'Academic period is closed', code: 'PERIOD_CLOSED' });
      actor.overridden = true;
    }
  }

  private lock(tx: Tx, key: string) {
    // executeRaw: pg_advisory_xact_lock возвращает void — $queryRaw не может десериализовать такой столбец
    return tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
  }

  private diff(t: Target, period: Period, component: JournalComponent, extra: Record<string, unknown>) {
    return {
      studentId: t.student.userId,
      studentLoginId: t.student.loginId,
      studentName: t.student.fullName,
      groupName: t.student.groupName,
      subjectId: t.subject.id,
      subjectCode: t.subject.code,
      academicYear: period.academicYear,
      term: period.term,
      component,
      max: COMPONENT_MAX[component],
      ...extra,
    };
  }

  // ───────────────────────── атомарные операции (внутри транзакции) ─────────────────────────
  private async opAddSeminar(tx: Tx, actor: Actor, t: Target, period: Period, score: number, comment: string | undefined, ev: AuditEvent[], extra: Record<string, unknown> = {}) {
    this.assertCap(actor, 'create');
    assertScore('SEMINAR', score);
    await this.lock(tx, `j:${t.student.userId}:${t.subject.id}:${period.academicYear}:${period.term}:S`);
    const n = await tx.grade.count({ where: { studentId: t.student.userId, subjectId: t.subject.id, ...period, type: GradeType.SEMINAR } });
    if (n >= MAX_ANSWERS) throw new BadRequestException({ message: `At most ${MAX_ANSWERS} seminar answers per subject`, code: 'TOO_MANY_ANSWERS' });
    const g = await tx.grade.create({
      data: { studentId: t.student.userId, subjectId: t.subject.id, ...this.teacherRef(actor), value: score, maxValue: JOURNAL_RULES.SEMINAR_ANSWER_MAX, type: GradeType.SEMINAR, comment: comment ?? null, ...period },
    });
    ev.push({ action: 'journal.seminar_add', targetId: g.id, diff: this.diff(t, period, 'SEMINAR', { gradeId: g.id, old: null, new: score, answerNo: n + 1, ...extra }) });
    return g;
  }

  private async opSetComponent(tx: Tx, actor: Actor, t: Target, period: Period, type: 'MIDTERM' | 'FINAL', score: number, reason: string | undefined, ev: AuditEvent[], notes: Note[]) {
    assertScore(type, score);
    await this.lock(tx, `j:${t.student.userId}:${t.subject.id}:${period.academicYear}:${period.term}:${type}`);
    const existing = await tx.grade.findFirst({ where: { studentId: t.student.userId, subjectId: t.subject.id, ...period, type }, orderBy: { updatedAt: 'desc' } });
    if (!existing) {
      this.assertCap(actor, 'create');
      const g = await tx.grade.create({
        data: { studentId: t.student.userId, subjectId: t.subject.id, ...this.teacherRef(actor), value: score, maxValue: COMPONENT_MAX[type], type, ...period },
      });
      ev.push({ action: 'journal.grade_create', targetId: g.id, diff: this.diff(t, period, type, { gradeId: g.id, old: null, new: score }) });
      return { id: g.id, changed: true };
    }
    const old = Number(existing.value);
    if (old === score) return { id: existing.id, changed: false };
    this.assertCap(actor, 'update');
    needReason(!!existing.publishedAt, reason);
    await tx.grade.update({ where: { id: existing.id }, data: { value: score, ...this.teacherRef(actor) } });
    await tx.gradeHistory.create({ data: { gradeId: existing.id, oldValue: old, newValue: score, changedBy: actor.id, reason: reason ?? null } });
    ev.push({ action: 'journal.grade_update', targetId: existing.id, diff: this.diff(t, period, type, { gradeId: existing.id, old, new: score, reason: reason ?? null, published: !!existing.publishedAt }) });
    if (existing.publishedAt) notes.push({ kind: 'CHANGED', studentId: t.student.userId, subjectName: t.subject.name, component: type, old, new: score, reason });
    return { id: existing.id, changed: true };
  }

  private async opUpdateGrade(tx: Tx, actor: Actor, g: GradeWithCtx, t: Target, score: number | undefined, comment: string | undefined, reason: string | undefined, ev: AuditEvent[], notes: Note[]) {
    const kind = g.type as JournalComponent;
    const period = { academicYear: g.academicYear, term: g.term };
    const old = Number(g.value);
    if (score !== undefined) assertScore(kind, score);
    const scoreChanged = score !== undefined && score !== old;
    if (scoreChanged) needReason(!!g.publishedAt, reason);
    if (!scoreChanged && (comment === undefined || comment === (g.comment ?? ''))) return false;
    this.assertCap(actor, 'update');
    await this.lock(tx, `j:${g.studentId}:${g.subjectId}:${period.academicYear}:${period.term}:${kind === 'SEMINAR' ? 'S' : kind}`);
    await tx.grade.update({ where: { id: g.id }, data: { ...(scoreChanged ? { value: score } : {}), ...(comment !== undefined ? { comment } : {}), ...this.teacherRef(actor) } });
    if (scoreChanged) {
      await tx.gradeHistory.create({ data: { gradeId: g.id, oldValue: old, newValue: score!, changedBy: actor.id, reason: reason ?? null } });
      ev.push({
        action: kind === 'SEMINAR' ? 'journal.seminar_update' : 'journal.grade_update',
        targetId: g.id,
        diff: this.diff(t, period, kind, { gradeId: g.id, old, new: score, reason: reason ?? null, published: !!g.publishedAt }),
      });
      if (g.publishedAt) notes.push({ kind: 'CHANGED', studentId: g.studentId, subjectName: t.subject.name, component: kind, old, new: score!, reason });
    }
    return true;
  }

  private async opDeleteGrade(tx: Tx, actor: Actor, g: GradeWithCtx, t: Target, reason: string | undefined, ev: AuditEvent[], notes: Note[]) {
    const kind = g.type as JournalComponent;
    this.assertCap(actor, 'delete');
    needReason(!!g.publishedAt, reason);
    const period = { academicYear: g.academicYear, term: g.term };
    await this.lock(tx, `j:${g.studentId}:${g.subjectId}:${period.academicYear}:${period.term}:${kind === 'SEMINAR' ? 'S' : kind}`);
    await tx.grade.delete({ where: { id: g.id } });
    ev.push({
      action: kind === 'SEMINAR' ? 'journal.seminar_delete' : 'journal.grade_delete',
      targetId: g.id,
      diff: this.diff(t, period, kind, { gradeId: g.id, old: Number(g.value), new: null, reason: reason ?? null, published: !!g.publishedAt }),
    });
    if (g.publishedAt) notes.push({ kind: 'CHANGED', studentId: g.studentId, subjectName: t.subject.name, component: kind, old: Number(g.value), new: null, reason });
  }

  private async persist(tx: Tx, actor: Actor, ev: AuditEvent[], ctx: AuditCtx) {
    if (!ev.length) return;
    await tx.auditLog.createMany({
      data: ev.map((e) => ({ actorId: actor.id, action: e.action, targetType: 'Grade', targetId: e.targetId, diff: (actor.overridden ? { ...e.diff, override: true } : e.diff) as Prisma.InputJsonValue, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null })),
    });
  }

  private async gradeWithCtx(actor: Actor, id: string): Promise<{ g: GradeWithCtx; t: Target }> {
    this.assertWriteScope(actor);
    const g = await this.prisma.grade.findUnique({ where: { id }, include: { student: { select: { groupName: true, user: { select: { loginId: true, fullName: true } } } }, subject: { select: { id: true, code: true, name: true } } } });
    if (!g || !TYPES.includes(g.type)) throw new NotFoundException('Grade not found');
    await this.assertPair(actor, g.subjectId, g.student.groupName);
    await this.openPeriod({ academicYear: g.academicYear, term: g.term }, actor);
    return {
      g,
      t: { student: { userId: g.studentId, groupName: g.student.groupName, loginId: g.student.user.loginId, fullName: g.student.user.fullName }, subject: g.subject },
    };
  }

  // ───────────────────────── публичные операции ─────────────────────────
  private async result(actor: Actor, t: Target, period: Period, studentIds: string[]) {
    const { records } = await this.read.load(actor, { ...period, subjectId: t.subject.id, groupName: t.student.groupName });
    return { records: records.filter((r) => studentIds.includes(r.student.id)) };
  }

  async addSeminar(actor: Actor, dto: { studentId: string; subjectId: string; academicYear: string; term: Term; score: number; comment?: string }, ctx: AuditCtx) {
    const period = { academicYear: dto.academicYear, term: dto.term };
    const t = await this.targetFor(actor, dto.studentId, dto.subjectId);
    await this.openPeriod(period, actor);
    const ev: AuditEvent[] = [];
    await this.prisma.$transaction(async (tx) => {
      await this.opAddSeminar(tx, actor, t, period, dto.score, dto.comment, ev);
      await this.persist(tx, actor, ev, ctx);
    });
    return this.result(actor, t, period, [dto.studentId]);
  }

  async setComponent(actor: Actor, dto: { studentId: string; subjectId: string; academicYear: string; term: Term; type: 'MIDTERM' | 'FINAL'; score: number; reason?: string }, ctx: AuditCtx) {
    const period = { academicYear: dto.academicYear, term: dto.term };
    const t = await this.targetFor(actor, dto.studentId, dto.subjectId);
    await this.openPeriod(period, actor);
    const ev: AuditEvent[] = [];
    const notes: Note[] = [];
    await this.prisma.$transaction(async (tx) => {
      await this.opSetComponent(tx, actor, t, period, dto.type, dto.score, dto.reason, ev, notes);
      await this.persist(tx, actor, ev, ctx);
    });
    await this.sendNotes(notes);
    return this.result(actor, t, period, [dto.studentId]);
  }

  async updateGrade(actor: Actor, id: string, dto: { score?: number; comment?: string; reason?: string }, ctx: AuditCtx) {
    const { g, t } = await this.gradeWithCtx(actor, id);
    const ev: AuditEvent[] = [];
    const notes: Note[] = [];
    await this.prisma.$transaction(async (tx) => {
      await this.opUpdateGrade(tx, actor, g, t, dto.score, dto.comment, dto.reason, ev, notes);
      await this.persist(tx, actor, ev, ctx);
    });
    await this.sendNotes(notes);
    return this.result(actor, t, { academicYear: g.academicYear, term: g.term }, [g.studentId]);
  }

  async deleteGrade(actor: Actor, id: string, reason: string | undefined, ctx: AuditCtx) {
    const { g, t } = await this.gradeWithCtx(actor, id);
    const ev: AuditEvent[] = [];
    const notes: Note[] = [];
    await this.prisma.$transaction(async (tx) => {
      await this.opDeleteGrade(tx, actor, g, t, reason, ev, notes);
      await this.persist(tx, actor, ev, ctx);
    });
    await this.sendNotes(notes);
    return this.result(actor, t, { academicYear: g.academicYear, term: g.term }, [g.studentId]);
  }

  /** Быстрый ввод (grid): пачка ячеек в одной транзакции — всё или ничего */
  async applyCells(
    actor: Actor,
    dto: { subjectId: string; groupName: string; academicYear: string; term: Term; cells: Array<{ studentId: string; kind: JournalComponent; answerId?: string; score: number | null; reason?: string }> },
    ctx: AuditCtx,
  ) {
    this.assertWriteScope(actor);
    const period = { academicYear: dto.academicYear, term: dto.term };
    await this.assertPair(actor, dto.subjectId, dto.groupName);
    await this.openPeriod(period, actor);
    const ids = Array.from(new Set(dto.cells.map((c) => c.studentId)));
    const [students, subject] = await Promise.all([
      this.prisma.student.findMany({ where: { userId: { in: ids }, groupName: dto.groupName, user: { status: 'ACTIVE' } }, select: { userId: true, groupName: true, user: { select: { loginId: true, fullName: true } } } }),
      this.prisma.subject.findUnique({ where: { id: dto.subjectId }, select: { id: true, code: true, name: true } }),
    ]);
    if (!subject) throw new NotFoundException('Subject not found');
    const byId = new Map(students.map((s) => [s.userId, s]));
    const foreign = ids.filter((i) => !byId.has(i));
    if (foreign.length) throw new ForbiddenException({ message: 'Some students are not in this group', studentIds: foreign });
    const tOf = (id: string): Target => {
      const s = byId.get(id)!;
      return { student: { userId: s.userId, groupName: s.groupName, loginId: s.user.loginId, fullName: s.user.fullName }, subject };
    };
    // предварительная валидация (до записи)
    for (const c of dto.cells) if (c.score !== null) assertScore(c.kind, c.score);

    const ev: AuditEvent[] = [];
    const notes: Note[] = [];
    await this.prisma.$transaction(async (tx) => {
      for (const c of dto.cells) {
        const t = tOf(c.studentId);
        if (c.kind === 'SEMINAR') {
          if (c.answerId) {
            const g = await tx.grade.findFirst({ where: { id: c.answerId, studentId: c.studentId, subjectId: dto.subjectId, ...period, type: GradeType.SEMINAR }, include: { student: { select: { groupName: true, user: { select: { loginId: true, fullName: true } } } }, subject: { select: { id: true, code: true, name: true } } } });
            if (!g) throw new NotFoundException('Seminar answer not found');
            if (c.score === null) await this.opDeleteGrade(tx, actor, g, t, c.reason, ev, notes);
            else await this.opUpdateGrade(tx, actor, g, t, c.score, undefined, c.reason, ev, notes);
          } else if (c.score !== null) {
            await this.opAddSeminar(tx, actor, t, period, c.score, undefined, ev);
          }
        } else {
          const kind = c.kind as 'MIDTERM' | 'FINAL';
          if (c.score === null) {
            const g = await tx.grade.findFirst({ where: { studentId: c.studentId, subjectId: dto.subjectId, ...period, type: kind }, include: { student: { select: { groupName: true, user: { select: { loginId: true, fullName: true } } } }, subject: { select: { id: true, code: true, name: true } } } });
            if (g) await this.opDeleteGrade(tx, actor, g, t, c.reason, ev, notes);
          } else {
            await this.opSetComponent(tx, actor, t, period, kind, c.score, c.reason, ev, notes);
          }
        }
      }
      await this.persist(tx, actor, ev, ctx);
    });
    await this.sendNotes(notes);
    const { records } = await this.read.load(actor, { ...period, subjectId: dto.subjectId, groupName: dto.groupName });
    return { records: records.filter((r) => ids.includes(r.student.id)) };
  }

  // ───────────────────────── публикация ─────────────────────────
  async publish(actor: Actor, dto: { subjectId: string; groupName: string; academicYear: string; term: Term; studentIds?: string[] }, ctx: AuditCtx) {
    this.assertWriteScope(actor);
    this.assertCap(actor, 'publish');
    const period = { academicYear: dto.academicYear, term: dto.term };
    await this.assertPair(actor, dto.subjectId, dto.groupName);
    await this.openPeriod(period, actor);
    const subject = await this.prisma.subject.findUnique({ where: { id: dto.subjectId }, select: { id: true, code: true, name: true } });
    if (!subject) throw new NotFoundException('Subject not found');
    const groupStudents = await this.prisma.student.findMany({ where: { groupName: dto.groupName, user: { status: 'ACTIVE' }, ...(dto.studentIds ? { userId: { in: dto.studentIds } } : {}) }, select: { userId: true, user: { select: { loginId: true, fullName: true } } } });
    if (dto.studentIds && groupStudents.length !== new Set(dto.studentIds).size) throw new ForbiddenException('Some students are not in this group');
    const ids = groupStudents.map((s) => s.userId);

    const drafts = await this.prisma.grade.findMany({ where: { studentId: { in: ids }, subjectId: dto.subjectId, ...period, type: { in: TYPES as any }, publishedAt: null }, select: { id: true, studentId: true, type: true } });
    if (!drafts.length) return { published: 0, students: 0, records: [] };
    const now = new Date();
    const notes = new Map<string, Note & { kind: 'PUBLISHED' }>();
    await this.prisma.$transaction(async (tx) => {
      await tx.grade.updateMany({ where: { id: { in: drafts.map((d) => d.id) } }, data: { publishedAt: now, publishedBy: actor.id } });
      const perStudent = new Map<string, string[]>();
      for (const d of drafts) (perStudent.get(d.studentId) ?? perStudent.set(d.studentId, []).get(d.studentId)!).push(d.type);
      await tx.auditLog.createMany({
        data: Array.from(perStudent.entries()).map(([sid, types]) => {
          const s = groupStudents.find((x) => x.userId === sid)!;
          return {
            actorId: actor.id, action: 'journal.publish', targetType: 'Grade', targetId: null,
            diff: { studentId: sid, studentLoginId: s.user.loginId, studentName: s.user.fullName, groupName: dto.groupName, subjectId: subject.id, subjectCode: subject.code, ...period, component: 'ALL', grades: types.length, types, ...(actor.overridden ? { override: true } : {}), old: 'DRAFT', new: 'PUBLISHED' } as Prisma.InputJsonValue,
            ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null,
          };
        }),
      });
      for (const [sid, types] of perStudent) notes.set(sid, { kind: 'PUBLISHED', studentId: sid, subjectId: subject.id, subjectName: subject.name, types: new Set(types) });
    });
    await this.sendNotes(Array.from(notes.values()), period);
    const { records } = await this.read.load(actor, { ...period, subjectId: dto.subjectId, groupName: dto.groupName });
    return { published: drafts.length, students: notes.size, records: records.filter((r) => notes.has(r.student.id)) };
  }

  async unpublish(actor: Actor, dto: { subjectId: string; groupName: string; academicYear: string; term: Term; studentIds?: string[]; reason: string }, ctx: AuditCtx) {
    this.assertWriteScope(actor);
    this.assertCap(actor, 'publish');
    const period = { academicYear: dto.academicYear, term: dto.term };
    await this.assertPair(actor, dto.subjectId, dto.groupName);
    await this.openPeriod(period, actor);
    const subject = await this.prisma.subject.findUnique({ where: { id: dto.subjectId }, select: { id: true, code: true, name: true } });
    if (!subject) throw new NotFoundException('Subject not found');
    const groupStudents = await this.prisma.student.findMany({ where: { groupName: dto.groupName, user: { status: 'ACTIVE' }, ...(dto.studentIds ? { userId: { in: dto.studentIds } } : {}) }, select: { userId: true, user: { select: { loginId: true, fullName: true } } } });
    if (dto.studentIds && groupStudents.length !== new Set(dto.studentIds).size) throw new ForbiddenException('Some students are not in this group');
    const rows = await this.prisma.grade.findMany({ where: { studentId: { in: groupStudents.map((s) => s.userId) }, subjectId: dto.subjectId, ...period, type: { in: TYPES as any }, publishedAt: { not: null } }, select: { id: true, studentId: true, type: true } });
    if (!rows.length) return { unpublished: 0, students: 0, records: [] };
    const perStudent = new Map<string, string[]>();
    for (const d of rows) (perStudent.get(d.studentId) ?? perStudent.set(d.studentId, []).get(d.studentId)!).push(d.type);
    await this.prisma.$transaction(async (tx) => {
      await tx.grade.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { publishedAt: null, publishedBy: null } });
      await tx.auditLog.createMany({
        data: Array.from(perStudent.entries()).map(([sid, types]) => {
          const s = groupStudents.find((x) => x.userId === sid)!;
          return {
            actorId: actor.id, action: 'journal.unpublish', targetType: 'Grade', targetId: null,
            diff: { studentId: sid, studentLoginId: s.user.loginId, studentName: s.user.fullName, groupName: dto.groupName, subjectId: subject.id, subjectCode: subject.code, ...period, component: 'ALL', grades: types.length, types, ...(actor.overridden ? { override: true } : {}), old: 'PUBLISHED', new: 'DRAFT', reason: dto.reason } as Prisma.InputJsonValue,
            ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null,
          };
        }),
      });
    });
    const { records } = await this.read.load(actor, { ...period, subjectId: dto.subjectId, groupName: dto.groupName });
    return { unpublished: rows.length, students: perStudent.size, records: records.filter((r) => perStudent.has(r.student.id)) };
  }

  // ───────────────────────── массовые операции ─────────────────────────
  private async bulkTargets(actor: Actor, dto: BulkDto) {
    this.assertWriteScope(actor);
    await this.assertPair(actor, dto.subjectId, dto.groupName);
    const [subject, students] = await Promise.all([
      this.prisma.subject.findUnique({ where: { id: dto.subjectId }, select: { id: true, code: true, name: true } }),
      this.prisma.student.findMany({ where: { userId: { in: dto.studentIds } }, select: { userId: true, groupName: true, user: { select: { loginId: true, fullName: true, status: true } } } }),
    ]);
    if (!subject) throw new NotFoundException('Subject not found');
    const byId = new Map(students.map((s) => [s.userId, s]));
    const valid: Target['student'][] = [];
    const invalid: Array<{ studentId: string; reason: 'NOT_FOUND' | 'NOT_IN_GROUP' | 'INACTIVE' }> = [];
    for (const id of Array.from(new Set(dto.studentIds))) {
      const s = byId.get(id);
      if (!s) invalid.push({ studentId: id, reason: 'NOT_FOUND' });
      else if (s.groupName !== dto.groupName) invalid.push({ studentId: id, reason: 'NOT_IN_GROUP' });
      else if (s.user.status !== 'ACTIVE') invalid.push({ studentId: id, reason: 'INACTIVE' });
      else valid.push({ userId: s.userId, groupName: s.groupName, loginId: s.user.loginId, fullName: s.user.fullName });
    }
    return { subject, valid, invalid };
  }

  async bulkPreview(actor: Actor, dto: BulkDto) {
    const period = { academicYear: dto.academicYear, term: dto.term };
    await this.openPeriod(period, actor);
    const { valid, invalid } = await this.bulkTargets(actor, dto);
    return {
      action: dto.action,
      selected: dto.studentIds.length,
      valid: valid.length,
      invalid,
      ...(dto.action === 'SEMINAR' ? { score: dto.score, max: JOURNAL_RULES.SEMINAR_ANSWER_MAX } : { status: dto.status, classDate: dto.classDate }),
    };
  }

  async bulkApply(actor: Actor, dto: BulkDto, ctx: AuditCtx) {
    if (dto.confirm !== true) {
      throw new BadRequestException({ message: 'Confirmation required for bulk operations', code: 'CONFIRMATION_REQUIRED', preview: await this.bulkPreview(actor, dto) });
    }
    const period = { academicYear: dto.academicYear, term: dto.term };
    await this.openPeriod(period, actor);
    const { subject, valid, invalid } = await this.bulkTargets(actor, dto);
    if (invalid.length) throw new ForbiddenException({ message: 'Some selected students are not valid for this group', invalid });

    if (dto.action === 'SEMINAR') {
      assertScore('SEMINAR', dto.score);
      const ev: AuditEvent[] = [];
      await this.prisma.$transaction(async (tx) => {
        for (const s of valid) await this.opAddSeminar(tx, actor, { student: s, subject }, period, dto.score, dto.comment, ev, { bulk: true });
        await this.persist(tx, actor, ev, ctx);
      });
      const ids = valid.map((v) => v.userId);
      const { records } = await this.read.load(actor, { ...period, subjectId: dto.subjectId, groupName: dto.groupName });
      return { action: 'SEMINAR', affected: valid.length, records: records.filter((r) => ids.includes(r.student.id)) };
    }

    // ATTENDANCE — единая реализация посещаемости (AttendanceService): права, scope, период, аудит
    const grant = await this.perms.require(actor.role, 'attendance.create');
    const r = await this.attendance.mark(
      { id: actor.id, role: actor.role },
      grant,
      { groupName: dto.groupName, subjectCode: subject.code, classDate: dto.classDate, entries: valid.map((v) => ({ studentLoginId: v.loginId, status: dto.status })) },
      ctx,
    );
    return { action: 'ATTENDANCE', affected: r.saved, records: [] };
  }

  // ───────────────────────── импорт (parse → validate → preview → confirm) ─────────────────────────
  private async evaluateImport(actor: Actor, dto: ImportDto) {
    this.assertWriteScope(actor);
    const period = { academicYear: dto.academicYear, term: dto.term };
    await this.assertPair(actor, dto.subjectId, dto.groupName);
    await this.openPeriod(period, actor);
    const subject = await this.prisma.subject.findUnique({ where: { id: dto.subjectId }, select: { id: true, code: true, name: true } });
    if (!subject) throw new NotFoundException('Subject not found');

    const users = await this.prisma.user.findMany({
      where: { loginId: { in: Array.from(new Set(dto.rows.map((r) => r.studentLoginId))) }, role: 'STUDENT' },
      select: { id: true, loginId: true, fullName: true, status: true, student: { select: { groupName: true } } },
    });
    const byLogin = new Map(users.map((u) => [u.loginId, u]));
    const existing = await this.prisma.grade.findMany({
      where: { subjectId: dto.subjectId, ...period, type: { in: ['MIDTERM', 'FINAL'] }, studentId: { in: users.map((u) => u.id) } },
      select: { studentId: true, type: true, value: true, publishedAt: true },
    });
    const exMap = new Map(existing.map((e) => [e.studentId + ':' + e.type, e]));

    const seen = new Set<string>();
    const rows = dto.rows.map((r, index) => {
      const errors: string[] = [];
      const u = byLogin.get(r.studentLoginId);
      if (!u || !u.student) errors.push('INVALID_STUDENT');
      else if (u.status !== 'ACTIVE') errors.push('INVALID_STUDENT');
      else if (u.student.groupName !== dto.groupName) errors.push('NOT_IN_GROUP');
      if (seen.has(r.studentLoginId)) errors.push('DUPLICATE_ROW');
      seen.add(r.studentLoginId);
      if (r.subjectCode && r.subjectCode !== subject.code) errors.push('WRONG_SUBJECT');
      if ((r.academicYear && r.academicYear !== dto.academicYear) || (r.term && r.term !== dto.term)) errors.push('WRONG_PERIOD');
      if (r.midterm === undefined && r.final === undefined && !(r.seminar && r.seminar.length)) errors.push('EMPTY_ROW');
      const bad = (v: number | undefined, kind: JournalComponent) => v !== undefined && !(Number.isFinite(v) && v >= 0 && v <= COMPONENT_MAX[kind] && twoDec(v));
      if (bad(r.midterm, 'MIDTERM')) errors.push('INVALID_MIDTERM');
      if (bad(r.final, 'FINAL')) errors.push('INVALID_FINAL');
      if (r.seminar?.some((v) => bad(v, 'SEMINAR'))) errors.push('INVALID_SEMINAR');
      const changes: Array<{ component: JournalComponent; old: number | null; new: number; published: boolean }> = [];
      if (u && !errors.length) {
        for (const [k, v] of [['MIDTERM', r.midterm], ['FINAL', r.final]] as const) {
          if (v === undefined) continue;
          const ex = exMap.get(u.id + ':' + k);
          if (ex && Number(ex.value) === v) continue;
          changes.push({ component: k, old: ex ? Number(ex.value) : null, new: v, published: !!ex?.publishedAt });
        }
        for (const v of r.seminar ?? []) changes.push({ component: 'SEMINAR', old: null, new: v, published: false });
        if (changes.some((c) => c.published && c.old !== null) && !(dto.reason && dto.reason.trim().length >= 3)) errors.push('REASON_REQUIRED');
      }
      return { index, studentLoginId: r.studentLoginId, fullName: u?.fullName ?? null, status: errors.length ? ('ERROR' as const) : changes.length ? ('OK' as const) : ('UNCHANGED' as const), errors, changes, _id: u?.id };
    });
    return { subject, period, rows };
  }

  async importPreview(actor: Actor, dto: ImportDto) {
    const { rows } = await this.evaluateImport(actor, dto);
    const pub = rows.map(({ _id, ...r }) => r);
    return {
      rows: pub,
      summary: { total: rows.length, ok: rows.filter((r) => r.status === 'OK').length, unchanged: rows.filter((r) => r.status === 'UNCHANGED').length, errors: rows.filter((r) => r.status === 'ERROR').length },
    };
  }

  async importApply(actor: Actor, dto: ImportDto, ctx: AuditCtx) {
    const { subject, period, rows } = await this.evaluateImport(actor, dto);
    const bad = rows.filter((r) => r.status === 'ERROR');
    if (bad.length) throw new BadRequestException({ message: 'Import validation failed', code: 'IMPORT_INVALID', rows: bad.map(({ _id, ...r }) => r) });
    const ev: AuditEvent[] = [];
    const notes: Note[] = [];
    const src = new Map(dto.rows.map((r) => [r.studentLoginId, r]));
    await this.prisma.$transaction(async (tx) => {
      for (const r of rows) {
        if (r.status !== 'OK') continue;
        const u = await tx.student.findUnique({ where: { userId: r._id! }, select: { userId: true, groupName: true, user: { select: { loginId: true, fullName: true } } } });
        const t: Target = { student: { userId: u!.userId, groupName: u!.groupName, loginId: u!.user.loginId, fullName: u!.user.fullName }, subject };
        const s = src.get(r.studentLoginId)!;
        if (s.midterm !== undefined) await this.opSetComponent(tx, actor, t, period, 'MIDTERM', s.midterm, dto.reason, ev, notes);
        if (s.final !== undefined) await this.opSetComponent(tx, actor, t, period, 'FINAL', s.final, dto.reason, ev, notes);
        for (const v of s.seminar ?? []) await this.opAddSeminar(tx, actor, t, period, v, undefined, ev, { import: true });
      }
      await this.persist(tx, actor, ev, ctx);
    });
    await this.sendNotes(notes);
    return { applied: rows.filter((r) => r.status === 'OK').length, unchanged: rows.filter((r) => r.status === 'UNCHANGED').length };
  }

  // ───────────────────────── уведомления (через существующий NotificationsService) ─────────────────────────
  private async sendNotes(notes: Note[], period?: Period) {
    for (const n of notes) {
      try {
        if (n.kind === 'CHANGED') {
          const lab = COMPONENT_LABEL[n.component];
          const oldT = n.old == null ? '—' : String(n.old);
          const newT = n.new == null ? '—' : String(n.new);
          const tail = n.reason ? ` (${n.reason})` : '';
          const txt = (k: keyof L10n) => `${n.subjectName}: ${lab[k]} ${oldT} → ${newT}${tail}`;
          await this.notifications.notify([n.studentId], {
            type: 'ACADEMIC',
            title: l('Qiymət dəyişdi', 'Оценка изменена', 'Grade updated'),
            message: l(txt('az'), txt('ru'), txt('en')),
            link: 'grades',
          });
        } else if (period) {
          const rows = await this.prisma.grade.findMany({ where: { studentId: n.studentId, subjectId: n.subjectId, ...period, type: { in: TYPES as any } }, select: { id: true, type: true, value: true, publishedAt: true, createdAt: true, updatedAt: true } });
          const sum = summarizeSubject(rows.filter((r) => r.publishedAt));
          const name = n.subjectName;
          const title = n.types.has('FINAL')
            ? l('Yekun imtahan qiymətiniz dərc edildi', 'Оценка за финальный экзамен опубликована', 'Your final exam grade has been published')
            : n.types.has('MIDTERM')
              ? l('Aralıq imtahan qiymətiniz dərc edildi', 'Оценка за midterm опубликована', 'Your midterm grade has been published')
              : l('Seminar balınız yeniləndi', 'Ваш балл за семинары обновлён', 'Your seminar score has been updated');
          const parts = (k: keyof L10n) => {
            const out: string[] = [];
            if (sum.midterm) out.push(`${COMPONENT_LABEL.MIDTERM[k]} ${sum.midterm.score}/30`);
            if (sum.final) out.push(`${COMPONENT_LABEL.FINAL[k]} ${sum.final.score}/50`);
            out.push(sum.seminar.eligible ? `Seminar ${sum.seminar.score}/20` : `Seminar ${sum.seminar.count}/${JOURNAL_RULES.SEMINAR_MIN_ANSWERS}`);
            if (sum.complete) out.push(`Total ${sum.total.score}/100`);
            return `${name}: ` + out.join(' · ');
          };
          await this.notifications.notify([n.studentId], { type: 'ACADEMIC', title, message: l(parts('az'), parts('ru'), parts('en')), link: 'grades' });
          if (!sum.seminar.eligible) {
            const need = (k: keyof L10n) =>
              ({
                az: `${name}: seminar balı üçün ən azı ${JOURNAL_RULES.SEMINAR_MIN_ANSWERS} cavab lazımdır (${sum.seminar.count}/${JOURNAL_RULES.SEMINAR_MIN_ANSWERS})`,
                ru: `${name}: для семинарского балла нужно минимум ${JOURNAL_RULES.SEMINAR_MIN_ANSWERS} ответа (${sum.seminar.count}/${JOURNAL_RULES.SEMINAR_MIN_ANSWERS})`,
                en: `${name}: at least ${JOURNAL_RULES.SEMINAR_MIN_ANSWERS} seminar answers are required (${sum.seminar.count}/${JOURNAL_RULES.SEMINAR_MIN_ANSWERS})`,
              })[k];
            await this.notifications.notify([n.studentId], {
              type: 'ACADEMIC',
              title: l('Seminar tələbi tamamlanmayıb', 'Требование по семинарам не выполнено', 'Your seminar requirement is incomplete'),
              message: l(need('az'), need('ru'), need('en')),
              link: 'grades',
            });
          }
        }
      } catch {
        // уведомление — побочный эффект: сбой доставки не должен откатывать оценку
      }
    }
  }
}

type GradeWithCtx = Grade & { student: { groupName: string; user: { loginId: string; fullName: string } }; subject: { id: string; code: string; name: string } };
