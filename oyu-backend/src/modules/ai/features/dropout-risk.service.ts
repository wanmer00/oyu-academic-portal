import { attendanceRate } from '../../attendance/attendance.calc';
import { Injectable } from '@nestjs/common';
import { recordPercents } from '../../journal/journal.calc';
import { AIFeature } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AISessionService } from '../ai-session.service';
import { CurrentUserData } from '../../../common/decorators/current-user.decorator';

export interface DropoutRiskInput {
  minRiskScore?: number; // 0-100 порог
  focusCourse?: number;
}

@Injectable()
export class DropoutRiskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly session: AISessionService,
  ) {}

  async run(user: CurrentUserData, input: DropoutRiskInput, ip?: string, userAgent?: string) {
    // доступ проверяет контроллер по праву reports.view (scope ALL)

    // Агрегация факторов риска для каждого студента:
    // - avg score < 55 → +30
    // - attendance < 60% → +25
    // - overdue payment → +20
    // - grade trend downward → +15
    // - repeated failing requests → +10
    const students = await this.prisma.student.findMany({
      where: input.focusCourse ? { course: input.focusCourse } : {},
      include: {
        user: { select: { loginId: true, fullName: true } },
        grades: { where: { type: { in: ['SEMINAR', 'MIDTERM', 'FINAL'] }, publishedAt: { not: null } }, select: { id: true, type: true, value: true, publishedAt: true, createdAt: true, updatedAt: true, subjectId: true, academicYear: true, term: true } },
        attendance: { select: { status: true } },
      },
      take: 300,
    });

    const scored: Array<{
      loginId: string;
      fullName: string;
      score: number;
      reasons: string[];
    }> = [];

    for (const s of students) {
      const reasons: string[] = [];
      let score = 0;

      // средняя успеваемость по записям Journal (%), а не по сырым строкам разных шкал
      const scores = recordPercents(s.grades);
      const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
      if (avg != null && avg < 55) {
        score += 30;
        reasons.push(`orta bal ${avg.toFixed(1)} < 55`);
      } else if (avg != null && avg < 65) {
        score += 15;
        reasons.push(`orta bal ${avg.toFixed(1)} aşağıdır`);
      }

      if (s.attendance.length > 5) {
        // единое правило Academic Journal → Attendance: (занятий − ABSENT) / занятий
        const rate = (attendanceRate({ total: s.attendance.length, ABSENT: s.attendance.filter((a) => a.status === 'ABSENT').length }) ?? 100) / 100;
        if (rate < 0.6) {
          score += 25;
          reasons.push(`davamiyyət ${Math.round(rate * 100)}% < 60%`);
        } else if (rate < 0.75) {
          score += 10;
          reasons.push(`davamiyyət ${Math.round(rate * 100)}%`);
        }
      }

      // Просроченные платежи: PENDING у которых dueDate в прошлом (или FAILED)
      const now = new Date();
      const overdue = await this.prisma.payment.count({
        where: {
          studentId: s.userId,
          OR: [
            { status: 'FAILED' },
            { status: 'PENDING', dueDate: { lt: now } },
          ],
        },
      });
      if (overdue > 0) {
        score += 20;
        reasons.push(`${overdue} gecikmiş ödəniş`);
      }

      if (score >= (input.minRiskScore ?? 30)) {
        scored.push({
          loginId: s.user.loginId,
          fullName: s.user.fullName,
          score,
          reasons,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 20);

    const system = [
      'Sən deakanlıq üçün tələbə risk analitikisən.',
      'Aşağıda tələbələrin risk xalı və səbəbləri verilib — onlara əsaslanaraq qısa, əməli tövsiyələr ver.',
      'Çıxış formatı — markdown: hər tələbə üçün 1-2 cümləlik risk təsviri + konkret tövsiyə (fərdi görüş, maliyyə dəstəyi, akademik dəstək və s.).',
      'Ümumi statistika ilə başla (neçə yüksək, orta, aşağı risk).',
    ].join(' ');

    const userMessage = [
      `# Analiz ediləcək tələbələr (${top.length} ən risqli):`,
      ...top.map(
        (s) => `• ${s.fullName} (${s.loginId}) — risk: ${s.score}/100. Səbəblər: ${s.reasons.join('; ') || '—'}`,
      ),
    ].join('\n');

    const res = await this.session.runAndLog({
      userId: user.id,
      feature: AIFeature.DROPOUT_ANALYSIS,
      title: `Dropout risk: ${top.length} tələbə`,
      system,
      userMessage,
      ip,
      userAgent,
      maxTokens: 2000,
    });

    return {
      ...res,
      atRisk: top,
      summary: {
        totalAnalyzed: students.length,
        highRisk: top.filter((s) => s.score >= 60).length,
        mediumRisk: top.filter((s) => s.score >= 30 && s.score < 60).length,
      },
    };
  }
}
