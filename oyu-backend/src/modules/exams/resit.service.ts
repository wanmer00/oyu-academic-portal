import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { AuditCtx } from '../../common/audit/audit-trail.service';
import { env } from '../../config/env';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { Actor, ExamCommon, Tx } from './exam-common.service';
import { cycleKey, isoDate, localParts, resitFee } from './exam.rules';

/**
 * Абстракция платёжного провайдера. Сейчас DemoPaymentProvider (мгновенный PAID);
 * реальный провайдер подключается реализацией интерфейса — бизнес-правила resit от него не зависят.
 */
export interface PaymentProvider {
  readonly name: string;
  charge(p: { amount: number; currency: string; reference: string; simulate?: 'FAIL' }): Promise<{ status: 'PAID' | 'FAILED' | 'PENDING'; providerRef: string }>;
}
export class DemoPaymentProvider implements PaymentProvider {
  readonly name = 'DEMO';
  async charge(p: { amount: number; currency: string; reference: string; simulate?: 'FAIL' }) {
    return { status: p.simulate === 'FAIL' ? ('FAILED' as const) : ('PAID' as const), providerRef: `DEMO-${p.reference}` };
  }
}

const RESIT_STATES = ['RESIT_ELIGIBLE', 'RESIT_PAYMENT_PENDING', 'RESIT_PAID', 'RESIT_FORFEITED'] as const;

@Injectable()
export class ResitService {
  private provider: PaymentProvider = new DemoPaymentProvider();
  constructor(private readonly prisma: PrismaService, private readonly common: ExamCommon) {}

  /**
   * Ближайшее resit-окно, в котором этот enrollment может пересдаваться.
   * Привязка к семестру: окно финального экзамена должно быть того же term (зимний → зимнее, весенний → весеннее/летнее resit),
   * не раньше цикла enrollment. Прошедшие окна не считаются.
   */
  async targetWindow(en: { academicYear: string; term: string }, now = new Date(), db: Tx | PrismaService = this.prisma) {
    const today = localParts(now).date;
    const wins = await db.examWindow.findMany({
      where: { kind: 'RESIT', status: { in: ['DRAFT', 'PUBLISHED'] }, endDate: { gte: new Date(`${today}T00:00:00Z`) }, finalWindow: { term: en.term as never, academicYear: { gte: en.academicYear } } },
      include: { finalWindow: true }, orderBy: { startDate: 'asc' },
    });
    return wins[0] ?? null;
  }

  /** Лимит resit в цикле: оплачиваемые/оплаченные/использованные */
  async usedInCycle(studentId: string, key: string, db: Tx | PrismaService = this.prisma, exceptId?: string) {
    return db.resitEligibility.count({ where: { studentId, cycleKey: key, status: { in: ['PAYMENT_PENDING', 'PAID', 'USED'] }, ...(exceptId ? { id: { not: exceptId } } : {}) } });
  }

  /** Создаёт запись права на resit для ближайшего окна, если её ещё нет. Сумма считается backend-ом. */
  async ensureRecord(en: { id: string; studentId: string; subjectId: string; academicYear: string; term: string; status: string }, now = new Date()) {
    if (!(RESIT_STATES as readonly string[]).includes(en.status)) return null;
    const w = await this.targetWindow(en, now);
    if (!w?.finalWindow) return null;
    const key = cycleKey(w.finalWindow.academicYear, w.finalWindow.term);
    const found = await this.prisma.resitEligibility.findUnique({ where: { enrollmentId_cycleKey: { enrollmentId: en.id, cycleKey: key } } });
    if (found) return { record: found, window: w };
    const credits = await this.common.creditsFor(en.studentId, en.subjectId);
    const price = this.common.cfg.creditPrice();
    const { fee } = resitFee(credits, price, this.common.cfg.resitRatio());
    const record = await this.prisma.resitEligibility.create({ data: { enrollmentId: en.id, studentId: en.studentId, subjectId: en.subjectId, cycleKey: key, credits, creditPrice: price, feeAmount: fee } }).catch(() => null);
    return record ? { record, window: w } : null;
  }

