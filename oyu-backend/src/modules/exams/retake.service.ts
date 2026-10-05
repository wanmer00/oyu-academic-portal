import { BadRequestException, ConflictException, NotFoundException, Injectable } from '@nestjs/common';
import { Term } from '@prisma/client';
import { z } from 'zod';
import { AuditCtx } from '../../common/audit/audit-trail.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { Actor, ExamCommon } from './exam-common.service';
import { ResitService } from './resit.service';
import { isoDate } from './exam.rules';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const OfferingSchema = z.object({
  subjectId: z.string(), specialtyId: z.string().nullable().optional(), academicYear: z.string().regex(/^\d{4}-\d{4}$/), term: z.nativeEnum(Term),
  course: z.number().int().min(1).max(6), semester: z.number().int().min(1).max(12), cycle: z.enum(['EVERY_YEAR', 'EVEN_YEARS', 'ODD_YEARS']).default('EVERY_YEAR'),
  isAvailable: z.boolean().default(true), startsAt: day, enrollmentOpensAt: day.nullable().optional(), enrollmentClosesAt: day.nullable().optional(), prerequisiteIds: z.array(z.string()).default([]),
});
export const SummerPeriodSchema = z.object({ title: z.string().trim().min(3).max(120), academicYear: z.string().regex(/^\d{4}-\d{4}$/), startDate: day, endDate: day, registrationClosesAt: z.string().datetime() });
export const SummerCourseSchema = z.object({ subjectId: z.string(), teacherId: z.string().nullable().optional(), schedule: z.string().max(200).nullable().optional(), maxStudents: z.number().int().min(1).max(500).default(30), minAttendance: z.number().int().min(0).max(100).default(75), assessment: z.enum(['FINAL_EXAM', 'PROJECT', 'COURSEWORK']).default('FINAL_EXAM') });
export const RetakeChoiceSchema = z.object({ mode: z.enum(['SUMMER', 'NEXT_OFFERING']), summerCourseId: z.string().optional(), offeringId: z.string().optional() });

/**
 * Retake — повторное прохождение предмета (НЕ 25% resit): новый академический enrollment.
 * Два пути: летние занятия (SummerRetakeCourse) или ближайшее предложение предмета (SubjectOffering), вычисленное по данным, а не «год + 1».
 */
@Injectable()
export class RetakeService {
  constructor(private readonly prisma: PrismaService, private readonly common: ExamCommon, private readonly resits: ResitService) {}

  private startOf(academicYear: string, term: string) {
    const y = Number(academicYear.slice(0, 4));
    return term === 'FALL' ? new Date(Date.UTC(y, 8, 1)) : term === 'SPRING' ? new Date(Date.UTC(y + 1, 1, 1)) : new Date(Date.UTC(y + 1, 5, 15));
  }

  /** Варианты для enrollment: летние курсы + все будущие предложения предмета (с причиной блокировки) + рекомендованное ближайшее */
  async options(studentId: string, enrollmentId: string, now = new Date()) {
    const en = await this.prisma.subjectEnrollment.findFirst({ where: { id: enrollmentId, studentId }, include: { subject: { select: { id: true, code: true, name: true } } } });
    if (!en) throw new NotFoundException('Enrollment not found');
    const st = await this.prisma.student.findUniqueOrThrow({ where: { userId: studentId }, select: { course: true, groupName: true } });
    const grp = await this.prisma.academicGroup.findUnique({ where: { name: st.groupName }, select: { specialtyId: true } });
    const curYear = this.common.startYear(this.common.academicYearOf(now));

    const periods = await this.prisma.summerRetakePeriod.findMany({ where: { status: 'OPEN', registrationClosesAt: { gt: now } }, include: { courses: { where: { subjectId: en.subjectId }, include: { teacher: { select: { user: { select: { fullName: true } } } }, _count: { select: { retakes: { where: { status: { not: 'CANCELLED' } } } } } } } } });
    const summer = periods.flatMap((p) => p.courses.map((c) => ({
      courseId: c.id, periodId: p.id, title: p.title, startDate: isoDate(p.startDate), endDate: isoDate(p.endDate), registrationClosesAt: p.registrationClosesAt, teacher: c.teacher?.user.fullName ?? null,
      schedule: c.schedule, minAttendance: c.minAttendance, assessment: c.assessment, seatsLeft: Math.max(0, c.maxStudents - c._count.retakes),
    })));

    const offerings = await this.prisma.subjectOffering.findMany({
      where: { subjectId: en.subjectId, isAvailable: true, startsAt: { gt: now }, OR: [{ specialtyId: null }, ...(grp ? [{ specialtyId: grp.specialtyId }] : [])] },
      include: { prerequisites: { include: { requiredSubject: { select: { id: true, name: true } } } } }, orderBy: { startsAt: 'asc' },
    });
    const done = new Set((await this.prisma.subjectEnrollment.findMany({ where: { studentId, status: 'COMPLETED' }, select: { subjectId: true } })).map((e) => e.subjectId));
    const list = offerings.map((o) => {
      const missing = o.prerequisites.filter((p) => !done.has(p.requiredSubjectId)).map((p) => p.requiredSubject);
      // курс студента к моменту начала предложения; предмет старшего курса раньше времени взять нельзя
      const courseThen = st.course + (this.common.startYear(o.academicYear) - curYear);
      let blocked: string | null = null;
      if (o.enrollmentClosesAt && o.enrollmentClosesAt < now) blocked = 'ENROLLMENT_CLOSED';
      else if (o.enrollmentOpensAt && o.enrollmentOpensAt > now) blocked = 'ENROLLMENT_NOT_OPEN';
      else if (missing.length) blocked = 'PREREQUISITE_MISSING';
      else if (o.course > courseThen) blocked = 'COURSE_TOO_EARLY';
      return { offeringId: o.id, academicYear: o.academicYear, term: o.term, course: o.course, semester: o.semester, cycle: o.cycle, startsAt: isoDate(o.startsAt), blocked, missingPrerequisites: missing };
    });
    const next = list.find((o) => !o.blocked) ?? null;
    return { enrollmentId, subject: en.subject, summer, offerings: list, next };
  }

