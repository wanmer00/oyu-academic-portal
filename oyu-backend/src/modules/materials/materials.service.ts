import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { TeacherAccessService } from '../teachers/teacher-access.service';
import { CreateMaterialDto, UpdateMaterialDto } from './dto';

@Injectable()
export class MaterialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeacherAccessService,
  ) {}

  private async subjectIdsForStudent(userId: string) {
    const student = await this.prisma.student.findUnique({ where: { userId } });
    if (!student) throw new ForbiddenException('Only students');
    const slots = await this.prisma.scheduleSlot.findMany({
      where: { groupName: student.groupName },
      distinct: ['subjectId'],
      select: { subjectId: true },
    });
    return slots.map((s) => s.subjectId);
  }

  async listForStudent(userId: string, subjectCode?: string) {
    const subjectIds = await this.subjectIdsForStudent(userId);
    const where: any = { subjectId: { in: subjectIds } };
    if (subjectCode) {
      const subj = await this.prisma.subject.findUnique({ where: { code: subjectCode } });
      if (!subj) throw new NotFoundException('Subject not found');
      if (!subjectIds.includes(subj.id)) throw new ForbiddenException('Subject not for your group');
      where.subjectId = subj.id;
    }
    return this.prisma.material.findMany({
      where,
      include: {
        subject: { select: { id: true, code: true, name: true, color: true } },
        teacher: { include: { user: { select: { fullName: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Материалы по предметам, которые ведёт преподаватель (свои — можно менять, чужие — только смотреть) */
  async listForTeacher(userId: string) {
    const scope = await this.access.scope(userId);
    const items = await this.prisma.material.findMany({
      where: { subjectId: { in: scope.subjectIds } },
      include: {
        subject: { select: { id: true, code: true, name: true, color: true } },
        teacher: { include: { user: { select: { fullName: true } } } },
        assignment: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return items.map((m) => ({
      id: m.id, title: m.title, type: m.type, url: m.url, fileName: m.fileName, createdAt: m.createdAt,
      subject: m.subject, assignment: m.assignment,
      mine: m.teacherId === userId,
      author: m.teacher?.user?.fullName ?? null,
    }));
  }

  private async checkAssignmentLink(teacherId: string, assignmentId: string, subjectId: string) {
    const a = await this.prisma.assignment.findUnique({ where: { id: assignmentId } });
    if (!a || a.teacherId !== teacherId) throw new ForbiddenException('Assignment is not yours');
    if (a.subjectId !== subjectId) throw new BadRequestException('Assignment belongs to another subject');
  }

  async update(
    teacherUserId: string,
    id: string,
    dto: UpdateMaterialDto,
    audit: { ip?: string | null; userAgent?: string | null },
  ) {
    await this.access.requireTeacher(teacherUserId);
    const m = await this.prisma.material.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Material not found');
    if (m.teacherId !== teacherUserId) throw new ForbiddenException('Not your material');
    await this.access.assertCanTeachSubject(teacherUserId, m.subjectId);
    if (dto.assignmentId) await this.checkAssignmentLink(teacherUserId, dto.assignmentId, m.subjectId);

    const nextUrl = dto.url !== undefined ? dto.url : m.url;
    const nextFile = dto.fileName !== undefined ? dto.fileName : m.fileName;
    if (!nextUrl && !nextFile) throw new BadRequestException('url or fileName required');

    const updated = await this.prisma.material.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.url !== undefined && { url: dto.url }),
        ...(dto.fileName !== undefined && { fileName: dto.fileName }),
        ...(dto.assignmentId !== undefined && { assignmentId: dto.assignmentId }),
      },
    });
    await this.prisma.auditLog.create({
      data: {
        actorId: teacherUserId, action: 'material.update', targetType: 'Material', targetId: id,
        diff: { fields: Object.keys(dto) }, ip: audit.ip ?? null, userAgent: audit.userAgent ?? null,
      },
    });
    return updated;
  }

  async create(
    teacherUserId: string,
    dto: CreateMaterialDto,
    audit: { ip?: string | null; userAgent?: string | null },
  ) {
    await this.access.requireTeacher(teacherUserId);

    const subject = await this.prisma.subject.findUnique({ where: { code: dto.subjectCode } });
    if (!subject) throw new NotFoundException('Subject not found');
    await this.access.assertCanTeachSubject(teacherUserId, subject.id);
    if (dto.assignmentId) await this.checkAssignmentLink(teacherUserId, dto.assignmentId, subject.id);

    const created = await this.prisma.material.create({
      data: {
        subjectId: subject.id,
        teacherId: teacherUserId,
        title: dto.title,
        type: dto.type,
        url: dto.url ?? null,
        fileName: dto.fileName ?? null,
        assignmentId: dto.assignmentId ?? null,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: teacherUserId,
        action: 'material.create',
        targetType: 'Material',
        targetId: created.id,
        diff: { subjectCode: dto.subjectCode, title: dto.title, type: dto.type },
        ip: audit.ip ?? null,
        userAgent: audit.userAgent ?? null,
      },
    });
    return created;
  }

  async delete(
    teacherUserId: string,
    id: string,
    audit: { ip?: string | null; userAgent?: string | null },
  ) {
    const m = await this.prisma.material.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Material not found');
    if (m.teacherId !== teacherUserId) throw new ForbiddenException('Not your material');
    await this.prisma.material.delete({ where: { id } });
    await this.prisma.auditLog.create({
      data: {
        actorId: teacherUserId,
        action: 'material.delete',
        targetType: 'Material',
        targetId: id,
        ip: audit.ip ?? null,
        userAgent: audit.userAgent ?? null,
      },
    });
    return { ok: true };
  }
}