  /** Витрина resit студента: предметы, сумма, статус оплаты, лимит цикла */
  async listForStudent(studentId: string, now = new Date()) {
    const enrs = await this.prisma.subjectEnrollment.findMany({ where: { studentId, source: { not: 'DEMO' }, status: { in: [...RESIT_STATES] } }, include: { subject: { select: { id: true, code: true, name: true } } }, orderBy: { updatedAt: 'desc' } });
    const price = this.common.cfg.creditPrice(), ratio = this.common.cfg.resitRatio(), max = this.common.cfg.maxResits();
    const items = [];
    const usage = new Map<string, number>();
    for (const en of enrs) {
      const t = await this.ensureRecord(en, now);
      const w = t?.window ?? (await this.targetWindow(en, now));
      const key = w?.finalWindow ? cycleKey(w.finalWindow.academicYear, w.finalWindow.term) : cycleKey(en.academicYear, en.term);
      if (!usage.has(key)) usage.set(key, await this.usedInCycle(studentId, key));
      const credits = t?.record.credits ?? (await this.common.creditsFor(studentId, en.subjectId));
      const fees = resitFee(credits, Number(t?.record.creditPrice ?? price), ratio);
      const rec = t?.record ?? null;
      const limitReached = (usage.get(key) ?? 0) >= max && !['PAID', 'USED', 'PAYMENT_PENDING'].includes(rec?.status ?? '');
      items.push({
        enrollmentId: en.id, resitId: rec?.id ?? null, subject: en.subject, status: en.status, cycle: key, credits, creditPrice: Number(rec?.creditPrice ?? price), fullCost: fees.full, fee: rec ? Number(rec.feeAmount) : fees.fee, currency: 'AZN',
        payment: rec?.status ?? (w ? 'ELIGIBLE' : 'NO_WINDOW'), limitReached,
        window: w ? { id: w.id, title: w.title, startDate: isoDate(w.startDate), endDate: isoDate(w.endDate), weekdays: w.allowedWeekdays, time: `${w.startTime}–${w.endTime}` } : null,
        canPay: !!w && !!rec && ['ELIGIBLE', 'PAYMENT_PENDING'].includes(rec.status) && !limitReached && en.status !== 'RESIT_PAID',
      });
    }
    const cycles = [...usage.entries()].map(([cycle, used]) => ({ cycle, used, max }));
    return { items, limit: { max, cycles } };
  }

  /**
   * Оплата 25% resit (DEMO). Backend заново проверяет: принадлежность записи, статус предмета, resit-окно цикла,
   * лимит 2 в цикле, пересчитывает сумму. Клиентская сумма не используется.
   */
  async pay(user: Actor, resitId: string, opts: { simulate?: 'FAIL' }, ctx: AuditCtx) {
    const rec0 = await this.prisma.resitEligibility.findUnique({ where: { id: resitId }, include: { enrollment: true, subject: { select: { name: true } } } });
    if (!rec0 || rec0.studentId !== user.id) throw new NotFoundException('Resit not found');
    const sim = opts.simulate === 'FAIL' && env.DEMO_MODE ? 'FAIL' : undefined;
    const out = await this.prisma.$transaction(async (tx) => {
      await this.common.lockStudent(tx, user.id);
      const rec = await tx.resitEligibility.findUniqueOrThrow({ where: { id: resitId }, include: { enrollment: true } });
      const en = rec.enrollment;
      if (rec.status === 'PAID' || rec.status === 'USED') throw new ConflictException({ message: 'Resit is already paid or used', code: 'RESIT_ALREADY_PAID' });
      if (rec.status === 'FORFEITED') throw new ConflictException({ message: 'Resit opportunity has expired', code: 'RESIT_FORFEITED' });
      if (!(RESIT_STATES as readonly string[]).includes(en.status) || en.status === 'RESIT_PAID') throw new ConflictException({ message: 'Subject is not in the resit branch', code: 'RESIT_NOT_ALLOWED' });
      const w = await this.targetWindow(en, new Date(), tx);
      if (!w?.finalWindow || cycleKey(w.finalWindow.academicYear, w.finalWindow.term) !== rec.cycleKey) throw new ConflictException({ message: 'No resit window for this cycle', code: 'NO_RESIT_WINDOW' });
      if ((await this.usedInCycle(user.id, rec.cycleKey, tx, rec.id)) >= this.common.cfg.maxResits()) throw new ConflictException({ message: 'Resit limit for this cycle reached', code: 'RESIT_LIMIT' });
      const credits = await this.common.creditsFor(user.id, rec.subjectId, tx);
      const price = this.common.cfg.creditPrice();
      const { fee } = resitFee(credits, price, this.common.cfg.resitRatio());
      const invoice = `RST-${new Date().getUTCFullYear()}-${randomBytes(4).toString('hex').toUpperCase()}`;
      await this.common.log(tx, user, 'payment_initiated', 'ResitEligibility', rec.id, { fee, credits, price, invoice }, ctx);
      const charge = await this.provider.charge({ amount: fee, currency: 'AZN', reference: invoice, simulate: sim });
      if (charge.status === 'FAILED') {
        await tx.payment.create({ data: { studentId: user.id, amount: fee, type: 'RETAKE', status: 'FAILED', description: `25% resit — ${rec0.subject.name}`, invoiceNumber: invoice, dueDate: new Date(), providerRef: charge.providerRef } });
        await this.common.log(tx, user, 'payment_failed', 'ResitEligibility', rec.id, { invoice }, ctx, 'FAILED');
        return { ok: false as const, code: 'PAYMENT_FAILED' };
      }
      const paid = charge.status === 'PAID';
      const pay = await tx.payment.create({ data: { studentId: user.id, amount: fee, type: 'RETAKE', status: paid ? 'PAID' : 'PROCESSING', description: `25% resit — ${rec0.subject.name}`, invoiceNumber: invoice, dueDate: new Date(), paidAt: paid ? new Date() : null, providerRef: charge.providerRef } });
      await tx.resitEligibility.update({ where: { id: rec.id }, data: { status: paid ? 'PAID' : 'PAYMENT_PENDING', paymentId: pay.id, credits, creditPrice: price, feeAmount: fee } });
      await tx.subjectEnrollment.update({ where: { id: en.id }, data: { status: paid ? 'RESIT_PAID' : 'RESIT_PAYMENT_PENDING' } });
      if (paid) {
        await this.common.log(tx, user, 'payment_completed', 'Payment', pay.id, { invoice, amount: fee }, ctx);
        await this.common.log(tx, user, 'resit_granted', 'ResitEligibility', rec.id, { subjectId: rec.subjectId, cycle: rec.cycleKey }, ctx);
      }
      return { ok: true as const, status: paid ? 'PAID' : 'PAYMENT_PENDING', amount: fee, invoice };
    });
    if (!out.ok) throw new BadRequestException({ message: 'Payment failed', code: out.code });
    void this.common.notify([user.id], 'PAYMENT', { az: 'Yenidən imtahan ödənişi', ru: 'Оплата пересдачи', en: 'Resit payment' }, { az: `${rec0.subject.name}: ${out.amount} AZN`, ru: `${rec0.subject.name}: ${out.amount} AZN`, en: `${rec0.subject.name}: ${out.amount} AZN` }, 'exams');
    return out;
  }

