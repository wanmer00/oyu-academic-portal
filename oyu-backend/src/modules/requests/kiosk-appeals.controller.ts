import { Body, Controller, ForbiddenException, Get, Post, Req, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { z } from 'zod';
import { Public } from '../../common/decorators/public.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { WorkstationGuard } from '../exams/runtime.service';
import { AppealInputSchema, AppealsService } from './appeals.service';

/** Сколько минут после сдачи студент может смотреть ошибки и подать апелляцию прямо на экзаменационном ПК */
const KIOSK_MINUTES = 30;
const KioskAppealSchema = AppealInputSchema.omit({ resultId: true });

/**
 * Экран окончания экзамена: просмотр ошибок и подача апелляции без входа в портал.
 * Доступ — только с того же зарегистрированного ПК (ключ рабочего места), только к последней сданной на нём работе,
 * только в течение 30 минут после сдачи и пока ПК не отдан следующему студенту. Дальше — через портал (Requests).
 */
@Public()
@SkipThrottle()
@UseGuards(WorkstationGuard)
@Controller('exam-runtime/appeal')
export class KioskAppealsController {
  constructor(private readonly prisma: PrismaService, private readonly appeals: AppealsService) {}

  private async lastResult(wsId: string) {
    const last = await this.prisma.examAttempt.findFirst({ where: { workstationId: wsId, status: { not: 'VOID' } }, orderBy: { createdAt: 'desc' }, include: { result: { select: { id: true, publishedAt: true } } } });
    const fresh = last?.submittedAt && Date.now() - last.submittedAt.getTime() < KIOSK_MINUTES * 60_000;
    if (!last || !fresh || !last.result?.publishedAt || !['SUBMITTED', 'AUTO_SUBMITTED', 'TERMINATED'].includes(last.status)) {
      throw new ForbiddenException({ message: 'Exam review on this workstation is no longer available — use the portal', code: 'KIOSK_REVIEW_EXPIRED' });
    }
    return { studentId: last.studentId, resultId: last.result.id };
  }

  @Get('review')
  async review(@Req() req: Request & { workstation: { id: string } }) {
    const r = await this.lastResult(req.workstation.id);
    return this.appeals.review(r.studentId, r.resultId);
  }

  @Post()
  async submit(@Req() req: Request & { workstation: { id: string; code: string } }, @Body(new ZodValidationPipe(KioskAppealSchema)) dto: z.infer<typeof KioskAppealSchema>) {
    const r = await this.lastResult(req.workstation.id);
    return this.appeals.create(r.studentId, { resultId: r.resultId, items: dto.items }, undefined, { ip: req.ip ?? null, userAgent: `kiosk ${req.workstation.code}` });
  }
}
