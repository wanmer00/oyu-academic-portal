import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';

import { CurrentUser, CurrentUserData } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/rbac/require-permission.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { MaterialsService } from './materials.service';
import { CreateMaterialDto, CreateMaterialSchema, UpdateMaterialDto, UpdateMaterialSchema } from './dto';

function audit(req: Request) {
  return { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null };
}

// ── STUDENT: /me/materials ──
@Controller('me/materials')
@RequirePermission('materials.view')
export class StudentMaterialsController {
  constructor(private readonly svc: MaterialsService) {}

  @Get()
  list(
    @CurrentUser() user: CurrentUserData,
    @Query('subjectCode') subjectCode?: string,
  ) {
    return this.svc.listForStudent(user.id, subjectCode);
  }
}

// ── TEACHER: /teacher/materials ──
@Controller('teacher/materials')
@RequirePermission('materials.manage')
export class TeacherMaterialsController {
  constructor(private readonly svc: MaterialsService) {}

  @Get()
  mine(@CurrentUser() user: CurrentUserData) {
    return this.svc.listForTeacher(user.id);
  }

  @Post()
  create(
    @CurrentUser() user: CurrentUserData,
    @Body(new ZodValidationPipe(CreateMaterialSchema)) dto: CreateMaterialDto,
    @Req() req: Request,
  ) {
    return this.svc.create(user.id, dto, audit(req));
  }

  @Patch(':id')
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateMaterialSchema)) dto: UpdateMaterialDto,
    @Req() req: Request,
  ) {
    return this.svc.update(user.id, id, dto, audit(req));
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    return this.svc.delete(user.id, id, audit(req));
  }
}
