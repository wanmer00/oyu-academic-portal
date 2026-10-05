// E2E: апелляция по экзамену как часть Requests (type = APPEAL). Запуск на свежих демо-данных:
//   node test/appeal-e2e.js        (нужны RATE_LIMIT_AUTH_MAX=1000 RATE_LIMIT_MAX=100000)
const { execSync } = require('child_process');
const B = process.env.API || 'http://localhost:3001/api/v1';
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, e !== undefined ? JSON.stringify(e).slice(0, 400) : ''); } };
const sql = (q) => execSync(`docker exec ap-postgres psql -U ap -d ap -t -A -c "${q.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
async function call(method, path, token, body) {
  const r = await fetch(B + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* */ }
  return { status: r.status, body: j };
}
const login = async (u) => (await call('POST', '/auth/login', null, { loginId: u, password: 'Demo@Portal2026' })).body.accessToken;
const code = (r) => r.body && (r.body.code || r.body.message);

(async () => {
  const T = {};
  for (const u of ['student2.demo', 'student3.demo', 'student4.demo', 'student6.demo', 'dean.demo', 'dean2.demo', 'tutor.demo', 'superadmin.demo']) T[u] = await login(u);
  const s3 = sql("select id from \"User\" where \"loginId\"='student3.demo'");
  const res3 = (await call('GET', '/me/exams', T['student3.demo'])).body.results.find((r) => r.source === 'COMPUTER');
  const res2 = (await call('GET', '/me/exams', T['student2.demo'])).body.results.find((r) => r.source === 'COMPUTER');

  console.log('\n[1] Exam Review');
  const rv = await call('GET', `/me/exam-results/${res3.id}/review`, T['student3.demo']);
  ok(rv.status === 200 && rv.body.questions.length === 25, '1. студент видит свой Exam Review (25 вопросов)', rv.status);
  ok(rv.body.questions.every((q) => ['CORRECT', 'WRONG', 'SKIP'].includes(q.state) && q.maxPoints === 2), 'по каждому вопросу: статус, баллы, максимум');
  ok(rv.body.questions.some((q) => q.state !== 'CORRECT') && rv.body.questions.filter((q) => q.state === 'CORRECT').length === rv.body.questions.filter((q) => q.points === 2).length, 'видны ошибки / пропущенные задания (из реальных данных попытки)');
  ok(!JSON.stringify(rv.body).match(/isCorrect|correctAnswer|correctId/), 'правильные ответы студенту не отдаются (политика)');
  ok(rv.body.appeal.canAppeal && rv.body.appeal.deadline, 'окно апелляции открыто, дедлайн известен');
  ok((await call('GET', `/me/exam-results/${res2.id}/review`, T['student3.demo'])).status === 404, '2. чужой экзамен недоступен (404)');

  console.log('\n[2] Подача апелляции через Requests');
  const skip = rv.body.questions.filter((q) => q.state === 'SKIP');
  const wrong = [rv.body.questions.find((q) => q.state === 'WRONG') || skip[1]]; // первый спорный: неверный ответ (или второй пропуск)
  const body = (items) => ({ type: 'APPEAL', appeal: { resultId: res3.id, items } });
  ok((await call('POST', '/me/requests', T['student3.demo'], body([{ position: wrong[0].position, reason: 'MADE_UP', explanation: 'Long enough explanation' }]))).status === 400, '4. неверная причина отклонена');
  ok((await call('POST', '/me/requests', T['student3.demo'], body([{ position: wrong[0].position, reason: 'SCORING_ERROR', explanation: 'short' }]))).status === 400, '5. объяснение короче 10 символов отклонено');
  ok((await call('POST', '/me/requests', T['student3.demo'], body([{ position: wrong[0].position, reason: 'OTHER' }]))).status === 400, '5. OTHER без объяснения отклонено');
  ok((await call('POST', '/me/requests', T['student3.demo'], body([{ position: 99, reason: 'SCORING_ERROR', explanation: 'Explanation text here' }]))).status === 400, 'несуществующий вопрос отклонён');
  ok((await call('POST', '/me/requests', T['student3.demo'], { type: 'CERTIFICATE', appeal: { resultId: res3.id, items: [] } })).status === 400, 'appeal-данные только для type=APPEAL');
  const items = [{ position: wrong[0].position, reason: 'SCORING_ERROR', explanation: 'My answer was correct according to the formula used in class.' }, { position: skip[0].position, reason: 'ANSWER_NOT_RECORDED', explanation: 'I selected an answer but it was not saved by the system.' }];
  const cr = await call('POST', '/me/requests', T['student3.demo'], body(items));
  ok(cr.status === 201 && cr.body.type === 'APPEAL' && cr.body.appeal.code, '3. одна заявка APPEAL с несколькими спорными вопросами создана', cr.body);
  const reqId = cr.body.id;
  ok((await call('POST', '/me/requests', T['student3.demo'], body(items))).status === 409, '7. повторная активная апелляция по тому же экзамену запрещена (409)');
  const mine = await call('GET', `/me/requests/${reqId}`, T['student3.demo']);
  ok(mine.body.appeal.items.length === 2 && mine.body.appeal.items[0].questionText && mine.body.appeal.items[0].awardedPoints === wrong[0].points, 'снимок: номер, текст вопроса, начисленные баллы');
  ok(!JSON.stringify(mine.body).includes('correctAnswer'), 'студент не видит правильный ответ и в заявке');
  ok((await call('GET', `/me/requests/${reqId}`, T['student2.demo'])).status === 404, 'чужая заявка недоступна');
  ok((await call('GET', '/me/requests', T['student3.demo'])).body.find((r) => r.id === reqId).appeal.disputed === 2, 'апелляция видна в «Мои заявки» с числом спорных вопросов');

  console.log('\n[3] Срок апелляции');
  const res6 = (await call('GET', '/me/exams', T['student6.demo'])).body.results.find((r) => r.source === 'COMPUTER');
  await call('PATCH', '/admin/settings/exam.appealWindowHours', T['superadmin.demo'], { value: 1 });
  const late = await call('POST', '/me/requests', T['student6.demo'], { type: 'APPEAL', appeal: { resultId: res6.id, items: [{ position: 1, reason: 'SCORING_ERROR', explanation: 'Explanation for a late appeal.' }] } });
  ok(late.status === 409 && code(late) === 'APPEAL_CLOSED', '6. после дедлайна подать нельзя (backend)', late.body);
  ok((await call('GET', `/me/requests/${reqId}`, T['student3.demo'])).status === 200, 'уже поданные апелляции продолжают работать после дедлайна');
  await call('PATCH', '/admin/settings/exam.appealWindowHours', T['superadmin.demo'], { value: 72 });

  console.log('\n[4] Права преподавателя и руководства');
  let teacher = null;
  for (let i = 1; i <= 20 && !teacher; i++) { const t = await login(`teacher${i}.demo`); const l = await call('GET', '/teacher/requests/appeals', t); if (l.body && l.body.some((a) => a.requestId === reqId)) teacher = t; else if (!T.other && l.status === 200) T.other = t; }
  ok(!!teacher, 'преподаватель предмета видит апелляцию');
  ok((await call('GET', `/teacher/requests/appeals/${reqId}`, T.other)).status === 404, '8. преподаватель другого предмета не видит апелляцию');
  const det = await call('GET', `/teacher/requests/appeals/${reqId}`, teacher);
  ok(det.body.items[0].correctAnswer && det.body.items[0].explanation, 'проверяющий видит вопрос, ответ студента, правильный ответ, причину и объяснение');
  ok((await call('GET', '/teacher/requests/appeals', T['student3.demo'])).status === 403, 'студент не имеет доступа к очереди рассмотрения');
  ok((await call('GET', `/admin/requests/appeals/${reqId}`, T['dean.demo'])).status === 200, '9. декан факультета видит апелляцию своей области');
  ok((await call('GET', `/admin/requests/appeals/${reqId}`, T['dean2.demo'])).status === 404, 'декан другого факультета — нет');
  const deanDecide = await call('PUT', `/admin/requests/appeals/${reqId}/items/${det.body.items[0].id}`, T['dean.demo'], { newPoints: 2, comment: 'test' });
  ok(deanDecide.status === 403 && code(deanDecide) === 'APPEAL_NOT_ESCALATED', 'руководство не меняет баллы по неэскалированной апелляции', deanDecide.body);

  console.log('\n[5] Рассмотрение и решение');
  const st = await call('POST', `/teacher/requests/appeals/${reqId}/start`, teacher);
  ok(st.body.status === 'UNDER_REVIEW', 'апелляция взята на рассмотрение (UNDER_REVIEW)');
  ok((await call('POST', `/me/requests/${reqId}/withdraw`, T['student3.demo'])).status === 409, '20. после начала рассмотрения отзыв невозможен');
  const [iw, is] = det.body.items;
  ok((await call('PUT', `/teacher/requests/appeals/${reqId}/items/${iw.id}`, teacher, { newPoints: 3, comment: 'too much' })).status === 400, '12. балл выше максимума вопроса отклонён');
  ok((await call('PUT', `/teacher/requests/appeals/${reqId}/items/${is.id}`, teacher, { newPoints: -1, comment: 'not answered' })).status === 400, 'без ответа балл ниже 0 нельзя');
  ok((await call('POST', `/teacher/requests/appeals/${reqId}/decide`, teacher, {})).status === 409, 'решение без оценки всех вопросов запрещено');
  await call('PUT', `/teacher/requests/appeals/${reqId}/items/${iw.id}`, teacher, { newPoints: 2, comment: 'Answer is correct, key error.' });
  await call('PUT', `/teacher/requests/appeals/${reqId}/items/${is.id}`, teacher, { newPoints: 0, comment: 'No answer was recorded in the log.' });
  const sid3 = sql(`select "subjectId" from "ExamAppeal" where "requestId"='${reqId}'`);
  const before = sql(`select string_agg(type||':'||value::text, ',' order by type, "createdAt") from "Grade" where "studentId"='${s3}' and "subjectId"='${sid3}' and "academicYear"='2026-2027' and type in ('MIDTERM','SEMINAR')`);
  const jBefore = await call('GET', `/journal/me/subjects/${sid3}`, T['student3.demo']);
  const dec = await call('POST', `/teacher/requests/appeals/${reqId}/decide`, teacher, { note: 'Q' + iw.position + ' corrected' });
  ok(dec.status === 201 && dec.body.status === 'PARTIALLY_APPROVED' && dec.body.outcome === 'PARTIALLY_APPROVED', '13. общий результат вычислен: PARTIALLY_APPROVED', dec.body && dec.body.status);
  const orig = dec.body.originalExamScore, revised = dec.body.revisedExamScore;
  ok(revised === orig + (2 - iw.awardedPoints), `13. Exam Score пересчитан: ${orig} → ${revised} (Q${iw.position}: ${iw.awardedPoints} → +2)`);
  ok(revised <= 50, '11. Final остаётся ≤ 50');
  const fin = Number(sql(`select value from "Grade" where "studentId"='${s3}' and "subjectId"='${sid3}' and type='FINAL' and "academicYear"='2026-2027'`));
  ok(fin === revised, 'FINAL в Academic Journal = пересмотренный балл', fin);
  ok(Number(sql(`select count(*) from "GradeHistory" h join "Grade" g on g.id=h."gradeId" where g."studentId"='${s3}' and h.reason like 'Appeal A-%'`)) === 1, '14. GradeHistory создан (old → new, причина со ссылкой на апелляцию)');
  const acts = sql(`select string_agg(distinct action, ',') from "AuditLog" where "targetId" in ('${reqId}', '${res3.id}', '${iw.id}', '${is.id}')`);
  ok(['appeal.submit', 'appeal.review', 'appeal.item.decision', 'grade.adjust', 'appeal.decide', 'appeal.close'].every((a) => acts.includes(a)), '15. AuditLog: submit / review / item.decision / grade.adjust / decide / close', acts);
  ok(Number(sql(`select count(*) from "Notification" where "userId"='${s3}' and link='requests'`)) >= 3 && Number(sql(`select count(*) from "Notification" where "userId"='${s3}' and type='ACADEMIC' and link='exams' and "createdAt" > now() - interval '5 minutes'`)) >= 1, '16. уведомления: отправлена, на рассмотрении, решение, изменение балла');
  ok(sql(`select string_agg(type||':'||value::text, ',' order by type, "createdAt") from "Grade" where "studentId"='${s3}' and "subjectId"='${sid3}' and "academicYear"='2026-2027' and type in ('MIDTERM','SEMINAR')`) === before, '17-18. Seminar и Midterm не изменились');
  const jAfter = await call('GET', `/journal/me/subjects/${sid3}`, T['student3.demo']);
  const tot = (j) => j.body && (j.body.summary ? j.body.summary.total.score : j.body.total ? j.body.total.score : null);
  ok(tot(jAfter) != null && Math.abs(tot(jAfter) - tot(jBefore) - (Math.max(0, revised) - Math.max(0, orig))) < 0.01 && tot(jAfter) <= 100, '19. итог предмета пересчитан существующим расчётом журнала (≤ 100)', { before: tot(jBefore), after: tot(jAfter) });
  const view = (await call('GET', '/me/exams', T['student3.demo'])).body.results.find((r) => r.id === res3.id);
  ok(view.examScore === revised && view.original && view.original.examScore === orig, 'студент видит обновлённый балл и исходный');
  ok((await call('POST', `/teacher/requests/appeals/${reqId}/decide`, teacher, {})).status === 409, 'повторное решение невозможно');
  ok((await call('POST', '/me/requests', T['student3.demo'], body(items))).status === 409, 'после решения повторная апелляция не допускается (явное правило)');

  console.log('\n[6] Эскалация и руководство');
  const a4 = (await call('GET', '/me/requests', T['student4.demo'])).body.find((r) => r.appeal);
  let t4 = null;
  for (let i = 1; i <= 20 && !t4; i++) { const t = await login(`teacher${i}.demo`); if ((await call('GET', `/teacher/requests/appeals/${a4.id}`, t)).status === 200) t4 = t; }
  ok((await call('POST', `/teacher/requests/appeals/${a4.id}/escalate`, t4, { reason: 'Need department decision on wording.' })).status === 201, 'преподаватель передал апелляцию руководству');
  const d4 = await call('GET', `/admin/requests/appeals/${a4.id}`, T['dean.demo']);
  ok(d4.body.escalated && d4.body.permissions.canDecide, 'эскалированная апелляция — в очереди декана, он может решать');
  ok((await call('GET', '/admin/requests/appeals?escalated=true', T['dean.demo'])).body.some((a) => a.requestId === a4.id), 'очередь «Переданные руководству»');
  ok((await call('PUT', `/teacher/requests/appeals/${a4.id}/items/${d4.body.items[0].id}`, t4, { newPoints: 2, comment: 'teacher try' })).status === 403, 'после эскалации преподаватель не решает');
  const tutorTry = await call('PUT', `/admin/requests/appeals/${a4.id}/items/${d4.body.items[0].id}`, T['tutor.demo'], { newPoints: 2, comment: 'tutor try' });
  ok(tutorTry.status === 403 || tutorTry.status === 404, '10. роль без права решения (тьютор) не может изменить апелляцию', tutorTry.status);
  for (const it of d4.body.items) await call('PUT', `/admin/requests/appeals/${a4.id}/items/${it.id}`, T['dean.demo'], { newPoints: it.awardedPoints, comment: 'Wording is clear; decision unchanged.' });
  const d4f = await call('POST', `/admin/requests/appeals/${a4.id}/decide`, T['dean.demo'], { note: 'Unchanged' });
  ok(d4f.body.status === 'REJECTED' && d4f.body.revisedExamScore == null, 'декан отклонил: балл не изменился, статус REJECTED');
  const an = await call('GET', '/admin/requests/appeals/analytics', T['superadmin.demo']);
  ok(an.body.totals.submitted >= 3 && an.body.topReasons.length > 0 && an.body.averageReviewHours != null, 'аналитика на реальных данных', an.body.totals);

  console.log('\n[7] Отзыв и обычные заявки');
  const a2 = (await call('GET', '/me/requests', T['student2.demo'])).body.find((r) => r.appeal);
  ok((await call('DELETE', `/me/requests/${a2.id}`, T['student2.demo'])).status === 400, 'апелляцию нельзя удалить физически');
  ok((await call('PATCH', `/me/requests/${a2.id}`, T['student2.demo'], { description: 'changed text' })).status === 400, 'общий PATCH не меняет апелляцию по экзамену');
  const w = await call('POST', `/me/requests/${a2.id}/withdraw`, T['student2.demo']);
  ok(w.body && w.body.status === 'WITHDRAWN', '20. PENDING → WITHDRAWN', w.body);
  ok(sql(`select count(*) from "ExamAppeal" where "requestId"='${a2.id}'`) === '1', 'история отозванной апелляции сохранена');
  const cert = await call('POST', '/me/requests', T['student2.demo'], { type: 'CERTIFICATE', description: 'Need a study certificate' });
  ok(cert.status === 201, '24. CERTIFICATE создаётся как раньше');
  ok((await call('PATCH', `/me/requests/${cert.body.id}`, T['student2.demo'], { description: 'Updated certificate text' })).status === 200, 'CERTIFICATE редактируется как раньше');
  ok((await call('DELETE', `/me/requests/${cert.body.id}`, T['student2.demo'])).status === 200, 'PENDING CERTIFICATE удаляется как раньше');
  const legacy = await call('POST', '/me/requests', T['student2.demo'], { type: 'APPEAL', description: 'Plain text appeal without exam' });
  ok(legacy.status === 201, 'простая текстовая APPEAL (без экзамена) работает как раньше');

  console.log(`\nИтог: ${pass} прошло, ${fail} не прошло`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
