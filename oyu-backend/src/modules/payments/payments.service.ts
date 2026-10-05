import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PaymentStatus, PaymentType } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async listForStudent(userId: string) {
    const student = await this.prisma.student.findUnique({ where: { userId } });
    if (!student) throw new ForbiddenException('Only students');
    const items = await this.prisma.payment.findMany({
      where: { studentId: student.userId },
      orderBy: [{ status: 'asc' }, { dueDate: 'desc' }],
    });
    const summary = {
      totalPaid:    items.filter(p => p.status === 'PAID').reduce((s, p) => s + Number(p.amount), 0),
      totalPending: items.filter(p => p.status === 'PENDING' || p.status === 'PROCESSING').reduce((s, p) => s + Number(p.amount), 0),
      overdueCount: items.filter(p => (p.status === 'PENDING' || p.status === 'PROCESSING') && p.dueDate < new Date()).length,
    };
    return {
      items: items.map(p => ({ ...p, amount: Number(p.amount) })),
      summary,
    };
  }

  // Simulated payment: student marks payment as PROCESSING → PAID (demo)
  async payMock(userId: string, paymentId: string) {
    const student = await this.prisma.student.findUnique({ where: { userId } });
    if (!student) throw new ForbiddenException('Only students');
    const p = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!p) throw new NotFoundException('Payment not found');
    if (p.studentId !== student.userId) throw new ForbiddenException('Not yours');
    if (p.status === 'PAID') throw new BadRequestException('Already paid');
    const updated = await this.prisma.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.PAID, paidAt: new Date(), providerRef: 'DEMO-' + Date.now() },
    });
    await this.prisma.auditLog.create({
      data: { actorId: userId, action: 'payment.pay_mock', targetType: 'Payment', targetId: paymentId, diff: { amount: Number(p.amount) } },
    });
    await this.notifications.notify([userId], {
      type: 'PAYMENT',
      title: { az: 'Ödəniş qəbul edildi', ru: 'Платёж принят', en: 'Payment received' },
      message: {
        az: `${p.description} — ${Number(p.amount)} ${p.currency} (${p.invoiceNumber})`,
        ru: `${p.description} — ${Number(p.amount)} ${p.currency} (${p.invoiceNumber})`,
        en: `${p.description} — ${Number(p.amount)} ${p.currency} (${p.invoiceNumber})`,
      },
      link: 'payments',
    });
    return { ...updated, amount: Number(updated.amount) };
  }

  // ── Admin ──
  async listAll(params: { status?: PaymentStatus; type?: PaymentType; take?: number }) {
    const take = Math.min(params.take ?? 200, 500);
    const where: any = {};
    if (params.status) where.status = params.status;
    if (params.type) where.type = params.type;
    const items = await this.prisma.payment.findMany({
      where,
      include: { student: { include: { user: { select: { loginId: true, fullName: true, email: true } } } } },
      orderBy: { createdAt: 'desc' },
      take,
    });
    const totalPaid    = items.filter(p => p.status === 'PAID').reduce((s, p) => s + Number(p.amount), 0);
    const totalPending = items.filter(p => p.status === 'PENDING' || p.status === 'PROCESSING').reduce((s, p) => s + Number(p.amount), 0);
    return {
      items: items.map(p => ({
        ...p,
        amount: Number(p.amount),
        student: { loginId: p.student.user.loginId, fullName: p.student.user.fullName, groupName: p.student.groupName },
      })),
      summary: { totalPaid, totalPending, count: items.length },
    };
  }
}
