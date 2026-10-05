// E2E: область руководства (декан факультета) применяется к каждому обращению по id, а не только к спискам.
// Запуск: node test/org-scope-e2e.js (API http://localhost:3001, демо-данные; меняет данные — после прогона reset демо)
const { execSync } = require('child_process');
const path = require('path');
const BASE = process.env.API || 'http://localhost:3001/api/v1';
const sql = (q) => execSync('docker compose exec -T postgres psql -U ap -d ap -At -c ' + JSON.stringify(q), { cwd: path.resolve(__dirname, '../..') }).toString().trim();
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const login = async (u) => (await (await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loginId: u, password: 'Demo@Portal2026' }) })).json()).accessToken;
const call = async (t, m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: { Authorization: 'Bearer ' + t, ...(b ? { 'Content-Type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, b: await r.json().catch(() => null) }; };

(async () => {
  const dean = await login('dean.demo');
  const me = (await call(dean, 'GET', '/me')).b;
  ok(me.orgScope.kind === 'FACULTY', 'dean has faculty scope');
  const fac = sql(`select "facultyId" from "User" where "loginId"='dean.demo'`);
  const inGroups = sql(`select g.name from "AcademicGroup" g join "Specialty" s on s.id=g."specialtyId" join "Department" d on d.id=s."departmentId" where d."facultyId"='${fac}'`).split('\n');
  const own = sql(`select "userId" from "Student" where "groupName" in (${inGroups.map((g) => `'${g}'`).join(',')}) limit 1`);
  const foreign = sql(`select "userId"||'|'||"groupName" from "Student" where "groupName" not in (${inGroups.map((g) => `'${g}'`).join(',')}) limit 1`).split('|');
  const fId = foreign[0], fGroup = foreign[1];

  // свой студент — доступен
  ok((await call(dean, 'GET', '/admin/students/' + own)).s === 200, 'own-faculty student readable');
  // чужой факультет — 403 на чтение и все изменения
  ok((await call(dean, 'GET', '/admin/students/' + fId)).s === 403, 'foreign student GET 403');
  ok((await call(dean, 'PATCH', '/admin/students/' + fId, { phone: '+994000000' })).s === 403, 'foreign student PATCH 403');
  ok((await call(dean, 'POST', '/admin/students/' + fId + '/archive', {})).s === 403, 'foreign student archive 403');
  ok((await call(dean, 'POST', '/admin/students/' + fId + '/unarchive')).s === 403, 'foreign student unarchive 403');
  ok((await call(dean, 'PATCH', '/admin/students/' + own, { groupName: fGroup })).s === 403, 'transfer own student into foreign group 403');
  ok((await call(dean, 'PATCH', '/admin/groups/' + encodeURIComponent(fGroup), { newName: 'HACK-1' })).s === 403, 'rename foreign group 403');
  ok((await call(dean, 'POST', '/admin/teachers/x/assign', { subjectCode: 'IT101', groupName: fGroup })).s === 403, 'assign teacher to foreign group 403');
  ok((await call(dean, 'GET', '/admin/students/nonexistent-id')).s === 404, 'unknown student 404');

  // преподаватель вне области
  const tForeign = sql(`select "teacherId" from "ScheduleSlot" group by "teacherId" having bool_and("groupName" not in (${inGroups.map((g) => `'${g}'`).join(',')})) limit 1`);
  if (tForeign) ok((await call(dean, 'GET', '/admin/teachers/' + tForeign)).s === 403, 'foreign teacher GET 403');

  // заявки: чужой факультет — 403, свой — 200
  const fReq = sql(`select r.id from "Request" r join "Student" s on s."userId"=r."userId" where r.status='PENDING' and r.type in ('CERTIFICATE','TRANSFER','OTHER') and s."groupName" not in (${inGroups.map((g) => `'${g}'`).join(',')}) limit 1`);
  const oReq = sql(`select r.id from "Request" r join "Student" s on s."userId"=r."userId" where r.status='PENDING' and r.type in ('CERTIFICATE','TRANSFER','OTHER') and s."groupName" in (${inGroups.map((g) => `'${g}'`).join(',')}) limit 1`);
  if (fReq) ok((await call(dean, 'PATCH', '/admin/requests/' + fReq, { status: 'APPROVED' })).s === 403, 'foreign request decision 403');
  if (oReq) ok((await call(dean, 'PATCH', '/admin/requests/' + oReq, { status: 'APPROVED' })).s === 200, 'own-faculty request decision 200');

  // тот же студент через управление пользователями — тоже 403; список пользователей ограничен областью
  ok((await call(dean, 'GET', '/admin/users/' + fId)).s === 403, 'foreign user GET 403');
  ok((await call(dean, 'PATCH', '/admin/users/' + fId, { phone: '+994111' })).s === 403, 'foreign user PATCH 403');
  ok((await call(dean, 'POST', '/admin/users/' + fId + '/block', { reason: 'qa probe block' })).s === 403, 'foreign user block 403');
  ok((await call(dean, 'POST', '/admin/users/' + fId + '/reset-password', {})).s === 403, 'foreign user reset-password 403');
  ok((await call(dean, 'GET', '/admin/users/' + own)).s === 200, 'own-faculty user GET 200');
  const ul = (await call(dean, 'GET', '/admin/users?take=200')).b;
  const allUsers = Number(sql(`select count(*) from "User" where status<>'DELETED'`));
  ok(ul.total < allUsers && ul.items.every((x) => x.role === 'STUDENT' || x.role === 'TEACHER'), 'users list scoped (' + ul.total + ' of ' + allUsers + ')');

  // ректор (без ограничений) по-прежнему видит всех
  const rector = await login('rector.demo');
  ok((await call(rector, 'GET', '/admin/students/' + fId)).s === 200, 'rector reads any student');

  console.log(`org-scope-e2e: ${pass}/${pass + fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
