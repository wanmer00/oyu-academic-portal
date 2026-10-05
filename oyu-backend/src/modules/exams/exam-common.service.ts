import { Injectable } from '@nestjs/common';
import { Prisma, Term } from '@prisma/client';
import { AuditCtx, AuditTrailService } from '../../common/audit/audit-trail.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SettingsService } from '../admin/settings.service';
import { NotificationsService, L10n } from '../notifications/notifications.service';
import { summarizeSubject } from '../journal/journal.calc';
import { cycleKey, EXAM_RULES } from './exam.rules';

export type Tx = Prisma.TransactionClient;
export interface Actor { id: string; role?: string }

/** Общие помощники Exam System: аудит, настройки, Entry Score, запись итога в Journal, уведомления */
@Injectable()
export class ExamCommon {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditTrail: AuditTrailService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  cfg = {
    creditPrice: () => this.settings.get('exam.creditPrice'),
    resitRatio: () => this.settings.get('exam.resitFeeRatio'),
    maxResits: () => this.settings.get('exam.maxResitsPerCycle'),
    duration: () => this.settings.get('exam.durationMinutes'),
    tokenTtl: () => this.settings.get('exam.tokenTtlSeconds'),
    instantResult: () => this.settings.get('exam.instantResult') >= 1,
    appealDelayHours: () => this.settings.get('exam.appealDelayHours'),
    appealWindowHours: () => this.settings.get('exam.appealWindowHours'),
    passTotal: () => this.settings.passMark,
    minExam: () => EXAM_RULES.MIN_EXAM_SCORE,
  };

  /** Запись в AuditLog (внутри транзакции, если передан tx). Обязательные события: действие, пользователь, сущность, метаданные */
  log(tx: Tx | null, actor: Actor | null, action: string, entity: string, entityId: string | null, meta: Record<string, unknown> = {}, ctx: AuditCtx = {}, result: 'SUCCESS' | 'DENIED' | 'FAILED' = 'SUCCESS') {
    const entry = { actorId: actor?.id ?? null, action: `exam.${action}`, targetType: entity, targetId: entityId, extra: { ...meta, ...(actor?.role ? { role: actor.role } : {}) }, result };
    return tx ? this.auditTrail.recordTx(tx, entry, ctx) : this.auditTrail.record(entry, ctx);
  }

  notify(userIds: string[], type: 'ACADEMIC' | 'PAYMENT' | 'ADMINISTRATIVE', title: L10n, message: L10n, link?: string) {
    return this.notifications.notify(userIds, { type, title, message, link }).catch(() => undefined);
  }

  /** Текущий учебный год по календарю: сентябрь–август */
  academicYearOf(d: Date): string {
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    const s = m >= 9 ? y : y - 1;
    return `${s}-${s + 1}`;
  }
  startYear = (academicYear: string) => Number(academicYear.slice(0, 4));

  cycleOf(e: { academicYear: string; term: Term | string }) { return cycleKey(e.academicYear, String(e.term)); }

  /**
   * Entry Score = MIDTERM + SEMINAR (0..50) по опубликованным строкам Journal за период.
   * null — нет Midterm или недостаточно семинарских ответов (< 3): допуск невозможен.
   */
  async entryScore(studentId: string, subjectId: string, academicYear: string, term: Term, db: Tx | PrismaService = this.prisma): Promise<number | null> {
    const rows = await db.grade.findMany({
      where: { studentId, subjectId, academicYear, term, publishedAt: { not: null }, type: { in: ['MIDTERM', 'SEMINAR'] } },
      select: { id: true, type: true, value: true, publishedAt: true, createdAt: true, updatedAt: true },
    });
    const s = summarizeSubject(rows as never);
    if (!s.midterm || !s.seminar.eligible || s.seminar.score == null) return null;
    return Math.round((s.midterm.score + s.seminar.score) * 100) / 100;
  }

  /** Кредиты предмета для студента: из учебного плана его специальности, иначе поле Subject.credits */
  async creditsFor(studentId: string, subjectId: string, db: Tx | PrismaService = this.prisma): Promise<number> {
    const st = await db.student.findUnique({ where: { userId: studentId }, select: { groupName: true } });
    const item = st ? await db.curriculumItem.findFirst({ where: { subjectId, specialty: { groups: { some: { name: st.groupName } } } }, select: { credits: true } }) : null;
    if (item) return item.credits;
    const s = await db.subject.findUnique({ where: { id: subjectId }, select: { credits: true } });
    return s?.credits ?? 0;
  }

  /**
   * Итог экзамена → Academic Journal как компонент FINAL (0..50). Выполняется системой, ручной ввод FINAL для таких предметов закрыт.
   * Период Journal может быть закрыт (resit летом) — запись идёт в обход блокировки, с историей изменения.
   */
  async writeFinalToJournal(tx: Tx, p: { studentId: string; subjectId: string; academicYear: string; term: Term; semester: number; examScore: number; reason: string }) {
    const value = Math.max(0, Math.min(EXAM_RULES.MAX_EXAM_SCORE, p.examScore));
    const existing = await tx.grade.findFirst({ where: { studentId: p.studentId, subjectId: p.subjectId, academicYear: p.academicYear, term: p.term, type: 'FINAL' }, orderBy: { updatedAt: 'desc' } });
    if (existing) {
      if (Number(existing.value) !== value || !existing.publishedAt) {
        await tx.gradeHistory.create({ data: { gradeId: existing.id, oldValue: existing.value, newValue: value, changedBy: 'system:exam', reason: p.reason } });
        await tx.grade.update({ where: { id: existing.id }, data: { value, publishedAt: existing.publishedAt ?? new Date(), publishedBy: 'system:exam', teacherId: null } });
      }
      return;
    }
    await tx.grade.create({ data: { studentId: p.studentId, subjectId: p.subjectId, teacherId: null, value, maxValue: 50, type: 'FINAL', comment: 'Exam System', academicYear: p.academicYear, term: p.term, semester: p.semester, publishedAt: new Date(), publishedBy: 'system:exam' } });
  }

  /** Студент входит в область окна? Пустой список scopes — все студенты */
  async inScope(windowId: string, studentId: string, db: Tx | PrismaService = this.prisma): Promise<boolean> {
    const scopes = await db.examWindowScope.findMany({ where: { windowId } });
    if (!scopes.length) return true;
    const st = await db.student.findUnique({ where: { userId: studentId }, select: { groupName: true } });
    if (!st) return false;
    const g = await db.academicGroup.findUnique({ where: { name: st.groupName }, select: { name: true, specialtyId: true, specialty: { select: { department: { select: { facultyId: true } } } } } });
    if (!g) return false;
    return scopes.some((s) => (s.groupName && s.groupName === g.name) || (s.specialtyId && s.specialtyId === g.specialtyId) || (s.facultyId && s.facultyId === g.specialty.department.facultyId));
  }

  /** Блокировка строки студента внутри транзакции — сериализует конкурентные авторизации / оплаты одного студента */
  lockStudent(tx: Tx, studentId: string) {
    return tx.$queryRaw`SELECT "userId" FROM "Student" WHERE "userId" = ${studentId} FOR UPDATE`;
  }
}
