import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AssignmentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { TeacherAccessService } from '../teachers/teacher-access.service';
import { CreateAssignmentDto, GradeSubmissionDto, SubmitDto, UpdateAssignmentDto } from './dto';
import { NotificationsService } from '../notifications/notifications.service';

interface AuditCtx { ip?: string | null; userAgent?: string | null; }

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly access: TeacherAccessService,
  ) {}

  // ───── Helpers ─────
  private async requireStudent(userId: string) {
    const s = await this.prisma.student.findUnique({ where: { userId } });
    if (!s) throw new ForbiddenException('Only students');
    return s;
  }

  private async requireTeacher(userId: string) {
    const t = await this.prisma.teacher.findUnique({ where: { userId } });
    if (!t) throw new ForbiddenException('Only teachers');
    return t;
  }

  private async studentSubjectIds(groupName: string): Promise<string[]> {
    const slots = await this.prisma.scheduleSlot.findMany({
      where: { groupName },
      distinct: ['subjectId'],
      select: { subjectId: true },
    });
    return slots.map((s) => s.subjectId);
  }

  private serializeAssignment(a: any, submission?: any) {
    return {
      id: a.id,
      title: a.title,
      description: a.description,
      dueDate: a.dueDate.toISOString(),
      maxGrade: Number(a.maxGrade),
      createdAt: a.createdAt.toISOString(),
      subject: a.subject,
      teacher: a.teacher?.user
        ? { fullName: a.teacher.user.fullName, loginId: a.teacher.user.loginId }
        : null,
      submission: submission
        ? {
            id: submission.id,
            status: submission.status,
            submittedAt: submission.submittedAt ? submission.submittedAt.toISOString() : null,
            grade: submission.grade == null ? null : Number(submission.grade),
            feedback: submission.feedback,
            fileName: submission.fileName,
            studentNotes: submission.studentNotes,
            gradedAt: submission.gradedAt ? submission.gradedAt.toISOString() : null,
          }
        : null,
    };
  }

  // ───── STUDENT ─────
  async getForStudent(userId: string) {
    const student = await this.requireStudent(userId);
    const subjectIds = await this.studentSubjectIds(student.groupName);
    const assignments = await this.prisma.assignment.findMany({
      where: { subjectId: { in: subjectIds }, status: { not: 'DRAFT' } }, // черновики студентам не видны
      include: {
        subject: { select: { id: true, code: true, name: true, color: true } },
        teacher: { include: { user: { select: { fullName: true, loginId: true } } } },
        submissions: { where: { studentId: student.userId } },
      },
      orderBy: { dueDate: 'asc' },
    });
    return assignments.map((a) => this.serializeAssignment(a, a.submissions[0]));
  }

  async getOneForStudent(userId: string, assignmentId: string) {
    const student = await this.requireStudent(userId);
    const a = await this.prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: {
        subject: { select: { id: true, code: true, name: true, color: true } },
        teacher: { include: { user: { select: { fullName: true, loginId: true } } } },
        submissions: { where: { studentId: student.userId } },
      },
    });
    if (!a || a.status === 'DRAFT') throw new NotFoundException('Assignment not found');
    const subjectIds = await this.studentSubjectIds(student.groupName);
    if (!subjectIds.includes(a.subjectId)) {
      throw new ForbiddenException('This assignment is not for your group');
    }
    return this.serializeAssignment(a, a.submissions[0]);
  }

  async submit(userId: string, assignmentId: string, dto: SubmitDto, audit: AuditCtx) {
    const student = await this.requireStudent(userId);
    const a = await this.prisma.assignment.findUnique({ where: { id: assignmentId } });
    if (!a || a.status === 'DRAFT') throw new NotFoundException('Assignment not found');

    const subjectIds = await this.studentSubjectIds(student.groupName);
    if (!subjectIds.includes(a.subjectId)) {
      throw new ForbiddenException('This assignment is not for your group');
    }
    if (a.status === 'CLOSED') throw new BadRequestException('Assignment is closed for submissions');

    const isLate = new Date() > a.dueDate;
    const status = isLate ? 'LATE' : 'SUBMITTED';

    const sub = await this.prisma.submission.upsert({
      where: { assignmentId_studentId: { assignmentId, studentId: student.userId } },
      update: {
        status,
        submittedAt: new Date(),
        fileName: dto.fileName ?? null,
        studentNotes: dto.notes ?? null,
      },
      create: {
        assignmentId,
        studentId: student.userId,
        status,
        submittedAt: new Date(),
        fileName: dto.fileName ?? null,
        studentNotes: dto.notes ?? null,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: userId,
        action: 'submission.submit',
        targetType: 'Submission',
        targetId: sub.id,
        diff: { assignmentId, late: isLate },
        ip: audit.ip ?? null,
        userAgent: audit.userAgent ?? null,
      },
    });

    return sub;
  }

  // ───── TEACHER ─────
  async getForTeacher(teacherId: string) {
    await this.requireTeacher(teacherId);
    const items = await this.prisma.assignment.findMany({
      where: { teacherId },
      include: {
        subject: { select: { id: true, code: true, name: true, color: true } },
        submissions: true,
        materials: { select: { id: true, title: true, type: true, url: true } },
      },
      orderBy: { dueDate: 'desc' },
    });
    return items.map((a) => ({
      id: a.id,
      title: a.title,
      description: a.description,
      dueDate: a.dueDate.toISOString(),
      maxGrade: Number(a.maxGrade),
      status: a.status,
      publishedAt: a.publishedAt ? a.publishedAt.toISOString() : null,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
      subject: a.subject,
      materials: a.materials,
      submissionsCount: a.submissions.filter((s) => s.status !== 'PENDING').length,
      gradedCount: a.submissions.filter((s) => s.status === 'GRADED').length,
      pendingCount: a.submissions.filter((s) => s.status === 'SUBMITTED' || s.status === 'LATE').length,
    }));
  }

  private async ownAssignment(teacherId: string, id: string) {
    await this.requireTeacher(teacherId);
    const a = await this.prisma.assignment.findUnique({ where: { id }, include: { subject: true, submissions: { select: { status: true } } } });
    if (!a) throw new NotFoundException('Assignment not found');
    if (a.teacherId !== teacherId) throw new ForbiddenException('Not your assignment');
    return a;
  }

  private async notifyPublished(a: { id: string; title: string; dueDate: Date; subjectId: string }, subjectName: string) {
    const recipients = await this.notifications.studentIdsBySubject(a.subjectId);
    const dueDay = a.dueDate.toISOString().slice(0, 10);
    await this.notifications.notify(recipients, {
      type: 'ASSIGNMENT',
      title: { az: 'Yeni tapşırıq', ru: 'Новое задание', en: 'New assignment' },
      message: {
        az: `${subjectName}: ${a.title} (son tarix: ${dueDay})`,
        ru: `${subjectName}: ${a.title} (срок: ${dueDay})`,
        en: `${subjectName}: ${a.title} (due: ${dueDay})`,
      },
      link: 'assignments',
    });
  }

  async update(teacherId: string, id: string, dto: UpdateAssignmentDto, audit: AuditCtx) {
    const a = await this.ownAssignment(teacherId, id);
    const data: Prisma.AssignmentUpdateInput = {};
    const changed: string[] = [];
    if (dto.title !== undefined) { data.title = dto.title; changed.push('title'); }
    if (dto.description !== undefined) { data.description = dto.description; changed.push('description'); }
    if (dto.dueDate !== undefined) {
      const due = new Date(dto.dueDate);
      if (Number.isNaN(due.getTime())) throw new BadRequestException('Invalid dueDate');
      data.dueDate = due; changed.push('dueDate');
    }
    if (dto.maxGrade !== undefined && dto.maxGrade !== Number(a.maxGrade)) {
      if (a.submissions.some((s) => s.status === 'GRADED')) {
        throw new BadRequestException('Cannot change max grade after submissions were graded');
      }
      data.maxGrade = dto.maxGrade; changed.push('maxGrade');
    }
    if (!changed.length) return { id, unchanged: true };
    const updated = await this.prisma.assignment.update({ where: { id }, data });
    await this.prisma.auditLog.create({
      data: { actorId: teacherId, action: 'assignment.update', targetType: 'Assignment', targetId: id, diff: { fields: changed }, ip: audit.ip ?? null, userAgent: audit.userAgent ?? null },
    });
    // Срок изменён у опубликованного задания — предупреждаем студентов
    if (changed.includes('dueDate') && a.status === 'PUBLISHED') {
      const recipients = await this.notifications.studentIdsBySubject(a.subjectId);
      const dueDay = updated.dueDate.toISOString().slice(0, 10);
      await this.notifications.notify(recipients, {
        type: 'ASSIGNMENT',
        title: { az: 'Tapşırıq müddəti dəyişdi', ru: 'Срок задания изменён', en: 'Assignment deadline changed' },
        message: { az: `${updated.title}: ${dueDay}`, ru: `${updated.title}: ${dueDay}`, en: `${updated.title}: ${dueDay}` },
        link: 'assignments',
      });
    }
    return updated;
  }

  async setStatus(teacherId: string, id: string, status: AssignmentStatus, audit: AuditCtx) {
    const a = await this.ownAssignment(teacherId, id);
    if (a.status === status) return { id, status, unchanged: true };
    const allowed: Record<AssignmentStatus, AssignmentStatus[]> = {
      DRAFT: ['PUBLISHED'],
      PUBLISHED: ['CLOSED', 'DRAFT'],
      CLOSED: ['PUBLISHED'],
    };
    if (!allowed[a.status].includes(status)) throw new BadRequestException(`Cannot change status ${a.status} → ${status}`);
    if (status === 'DRAFT' && a.submissions.some((s) => s.status !== 'PENDING')) {
      throw new BadRequestException('Cannot unpublish an assignment that already has submissions');
    }
    const updated = await this.prisma.assignment.update({
      where: { id },
      data: { status, ...(status === 'PUBLISHED' && !a.publishedAt ? { publishedAt: new Date() } : {}) },
    });
    await this.prisma.auditLog.create({
      data: { actorId: teacherId, action: `assignment.${status.toLowerCase()}`, targetType: 'Assignment', targetId: id, diff: { from: a.status, to: status }, ip: audit.ip ?? null, userAgent: audit.userAgent ?? null },
    });
    if (status === 'PUBLISHED' && a.status === 'DRAFT') await this.notifyPublished(updated, a.subject.name);
    return updated;
  }

  async create(teacherId: string, dto: CreateAssignmentDto, audit: AuditCtx) {
    await this.requireTeacher(teacherId);
    const subject = await this.prisma.subject.findUnique({ where: { code: dto.subjectCode } });
    if (!subject) throw new NotFoundException('Subject not found');
    await this.access.assertCanTeachSubject(teacherId, subject.id);

    const due = new Date(dto.dueDate);
    if (Number.isNaN(due.getTime())) throw new BadRequestException('Invalid dueDate');

    const created = await this.prisma.assignment.create({
      data: {
        subjectId: subject.id,
        teacherId,
        title: dto.title,
        description: dto.description,
        dueDate: due,
        maxGrade: dto.maxGrade,
        status: dto.publish ? 'PUBLISHED' : 'DRAFT',
        publishedAt: dto.publish ? new Date() : null,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: teacherId,
        action: 'assignment.create',
        targetType: 'Assignment',
        targetId: created.id,
        diff: { subjectCode: dto.subjectCode, title: dto.title },
        ip: audit.ip ?? null,
        userAgent: audit.userAgent ?? null,
      },
    });

    if (created.status === 'PUBLISHED') await this.notifyPublished(created, subject.name);
    return created;
  }

  async submissionsFor(teacherId: string, assignmentId: string) {
    await this.requireTeacher(teacherId);
    const a = await this.prisma.assignment.findUnique({ where: { id: assignmentId } });
    if (!a) throw new NotFoundException('Assignment not found');
    if (a.teacherId !== teacherId) throw new ForbiddenException('Not your assignment');

    const subs = await this.prisma.submission.findMany({
      where: { assignmentId },
      include: { student: { include: { user: { select: { fullName: true, loginId: true } } } } },
      orderBy: { submittedAt: 'desc' },
    });

    return subs.map((s) => ({
      id: s.id,
      status: s.status,
      submittedAt: s.submittedAt ? s.submittedAt.toISOString() : null,
      grade: s.grade == null ? null : Number(s.grade),
      feedback: s.feedback,
      fileName: s.fileName,
      studentNotes: s.studentNotes,
      gradedAt: s.gradedAt ? s.gradedAt.toISOString() : null,
      student: {
        userId: s.student.userId,
        loginId: s.student.user.loginId,
        fullName: s.student.user.fullName,
        groupName: s.student.groupName,
      },
    }));
  }

  async gradeSubmission(
    teacherId: string,
    submissionId: string,
    dto: GradeSubmissionDto,
    audit: AuditCtx,
  ) {
    await this.requireTeacher(teacherId);
    const sub = await this.prisma.submission.findUnique({
      where: { id: submissionId },
      include: { assignment: true },
    });
    if (!sub) throw new NotFoundException('Submission not found');
    if (sub.assignment.teacherId !== teacherId) {
      throw new ForbiddenException('Not your assignment');
    }
    if (dto.grade > Number(sub.assignment.maxGrade)) {
      throw new BadRequestException(`Grade must not exceed assignment max (${Number(sub.assignment.maxGrade)})`);
    }

    const updated = await this.prisma.submission.update({
      where: { id: submissionId },
      data: {
        grade: dto.grade,
        feedback: dto.feedback ?? null,
        status: 'GRADED',
        gradedAt: new Date(),
        gradedBy: teacherId,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: teacherId,
        action: 'submission.grade',
        targetType: 'Submission',
        targetId: submissionId,
        diff: { grade: dto.grade, assignmentId: sub.assignmentId },
        ip: audit.ip ?? null,
        userAgent: audit.userAgent ?? null,
      },
    });

    await this.notifications.notify([sub.studentId], {
      type: 'ASSIGNMENT',
      title: { az: 'Tapşırıq qiymətləndirildi', ru: 'Задание проверено', en: 'Assignment graded' },
      message: {
        az: `${sub.assignment.title}: ${dto.grade}/${Number(sub.assignment.maxGrade)}`,
        ru: `${sub.assignment.title}: ${dto.grade}/${Number(sub.assignment.maxGrade)}`,
        en: `${sub.assignment.title}: ${dto.grade}/${Number(sub.assignment.maxGrade)}`,
      },
      link: 'assignments',
    });
    return updated;
  }
}
