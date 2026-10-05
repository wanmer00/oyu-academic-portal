import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AppealsService } from './appeals.service';
import { CreateRequestDto, UpdateRequestDto } from './dto';

/** Лимит заявок в сутки на одного пользователя. */
const DAILY_LIMIT = 5;

@Injectable()
export class RequestsService {
  constructor(private readonly prisma: PrismaService, private readonly appeals: AppealsService) {}

  async listMy(userId: string) {
    const rows = await this.prisma.request.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { examAppeal: { select: { id: true, appealDeadline: true, items: { select: { position: true } }, result: { select: { exam: { select: { subject: { select: { name: true } }, window: { select: { title: true } } } } } } } } },
    });
    // апелляция по экзамену — та же заявка + краткие сведения об экзамене
    return rows.map(({ examAppeal, ...r }) => ({ ...r, appeal: examAppeal ? { code: 'A-' + r.id.slice(-6).toUpperCase(), subject: examAppeal.result.exam?.subject.name ?? null, exam: examAppeal.result.exam?.window.title ?? null, disputed: examAppeal.items.length, deadline: examAppeal.appealDeadline } : null }));
  }

  /** Детали своей заявки; для APPEAL по экзамену — спорные вопросы, решения, таймлайн */
  async getMine(userId: string, id: string) {
    const r = await this.prisma.request.findUnique({ where: { id } });
    if (!r || r.userId !== userId) throw new NotFoundException('Müraciət tapılmadı');
    return { ...r, appeal: await this.appeals.mine(userId, id) };
  }

  async dailyQuota(userId: string) {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const used = await this.prisma.request.count({
      where: { userId, createdAt: { gte: since } },
    });
    return { used, limit: DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - used) };
  }

  async create(
    userId: string,
    dto: CreateRequestDto,
    audit: { ip?: string | null; userAgent?: string | null },
  ) {
    // Дневной лимит — защита от спама
    const q = await this.dailyQuota(userId);
    if (q.remaining <= 0) {
      throw new BadRequestException(
        `Gündəlik limit (${DAILY_LIMIT} müraciət) tükənib. Sabah yenidən cəhd edin.`,
      );
    }

    if (dto.appeal) return this.appeals.create(userId, dto.appeal, dto.description, { ip: audit.ip ?? null, userAgent: audit.userAgent ?? null });

    const req = await this.prisma.request.create({
      data: { userId, type: dto.type, description: dto.description! },
    });
    await this.prisma.auditLog.create({
      data: {
        actorId: userId,
        action: 'request.create',
        targetType: 'Request',
        targetId: req.id,
        diff: { type: dto.type, dailyUsed: q.used + 1 },
        ip: audit.ip ?? null,
        userAgent: audit.userAgent ?? null,
      },
    });
    return req;
  }

  /** Студент редактирует свою заявку — только если она в статусе PENDING. */
  async updateMine(
    userId: string,
    id: string,
    dto: UpdateRequestDto,
    audit: { ip?: string | null; userAgent?: string | null },
  ) {
    const existing = await this.prisma.request.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Müraciət tapılmadı');
    if (existing.userId !== userId) throw new ForbiddenException('Bu müraciət sizin deyil');
    if (existing.status !== 'PENDING') {
      throw new BadRequestException('Yalnız "Gözləyir" statuslu müraciəti redaktə etmək olar');
    }
    if (await this.prisma.examAppeal.findUnique({ where: { requestId: id }, select: { id: true } })) {
      throw new BadRequestException({ message: 'Use the appeal form to edit an exam appeal', code: 'USE_APPEAL_EDIT' });
    }
    if (!dto.type && !dto.description) {
      throw new BadRequestException('Dəyişiklik üçün ən az bir sahə göndər');
    }

    const updated = await this.prisma.request.update({
      where: { id },
      data: {
        ...(dto.type !== undefined ? { type: dto.type } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
      },
    });
    await this.prisma.auditLog.create({
      data: {
        actorId: userId,
        action: 'request.update',
        targetType: 'Request',
        targetId: id,
        diff: { type: dto.type, descChanged: dto.description !== undefined },
        ip: audit.ip ?? null,
        userAgent: audit.userAgent ?? null,
      },
    });
    return updated;
  }

  /** Студент удаляет свою заявку — только если PENDING. */
  async deleteMine(
    userId: string,
    id: string,
    audit: { ip?: string | null; userAgent?: string | null },
  ) {
    const existing = await this.prisma.request.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Müraciət tapılmadı');
    if (existing.userId !== userId) throw new ForbiddenException('Bu müraciət sizin deyil');
    if (existing.status !== 'PENDING') {
      throw new BadRequestException('Yalnız "Gözləyir" statuslu müraciəti silmək olar');
    }
    // апелляции по экзамену не удаляются физически — только отзыв (WITHDRAWN)
    if (await this.prisma.examAppeal.findUnique({ where: { requestId: id }, select: { id: true } })) {
      throw new BadRequestException({ message: 'An exam appeal can only be withdrawn', code: 'USE_APPEAL_WITHDRAW' });
    }
    await this.prisma.request.delete({ where: { id } });
    await this.prisma.auditLog.create({
      data: {
        actorId: userId,
        action: 'request.delete',
        targetType: 'Request',
        targetId: id,
        diff: { type: existing.type },
        ip: audit.ip ?? null,
        userAgent: audit.userAgent ?? null,
      },
    });
    return { ok: true };
  }
}
