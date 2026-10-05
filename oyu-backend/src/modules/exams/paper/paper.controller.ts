import { Body, Controller, Get, Header, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { z } from 'zod';
import { CurrentUser, CurrentUserData } from '../../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequirePermission } from '../../../common/rbac/require-permission.decorator';
import { ctxOf } from '../exams.controller';
import { PaperService } from './paper.service';

const Generate = z.object({ studentIds: z.array(z.string()).max(2000).optional() });
const Scan = z.object({ mimeType: z.string().max(40), dataBase64: z.string().max(17_000_000) });
const Correct = z.object({ letter: z.enum(['A', 'B', 'C', 'D', 'E']).nullable(), reason: z.string().trim().min(3).max(300) });
const actor = (u: CurrentUserData) => ({ id: u.id, role: u.role });

/** Бумажные экзамены: бланки, сканы, OMR, ручная проверка. Доступ — только exams.paper (Management). */
@Controller('admin/paper')
export class PaperController {
  constructor(private readonly svc: PaperService) {}

  @Post('exams/:examId/generate') @RequirePermission('exams.paper')
  generate(@CurrentUser() u: CurrentUserData, @Param('examId') id: string, @Body(new ZodValidationPipe(Generate)) b: z.infer<typeof Generate>, @Req() req: Request) { return this.svc.generate(actor(u), id, b.studentIds, ctxOf(req)); }

  @Get('exams/:examId/sheets') @RequirePermission('exams.paper')
  sheets(@Param('examId') id: string) { return this.svc.sheets(id); }

  @Get('exams/:examId/print') @RequirePermission('exams.paper') @Header('Content-Type', 'text/html; charset=utf-8')
  printExam(@Param('examId') id: string) { return this.svc.printExam(id); }

  @Get('sheets/:id/print') @RequirePermission('exams.paper') @Header('Content-Type', 'text/html; charset=utf-8')
  printSheet(@Param('id') id: string) { return this.svc.printSheet(id); }

  @Get('review') @RequirePermission('exams.paper')
  review() { return this.svc.review(); }

  @Get('sheets/:id') @RequirePermission('exams.paper')
  detail(@Param('id') id: string) { return this.svc.detail(id); }

  @Post('sheets/:id/scan') @RequirePermission('exams.paper')
  scan(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Body(new ZodValidationPipe(Scan)) b: z.infer<typeof Scan>, @Req() req: Request) { return this.svc.upload(actor(u), id, b.mimeType, b.dataBase64, ctxOf(req)); }

  @Get('sheets/:id/scan-image') @RequirePermission('exams.paper')
  async image(@Param('id') id: string, @Res() res: Response, @Query('v') _v?: string) {
    const { mimeType, data } = await this.svc.scanImage(id);
    res.setHeader('Content-Type', mimeType); res.setHeader('Cache-Control', 'private, max-age=60'); res.send(data);
  }

  @Put('sheets/:id/answers/:position') @RequirePermission('exams.paper')
  correct(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Param('position') p: string, @Body(new ZodValidationPipe(Correct)) b: z.infer<typeof Correct>, @Req() req: Request) { return this.svc.correct(actor(u), id, Number(p), b.letter, b.reason, ctxOf(req)); }

  @Post('sheets/:id/confirm') @RequirePermission('exams.paper')
  confirm(@CurrentUser() u: CurrentUserData, @Param('id') id: string, @Req() req: Request) { return this.svc.confirm(actor(u), id, ctxOf(req)); }
}
