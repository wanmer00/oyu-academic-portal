// ============================================================
// Демо-данные Exam Management System (вымышленные): окна финальных экзаменов и пересдач, банки вопросов в разных статусах,
// рабочие места (30 ПК), проктор, сценарии студентов (сдал / провал / resit / retake), предложения предметов, летний retake.
// Демо-вопросы — арифметические (одинаковые для всех предметов), чтобы цепочка «банк → экзамен → результат» была проверяемой.
// ============================================================
import { PrismaClient, Role, Term } from '@prisma/client';
import { calculateSeminarScore } from '../modules/journal/journal.calc';
import { addDays, defaultResitWindow, isoDate, localParts, questionHash, resitFee, scoreExam, sha256 } from '../modules/exams/exam.rules';
import { randomUUID } from 'crypto';

type Log = (m: string) => void;
export interface ExamSeedCtx {
  R: () => number; now: Date; hash: string; email: (login: string) => string;
  students: Array<{ id: string; n: number; group: string }>;
  teachers: Array<{ id: string; n: number; track: string }>;
  subj: Map<string, { id: string; code: string; name: string; semester: number; teacherId: string }>;
  groups: Array<{ name: string; semester: number; sp: { id: string; track: string | null } }>;
  groupSubjects: Record<string, string[]>;
  rooms: Array<{ id: string; code: string }>;
  adminId: string;
  semesterCodes: (track: string, sem: number) => string[];
  period: { academicYear: string; term: Term };
}

export const DEMO_WS_KEY = (room: string, code: string) => `wk_demo_${room}_${code}`;
const DAY = 86400000;
/** Набор ответов с заданным Exam Score: по возможности 3–4 неверных и несколько пропусков (реалистичная работа) */
const answersFor = (e: number) => {
  let w = 4 - ((e + 4) % 2 ? 1 : 0); // чётность e + w
  if ((e + w) / 2 + w > 25) w = e % 2;
  const c = (e + w) / 2;
  return [...Array(c).fill('CORRECT'), ...Array(w).fill('WRONG'), ...Array(25 - c - w).fill('SKIP')] as Array<'CORRECT' | 'WRONG' | 'SKIP'>;
};

