// E2E: банк вопросов (преподаватель → проверка Management → версии), окна, закрытие окна. Запуск: node test/exam-e2e-bank.js
const { execSync } = require('child_process');
const B = process.env.API || 'http://localhost:3001/api/v1';
const PW = 'Demo@Portal2026';
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, e !== undefined ? JSON.stringify(e) : ''); } };
const sql = (q) => execSync(`docker exec ap-postgres psql -U ap -d ap -t -A -c "${q.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
async function call(method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(B + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* */ }
  return { status: r.status, body: j };
}
const login = async (u) => (await call('POST', '/auth/login', { body: { loginId: u, password: PW } })).body.accessToken;
const q = (body, correct = 'B', extra = {}) => ({ body, correct, options: ['A', 'B', 'C', 'D', 'E'].map((l, i) => ({ label: l, body: `${body} option ${i + 1}` })), ...extra });
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

(async () => {
  const rector = await login('rector.demo'), sa = await login('superadmin.demo');
  let teacher = null, row = null;
  for (let i = 1; i <= 4 && !row; i++) { const t = await login(`teacher${i}.demo`); const r = await call('GET', '/teacher/exams', { token: t }); const f = (r.body || []).find((x) => x.subject.code === 'IT301'); if (f) { teacher = t; row = f; } }
  console.log('\n[1] Преподаватель: My Exams');
  ok(row && row.approvedVersion && row.approvedVersion.version === 1 && row.exams.length >= 1, 'предмет IT301: утверждённая v1, экзамен в окне', row && row.status);
  ok(row.deadline && row.overdue === false && row.locked === false, 'дедлайн в будущем, статус не OVERDUE');
  const sid = row.subject.id;

  console.log('\n[2] Редактор: версия, валидация, дубликаты');
  const v2 = await call('POST', `/teacher/question-banks/${sid}/versions`, { token: teacher });
  ok(v2.status < 300 && v2.body.version === 2 && v2.body.status === 'DRAFT' && v2.body.questions.length === 30, 'новая версия v2 = копия утверждённой (30 вопросов), DRAFT', v2.body && v2.body.version);
  const vid = v2.body.id;
  ok(v2.body.questions.some((x) => x.correct), 'автор видит свои правильные ответы');
  const first = v2.body.questions[0];
  const dup = await call('POST', `/teacher/question-banks/versions/${vid}/questions`, { token: teacher, body: { body: first.body, correct: first.correct, options: first.options } });
  ok(dup.status === 409 && dup.body.code === 'DUPLICATE_QUESTION', 'дубликат вопроса отклонён', dup.body);
  const sameOpts = q('Dup options?'); sameOpts.options[1].body = sameOpts.options[0].body;
  ok((await call('POST', `/teacher/question-banks/versions/${vid}/questions`, { token: teacher, body: sameOpts })).status === 400, 'одинаковые варианты отклонены');
  const twoCorrect = { ...q('Two correct?'), correct: 'AB' };
  ok((await call('POST', `/teacher/question-banks/versions/${vid}/questions`, { token: teacher, body: twoCorrect })).status === 400, 'один правильный ответ: "AB" отклонён');
  const add = await call('POST', `/teacher/question-banks/versions/${vid}/questions`, { token: teacher, body: q('What is x^{2} for x = 3? **Bold** and `code` allowed') });
  ok(add.status < 300, 'вопрос с форматированием добавлен', add.body);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  ok((await call('POST', `/teacher/question-banks/versions/${vid}/questions`, { token: teacher, body: q('Question with image', 'C', { image: png }) })).status < 300, 'вопрос с изображением добавлен');
  ok((await call('POST', `/teacher/question-banks/versions/${vid}/questions`, { token: teacher, body: q('Bad image', 'C', { image: 'data:text/html;base64,PHNjcmlwdD4=' }) })).status === 400, 'не-изображение отклонено');
  ok((await call('PUT', `/teacher/question-banks/versions/${vid}/questions/${add.body.id}`, { token: teacher, body: q('What is x^{2} for x = 4?', 'D') })).status < 300, 'вопрос отредактирован');

  console.log('\n[3] Импорт CSV');
  const csv = 'question,A,B,C,D,E,correct\n"Csv 1",1,2,3,4,5,B\n"Csv 2",1,2,3,4,5,Z\n"Csv 3",1,1,3,4,5,A\n"Csv 1",1,2,3,4,5,B\n"Csv 4",1,2,3,4,,C\n';
  const dry = await call('POST', `/teacher/question-banks/versions/${vid}/import`, { token: teacher, body: { fileName: 'q.csv', contentBase64: b64(csv), dryRun: true } });
  ok(dry.body.errors.length === 4 && dry.body.valid === 1 && dry.body.imported === 0, 'dry-run: ошибки по строкам (буква, одинаковые варианты, дубль, пустой вариант)', dry.body);
  const good = 'question;A;B;C;D;E;correct\n"Import ' + 1 + '";1;2;3;4;5;B\n"Import 2";1;2;3;4;5;C\n';
  const imp = await call('POST', `/teacher/question-banks/versions/${vid}/import`, { token: teacher, body: { fileName: 'q.csv', contentBase64: b64(good) } });
  ok(imp.body.imported === 2, 'корректный CSV (разделитель ;) импортирован', imp.body);
  ok((await call('POST', `/teacher/question-banks/versions/${vid}/import`, { token: teacher, body: { fileName: 'q.txt', contentBase64: b64('x') } })).status === 400, 'формат .txt не поддерживается');

  console.log('\n[4] Отправка на проверку и ревью');
  const sub = await call('POST', `/teacher/question-banks/versions/${vid}/submit`, { token: teacher });
  ok(sub.status < 300 && sub.body.status === 'SUBMITTED', 'v2 отправлена на проверку', sub.body);
  const ed = await call('POST', `/teacher/question-banks/versions/${vid}/questions`, { token: teacher, body: q('After submit') });
  ok(ed.status === 409 && ed.body.code === 'VERSION_LOCKED', 'после отправки вопросы менять нельзя');
  ok((await call('GET', '/admin/question-reviews', { token: teacher })).status === 403, 'преподаватель не видит очередь проверки (403)');
  ok((await call('POST', `/admin/question-reviews/${vid}/approve`, { token: teacher })).status === 403, 'преподаватель не может утвердить (403)');
  const queue = await call('GET', '/admin/question-reviews?status=SUBMITTED', { token: rector });
  ok(queue.body.some((x) => x.id === vid), 'версия в очереди Management');
  ok((await call('POST', `/admin/question-reviews/${vid}/approve`, { token: rector })).status === 409, 'утвердить без начала проверки нельзя');
  const claim = await call('POST', `/admin/question-reviews/${vid}/claim`, { token: rector });
  ok(claim.body.status === 'UNDER_REVIEW', 'проверка начата (UNDER_REVIEW)');
  ok((await call('POST', `/admin/question-reviews/${vid}/reject`, { token: rector, body: { reason: '' } })).status === 400, 'reject без причины невозможен');
  const rej = await call('POST', `/admin/question-reviews/${vid}/reject`, { token: rector, body: { reason: 'Question 7 has two potentially correct answers.' } });
  ok(rej.body.status === 'REJECTED', 'версия отклонена с причиной');
  const mine = (await call('GET', '/teacher/exams', { token: teacher })).body.find((x) => x.subject.code === 'IT301');
  ok(mine.versions.find((v) => v.version === 2).rejectionReason.includes('two potentially'), 'преподаватель видит причину отклонения');
  ok(mine.approvedVersion.version === 1, 'утверждённая v1 остаётся активной');

  const v3 = await call('POST', `/teacher/question-banks/${sid}/versions`, { token: teacher });
  ok(v3.body.version === 3 && v3.body.questions.length === 34, 'ревизия: v3 = копия отклонённой v2 (34 вопроса)', v3.body && v3.body.questions && v3.body.questions.length);
  ok((await call('POST', `/teacher/question-banks/versions/${v3.body.id}/submit`, { token: teacher })).body.status === 'SUBMITTED', 'v3 отправлена повторно');
  await call('POST', `/admin/question-reviews/${v3.body.id}/claim`, { token: sa });
  const ap = await call('POST', `/admin/question-reviews/${v3.body.id}/approve`, { token: sa });
  ok(ap.body.status === 'APPROVED', 'v3 утверждена');
  ok(sql(`select string_agg(version::text||':'||status, ',' order by version) from "QuestionBankVersion" where "bankId"=(select id from "QuestionBank" where "subjectId"='${sid}')`) === '1:SUPERSEDED,2:REJECTED,3:APPROVED', 'версии: v1 вытеснена, v2 отклонена, v3 активна');
  const pinned = sql(`select v.version from "Exam" e join "QuestionBankVersion" v on v.id=e."bankVersionId" where e."subjectId"='${sid}' and e."bankVersionId" is not null limit 1`);
  ok(pinned === '' || pinned === '1', 'экзамен, уже использовавший банк, остаётся на своей версии (v1)', pinned);

  console.log('\n[5] Дедлайн загрузки');
  const winId = (await call('GET', '/admin/exam-windows?kind=FINAL&status=PUBLISHED', { token: rector })).body[0].id;
  await call('PUT', `/admin/exam-windows/${winId}`, { token: sa, body: { questionDeadline: new Date(Date.now() - 86400000).toISOString() } });
  const late = await call('POST', `/teacher/question-banks/${sid}/versions`, { token: teacher });
  ok(late.status === 403 && late.body.code === 'DEADLINE_PASSED', 'после дедлайна преподаватель не может создавать версии', late.body);
  const win = await call('GET', `/admin/exam-windows/${winId}`, { token: rector });
  ok(win.body.exams.some((e) => e.overdue === false) && win.body.exams.every((e) => e.bank.status), 'Management видит статус банков по экзаменам окна');
  await call('PUT', `/admin/exam-windows/${winId}`, { token: sa, body: { questionDeadline: new Date(Date.now() + 3 * 86400000).toISOString() } });

  console.log('\n[6] Окна: создание, resit через неделю, закрытие');
  const created = await call('POST', '/admin/exam-windows', { token: sa, body: { title: 'E2E final window', kind: 'FINAL', academicYear: '2026-2027', term: 'FALL', startDate: '2027-06-01', endDate: '2027-06-30', allowedWeekdays: [1, 3, 5], startTime: '10:00', endTime: '12:00', maxPerWeek: 3, scopes: [{ groupName: 'KM-21' }] } });
  ok(created.status < 300 && created.body.status === 'DRAFT', 'окно создано (черновик)', created.body);
  ok((await call('POST', `/admin/exam-windows/${created.body.id}/publish`, { token: sa })).status === 400, 'пустое окно опубликовать нельзя');
  ok((await call('POST', '/admin/exam-windows', { token: sa, body: { ...created.body, title: 'bad', startTime: '12:00', endTime: '10:00', scopes: [] } })).status === 400, 'время начала позже окончания отклонено');
  const resit = await call('POST', `/admin/exam-windows/${created.body.id}/resit-window`, { token: sa, body: {} });
  ok(resit.body.startDate === '2027-07-07' && resit.body.allowedWeekdays.join() === '1,2,3,4,5' && resit.body.startTime === '10:00', 'resit-окно: старт ровно через неделю после финального (07.07), пн–пт, то же время', resit.body);
  ok(resit.body.term === 'FALL', 'зимний цикл: resit тоже зимний');
  ok((await call('POST', `/admin/exam-windows/${created.body.id}/resit-window`, { token: sa, body: {} })).status === 409, 'второе resit-окно для того же финального невозможно');
  const sub1 = (await call('GET', '/teacher/exams', { token: teacher })).body[0].subject.id;
  const ex = await call('POST', `/admin/exam-windows/${created.body.id}/exams`, { token: sa, body: { subjectId: sub1, delivery: 'COMPUTER' } });
  ok(ex.status < 300, 'предмет добавлен в окно');
  ok((await call('POST', `/admin/exam-windows/${created.body.id}/exams`, { token: sa, body: { subjectId: sub1 } })).status === 409, 'дубль предмета в окне отклонён');
  ok((await call('POST', `/admin/exam-windows/${created.body.id}/cancel`, { token: sa })).body.status === 'CANCELLED', 'окно без попыток можно отменить');
  ok((await call('DELETE', `/admin/exams/${ex.body.id}`, { token: sa })).status < 300, 'экзамен без попыток можно удалить');

  console.log(`\nИтог: ${pass} прошло, ${fail} не прошло`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
