import { Global, Injectable, Module } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/** Должности руководства (роль ADMIN). Область данных определяется должностью и привязкой к оргструктуре. */
export const POSITIONS = ['RECTOR', 'VICE_RECTOR', 'DEAN', 'HEAD_OF_DEPARTMENT', 'TUTOR'] as const;
export type Position = (typeof POSITIONS)[number];

export interface OrgScope {
  /** null — без ограничений (ректор, проректор, ADMIN без должности, SUPER_ADMIN) */
  groups: string[] | null;
  kind: 'ALL' | 'FACULTY' | 'DEPARTMENT' | 'GROUPS';
  position: Position | null;
  label: string | null;
  facultyId: string | null;
  departmentId: string | null;
}

const ALL: OrgScope = { groups: null, kind: 'ALL', position: null, label: null, facultyId: null, departmentId: null };
const TTL = 30_000;

/**
 * Область данных руководства по оргструктуре:
 *  DEAN — группы специальностей своего факультета; HEAD_OF_DEPARTMENT — своей кафедры; TUTOR — закреплённые группы.
 * Применяется поверх прав RBAC (PermissionsGuard сужает scope ALL → ASSIGNED, списки Admin Panel фильтруются по группам).
 */
@Injectable()
export class OrgScopeService {
  private cache = new Map<string, { at: number; v: OrgScope }>();
  constructor(private readonly prisma: PrismaService) {}

  invalidate() { this.cache.clear(); }

  async forUser(user: { id: string; role: Role }): Promise<OrgScope> {
    if (user.role !== Role.ADMIN) return ALL;
    const hit = this.cache.get(user.id);
    if (hit && Date.now() - hit.at < TTL) return hit.v;
    const v = await this.compute(user.id);
    this.cache.set(user.id, { at: Date.now(), v });
    return v;
  }

  private async compute(userId: string): Promise<OrgScope> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { position: true, facultyId: true, departmentId: true, faculty: { select: { name: true } }, department: { select: { name: true } }, tutorGroups: { select: { name: true } } },
    });
    const position = (u?.position as Position | null) ?? null;
    if (!u || !position || position === 'RECTOR' || position === 'VICE_RECTOR') return { ...ALL, position };
    if (position === 'DEAN' && u.facultyId) {
      const groups = await this.prisma.academicGroup.findMany({ where: { specialty: { department: { facultyId: u.facultyId } } }, select: { name: true } });
      return { groups: groups.map((g) => g.name), kind: 'FACULTY', position, label: u.faculty?.name ?? null, facultyId: u.facultyId, departmentId: null };
    }
    if (position === 'HEAD_OF_DEPARTMENT' && u.departmentId) {
      const groups = await this.prisma.academicGroup.findMany({ where: { specialty: { departmentId: u.departmentId } }, select: { name: true } });
      return { groups: groups.map((g) => g.name), kind: 'DEPARTMENT', position, label: u.department?.name ?? null, facultyId: null, departmentId: u.departmentId };
    }
    if (position === 'TUTOR') {
      const groups = u.tutorGroups.map((g) => g.name).sort();
      return { groups, kind: 'GROUPS', position, label: groups.join(', '), facultyId: null, departmentId: null };
    }
    // должность без привязки — без доступа к данным по группам (безопаснее, чем «всё»)
    return { groups: [], kind: 'GROUPS', position, label: null, facultyId: null, departmentId: null };
  }
}

@Global()
@Module({ providers: [OrgScopeService], exports: [OrgScopeService] })
export class OrgScopeModule {}
