import { BadRequestException, ForbiddenException, Global, Injectable, Module, NotFoundException } from '@nestjs/common';
import { PeriodStatus, Term } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { CURRENT_PERIOD } from '../teachers/teacher-access.service';

import { AuditCtx } from '../../common/audit/audit-trail.service';
export type { AuditCtx };

/**
 * Блокировка академического периода. Реальная защита на backend:
 * все операции записи оценок/посещаемости вызывают assertOpen().
 */
@Injectable()
export class PeriodService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.academicPeriod.findMany({ orderBy: [{ academicYear: 'desc' }, { term: 'asc' }] });
  }

  get(academicYear: string, term: Term) {
    return this.prisma.academicPeriod.findUnique({ where: { academicYear_term: { academicYear, term } } });
  }

  async isClosed(academicYear: string, term: Term): Promise<boolean> {
    return (await this.get(academicYear, term))?.status === PeriodStatus.CLOSED;
  }

  /** Период должен существовать (опечатка в периоде не создаёт «призрачный» семестр) */
  async requireExisting(academicYear: string, term: Term) {
    const p = await this.get(academicYear, term);
    if (!p) throw new BadRequestException({ message: 'Unknown academic period', code: 'PERIOD_UNKNOWN' });
    return p;
  }

  async assertOpen(academicYear: string, term: Term) {
    const p = await this.get(academicYear, term);
    if (p?.status === PeriodStatus.CLOSED) {
      throw new ForbiddenException({ message: 'Academic period is closed', code: 'PERIOD_CLOSED' });
    }
  }

  /** Открыть/закрыть период — только руководство; причина и аудит обязательны */
  async setStatus(actorId: string, id: string, status: PeriodStatus, reason: string, ctx: AuditCtx) {
    const existing = await this.prisma.academicPeriod.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Academic period not found');
    if (existing.status === status) return existing;
    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.academicPeriod.update({
        where: { id },
        data: {
          status,
          closedAt: status === PeriodStatus.CLOSED ? new Date() : null,
          closedBy: status === PeriodStatus.CLOSED ? actorId : null,
          note: reason,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId,
          action: status === PeriodStatus.CLOSED ? 'journal.period_close' : 'journal.period_open',
          targetType: 'AcademicPeriod',
          targetId: id,
          diff: { academicYear: existing.academicYear, term: existing.term, old: existing.status, new: status, reason },
          ip: ctx.ip ?? null,
          userAgent: ctx.userAgent ?? null,
        },
      });
      return u;
    });
    return updated;
  }

  /**
   * Академический период даты занятия. Календарное правило: сен–янв = FALL, фев–июн = SPRING, июл–авг = SUMMER.
   * Если такого периода нет в системе (напр. демо-данные в «будущем» семестре) — активный период системы,
   * чтобы посещаемость не оказывалась в несуществующем семестре.
   */
  async forDate(date: Date): Promise<{ academicYear: string; term: Term }> {
    const m = date.getUTCMonth() + 1;
    const y = date.getUTCFullYear();
    const term: Term = m >= 9 || m === 1 ? 'FALL' : m <= 6 ? 'SPRING' : 'SUMMER';
    const start = m >= 9 ? y : y - 1;
    const academicYear = `${start}-${start + 1}`;
    if (await this.get(academicYear, term)) return { academicYear, term };
    return { academicYear: CURRENT_PERIOD.academicYear, term: CURRENT_PERIOD.term };
  }

  current() {
    return { ...CURRENT_PERIOD };
  }
}

@Global()
@Module({ providers: [PeriodService], exports: [PeriodService] })
export class PeriodModule {}
