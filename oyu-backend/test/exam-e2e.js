// E2E-проверка Exam Management System против запущенного API (docker compose up) и демо-данных.
//   node test/exam-e2e.js            (API: http://localhost:3001/api/v1, БД: контейнер ap-postgres)
// Нужны повышенные лимиты: RATE_LIMIT_AUTH_MAX=1000 RATE_LIMIT_MAX=100000 (иначе throttler вернёт 429).
const { execSync } = require('child_process');
const B = process.env.API || 'http://localhost:3001/api/v1';
const PW = 'Demo@Portal2026';
let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); } };
const sql = (q) => execSync(`docker exec ap-postgres psql -U ap -d ap -t -A -c "${q.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();

async function call(method, path, { token, key, body, raw } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  if (key) headers['x-workstation-key'] = key;
  const r = await fetch(B + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) return r;
  let j = null; try { j = await r.json(); } catch { /* not json */ }
  return { status: r.status, body: j };
}
const login = async (u) => { const r = await call('POST', '/auth/login', { body: { loginId: u, password: PW } }); if (!r.body?.accessToken) throw new Error('login ' + u + ' ' + r.status + JSON.stringify(r.body)); return r.body.accessToken; };
const ws = (room, n) => `wk_demo_${room}_PC-${String(n).padStart(2, '0')}`;
const code = (r) => r.body?.code ?? r.body?.message;

(async () => {
  const T = {};
  for (const u of ['proctor.demo', 'rector.demo', 'superadmin.demo', 'student1.demo', 'student2.demo', 'student4.demo', 'student6.demo', 'student9.demo', 'student12.demo', 'teacher1.demo']) T[u] = await login(u);
  const wsList = await call('GET', '/admin/exam-workstations', { token: T['rector.demo'] });
  console.log('\n[1] Рабочие места и защита запуска');
  ok(wsList.status === 200 && wsList.body.length === 42, '42 рабочих места зарегистрированы', wsList.status);
  ok((await call('GET', '/exam-runtime/state')).status === 401, 'без ключа ПК runtime недоступен (401)');
  ok((await call('GET', '/exam-runtime/state', { key: 'wk_wrong' })).status === 403, 'неизвестный ключ ПК — 403');
  ok((await call('GET', '/exam-runtime/state', { token: T['student1.demo'] })).status === 401, 'студенческий JWT без ключа ПК не открывает runtime');
  ok((await call('GET', '/proctor/rooms', { token: T['student1.demo'] })).status === 403, 'студент не имеет доступа к proctor API');
  ok((await call('GET', '/proctor/rooms', { token: T['teacher1.demo'] })).status === 403, 'преподаватель не имеет доступа к proctor API');
  for (let i = 1; i <= 6; i++) await call('GET', '/exam-runtime/state', { key: ws('B101', i) }); // ПК онлайн
  const rooms = await call('GET', '/proctor/rooms', { token: T['proctor.demo'] });
  const roomB101 = rooms.body.find((r) => r.code === 'B101');
  ok(rooms.status === 200 && roomB101, 'проктор видит свои аудитории', rooms.status);
  const status0 = await call('GET', `/proctor/rooms/${roomB101.id}/status`, { token: T['proctor.demo'] });
  ok(status0.body.filter((w) => w.state === 'AVAILABLE').length >= 6, 'онлайн ПК = AVAILABLE (в DEMO_MODE все ПК онлайн)', status0.body.map((w) => w.state).join(','));
  const wsId = (n) => status0.body.find((w) => w.code === `PC-${String(n).padStart(2, '0')}`).id;

  console.log('\n[2] Витрина студента');
  const ov = await call('GET', '/me/exams', { token: T['student1.demo'] });
  ok(ov.status === 200 && ov.body.available.length === 5, 'student1: 5 предметов доступны сегодня', ov.body && ov.body.available?.length);
  ok(ov.body.available.every((e) => e.admission.eligible), 'student1 допущен ко всем (Entry Score есть)');
  ok(!JSON.stringify(ov.body).includes('isCorrect'), 'витрина не содержит правильных ответов');
  const ex1 = ov.body.available.find((e) => e.subject.code.startsWith('IT3'));
  const exams = ov.body.available;

  console.log('\n[3] Авторизация проктором и запуск');
  const st1 = (await call('GET', '/proctor/students?q=student1.demo', { token: T['proctor.demo'] })).body[0];
  ok(st1 && st1.loginId === 'student1.demo', 'проктор находит студента по loginId');
  const stExams = await call('GET', `/proctor/students/${st1.id}/exams`, { token: T['proctor.demo'] });
  ok(stExams.body.exams.length >= 5 && stExams.body.exams.every((e) => e.eligible), 'проктор видит допуск по предметам');
  const authBody = (n, examId, studentId = st1.id, id = true) => ({ studentId, examId, workstationId: wsId(n), idChecked: id, passportChecked: true });
  ok((await call('POST', '/proctor/authorizations', { token: T['proctor.demo'], body: authBody(1, ex1.examId, st1.id, false) })).status === 400, 'без подтверждения ID/паспорта авторизация невозможна (400)');
  const a1 = await call('POST', '/proctor/authorizations', { token: T['proctor.demo'], body: authBody(1, ex1.examId) });
  ok(a1.status === 201 || a1.status === 200, 'проктор авторизовал студента на PC-01', a1.body);
  const a1dup = await call('POST', '/proctor/authorizations', { token: T['proctor.demo'], body: authBody(2, ex1.examId) });
  ok(a1dup.status === 409 && (a1dup.body.reasons || []).includes('ATTEMPT_EXISTS'), 'повторная авторизация на тот же экзамен отклонена', a1dup.body);
  const busy = await call('POST', '/proctor/authorizations', { token: T['proctor.demo'], body: authBody(1, exams[1].examId, (await call('GET', '/proctor/students?q=student3.demo', { token: T['proctor.demo'] })).body[0].id) });
  ok(busy.status === 409 && code(busy) === 'WORKSTATION_BUSY', 'занятый ПК нельзя назначить второму студенту', busy.body);
  const w = await call('GET', '/exam-runtime/state', { key: ws('B101', 1) });
  ok(w.body.state === 'WAITING' && w.body.launchToken && w.body.student.loginId === 'student1.demo', 'ПК получил ожидающую авторизацию (WAITING)', w.body);
  ok((await call('GET', '/exam-runtime/state', { key: ws('B101', 2) })).body.state === 'IDLE', 'другой ПК остаётся IDLE');
  ok((await call('POST', '/exam-runtime/start', { key: ws('B101', 2), body: { token: w.body.launchToken } })).status === 409, 'токен чужого ПК не работает (нет авторизации на этом ПК)');
  ok((await call('POST', '/exam-runtime/start', { key: ws('B101', 1), body: { token: 'x'.repeat(43) } })).status === 403, 'неверный токен — 403');
  const start = await call('POST', '/exam-runtime/start', { key: ws('B101', 1), body: { token: w.body.launchToken } });
  ok(start.status === 201 || start.status === 200, 'START EXAM: токен принят', start.body);
  const again = await call('POST', '/exam-runtime/start', { key: ws('B101', 1), body: { token: w.body.launchToken } });
  ok(again.status === 409 || again.status === 403, 'повторное использование токена невозможно', again.status);

  console.log('\n[4] Снапшот, рандомизация, таймер');
  const at = await call('GET', '/exam-runtime/attempt', { key: ws('B101', 1) });
  const q = at.body.questions;
  ok(q.length === 25, '25 вопросов', q?.length);
  ok(!JSON.stringify(at.body).match(/isCorrect|correct/i), 'в ответе runtime нет признаков правильного ответа');
  ok(q.every((x) => x.options.length === 5 && x.options.map((o) => o.label).join('') === 'ABCDE'), 'у каждого вопроса варианты A–E');
  const at2 = await call('GET', '/exam-runtime/attempt', { key: ws('B101', 1) });
  ok(JSON.stringify(at2.body.questions) === JSON.stringify(q), 'refresh возвращает тот же снапшот (вопросы и порядок вариантов)');
  const dur = new Date(at.body.expiresAt) - new Date(at.body.startedAt);
  ok(dur === 120 * 60000, 'таймер на сервере = 2 часа', dur);
  ok(new Date(at.body.expiresAt) > new Date(at.body.serverNow), 'serverNow < expiresAt');
  // индивидуальность: второй студент (ниже) получит другой набор
  const solve = (qq) => { const m = /(\d+) × (\d+)/.exec(qq.body); const v = String(Number(m[1]) * Number(m[2])); return qq.options.find((o) => o.body === v).id; };

  console.log('\n[5] Автосохранение и оценивание');
  // 15 верных, 5 неверных, 5 пропусков → 30 − 5 = 25
  let seq = 0;
  for (let i = 0; i < 25; i++) {
    const qq = q[i];
    let optionId = null;
    if (i < 15) optionId = solve(qq);
    else if (i < 20) optionId = qq.options.find((o) => o.id !== solve(qq)).id;
    if (optionId) { const r = await call('PUT', `/exam-runtime/answers/${qq.position}`, { key: ws('B101', 1), body: { optionId, seq: ++seq } }); if (r.status !== 200) ok(false, 'answer save', r.body); }
  }
  const stale = await call('PUT', `/exam-runtime/answers/1`, { key: ws('B101', 1), body: { optionId: q[0].options[1].id, seq: 1 } });
  ok(stale.body.saved === false, 'устаревший (меньший seq) запрос не перезаписывает ответ');
  ok((await call('PUT', `/exam-runtime/answers/1`, { key: ws('B101', 1), body: { optionId: 'foreign-option-id', seq: 99 } })).status === 400, 'чужой вариант ответа отклонён');
  const at3 = await call('GET', '/exam-runtime/attempt', { key: ws('B101', 1) });
  ok(at3.body.questions.filter((x) => x.selectedOptionId).length === 20, 'ответы восстанавливаются после refresh (20 сохранено)');
  const entry = Number(sql(`select "entryScore" from "SubjectEnrollment" where "studentId"='${st1.id}' and "subjectId"=(select "subjectId" from "Exam" where id='${ex1.examId}') and "academicYear"='2026-2027'`));
  const sub = await call('POST', '/exam-runtime/submit', { key: ws('B101', 1) });
  ok(sub.body.published && sub.body.examScore === 25 && sub.body.correct === 15 && sub.body.wrong === 5 && sub.body.skipped === 5, 'результат: 15 верных, 5 неверных, 5 пропусков → 25/50', sub.body);
  ok(Math.abs(sub.body.total - (entry + 25)) < 0.001, 'Total = Entry + Exam', { entry, total: sub.body.total });
  ok(sub.body.passed === (sub.body.total >= 51 && sub.body.examScore >= 17), 'PASS согласуется с правилом (Total ≥ 51 и Exam ≥ 17)', sub.body);
  ok((await call('POST', '/exam-runtime/submit', { key: ws('B101', 1) })).status === 404, 'повторная сдача невозможна');
  ok((await call('PUT', `/exam-runtime/answers/1`, { key: ws('B101', 1), body: { optionId: null, seq: 500 } })).status === 404, 'после сдачи ответы менять нельзя');
  const myRes = await call('GET', '/me/exams', { token: T['student1.demo'] });
  ok(myRes.body.results.length === 1 && myRes.body.results[0].examScore === 25, 'результат виден студенту на вкладке Results');
  ok(myRes.body.subjects.find((s) => s.subject.code === ex1.subject.code).status === (sub.body.passed ? 'COMPLETED' : 'RESIT_ELIGIBLE'), 'статус предмета обновился');
  ok(Number(sql(`select count(*) from "Grade" where "studentId"='${st1.id}' and type='FINAL' and "academicYear"='2026-2027' and comment='Exam System'`)) === 1, 'Exam Score записан в Journal как FINAL');
  ok(sql(`select count(*) from "AuditLog" where action like 'exam.%' and "targetId"=(select id from "ExamAttempt" where "studentId"='${st1.id}' limit 1)`) >= 3, 'в Audit Log есть события попытки');
  ok((await call('POST', '/proctor/authorizations', { token: T['proctor.demo'], body: authBody(3, ex1.examId) })).status === 409, 'второй экзамен по тому же предмету невозможен');

  console.log('\n[6] Максимум 3 финальных экзамена в неделю');
  const others = exams.filter((e) => e.examId !== ex1.examId);
  const run = async (n, ex, studentId, token) => {
    const a = await call('POST', '/proctor/authorizations', { token: T['proctor.demo'], body: authBody(n, ex.examId, studentId) });
    if (a.status >= 300) return a;
    const s = await call('GET', '/exam-runtime/state', { key: ws('B101', n) });
    await call('POST', '/exam-runtime/start', { key: ws('B101', n), body: { token: s.body.launchToken } });
    await call('POST', '/exam-runtime/submit', { key: ws('B101', n) });
    return a;
  };
  ok((await run(2, others[0], st1.id)).status < 300, '2-й экзамен недели');
  ok((await run(3, others[1], st1.id)).status < 300, '3-й экзамен недели');
  const fourth = await call('POST', '/proctor/authorizations', { token: T['proctor.demo'], body: authBody(4, others[2].examId) });
  ok(fourth.status === 409 && (fourth.body.reasons || []).includes('WEEKLY_LIMIT'), '4-й экзамен за неделю отклонён (WEEKLY_LIMIT)', fourth.body);
  const s6 = (await call('GET', '/proctor/students?q=student6.demo', { token: T['proctor.demo'] })).body[0];
  const s6ex = await call('GET', `/proctor/students/${s6.id}/exams`, { token: T['proctor.demo'] });
  ok(s6ex.body.exams.some((e) => e.reasons.includes('WEEKLY_LIMIT')), 'student6 (3 экзамена уже сданы) блокируется по неделе', s6ex.body.exams.map((e) => e.reasons));

  console.log('\n[7] Окно и время');
  const winId = (await call('GET', '/admin/exam-windows?kind=FINAL&status=PUBLISHED', { token: T['rector.demo'] })).body[0].id;
  const nowBaku = new Date(Date.now() + 4 * 3600000);
  const hh = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const mins = nowBaku.getUTCHours() * 60 + nowBaku.getUTCMinutes();
  const st3 = (await call('GET', '/proctor/students?q=student3.demo', { token: T['proctor.demo'] })).body[0];
  const ex3 = (await call('GET', '/me/exams', { token: await login('student3.demo') })).body.available;
  if (mins >= 1 && mins <= 1438) {
    // окно «заканчивается» ровно сейчас: время старта должно быть строго меньше endTime
    await call('PUT', `/admin/exam-windows/${winId}`, { token: T['superadmin.demo'], body: { startTime: '00:00', endTime: hh(mins) } });
    const late = await call('POST', '/proctor/authorizations', { token: T['proctor.demo'], body: authBody(5, ex3[0].examId, st3.id) });
    ok(late.status === 409 && (late.body.reasons || []).includes('OUTSIDE_ALLOWED_TIME'), 'старт в endTime (как 12:00 для окна 10–12) отклонён', late.body);
    await call('PUT', `/admin/exam-windows/${winId}`, { token: T['superadmin.demo'], body: { startTime: '00:00', endTime: hh(Math.min(mins + 1, 1439)) } });
    const edge = await call('POST', '/proctor/authorizations', { token: T['proctor.demo'], body: authBody(5, ex3[0].examId, st3.id) });
    ok(edge.status < 300 || (edge.body.reasons || []).every((r) => r !== 'OUTSIDE_ALLOWED_TIME'), 'за минуту до окончания окна старт разрешён', edge.body);
    if (edge.status < 300) await call('DELETE', `/proctor/authorizations/${edge.body.authorizationId}`, { token: T['proctor.demo'], body: { reason: 'test cleanup' } });
    await call('PUT', `/admin/exam-windows/${winId}`, { token: T['superadmin.demo'], body: { startTime: '00:00', endTime: '23:59' } });
  }
  const wd = (new Date(Date.now() + 4 * 3600000).getUTCDay() || 7);
  await call('PUT', `/admin/exam-windows/${winId}`, { token: T['superadmin.demo'], body: { allowedWeekdays: [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== wd) } });
  const wdDeny = await call('POST', '/proctor/authorizations', { token: T['proctor.demo'], body: authBody(5, ex3[0].examId, st3.id) });
  ok(wdDeny.status === 409 && (wdDeny.body.reasons || []).includes('WEEKDAY_NOT_ALLOWED'), 'запрещённый день недели отклонён', wdDeny.body);
  await call('PUT', `/admin/exam-windows/${winId}`, { token: T['superadmin.demo'], body: { allowedWeekdays: [1, 2, 3, 4, 5, 6] } });
  ok((await call('GET', `/admin/exam-windows/${winId}`, { token: T['rector.demo'] })).body.version >= 4, 'изменения окна версионируются');

  console.log('\n[8] Таймер: автосдача по истечению');
  const stT = (await call('GET', '/proctor/students?q=student12.demo', { token: T['proctor.demo'] })).body[0];
  const exT = (await call('GET', '/me/exams', { token: T['student12.demo'] })).body.available.find((e) => e.delivery === 'COMPUTER');
  const aT = await call('POST', '/proctor/authorizations', { token: T['proctor.demo'], body: authBody(6, exT.examId, stT.id) });
  const sT = await call('GET', '/exam-runtime/state', { key: ws('B101', 6) });
  await call('POST', '/exam-runtime/start', { key: ws('B101', 6), body: { token: sT.body.launchToken } });
  const atT = await call('GET', '/exam-runtime/attempt', { key: ws('B101', 6) });
  await call('PUT', `/exam-runtime/answers/1`, { key: ws('B101', 6), body: { optionId: solve(atT.body.questions[0]), seq: 1 } });
  sql(`update "ExamAttempt" set "expiresAt" = now() - interval '1 minute' where id='${aT.body.attemptId}'`);
  const late = await call('PUT', `/exam-runtime/answers/2`, { key: ws('B101', 6), body: { optionId: null, seq: 2 } });
  ok(late.status === 409 && code(late) === 'TIME_EXPIRED', 'после истечения времени ответы не принимаются', late.body);
  ok(sql(`select status from "ExamAttempt" where id='${aT.body.attemptId}'`) === 'AUTO_SUBMITTED', 'попытка автоматически завершена (AUTO_SUBMITTED)');
  ok(Number(sql(`select correct from "ExamResult" where "attemptId"='${aT.body.attemptId}'`)) === 1, 'сохранённый ответ оценён (1 верный)');

  console.log('\n[9] 25% resit: стоимость, лимит 2, повторная оплата');
  const rs4 = await call('GET', '/me/exams', { token: T['student4.demo'] });
  const it4 = rs4.body.resits.items[0];
  ok(it4 && it4.credits === 8 && it4.fee === 30 && it4.fullCost === 120, 'стоимость resit = 8 кредитов × 15 × 25% = 30 AZN', it4);
  ok(it4.canPay && it4.window, 'студент видит окно resit и может оплатить');
  const pay4 = await call('POST', `/me/resits/${it4.resitId}/pay`, { token: T['student4.demo'], body: {} });
  ok(pay4.body.status === 'PAID' && pay4.body.amount === 30, 'оплата DEMO: сумма пересчитана backend-ом (30)', pay4.body);
  ok((await call('POST', `/me/resits/${it4.resitId}/pay`, { token: T['student4.demo'], body: {} })).status === 409, 'повторная оплата уже оплаченного resit — 409');
  ok((await call('POST', `/me/resits/${it4.resitId}/pay`, { token: T['student1.demo'], body: {} })).status === 404, 'чужой resit оплатить нельзя');
  const rs6 = (await call('GET', '/me/exams', { token: T['student6.demo'] })).body.resits;
  const third = rs6.items.find((i) => i.payment === 'ELIGIBLE' && i.limitReached);
  ok(rs6.limit.cycles[0].used === 2 && third, 'student6: 2 resit использованы, третий предмет — лимит цикла', rs6.limit);
  const lim = await call('POST', `/me/resits/${third.resitId}/pay`, { token: T['student6.demo'], body: {} });
  ok(lim.status === 409 && code(lim) === 'RESIT_LIMIT', 'третий resit в цикле отклонён backend-ом (RESIT_LIMIT)', lim.body);
  const rs5 = (await call('GET', '/me/exams', { token: await login('student5.demo') })).body.resits.items[0];
  ok(rs5.payment === 'PAID' && rs5.status === 'RESIT_PAID', 'student5: resit уже оплачен');
  const failPay = await call('POST', `/me/resits/${(await call('GET', '/me/exams', { token: await login('student2.demo') })).body.resits.items[0]?.resitId ?? 'none'}/pay`, { token: await login('student2.demo'), body: {} });
  ok(failPay.status === 404, 'у сдавшего предмета resit отсутствует');

  console.log('\n[10] Retake ≠ resit');
  const rt9 = (await call('GET', '/me/exams', { token: T['student9.demo'] })).body;
  ok(rt9.retakes.required.length === 1 && rt9.retakes.required[0].reason === 'RESIT_FAILED', 'student9: провал resit → RETAKE_REQUIRED', rt9.retakes.required);
  ok(rt9.resits.items.length === 0, 'после провала resit новый 25% resit не предлагается');
  const opt = rt9.retakes.required[0];
  ok(opt.summer.length === 1 && opt.next && opt.next.academicYear, 'доступны летний курс и ближайшее предложение предмета', { s: opt.summer.length, n: opt.next });
  const reg = await call('POST', `/me/retakes/${opt.enrollmentId}/register`, { token: T['student9.demo'], body: { mode: 'NEXT_OFFERING', offeringId: opt.next.offeringId } });
  ok(reg.status < 300, 'студент зарегистрировался на ближайшее предложение', reg.body);
  ok((await call('POST', `/me/retakes/${opt.enrollmentId}/register`, { token: T['student9.demo'], body: { mode: 'NEXT_OFFERING', offeringId: opt.next.offeringId } })).status === 409, 'повторная регистрация невозможна');
  ok(Number(sql(`select count(*) from "SubjectEnrollment" where "studentId"=(select id from "User" where "loginId"='student9.demo') and "attemptNo"=2`)) === 1, 'создан новый enrollment (attemptNo = 2)');
  const rt7 = (await call('GET', '/me/exams', { token: await login('student7.demo') })).body;
  ok(rt7.retakes.required[0]?.reason === 'RESIT_MISSED', 'student7: упущенный resit → доступен retake', rt7.retakes.required[0]?.reason);

  console.log('\n[11] Права и аудит');
  ok((await call('GET', '/admin/exam-windows', { token: T['student1.demo'] })).status === 403, 'студент не видит окна управления');
  ok((await call('GET', '/admin/exam-audit', { token: T['teacher1.demo'] })).status === 403, 'преподаватель не видит audit экзаменов');
  const au = await call('GET', '/admin/exam-audit?take=50', { token: T['rector.demo'] });
  ok(au.status === 200 && au.body.some((x) => x.action === 'exam.student_authorized') && au.body.some((x) => x.action === 'exam.submitted') && au.body.some((x) => x.action === 'exam.auto_submitted'), 'audit содержит авторизацию, сдачу и автосдачу');
  let blocked = false;
  try { sql(`update "AuditLog" set action='x' where id=(select id from "AuditLog" limit 1)`); } catch { blocked = true; }
  ok(blocked, 'AuditLog нельзя изменить даже напрямую в БД (триггер)');
  blocked = false;
  try { sql(`update "ExamResult" set "examScore"=50 where id=(select id from "ExamResult" limit 1)`); } catch { blocked = true; }
  ok(blocked, 'ExamResult нельзя изменить задним числом (триггер)');
  blocked = false;
  try { sql(`update "ExamAttemptQuestion" set "position"=99 where id=(select id from "ExamAttemptQuestion" limit 1)`); } catch { blocked = true; }
  ok(blocked, 'снапшот попытки неизменяем (триггер)');
  blocked = false;
  try { sql(`update "Question" set body='hacked' where "versionId" in (select id from "QuestionBankVersion" where status='APPROVED') and id=(select q.id from "Question" q join "QuestionBankVersion" v on v.id=q."versionId" where v.status='APPROVED' limit 1)`); } catch { blocked = true; }
  ok(blocked, 'утверждённый банк вопросов неизменяем (триггер)');

  console.log(`\nИтог: ${pass} прошло, ${fail} не прошло`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
