import { Module } from '@nestjs/common';
import { AssignmentsService } from './assignments.service';
import {
  StudentAssignmentsController,
  TeacherAssignmentsController,
  TeacherSubmissionsController,
} from './assignments.controller';

@Module({
  controllers: [
    StudentAssignmentsController,
    TeacherAssignmentsController,
    TeacherSubmissionsController,
  ],
  providers: [AssignmentsService],
  exports: [AssignmentsService],
})
export class AssignmentsModule {}
