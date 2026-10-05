import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, TimetableJob } from '@prisma/client';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { AuditCtx, AuditTrailService } from '../../common/audit/audit-trail.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { PeriodService } from '../journal/period.service';
import { SolveResult, Level, PRule, PSession, PFixed, PARITY_BITS, Problem, ParityMask, parseTime } from './engine/types';
import { TimetableConflictsService } from './timetable.conflicts.service';
import { TTContext, TimetableContextService } from './timetable.context.service';
import { GenerateDto } from './timetable.dto';
import { Actor } from './timetable.lessons.service';
import { TimetableVersionsService } from './timetable.versions.service';

type Scope = GenerateDto['scope'];
interface Prepared {
  problem: Problem;
  sessionMeta: Map<string, { requirementId: string; index: number; subjectId: string; groups: string[]; type: string; teacherId: string | null }>;
  freed: number;
  kept: number;
  requirementsInScope: number;
}

@Injectable()
export class TimetableJobsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Timetable');
  private busy = false;
  private current: { jobId: string; worker: Worker; flag: Int32Array } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ctxSvc: TimetableContextService,
    private readonly versions: TimetableVersionsService,
    private readonly conflicts: TimetableConflictsService,
    private readonly audit: AuditTrailService,
    private readonly periods: PeriodService,
  ) {}

  async onModuleInit() {
    // задачи, прерванные перезапуском сервера, помечаем как FAILED
    const stuck = await this.prisma.timetableJob.findMany({ where: { status: { in: ['QUEUED', 'RUNNING'] } } });
    for (const j of stuck) {
      await this.prisma.timetableJob.update({ where: { id: j.id }, data: { status: 'FAILED', error: 'Server restarted while the job was running', finishedAt: new Date() } });
      if (j.versionId) await this.prisma.scheduleVersion.updateMany({ where: { id: j.versionId, status: 'DRAFT' }, data: { note: 'Generation interrupted by a server restart' } });
    }
  }

  onModuleDestroy() {
    if (this.current) { Atomics.store(this.current.flag, 0, 1); void this.current.worker.terminate(); }
  }

  // ───────────────────────── API ─────────────────────────
  async enqueue(actor: Actor, dto: GenerateDto, ctxA: AuditCtx) {
    if (await this.periods.isClosed(dto.academicYear, dto.term)) throw new ForbiddenException({ message: 'Academic period is closed', code: 'PERIOD_CLOSED' });
    const running = await this.prisma.timetableJob.count({ where: { status: { in: ['QUEUED', 'RUNNING'] }, academicYear: dto.academicYear, term: dto.term } });
    if (running) throw new ConflictException({ message: 'A generation job for this period is already in progress', code: 'JOB_ACTIVE' });
    if (dto.mode === 'REGENERATE' && !dto.baseVersionId) throw new BadRequestException({ message: 'baseVersionId is required for REGENERATE', code: 'BASE_REQUIRED' });

    const version = await this.versions.createDraft(
      actor,
      { academicYear: dto.academicYear, term: dto.term, fromVersionId: dto.baseVersionId ?? null, name: dto.mode === 'REGENERATE' ? 'Regeneration' : 'Generated', note: dto.note },
      ctxA,
      'timetable.version_create',
    );
    const job = await this.prisma.timetableJob.create({
      data: { versionId: version.id, academicYear: dto.academicYear, term: dto.term, kind: dto.mode, status: 'QUEUED', scope: dto.scope as Prisma.InputJsonValue, params: { timeLimitSec: dto.timeLimitSec ?? null, seed: dto.seed ?? null, baseVersionId: dto.baseVersionId ?? null } as Prisma.InputJsonValue, phase: 'QUEUED', createdBy: actor.id },
    });
    await this.audit.record({ actorId: actor.id, action: 'timetable.generate', targetType: 'TimetableJob', targetId: job.id, new: { mode: dto.mode, scope: dto.scope }, extra: { versionId: version.id, version: version.number, academicYear: dto.academicYear, term: dto.term } }, ctxA);
    setImmediate(() => void this.pump());
    return { job: this.view(job), version };
  }

  view(j: TimetableJob) {
    return { id: j.id, versionId: j.versionId, academicYear: j.academicYear, term: j.term, kind: j.kind, status: j.status, progress: j.progress, phase: j.phase, scope: j.scope, result: j.result, error: j.error, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt };
  }

  async get(id: string) {
    const j = await this.prisma.timetableJob.findUnique({ where: { id } });
    if (!j) throw new NotFoundException('Job not found');
    return this.view(j);
  }

  async list(q: { academicYear?: string; term?: string }) {
    const rows = await this.prisma.timetableJob.findMany({ where: { ...(q.academicYear ? { academicYear: q.academicYear } : {}), ...(q.term ? { term: q.term as never } : {}) }, orderBy: { createdAt: 'desc' }, take: 30 });
    return rows.map((r) => this.view(r));
  }

  async cancel(actor: Actor, id: string, ctxA: AuditCtx) {
    const j = await this.prisma.timetableJob.findUnique({ where: { id } });
    if (!j) throw new NotFoundException('Job not found');
    if (j.status === 'QUEUED') {
      await this.prisma.timetableJob.update({ where: { id }, data: { status: 'CANCELLED', finishedAt: new Date(), phase: 'CANCELLED' } });
      if (j.versionId) await this.prisma.scheduleVersion.updateMany({ where: { id: j.versionId, status: 'DRAFT' }, data: { status: 'ARCHIVED', archivedAt: new Date(), note: 'Generation cancelled' } });
    } else if (j.status === 'RUNNING' && this.current?.jobId === id) {
      Atomics.store(this.current.flag, 0, 1);
    } else {
      throw new ConflictException({ message: 'The job is already finished', code: 'BAD_STATE' });
    }
    await this.audit.record({ actorId: actor.id, action: 'timetable.generate_cancel', targetType: 'TimetableJob', targetId: id }, ctxA);
    return this.get(id);
  }

  // ───────────────────────── очередь ─────────────────────────
  private async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (true) {
        const job = await this.prisma.timetableJob.findFirst({ where: { status: 'QUEUED' }, orderBy: { createdAt: 'asc' } });
        if (!job) break;
        await this.run(job).catch(async (e) => {
          this.log.error(`job ${job.id} failed: ${e?.stack ?? e}`);
          await this.prisma.timetableJob.update({ where: { id: job.id }, data: { status: 'FAILED', error: String(e?.message ?? e).slice(0, 500), finishedAt: new Date(), phase: 'FAILED' } });
          if (job.versionId) await this.prisma.scheduleVersion.updateMany({ where: { id: job.versionId, status: 'DRAFT' }, data: { status: 'ARCHIVED', archivedAt: new Date(), note: 'Generation failed' } });
        });
      }
    } finally {
      this.busy = false;
    }
  }

  private async run(job: TimetableJob) {
    await this.prisma.timetableJob.update({ where: { id: job.id }, data: { status: 'RUNNING', startedAt: new Date(), progress: 1, phase: 'BUILD' } });
    const params = (job.params ?? {}) as { timeLimitSec?: number | null; seed?: number | null };
    const ctx = await this.ctxSvc.load(job.academicYear, job.term);
    const prepared = await this.prepare(job, ctx, (job.scope ?? {}) as Scope, params);

    const flag = new Int32Array(new SharedArrayBuffer(4));
    const result = await new Promise<SolveResult>((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'engine', 'solver.worker.js'), { workerData: { problem: prepared.problem, flag: flag.buffer }, resourceLimits: { maxOldGenerationSizeMb: 1536 } });
      this.current = { jobId: job.id, worker, flag };
      let lastWrite = 0;
      worker.on('message', (m: any) => {
        if (m.type === 'progress') {
          const now = Date.now();
          if (now - lastWrite > 700) {
            lastWrite = now;
            void this.prisma.timetableJob.update({ where: { id: job.id }, data: { progress: m.percent, phase: m.phase, result: { placed: m.placed, total: m.total, cost: m.cost } as Prisma.InputJsonValue } }).catch(() => undefined);
          }
        } else if (m.type === 'done') resolve(m.result);
        else if (m.type === 'error') reject(new Error(m.message));
      });
      worker.on('error', reject);
      worker.on('exit', (code) => { if (code !== 0) reject(new Error('Solver worker exited with code ' + code)); });
    }).finally(() => { this.current = null; });

    if (Atomics.load(flag, 0) === 1) {
      await this.prisma.timetableJob.update({ where: { id: job.id }, data: { status: 'CANCELLED', finishedAt: new Date(), phase: 'CANCELLED', progress: 100 } });
      if (job.versionId) await this.prisma.scheduleVersion.updateMany({ where: { id: job.versionId, status: 'DRAFT' }, data: { status: 'ARCHIVED', archivedAt: new Date(), note: 'Generation cancelled' } });
      return;
    }
    await this.apply(job, ctx, prepared, result);
  }

  // ───────────────────────── подготовка задачи ─────────────────────────
  private groupScope(ctx: TTContext, scope: Scope): Set<string> | null {
    if (!scope.groups?.length && !scope.faculties?.length && !scope.levels?.length && !scope.specialties?.length) return null;
    let list = Array.from(ctx.groupMeta.values());
    if (scope.levels?.length) list = list.filter((g) => scope.levels!.includes(g.level));
    if (scope.faculties?.length) list = list.filter((g) => scope.faculties!.includes(g.faculty));
    if (scope.specialties?.length) list = list.filter((g) => scope.specialties!.includes(g.specialty));
    if (scope.groups?.length) list = list.filter((g) => scope.groups!.includes(g.name));
    return new Set(list.map((g) => g.name));
  }

  private async prepare(job: TimetableJob, ctx: TTContext, scope: Scope, params: { timeLimitSec?: number | null; seed?: number | null }): Promise<Prepared> {
    const versionId = job.versionId!;
    const groups = this.groupScope(ctx, scope);
    const inGroups = (names: string[]) => !groups || names.every((g) => groups.has(g));
    const slotSet = scope.slotIds?.length ? new Set(scope.slotIds) : null;
    const daySet = scope.days?.length ? new Set(scope.days) : null;

    // занятия, которые будут пересозданы: в области, не зафиксированные
    const existing = await this.prisma.scheduleLesson.findMany({ where: { versionId } });
    const lessonSet = scope.lessonIds?.length ? new Set(scope.lessonIds) : null;
    // id занятий пришли из базовой версии, а работа идёт в её копии: сопоставляем по (нагрузка, номер занятия)
    const baseId = (job.params as { baseVersionId?: string | null } | null)?.baseVersionId;
    if (lessonSet && baseId && baseId !== versionId) {
      const baseRows = await this.prisma.scheduleLesson.findMany({ where: { versionId: baseId, id: { in: Array.from(lessonSet) } }, select: { requirementId: true, sessionIndex: true } });
      const keys = new Set(baseRows.filter((b) => b.requirementId).map((b) => `${b.requirementId}#${b.sessionIndex}`));
      for (const l of existing) if (l.requirementId && keys.has(`${l.requirementId}#${l.sessionIndex}`)) lessonSet.add(l.id);
    }
    const free = existing.filter((l) =>
      !l.locked && (!lessonSet || (lessonSet.has(l.id) && !!l.requirementId)) && inGroups(l.groupNames)
      && (!scope.teachers?.length || (l.teacherId && scope.teachers.includes(l.teacherId)))
      && (!scope.subjects?.length || scope.subjects.includes(l.subjectId))
      && (!daySet || daySet.has(l.dayOfWeek))
      && (!slotSet || (l.timeSlotId && slotSet.has(l.timeSlotId))),
    );
    if (free.length) await this.prisma.scheduleLesson.deleteMany({ where: { id: { in: free.map((l) => l.id) } } });
    const freeIds = new Set(free.map((l) => l.id));
    const kept = existing.filter((l) => !freeIds.has(l.id));

    const reqs = await this.prisma.lessonRequirement.findMany({ where: { academicYear: job.academicYear, term: job.term, isActive: true } });
    const keptByReq = new Map<string, number>();
    for (const l of kept) if (l.requirementId) keptByReq.set(l.requirementId, (keptByReq.get(l.requirementId) ?? 0) + 1);

    const sessions: PSession[] = [];
    const sessionMeta: Prepared['sessionMeta'] = new Map();
    let inScope = 0;
    for (const r of reqs) {
      if (!inGroups(r.groupNames)) continue;
      if (scope.teachers?.length && !(r.teacherId && scope.teachers.includes(r.teacherId))) continue;
      if (scope.subjects?.length && !scope.subjects.includes(r.subjectId)) continue;
      if (r.groupNames.some((g) => !ctx.groupMeta.has(g))) continue;
      const type = ctx.lessonTypes.get(r.lessonTypeCode);
      if (!type) continue;
      inScope++;
      const have = keptByReq.get(r.id) ?? 0;
      const level = (ctx.groupMeta.get(r.groupNames[0])!.level) as Level;
      for (let i = have; i < r.sessionsPerWeek; i++) {
        const id = `${r.id}#${i}`;
        sessions.push({
          id, requirementId: r.id, index: i, subjectId: r.subjectId, teacherId: r.teacherId, groups: r.groupNames, type: r.lessonTypeCode,
          roomTypes: r.roomType ? [r.roomType] : type.roomTypes, features: r.requiredFeatures, parity: (PARITY_BITS[r.weekParity] ?? 3) as ParityMask,
          duration: r.durationSlots, level, needsRoom: type.needsRoom,
        });
        sessionMeta.set(id, { requirementId: r.id, index: i, subjectId: r.subjectId, groups: r.groupNames, type: r.lessonTypeCode, teacherId: r.teacherId });
      }
    }

    const fixed: PFixed[] = kept.map((l) => ({
      id: l.id, requirementId: l.requirementId, subjectId: l.subjectId, teacherId: l.teacherId, roomId: l.roomId, groups: l.groupNames, day: l.dayOfWeek,
      start: parseTime(l.startTime), end: parseTime(l.endTime), parity: (PARITY_BITS[l.weekParity] ?? 3) as ParityMask,
    }));

    // ограничения области по аудиториям / дням / парам реализованы правилами (hard) поверх основных
    const rules: PRule[] = ctx.rules.slice();
    if (scope.rooms?.length) {
      const allowed = new Set(scope.rooms);
      for (const r of ctx.rooms) if (!allowed.has(r.id)) rules.push({ scope: 'ROOM', target: r.id, kind: 'UNAVAILABLE', hard: true, days: [], slotCodes: [], value: null, weight: 1 });
    }
    const slots = slotSet ? ctx.slots.filter((s) => slotSet.has(s.id)) : ctx.slots;
    const days = daySet ? ctx.config.workingDays.filter((d) => daySet.has(d)) : ctx.config.workingDays;
    const limitMs = (params.timeLimitSec ?? ctx.config.timeLimitSec) * 1000;
    const problem: Problem = {
      days, slots, rooms: ctx.rooms, teachers: ctx.teachers, groups: ctx.groups, rules, sessions, fixed, weights: ctx.config.weights,
      params: ctx.solverParams(params.seed ?? Math.floor(Math.random() * 1_000_000_000) + 1, limitMs),
    };
    // слоты фиксированных занятий, не входящих в сетку выбора, движок добавит сам как «индивидуальные интервалы»
    return { problem, sessionMeta, freed: free.length, kept: kept.length, requirementsInScope: inScope };
  }

  // ───────────────────────── применение результата ─────────────────────────
  private async apply(job: TimetableJob, ctx: TTContext, prep: Prepared, res: SolveResult) {
    const versionId = job.versionId!;
    const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const sessById = new Map(prep.problem.sessions.map((s) => [s.id, s]));
    const rows: Prisma.ScheduleLessonCreateManyInput[] = res.assignments.map((a) => {
      const meta = prep.sessionMeta.get(a.sessionId)!;
      const s = sessById.get(a.sessionId)!;
      return {
        versionId, requirementId: meta.requirementId, sessionIndex: meta.index, subjectId: meta.subjectId, teacherId: meta.teacherId, roomId: a.roomId, groupNames: meta.groups,
        lessonTypeCode: meta.type, dayOfWeek: a.day, timeSlotId: a.slotId, startTime: hhmm(a.start), endTime: hhmm(a.end),
        weekParity: s.parity === 1 ? 'UPPER' : s.parity === 2 ? 'LOWER' : 'BOTH', level: s.level,
      };
    });
    // индекс sessions по id для скорости при больших объёмах
    for (let i = 0; i < rows.length; i += 1000) await this.prisma.scheduleLesson.createMany({ data: rows.slice(i, i + 1000) });

    const { result: check, stats } = await this.conflicts.check(versionId, true);
    const reqIds = Array.from(new Set(res.unplaced.map((u) => prep.sessionMeta.get(u.sessionId)?.requirementId).filter(Boolean) as string[]));
    const reqs = reqIds.length ? await this.prisma.lessonRequirement.findMany({ where: { id: { in: reqIds } }, include: { subject: { select: { code: true, name: true } } } }) : [];
    const reqById = new Map(reqs.map((r) => [r.id, r]));
    const total = prep.problem.sessions.length;
    const summary = {
      sessionsTotal: total,
      placed: res.assignments.length,
      successPct: total ? Math.round((res.assignments.length / total) * 1000) / 10 : 100,
      freedLessons: prep.freed,
      keptLessons: prep.kept,
      requirementsInScope: prep.requirementsInScope,
      lessonsInVersion: stats.lessons,
      groups: stats.groups,
      teachers: stats.teachers,
      roomsUsed: stats.roomsUsed,
      critical: stats.critical,
      warnings: stats.warnings,
      compliancePct: stats.compliancePct,
      softCost: res.cost,
      breakdown: res.breakdown,
      iterations: res.iterations,
      elapsedMs: res.elapsedMs,
      phases: res.phases,
      unplaced: res.unplaced.slice(0, 300).map((u) => {
        const m = prep.sessionMeta.get(u.sessionId);
        const r = m ? reqById.get(m.requirementId) : undefined;
        return { requirementId: m?.requirementId ?? null, subject: r?.subject.code ?? null, subjectName: r?.subject.name ?? null, groups: m?.groups ?? [], type: m?.type ?? null, code: u.code, tally: u.tally };
      }),
      unplacedCount: res.unplaced.length,
      criticalSample: check.critical.length,
    };
    await this.prisma.timetableJob.update({ where: { id: job.id }, data: { status: 'DONE', progress: 100, phase: 'DONE', finishedAt: new Date(), result: summary as unknown as Prisma.InputJsonValue } });
    await this.audit.record({ actorId: job.createdBy, action: 'timetable.generate_done', targetType: 'TimetableJob', targetId: job.id, new: { placed: summary.placed, total, unplaced: summary.unplacedCount, critical: summary.critical, warnings: summary.warnings }, extra: { versionId } });
  }
}
