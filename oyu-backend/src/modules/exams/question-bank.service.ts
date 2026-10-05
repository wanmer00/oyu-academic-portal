import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { parseString } from 'fast-csv';
import { z } from 'zod';
import { AuditCtx } from '../../common/audit/audit-trail.service';
import { OrgScopeService } from '../../common/rbac/org-scope.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { TeacherAccessService } from '../teachers/teacher-access.service';
import { Actor, ExamCommon } from './exam-common.service';
import { EXAM_RULES, questionHash } from './exam.rules';

const LABELS = EXAM_RULES.OPTIONS;
const MIN_APPROVED = EXAM_RULES.QUESTIONS;

export const QuestionSchema = z.object({
  body: z.string().trim().min(3).max(4000),
  options: z.array(z.object({ label: z.enum(['A', 'B', 'C', 'D', 'E']), body: z.string().trim().min(1).max(1000) })).length(5),
  correct: z.enum(['A', 'B', 'C', 'D', 'E']),
  image: z.string().regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/).max(550_000).nullable().optional(),
});
export type QuestionDto = z.infer<typeof QuestionSchema>;
export const ImportSchema = z.object({ fileName: z.string().max(200), contentBase64: z.string().max(8_000_000), dryRun: z.boolean().default(false) });
export const RejectSchema = z.object({ reason: z.string().trim().min(5).max(2000) });

const strip = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const bad = (message: string, code: string, extra: Record<string, unknown> = {}) => new BadRequestException({ message, code, ...extra });

