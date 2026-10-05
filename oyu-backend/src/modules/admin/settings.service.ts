import { BadRequestException, Global, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditCtx, AuditTrailService } from '../../common/audit/audit-trail.service';
import { env } from '../../config/env';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface SettingDef {
  key: string;
  type: 'number';
  min: number;
  max: number;
  default: number;
  unit?: string;
}

/** Системные настройки, реально используемые кодом. Значение по умолчанию — из env; строка в SystemSetting его переопределяет. */
export const SETTING_DEFS: SettingDef[] = [
  { key: 'journal.passMark', type: 'number', min: 0, max: 100, default: env.JOURNAL_PASS_MARK, unit: 'points' },
  { key: 'journal.lowAttendance', type: 'number', min: 0, max: 100, default: env.JOURNAL_LOW_ATTENDANCE, unit: '%' },
  // Exam Management System
  { key: 'exam.creditPrice', type: 'number', min: 0, max: 1000, default: 15, unit: 'AZN' },
  { key: 'exam.resitFeeRatio', type: 'number', min: 0, max: 1, default: 0.25, unit: 'ratio' },
  { key: 'exam.maxResitsPerCycle', type: 'number', min: 0, max: 10, default: 2, unit: 'exams' },
  { key: 'exam.durationMinutes', type: 'number', min: 10, max: 480, default: 120, unit: 'min' },
  { key: 'exam.tokenTtlSeconds', type: 'number', min: 30, max: 3600, default: 300, unit: 's' },
  { key: 'exam.instantResult', type: 'number', min: 0, max: 1, default: 1, unit: 'flag' },
  // Окно апелляции: открывается через N часов после публикации результата и длится M часов
  { key: 'exam.appealDelayHours', type: 'number', min: 0, max: 720, default: 0, unit: 'h' },
  { key: 'exam.appealWindowHours', type: 'number', min: 1, max: 2160, default: 72, unit: 'h' },
];
const DEF = new Map(SETTING_DEFS.map((d) => [d.key, d]));

@Injectable()
export class SettingsService implements OnModuleInit {
  private values = new Map<string, number>();
  private loadedAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditTrailService,
  ) {}

  async onModuleInit() {
    await this.reload();
  }

  async reload() {
    const rows = await this.prisma.systemSetting.findMany({ where: { key: { in: SETTING_DEFS.map((d) => d.key) } } });
    const next = new Map<string, number>();
    for (const d of SETTING_DEFS) next.set(d.key, d.default);
    for (const r of rows) if (typeof r.value === 'number' && DEF.has(r.key)) next.set(r.key, r.value);
    this.values = next;
    this.loadedAt = Date.now();
  }

  private num(key: string): number {
    // синхронный доступ из расчётов журнала; обновляется при изменении и раз в 30 с
    if (Date.now() - this.loadedAt > 30_000) void this.reload().catch(() => undefined);
    return this.values.get(key) ?? DEF.get(key)!.default;
  }

  get passMark() { return this.num('journal.passMark'); }
  get lowAttendance() { return this.num('journal.lowAttendance'); }
  /** Числовая настройка по ключу (в т.ч. exam.*) */
  get(key: string): number { return this.num(key); }

  async list() {
    await this.reload();
    const rows = await this.prisma.systemSetting.findMany({ where: { key: { in: SETTING_DEFS.map((d) => d.key) } } });
    const meta = new Map(rows.map((r) => [r.key, r]));
    return SETTING_DEFS.map((d) => ({
      key: d.key, type: d.type, min: d.min, max: d.max, unit: d.unit ?? null, default: d.default,
      value: this.values.get(d.key)!, overridden: meta.has(d.key), updatedAt: meta.get(d.key)?.updatedAt ?? null,
    }));
  }

  async set(actorId: string, key: string, value: number, ctx: AuditCtx) {
    const d = DEF.get(key);
    if (!d) throw new BadRequestException({ message: 'Unknown setting', code: 'UNKNOWN_SETTING' });
    if (typeof value !== 'number' || !Number.isFinite(value) || value < d.min || value > d.max) {
      throw new BadRequestException({ message: `Value must be between ${d.min} and ${d.max}`, code: 'SETTING_OUT_OF_RANGE' });
    }
    const old = this.values.get(key) ?? d.default;
    await this.prisma.$transaction(async (tx) => {
      await tx.systemSetting.upsert({ where: { key }, create: { key, value, updatedBy: actorId }, update: { value, updatedBy: actorId } });
      await this.audit.recordTx(tx as Prisma.TransactionClient, { actorId, action: 'settings.update', targetType: 'SystemSetting', targetId: key, old, new: value }, ctx);
    });
    await this.reload();
    return { key, value };
  }
}

@Global()
@Module({ providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}
