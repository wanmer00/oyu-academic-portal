import { Injectable } from '@nestjs/common';
import { AIFeature, Role } from '@prisma/client';
import { AISessionService } from '../ai-session.service';
import { subjectOutcome } from '../../students/academic.calc';
import { StudentsService } from '../../students/students.service';
import { CurrentUserData } from '../../../common/decorators/current-user.decorator';

export interface GpaWhatIfInput {
  /** Прогнозируемые оценки: subjectCode → итоговый балл (0-100) */
  forecast: Record<string, number>;
  note?: string;
}

@Injectable()
export class GpaWhatIfService {
  constructor(
    private readonly session: AISessionService,
    private readonly students: StudentsService,
  ) {}

  async run(user: CurrentUserData, input: GpaWhatIfInput, ip?: string, userAgent?: string) {
    if (user.role !== Role.STUDENT) throw new Error('Only students');
    const studentId = user.student?.userId ?? user.id;

    // Фактический GPA — из транскрипта (Academic Journal → официальная шкала портала); второй формулы GPA здесь нет
    const tr = await this.students.getTranscript(studentId);
    let totalCredits = tr.summary.totalCredits;
    let totalPoints = tr.periods.reduce((s, p) => s + p.subjects.reduce((ss, x) => ss + x.gradePoints * x.subject.credits, 0), 0);
    const bySubject: Record<string, { name: string; credits: number; latestScore: number | null }> = {};
    for (const p of tr.periods) {
      for (const x of p.subjects) bySubject[x.subject.code] = { name: x.subject.name, credits: x.subject.credits, latestScore: x.finalValue };
      for (const x of p.inProgress) bySubject[x.subject.code] ??= { name: x.subject.name, credits: x.subject.credits, latestScore: null };
    }
    const currentGpa = totalCredits > 0 ? totalPoints / totalCredits : 0;
    // With forecast
    let fCred = totalCredits;
    let fPts = totalPoints;
    const forecastRows: Array<{ code: string; name: string; credits: number; score: number }> = [];
    for (const [code, score] of Object.entries(input.forecast)) {
      const s = bySubject[code] || {
        name: code,
        credits: 3,
        latestScore: null,
      };
      fCred += s.credits;
      fPts += subjectOutcome(score).gradePoints * s.credits;
      forecastRows.push({ code, name: s.name, credits: s.credits, score });
    }
    const forecastGpa = fCred > 0 ? fPts / fCred : 0;

    const summary = [
      `Cari GPA: ${currentGpa.toFixed(2)} (${totalCredits} kredit)`,
      `Proqnoz (${forecastRows.length} yeni qiymət ilə): ${forecastGpa.toFixed(2)} (${fCred} kredit)`,
      `Dəyişmə: ${(forecastGpa - currentGpa >= 0 ? '+' : '') + (forecastGpa - currentGpa).toFixed(2)}`,
    ].join('\n');

    const system = [
      'Sən Academic Portalın GPA kalkulyatoru və akademik məsləhətçisən.',
      'Tələbəyə qısa, praktik cavab ver: mənası nədir, təqaüdə təsiri, qırmızı diplom üçün minimum lazım olan.',
      'Azərbaycan dilində, dostyana tonda. Hesablamaları aşağıda verirəm — onları qəbul et, öz hesablama aparma.',
      'Maksimum 6 bənd, qısa.',
    ].join(' ');

    const userMessage = [
      '# Faktik hesablama (sistemin verdiyi)',
      summary,
      '',
      '# Tələbə proqnozu',
      forecastRows
        .map((r) => `• ${r.name} (${r.code}, ${r.credits} kredit): ${r.score}/100`)
        .join('\n') || '(boş)',
      input.note ? `\n# Əlavə qeyd:\n${input.note}` : '',
    ].join('\n');

    const res = await this.session.runAndLog({
      userId: user.id,
      feature: AIFeature.GPA_WHATIF,
      title: `GPA what-if: ${forecastRows.length} qiymət`,
      system,
      userMessage,
      ip,
      userAgent,
    });

    return {
      ...res,
      currentGpa: Number(currentGpa.toFixed(3)),
      forecastGpa: Number(forecastGpa.toFixed(3)),
      delta: Number((forecastGpa - currentGpa).toFixed(3)),
      totalCredits,
      forecastCredits: fCred,
    };
  }
}
