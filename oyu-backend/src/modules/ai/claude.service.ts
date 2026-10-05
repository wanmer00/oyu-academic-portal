import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ClaudeCallInput {
  system?: string;
  messages: ClaudeMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface ClaudeCallResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
  stub: boolean;
  latencyMs: number;
}

/**
 * Единственная точка вызова Claude API.
 * Если ANTHROPIC_API_KEY не задан (или AI_STUB_MODE=true) — возвращает осмысленную заглушку
 * чтобы фронт и IT-аудит работали сразу, а реальный ключ можно было вставить позже.
 */
@Injectable()
export class ClaudeService {
  private readonly logger = new Logger(ClaudeService.name);
  private readonly client: Anthropic | null;
  private readonly enabled: boolean;

  constructor() {
    const stubForced = env.AI_STUB_MODE === true;
    const hasKey = !!env.ANTHROPIC_API_KEY;
    this.enabled = hasKey && !stubForced;
    this.client = this.enabled ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY! }) : null;

    if (!this.enabled) {
      this.logger.warn(
        `Claude is in STUB mode (hasKey=${hasKey}, stubForced=${stubForced}). ` +
          'Задай ANTHROPIC_API_KEY в .env чтобы активировать реальные ответы.',
      );
    } else {
      this.logger.log(`Claude enabled: model=${env.AI_MODEL}`);
    }
  }

  /** true — настоящая модель доступна (ключ задан и не включён stub-режим) */
  get live(): boolean { return this.enabled; }

  async call(input: ClaudeCallInput): Promise<ClaudeCallResult> {
    const startedAt = Date.now();
    const maxTokens = input.maxTokens ?? env.AI_MAX_TOKENS;

    if (!this.enabled || !this.client) {
      return this.stubResponse(input, Date.now() - startedAt);
    }

    try {
      const response = await this.client.messages.create({
        model: env.AI_MODEL,
        max_tokens: maxTokens,
        temperature: input.temperature ?? 0.4,
        system: input.system,
        messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
      });

      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
        .trim();

      return {
        text,
        tokensIn: response.usage.input_tokens,
        tokensOut: response.usage.output_tokens,
        model: response.model,
        stub: false,
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      this.logger.error(`Claude call failed: ${(err as Error).message}`);
      // Graceful fallback — возвращаем заглушку с ошибкой чтобы UI не ломался
      return {
        text: `[AI временно недоступен]\n\nПроверь ANTHROPIC_API_KEY или повтори попытку позже.\nОшибка: ${(err as Error).message}`,
        tokensIn: 0,
        tokensOut: 0,
        model: env.AI_MODEL,
        stub: true,
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // STUB режим — осмысленные ответы чтобы UI и IT-аудит работали
  // ═══════════════════════════════════════════════════════════════
  private stubResponse(input: ClaudeCallInput, latencyMs: number): ClaudeCallResult {
    const lastUser = [...input.messages].reverse().find((m) => m.role === 'user');
    const userText = (lastUser?.content || '').slice(0, 400);
    const sys = (input.system || '').toLowerCase();

    let text = '';

    if (sys.includes('gpa') || sys.includes('balı hesabla')) {
      text = [
        '📊 GPA kalkulyatoru (demo):',
        '',
        'Cari GPA: 3.45 (əvvəlki semestrlərə əsasən)',
        'Yekun oçenkalarla: ~3.52',
        'Təqaüd üçün lazımi minimum: 3.20 ✓',
        'Qırmızı diplom: 3.75 (hələ çatmır — 2 semestr ortalama 3.95 lazımdır)',
        '',
        '*Qeyd: bu demo-cavabdır. ANTHROPIC_API_KEY qoşulduqdan sonra real hesablama işləyəcək.*',
      ].join('\n');
    } else if (sys.includes('заявк') || sys.includes('request') || sys.includes('ərizə')) {
      text = [
        'Hörmətli Dekanat,',
        '',
        'Mən [Ad, soyad], [qrup] qrupunun tələbəsi, bu ərizə ilə Sizə müraciət edirəm.',
        '',
        `Məsələnin mahiyyəti: ${userText || '[tələbənin qeydi]'}`,
        '',
        'Xahiş edirəm, müraciətimə baxılsın və müvafiq qərar verilsin.',
        '',
        'Hörmətlə,',
        '[İmza] · [Tarix]',
        '',
        '_(demo-cavab. Real Claude qoşulduqda mətn tələbənin kontekstinə əsaslanacaq.)_',
      ].join('\n');
    } else if (sys.includes('translat') || sys.includes('tərcümə') || sys.includes('перевод')) {
      text = [
        '```json',
        '{',
        '  "az": "(orijinal mətn)",',
        '  "en": "(demo English translation of the original text)",',
        '  "ru": "(демо-перевод на русский исходного текста)"',
        '}',
        '```',
        '',
        '_Demo-cavab. Real tərcümə API açarı qoşulduqdan sonra gələcək._',
      ].join('\n');
    } else if (sys.includes('search') || sys.includes('material') || sys.includes('axtarış')) {
      text = [
        '🔍 Seçilmiş materiallardan tapılanlar (demo):',
        '',
        '**1. TCP/IP əsasları** (Computer Networks, 3-cü həftə)',
        '   "TCP handshake-də 3 mesaj mübadilə olunur: SYN, SYN-ACK, ACK..."',
        '',
        '**2. Daşıma qatı** (Computer Networks, 4-cü həftə)',
        '   "TCP və UDP fərqi nəzərə alınmalıdır..."',
        '',
        '_Demo. Real RAG axtarışı Claude ilə işləyəcək._',
      ].join('\n');
    } else if (sys.includes('question') || sys.includes('sual yarad')) {
      text = [
        'İmtahan üçün təklif olunan suallar (demo):',
        '',
        '1. **Çoxvariantlı:** OSI modelində daşıma qatı hansıdır?',
        '   a) 3-cü b) 4-cü ✓ c) 5-ci d) 7-ci',
        '',
        '2. **Qısa cavab:** TCP və UDP arasındakı əsas fərqi izah edin.',
        '',
        '3. **Essay:** Müasir veb-tətbiqlərdə HTTPS-in rolunu təsvir edin.',
        '',
        '_Demo-cavab. Real sual generatoru aktiv API ilə işləyəcək._',
      ].join('\n');
    } else if (sys.includes('dropout') || sys.includes('risk') || sys.includes('analysis')) {
      text = [
        '⚠️ Risk analizi (demo):',
        '',
        '**Yüksək risk (3 tələbə):**',
        '• student2.demo — GPA düşüb 2.1-ə, 32% davam; məsləhət: fərdi görüş',
        '• student3.demo — Ödəniş 2 ay gecikib, 4 fiziki dərsdə olmayıb; məsləhət: maliyyə dəstəyi',
        '',
        '**Orta risk (5 tələbə):** GPA < 2.5 və azalma trendi',
        '',
        '_Demo. Real analiz API açarı ilə işləyəcək._',
      ].join('\n');
    } else if (sys.includes('anomaly') || sys.includes('audit') || sys.includes('security')) {
      text = [
        '🛡 Audit jurnalı analizi (demo):',
        '',
        '**Aşkar edilən anomaliyalar:**',
        '• 47 uğursuz giriş cəhdi bir IP-dən (185.122.x.x) — 2 saat ərzində',
        '• Qeyri-adi vaxt: loginId=admin.demo gecə saat 03:47-də admin paneldə',
        '• Kütləvi material yüklənməsi: loginId=teacher2.demo 1 saatda 127 fayl',
        '',
        '**Tövsiyyə:** 185.122.x.x IP-sini rate-limit siyahısına əlavə et.',
        '',
        '_Demo. Real analiz API açarı ilə işləyəcək._',
      ].join('\n');
    } else {
      text = [
        `Mən Academic Portalın AI-assistentiyəm. Sualınız: "${userText}"`,
        '',
        'Hazırda demo-rejimdəyəm — admin ANTHROPIC_API_KEY əlavə etdikdən sonra',
        'həqiqi cavablar verməyə başlayacam. Bütün dialoqlar IT-auditoru üçün qeyd olunur.',
      ].join('\n');
    }

    return {
      text,
      tokensIn: Math.ceil((input.system || '').length / 4) + Math.ceil(userText.length / 4),
      tokensOut: Math.ceil(text.length / 4),
      model: 'stub-' + env.AI_MODEL,
      stub: true,
      latencyMs,
    };
  }
}
