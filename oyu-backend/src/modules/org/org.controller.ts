import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { OrgScopeService } from '../../common/rbac/org-scope.service';
import { RequirePermission } from '../../common/rbac/require-permission.decorator';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/** Оргструктура: факультеты → кафедры → специальности → группы, учебные планы специальностей */
@Controller('admin/org')
export class OrgController {
  constructor(private readonly prisma: PrismaService, private readonly org: OrgScopeService) {}

  @Get()
  @RequirePermission('groups.view')
  async tree(@CurrentUser() u: CurrentUserData) {
    const scope = await this.org.forUser(u);
    const [faculties, students, leaders] = await Promise.all([
      this.prisma.faculty.findMany({
        orderBy: { sortOrder: 'asc' },
        include: { departments: { orderBy: { name: 'asc' }, include: { specialties: { orderBy: { code: 'asc' }, include: { groups: { orderBy: { name: 'asc' }, include: { tutor: { select: { id: true, fullName: true, loginId: true } } } }, _count: { select: { curriculum: true } } } } } } },
      }),
      this.prisma.student.groupBy({ by: ['groupName'], where: { user: { status: 'ACTIVE' } }, _count: { _all: true } }),
      this.prisma.user.findMany({ where: { position: { not: null }, status: 'ACTIVE' }, select: { id: true, fullName: true, loginId: true, position: true, facultyId: true, departmentId: true } }),
    ]);
    const cnt = new Map(students.map((s) => [s.groupName, s._count._all]));
    const inScope = (g: string) => !scope.groups || scope.groups.includes(g);
    return {
      scope: { kind: scope.kind, position: scope.position, label: scope.label },
      leaders: leaders.filter((l) => l.position === 'RECTOR' || l.position === 'VICE_RECTOR').sort((a, b) => (a.position === 'RECTOR' ? -1 : 1) - (b.position === 'RECTOR' ? -1 : 1)).map((l) => ({ id: l.id, fullName: l.fullName, loginId: l.loginId, position: l.position })),
      faculties: faculties.map((f) => ({
        id: f.id, name: f.name, shortName: f.shortName,
        dean: leaders.find((l) => l.position === 'DEAN' && l.facultyId === f.id) ?? null,
        departments: f.departments.map((d) => ({
          id: d.id, name: d.name,
          head: leaders.find((l) => l.position === 'HEAD_OF_DEPARTMENT' && l.departmentId === d.id) ?? null,
          specialties: d.specialties.map((s) => ({
            id: s.id, code: s.code, name: s.name, level: s.level, durationYears: s.durationYears, totalCredits: s.totalCredits, curriculumItems: s._count.curriculum,
            groups: s.groups.map((g) => ({ id: g.id, name: g.name, course: g.course, level: g.level, students: cnt.get(g.name) ?? 0, tutor: g.tutor, inScope: inScope(g.name) })),
          })),
        })),
      })),
    };
  }

  /** Учебный план специальности по семестрам + прогресс по кредитам */
  @Get('specialties/:id/curriculum')
  @RequirePermission('subjects.view')
  async curriculum(@Param('id') id: string) {
    const s = await this.prisma.specialty.findUnique({
      where: { id },
      include: { department: { include: { faculty: true } }, curriculum: { orderBy: [{ semester: 'asc' }, { kind: 'asc' }], include: { subject: { select: { id: true, code: true, name: true, color: true } } } } },
    });
    if (!s) throw new NotFoundException('Specialty not found');
    // альтернативы выборных предметов (одна electiveGroup) считаются один раз
    const credit = (list: typeof s.curriculum) => { const seen = new Set<string>(); return list.reduce((a, c) => { if (c.electiveGroup) { if (seen.has(c.electiveGroup)) return a; seen.add(c.electiveGroup); } return a + c.credits; }, 0); };
    const semesters = new Map<number, typeof s.curriculum>();
    for (const c of s.curriculum) (semesters.get(c.semester) ?? semesters.set(c.semester, []).get(c.semester)!).push(c);
    return {
      specialty: { id: s.id, code: s.code, name: s.name, level: s.level, durationYears: s.durationYears, totalCredits: s.totalCredits, department: s.department.name, faculty: s.department.faculty.name },
      plannedCredits: credit(s.curriculum),
      semesters: Array.from(semesters.entries()).sort((a, b) => a[0] - b[0]).map(([n, items]) => ({
        semester: n, credits: credit(items),
        items: items.map((c) => ({ subject: c.subject, credits: c.credits, kind: c.kind, control: c.control, electiveGroup: c.electiveGroup })),
      })),
    };
  }
}