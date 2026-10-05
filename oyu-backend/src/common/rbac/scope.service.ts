import { BadRequestException, ForbiddenException, Global, Injectable, Module, NotFoundException } from '@nestjs/common';
import { PermissionScope } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { TeacherAccessService } from '../../modules/teachers/teacher-access.service';
import { Grant } from './permissions.service';

export interface Actor {
  id: string;
  role: import('@prisma/client').Role;
}

/** Применение scope к конкретному студенту: OWN / ASSIGNED / ALL */
@Injectable()
export class ScopeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeacherAccessService,
  ) {}

  /**
   * Возвращает id студента, к данным которого у актора есть доступ по scope права.
   * OWN — всегда сам; ASSIGNED — студенты своих групп; ALL — любой.
   */
  async resolveStudentId(actor: Actor, grant: Grant, requested?: string): Promise<string> {
    switch (grant.scope) {
      case PermissionScope.OWN:
        if (requested && requested !== actor.id) throw new ForbiddenException({ message: 'You can only access your own data', code: 'SCOPE_DENIED' });
        return actor.id;
      case PermissionScope.ASSIGNED: {
        if (!requested) throw new BadRequestException({ message: 'studentId is required', code: 'STUDENT_REQUIRED' });
        const st = await this.prisma.student.findUnique({ where: { userId: requested }, select: { groupName: true } });
        if (!st) throw new NotFoundException('Student not found');
        const scope = await this.access.scope(actor.id);
        if (!scope.groups.includes(st.groupName)) throw new ForbiddenException({ message: 'This student is not in your groups', code: 'SCOPE_DENIED' });
        return requested;
      }
      default: {
        if (!requested) throw new BadRequestException({ message: 'studentId is required', code: 'STUDENT_REQUIRED' });
        const st = await this.prisma.student.findUnique({ where: { userId: requested }, select: { userId: true } });
        if (!st) throw new NotFoundException('Student not found');
        return requested;
      }
    }
  }
}

@Global()
@Module({ providers: [ScopeService], exports: [ScopeService] })
export class ScopeModule {}

export const narrower = (a: PermissionScope, b: PermissionScope): PermissionScope => {
  const rank: Record<PermissionScope, number> = { OWN: 0, ASSIGNED: 1, ALL: 2 };
  return rank[a] <= rank[b] ? a : b;
};
