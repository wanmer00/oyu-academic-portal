// E2E: resit-экзамен (цикл, оплата), провал resit → RETAKE, закрытие окон (неявка, сгорание resit). Запуск: node test/exam-e2e-resit.js
// Выполнять на свежих демо-данных (после demo:reset), до/после основного теста — состояние студентов 4–6 берётся из seed.
const { execSync } = require('child_process');
const B = process.env.API || 'http://localhost:3001/api/v1';
const PW = 'Demo@Portal2026';
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, e !== undefined ? JSON.stringify(e) : ''); } };
const sql = (q) => execSync(`docker exec ap-postgres psql -U ap -d ap -t -A -c "${q.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
async function call(method, path, { token, key, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  if (key) headers['x-workstation-key'] = key;
  const r = await fetch(B + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* */ }
  return { status: r.status, body: j };
}
const login = async (u) => (await call('POST', '/auth/login', { body: { loginId: u, password: PW } })).body.accessToken;
const key = (n) => `wk_demo_B101_PC-${String(n).padStart(2, '0')}`;
const solve = (qq) => { const m = /(\d+) × (\d+)/.exec(qq.body); const v = String(Number(m[1]) * Number(m[2])); return qq.options.find((o) => o.body === v).id; };

(async () => {
  const pr = await login('proctor.demo'), sa = await login('superadmin.demo');
  for (let i = 1; i <= 4; i++) await call('GET', '/exam-runtime/state', { key: key(i) });
  const rooms = (await call('GET', '/proctor/rooms', { token: pr })).body;
  const ws = (await call('GET', `/proctor/rooms/${rooms.find((r) => r.code === 'B101').id}/status`, { token: pr })).body;
  const wsId = (n) => ws.find((w) => w.code === `PC-${String(n).padStart(2, '0')}`).id;
  const student = async (login) => (await call('GET', `/proctor/students?q=${login}`, { token: pr })).body[0];
  const resitWin = (await call('GET', '/admin/exam-windows?kind=RESIT', { token: sa })).body.find((w) => w.title.startsWith('Fall'));
  const finalWin = (await call('GET', '/admin/exam-windows?kind=FINAL', { token: sa })).body.find((w) => w.title.startsWith('Final exams — Fall'));
  const resitExams = (await call('GET', `/admin/exam-windows/${resitWin.id}`, { token: sa })).body.exams;
  const examFor = (code) => resitExams.find((e) => e.subject.code === code).id;

  console.log('\n[1] Допуск к resit');
  const s5 = await student('student5.demo'), s4 = await student('student4.demo'), s6 = await student('student6.demo');
  const code0 = (await call('GET', '/me/exams', { token: await login('student5.demo') })).body.resits.items[0].subject.code;
  const auth = (n, examId, st) => call('POST', '/proctor/authorizations', { token: pr, body: { studentId: st.id, examId, workstationId: wsId(n), idChecked: true, passportChecked: true } });
  let a = await auth(1, examFor(code0), s5);
  ok(a.status === 409 && (a.body.reasons || []).includes('WINDOW_NOT_STARTED'), 'resit оплачен, но окно resit ещё не началось (+1 неделя после финального) → отказ', a.body);
  const today = new Date(Date.now() + 4 * 3600000).toISOString().slice(0, 10);
  const end = new Date(Date.now() + 4 * 3600000 + 10 * 86400000).toISOString().slice(0, 10);
  const up = await call('PUT', `/admin/exam-windows/${resitWin.id}`, { token: sa, body: { startDate: today, endDate: end, allowedWeekdays: [1, 2, 3, 4, 5, 6, 7], startTime: '00:00', endTime: '23:59' } });
  ok(up.status === 200, 'Management перенёс окно resit на сегодня (окно можно изменять)', up.body);
  a = await auth(1, examFor((await call('GET', '/me/exams', { token: await login('student4.demo') })).body.resits.items[0].subject.code), s4);
  ok(a.status === 409 && (a.body.reasons || []).includes('RESIT_NOT_PAID'), 'студент без оплаты не допускается к resit (RESIT_NOT_PAID)', a.body);
  const s1 = await student('student1.demo');
  a = await auth(1, examFor('IT301'), s1);
  ok(a.status === 409 && (a.body.reasons || []).some((r) => ['RESIT_NOT_ELIGIBLE', 'ALREADY_PASSED', 'NOT_ENROLLED'].includes(r)), 'студент без права на resit не допускается', a.body);

  console.log('\n[2] Провал resit → RETAKE_REQUIRED');
  a = await auth(1, examFor(code0), s5);
  ok(a.status < 300, 'student5 (resit оплачен) авторизован', a.body);
  let st = await call('GET', '/exam-runtime/state', { key: key(1) });
  await call('POST', '/exam-runtime/start', { key: key(1), body: { token: st.body.launchToken } });
  const at = await call('GET', '/exam-runtime/attempt', { key: key(1) });
  // пропускаем всё, кроме трёх заведомо неверных ответов → Exam < 17
  for (let i = 0; i < 3; i++) await call('PUT', `/exam-runtime/answers/${i + 1}`, { key: key(1), body: { optionId: at.body.questions[i].options.find((o) => o.id !== solve(at.body.questions[i])).id, seq: i + 1 } });
  const res = await call('POST', '/exam-runtime/submit', { key: key(1) });
  ok(res.body.passed === false && res.body.examScore === -3 && res.body.kind === 'RESIT', 'resit провален: Exam Score = −3 (минимум учитывает штрафы)', res.body);
  const me5 = (await call('GET', '/me/exams', { token: await login('student5.demo') })).body;
  ok(me5.retakes.required.some((r) => r.subject.code === code0 && r.status === 'RETAKE_REQUIRED'), 'предмет → RETAKE_REQUIRED');
  ok(!me5.resits.items.some((r) => r.subject.code === code0), '"Pay 25% and try again" больше не показывается');
  ok(sql(`select status from "ResitEligibility" where "studentId"='${s5.id}' and "subjectId"=(select id from "Subject" where code='${code0}')`) === 'USED', 'право resit помечено USED');
  const again = await auth(2, examFor(code0), s5);
  ok(again.status === 409, 'повторный resit невозможен');

  console.log('\n[3] Успешный resit → COMPLETED, Journal обновляется');
  const items6 = (await call('GET', '/me/exams', { token: await login('student6.demo') })).body.resits.items.filter((i) => i.payment === 'PAID');
  ok(items6.length === 2, 'student6 имеет 2 оплаченных resit', items6.length);
  const c6 = items6[0].subject.code;
  a = await auth(2, examFor(c6), s6);
  ok(a.status < 300, 'resit-экзамен не подпадает под лимит 3/неделю (student6 уже сдал 3 финала)', a.body);
  st = await call('GET', '/exam-runtime/state', { key: key(2) });
  await call('POST', '/exam-runtime/start', { key: key(2), body: { token: st.body.launchToken } });
  const at6 = await call('GET', '/exam-runtime/attempt', { key: key(2) });
  for (const q of at6.body.questions) await call('PUT', `/exam-runtime/answers/${q.position}`, { key: key(2), body: { optionId: solve(q), seq: 1 } });
  const res6 = await call('POST', '/exam-runtime/submit', { key: key(2) });
  ok(res6.body.examScore === 50 && res6.body.passed && res6.body.kind === 'RESIT', '25 верных = 50 баллов, resit сдан', res6.body);
  ok(sql(`select status from "SubjectEnrollment" where "studentId"='${s6.id}' and "subjectId"=(select id from "Subject" where code='${c6}') and "academicYear"='2026-2027'`) === 'COMPLETED', 'предмет → COMPLETED');
  ok(Number(sql(`select value from "Grade" where "studentId"='${s6.id}' and type='FINAL' and "subjectId"=(select id from "Subject" where code='${c6}') and "academicYear"='2026-2027'`)) === 50, 'Journal FINAL = 50 (результат resit заменил провал)');
  ok(sql(`select count(*) from "GradeHistory" where "changedBy"='system:exam'`) >= 1, 'изменение FINAL записано в историю оценок');

  console.log('\n[4] Закрытие окон');
  const absentBefore = Number(sql(`select count(*) from "ExamResult" where source='ABSENT'`));
  const cl = await call('POST', `/admin/exam-windows/${finalWin.id}/close`, { token: sa });
  ok(cl.status < 300 && cl.body.closed && cl.body.absent > 0, `финальное окно закрыто: неявившиеся получили результат ABSENT (${cl.body.absent})`, cl.body);
  ok(Number(sql(`select count(*) from "ExamResult" where source='ABSENT'`)) - absentBefore === cl.body.absent, 'ABSENT-результаты созданы');
  ok(Number(sql(`select count(*) from "SubjectEnrollment" where status='RESIT_ELIGIBLE' and "academicYear"='2026-2027'`)) > 10, 'неявка = провал → право на resit');
  ok((await call('POST', `/admin/exam-windows/${finalWin.id}/close`, { token: sa })).body.closed === false, 'повторное закрытие безопасно');
  const rc = await call('POST', `/admin/exam-windows/${resitWin.id}/close`, { token: sa });
  ok(rc.body.closed && rc.body.forfeited >= 1, `окно resit закрыто: неиспользованные resit сгорели (${rc.body.forfeited})`, rc.body);
  const me6 = (await call('GET', '/me/exams', { token: await login('student6.demo') })).body;
  ok(me6.retakes.required.some((r) => r.reason === 'RESIT_MISSED' || r.reason === 'RESIT_FAILED'), 'после сгорания resit доступен retake');
  const cs = (await call('GET', '/admin/exam-analytics', { token: sa })).body;
  ok(cs.totals.completed > 0 && cs.grades && Array.isArray(cs.subjectFailure) && cs.payments.length > 0, 'аналитика: результаты, оценки, провалы по предметам, платежи', Object.keys(cs));
  const rs = await call('GET', '/admin/exam-results?status=FAILED', { token: sa });
  ok(rs.body.length > 0 && rs.body.every((r) => !r.passed), 'фильтр результатов по статусу работает');

  console.log(`\nИтог: ${pass} прошло, ${fail} не прошло`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
