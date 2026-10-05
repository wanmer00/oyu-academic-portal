// E2E: единый GPA (/me/academic-summary == /me/transcript) и refresh-токен только в HttpOnly cookie.
// Запуск: node test/gpa-auth-e2e.js  (API на http://localhost:3001, демо-данные)
const BASE = process.env.API || 'http://localhost:3001/api/v1';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };

async function login(loginId) {
  const r = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loginId, password: 'Demo@Portal2026' }) });
  return { status: r.status, body: await r.json(), cookie: r.headers.get('set-cookie') || '' };
}
const get = async (path, token) => { const r = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + token } }); return { status: r.status, body: await r.json().catch(() => null) }; };

(async () => {
  // ── Auth: refresh-токен не попадает в JSON ──
  const L = await login('student1.demo');
  ok(L.status === 200 && L.body.accessToken, 'login ok');
  ok(!('refreshToken' in L.body) && !JSON.stringify(L.body).includes(L.cookie.split(';')[0].split('=')[1] || '§'), 'refresh token absent from login JSON');
  ok(/ap_refresh=/.test(L.cookie) && /HttpOnly/i.test(L.cookie) && /SameSite=Strict/i.test(L.cookie) && /Path=\/api\/v1\/auth/i.test(L.cookie), 'refresh cookie HttpOnly/SameSite/Path');
  ok(!('passwordHash' in L.body.user) && !('totpSecret' in L.body.user), 'no secrets in user');
  const ck = L.cookie.split(';')[0];
  const R = await fetch(BASE + '/auth/refresh', { method: 'POST', headers: { Cookie: ck } });
  const RB = await R.json();
  ok(R.status === 200 && RB.accessToken && !('refreshToken' in RB), 'refresh ok, no token in JSON');
  const R2 = await fetch(BASE + '/auth/refresh', { method: 'POST', headers: { Cookie: ck } });
  ok(R2.status === 401, 'old refresh token rejected after rotation');
  const lo = await fetch(BASE + '/auth/logout', { method: 'POST', headers: { Cookie: (R.headers.get('set-cookie') || '').split(';')[0] } });
  ok(lo.status === 204 && /ap_refresh=;/.test(lo.headers.get('set-cookie') || ''), 'logout clears cookie');

  // ── GPA: один источник для всех студентов с оценками ──
  for (const s of ['student1.demo', 'student2.demo', 'student3.demo', 'student4.demo']) {
    const { body } = await login(s);
    const t = body.accessToken;
    const [sum, tr] = [await get('/me/academic-summary', t), await get('/me/transcript', t)];
    ok(sum.status === 200, s + ' summary 200');
    const graded = tr.body.periods.filter((p) => p.subjects.length);
    ok(sum.body.cumulativeGpa === (graded.length ? tr.body.summary.cumulativeGPA : null), s + ' cumulative GPA == transcript');
    ok(sum.body.earnedCredits === tr.body.summary.earnedCredits && sum.body.totalCredits === tr.body.summary.totalCredits, s + ' credits == transcript');
    // пересчёт по строкам транскрипта: взвешено по кредитам, не сданные (<51) — 0 баллов и 0 кредитов
    const rows = graded.flatMap((p) => p.subjects);
    const cr = rows.reduce((a, x) => a + x.subject.credits, 0);
    const exp = cr ? Math.round((rows.reduce((a, x) => a + x.gradePoints * x.subject.credits, 0) / cr) * 100) / 100 : null;
    ok(sum.body.cumulativeGpa === exp, s + ' GPA credit-weighted recompute ' + sum.body.cumulativeGpa + ' vs ' + exp);
    ok(rows.every((x) => (x.finalValue >= 51) === (x.creditsEarned > 0)), s + ' credits earned iff total >= 51');
    ok(['NONE', 'EXCELLENT', 'GOOD', 'SATISFACTORY', 'AT_RISK'].includes(sum.body.academicStanding), s + ' standing enum');
  }
  // не-студент → 403/404, а не чужие данные
  const T = await login('teacher1.demo');
  const ts = await get('/me/academic-summary', T.body.accessToken);
  ok(ts.status === 403 || ts.status === 404, 'teacher cannot read student academic summary (' + ts.status + ')');
  const anon = await fetch(BASE + '/me/academic-summary');
  ok(anon.status === 401, 'anonymous → 401');

  console.log(`gpa-auth-e2e: ${pass}/${pass + fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