  /** Студент выбирает путь повторного прохождения; создаётся RetakeEnrollment и новый SubjectEnrollment (attemptNo + 1) */
  async register(user: Actor, enrollmentId: string, dto: z.infer<typeof RetakeChoiceSchema>, ctx: AuditCtx) {
    const now = new Date();
    const out = await this.prisma.$transaction(async (tx) => {
      await this.common.lockStudent(tx, user.id);
      const en = await tx.subjectEnrollment.findFirst({ where: { id: enrollmentId, studentId: user.id }, include: { subject: { select: { name: true } } } });
      if (!en) throw new NotFoundException('Enrollment not found');
      let allowed = en.status === 'RETAKE_REQUIRED' || en.status === 'RESIT_FORFEITED';
      if (!allowed && en.status === 'RESIT_ELIGIBLE') {
        // лимит 2 resit в цикле достигнут → пересдать этот предмет нельзя, остаётся retake
        const w = await this.resits.targetWindow(en, now, tx);
        const key = w?.finalWindow ? `${w.finalWindow.academicYear}:${w.finalWindow.term}` : null;
        allowed = !!key && (await this.resits.usedInCycle(user.id, key, tx)) >= this.common.cfg.maxResits();
      }
      if (!allowed) throw new ConflictException({ message: 'Retake is not available for this subject', code: 'RETAKE_NOT_ALLOWED' });
      if (await tx.retakeEnrollment.findUnique({ where: { failedEnrollmentId: en.id } })) throw new ConflictException({ message: 'Already registered', code: 'RETAKE_EXISTS' });

      let academicYear: string, term: Term, semester = en.semester, offeringId: string | null = null, summerCourseId: string | null = null;
      if (dto.mode === 'SUMMER') {
        if (!dto.summerCourseId) throw new BadRequestException({ message: 'summerCourseId required', code: 'RETAKE_CHOICE' });
        const c = await tx.summerRetakeCourse.findUnique({ where: { id: dto.summerCourseId }, include: { period: true, _count: { select: { retakes: { where: { status: { not: 'CANCELLED' } } } } } } });
        if (!c || c.subjectId !== en.subjectId || c.period.status !== 'OPEN') throw new NotFoundException('Summer course not found');
        if (c.period.registrationClosesAt < now) throw new ConflictException({ message: 'Registration is closed', code: 'ENROLLMENT_CLOSED' });
        if (c._count.retakes >= c.maxStudents) throw new ConflictException({ message: 'No seats left', code: 'NO_SEATS' });
        academicYear = c.period.academicYear; term = 'SUMMER'; summerCourseId = c.id;
      } else {
        const opts = await this.options(user.id, en.id, now);
        const o = opts.offerings.find((x) => x.offeringId === dto.offeringId);
        if (!o) throw new NotFoundException('Offering not found');
        if (o.blocked) throw new ConflictException({ message: 'Offering is not available', code: o.blocked, missing: o.missingPrerequisites });
        academicYear = o.academicYear; term = o.term; semester = o.semester; offeringId = o.offeringId;
      }
      const attemptNo = (await tx.subjectEnrollment.aggregate({ where: { studentId: user.id, subjectId: en.subjectId }, _max: { attemptNo: true } }))._max.attemptNo! + 1;
      const fresh = await tx.subjectEnrollment.create({ data: { studentId: user.id, subjectId: en.subjectId, offeringId, academicYear, term, semester, attemptNo, source: dto.mode === 'SUMMER' ? 'RETAKE_SUMMER' : 'RETAKE_OFFERING', status: 'ENROLLED', retakeOfId: en.id } });
      const rt = await tx.retakeEnrollment.create({ data: { studentId: user.id, subjectId: en.subjectId, failedEnrollmentId: en.id, mode: dto.mode, summerCourseId, offeringId, newEnrollmentId: fresh.id, status: 'REGISTERED' } });
      await tx.subjectEnrollment.update({ where: { id: en.id }, data: { status: 'RETAKE_REGISTERED' } });
      await this.common.log(tx, user, 'retake_created', 'RetakeEnrollment', rt.id, { subjectId: en.subjectId, mode: dto.mode, academicYear, term, newEnrollmentId: fresh.id }, ctx);
      return { id: rt.id, mode: dto.mode, academicYear, term, subject: en.subject.name };
    });
    return out;
  }

