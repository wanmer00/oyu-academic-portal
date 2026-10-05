import { Injectable } from '@nestjs/common';
import { AIFeature, Role } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AISessionService } from '../ai-session.service';
import { TeacherAccessService } from '../../teachers/teacher-access.service';
import { CurrentUserData } from '../../../common/decorators/current-user.decorator';

export interface QuestionGenInput {
  subjectCode: string;
  count?: number;
  types?: Array<'mcq' | 'short' | 'essay'>;
  difficulty?: 'easy' | 'medium' | 'hard' | 'mixed';
  topic?: string;
}

@Injectable()
export class QuestionGenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly session: AISessionService,
    private readonly access: TeacherAccessService,
  ) {}

  async run(user: CurrentUserData, input: QuestionGenInput, ip?: string, userAgent?: string) {
    if (user.role !== Role.TEACHER && user.role !== Role.ADMIN && user.role !== Role.SUPER_ADMIN) {
      throw new Error('Only teachers/administrators');
    }

    const subject = await this.prisma.subject.findUnique({
      where: { code: input.subjectCode },
    });
    if (!subject) throw new Error('Subject not found');
    // Преподаватель генерирует вопросы только по предметам, которые ведёт (по расписанию)
    if (user.role === Role.TEACHER) await this.access.assertCanTeachSubject(user.id, subject.id);

    const materials = await this.prisma.material.findMany({
      where: { subjectId: subject.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    const count = Math.max(5, Math.min(50, input.count || 15));
    const types = input.types?.length ? input.types : ['mcq', 'short', 'essay'];
    const difficulty = input.difficulty || 'mixed';

    const system = [
      'Sən universitet imtahan sualı generatorusan.',
      'Verilmiş fənn və material xülasələri əsasında müxtəlif çətinlik səviyyələrində suallar hazırla.',
      'OUTPUT STRICT JSON — {"questions":[{"type":"mcq"|"short"|"essay", "difficulty":"easy"|"medium"|"hard", "question":"...", "choices":[...]?, "answer":"...", "explanation":"..."}]}',
      'MCQ üçün 4 seçim (a,b,c,d) və doğru cavab "a"-"d" kimi. No markdown fences.',
    ].join(' ');

    const catalog =
      materials.map((m) => `• ${m.title} (${m.type})`).join('\n') ||
      '(material siyahısı boşdur)';

    const userMessage = [
      `# Fənn: ${subject.code} — ${subject.name}`,
      input.topic ? `# Mövzu fokus: ${input.topic}` : '',
      `# Sual sayı: ${count}`,
      `# Tiplər: ${types.join(', ')}`,
      `# Çətinlik: ${difficulty}`,
      ``,
      `# Materialar:`,
      catalog,
    ]
      .filter(Boolean)
      .join('\n');

    const res = await this.session.runAndLog({
      userId: user.id,
      feature: AIFeature.QUESTION_GEN,
      title: `Sual generatoru: ${subject.code} x${count}`,
      system,
      userMessage,
      ip,
      userAgent,
      maxTokens: 3000,
    });

    let questions: unknown[] = [];
    try {
      const clean = res.text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);
      questions = parsed.questions || [];
    } catch {
      // leave empty
    }

    return { ...res, subject: { code: subject.code, name: subject.name }, questions };
  }
}
