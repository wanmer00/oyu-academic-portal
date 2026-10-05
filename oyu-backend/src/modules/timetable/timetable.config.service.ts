import { BadRequestException, ConflictException, NotFoundException, Injectable } from '@nestjs/common';
import { Prisma, Term, TimetableRule } from '@prisma/client';
import { AuditCtx, AuditTrailService } from '../../common/audit/audit-trail.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { DEFAULT_WEIGHTS, parseTime } from './engine/types';
import { TimetableContextService } from './timetable.context.service';
import { Actor } from './timetable.lessons.service';
import { z } from 'zod';
import { ConfigPatchSchema, LessonTypePatchSchema, LessonTypeSchema, MyAvailabilitySchema, RuleSchema, TimeSlotPatchSchema, TimeSlotSchema } from './timetable.dto';

type Rule = z.infer<typeof RuleSchema>;
const SYSTEM_TYPES = ['lecture', 'seminar', 'practice', 'lab', 'consultation', 'exam', 'other'];
export const ROOM_TYPES = ['classroom', 'lecture_hall', 'lab', 'computer_lab', 'seminar_room', 'gym', 'other'];

const KIND_SCOPES: Record<string, string[]> = {
  UNAVAILABLE: ['GLOBAL', 'TEACHER', 'GROUP', 'ROOM', 'BUILDING', 'SUBJECT'],
  PREFERRED: ['TEACHER', 'GROUP', 'ROOM', 'BUILDING'],
  NO_LATE: ['GLOBAL', 'TEACHER', 'GROUP'],
  MAX_PER_DAY: ['TEACHER', 'GROUP'],
  ALLOWED_BUILDINGS: ['TEACHER', 'GROUP', 'SUBJECT'],
};

