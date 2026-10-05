import { ForbiddenException, Global, Injectable, Module } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { OrgScopeService } from '../../common/rbac/org-scope.service';

export const CURRENT_PERIOD = { academicYear: '2026-2027', term: 'FALL' as const };

export interface TeachingPair {
  subjectId: string;
  groupName: string;
}

export interface TeacherScope {
  pairs: TeachingPair[];
  subjectIds: string[];
  groups: string[];
}

/**
 * Единственный источник правды по доступу преподавателя.
 * Преподаватель "ведёт" пару (предмет, группа), если в расписании есть слот с его teacherId.
 * Все teacher-операции над оценками, посещаемостью, заданиями, материалами и заявками
 * обязаны проходить через этот сервис — скрытия кнопок на фронте недостаточно.
 */
@Injectable()
export class TeacherAccessService {
  constructor(private readonly prisma: PrismaService, private readonly org: OrgScopeService) {}

  async requireTeacher(userId: string) {
    const teacher = await this.prisma.teacher.findUnique({ where: { userId } });
    if (!teacher) throw new ForbiddenException('Only teachers have access');
    return teacher;
  }

  async scope(userId: string): Promise<TeacherScope> {
    const teacher = await this.prisma.teacher.findUnique({ where: { userId }, select: { userId: true } });
    // Руководство с областью (декан / зав. кафедрой / тьютор): «закреплённые» пары = все занятия групп своей области
    let where: { teacherId?: string; groupName?: { in: string[] } } = { teacherId: userId };
    if (!teacher) {
      const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
      const os = u ? await this.org.forUser(u) : null;
      if (!os || !os.groups) throw new ForbiddenException('Only teachers have access');
      where = { groupName: { in: os.groups } };
    }
    const slots = await this.prisma.scheduleSlot.findMany({
      where,
      distinct: ['subjectId', 'groupName'],
      select: { subjectId: true, groupName: true },
    });
    return {
      pairs: slots,
      subjectIds: Array.from(new Set(slots.map((s) => s.subjectId))),
      groups: Array.from(new Set(slots.map((s) => s.groupName))),
    };
  }

  groupsForSubject(scope: TeacherScope, subjectId: string): string[] {
    return scope.pairs.filter((p) => p.subjectId === subjectId).map((p) => p.groupName);
  }

  async assertCanTeach(userId: string, subjectId: string, groupName: string) {
    const scope = await this.scope(userId);
    if (!scope.pairs.some((p) => p.subjectId === subjectId && p.groupName === groupName)) {
      throw new ForbiddenException('You do not teach this subject in this group');
    }
    return scope;
  }

  async assertCanTeachSubject(userId: string, subjectId: string) {
    const scope = await this.scope(userId);
    if (!scope.subjectIds.includes(subjectId)) {
      throw new ForbiddenException('You do not teach this subject');
    }
    return scope;
  }
}

@Global()
@Module({
  providers: [TeacherAccessService],
  exports: [TeacherAccessService],
})
export class TeacherAccessModule {}
