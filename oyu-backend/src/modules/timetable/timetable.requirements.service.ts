import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Term, UserStatus, WeekParity } from '@prisma/client';
import { z } from 'zod';
import { AuditCtx, AuditTrailService } from '../../common/audit/audit-trail.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { TimetableContextService } from './timetable.context.service';
import { Actor } from './timetable.lessons.service';
import { BuildRequirementsSchema, ImportRequirementsSchema, RequirementDto, RequirementPatchSchema, RequirementsQuery } from './timetable.dto';

type Q = z.infer<typeof RequirementsQuery>;

@Injectable()
export class TimetableRequirementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctxSvc: TimetableContextService,
    private readonly audit: AuditTrailService,
  ) {}

  private async view(rows: Prisma.LessonRequirementGetPayload<{ include: { subject: { select: { code: true; name: true; credits: true } } } }>[], ctxYear: string, ctxTerm: Term, versionId?: string) {
    const ctx = await this.ctxSvc.load(ctxYear, ctxTerm);
    let placed = new Map<string, number>();
    if (versionId) {
      const g = await this.prisma.scheduleLesson.groupBy({ by: ['requirementId'], where: { versionId, requirementId: { in: rows.map((r) => r.id) } }, _count: { _all: true } });
      placed = new Map(g.map((x) => [x.requirementId!, x._count._all]));
    }
    return rows.map((r) => ({
      id: r.id, academicYear: r.academicYear, term: r.term, subject: { id: r.subjectId, code: r.subject.code, name: r.subject.name, credits: r.subject.credits },
      groupNames: r.groupNames, students: r.groupNames.reduce((a, g) => a + (ctx.groupMeta.get(g)?.size ?? 0), 0),
      teacher: r.teacherId ? { id: r.teacherId, name: ctx.teacherMeta.get(r.teacherId)?.name ?? '?' } : null,
      lessonTypeCode: r.lessonTypeCode, sessionsPerWeek: r.sessionsPerWeek, durationSlots: r.durationSlots, weekParity: r.weekParity, level: r.level,
      roomType: r.roomType, requiredFeatures: r.requiredFeatures, isActive: r.isActive, note: r.note, placed: versionId ? placed.get(r.id) ?? 0 : null,
    }));
  }

  async list(q: Q & { versionId?: string }) {
    const where: Prisma.LessonRequirementWhereInput = {
      academicYear: q.academicYear, term: q.term,
      ...(q.group ? { groupNames: { has: q.group } } : {}), ...(q.teacherId ? { teacherId: q.teacherId } : {}), ...(q.subjectId ? { subjectId: q.subjectId } : {}), ...(q.type ? { lessonTypeCode: q.type } : {}),
      ...(q.search ? { OR: [{ subject: { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { code: { contains: q.search, mode: 'insensitive' } }] } }, { groupNames: { hasSome: (await this.ctxSvc.groups()).filter((g) => g.name.toLowerCase().includes(q.search!.toLowerCase())).map((g) => g.name) } }] } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.lessonRequirement.count({ where }),
      this.prisma.lessonRequirement.findMany({ where, include: { subject: { select: { code: true, name: true, credits: true } } }, orderBy: [{ subject: { code: 'asc' } }, { createdAt: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items: await this.view(rows, q.academicYear, q.term, q.versionId) };
  }

  private async validate(dto: Pick<RequirementDto, 'subjectId' | 'groupNames' | 'teacherId' | 'lessonTypeCode' | 'roomType'> & { academicYear: string; term: Term }) {
    const ctx = await this.ctxSvc.load(dto.academicYear, dto.term);
    if (!(await this.prisma.subject.findUnique({ where: { id: dto.subjectId }, select: { id: true } }))) throw new BadRequestException({ message: 'Unknown subject', code: 'UNKNOWN_SUBJECT' });
    for (const g of dto.groupNames) if (!ctx.groupMeta.has(g)) throw new BadRequestException({ message: `Unknown group ${g}`, code: 'UNKNOWN_GROUP' });
    const levels = new Set(dto.groupNames.map((g) => ctx.groupMeta.get(g)!.level));
    if (levels.size > 1) throw new BadRequestException({ message: 'A stream cannot mix education levels', code: 'MIXED_LEVELS' });
    if (dto.teacherId && !ctx.teacherMeta.has(dto.teacherId)) throw new BadRequestException({ message: 'Unknown or inactive teacher', code: 'UNKNOWN_TEACHER' });
    if (!ctx.lessonTypes.has(dto.lessonTypeCode)) throw new BadRequestException({ message: 'Unknown lesson type', code: 'UNKNOWN_LESSON_TYPE' });
    return { level: Array.from(levels)[0] };
  }

  private async assertUnique(dto: { academicYear: string; term: Term; subjectId: string; groupNames: string[]; lessonTypeCode: string }, exceptId?: string) {
    const dup = await this.prisma.lessonRequirement.findFirst({ where: { academicYear: dto.academicYear, term: dto.term, subjectId: dto.subjectId, lessonTypeCode: dto.lessonTypeCode, groupNames: { equals: dto.groupNames }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
    if (dup) throw new ConflictException({ message: 'This workload already exists', code: 'REQUIREMENT_EXISTS', id: dup.id });
  }

  async create(actor: Actor, dto: RequirementDto, ctxA: AuditCtx) {
    const { level } = await this.validate(dto);
    const groupNames = Array.from(new Set(dto.groupNames));
    await this.assertUnique({ ...dto, groupNames });
    const row = await this.prisma.lessonRequirement.create({
      data: { academicYear: dto.academicYear, term: dto.term, subjectId: dto.subjectId, groupNames, teacherId: dto.teacherId ?? null, lessonTypeCode: dto.lessonTypeCode, sessionsPerWeek: dto.sessionsPerWeek, durationSlots: dto.durationSlots, weekParity: dto.weekParity, level, roomType: dto.roomType ?? null, requiredFeatures: dto.requiredFeatures, isActive: dto.isActive, note: dto.note ?? null },
      include: { subject: { select: { code: true, name: true, credits: true } } },
    });
    await this.audit.record({ actorId: actor.id, action: 'timetable.requirement_create', targetType: 'LessonRequirement', targetId: row.id, new: { subject: row.subject.code, groups: groupNames, type: row.lessonTypeCode, perWeek: row.sessionsPerWeek, teacherId: row.teacherId } }, ctxA);
    return (await this.view([row], dto.academicYear, dto.term))[0];
  }

  async patch(actor: Actor, id: string, dto: z.infer<typeof RequirementPatchSchema>, ctxA: AuditCtx) {
    const cur = await this.prisma.lessonRequirement.findUnique({ where: { id }, include: { subject: { select: { code: true, name: true, credits: true } } } });
    if (!cur) throw new NotFoundException('Requirement not found');
    const merged = { academicYear: cur.academicYear, term: cur.term, subjectId: dto.subjectId ?? cur.subjectId, groupNames: dto.groupNames ? Array.from(new Set(dto.groupNames)) : cur.groupNames, teacherId: dto.teacherId !== undefined ? dto.teacherId : cur.teacherId, lessonTypeCode: dto.lessonTypeCode ?? cur.lessonTypeCode, roomType: dto.roomType !== undefined ? dto.roomType : cur.roomType };
    const { level } = await this.validate(merged);
    await this.assertUnique(merged, id);
    const row = await this.prisma.lessonRequirement.update({
      where: { id },
      data: { subjectId: merged.subjectId, groupNames: merged.groupNames, teacherId: merged.teacherId ?? null, lessonTypeCode: merged.lessonTypeCode, roomType: merged.roomType ?? null, level, ...(dto.sessionsPerWeek !== undefined ? { sessionsPerWeek: dto.sessionsPerWeek } : {}), ...(dto.durationSlots !== undefined ? { durationSlots: dto.durationSlots } : {}), ...(dto.weekParity ? { weekParity: dto.weekParity as WeekParity } : {}), ...(dto.requiredFeatures ? { requiredFeatures: dto.requiredFeatures } : {}), ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}), ...(dto.note !== undefined ? { note: dto.note } : {}) },
      include: { subject: { select: { code: true, name: true, credits: true } } },
    });
    await this.audit.record({ actorId: actor.id, action: 'timetable.requirement_update', targetType: 'LessonRequirement', targetId: id, old: { teacherId: cur.teacherId, perWeek: cur.sessionsPerWeek, type: cur.lessonTypeCode, groups: cur.groupNames, active: cur.isActive }, new: { teacherId: row.teacherId, perWeek: row.sessionsPerWeek, type: row.lessonTypeCode, groups: row.groupNames, active: row.isActive } }, ctxA);
    return (await this.view([row], row.academicYear, row.term))[0];
  }

  async remove(actor: Actor, id: string, ctxA: AuditCtx) {
    const cur = await this.prisma.lessonRequirement.findUnique({ where: { id }, include: { subject: { select: { code: true } } } });
    if (!cur) throw new NotFoundException('Requirement not found');
    await this.prisma.lessonRequirement.delete({ where: { id } });
    await this.audit.record({ actorId: actor.id, action: 'timetable.requirement_delete', targetType: 'LessonRequirement', targetId: id, old: { subject: cur.subject.code, groups: cur.groupNames, type: cur.lessonTypeCode, perWeek: cur.sessionsPerWeek } }, ctxA);
    return { deleted: true };
  }

  /** Заполнение нагрузки по предметам семестра группы: Subject.semester == Student.semester группы */
  async build(actor: Actor, dto: z.infer<typeof BuildRequirementsSchema>, ctxA: AuditCtx) {
    const ctx = await this.ctxSvc.load(dto.academicYear, dto.term);
    let groups = Array.from(ctx.groupMeta.values());
    if (dto.level) groups = groups.filter((g) => g.level === dto.level);
    if (dto.faculty) groups = groups.filter((g) => g.faculty === dto.faculty);
    if (dto.groups?.length) groups = groups.filter((g) => dto.groups!.includes(g.name));
    if (!groups.length) throw new BadRequestException({ message: 'No groups match the selection', code: 'NO_GROUPS' });
    for (const p of dto.pattern) if (!ctx.lessonTypes.has(p.lessonTypeCode)) throw new BadRequestException({ message: `Unknown lesson type ${p.lessonTypeCode}`, code: 'UNKNOWN_LESSON_TYPE' });

    const sem = await this.prisma.student.groupBy({ by: ['groupName', 'semester'], where: { groupName: { in: groups.map((g) => g.name) }, user: { status: UserStatus.ACTIVE } }, _count: { _all: true } });
    const groupSem = new Map<string, number>();
    const best = new Map<string, number>();
    for (const s of sem) if (s._count._all > (best.get(s.groupName) ?? 0)) { best.set(s.groupName, s._count._all); groupSem.set(s.groupName, s.semester); }
    const subjects = await this.prisma.subject.findMany({ where: { isActive: true }, select: { id: true, code: true, semester: true } });
    const bySem = new Map<number, typeof subjects>();
    for (const s of subjects) (bySem.get(s.semester) ?? bySem.set(s.semester, []).get(s.semester)!).push(s);

    // преподаватель — из действующего расписания (тот же предмет и группа), иначе тот, кто ведёт предмет в любой группе
    const slots = await this.prisma.scheduleSlot.findMany({ where: { academicYear: dto.academicYear, term: dto.term, teacherId: { not: null } }, select: { subjectId: true, groupName: true, teacherId: true, type: true } });
    const exact = new Map<string, string>(), anyT = new Map<string, string>();
    for (const s of slots) { exact.set(`${s.subjectId}|${s.groupName}`, s.teacherId!); if (!anyT.has(s.subjectId)) anyT.set(s.subjectId, s.teacherId!); }

    if (dto.replace) {
      const del = await this.prisma.lessonRequirement.deleteMany({ where: { academicYear: dto.academicYear, term: dto.term, groupNames: { hasSome: groups.map((g) => g.name) } } });
      void del;
    }
    const existing = await this.prisma.lessonRequirement.findMany({ where: { academicYear: dto.academicYear, term: dto.term, groupNames: { hasSome: groups.map((g) => g.name) } }, select: { subjectId: true, lessonTypeCode: true, groupNames: true } });
    const has = new Set(existing.map((e) => `${e.subjectId}|${e.lessonTypeCode}|${e.groupNames.join('+')}`));
    const data: Prisma.LessonRequirementCreateManyInput[] = [];
    let skippedNoSubjects = 0;
    // потоки лекций: группы одной специальности и курса, по streamLectures штук
    const streamKey = (g: (typeof groups)[number]) => `${g.faculty}|${g.specialty}|${g.course}|${g.level}`;
    for (const p of dto.pattern) {
      const streamable = p.lessonTypeCode === 'lecture' && dto.streamLectures > 1;
      const unitsBySubject = new Map<string, Array<{ names: string[]; level: (typeof groups)[number]['level'] }>>();
      for (const g of groups) {
        const subs = bySem.get(groupSem.get(g.name) ?? -1) ?? [];
        if (!subs.length) { skippedNoSubjects++; continue; }
        for (const s of subs) (unitsBySubject.get(s.id) ?? unitsBySubject.set(s.id, []).get(s.id)!).push({ names: [g.name], level: g.level });
      }
      for (const [subjectId, units] of unitsBySubject) {
        let packed = units.map((u) => u);
        if (streamable) {
          const buckets = new Map<string, typeof units>();
          for (const u of units) (buckets.get(streamKey(ctx.groupMeta.get(u.names[0])!)) ?? buckets.set(streamKey(ctx.groupMeta.get(u.names[0])!), []).get(streamKey(ctx.groupMeta.get(u.names[0])!))!).push(u);
          packed = [];
          for (const b of buckets.values()) {
            b.sort((x, y) => x.names[0].localeCompare(y.names[0]));
            for (let i = 0; i < b.length; i += dto.streamLectures) packed.push({ names: b.slice(i, i + dto.streamLectures).flatMap((x) => x.names), level: b[0].level });
          }
        }
        for (const u of packed) {
          const key = `${subjectId}|${p.lessonTypeCode}|${u.names.join('+')}`;
          if (has.has(key)) continue;
          has.add(key);
          data.push({ academicYear: dto.academicYear, term: dto.term, subjectId, groupNames: u.names, teacherId: exact.get(`${subjectId}|${u.names[0]}`) ?? anyT.get(subjectId) ?? null, lessonTypeCode: p.lessonTypeCode, sessionsPerWeek: p.sessionsPerWeek, durationSlots: p.durationSlots, level: u.level });
        }
      }
    }
    for (let i = 0; i < data.length; i += 1000) await this.prisma.lessonRequirement.createMany({ data: data.slice(i, i + 1000) });
    await this.audit.record({ actorId: actor.id, action: 'timetable.requirements_build', targetType: 'LessonRequirement', new: { created: data.length, groups: groups.length, pattern: dto.pattern, replace: dto.replace }, extra: { academicYear: dto.academicYear, term: dto.term } }, ctxA);
    const noTeacher = data.filter((d) => !d.teacherId).length;
    return { created: data.length, groups: groups.length, withoutTeacher: noTeacher, groupsWithoutSubjects: skippedNoSubjects };
  }

  /** Импорт нагрузки (CSV разбирается во frontend): dryRun показывает результат без записи */
  async import(actor: Actor, dto: z.infer<typeof ImportRequirementsSchema>, ctxA: AuditCtx) {
    const ctx = await this.ctxSvc.load(dto.academicYear, dto.term);
    const subjects = await this.prisma.subject.findMany({ where: { code: { in: Array.from(new Set(dto.rows.map((r) => r.subjectCode.toUpperCase()))) } }, select: { id: true, code: true } });
    const subjByCode = new Map(subjects.map((s) => [s.code.toUpperCase(), s.id]));
    const teachersByLogin = new Map(Array.from(ctx.teacherMeta.values()).map((t) => [t.loginId, t.id]));
    const parityMap: Record<string, WeekParity> = { BOTH: 'BOTH', UPPER: 'UPPER', LOWER: 'LOWER', '': 'BOTH' };
    const out = dto.rows.map((r, index) => {
      const errors: string[] = [];
      const subjectId = subjByCode.get(r.subjectCode.toUpperCase());
      if (!subjectId) errors.push('UNKNOWN_SUBJECT');
      const groupNames = r.groups.split(/[;,|]/).map((x) => x.trim()).filter(Boolean);
      const bad = groupNames.filter((g) => !ctx.groupMeta.has(g));
      if (!groupNames.length || bad.length) errors.push('UNKNOWN_GROUP');
      if (new Set(groupNames.map((g) => ctx.groupMeta.get(g)?.level)).size > 1) errors.push('MIXED_LEVELS');
      const teacherId = r.teacherLoginId ? teachersByLogin.get(r.teacherLoginId) : undefined;
      if (r.teacherLoginId && !teacherId) errors.push('UNKNOWN_TEACHER');
      if (!ctx.lessonTypes.has(r.lessonType)) errors.push('UNKNOWN_LESSON_TYPE');
      const parity = parityMap[(r.parity ?? '').toUpperCase()];
      if (!parity) errors.push('BAD_PARITY');
      return { index, errors, subjectId, groupNames, teacherId: teacherId ?? null, lessonType: r.lessonType, sessionsPerWeek: r.sessionsPerWeek, durationSlots: r.durationSlots, parity: parity ?? 'BOTH', roomType: r.roomType ?? null };
    });
    const bad = out.filter((o) => o.errors.length);
    if (dto.dryRun || bad.length) return { applied: false, total: out.length, errors: bad.length, rows: out.map((o) => ({ index: o.index, errors: o.errors })).filter((o) => o.errors.length).slice(0, 200) };
    let created = 0, updated = 0;
    await this.prisma.$transaction(async (tx) => {
      for (const o of out) {
        const level = ctx.groupMeta.get(o.groupNames[0])!.level;
        const key = { academicYear: dto.academicYear, term: dto.term, subjectId: o.subjectId!, lessonTypeCode: o.lessonType, groupNames: { equals: o.groupNames } };
        const ex = await tx.lessonRequirement.findFirst({ where: key, select: { id: true } });
        const payload = { teacherId: o.teacherId, sessionsPerWeek: o.sessionsPerWeek, durationSlots: o.durationSlots, weekParity: o.parity as WeekParity, roomType: o.roomType };
        if (ex) { await tx.lessonRequirement.update({ where: { id: ex.id }, data: payload }); updated++; }
        else { await tx.lessonRequirement.create({ data: { academicYear: dto.academicYear, term: dto.term, subjectId: o.subjectId!, groupNames: o.groupNames, lessonTypeCode: o.lessonType, level, ...payload } }); created++; }
      }
      await this.audit.recordTx(tx, { actorId: actor.id, action: 'timetable.requirements_import', targetType: 'LessonRequirement', new: { created, updated, rows: out.length }, extra: { academicYear: dto.academicYear, term: dto.term } }, ctxA);
    }, { timeout: 120_000 });
    return { applied: true, total: out.length, created, updated, errors: 0, rows: [] };
  }
}