  /** Management: список resit и платежей */
  async adminList(q: { status?: string; cycle?: string }, groups: string[] | null) {
    const rows = await this.prisma.resitEligibility.findMany({
      where: { ...(q.status ? { status: q.status as never } : {}), ...(q.cycle ? { cycleKey: q.cycle } : {}), ...(groups ? { student: { groupName: { in: groups } } } : {}) },
      orderBy: { updatedAt: 'desc' }, take: 500,
      include: { subject: { select: { code: true, name: true } }, student: { select: { groupName: true, user: { select: { fullName: true, loginId: true } } } }, payment: { select: { status: true, invoiceNumber: true, paidAt: true, amount: true } } },
    });
    return rows.map((r) => ({ id: r.id, cycle: r.cycleKey, status: r.status, credits: r.credits, fee: Number(r.feeAmount), subject: r.subject, student: { fullName: r.student.user.fullName, loginId: r.student.user.loginId, groupName: r.student.groupName }, payment: r.payment ? { status: r.payment.status, invoice: r.payment.invoiceNumber, paidAt: r.payment.paidAt, amount: Number(r.payment.amount) } : null }));
  }

  /** Возврат оплаты (только Management, с причиной). Право на resit при этом снимается. */
  async refund(actor: Actor, resitId: string, reason: string, ctx: AuditCtx) {
    const r = await this.prisma.resitEligibility.findUnique({ where: { id: resitId }, include: { enrollment: true } });
    if (!r || !r.paymentId) throw new NotFoundException('Paid resit not found');
    if (r.status === 'USED') throw new ForbiddenException({ message: 'Resit already used', code: 'RESIT_USED' });
    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({ where: { id: r.paymentId! }, data: { status: 'REFUNDED' } });
      await tx.resitEligibility.update({ where: { id: r.id }, data: { status: 'ELIGIBLE', paymentId: null } });
      if (r.enrollment.status === 'RESIT_PAID') await tx.subjectEnrollment.update({ where: { id: r.enrollmentId }, data: { status: 'RESIT_ELIGIBLE' } });
      await this.common.log(tx, actor, 'payment_refunded', 'Payment', r.paymentId!, { resitId, reason }, ctx);
    });
    return { ok: true };
  }
}


