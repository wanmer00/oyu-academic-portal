import { Controller, Get, Param, Query } from '@nestjs/common';
import { Term } from '@prisma/client';
import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/rbac/require-permission.decorator';
import { StudentsService } from './students.service';

// Личный кабинет студента: данные только самого студента (id берётся из JWT, scope OWN).
// Посещаемость — в Academic Journal: GET /journal/attendance/student.
@Controller('me')
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @Get('info')
  @RequirePermission('students.view')
  info(@CurrentUser() user: CurrentUserData) {
    return this.students.getMyInfo(user.id);
  }

  @Get('grades')
  @RequirePermission('grades.view')
  grades(
    @CurrentUser() user: CurrentUserData,
    @Query('academicYear') academicYear?: string,
    @Query('term') term?: Term,
  ) {
    return this.students.getMyGrades(user.id, { academicYear, term });
  }

  @Get('schedule')
  @RequirePermission('schedule.view')
  schedule(@CurrentUser() user: CurrentUserData) {
    return this.students.getMySchedule(user.id);
  }

  @Get('transcript')
  @RequirePermission('grades.view')
  transcript(@CurrentUser() user: CurrentUserData) {
    return this.students.getTranscript(user.id);
  }

  /** Официальный GPA / кредиты / академический статус — единый источник для всех student UI */
  @Get('academic-summary')
  @RequirePermission('grades.view')
  academicSummary(@CurrentUser() user: CurrentUserData) {
    return this.students.academicSummary(user.id);
  }

  @Get('subjects-overview')
  @RequirePermission('subjects.view')
  subjectsOverview(
    @CurrentUser() user: CurrentUserData,
    @Query('academicYear') academicYear?: string,
    @Query('term') term?: Term,
  ) {
    return this.students.getSubjectsOverview(user.id, { academicYear, term });
  }

  @Get('subjects/:code/days')
  @RequirePermission('subjects.view')
  subjectDays(
    @CurrentUser() user: CurrentUserData,
    @Param('code') code: string,
    @Query('academicYear') academicYear?: string,
    @Query('term') term?: Term,
  ) {
    return this.students.getSubjectDays(user.id, code, { academicYear, term });
  }
}
