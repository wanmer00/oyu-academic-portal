import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { z } from 'zod';
import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { RequirePermission } from '../../common/rbac/require-permission.decorator';
import { AdminDirectoryService } from './admin-directory.service';
import { OrgScopeService } from '../../common/rbac/org-scope.service';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  AssignTeacherSchema, CreateStudentSchema, CreateSubjectSchema, CreateTeacherSchema, OptionalReasonSchema, RenameGroupSchema,
  StudentsQuerySchema, SubjectsQuerySchema, TeachersQuerySchema, UpdateStudentSchema, UpdateSubjectSchema, UpdateTeacherSchema,
} from './admin-people.dto';

type Q<T extends z.ZodTypeAny> = z.infer<T>;
const ctxOf = (req: Request) => ({ ip: req.ip ?? null, userAgent: (req.headers['user-agent'] as string) ?? null });
const idPipe = new ZodValidationPipe(z.string().min(1).max(40));
const namePipe = new ZodValidationPipe(z.string().min(1).max(50));
const ALL = { requireAll: true } as const;

/** Admin Panel → Students / Teachers / Groups / Subjects */
@Controller('admin')
export class AdminDirectoryController {
  constructor(private readonly dir: AdminDirectoryService, private readonly org: OrgScopeService, private readonly prisma: PrismaService) {}
  private async groupsOf(u: CurrentUserData) { return (await this.org.forUser(u)).groups; }
  private async assertGroup(u: CurrentUserData, group: string) { const g = await this.groupsOf(u); if (g && !g.includes(group)) throw new ForbiddenException({ message: 'Outside your area of responsibility', code: 'ORG_SCOPE_DENIED' }); }
  // Область руководства (декан / зав. кафедрой / тьютор) применяется не только к спискам, но и к каждому обращению по id (защита от BOLA)
  private async assertStudent(u: CurrentUserData, id: string) {
    if (!(await this.groupsOf(u))) return;
    const s = await this.prisma.student.findUnique({ where: { userId: id }, select: { groupName: true } });
    if (!s) throw new NotFoundException('Student not found');
    await this.assertGroup(u, s.groupName);
  }
  /** Преподаватель в области — если ведёт занятия хотя бы в одной группе области (то же правило, что у списка преподавателей) */
  private async assertTeacher(u: CurrentUserData, id: string) {
    const g = await this.groupsOf(u);
    if (!g) return;
    const n = await this.prisma.scheduleSlot.count({ where: { teacherId: id, groupName: { in: g } } });
    if (!n) throw new ForbiddenException({ message: 'Outside your area of responsibility', code: 'ORG_SCOPE_DENIED' });
  }

  // ── Students ──
  @Get('students')
  @RequirePermission('students.view', ALL)
  async students(@CurrentUser() u: CurrentUserData, @Query(new ZodValidationPipe(StudentsQuerySchema)) q: Q<typeof StudentsQuerySchema>) { return this.dir.listStudents(q, await this.groupsOf(u)); }

  @Get('students/:id')
  @RequirePermission('students.view', ALL)
  async student(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string) { await this.assertStudent(u, id); return this.dir.getStudent(id); }

  @Post('students')
  @RequirePermission('students.create', ALL)
  async createStudent(@CurrentUser() u: CurrentUserData, @Body(new ZodValidationPipe(CreateStudentSchema)) dto: Q<typeof CreateStudentSchema>, @Req() req: Request) { await this.assertGroup(u, dto.groupName); return this.dir.createStudent(u, dto, ctxOf(req)); }

  @Patch('students/:id')
  @RequirePermission('students.update', ALL)
  async updateStudent(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string, @Body(new ZodValidationPipe(UpdateStudentSchema)) dto: Q<typeof UpdateStudentSchema>, @Req() req: Request) {
    await this.assertStudent(u, id);
    if (dto.groupName) await this.assertGroup(u, dto.groupName); // перевод — только в группу своей области
    return this.dir.updateStudent(u, id, dto, ctxOf(req));
  }

  @Post('students/:id/archive')
  @RequirePermission('students.archive', ALL)
  async archive(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string, @Body(new ZodValidationPipe(OptionalReasonSchema)) dto: Q<typeof OptionalReasonSchema>, @Req() req: Request) { await this.assertStudent(u, id); return this.dir.archiveStudent(u, id, true, dto.reason, ctxOf(req)); }