export async function seedExams(prisma: PrismaClient, c: ExamSeedCtx, log: Log) {
  const { R, now, subj } = c;
  const today = localParts(now).date;
  const stud = (n: number) => c.students.find((s) => s.n === n)!;
  const subjName = (code: string) => subj.get(code)!.name;

  // ═══ 1. Проктора и рабочие места ═══
  const proctors: Array<{ id: string; loginId: string }> = [];
  for (const [login, name] of [['proctor.demo', 'Invigilator 1'], ['proctor2.demo', 'Invigilator 2']] as const) {
    proctors.push(await prisma.user.create({ data: { loginId: login, email: c.email(login), passwordHash: c.hash, role: Role.PROCTOR, fullName: name, preferredLang: 'az' } }));
  }
  const labRooms = c.rooms.filter((r) => ['B101', 'B102'].includes(r.code));
  for (const p of proctors) for (const r of labRooms) if (p.loginId === 'proctor.demo' || r.code === 'B102') await prisma.proctorAssignment.create({ data: { proctorId: p.id, roomId: r.id } });
  const wsRows = [];
  for (const r of labRooms) for (let i = 1; i <= (r.code === 'B101' ? 30 : 12); i++) {
    const code = `PC-${String(i).padStart(2, '0')}`;
    wsRows.push({ roomId: r.id, code, keyHash: sha256(DEMO_WS_KEY(r.code, code)), keyIssuedAt: now });
  }
  await prisma.examWorkstation.createMany({ data: wsRows });

  // ═══ 2. Зачисление на предметы текущего семестра ═══
  const enrolRows = c.students.flatMap((s) => {
    const g = c.groups.find((x) => x.name === s.group)!;
    return c.groupSubjects[s.group].map((code) => ({ studentId: s.id, subjectId: subj.get(code)!.id, academicYear: c.period.academicYear, term: c.period.term, semester: g.semester, source: 'CURRICULUM', status: 'ENROLLED' as const }));
  });
  for (let i = 0; i < enrolRows.length; i += 500) await prisma.subjectEnrollment.createMany({ data: enrolRows.slice(i, i + 500) });

  // ═══ 3. Окна: финальные (открыто сейчас) и пересдач ═══
  const examCodes = [...new Set(Object.values(c.groupSubjects).flat())];
  const paperCode = 'UMM101'; // «Azərbaycan tarixi» — бумажный экзамен (группы 1 курса)
  const finalW = await prisma.examWindow.create({
    data: {
      title: 'Final exams — Fall 2026/27 (demo: open now)', kind: 'FINAL', academicYear: c.period.academicYear, term: c.period.term,
      startDate: new Date(addDays(today, -2)), endDate: new Date(addDays(today, 25)), allowedWeekdays: [1, 2, 3, 4, 5, 6], startTime: '00:00', endTime: '23:59', maxPerWeek: 3,
      questionDeadline: new Date(now.getTime() + 3 * DAY), status: 'PUBLISHED', createdBy: c.adminId,
      exams: { create: examCodes.map((code) => ({ subjectId: subj.get(code)!.id, delivery: code === paperCode ? ('PAPER' as const) : ('COMPUTER' as const) })) },
    },
    include: { exams: true },
  });
  const rd = defaultResitWindow({ startDate: finalW.startDate, endDate: finalW.endDate, startTime: finalW.startTime, endTime: finalW.endTime });
  const resitW = await prisma.examWindow.create({
    data: {
      title: 'Fall 2026/27 — 25% resit window', kind: 'RESIT', academicYear: c.period.academicYear, term: c.period.term, startDate: new Date(rd.startDate), endDate: new Date(rd.endDate), allowedWeekdays: rd.allowedWeekdays,
      startTime: rd.startTime, endTime: rd.endTime, maxPerWeek: 3, questionDeadline: new Date(`${addDays(rd.startDate, -7)}T23:59:59+04:00`), status: 'PUBLISHED', finalWindowId: finalW.id, createdBy: c.adminId,
      exams: { create: examCodes.map((code) => ({ subjectId: subj.get(code)!.id, delivery: 'COMPUTER' as const })) },
    },
  });
  const examBySubject = new Map(finalW.exams.map((e) => [e.subjectId, e]));

  // ═══ 4. Банки вопросов: утверждены / на проверке / отклонены / черновик ═══
  const kmCodes = new Set([...c.groupSubjects['KM-21'], ...c.groupSubjects['İT-11'], paperCode]);
  const mkQuestions = (name: string, count: number) => {
    const out = [];
    for (let k = 1; k <= count; k++) {
      const a = 3 + ((k * 7) % 17), b = 2 + ((k * 5) % 9), correct = a * b;
      const pool = new Set<number>([correct]);
      for (let d = 1; pool.size < 5; d++) pool.add(correct + (d % 2 ? d : -d) * (1 + (k % 3)));
      const vals = [...pool].sort(() => R() - 0.5);
      const body = `[${name}] Demo question ${k}: ${a} × ${b} = ?`;
      out.push({ body, vals, correctIdx: vals.indexOf(correct), hash: questionHash(body, vals.map(String)) });
    }
    return out;
  };
  let idx = 0, banks = 0;
  const stat = { approved: 0, submitted: 0, rejected: 0, draft: 0 };
  for (const code of examCodes) {
    const sj = subj.get(code)!;
    const i = idx++;
    const status = kmCodes.has(code) ? 'APPROVED' : i % 11 === 3 ? 'SUBMITTED' : i % 13 === 5 ? 'REJECTED' : i % 17 === 9 ? 'DRAFT' : 'APPROVED';
    const count = status === 'DRAFT' ? 12 : 30;
    const bank = await prisma.questionBank.create({ data: { subjectId: sj.id, ownerId: sj.teacherId } });
    const ver = await prisma.questionBankVersion.create({ data: { bankId: bank.id, version: 1, authorId: sj.teacherId, status: 'DRAFT' } });
    const qs = mkQuestions(sj.name, count);
    const qRows = qs.map((q, k) => ({ id: randomUUID(), versionId: ver.id, ordinal: k + 1, body: q.body, contentHash: q.hash }));
    await prisma.question.createMany({ data: qRows });
    await prisma.questionOption.createMany({ data: qs.flatMap((q, k) => q.vals.map((v, o) => ({ id: randomUUID(), questionId: qRows[k].id, label: 'ABCDE'[o], body: String(v), isCorrect: o === q.correctIdx }))) });
    if (status !== 'DRAFT') {
      await prisma.questionBankVersion.update({
        where: { id: ver.id },
        data: { status, submittedAt: new Date(now.getTime() - 5 * DAY), ...(status === 'APPROVED' ? { approvedAt: new Date(now.getTime() - 3 * DAY), reviewedAt: new Date(now.getTime() - 3 * DAY), reviewerId: c.adminId } : {}), ...(status === 'REJECTED' ? { reviewerId: c.adminId, reviewedAt: new Date(now.getTime() - 2 * DAY), rejectionReason: 'Question 7 has two potentially correct answers.' } : {}) },
      });
    }
    stat[status === 'APPROVED' ? 'approved' : status === 'SUBMITTED' ? 'submitted' : status === 'REJECTED' ? 'rejected' : 'draft']++;
    banks++;
  }

  // ═══ 5. Сценарии студентов группы KM-21 ═══
  const km = c.groupSubjects['KM-21'];
  const ids = c.students.filter((s) => s.group === 'KM-21').map((s) => s.id);
  await prisma.grade.updateMany({ where: { studentId: { in: ids }, academicYear: c.period.academicYear, term: c.period.term }, data: { publishedAt: now } });
  const grades = await prisma.grade.findMany({ where: { studentId: { in: ids }, type: { in: ['MIDTERM', 'SEMINAR'] } } });
  const entryOf = (studentId: string, subjectId: string, year: string, term: string) => {
    const rows = grades.filter((g) => g.studentId === studentId && g.subjectId === subjectId && g.academicYear === year && g.term === term);
    const mid = rows.find((g) => g.type === 'MIDTERM');
    const sem = calculateSeminarScore(rows.filter((g) => g.type === 'SEMINAR').map((g) => g.value.toString()));
    return mid && sem.score != null ? Math.round((Number(mid.value) + sem.score) * 100) / 100 : null;
  };
  let invoice = 1;
  const pay = async (studentId: string, subjectName: string, fee: number, status: 'PAID' | 'FAILED' = 'PAID') =>
    prisma.payment.create({ data: { studentId, amount: fee, type: 'RETAKE', status, description: `25% resit — ${subjectName}`, invoiceNumber: `RST-DEMO-${String(invoice++).padStart(4, '0')}`, dueDate: now, paidAt: status === 'PAID' ? now : null, providerRef: 'DEMO-seed' } });

  /** Результат экзамена по сценарию: attempt + authorization (если задан ПК) + result + запись FINAL в Journal */
  const scenario = async (p: { n: number; code: string; examScore: number; hoursAgo: number; kind?: 'FINAL' | 'RESIT'; year?: string; term?: Term; enrollmentStatus: 'COMPLETED' | 'RESIT_ELIGIBLE' | 'RESIT_PAID' | 'RETAKE_REQUIRED' | 'RESIT_FORFEITED'; resit?: 'PAID' | 'USED' | 'FORFEITED'; withAttempt?: boolean }) => {
    const s = stud(p.n), sj = subj.get(p.code)!;
    const year = p.year ?? c.period.academicYear, term = p.term ?? c.period.term;
    const entry = entryOf(s.id, sj.id, year, term) ?? 40;
    const en = await prisma.subjectEnrollment.upsert({
      where: { studentId_subjectId_academicYear_term_attemptNo: { studentId: s.id, subjectId: sj.id, academicYear: year, term, attemptNo: 1 } },
      create: { studentId: s.id, subjectId: sj.id, academicYear: year, term, semester: c.groups.find((g) => g.name === s.group)!.semester - (year === c.period.academicYear ? 0 : 1), entryScore: entry, status: p.enrollmentStatus },
      update: { entryScore: entry, status: p.enrollmentStatus },
    });
    const score = scoreExam({ answers: answersFor(p.examScore), entryScore: entry });
    const at = new Date(now.getTime() - p.hoursAgo * 3600000);
    const exam = year === c.period.academicYear ? examBySubject.get(sj.id)! : null;
    let attemptId: string | null = null;
    if (p.withAttempt && exam) {
      const ws = await prisma.examWorkstation.findFirstOrThrow({ where: { room: { code: 'B101' } }, orderBy: { code: 'asc' } });
      const auth = await prisma.proctorAuthorization.create({ data: { examId: exam.id, studentId: s.id, proctorId: proctors[0].id, workstationId: ws.id, tokenHash: sha256(randomUUID()), idChecked: true, passportChecked: true, expiresAt: new Date(at.getTime() + 300000), usedAt: at } });
      const bank = await prisma.questionBankVersion.findFirst({ where: { status: 'APPROVED', bank: { subjectId: sj.id } }, include: { questions: { include: { options: true }, orderBy: { ordinal: 'asc' } } } });
      const att = await prisma.examAttempt.create({ data: { examId: exam.id, studentId: s.id, enrollmentId: en.id, kind: 'FINAL', authorizationId: auth.id, workstationId: ws.id, bankVersionId: bank?.id ?? null, rulesVersion: 1, windowVersion: 1, status: 'SUBMITTED', startedAt: at, expiresAt: new Date(at.getTime() + 7200000), submittedAt: new Date(at.getTime() + 3600000), submittedBy: 'STUDENT' } });
      attemptId = att.id;
      if (bank) {
        // неизменяемый снапшот: 25 вопросов, перемешанные варианты и ответы, дающие ровно этот Exam Score
        if (!exam.bankVersionId) { await prisma.exam.update({ where: { id: exam.id }, data: { bankVersionId: bank.id } }); exam.bankVersionId = bank.id; }
        const picked = [...bank.questions].sort(() => R() - 0.5).slice(0, 25);
        const pattern = answersFor(p.examScore).sort(() => R() - 0.5);
        await prisma.examAttemptQuestion.createMany({ data: picked.map((q, i) => {
          const order = q.options.map((o) => o.id).sort(() => R() - 0.5);
          const right = q.options.find((o) => o.isCorrect)!.id, wrong = q.options.find((o) => !o.isCorrect)!.id;
          return { attemptId: att.id, questionId: q.id, position: i + 1, optionOrder: order, selectedOptionId: pattern[i] === 'CORRECT' ? right : pattern[i] === 'WRONG' ? wrong : null, answeredAt: pattern[i] === 'SKIP' ? null : at, seq: 1 };
        }) });
      }
    }
    await prisma.examResult.create({
      data: { attemptId, examId: exam?.id ?? null, studentId: s.id, enrollmentId: en.id, kind: p.kind ?? 'FINAL', source: 'COMPUTER', correct: score.correct, wrong: score.wrong, skipped: score.skipped, examScore: score.examScore, entryScore: score.entryScore, total: score.total, letter: score.letter, passed: score.passed, failReason: score.failReason, rulesVersion: 1, createdAt: at, publishedAt: at },
    });
    await prisma.grade.deleteMany({ where: { studentId: s.id, subjectId: sj.id, academicYear: year, term, type: 'FINAL' } });
    await prisma.grade.create({ data: { studentId: s.id, subjectId: sj.id, teacherId: null, value: Math.max(0, p.examScore), maxValue: 50, type: 'FINAL', comment: 'Exam System', academicYear: year, term, semester: en.semester, publishedAt: at, publishedBy: 'system:exam' } });
    if (p.resit) {
      const credits = 8;
      const fee = resitFee(credits, 15).fee;
      const paid = p.resit !== 'FORFEITED' ? await pay(s.id, sj.name, fee) : null;
      await prisma.resitEligibility.create({ data: { enrollmentId: en.id, studentId: s.id, subjectId: sj.id, cycleKey: `${year}:${term}`, credits, creditPrice: 15, feeAmount: fee, status: p.resit, paymentId: paid?.id ?? null } });
    }
    return { en, score };
  };

  // текущий цикл (финальное окно открыто сейчас)
  await scenario({ n: 2, code: km[0], examScore: 30, hoursAgo: 30, enrollmentStatus: 'COMPLETED', withAttempt: true }); // сдал
  await scenario({ n: 3, code: km[0], examScore: 44, hoursAgo: 28, enrollmentStatus: 'COMPLETED', withAttempt: true }); // сдал на A
  await scenario({ n: 4, code: km[0], examScore: 8, hoursAgo: 26, enrollmentStatus: 'RESIT_ELIGIBLE', withAttempt: true }); // провал: можно оплатить 25%
  await scenario({ n: 5, code: km[0], examScore: 14, hoursAgo: 24, enrollmentStatus: 'RESIT_PAID', resit: 'PAID', withAttempt: true }); // Total достаточен, Exam < 17; resit оплачен
  for (const [i, code] of [km[0], km[1], km[2]].entries()) // 3 провала за неделю: 2 resit оплачены, третий — лимит
    await scenario({ n: 6, code, examScore: 12, hoursAgo: 20 - i, enrollmentStatus: i < 2 ? 'RESIT_PAID' : 'RESIT_ELIGIBLE', resit: i < 2 ? 'PAID' : undefined, withAttempt: true });

  // ═══ 5b. Демо-апелляции (Request.type = APPEAL): одна ожидает, одна на рассмотрении ═══
  const appeal = async (n: number, status: 'PENDING' | 'UNDER_REVIEW', picks: Array<[state: string, reason: string, explanation: string]>, hoursAgo: number) => {
    const s = stud(n);
    const r = await prisma.examResult.findFirst({ where: { studentId: s.id, attemptId: { not: null } }, orderBy: { createdAt: 'asc' }, include: { attempt: { include: { questions: { orderBy: { position: 'asc' }, include: { question: { include: { options: true } } } } } } } });
    if (!r?.attempt || !r.publishedAt) return;
    const used = new Set<number>();
    const items = picks.map(([state, reason, explanation]) => {
      const q = r.attempt!.questions.find((x) => !used.has(x.position) && (state === 'SKIP' ? x.selectedOptionId == null : state === 'WRONG' ? x.selectedOptionId != null && !x.question.options.find((o) => o.id === x.selectedOptionId)!.isCorrect : false))!;
      used.add(q.position);
      const opt = q.selectedOptionId ? q.question.options.find((o) => o.id === q.selectedOptionId)! : null;
      return { position: q.position, questionId: q.questionId, reason, explanation, questionText: q.question.body, answerText: opt ? `${'ABCDE'[q.optionOrder.indexOf(opt.id)]}) ${opt.body}` : null, answerState: state, awardedPoints: state === 'WRONG' ? -1 : 0, maxPoints: 2 };
    });
    const at = new Date(now.getTime() - hoursAgo * 3600000);
    const req = await prisma.request.create({ data: { userId: s.id, type: 'APPEAL', status, description: `${subjName(km[0])} — ${items.length} question(s): ${items.map((i) => 'Q' + i.position).join(', ')}`, createdAt: at } });
    await prisma.examAppeal.create({ data: { requestId: req.id, resultId: r.id, studentId: s.id, subjectId: subj.get(km[0])!.id, originalExamScore: r.examScore, entryScore: r.entryScore, originalTotal: r.total, appealOpenAt: r.publishedAt, appealDeadline: new Date(r.publishedAt.getTime() + 72 * 3600000), reviewStartedAt: status === 'UNDER_REVIEW' ? new Date(at.getTime() + 3600000) : null, createdAt: at, items: { create: items } } });
  };
  await appeal(2, 'PENDING', [['WRONG', 'SCORING_ERROR', 'Mənim cavabım düzgün hesablanıb, amma bal verilməyib. Hesablamanı yenidən yoxlayın.'], ['SKIP', 'ANSWER_NOT_RECORDED', 'Bu suala cavab vermişdim, lakin sistemdə cavab qeyd olunmayıb.']], 6);
  await appeal(4, 'UNDER_REVIEW', [['WRONG', 'QUESTION_WORDING_ERROR', 'Sualın şərti iki cür başa düşülə bilər, mənim cavabım ikinci şərhə uyğundur.'], ['WRONG', 'AMBIGUOUS_WORDING', 'Variantlardan ikisi şərtə görə eyni dərəcədə düzgün görünür.']], 20);

  // прошлый цикл: Spring 2025/26 — окна закрыты; сюжеты resit/retake
  const pastFinal = await prisma.examWindow.create({ data: { title: 'Final exams — Spring 2025/26', kind: 'FINAL', academicYear: '2025-2026', term: 'SPRING', startDate: new Date('2026-06-01'), endDate: new Date('2026-06-30'), allowedWeekdays: [1, 3, 5], startTime: '10:00', endTime: '12:00', maxPerWeek: 3, questionDeadline: new Date('2026-05-15T23:59:59+04:00'), status: 'CLOSED', createdBy: c.adminId } });
  await prisma.examWindow.create({ data: { title: 'Spring 2025/26 — 25% resit (summer)', kind: 'RESIT', academicYear: '2025-2026', term: 'SUMMER', startDate: new Date('2026-07-07'), endDate: new Date('2026-07-20'), allowedWeekdays: [1, 2, 3, 4, 5], startTime: '10:00', endTime: '12:00', maxPerWeek: 3, questionDeadline: new Date('2026-06-30T23:59:59+04:00'), status: 'CLOSED', finalWindowId: pastFinal.id, createdBy: c.adminId } });
  const spring2 = c.semesterCodes('IT', 2); // предметы 2 семестра трека IT (студенты KM-21 учили их прошлой весной)
  await scenario({ n: 7, code: spring2[0], examScore: 6, hoursAgo: 24 * 100, year: '2025-2026', term: 'SPRING', enrollmentStatus: 'RESIT_FORFEITED', resit: 'FORFEITED' }); // не воспользовался resit
  await scenario({ n: 8, code: spring2[0], examScore: 10, hoursAgo: 24 * 100, year: '2025-2026', term: 'SPRING', enrollmentStatus: 'COMPLETED', resit: 'USED' });
  await scenario({ n: 8, code: spring2[0], examScore: 32, hoursAgo: 24 * 88, year: '2025-2026', term: 'SPRING', kind: 'RESIT', enrollmentStatus: 'COMPLETED' }); // resit сдан
  await scenario({ n: 9, code: spring2[0], examScore: 9, hoursAgo: 24 * 100, year: '2025-2026', term: 'SPRING', enrollmentStatus: 'RETAKE_REQUIRED', resit: 'USED' });
  await scenario({ n: 9, code: spring2[0], examScore: 11, hoursAgo: 24 * 88, year: '2025-2026', term: 'SPRING', kind: 'RESIT', enrollmentStatus: 'RETAKE_REQUIRED' }); // resit провален → retake

  // ═══ 6. Предложения предметов (SubjectOffering) ═══
  const years = ['2026-2027', '2027-2028', '2028-2029'];
  const offerRows: Array<{ subjectId: string; academicYear: string; term: Term; course: number; semester: number; cycle: string; isAvailable: boolean; startsAt: Date }> = [];
  let oi = 0;
  for (const sj of subj.values()) {
    const cyc = oi % 5 === 0 ? 'ODD_YEARS' : oi % 5 === 1 ? 'EVEN_YEARS' : 'EVERY_YEAR';
    oi++;
    for (const y of years) {
      const start = Number(y.slice(0, 4));
      if ((cyc === 'EVEN_YEARS' && start % 2) || (cyc === 'ODD_YEARS' && !(start % 2))) continue; // чередование чётных/нечётных лет
      const term: Term = sj.semester % 2 ? 'FALL' : 'SPRING';
      offerRows.push({ subjectId: sj.id, academicYear: y, term, course: Math.ceil(sj.semester / 2), semester: sj.semester, cycle: cyc, isAvailable: true, startsAt: new Date(Date.UTC(term === 'FALL' ? start : start + 1, term === 'FALL' ? 8 : 1, term === 'FALL' ? 15 : 10)) });
    }
  }
  for (let i = 0; i < offerRows.length; i += 500) await prisma.subjectOffering.createMany({ data: offerRows.slice(i, i + 500) });

  // ═══ 7. Летний retake 2027 ═══
  const period = await prisma.summerRetakePeriod.create({ data: { title: 'Summer retake 2027', academicYear: '2026-2027', startDate: new Date('2027-06-21'), endDate: new Date('2027-08-13'), registrationClosesAt: new Date('2027-06-14T18:00:00+04:00') } });
  for (const code of spring2.slice(0, 3)) {
    const sj = subj.get(code)!;
    await prisma.summerRetakeCourse.create({ data: { periodId: period.id, subjectId: sj.id, teacherId: sj.teacherId, schedule: 'Mon/Wed/Fri 10:00–12:00, Room A101', maxStudents: 30, minAttendance: 75, assessment: 'FINAL_EXAM' } });
  }
  log(`  ✓ exams: windows 4, question banks ${banks} (approved ${stat.approved}, review ${stat.submitted}, rejected ${stat.rejected}, draft ${stat.draft}), workstations ${wsRows.length}, enrollments ${enrolRows.length}, offerings ${offerRows.length}`);
  return { examWindows: 4, questionBanks: banks, workstations: wsRows.length, resitWindow: resitW.id, finalWindow: isoDate(finalW.startDate) + '..' + isoDate(finalW.endDate) };
}