  // ───────────────────────── Management ─────────────────────────
  async listOfferings(q: { subjectId?: string; academicYear?: string }) {
    const rows = await this.prisma.subjectOffering.findMany({
      where: { ...(q.subjectId ? { subjectId: q.subjectId } : {}), ...(q.academicYear ? { academicYear: q.academicYear } : {}) }, orderBy: [{ startsAt: 'asc' }], take: 500,
      include: { subject: { select: { code: true, name: true } }, specialty: { select: { code: true, name: true } }, prerequisites: { include: { requiredSubject: { select: { id: true, name: true } } } } },
    });
    return rows.map((o) => ({ id: o.id, subject: o.subject, specialty: o.specialty, academicYear: o.academicYear, term: o.term, course: o.course, semester: o.semester, cycle: o.cycle, isAvailable: o.isAvailable, startsAt: isoDate(o.startsAt), enrollmentOpensAt: o.enrollmentOpensAt && isoDate(o.enrollmentOpensAt), enrollmentClosesAt: o.enrollmentClosesAt && isoDate(o.enrollmentClosesAt), prerequisites: o.prerequisites.map((p) => p.requiredSubject) }));
  }

  async createOffering(actor: Actor, dto: z.infer<typeof OfferingSchema>, ctx: AuditCtx) {
    const { prerequisiteIds, startsAt, enrollmentOpensAt, enrollmentClosesAt, ...rest } = dto;
    if (prerequisiteIds.includes(dto.subjectId)) throw new BadRequestException({ message: 'A subject cannot be its own prerequisite', code: 'PREREQ_SELF' });
    const dup = await this.prisma.subjectOffering.findFirst({ where: { subjectId: dto.subjectId, specialtyId: dto.specialtyId ?? null, academicYear: dto.academicYear, term: dto.term } });
    if (dup) throw new ConflictException({ message: 'Offering already exists', code: 'OFFERING_EXISTS' });
    const o = await this.prisma.subjectOffering.create({
      data: { ...rest, specialtyId: dto.specialtyId ?? null, startsAt: new Date(startsAt), enrollmentOpensAt: enrollmentOpensAt ? new Date(enrollmentOpensAt) : null, enrollmentClosesAt: enrollmentClosesAt ? new Date(enrollmentClosesAt) : null, prerequisites: { create: [...new Set(prerequisiteIds)].map((requiredSubjectId) => ({ requiredSubjectId })) } },
    });
    await this.common.log(null, actor, 'subject_offering_created', 'SubjectOffering', o.id, { subjectId: o.subjectId, academicYear: o.academicYear, term: o.term, course: o.course }, ctx);
    return o;
  }

  async updateOffering(actor: Actor, id: string, patch: { isAvailable?: boolean; enrollmentClosesAt?: string | null }, ctx: AuditCtx) {
    const o = await this.prisma.subjectOffering.findUnique({ where: { id } });
    if (!o) throw new NotFoundException('Offering not found');
    await this.prisma.subjectOffering.update({ where: { id }, data: { ...(patch.isAvailable !== undefined ? { isAvailable: patch.isAvailable } : {}), ...(patch.enrollmentClosesAt !== undefined ? { enrollmentClosesAt: patch.enrollmentClosesAt ? new Date(patch.enrollmentClosesAt) : null } : {}) } });
    await this.common.log(null, actor, 'subject_offering_changed', 'SubjectOffering', id, { patch }, ctx);
    return { ok: true };
  }