  @Post('students/:id/unarchive')
  @RequirePermission('students.archive', ALL)
  async unarchive(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string, @Req() req: Request) { await this.assertStudent(u, id); return this.dir.archiveStudent(u, id, false, undefined, ctxOf(req)); }

  // ── Teachers ──
  @Get('teachers')
  @RequirePermission('teachers.view', ALL)
  async teachers(@CurrentUser() u: CurrentUserData, @Query(new ZodValidationPipe(TeachersQuerySchema)) q: Q<typeof TeachersQuerySchema>) { return this.dir.listTeachers(q, await this.groupsOf(u)); }

  @Get('teachers/:id')
  @RequirePermission('teachers.view', ALL)
  async teacher(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string) { await this.assertTeacher(u, id); return this.dir.getTeacher(id); }

  @Post('teachers')
  @RequirePermission('teachers.create', ALL)
  createTeacher(@CurrentUser() u: CurrentUserData, @Body(new ZodValidationPipe(CreateTeacherSchema)) dto: Q<typeof CreateTeacherSchema>, @Req() req: Request) { return this.dir.createTeacher(u, dto, ctxOf(req)); }

  @Patch('teachers/:id')
  @RequirePermission('teachers.update', ALL)
  async updateTeacher(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string, @Body(new ZodValidationPipe(UpdateTeacherSchema)) dto: Q<typeof UpdateTeacherSchema>, @Req() req: Request) { await this.assertTeacher(u, id); return this.dir.updateTeacher(u, id, dto, ctxOf(req)); }

  @Post('teachers/:id/assign')
  @RequirePermission('teachers.assign', ALL)
  async assign(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string, @Body(new ZodValidationPipe(AssignTeacherSchema)) dto: Q<typeof AssignTeacherSchema>, @Req() req: Request) { await this.assertGroup(u, dto.groupName); return this.dir.assignTeacher(u, id, dto, ctxOf(req)); }

  @Post('teachers/:id/unassign')
  @RequirePermission('teachers.assign', ALL)
  async unassign(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string, @Body(new ZodValidationPipe(AssignTeacherSchema)) dto: Q<typeof AssignTeacherSchema>, @Req() req: Request) { await this.assertGroup(u, dto.groupName); return this.dir.unassignTeacher(u, id, dto, ctxOf(req)); }

  // ── Groups ──
  @Get('groups')
  @RequirePermission('groups.view', ALL)
  async groups(@CurrentUser() u: CurrentUserData) { return this.dir.listGroups(await this.groupsOf(u)); }

  @Get('groups/:name')
  @RequirePermission('groups.view', ALL)
  async group(@CurrentUser() u: CurrentUserData, @Param('name', namePipe) name: string) { await this.assertGroup(u, name); return this.dir.getGroup(name); }

  @Patch('groups/:name')
  @RequirePermission('groups.update', ALL)
  async renameGroup(@CurrentUser() u: CurrentUserData, @Param('name', namePipe) name: string, @Body(new ZodValidationPipe(RenameGroupSchema)) dto: Q<typeof RenameGroupSchema>, @Req() req: Request) { await this.assertGroup(u, name); return this.dir.renameGroup(u, name, dto.newName, ctxOf(req)); }

  // ── Subjects ──
  @Get('subjects')
  @RequirePermission('subjects.view', ALL)
  subjects(@Query(new ZodValidationPipe(SubjectsQuerySchema)) q: Q<typeof SubjectsQuerySchema>) { return this.dir.listSubjects(q); }

  @Post('subjects')
  @RequirePermission('subjects.create', ALL)
  createSubject(@CurrentUser() u: CurrentUserData, @Body(new ZodValidationPipe(CreateSubjectSchema)) dto: Q<typeof CreateSubjectSchema>, @Req() req: Request) { return this.dir.createSubject(u, dto, ctxOf(req)); }

  @Patch('subjects/:id')
  @RequirePermission('subjects.update', ALL)
  updateSubject(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string, @Body(new ZodValidationPipe(UpdateSubjectSchema)) dto: Q<typeof UpdateSubjectSchema>, @Req() req: Request) { return this.dir.updateSubject(u, id, dto, ctxOf(req)); }

  @Delete('subjects/:id')
  @RequirePermission('subjects.delete', ALL)
  deleteSubject(@CurrentUser() u: CurrentUserData, @Param('id', idPipe) id: string, @Req() req: Request) { return this.dir.deleteSubject(u, id, ctxOf(req)); }
}
