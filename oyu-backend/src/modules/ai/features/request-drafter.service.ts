import { Injectable } from '@nestjs/common';
import { AIFeature, Role, RequestType } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AISessionService } from '../ai-session.service';
import { CurrentUserData } from '../../../common/decorators/current-user.decorator';

export interface DraftRequestInput {
  type: RequestType;
  note?: string;
  subjectCode?: string;
}

@Injectable()
export class RequestDrafterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly session: AISessionService,
  ) {}

  async run(user: CurrentUserData, input: DraftRequestInput, ip?: string, userAgent?: string) {
    if (user.role !== Role.STUDENT) throw new Error('Only students');
    const studentId = user.student?.userId ?? user.id;

    // Контекст: студент + последние оценки по предмету (если указан) + история заявок
    const student = await this.prisma.student.findUnique({
      where: { userId: studentId },
      include: { user: { select: { fullName: true, loginId: true, email: true, phone: true } } },
    });

    let subjectCtx = '';
    if (input.subjectCode) {
      const grades = await this.prisma.grade.findMany({
        where: { studentId, subject: { code: input.subjectCode }, publishedAt: { not: null } },
        include: { subject: { select: { code: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
      subjectCtx = grades
        .map((g) => `• ${g.subject.name} (${g.subject.code}): ${g.value != null ? Number(g.value).toFixed(1) : '—'}/${Number(g.maxValue)} [${g.type}]`)
        .join('\n');
    }

    const typeLabel: Record<RequestType, string> = {
      CERTIFICATE: 'Arayış sorğusu',
      APPEAL: 'Apelyasiya',
      TRANSFER: 'İxtisas / qrup dəyişmək',
      OTHER: 'Digər məsələ',
    };

    const system = [
      'Sən Academic Portalın ərizə-draft generatorusan.',
      'Tələbə üçün rəsmi dildə, Azərbaycan akademik üslubunda qısa ərizə mətni yaz.',
      'Strukturlu şəkildə: müraciət + məsələnin qısa izahı + xahiş + imza blokunun şablonu.',
      'Əlavə izah etmə, yalnız mətni ver.',
    ].join(' ');

    const userMessage = [
      `# Ərizə növü: ${typeLabel[input.type] || input.type}`,
      `# Tələbə: ${student?.user.fullName || ''} (Login ID ${student?.user.loginId || ''})`,
      `Fakültə: ${student?.faculty || ''} / ${student?.specialty || ''} / ${student?.groupName || ''}, ${student?.course || ''}-cu kurs`,
      subjectCtx ? `\n# Aidiyyatlı fənn üzrə son qiymətlər:\n${subjectCtx}` : '',
      input.note ? `\n# Tələbənin qeydi:\n${input.note}` : '',
    ].join('\n');

    const res = await this.session.runAndLog({
      userId: user.id,
      feature: AIFeature.REQUEST_DRAFTER,
      title: `Ərizə: ${typeLabel[input.type] || input.type}`,
      system,
      userMessage,
      ip,
      userAgent,
      maxTokens: 1200,
    });

    return { ...res, type: input.type };
  }
}