@Injectable()
export class QuestionBankService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly common: ExamCommon,
    private readonly access: TeacherAccessService,
    private readonly org: OrgScopeService,
  ) {}

  // ───────────────────────── общие проверки ─────────────────────────
  /** Нормализация и проверка одного вопроса: 5 вариантов A–E, ровно один верный, варианты не совпадают */
  validate(q: QuestionDto) {
    const labels = new Set(q.options.map((o) => o.label));
    if (labels.size !== 5 || !LABELS.every((l) => labels.has(l))) throw bad('Options must be A, B, C, D, E', 'OPTIONS_INVALID');
    const texts = q.options.map((o) => strip(o.body).trim().toLowerCase());
    if (new Set(texts).size !== 5) throw bad('Options must be different', 'OPTIONS_DUPLICATE');
    const options = [...q.options].sort((a, b) => a.label.localeCompare(b.label)).map((o) => ({ label: o.label, body: strip(o.body).trim(), isCorrect: o.label === q.correct }));
    return { body: strip(q.body).trim(), image: q.image ?? null, options, hash: questionHash(q.body, options.map((o) => o.body)) };
  }

  /** После дедлайна обычный преподаватель не меняет банк (пока по предмету есть активный экзамен с прошедшим дедлайном) */
  async assertBeforeDeadline(subjectId: string, now = new Date()) {
    const e = await this.prisma.exam.findFirst({
      where: { subjectId, window: { status: { in: ['DRAFT', 'PUBLISHED'] }, questionDeadline: { lt: now } } },
      select: { window: { select: { questionDeadline: true, title: true } } },
    });
    if (e) throw new ForbiddenException({ message: 'Question upload deadline has passed', code: 'DEADLINE_PASSED', deadline: e.window.questionDeadline });
  }

  private async teacherFor(user: { id: string }, subjectId: string) {
    const t = await this.access.requireTeacher(user.id);
    await this.access.assertCanTeachSubject(user.id, subjectId);
    return t;
  }

  private async versionFor(user: { id: string }, versionId: string) {
    const v = await this.prisma.questionBankVersion.findUnique({ where: { id: versionId }, include: { bank: { select: { subjectId: true } } } });
    if (!v) throw new NotFoundException('Version not found');
    await this.teacherFor(user, v.bank.subjectId);
    return v;
  }

  // ───────────────────────── преподаватель: My Exams ─────────────────────────
  async myExams(user: { id: string }) {
    const sc = await this.access.scope(user.id);
    const subjects = await this.prisma.subject.findMany({ where: { id: { in: sc.subjectIds } }, orderBy: { name: 'asc' }, select: { id: true, code: true, name: true, credits: true } });
    const now = new Date();
    const out = [];
    for (const s of subjects) {
      const [bank, exams] = await Promise.all([
        this.prisma.questionBank.findUnique({ where: { subjectId: s.id }, include: { versions: { orderBy: { version: 'desc' }, include: { _count: { select: { questions: true } }, reviewer: { select: { fullName: true } } } } } }),
        this.prisma.exam.findMany({ where: { subjectId: s.id, window: { status: { in: ['DRAFT', 'PUBLISHED'] } } }, include: { window: true }, orderBy: { window: { startDate: 'asc' } } }),
      ]);
      const versions = (bank?.versions ?? []).map((v) => ({ id: v.id, version: v.version, status: v.status, questions: v._count.questions, rejectionReason: v.rejectionReason, submittedAt: v.submittedAt, approvedAt: v.approvedAt, reviewer: v.reviewer?.fullName ?? null, basedOnId: v.basedOnId }));
      const approved = versions.find((v) => v.status === 'APPROVED') ?? null;
      const open = versions.find((v) => ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW'].includes(v.status)) ?? null;
      const deadline = exams.length ? exams.map((e) => e.window.questionDeadline).sort((a, b) => a.getTime() - b.getTime())[0] : null;
      const covered = !!approved || !!open?.submittedAt;
      out.push({
        subject: s, versions, approvedVersion: approved, openVersion: open, deadline,
        status: approved ? 'APPROVED' : open ? open.status : versions[0]?.status ?? 'NOT_STARTED',
        overdue: !!deadline && now > deadline && !covered,
        locked: !!deadline && now > deadline,
        exams: exams.map((e) => ({ examId: e.id, windowId: e.windowId, windowTitle: e.window.title, kind: e.window.kind, delivery: e.delivery, startDate: e.window.startDate, endDate: e.window.endDate, questionDeadline: e.window.questionDeadline })),
      });
    }
    return out;
  }

  // ───────────────────────── версии ─────────────────────────
  /** Новая версия: пустая или копия последней утверждённой / отклонённой (ревизия) */
  async createVersion(user: Actor, subjectId: string, ctx: AuditCtx) {
    const teacher = await this.teacherFor(user, subjectId);
    await this.assertBeforeDeadline(subjectId);
    const bank = (await this.prisma.questionBank.findUnique({ where: { subjectId } })) ?? (await this.prisma.questionBank.create({ data: { subjectId, ownerId: teacher.userId } }));
    const open = await this.prisma.questionBankVersion.findFirst({ where: { bankId: bank.id, status: { in: ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW'] } } });
    if (open) {
      if (open.status === 'DRAFT') return this.getVersion(user, open.id);
      throw new ConflictException({ message: 'A version is already under review', code: 'VERSION_IN_REVIEW' });
    }
    const last = await this.prisma.questionBankVersion.findFirst({ where: { bankId: bank.id }, orderBy: { version: 'desc' }, include: { questions: { include: { options: true }, orderBy: { ordinal: 'asc' } } } });
    const base = last && ['APPROVED', 'REJECTED', 'SUPERSEDED'].includes(last.status) ? last : null;
    const v = await this.prisma.$transaction(async (tx) => {
      const nv = await tx.questionBankVersion.create({ data: { bankId: bank.id, version: (last?.version ?? 0) + 1, authorId: user.id, basedOnId: base?.id ?? null } });
      for (const q of base?.questions ?? []) {
        await tx.question.create({ data: { versionId: nv.id, ordinal: q.ordinal, body: q.body, image: q.image, contentHash: q.contentHash, options: { create: q.options.map((o) => ({ label: o.label, body: o.body, isCorrect: o.isCorrect })) } } });
      }
      await this.common.log(tx, user, 'question_bank_version_created', 'QuestionBankVersion', nv.id, { subjectId, version: nv.version, basedOn: base?.version ?? null }, ctx);
      return nv;
    });
    return this.getVersion(user, v.id);
  }

  /** Версия для автора: вопросы с правильными ответами (их видит только владелец и reviewer) */
  async getVersion(user: { id: string }, versionId: string) {
    const v = await this.versionFor(user, versionId);
    return this.detail(v.id);
  }

  async detail(versionId: string) {
    const v = await this.prisma.questionBankVersion.findUnique({
      where: { id: versionId },
      include: { bank: { include: { subject: { select: { id: true, code: true, name: true, credits: true } } } }, author: { select: { fullName: true } }, reviewer: { select: { fullName: true } }, questions: { orderBy: { ordinal: 'asc' }, include: { options: { orderBy: { label: 'asc' } } } } },
    });
    if (!v) throw new NotFoundException('Version not found');
    return {
      id: v.id, version: v.version, status: v.status, subject: v.bank.subject, author: v.author.fullName, authorId: v.authorId, reviewer: v.reviewer?.fullName ?? null,
      rejectionReason: v.rejectionReason, submittedAt: v.submittedAt, approvedAt: v.approvedAt, editable: v.status === 'DRAFT', minRequired: MIN_APPROVED,
      questions: v.questions.map((q) => ({ id: q.id, ordinal: q.ordinal, body: q.body, image: q.image, correct: q.options.find((o) => o.isCorrect)?.label ?? null, options: q.options.map((o) => ({ label: o.label, body: o.body })) })),
    };
  }

  private async editable(user: { id: string }, versionId: string) {
    const v = await this.versionFor(user, versionId);
    if (v.status !== 'DRAFT') throw new ConflictException({ message: 'Only a draft version can be edited. Create a new version.', code: 'VERSION_LOCKED' });
    await this.assertBeforeDeadline(v.bank.subjectId);
    return v;
  }

  private dupError(e: unknown): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ message: 'Duplicate question', code: 'DUPLICATE_QUESTION' });
    throw e;
  }

  async addQuestion(user: Actor, versionId: string, dto: QuestionDto, ctx: AuditCtx) {
    const v = await this.editable(user, versionId);
    const n = this.validate(dto);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const max = await tx.question.aggregate({ where: { versionId }, _max: { ordinal: true } });
        const q = await tx.question.create({ data: { versionId, ordinal: (max._max.ordinal ?? 0) + 1, body: n.body, image: n.image, contentHash: n.hash, options: { create: n.options } } });
        await this.common.log(tx, user, 'question_uploaded', 'Question', q.id, { versionId, subjectId: v.bank.subjectId, ordinal: q.ordinal }, ctx);
        return { id: q.id, ordinal: q.ordinal };
      });
    } catch (e) { this.dupError(e); }
  }

  async updateQuestion(user: Actor, versionId: string, questionId: string, dto: QuestionDto, ctx: AuditCtx) {
    await this.editable(user, versionId);
    const cur = await this.prisma.question.findFirst({ where: { id: questionId, versionId } });
    if (!cur) throw new NotFoundException('Question not found');
    const n = this.validate(dto);
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.questionOption.deleteMany({ where: { questionId } });
        await tx.question.update({ where: { id: questionId }, data: { body: n.body, image: n.image, contentHash: n.hash, options: { create: n.options } } });
        await this.common.log(tx, user, 'question_edited', 'Question', questionId, { versionId, ordinal: cur.ordinal }, ctx);
      });
    } catch (e) { this.dupError(e); }
    return { ok: true };
  }

  async deleteQuestion(user: Actor, versionId: string, questionId: string, ctx: AuditCtx) {
    await this.editable(user, versionId);
    const cur = await this.prisma.question.findFirst({ where: { id: questionId, versionId } });
    if (!cur) throw new NotFoundException('Question not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.question.delete({ where: { id: questionId } });
      await this.common.log(tx, user, 'question_deleted', 'Question', questionId, { versionId, ordinal: cur.ordinal }, ctx);
    });
    return { ok: true };
  }

  // ───────────────────────── импорт CSV / XLSX ─────────────────────────
  private async parseRows(fileName: string, b64: string): Promise<string[][]> {
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) throw bad('Empty file', 'IMPORT_EMPTY');
    if (/\.xlsx$/i.test(fileName)) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as never);
      const ws = wb.worksheets[0];
      if (!ws) throw bad('Workbook has no sheets', 'IMPORT_EMPTY');
      const rows: string[][] = [];
      ws.eachRow({ includeEmpty: false }, (r) => rows.push((r.values as unknown[]).slice(1).map((c) => (c == null ? '' : typeof c === 'object' && 'text' in (c as object) ? String((c as { text: unknown }).text) : String(c)))));
      return rows;
    }
    if (/\.csv$/i.test(fileName)) {
      let text = buf.toString('utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      const delimiter = (text.split('\n')[0].match(/;/g)?.length ?? 0) > (text.split('\n')[0].match(/,/g)?.length ?? 0) ? ';' : ',';
      return new Promise((resolve, reject) => {
        const rows: string[][] = [];
        parseString(text, { delimiter, headers: false, ignoreEmpty: true, trim: true }).on('error', reject).on('data', (r: string[]) => rows.push(r)).on('end', () => resolve(rows));
      });
    }
    throw bad('Only .csv and .xlsx files are supported', 'IMPORT_FORMAT');
  }

  importTemplate() {
    return 'question,A,B,C,D,E,correct\n"What is 2 + 2?",3,4,5,6,7,B\n"Capital of Azerbaijan?",Ganja,Sumqayit,Baku,Shaki,Lankaran,C\n';
  }

  async importQuestions(user: Actor, versionId: string, dto: z.infer<typeof ImportSchema>, ctx: AuditCtx) {
    const v = await this.editable(user, versionId);
    const raw = await this.parseRows(dto.fileName, dto.contentBase64);
    if (raw.length > 1001) throw bad('Too many rows (max 1000)', 'IMPORT_TOO_LARGE');
    const head = raw[0]?.map((c) => c.trim().toLowerCase()) ?? [];
    const named = head.includes('a') && head.includes('b') && head.some((h) => ['correct', 'answer', 'right', 'düzgün'].includes(h));
    const col = (names: string[], fallback: number) => { const i = head.findIndex((h) => names.includes(h)); return named ? i : fallback; };
    const idx = { q: col(['question', 'text', 'body', 'sual'], 0), A: col(['a'], 1), B: col(['b'], 2), C: col(['c'], 3), D: col(['d'], 4), E: col(['e'], 5), correct: col(['correct', 'answer', 'right', 'düzgün'], 6) };
    const rows = named ? raw.slice(1) : raw;
    const existing = new Set((await this.prisma.question.findMany({ where: { versionId }, select: { contentHash: true } })).map((q) => q.contentHash));
    const seen = new Set<string>();
    const errors: Array<{ row: number; code: string }> = [];
    const good: Array<ReturnType<QuestionBankService['validate']>> = [];
    rows.forEach((r, i) => {
      const rowNo = i + (named ? 2 : 1);
      const get = (k: number) => (k >= 0 && r[k] != null ? String(r[k]).trim() : '');
      const correct = get(idx.correct).toUpperCase();
      try {
        const parsed = QuestionSchema.parse({ body: get(idx.q), options: LABELS.map((l) => ({ label: l, body: get(idx[l]) })), correct });
        const n = this.validate(parsed);
        if (existing.has(n.hash) || seen.has(n.hash)) { errors.push({ row: rowNo, code: 'DUPLICATE_QUESTION' }); return; }
        seen.add(n.hash);
        good.push(n);
      } catch (e) {
        errors.push({ row: rowNo, code: e instanceof z.ZodError ? (e.issues.some((x) => x.path[0] === 'correct') ? 'CORRECT_INVALID' : 'ROW_INVALID') : ((e as { response?: { code?: string } }).response?.code ?? 'ROW_INVALID') });
      }
    });
    if (dto.dryRun || errors.length) return { imported: 0, valid: good.length, errors, total: rows.length };
    const total = existing.size + good.length;
    if (total > 2000) throw bad('Too many questions in a version', 'IMPORT_TOO_LARGE');
    await this.prisma.$transaction(async (tx) => {
      const max = await tx.question.aggregate({ where: { versionId }, _max: { ordinal: true } });
      let ord = max._max.ordinal ?? 0;
      for (const n of good) await tx.question.create({ data: { versionId, ordinal: ++ord, body: n.body, image: null, contentHash: n.hash, options: { create: n.options } } });
      await this.common.log(tx, user, 'question_uploaded', 'QuestionBankVersion', versionId, { subjectId: v.bank.subjectId, imported: good.length, bulk: true, fileName: dto.fileName }, ctx);
    }, { timeout: 60000 });
    return { imported: good.length, valid: good.length, errors: [], total: rows.length };
  }

  // ───────────────────────── отправка на проверку ─────────────────────────
  async submit(user: Actor, versionId: string, ctx: AuditCtx) {
    const v = await this.editable(user, versionId);
    const count = await this.prisma.question.count({ where: { versionId } });
    if (count < MIN_APPROVED) throw bad(`At least ${MIN_APPROVED} questions are required`, 'NOT_ENOUGH_QUESTIONS', { have: count, need: MIN_APPROVED });
    await this.prisma.$transaction(async (tx) => {
      await tx.questionBankVersion.update({ where: { id: versionId }, data: { status: 'SUBMITTED', submittedAt: new Date(), rejectionReason: null, reviewerId: null, reviewStartedAt: null } });
      await this.common.log(tx, user, 'question_bank_submitted', 'QuestionBankVersion', versionId, { subjectId: v.bank.subjectId, version: v.version, questions: count }, ctx);
    });
    return this.detail(versionId);
  }

  // ───────────────────────── Management: проверка ─────────────────────────
  /** Область проверяющего: ректор/админ — все предметы; декан — факультет; зав. кафедрой — кафедра; остальные — ничего */
  private async reviewScope(user: { id: string; role: never | string }): Promise<Prisma.QuestionBankVersionWhereInput> {
    const os = await this.org.forUser(user as never);
    if (os.kind === 'ALL') return {};
    if (os.kind === 'FACULTY' && os.facultyId) return { bank: { subject: { department: { facultyId: os.facultyId } } } };
    if (os.kind === 'DEPARTMENT' && os.departmentId) return { bank: { subject: { departmentId: os.departmentId } } };
    return { id: '__none__' };
  }

  async queue(user: { id: string; role: string }, status?: string) {
    const scope = await this.reviewScope(user);
    const rows = await this.prisma.questionBankVersion.findMany({
      where: { ...scope, ...(status ? { status: status as never } : { status: { in: ['SUBMITTED', 'UNDER_REVIEW', 'REJECTED', 'APPROVED'] } }) },
      orderBy: [{ submittedAt: 'desc' }], take: 300,
      include: { bank: { include: { subject: { select: { id: true, code: true, name: true } } } }, author: { select: { fullName: true } }, reviewer: { select: { fullName: true } }, _count: { select: { questions: true } } },
    });
    return rows.map((v) => ({ id: v.id, version: v.version, status: v.status, subject: v.bank.subject, author: v.author.fullName, reviewer: v.reviewer?.fullName ?? null, questions: v._count.questions, submittedAt: v.submittedAt, reviewedAt: v.reviewedAt, rejectionReason: v.rejectionReason }));
  }

  private async reviewable(user: { id: string; role: string }, versionId: string) {
    const scope = await this.reviewScope(user);
    const v = await this.prisma.questionBankVersion.findFirst({ where: { id: versionId, ...scope } });
    if (!v) throw new NotFoundException('Version not found');
    return v;
  }

  async reviewDetail(user: { id: string; role: string }, versionId: string) {
    await this.reviewable(user, versionId);
    return this.detail(versionId);
  }

  private assertNotAuthor(user: { id: string }, authorId: string) {
    if (user.id === authorId) throw new ForbiddenException({ message: 'You cannot review your own question bank', code: 'SELF_REVIEW' });
  }

  async claim(user: Actor & { role: string }, versionId: string, ctx: AuditCtx) {
    const v = await this.reviewable(user, versionId);
    this.assertNotAuthor(user, v.authorId);
    const u = await this.prisma.questionBankVersion.updateMany({ where: { id: versionId, status: 'SUBMITTED' }, data: { status: 'UNDER_REVIEW', reviewerId: user.id, reviewStartedAt: new Date() } });
    if (u.count !== 1) {
      if (v.status === 'UNDER_REVIEW' && v.reviewerId === user.id) return this.detail(versionId);
      throw new ConflictException({ message: 'Version is not awaiting review', code: 'VERSION_STATE' });
    }
    await this.common.log(null, user, 'question_review_started', 'QuestionBankVersion', versionId, {}, ctx);
    return this.detail(versionId);
  }

  async approve(user: Actor & { role: string }, versionId: string, ctx: AuditCtx) {
    const v = await this.reviewable(user, versionId);
    this.assertNotAuthor(user, v.authorId);
    if (v.status !== 'UNDER_REVIEW' || v.reviewerId !== user.id) throw new ConflictException({ message: 'Open the version for review first', code: 'VERSION_STATE' });
    const count = await this.prisma.question.count({ where: { versionId } });
    if (count < MIN_APPROVED) throw bad(`At least ${MIN_APPROVED} questions are required`, 'NOT_ENOUGH_QUESTIONS');
    await this.prisma.$transaction(async (tx) => {
      await tx.questionBankVersion.updateMany({ where: { bankId: v.bankId, status: 'APPROVED' }, data: { status: 'SUPERSEDED' } });
      await tx.questionBankVersion.update({ where: { id: versionId }, data: { status: 'APPROVED', approvedAt: new Date(), reviewedAt: new Date(), rejectionReason: null } });
      await this.common.log(tx, user, 'question_bank_approved', 'QuestionBankVersion', versionId, { version: v.version, questions: count }, ctx);
    });
    void this.common.notify([v.authorId], 'ACADEMIC', { az: 'Sual bankı təsdiqləndi', ru: 'Банк вопросов утверждён', en: 'Question bank approved' }, { az: `Versiya ${v.version} təsdiqləndi`, ru: `Версия ${v.version} утверждена`, en: `Version ${v.version} approved` }, 'my-exams');
    return this.detail(versionId);
  }

  async reject(user: Actor & { role: string }, versionId: string, reason: string, ctx: AuditCtx) {
    const v = await this.reviewable(user, versionId);
    this.assertNotAuthor(user, v.authorId);
    if (v.status !== 'UNDER_REVIEW' || v.reviewerId !== user.id) throw new ConflictException({ message: 'Open the version for review first', code: 'VERSION_STATE' });
    await this.prisma.$transaction(async (tx) => {
      await tx.questionBankVersion.update({ where: { id: versionId }, data: { status: 'REJECTED', rejectionReason: reason, reviewedAt: new Date() } });
      await this.common.log(tx, user, 'question_bank_rejected', 'QuestionBankVersion', versionId, { version: v.version, reason }, ctx);
    });
    void this.common.notify([v.authorId], 'ACADEMIC', { az: 'Sual bankı rədd edildi', ru: 'Банк вопросов отклонён', en: 'Question bank rejected' }, { az: reason, ru: reason, en: reason }, 'my-exams');
    return this.detail(versionId);
  }
}
