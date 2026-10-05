import { Injectable } from '@nestjs/common';
import { AIFeature } from '@prisma/client';
import { AISessionService } from '../ai-session.service';
import { CurrentUserData } from '../../../common/decorators/current-user.decorator';

export interface TranslateInput {
  text: string;
  source: 'az' | 'en' | 'ru';
}

export interface TranslateOutput {
  az: string;
  en: string;
  ru: string;
}

@Injectable()
export class TranslateService {
  constructor(private readonly session: AISessionService) {}

  async run(user: CurrentUserData, input: TranslateInput, ip?: string, userAgent?: string) {
    const system = [
      'You are an accurate tri-lingual translator for a university portal.',
      'Translate into Azerbaijani (az), English (en), and Russian (ru).',
      'Preserve academic tone, proper nouns, numbers, and formatting.',
      'OUTPUT A STRICT JSON OBJECT with exactly three keys: "az", "en", "ru".',
      'No explanations, no markdown fences — JSON only.',
    ].join(' ');

    const userMessage = `Source language: ${input.source}\n\nText:\n${input.text}`;

    const res = await this.session.runAndLog({
      userId: user.id,
      feature: AIFeature.TRANSLATE,
      title: `Translate: ${input.text.slice(0, 60)}…`,
      system,
      userMessage,
      ip,
      userAgent,
      temperature: 0.1,
      maxTokens: 1800,
    });

    // Попытка распарсить JSON из ответа
    let parsed: TranslateOutput = { az: '', en: '', ru: '' };
    try {
      const clean = res.text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      // fallback: оставляем исходный текст в языке source
      parsed[input.source] = input.text;
    }
    // Убеждаемся что source заполнен
    if (!parsed[input.source]) parsed[input.source] = input.text;

    return { ...res, translations: parsed };
  }
}
