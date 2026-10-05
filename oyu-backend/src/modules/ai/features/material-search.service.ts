import { Injectable } from '@nestjs/common';
import { AIFeature, Role } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AISessionService } from '../ai-session.service';
import { CurrentUserData } from '../../../common/decorators/current-user.decorator';

export interface MaterialSearchInput {
  query: string;
  subjectCode?: string;
}

/**
 * Simple-RAG (variant B) — отдаём Claude список материалов студента
 * и просим найти наиболее релевантные по семантике к запросу.
 * Никаких embeddings, pgvector — пока работает пока материалов <~200.
 */
@Injectable()
export class MaterialSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly session: AISessionService,
  ) {}

  async run(user: CurrentUserData, input: MaterialSearchInput, ip?: string, userAgent?: string) {
    if (user.role !== Role.STUDENT) throw new Error('Only students');
    const studentId = user.student?.userId ?? user.id;

    // Материалы по курсам этого студента (через его оценки / расписание)
    const where: any = {};
    if (input.subjectCode) where.subject = { code: input.subjectCode };
    else {
      // все предметы студента
      const grades = await this.prisma.grade.findMany({
        where: { studentId, publishedAt: { not: null } },
        select: { subjectId: true },
        distinct: ['subjectId'],
      });
      where.subjectId = { in: grades.map((g) => g.subjectId) };
    }

    const materials = await this.prisma.material.findMany({
      where,
      include: { subject: { select: { code: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 60,
    });

    if (materials.length === 0) {
      return {
        sessionId: '',
        text: 'Sizin kurslarınız üzrə material tapılmadı.',
        stub: false,
        model: '',
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: 0,
        matches: [],
      };
    }

    const catalog = materials
      .map((m, i) => `[${i + 1}] ${m.subject.code} · ${m.subject.name} · ${m.title} (${m.type})`)
      .join('\n');

    const system = [
      'Sən universitet material axtarış köməkçisisən.',
      'Aşağıda tələbənin kurslarına aid material kataloqu var.',
      'Tələbənin sualına ən uyğun 3-5 material indeksini seç və qısaca səbəbini izah et.',
      'Çıxış formatı strict JSON: { "matches": [{"index": 1, "why": "..."}, ...], "note": "..." }.',
      'Əgər heç nə uyğun deyilsə — matches boş massiv olsun.',
    ].join(' ');

    const userMessage = `# Tələbə sualı:\n${input.query}\n\n# Material kataloqu (cəmi ${materials.length}):\n${catalog}`;

    const res = await this.session.runAndLog({
      userId: user.id,
      feature: AIFeature.MATERIAL_SEARCH,
      title: `Search: ${input.query.slice(0, 60)}`,
      system,
      userMessage,
      ip,
      userAgent,
      maxTokens: 1000,
    });

    let matches: Array<{ index: number; why: string }> = [];
    let note = '';
    try {
      const clean = res.text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);
      matches = parsed.matches || [];
      note = parsed.note || '';
    } catch {
      // если не распарсилось — возвращаем пустой список
    }

    // Преобразовать индексы в реальные материалы
    const hits = matches
      .map((m) => ({ material: materials[m.index - 1], why: m.why }))
      .filter((h) => h.material)
      .map((h) => ({
        id: h.material.id,
        title: h.material.title,
        subjectCode: h.material.subject.code,
        subjectName: h.material.subject.name,
        url: h.material.url,
        why: h.why,
      }));

    return { ...res, note, matches: hits };
  }
}