@Injectable()
export class TimetableConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditTrailService,
    private readonly ctxSvc: TimetableContextService,
  ) {}

  // ───────────────────────── справочник для интерфейса ─────────────────────────
  async refs(academicYear: string, term: Term) {
    const [ctx, subjects, groups] = await Promise.all([
      this.ctxSvc.load(academicYear, term),
      this.prisma.subject.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true, credits: true, semester: true, color: true }, orderBy: { code: 'asc' } }),
      this.ctxSvc.groups(),
    ]);
    const uniq = <T>(a: T[]) => Array.from(new Set(a)).sort();
    return {
      groups, faculties: uniq(groups.map((g) => g.faculty)), specialties: uniq(groups.map((g) => g.specialty)),
      levels: ['BACHELOR', 'MASTER', 'PHD'],
      buildings: uniq(ctx.roomsAll.map((r) => r.building).filter((b): b is string => !!b)),
      roomTypes: ROOM_TYPES, features: uniq(ctx.roomsAll.flatMap((r) => r.features)),
      rooms: ctx.roomsAll.map((r) => ({ id: r.id, code: r.code, building: r.building, capacity: r.capacity, type: r.type })),
      teachers: Array.from(ctx.teacherMeta.values()).map((t) => ({ id: t.id, name: t.name, loginId: t.loginId, department: t.department })).sort((a, b) => a.name.localeCompare(b.name)),
      subjects,
      lessonTypes: Array.from(ctx.lessonTypes.values()),
      timeSlots: ctx.slotsAll,
      config: ctx.config,
      defaultWeights: DEFAULT_WEIGHTS,
    };
  }

  // ───────────────────────── временная сетка ─────────────────────────
  timeSlots() { return this.prisma.timeSlot.findMany({ orderBy: [{ sortOrder: 'asc' }, { startTime: 'asc' }] }); }

  private async assertNoOverlap(candidate: { id?: string; startTime: string; endTime: string; level: string | null; isActive: boolean }) {
    if (!candidate.isActive) return;
    const others = await this.prisma.timeSlot.findMany({ where: { isActive: true, ...(candidate.id ? { id: { not: candidate.id } } : {}) } });
    for (const o of others) {
      const sameLevel = !o.level || !candidate.level || o.level === candidate.level;
      if (sameLevel && parseTime(o.startTime) < parseTime(candidate.endTime) && parseTime(candidate.startTime) < parseTime(o.endTime)) {
        throw new BadRequestException({ message: `The slot overlaps with ${o.code} (${o.startTime}–${o.endTime})`, code: 'SLOT_OVERLAP', with: o.code });
      }
    }
  }

  async createSlot(actor: Actor, dto: z.infer<typeof TimeSlotSchema>, ctxA: AuditCtx) {
    if (await this.prisma.timeSlot.findUnique({ where: { code: dto.code } })) throw new ConflictException({ message: 'Slot code already exists', code: 'SLOT_EXISTS' });
    await this.assertNoOverlap({ startTime: dto.startTime, endTime: dto.endTime, level: dto.level ?? null, isActive: dto.isActive ?? true });
    const row = await this.prisma.timeSlot.create({ data: { code: dto.code, label: dto.label, startTime: dto.startTime, endTime: dto.endTime, level: dto.level ?? null, shift: dto.shift ?? null, sortOrder: dto.sortOrder ?? 0, isActive: dto.isActive ?? true } });
    await this.audit.record({ actorId: actor.id, action: 'timetable.slot_create', targetType: 'TimeSlot', targetId: row.id, new: dto }, ctxA);
    this.ctxSvc.invalidate();
    return row;
  }

  async patchSlot(actor: Actor, id: string, dto: z.infer<typeof TimeSlotPatchSchema>, ctxA: AuditCtx) {
    const cur = await this.prisma.timeSlot.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException('Time slot not found');
    const next = { ...cur, ...dto };
    if (next.startTime >= next.endTime) throw new BadRequestException({ message: 'startTime must be before endTime', code: 'BAD_TIME' });
    await this.assertNoOverlap({ id, startTime: next.startTime, endTime: next.endTime, level: next.level ?? null, isActive: next.isActive });
    const row = await this.prisma.timeSlot.update({ where: { id }, data: dto });
    await this.audit.record({ actorId: actor.id, action: 'timetable.slot_update', targetType: 'TimeSlot', targetId: id, old: { start: cur.startTime, end: cur.endTime, active: cur.isActive, level: cur.level }, new: { start: row.startTime, end: row.endTime, active: row.isActive, level: row.level } }, ctxA);
    this.ctxSvc.invalidate();
    return row;
  }

  async deleteSlot(actor: Actor, id: string, ctxA: AuditCtx) {
    const cur = await this.prisma.timeSlot.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException('Time slot not found');
    const used = await this.prisma.scheduleLesson.count({ where: { timeSlotId: id } });
    if (used) throw new ConflictException({ message: 'The slot is used by lessons. Deactivate it instead.', code: 'SLOT_IN_USE', lessons: used });
    await this.prisma.$transaction(async (tx) => {
      await tx.timeSlot.delete({ where: { id } });
      const rules = await tx.timetableRule.findMany({ where: { timeSlotIds: { has: id } } });
      for (const r of rules) await tx.timetableRule.update({ where: { id: r.id }, data: { timeSlotIds: r.timeSlotIds.filter((x) => x !== id) } });
      await this.audit.recordTx(tx, { actorId: actor.id, action: 'timetable.slot_delete', targetType: 'TimeSlot', targetId: id, old: { code: cur.code, start: cur.startTime, end: cur.endTime } }, ctxA);
    });
    this.ctxSvc.invalidate();
    return { deleted: true };
  }

  // ───────────────────────── типы занятий ─────────────────────────
  lessonTypes() { return this.prisma.lessonType.findMany({ orderBy: { sortOrder: 'asc' } }); }

  async createType(actor: Actor, dto: z.infer<typeof LessonTypeSchema>, ctxA: AuditCtx) {
    if (await this.prisma.lessonType.findUnique({ where: { code: dto.code } })) throw new ConflictException({ message: 'Lesson type code already exists', code: 'TYPE_EXISTS' });
    const row = await this.prisma.lessonType.create({ data: { code: dto.code, name: dto.name, roomTypes: dto.roomTypes, needsRoom: dto.needsRoom, color: dto.color ?? null, sortOrder: dto.sortOrder ?? 100, isActive: dto.isActive ?? true } });
    await this.audit.record({ actorId: actor.id, action: 'timetable.type_create', targetType: 'LessonType', targetId: row.id, new: dto }, ctxA);
    this.ctxSvc.invalidate();
    return row;
  }

  async patchType(actor: Actor, id: string, dto: z.infer<typeof LessonTypePatchSchema>, ctxA: AuditCtx) {
    const cur = await this.prisma.lessonType.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException('Lesson type not found');
    const row = await this.prisma.lessonType.update({ where: { id }, data: dto });
    await this.audit.record({ actorId: actor.id, action: 'timetable.type_update', targetType: 'LessonType', targetId: id, old: { name: cur.name, roomTypes: cur.roomTypes, needsRoom: cur.needsRoom, active: cur.isActive }, new: { name: row.name, roomTypes: row.roomTypes, needsRoom: row.needsRoom, active: row.isActive } }, ctxA);
    this.ctxSvc.invalidate();
    return row;
  }

  async deleteType(actor: Actor, id: string, ctxA: AuditCtx) {
    const cur = await this.prisma.lessonType.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException('Lesson type not found');
    if (SYSTEM_TYPES.includes(cur.code)) throw new ConflictException({ message: 'A built-in lesson type cannot be deleted. Deactivate it instead.', code: 'TYPE_BUILTIN' });
    const used = (await this.prisma.lessonRequirement.count({ where: { lessonTypeCode: cur.code } })) + (await this.prisma.scheduleLesson.count({ where: { lessonTypeCode: cur.code } }));
    if (used) throw new ConflictException({ message: 'The type is in use', code: 'TYPE_IN_USE', usage: used });
    await this.prisma.lessonType.delete({ where: { id } });
    await this.audit.record({ actorId: actor.id, action: 'timetable.type_delete', targetType: 'LessonType', targetId: id, old: { code: cur.code } }, ctxA);
    this.ctxSvc.invalidate();
    return { deleted: true };
  }

  // ───────────────────────── параметры периода ─────────────────────────
  async getConfig(academicYear: string, term: Term) {
    const ctx = await this.ctxSvc.load(academicYear, term);
    const row = await this.prisma.timetableConfig.findUnique({ where: { academicYear_term: { academicYear, term } } });
    return { academicYear, term, ...ctx.config, overridden: !!row, updatedAt: row?.updatedAt ?? null, defaultWeights: DEFAULT_WEIGHTS };
  }

  async patchConfig(actor: Actor, academicYear: string, term: Term, dto: z.infer<typeof ConfigPatchSchema>, ctxA: AuditCtx) {
    const before = await this.getConfig(academicYear, term);
    if (dto.softWeights) {
      const bad = Object.keys(dto.softWeights).filter((k) => !(k in DEFAULT_WEIGHTS));
      if (bad.length) throw new BadRequestException({ message: 'Unknown weights: ' + bad.join(', '), code: 'UNKNOWN_WEIGHT' });
    }
    const data = { ...dto, softWeights: dto.softWeights as Prisma.InputJsonValue | undefined, workingDays: dto.workingDays ? Array.from(new Set(dto.workingDays)).sort() : undefined };
    await this.prisma.timetableConfig.upsert({
      where: { academicYear_term: { academicYear, term } },
      create: { academicYear, term, ...data, updatedBy: actor.id },
      update: { ...data, updatedBy: actor.id },
    });
    this.ctxSvc.invalidate();
    const after = await this.getConfig(academicYear, term);
    await this.audit.record({ actorId: actor.id, action: 'timetable.settings_update', targetType: 'TimetableConfig', targetId: `${academicYear}:${term}`, old: { workingDays: before.workingDays, maxConsecutive: before.maxConsecutive, maxDaily: before.maxDaily, timeLimitSec: before.timeLimitSec, weights: before.weights }, new: { workingDays: after.workingDays, maxConsecutive: after.maxConsecutive, maxDaily: after.maxDaily, timeLimitSec: after.timeLimitSec, weights: after.weights } }, ctxA);
    return after;
  }

  // ───────────────────────── правила и доступность ─────────────────────────
  private async validateRule(dto: Rule) {
    if (!KIND_SCOPES[dto.kind].includes(dto.scope)) throw new BadRequestException({ message: `Rule ${dto.kind} is not applicable to ${dto.scope}`, code: 'BAD_RULE_SCOPE' });
    if (dto.kind === 'PREFERRED' && dto.hard) throw new BadRequestException({ message: 'A preference cannot be hard', code: 'BAD_RULE' });
    const v = (dto.value ?? {}) as Record<string, unknown>;
    if (dto.kind === 'MAX_PER_DAY' && !(Number(v.max) >= 1)) throw new BadRequestException({ message: 'value.max (>=1) is required', code: 'BAD_RULE_VALUE' });
    if (dto.kind === 'ALLOWED_BUILDINGS' && !(Array.isArray(v.buildings) && v.buildings.length)) throw new BadRequestException({ message: 'value.buildings is required', code: 'BAD_RULE_VALUE' });
    if (dto.kind === 'NO_LATE' && !(Number(v.fromOrder) >= 0)) throw new BadRequestException({ message: 'value.fromOrder is required', code: 'BAD_RULE_VALUE' });
    if (dto.timeSlotIds.length) {
      const n = await this.prisma.timeSlot.count({ where: { id: { in: dto.timeSlotIds } } });
      if (n !== new Set(dto.timeSlotIds).size) throw new BadRequestException({ message: 'Unknown time slot in rule', code: 'UNKNOWN_SLOT' });
    }
    const t = dto.targetId!;
    if (dto.scope === 'TEACHER' && !(await this.prisma.teacher.findUnique({ where: { userId: t }, select: { userId: true } }))) throw new BadRequestException({ message: 'Unknown teacher', code: 'UNKNOWN_TARGET' });
    if (dto.scope === 'ROOM' && !(await this.prisma.room.findUnique({ where: { id: t }, select: { id: true } }))) throw new BadRequestException({ message: 'Unknown room', code: 'UNKNOWN_TARGET' });
    if (dto.scope === 'SUBJECT' && !(await this.prisma.subject.findUnique({ where: { id: t }, select: { id: true } }))) throw new BadRequestException({ message: 'Unknown subject', code: 'UNKNOWN_TARGET' });
    if (dto.scope === 'GROUP' && !(await this.ctxSvc.groups()).some((g) => g.name === t)) throw new BadRequestException({ message: 'Unknown group', code: 'UNKNOWN_TARGET' });
    if (dto.scope === 'BUILDING' && !(await this.prisma.room.findFirst({ where: { building: t }, select: { id: true } }))) throw new BadRequestException({ message: 'Unknown building', code: 'UNKNOWN_TARGET' });
  }

  private ruleView(r: TimetableRule) { return { id: r.id, scope: r.scope, targetId: r.targetId, kind: r.kind, hard: r.hard, days: r.days, timeSlotIds: r.timeSlotIds, value: r.value, weight: r.weight, note: r.note, academicYear: r.academicYear, term: r.term, createdBy: r.createdBy, createdAt: r.createdAt }; }

  async listRules(q: { scope?: string; targetId?: string; kind?: string; take: number; page: number }) {
    const where: Prisma.TimetableRuleWhereInput = { ...(q.scope ? { scope: q.scope as never } : {}), ...(q.targetId ? { targetId: q.targetId } : {}), ...(q.kind ? { kind: q.kind as never } : {}) };
    const [total, rows] = await Promise.all([this.prisma.timetableRule.count({ where }), this.prisma.timetableRule.findMany({ where, orderBy: [{ scope: 'asc' }, { createdAt: 'desc' }], skip: (q.page - 1) * q.take, take: q.take })]);
    return { total, page: q.page, items: rows.map((r) => this.ruleView(r)) };
  }

  async createRule(actor: Actor, dto: Rule, ctxA: AuditCtx) {
    await this.validateRule(dto);
    const row = await this.prisma.timetableRule.create({ data: { scope: dto.scope, targetId: dto.targetId ?? null, kind: dto.kind, hard: dto.hard, days: dto.days, timeSlotIds: dto.timeSlotIds, value: (dto.value ?? undefined) as Prisma.InputJsonValue | undefined, weight: dto.weight, note: dto.note ?? null, academicYear: dto.academicYear ?? null, term: dto.term ?? null, createdBy: actor.id } });
    await this.audit.record({ actorId: actor.id, action: 'timetable.rule_create', targetType: 'TimetableRule', targetId: row.id, new: this.ruleView(row) }, ctxA);
    this.ctxSvc.invalidate();
    return this.ruleView(row);
  }

  async patchRule(actor: Actor, id: string, dto: Partial<Rule>, ctxA: AuditCtx) {
    const cur = await this.prisma.timetableRule.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException('Rule not found');
    const merged: Rule = {
      scope: dto.scope ?? cur.scope, targetId: dto.targetId !== undefined ? dto.targetId : cur.targetId, kind: dto.kind ?? cur.kind, hard: dto.hard ?? cur.hard, days: dto.days ?? cur.days,
      timeSlotIds: dto.timeSlotIds ?? cur.timeSlotIds, value: dto.value !== undefined ? dto.value : (cur.value as Record<string, unknown> | null), weight: dto.weight ?? cur.weight, note: dto.note !== undefined ? dto.note : cur.note,
      academicYear: dto.academicYear !== undefined ? dto.academicYear : cur.academicYear, term: dto.term !== undefined ? dto.term : cur.term,
    };
    await this.validateRule(merged);
    const row = await this.prisma.timetableRule.update({ where: { id }, data: { scope: merged.scope, targetId: merged.targetId ?? null, kind: merged.kind, hard: merged.hard, days: merged.days, timeSlotIds: merged.timeSlotIds, value: (merged.value ?? Prisma.DbNull) as never, weight: merged.weight, note: merged.note ?? null, academicYear: merged.academicYear ?? null, term: merged.term ?? null } });
    await this.audit.record({ actorId: actor.id, action: 'timetable.rule_update', targetType: 'TimetableRule', targetId: id, old: this.ruleView(cur), new: this.ruleView(row) }, ctxA);
    this.ctxSvc.invalidate();
    return this.ruleView(row);
  }

  async deleteRule(actor: Actor, id: string, ctxA: AuditCtx) {
    const cur = await this.prisma.timetableRule.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException('Rule not found');
    await this.prisma.timetableRule.delete({ where: { id } });
    await this.audit.record({ actorId: actor.id, action: 'timetable.rule_delete', targetType: 'TimetableRule', targetId: id, old: this.ruleView(cur) }, ctxA);
    this.ctxSvc.invalidate();
    return { deleted: true };
  }

  /** Самообслуживание преподавателя: его собственные пожелания (мягкие правила, не нарушающие hard-ограничения других) */
  async myAvailability(userId: string) {
    const rows = await this.prisma.timetableRule.findMany({ where: { scope: 'TEACHER', targetId: userId, createdBy: userId }, orderBy: { createdAt: 'asc' } });
    const timeSlots = await this.prisma.timeSlot.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { startTime: 'asc' }], select: { id: true, code: true, label: true, startTime: true, endTime: true, level: true } });
    return { rules: rows.map((r) => ({ id: r.id, kind: r.kind, days: r.days, timeSlotIds: r.timeSlotIds, note: r.note })), timeSlots };
  }

  async setMyAvailability(actor: Actor, dto: z.infer<typeof MyAvailabilitySchema>, ctxA: AuditCtx) {
    if (!(await this.prisma.teacher.findUnique({ where: { userId: actor.id }, select: { userId: true } }))) throw new BadRequestException({ message: 'Only teachers can set availability', code: 'NOT_TEACHER' });
    const slotIds = Array.from(new Set(dto.rules.flatMap((r) => r.timeSlotIds)));
    if (slotIds.length && (await this.prisma.timeSlot.count({ where: { id: { in: slotIds } } })) !== slotIds.length) throw new BadRequestException({ message: 'Unknown time slot', code: 'UNKNOWN_SLOT' });
    const before = await this.myAvailability(actor.id);
    await this.prisma.$transaction(async (tx) => {
      await tx.timetableRule.deleteMany({ where: { scope: 'TEACHER', targetId: actor.id, createdBy: actor.id } });
      if (dto.rules.length) await tx.timetableRule.createMany({ data: dto.rules.map((r) => ({ scope: 'TEACHER' as const, targetId: actor.id, kind: r.kind, hard: false, days: r.days, timeSlotIds: r.timeSlotIds, weight: r.kind === 'UNAVAILABLE' ? 3 : 2, note: r.note ?? null, createdBy: actor.id })) });
      await this.audit.recordTx(tx, { actorId: actor.id, action: 'timetable.availability_update', targetType: 'Teacher', targetId: actor.id, old: before.rules.length, new: dto.rules.length }, ctxA);
    });
    this.ctxSvc.invalidate();
    return this.myAvailability(actor.id);
  }
}
