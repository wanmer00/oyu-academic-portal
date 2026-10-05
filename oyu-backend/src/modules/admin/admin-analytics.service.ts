import { attendanceRate } from '../attendance/attendance.calc';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { recordPercents } from '../journal/journal.calc';

/**
 * Admin analytics — карта рисков по группам, прогноз отчисления,
 * эффективность преподавателей, финансовый обзор.
 */
@Injectable()
export class AdminAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────────────────────────────────────────
  // 68. Heatmap групп факультета: средняя оценка / посещаемость / риск
  // ─────────────────────────────────────────────────────────────
  async groupHeatmap() {
    const students = await this.prisma.student.findMany({
      include: {
        grades: { where: { type: { in: ['SEMINAR', 'MIDTERM', 'FINAL'] }, publishedAt: { not: null } }, select: { id: true, type: true, value: true, publishedAt: true, createdAt: true, updatedAt: true, subjectId: true, academicYear: true, term: true } },
        attendance: { select: { status: true, subjectId: true } },
        payments: { select: { amount: true, status: true } },
      },
    });

    const byGroup = new Map<string, {
      groupName: string;
      faculty: string;
      level: string;
      studentsCount: number;
      avgPct: number;
      avgAttendancePct: number;
      lowGradeStudents: number;
      attendanceRiskStudents: number;
      debtTotalAzn: number;
      riskScore: number;
    }>();

    for (const s of students) {
      const key = s.groupName;
      let bucket = byGroup.get(key);
      if (!bucket) {
        bucket = {
          groupName: s.groupName,
          faculty: s.faculty,
          level: s.level,
          studentsCount: 0,
          avgPct: 0,
          avgAttendancePct: 0,
          lowGradeStudents: 0,
          attendanceRiskStudents: 0,
          debtTotalAzn: 0,
          riskScore: 0,
        };
        byGroup.set(key, bucket);
      }
      bucket.studentsCount++;

      // grade %
      const gPcts = recordPercents(s.grades);
      const studentAvgPct = gPcts.length ? gPcts.reduce((a, b) => a + b, 0) / gPcts.length : null;
      if (studentAvgPct !== null) {
        bucket.avgPct += studentAvgPct;
        if (studentAvgPct < 60) bucket.lowGradeStudents++;
      }

      // attendance %
      const attTotal = s.attendance.length;
      const attMissed = s.attendance.filter((a) => a.status === 'ABSENT').length;
      const studentAttPct = attendanceRate({ total: attTotal, ABSENT: attMissed }) ?? 100;
      bucket.avgAttendancePct += studentAttPct;
      if (studentAttPct < 75) bucket.attendanceRiskStudents++;

      // debt
      bucket.debtTotalAzn += s.payments
        .filter((p) => p.status === 'PENDING' || p.status === 'PROCESSING' || p.status === 'FAILED')
        .reduce((a, p) => a + Number(p.amount), 0);
    }

    const result = Array.from(byGroup.values()).map((g) => {
      const avgPct = g.studentsCount > 0 ? Math.round(g.avgPct / g.studentsCount) : 0;
      const avgAtt = g.studentsCount > 0 ? Math.round(g.avgAttendancePct / g.studentsCount) : 0;
      // Risk score 0..100 — взвешенно
      const lowRatio = g.lowGradeStudents / g.studentsCount;
      const attRatio = g.attendanceRiskStudents / g.studentsCount;
      const debtNorm = Math.min(1, g.debtTotalAzn / (g.studentsCount * 1000));
      const risk = Math.round((lowRatio * 50 + attRatio * 35 + debtNorm * 15) * 100) / 100 * 100;
      return { ...g, avgPct, avgAttendancePct: avgAtt, riskScore: Math.min(100, Math.round(risk)) };
    });
    result.sort((a, b) => b.riskScore - a.riskScore);
    return { groups: result };
  }

  // ─────────────────────────────────────────────────────────────
  // 69. Dropout-risk: индивидуальный прогноз отчисления
  // ─────────────────────────────────────────────────────────────
  async dropoutRisk(minScore = 40) {
    const students = await this.prisma.student.findMany({
      include: {
        user: { select: { id: true, loginId: true, fullName: true, email: true, status: true } },
        grades: { where: { type: { in: ['SEMINAR', 'MIDTERM', 'FINAL'] }, publishedAt: { not: null } }, select: { id: true, type: true, value: true, publishedAt: true, createdAt: true, updatedAt: true, subjectId: true, academicYear: true, term: true } },
        attendance: { select: { status: true } },
        payments: { select: { amount: true, status: true } },
      },
    });

    const items = students.map((s) => {
      const gPcts = recordPercents(s.grades);
      const avgPct = gPcts.length ? gPcts.reduce((a, b) => a + b, 0) / gPcts.length : 0;
      const lowGrades = gPcts.filter((p) => p < 60).length;

      const attTotal = s.attendance.length;
      const attMissed = s.attendance.filter((a) => a.status === 'ABSENT').length;
      const attPct = attendanceRate({ total: attTotal, ABSENT: attMissed }) ?? 100;

      const debt = s.payments
        .filter((p) => p.status === 'PENDING' || p.status === 'PROCESSING' || p.status === 'FAILED')
        .reduce((a, p) => a + Number(p.amount), 0);

      const reasons: string[] = [];
      let score = 0;

      // GPA-фактор
      if (avgPct > 0 && avgPct < 60) { score += 35; reasons.push(`Aşağı orta bal: ${Math.round(avgPct)}%`); }
      else if (avgPct < 70 && avgPct > 0) { score += 18; reasons.push(`Orta bal aşağı: ${Math.round(avgPct)}%`); }

      // Низкие оценки
      if (lowGrades >= 3) { score += 20; reasons.push(`${lowGrades} fəndə qeyri-kafi`); }
      else if (lowGrades >= 1) { score += 8; reasons.push(`${lowGrades} fəndə qeyri-kafi`); }

      // Посещаемость
      if (attPct < 60) { score += 25; reasons.push(`Davamiyyət ${Math.round(attPct)}%`); }
      else if (attPct < 75) { score += 12; reasons.push(`Davamiyyət ${Math.round(attPct)}%`); }

      // Долг
      if (debt > 1500) { score += 15; reasons.push(`Ödəniş borcu: ${debt.toFixed(0)} AZN`); }
      else if (debt > 500) { score += 7; reasons.push(`Ödəniş borcu: ${debt.toFixed(0)} AZN`); }

      score = Math.min(100, score);

      return {
        userId: s.userId,
        loginId: s.user.loginId,
        fullName: s.user.fullName,
        email: s.user.email,
        groupName: s.groupName,
        course: s.course,
        semester: s.semester,
        avgGradePct: Math.round(avgPct),
        attendancePct: Math.round(attPct),
        lowGradesCount: lowGrades,
        debtAzn: Math.round(debt),
        riskScore: score,
        reasons,
      };
    });

    items.sort((a, b) => b.riskScore - a.riskScore);
    return { items: items.filter((x) => x.riskScore >= minScore) };
  }

  // ─────────────────────────────────────────────────────────────
  // 71. Teacher effectiveness — оценки и посещаемость по предметам препода
  // ─────────────────────────────────────────────────────────────
  async teacherStats() {
    const teachers = await this.prisma.teacher.findMany({
      include: {
        user: { select: { loginId: true, fullName: true } },
        scheduleSlots: { select: { subjectId: true, groupName: true } },
        gradesGiven: { where: { type: { in: ['SEMINAR', 'MIDTERM', 'FINAL'] }, publishedAt: { not: null } }, select: { id: true, type: true, value: true, publishedAt: true, createdAt: true, updatedAt: true, subjectId: true, academicYear: true, term: true, studentId: true } },
        assignments: { select: { id: true } },
      },
    });

    // Map subjectId → attendance grouped by teacher's subjects
    const subjectIds = new Set<string>();
    teachers.forEach((t) => t.scheduleSlots.forEach((s) => subjectIds.add(s.subjectId)));
    const attendanceBySubject = await this.prisma.attendance.groupBy({
      by: ['subjectId', 'status'],
      where: { subjectId: { in: Array.from(subjectIds) } },
      _count: { _all: true },
    });
    const attMap = new Map<string, { total: number; absent: number }>();
    for (const row of attendanceBySubject) {
      const cur = attMap.get(row.subjectId) || { total: 0, absent: 0 };
      cur.total += row._count._all;
      if (row.status === 'ABSENT') cur.absent += row._count._all;
      attMap.set(row.subjectId, cur);
    }

    const items = teachers.map((t) => {
      const groupSet = new Set(t.scheduleSlots.map((s) => s.groupName));
      const subjSet = new Set(t.scheduleSlots.map((s) => s.subjectId));
      const gPcts = recordPercents(t.gradesGiven);
      const avgGivenPct = gPcts.length ? Math.round(gPcts.reduce((a, b) => a + b, 0) / gPcts.length) : null;
      const lowSharePct = gPcts.length ? Math.round(gPcts.filter((p) => p < 60).length / gPcts.length * 100) : 0;

      let attTotal = 0, attAbsent = 0;
      for (const subjId of subjSet) {
        const e = attMap.get(subjId);
        if (e) { attTotal += e.total; attAbsent += e.absent; }
      }
      const attPct = attendanceRate({ total: attTotal, ABSENT: attAbsent });

      // эффективность: высокий avg + низкая доля плохих + высокая посещаемость
      let eff = 50;
      if (avgGivenPct !== null) eff += (avgGivenPct - 70) * 0.5;
      if (attPct !== null) eff += (attPct - 75) * 0.4;
      eff -= lowSharePct * 0.3;
      eff = Math.max(0, Math.min(100, Math.round(eff)));

      return {
        loginId: t.user.loginId,
        fullName: t.user.fullName,
        department: t.department,
        title: t.title,
        experience: t.experience,
        subjectsCount: subjSet.size,
        groupsCount: groupSet.size,
        gradesGivenCount: t.gradesGiven.length,
        avgGivenPct,
        lowGradeSharePct: lowSharePct,
        attendancePct: attPct,
        assignmentsCount: t.assignments.length,
        effectivenessScore: eff,
      };
    });
    items.sort((a, b) => b.effectivenessScore - a.effectivenessScore);
    return { items };
  }

  // ─────────────────────────────────────────────────────────────
  // 74. Payments overview — общая картина по оплатам
  // ─────────────────────────────────────────────────────────────
  async paymentsOverview() {
    const all = await this.prisma.payment.findMany({
      include: {
        student: {
          include: {
            user: { select: { loginId: true, fullName: true } },
          },
        },
      },
    });

    let paid = 0, pending = 0, processing = 0, failed = 0;
    let paidSum = 0, pendingSum = 0, processingSum = 0, failedSum = 0;
    const byGroup = new Map<string, { groupName: string; total: number; paid: number; debt: number; debtors: number }>();
    const debtorSet = new Set<string>();
    const debtors: Array<{ loginId: string; fullName: string; groupName: string; debtAzn: number }> = [];
    const debtByUser = new Map<string, { loginId: string; fullName: string; groupName: string; debtAzn: number }>();

    for (const p of all) {
      const amt = Number(p.amount);
      const grp = p.student.groupName;
      let g = byGroup.get(grp);
      if (!g) { g = { groupName: grp, total: 0, paid: 0, debt: 0, debtors: 0 }; byGroup.set(grp, g); }
      g.total += amt;

      if (p.status === 'PAID') { paid++; paidSum += amt; g.paid += amt; }
      else if (p.status === 'PROCESSING') { processing++; processingSum += amt; }
      else if (p.status === 'PENDING') { pending++; pendingSum += amt; }
      else if (p.status === 'FAILED') { failed++; failedSum += amt; }

      if (p.status === 'PENDING' || p.status === 'PROCESSING' || p.status === 'FAILED') {
        g.debt += amt;
        const uid = p.student.userId;
        if (!debtorSet.has(uid)) { debtorSet.add(uid); g.debtors++; }
        const cur = debtByUser.get(uid);
        if (cur) cur.debtAzn += amt;
        else debtByUser.set(uid, {
          loginId: p.student.user.loginId,
          fullName: p.student.user.fullName,
          groupName: grp,
          debtAzn: amt,
        });
      }
    }
    debtors.push(...Array.from(debtByUser.values()).sort((a, b) => b.debtAzn - a.debtAzn));

    return {
      summary: {
        totalCount: all.length,
        totalAzn: Math.round(paidSum + pendingSum + processingSum + failedSum),
        paidAzn: Math.round(paidSum),
        debtAzn: Math.round(pendingSum + processingSum + failedSum),
        paidCount: paid,
        pendingCount: pending,
        processingCount: processing,
        failedCount: failed,
        debtorsCount: debtorSet.size,
      },
      byGroup: Array.from(byGroup.values())
        .map((g) => ({ ...g, total: Math.round(g.total), paid: Math.round(g.paid), debt: Math.round(g.debt) }))
        .sort((a, b) => b.debt - a.debt),
      topDebtors: debtors.slice(0, 20).map((d) => ({ ...d, debtAzn: Math.round(d.debtAzn) })),
    };
  }

  // ─────────────────────────────────────────────────────────────
  // 82a. Schedule conflicts — глобальный список конфликтов в текущем расписании
  // ─────────────────────────────────────────────────────────────
  async scheduleConflicts(academicYear?: string, term?: 'FALL' | 'SPRING' | 'SUMMER') {
    const where: any = {};
    if (academicYear) where.academicYear = academicYear;
    if (term) where.term = term;
    const slots = await this.prisma.scheduleSlot.findMany({
      where,
      include: {
        subject: { select: { code: true, name: true } },
        teacher: { include: { user: { select: { fullName: true } } } },
      },
    });

    type SlotL = typeof slots[number];
    const overlaps = (a: SlotL, b: SlotL): boolean =>
      a.dayOfWeek === b.dayOfWeek &&
      a.academicYear === b.academicYear &&
      a.term === b.term &&
      // weekParity intersect
      (a.weekParity === 'BOTH' || b.weekParity === 'BOTH' || a.weekParity === b.weekParity) &&
      a.startTime < b.endTime && b.startTime < a.endTime;

    const conflicts: Array<{ kind: string; aId: string; bId: string; details: string }> = [];
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const a = slots[i], b = slots[j];
        if (!overlaps(a, b)) continue;
        if (a.teacherId && a.teacherId === b.teacherId) {
          conflicts.push({ kind: 'TEACHER', aId: a.id, bId: b.id, details: `Müəllim ${a.teacher?.user.fullName} eyni vaxt: ${a.subject.code} (${a.groupName}) ↔ ${b.subject.code} (${b.groupName})` });
        }
        if (a.roomId && a.roomId === b.roomId) {
          conflicts.push({ kind: 'ROOM', aId: a.id, bId: b.id, details: `Otaq ${a.room} eyni vaxt: ${a.subject.code} ↔ ${b.subject.code}` });
        }
        if (a.groupName === b.groupName) {
          conflicts.push({ kind: 'GROUP', aId: a.id, bId: b.id, details: `Qrup ${a.groupName} eyni vaxt: ${a.subject.code} ↔ ${b.subject.code}` });
        }
      }
    }
    return { count: conflicts.length, conflicts };
  }
}