  async summerPeriods() {
    const rows = await this.prisma.summerRetakePeriod.findMany({ orderBy: { startDate: 'desc' }, include: { courses: { include: { subject: { select: { code: true, name: true } }, teacher: { select: { user: { select: { fullName: true } } } }, _count: { select: { retakes: true } } } } } });
    return rows.map((p) => ({ id: p.id, title: p.title, academicYear: p.academicYear, startDate: isoDate(p.startDate), endDate: isoDate(p.endDate), registrationClosesAt: p.registrationClosesAt, status: p.status, courses: p.courses.map((c) => ({ id: c.id, subject: c.subject, teacher: c.teacher?.user.fullName ?? null, teacherId: c.teacherId, schedule: c.schedule, maxStudents: c.maxStudents, minAttendance: c.minAttendance, assessment: c.assessment, registered: c._count.retakes })) }));
  }

  async createPeriod(actor: Actor, dto: z.infer<typeof SummerPeriodSchema>, ctx: AuditCtx) {
    if (dto.startDate > dto.endDate) throw new BadRequestException({ message: 'startDate must not be after endDate', code: 'WINDOW_DATES_INVALID' });
    const p = await this.prisma.summerRetakePeriod.create({ data: { title: dto.title, academicYear: dto.academicYear, startDate: new Date(dto.startDate), endDate: new Date(dto.endDate), registrationClosesAt: new Date(dto.registrationClosesAt) } });
    await this.common.log(null, actor, 'summer_retake_period_created', 'SummerRetakePeriod', p.id, { title: p.title }, ctx);
    return p;
  }

  async addCourse(actor: Actor, periodId: string, dto: z.infer<typeof SummerCourseSchema>, ctx: AuditCtx) {
    if (!(await this.prisma.summerRetakePeriod.findUnique({ where: { id: periodId } }))) throw new NotFoundException('Period not found');
    const dup = await this.prisma.summerRetakeCourse.findUnique({ where: { periodId_subjectId: { periodId, subjectId: dto.subjectId } } });
    if (dup) throw new ConflictException({ message: 'Course already exists', code: 'COURSE_EXISTS' });
    const c = await this.prisma.summerRetakeCourse.create({ data: { periodId, subjectId: dto.subjectId, teacherId: dto.teacherId ?? null, schedule: dto.schedule ?? null, maxStudents: dto.maxStudents, minAttendance: dto.minAttendance, assessment: dto.assessment } });
    await this.common.log(null, actor, 'summer_retake_course_created', 'SummerRetakeCourse', c.id, { subjectId: dto.subjectId }, ctx);
    return c;
  }

  async setPeriodStatus(actor: Actor, id: string, status: 'OPEN' | 'CLOSED', ctx: AuditCtx) {
    await this.prisma.summerRetakePeriod.update({ where: { id }, data: { status } });
    await this.common.log(null, actor, 'summer_retake_period_changed', 'SummerRetakePeriod', id, { status }, ctx);
    return { ok: true };
  }

  /** Retake: кто должен пересдавать, кто зарегистрирован */
  async adminList(q: { status?: string }, groups: string[] | null) {
    const required = await this.prisma.subjectEnrollment.findMany({
      where: { status: 'RETAKE_REQUIRED', ...(groups ? { student: { groupName: { in: groups } } } : {}) }, take: 500, orderBy: { updatedAt: 'desc' },
      include: { subject: { select: { code: true, name: true } }, student: { select: { groupName: true, user: { select: { fullName: true, loginId: true } } } } },
    });
    const registered = await this.prisma.retakeEnrollment.findMany({
      where: { ...(q.status ? { status: q.status as never } : {}), ...(groups ? { student: { groupName: { in: groups } } } : {}) }, take: 500, orderBy: { createdAt: 'desc' },
      include: { subject: { select: { code: true, name: true } }, student: { select: { groupName: true, user: { select: { fullName: true, loginId: true } } } }, summerCourse: { select: { period: { select: { title: true } } } }, offering: { select: { academicYear: true, term: true, course: true } } },
    });
    return {
      required: required.map((e) => ({ enrollmentId: e.id, subject: e.subject, student: { fullName: e.student.user.fullName, loginId: e.student.user.loginId, groupName: e.student.groupName }, since: e.updatedAt })),
      registered: registered.map((r) => ({ id: r.id, mode: r.mode, status: r.status, subject: r.subject, student: { fullName: r.student.user.fullName, loginId: r.student.user.loginId, groupName: r.student.groupName }, summer: r.summerCourse?.period.title ?? null, offering: r.offering, createdAt: r.createdAt })),
    };
  }
}
