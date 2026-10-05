// E2E: бумажный экзамен + OMR. Запуск: npx ts-node --transpile-only test/exam-e2e-paper.ts
import { execSync } from 'child_process';
import sharp from 'sharp';
import { sheetSvg } from '../src/modules/exams/paper/omr.layout';

const B = process.env.API || 'http://localhost:3001/api/v1';
let pass = 0, fail = 0;
const ok = (c: boolean, n: string, e?: unknown) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, e !== undefined ? JSON.stringify(e) : ''); } };
const sql = (q: string) => execSync(`docker exec ap-postgres psql -U ap -d ap -t -A -c "${q.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
async function call(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(B + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j: any = null; try { j = await r.json(); } catch { /* */ }
  return { status: r.status, body: j };
}
const login = async (u: string) => (await call('POST', '/auth/login', undefined, { loginId: u, password: 'Demo@Portal2026' })).body.accessToken as string;

/** Правильная буква по позиции: опция isCorrect → индекс в optionOrder */
function key(sheetId: string): number[] {
  const rows = sql(`select p.position, array_position(p."optionOrder", o.id) - 1 from "PaperSheetQuestion" p join "QuestionOption" o on o."questionId"=p."questionId" and o."isCorrect" where p."sheetId"='${sheetId}' order by p.position`).split('\n');
  return rows.map((r) => Number(r.split('|')[1]));
}
async function scan(fills: Array<number[] | undefined>, opts: { rotate?: number; blank?: boolean } = {}) {
  const svg = opts.blank
    ? '<svg xmlns="http://www.w3.org/2000/svg" width="794" height="1123"><rect width="794" height="1123" fill="#fff"/></svg>'
    : sheetSvg({ title: 'ANSWER SHEET', subject: 'S', studentName: 'N', studentId: 'I', groupName: 'G', examId: 'E', sheetCode: 'C', kind: 'FINAL' }, fills);
  let img = sharp(Buffer.from(svg), { density: 144 }).flatten({ background: '#ffffff' });
  if (opts.rotate) img = img.rotate(opts.rotate, { background: '#ffffff' });
  return (await img.png().toBuffer()).toString('base64');
}

(async () => {
  const sa = await login('superadmin.demo');
  const exam = sql(`select e.id from "Exam" e where e.delivery='PAPER' limit 1`);
  console.log('\n[Paper] бланки');
  const gen = await call('POST', `/admin/paper/exams/${exam}/generate`, sa, {});
  ok(gen.status < 300 && gen.body.created > 0, `сгенерированы индивидуальные бланки: ${gen.body.created}`, gen.body);
  ok((await call('POST', `/admin/paper/exams/${exam}/generate`, sa, {})).body.created === 0, 'повторная генерация не создаёт дубликатов');
  const sheets = (await call('GET', `/admin/paper/exams/${exam}/sheets`, sa)).body;
  ok(sheets.length === gen.body.created && sheets.every((s: any) => /^OYU-[0-9A-F]{8}$/.test(s.sheetCode)), 'у каждого бланка уникальный код');
  const a = sql(`select "optionOrder"::text from "PaperSheetQuestion" where "sheetId"='${sheets[0].id}' and position=1`);
  const b = sql(`select "optionOrder"::text from "PaperSheetQuestion" where "sheetId"='${sheets[1].id}' and position=1`);
  ok(a !== b, 'у разных студентов разный порядок вариантов/вопросов');
  const html = await fetch(B + `/admin/paper/sheets/${sheets[0].id}/print`, { headers: { authorization: 'Bearer ' + sa } });
  const txt = await html.text();
  ok(html.status === 200 && txt.includes('<svg') && txt.includes('ANSWER SHEET') && !txt.includes('isCorrect'), 'печатная форма: буклет + бланк с пузырьками, без ответов');

  console.log('\n[OMR] чистый бланк с небольшим наклоном');
  const k0 = key(sheets[0].id);
  const fills0: Array<number[] | undefined> = k0.map((c, i) => (i < 15 ? [c] : i < 20 ? [(c + 1) % 5] : undefined));
  const up0 = await call('POST', `/admin/paper/sheets/${sheets[0].id}/scan`, sa, { mimeType: 'image/png', dataBase64: await scan(fills0, { rotate: 1.2 }) });
  ok(up0.status < 300, 'скан загружен', up0.body);
  const d0 = up0.body;
  ok(d0.status === 'SCORED', 'чистый бланк без сомнений оценён автоматически (SCORED)', { status: d0.status, flags: d0.questions?.filter((q: any) => q.flags.length).map((q: any) => [q.position, q.flags]) });
  const r0 = sql(`select correct||'/'||wrong||'/'||skipped||'/'||"examScore" from "ExamResult" where "sheetId"='${sheets[0].id}'`);
  ok(r0 === '15/5/5/25.00', 'OMR: 15 верных, 5 неверных, 5 пропусков → 25 (+2/−1/0)', r0);
  ok(sql(`select source from "ExamResult" where "sheetId"='${sheets[0].id}'`) === 'PAPER', 'результат помечен PAPER');

  console.log('\n[OMR] два пузырька, ручная проверка');
  const k1 = key(sheets[1].id);
  const fills1: Array<number[] | undefined> = k1.map((c, i) => (i < 10 ? [c] : undefined));
  fills1[2] = [k1[2], (k1[2] + 2) % 5]; // два пузырька в вопросе 3
  const up1 = await call('POST', `/admin/paper/sheets/${sheets[1].id}/scan`, sa, { mimeType: 'image/png', dataBase64: await scan(fills1) });
  ok(up1.body.status === 'MANUAL_REVIEW_REQUIRED', 'двойная отметка → MANUAL_REVIEW_REQUIRED', up1.body.status);
  ok(up1.body.questions[2].flags.includes('DOUBLE'), 'вопрос 3 помечен DOUBLE');
  ok(up1.body.questions[3].detected !== null && up1.body.questions[20].flags.includes('EMPTY') && !up1.body.questions[20].flags.includes('DOUBLE'), 'пустые вопросы = EMPTY (SKIP), без ручной проверки');
  ok((await call('POST', `/admin/paper/sheets/${sheets[1].id}/confirm`, sa)).status === 409, 'подтвердить без проверки сомнительных нельзя (REVIEW_PENDING)');
  const review = await call('GET', '/admin/paper/review', sa);
  ok(review.body.some((s: any) => s.id === sheets[1].id && s.pending === 1), 'бланк в очереди ручной проверки');
  const fix = await call('PUT', `/admin/paper/sheets/${sheets[1].id}/answers/3`, sa, { letter: 'ABCDE'[k1[2]], reason: 'Верный ответ различим на скане' });
  ok(fix.status < 300 && fix.body.questions[2].final === 'ABCDE'[k1[2]] && fix.body.questions[2].reviewed, 'сотрудник исправил распознанный ответ');
  const conf = await call('POST', `/admin/paper/sheets/${sheets[1].id}/confirm`, sa);
  ok(conf.body.status === 'SCORED', 'после проверки бланк оценён', conf.body.status);
  ok(sql(`select correct from "ExamResult" where "sheetId"='${sheets[1].id}'`) === '10', 'считаются 10 верных (вопрос 3 по решению сотрудника)');
  ok(Number(sql(`select count(*) from "AuditLog" where action='exam.answer_manually_corrected' and "targetId"='${sheets[1].id}'`)) === 1, 'ручное изменение записано в Audit Log');
  ok((await call('PUT', `/admin/paper/sheets/${sheets[1].id}/answers/4`, sa, { letter: 'A', reason: 'late edit' })).status === 409, 'после оценивания править ответы нельзя');

  console.log('\n[OMR] плохое качество');
  const up2 = await call('POST', `/admin/paper/sheets/${sheets[2].id}/scan`, sa, { mimeType: 'image/png', dataBase64: await scan([], { blank: true }) });
  ok(up2.body.status === 'MANUAL_REVIEW_REQUIRED' && up2.body.scans[0].note === 'MARKERS_NOT_FOUND', 'скан без маркеров → ручная проверка (MARKERS_NOT_FOUND)', up2.body.scans && up2.body.scans[0]);
  ok((await call('POST', `/admin/paper/sheets/${sheets[2].id}/confirm`, sa)).status === 409, 'такой бланк нельзя подтвердить без проверки каждого вопроса');
  const img = await fetch(B + `/admin/paper/sheets/${sheets[2].id}/scan-image`, { headers: { authorization: 'Bearer ' + sa } });
  ok(img.status === 200 && img.headers.get('content-type') === 'image/png', 'сотрудник может открыть скан');
  ok((await call('GET', `/admin/paper/sheets/${sheets[2].id}`, await login('student1.demo'))).status === 403, 'студент не имеет доступа к бланкам');

  console.log(`\nИтог: ${pass} прошло, ${fail} не прошло`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
