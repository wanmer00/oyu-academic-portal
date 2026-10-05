import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export const AUDIT_CATEGORIES: Record<string, string[]> = {
  grade: ['journal.grade_create', 'journal.grade_update', 'journal.grade_delete', 'grade.create', 'grade.update', 'grade.bulk'],
  seminar: ['journal.seminar_add', 'journal.seminar_update', 'journal.seminar_delete'],
  attendance: ['attendance.mark', 'attendance.delete', 'attendance.export'],
  publish: ['journal.publish', 'journal.unpublish'],
  period: ['journal.period_close', 'journal.period_open'],
  export: ['journal.export', 'grade.export'],
};
const ALL_ACTIONS = Object.values(AUDIT_CATEGORIES).flat();
const categoryOf = (action: string) => Object.entries(AUDIT_CATEGORIES).find(([, v]) => v.includes(action))?.[0] ?? 'other';

/**
 * Read-only аудит академических записей (право audit.view).
 * Использует существующий AuditLog (второй аудит-системы нет).
 * Возвращает только метаданные изменений (кто/что/когда/старое/новое/причина), не оценки студентов «как таковые».
 */
@Injectable()
export class JournalAuditService {
  constructor(private readonly prisma: PrismaService) {}

  private where(q: { category?: string; actor?: string; student?: string; subject?: string; from?: string; to?: string }): Prisma.AuditLogWhereInput {
    const and: Prisma.AuditLogWhereInput[] = [];
    and.push({ action: { in: q.category ? AUDIT_CATEGORIES[q.category] ?? [] : ALL_ACTIONS } });
    if (q.actor) and.push({ actor: { OR: [{ loginId: { contains: q.actor } }, { fullName: { contains: q.actor, mode: 'insensitive' } }] } });
    if (q.student) and.push({ OR: [{ diff: { path: ['studentLoginId'], equals: q.student } }, { diff: { path: ['studentName'], string_contains: q.student } }] });
    if (q.subject) and.push({ diff: { path: ['subjectCode'], equals: q.subject } });
    if (q.from || q.to) and.push({ createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } });
    return { AND: and };
  }

  async feed(q: { category?: string; actor?: string; student?: string; subject?: string; from?: string; to?: string; page: number; pageSize: number }) {
    const where = this.where(q);
    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        include: { actor: { select: { loginId: true, fullName: true, role: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return {
      page: q.page,
      pageSize: q.pageSize,
      total,
      items: rows.map((e) => {
        const d = (e.diff ?? {}) as Record<string, any>;
        return {
          id: e.id,
          at: e.createdAt.toISOString(),
          action: e.action,
          category: categoryOf(e.action),
          actor: e.actor ? { loginId: e.actor.loginId, fullName: e.actor.fullName, role: e.actor.role } : null,
          entity: {
            student: d.studentLoginId ? { loginId: d.studentLoginId, fullName: d.studentName ?? null } : null,
            subjectCode: d.subjectCode ?? null,
            groupName: d.groupName ?? null,
            component: d.component ?? d.type ?? null,
            academicYear: d.academicYear ?? null,
            term: d.term ?? null,
            gradeId: d.gradeId ?? e.targetId ?? null,
          },
          old: d.old ?? d.oldValue ?? null,
          new: d.new ?? d.newValue ?? d.value ?? (d.byStatus ? JSON.stringify(d.byStatus) : null),
          max: d.max ?? null,
          reason: d.reason ?? null,
          published: d.published ?? null,
          bulk: !!d.bulk,
          count: d.count ?? d.grades ?? null,
          ip: e.ip,
        };
      }),
    };
  }

  async stats() {
    const since = new Date(Date.now() - 7 * 86400_000);
    const base: Prisma.AuditLogWhereInput = { createdAt: { gte: since } };
    const [byAction, afterPublish, actors, unpublish] = await Promise.all([
      this.prisma.auditLog.groupBy({ by: ['action'], where: { ...base, action: { in: ALL_ACTIONS } }, _count: { _all: true } }),
      this.prisma.auditLog.count({ where: { ...base, action: { in: ['journal.grade_update', 'journal.seminar_update', 'journal.grade_delete', 'journal.seminar_delete'] }, diff: { path: ['published'], equals: true } } }),
      this.prisma.auditLog.groupBy({ by: ['actorId'], where: { ...base, action: { in: ALL_ACTIONS } } }),
      this.prisma.auditLog.count({ where: { ...base, action: 'journal.unpublish' } }),
    ]);
    const cats: Record<string, number> = {};
    for (const a of byAction) cats[categoryOf(a.action)] = (cats[categoryOf(a.action)] ?? 0) + a._count._all;
    return {
      windowDays: 7,
      total: byAction.reduce((s, a) => s + a._count._all, 0),
      byCategory: cats,
      changesAfterPublish: afterPublish,
      unpublished: unpublish,
      actors: actors.length,
    };
  }
}
