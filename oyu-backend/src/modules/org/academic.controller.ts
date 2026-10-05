import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { z } from 'zod';
import { AuditTrailService } from '../../common/audit/audit-trail.service';
import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { OrgScopeService } from '../../common/rbac/org-scope.service';
import { RequirePermission } from '../../common/rbac/require-permission.decorator';
import { AcademicService, PROJECT_STATUSES, PROJECT_TYPES } from './academic.service';

const ALL = { requireAll: true } as const;
const ProjectsQuery = z.object({ type: z.enum(PROJECT_TYPES).optional(), status: z.enum(PROJECT_STATUSES).optional(), groupName: z.string().max(50).optional() });
const ProjectPatch = z.object({
  title: z.string().trim().min(3).max(200).optional(), organization: z.string().trim().max(200).nullable().optional(), status: z.enum(PROJECT_STATUSES).optional(),
  grade: z.number().min(0).max(100).nullable().optional(), note: z.string().trim().max(1000).nullable().optional(), supervisorId: z.string().max(40).nullable().optional(),
}).strict();
const ctxOf = (req: Request) => ({ ip: req.ip ?? null, userAgent: (req.headers['user-agent'] as string) ?? null });

/** Академический прогресс, задолженности, выборные предметы, практика и выпускные работы (бакалавриат) */
@Controller()
export class AcademicController {
  constructor(private readonly academic: AcademicService, private readonly org: OrgScopeService, private readonly audit: AuditTrailService) {}

  // ── студент: своё ──
  @Get('me/progress')
  @RequirePermission('grades.view')
  myProgress(@CurrentUser() u: CurrentUserData) {
    if (!u.student) throw new ForbiddenException('Only students have an academic progress');
    return this.academic.progress(u.id);
  }

  @Post('me/electives/:itemId')
  @RequirePermission('grades.view')
  async choose(@CurrentUser() u: CurrentUserData, @Param('itemId') itemId: string, @Req() req: Request) {
    const r = await this.academic.chooseElective(u.id, itemId);
    await this.audit.record({ actorId: u.id, action: 'elective.choose', targetType: 'CurriculumItem', targetId: itemId }, ctxOf(req));
    return r;
  }

  @Get('me/projects')
  @RequirePermission('grades.view')
  myProjects(@CurrentUser() u: CurrentUserData) { return this.academic.myProjects(u.id); }

  // ── руководство: в пределах своей области ──
  @Get('admin/students/:id/progress')
  @RequirePermission('students.view', ALL)
  async studentProgress(@CurrentUser() u: CurrentUserData, @Param('id') id: string) {
    const p = await this.academic.progress(id);
    const g = (await this.org.forUser(u)).groups;
    if (g && !g.includes(p.student.groupName)) throw new ForbiddenException({ message: 'Outside your area of responsibility', code: 'ORG_SCOPE_DENIED' });
    return p;
  }

  @Get('admin/debts')
  @RequirePermission('students.view', ALL)
  async debts(@CurrentUser() u: CurrentUserData) { return this.academic.debts((await this.org.forUser(u)).groups); }

  @Get('admin/projects')
  @RequirePermission('students.view', ALL)
  async projects(@CurrentUser() u: CurrentUserData, @Query(new ZodValidationPipe(ProjectsQuery)) q: z.infer<typeof ProjectsQuery>) {
    return this.academic.projects(q, (await this.org.forUser(u)).groups);
  }

  @Patch('admin/projects/:id')
  @RequirePermission('students.update', ALL)
  async updateProject(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Body(new ZodValidationPipe(ProjectPatch)) dto: z.infer<typeof ProjectPatch>, @Req() req: Request) {
    const r = await this.academic.updateProject(id, dto, (await this.org.forUser(u)).groups);
    await this.audit.record({ actorId: u.id, action: 'project.update', targetType: 'StudentProject', targetId: id, old: r.before, new: dto }, ctxOf(req));
    return r.after;
  }
}