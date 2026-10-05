import { Global, Injectable, Module } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface AuditCtx {
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditEntry {
  actorId: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  /** Значение до и после — записывается в diff.old / diff.new */
  old?: unknown;
  new?: unknown;
  extra?: Record<string, unknown>;
  result?: 'SUCCESS' | 'DENIED' | 'FAILED';
}

/** Единая запись в AuditLog для административных действий (user, action, entity, old/new, ip, result) */
@Injectable()
export class AuditTrailService {
  constructor(private readonly prisma: PrismaService) {}

  private data(e: AuditEntry, ctx: AuditCtx): Prisma.AuditLogUncheckedCreateInput {
    const diff: Record<string, unknown> = { ...(e.extra ?? {}) };
    if (e.old !== undefined) diff.old = e.old;
    if (e.new !== undefined) diff.new = e.new;
    return {
      actorId: e.actorId,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId ?? null,
      diff: diff as Prisma.InputJsonValue,
      result: e.result ?? 'SUCCESS',
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    };
  }

  record(e: AuditEntry, ctx: AuditCtx = {}) {
    return this.prisma.auditLog.create({ data: this.data(e, ctx) });
  }

  /** Внутри транзакции вызывающего кода */
  recordTx(tx: Prisma.TransactionClient, e: AuditEntry, ctx: AuditCtx = {}) {
    return tx.auditLog.create({ data: this.data(e, ctx) });
  }
}

@Global()
@Module({ providers: [AuditTrailService], exports: [AuditTrailService] })
export class AuditTrailModule {}
