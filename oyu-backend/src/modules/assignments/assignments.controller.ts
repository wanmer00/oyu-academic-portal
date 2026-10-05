import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { Request } from 'express';

import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/rbac/require-permission.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AssignmentsService } from './assignments.service';
import {
  AssignmentStatusDto,
  AssignmentStatusSchema,
  UpdateAssignmentDto,
  UpdateAssignmentSchema,
  CreateAssignmentDto,
  CreateAssignmentSchema,
  GradeSubmissionDto,
  GradeSubmissionSchema,
  SubmitDto,
  SubmitSchema,
} from './dto';

function audit(req: Request) {
  return {
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  };
}

// ── STUDENT: /api/v1/me/assignments ──
@Controller('me/assignments')
@RequirePermission('assignments.view')
export class StudentAssignmentsController {
  constructor(private readonly svc: AssignmentsService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserData) {
    return this.svc.getForStudent(user.id);
  }

  @Get(':id')
  one(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.svc.getOneForStudent(user.id, id);
  }

  @Post(':id/submit')
  @RequirePermission('assignments.submit')
  submit(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SubmitSchema)) dto: SubmitDto,
    @Req() req: Request,
  ) {
    return this.svc.submit(user.id, id, dto, audit(req));
  }
}

// ── TEACHER: /api/v1/teacher/assignments ──
@Controller('teacher/assignments')
@RequirePermission('assignments.manage')
export class TeacherAssignmentsController {
  constructor(private readonly svc: AssignmentsService) {}

  @Get()
  mine(@CurrentUser() user: CurrentUserData) {
    return this.svc.getForTeacher(user.id);
  }

  @Post()
  create(
    @CurrentUser() user: CurrentUserData,
    @Body(new ZodValidationPipe(CreateAssignmentSchema)) dto: CreateAssignmentDto,
    @Req() req: Request,
  ) {
    return this.svc.create(user.id, dto, audit(req));
  }

  @Patch(':id')
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateAssignmentSchema)) dto: UpdateAssignmentDto,
    @Req() req: Request,
  ) {
    return this.svc.update(user.id, id, dto, audit(req));
  }

  @Post(':id/status')
  setStatus(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AssignmentStatusSchema)) dto: AssignmentStatusDto,
    @Req() req: Request,
  ) {
    return this.svc.setStatus(user.id, id, dto.status, audit(req));
  }

  @Get(':id/submissions')
  submissions(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.svc.submissionsFor(user.id, id);
  }
}

// ── TEACHER: /api/v1/teacher/submissions/:id ──
@Controller('teacher/submissions')
@RequirePermission('assignments.manage')
export class TeacherSubmissionsController {
  constructor(private readonly svc: AssignmentsService) {}

  @Patch(':id')
  grade(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(GradeSubmissionSchema)) dto: GradeSubmissionDto,
    @Req() req: Request,
  ) {
    return this.svc.gradeSubmission(user.id, id, dto, audit(req));
  }
}
