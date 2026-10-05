import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { env } from '../config/env';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { PermissionsService } from '../common/rbac/permissions.service';
import { TimetableBootstrapService } from '../modules/timetable/timetable.bootstrap.service';
import { TimetableContextService } from '../modules/timetable/timetable.context.service';
import { seedDemo } from './demo-seed';
import { OrgScopeService } from '../common/rbac/org-scope.service';

// Справочники, которые создаёт миграция и которые посетитель мог изменить: при сбросе возвращаются к исходным значениям
const LESSON_TYPES = [
  { code: 'lecture', name: 'Lecture', roomTypes: ['lecture_hall', 'classroom'], color: '#2563eb', sortOrder: 1, needsRoom: true },
  { code: 'seminar', name: 'Seminar', roomTypes: ['classroom', 'seminar_room', 'lecture_hall'], color: '#7c3aed', sortOrder: 2, needsRoom: true },
  { code: 'practice', name: 'Practice', roomTypes: ['classroom', 'lab', 'computer_lab'], color: '#0891b2', sortOrder: 3, needsRoom: true },
  { code: 'lab', name: 'Laboratory', roomTypes: ['lab', 'computer_lab'], color: '#16a34a', sortOrder: 4, needsRoom: true },
  { code: 'consultation', name: 'Consultation', roomTypes: [] as string[], color: '#64748b', sortOrder: 5, needsRoom: false },
  { code: 'exam', name: 'Exam', roomTypes: [] as string[], color: '#dc2626', sortOrder: 6, needsRoom: true },
  { code: 'other', name: 'Other', roomTypes: [] as string[], color: '#94a3b8', sortOrder: 7, needsRoom: false },
];
const TIME_SLOTS = [
  ['B1', '1', '08:00', '09:20', 'BACHELOR', '1', 1], ['B2', '2', '09:35', '10:55', 'BACHELOR', '1', 2], ['B3', '3', '11:10', '12:30', 'BACHELOR', '1', 3],
  ['B4', '4', '12:45', '14:05', 'BACHELOR', '2', 4], ['B5', '5', '14:20', '15:40', 'BACHELOR', '2', 5], ['B6', '6', '15:55', '17:15', 'BACHELOR', '2', 6],
  ['M1', 'M1', '17:30', '18:50', 'MASTER', 'M', 7], ['M2', 'M2', '19:05', '20:25', 'MASTER', 'M', 8], ['M3', 'M3', '20:40', '22:00', 'MASTER', 'M', 9],
] as const;

@Injectable()
export class DemoResetService implements OnApplicationBootstrap {
  private readonly log = new Logger('DemoReset');
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionsService,
    private readonly bootstrap: TimetableBootstrapService,
    private readonly ttContext: TimetableContextService,
    private readonly org: OrgScopeService,
  ) {}

  /** Первый запуск демо-стенда: пустая база заполняется демо-данными автоматически */
  async onApplicationBootstrap() {
    if (!env.DEMO_MODE) return;
    try {
      if ((await this.prisma.user.count()) === 0) await this.reset();
    } catch (e) {
      this.log.error('Demo auto-seed failed: ' + (e as Error).message);
    }
  }

  /**
   * Полностью восстанавливает демо-базу: очищает все прикладные таблицы (миграции остаются),
   * возвращает справочники и права ролей к умолчаниям и заново создаёт демо-данные.
   * Все пользователи, сессии и изменения посетителей удаляются.
   */
  async reset() {
    if (this.running) throw new Error('RESET_IN_PROGRESS');
    this.running = true;
    const started = Date.now();
    try {
      const tables = await this.prisma.$queryRaw<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
      const list = tables.map((t) => `"${t.tablename.replace(/"/g, '')}"`).join(', ');
      await this.prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);

      await this.prisma.lessonType.createMany({ data: LESSON_TYPES });
      await this.prisma.timeSlot.createMany({
        data: TIME_SLOTS.map(([code, label, startTime, endTime, level, shift, sortOrder]) => ({ id: `ts_${code.toLowerCase()}`, code, label, startTime, endTime, level, shift, sortOrder })),
      });
      await this.perms.syncDefaults();

      const summary = await seedDemo(this.prisma, (m) => this.log.log(m));
      this.ttContext.invalidate();
      this.org.invalidate();
      await this.bootstrap.importExisting(); // опубликованная версия v1 расписания + нагрузка
      this.log.log(`Demo database restored in ${Date.now() - started} ms`);
      return { restored: true, elapsedMs: Date.now() - started, ...summary };
    } finally {
      this.running = false;
    }
  }
}