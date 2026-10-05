// ============================================================
// Экзаменационный киоск (exam.html). Работает только на зарегистрированном ПК: запросы подписаны ключом рабочего места
// (X-Workstation-Key). Студент не может запустить экзамен сам — старт возможен после авторизации проктора.
// Таймер, выбор вопросов, порядок вариантов и оценивание — на сервере; здесь только показ и автосохранение.
// ============================================================
(function () {
  'use strict';
  const t = (k, fb) => AP.i18n.t(k, fb), x = AP.ex, esc = x.esc, root = document.getElementById('k-root');
  const KEY = 'ap_ws_key';
  const API = ((window.AP_API_BASE || '').replace(/\/$/, '') || (location.hostname === 'localhost' ? 'http://localhost:3001' : '')) + '/api/v1';
  // DEMO: /exam.html?demo=<key> — ключ живёт только в этой вкладке (sessionStorage) и экзамен стартует автоматически
  try { const dk = new URLSearchParams(location.search).get('demo'); if (dk) { sessionStorage.setItem(KEY, dk); sessionStorage.setItem('ap_demo_auto', '1'); history.replaceState(null, '', location.pathname); } } catch { /* */ }
  const AUTO = () => { try { return sessionStorage.getItem('ap_demo_auto') === '1'; } catch { return false; } };
  const getKey = () => { try { return sessionStorage.getItem(KEY) || localStorage.getItem(KEY) || ''; } catch { return ''; } };

  async function call(method, path, body) {
    const res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', 'X-Workstation-Key': getKey(), 'X-Lang': AP.i18n.getLang() }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null; try { data = await res.json(); } catch { /* */ }
    if (!res.ok) { const e = new Error((data && data.message) || 'HTTP ' + res.status); e.status = res.status; e.body = data; throw e; }
    return data;
  }

  let S = { view: 'boot', wsCode: '', waiting: null, att: null, cur: 0, offset: 0, answers: new Map(), seq: 0, queue: [], flushing: false, offline: false, visited: new Set(), result: null, tick: null, poll: null };

  async function boot() {
    await AP.i18n.load(AP.i18n.getLang());
    document.addEventListener('ap:lang-changed', () => { AP.i18n.applyToDom(); draw(); });
    document.addEventListener('keydown', onKey);
    if (!getKey()) return setup();
    S.poll = setInterval(poll, 3000);
    poll();
  }

  function langBar() { return '<div class="lang-switcher" style="position:fixed;top:12px;right:14px;z-index:50">' + ['az', 'ru', 'en'].map((l) => '<button class="lang-btn' + (AP.i18n.getLang() === l ? ' active' : '') + '" data-l="' + l + '">' + l.toUpperCase() + '</button>').join('') + '</div>'; }
  function bindLang() { root.querySelectorAll('[data-l]').forEach((b) => b.addEventListener('click', () => AP.i18n.load(b.dataset.l))); }

  async function setup() {
    // DEMO: сервер отдаёт список демо-ПК с демо-ключами — выбираем компьютер одним кликом (в боевом режиме endpoint возвращает 404)
    let demo = [];
    try { const r = await fetch(API + '/exam-runtime-demo/workstations'); if (r.ok) demo = await r.json(); } catch { /* */ }
    const demoBox = demo.length ? '<div class="ex-note info" style="text-align:left"><b>' + esc(t('ex.k.demo_title')) + '</b><div class="ex-muted">' + esc(t('ex.k.demo_text')) + '</div><select class="input" id="k-demo" style="margin:8px 0">' + demo.map((d) => '<option value="' + esc(d.key) + '">' + esc(d.room + ' · ' + d.code) + '</option>').join('') + '</select><button class="btn btn-primary" id="k-demo-go" style="width:100%">' + esc(t('ex.k.demo_go')) + '</button></div>' : '';
    root.innerHTML = langBar() + '<div class="k-center"><div class="k-box card"><div class="card-pad"><img src="/img/logo.png" alt="" style="width:64px"><h1 class="k-h" style="font-size:22px">' + esc(t('ex.k.setup_title')) + '</h1><p class="ex-muted">' + esc(t('ex.k.setup_text')) + '</p>' + demoBox + '<input class="input" id="k-key" placeholder="wk_…" autocomplete="off" style="user-select:text;margin-top:10px"><div id="k-err" style="color:#dc2626;margin:8px 0;min-height:20px"></div><button class="btn btn-primary" id="k-save">' + esc(t('common.save')) + '</button></div></div></div>';
    bindLang();
    const dg = document.getElementById('k-demo-go');
    if (dg) dg.onclick = () => { try { localStorage.setItem(KEY, document.getElementById('k-demo').value); } catch { /* */ } location.reload(); };
    document.getElementById('k-save').onclick = async () => {
      const k = document.getElementById('k-key').value.trim();
      try { localStorage.setItem(KEY, k); await call('GET', '/exam-runtime/state'); location.reload(); } catch (e) { try { localStorage.removeItem(KEY); } catch { /* */ } document.getElementById('k-err').textContent = e.status === 403 || e.status === 401 ? t('ex.k.bad_key') : x.errMsg(e); }
    };
  }

  async function poll() {
    if (['exam', 'result', 'finishing'].includes(S.view)) return;
    try {
      const st = await call('GET', '/exam-runtime/state');
      S.wsCode = st.workstation.code; S.offline = false;
      if (st.state === 'IN_PROGRESS') return loadAttempt();
      const sig = st.state + ':' + (st.attemptId || '') + ':' + S.offline;
      if (st.state === 'FINISHED') { await showResult(); return; }
      const next = st.state === 'WAITING' ? 'waiting' : 'idle';
      const same = S.view === next && S.sig === sig;
      S.sig = sig; S.waiting = st.state === 'WAITING' ? st : null; S.view = next;
      if (same) return;
      if (next === 'waiting' && AUTO()) { draw(); startExam(); return; }
    } catch (e) {
      if (e.status === 401 || e.status === 403) { S.view = 'badkey'; } else S.offline = true;
      S.sig = null;
    }
    draw();
  }

  async function loadAttempt() {
    try {
      const a = await call('GET', '/exam-runtime/attempt');
      S.att = a; S.offset = new Date(a.serverNow).getTime() - Date.now();
      S.answers = new Map(a.questions.map((q) => [q.position, { optionId: q.selectedOptionId, seq: q.seq }]));
      S.seq = Math.max(0, ...a.questions.map((q) => q.seq));
      S.visited = new Set(a.questions.filter((q) => q.seq > 0).map((q) => q.position));
      if (!S.cur || S.cur > a.questions.length) S.cur = 1;
      S.view = 'exam'; clearInterval(S.tick); S.tick = setInterval(tick, 500); draw();
    } catch (e) {
      if (e.body && e.body.code === 'TIME_EXPIRED') return showResult();
      S.offline = true; draw();
    }
  }

  async function startExam() {
    const b = document.getElementById('k-start'); if (b) b.disabled = true;
    try { await call('POST', '/exam-runtime/start', { token: S.waiting.launchToken }); await loadAttempt(); }
    catch (e) { x.toast(x.errMsg(e), true); if (b) b.disabled = false; poll(); }
  }

  // ───────────────────────── экзамен ─────────────────────────
  const remainingMs = () => new Date(S.att.expiresAt).getTime() - (Date.now() + S.offset);
  function tick() {
    if (S.view !== 'exam') return;
    const ms = remainingMs(), el = document.getElementById('k-timer');
    if (el) { const s = Math.max(0, Math.ceil(ms / 1000)); el.textContent = String(Math.floor(s / 3600)).padStart(2, '0') + ':' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); el.className = 'k-timer' + (ms < 300000 ? ' crit' : ms < 900000 ? ' warn' : ''); }
    if (ms <= 0) finish(true);
  }

  const qOf = (pos) => S.att.questions.find((q) => q.position === pos);
  const state = (pos) => { const a = S.answers.get(pos); return a && a.optionId ? 'ans' : a && a.seq > 0 ? 'skp' : 'un'; };

  function select(pos, optionId) {
    const a = S.answers.get(pos) || { optionId: null, seq: 0 };
    if (a.optionId === optionId && a.seq > 0) return;
    S.answers.set(pos, { optionId, seq: ++S.seq });
    S.queue.push(pos); flush(); draw();
  }
  async function flush() {
    if (S.flushing) return;
    S.flushing = true;
    try {
      while (S.queue.length) {
        const pos = S.queue[0], a = S.answers.get(pos);
        try {
          const r = await call('PUT', '/exam-runtime/answers/' + pos, { optionId: a.optionId, seq: a.seq });
          S.offset = new Date(r.serverNow).getTime() - Date.now(); S.queue.shift(); if (S.offline) { S.offline = false; draw(); }
        } catch (e) {
          if (e.body && e.body.code === 'TIME_EXPIRED') { S.queue = []; finish(true); return; }
          if (e.status && e.status < 500 && e.status !== 429) { S.queue.shift(); continue; } // отклонено сервером — не повторяем
          S.offline = true; draw(); await new Promise((res) => setTimeout(res, 2500));
        }
      }
    } finally { S.flushing = false; }
  }
  function go(pos) {
    if (pos < 1 || pos > S.att.questions.length) return;
    const leaving = S.cur;
    const lv = S.answers.get(leaving);
    if (leaving && !(lv && lv.seq > 0)) { S.answers.set(leaving, { optionId: null, seq: ++S.seq }); S.queue.push(leaving); flush(); } // оставленный без ответа = SKIP
    S.cur = pos; S.visited.add(pos); draw();
    window.scrollTo({ top: 0 });
  }

  async function finish(auto) {
    if (S.view !== 'exam') return;
    if (!auto) {
      const total = S.att.questions.length, ans = S.att.questions.filter((q) => state(q.position) === 'ans').length, skp = S.att.questions.filter((q) => state(q.position) === 'skp' || (q.position === S.cur && state(q.position) === 'un')).length;
      const ok = await AP.tui.confirmDialog({ title: t('ex.k.finish_q'), message: t('ex.k.finish_text').replace('{a}', ans).replace('{s}', skp).replace('{u}', total - ans - skp), confirmLabel: t('ex.k.finish') });
      if (!ok) return;
    }
    S.view = 'finishing'; clearInterval(S.tick);
    root.innerHTML = '<div class="k-center"><div class="k-box"><div class="skel" style="height:90px"></div><p class="ex-muted">' + esc(t('ex.k.saving')) + '</p></div></div>';
    for (let i = 0; i < 20 && S.queue.length; i++) { await flush(); await new Promise((r) => setTimeout(r, 300)); }
    try { S.result = await call('POST', '/exam-runtime/submit'); }
    catch (e) { try { S.result = await call('GET', '/exam-runtime/result'); } catch { S.result = null; } }
    S.view = 'result'; draw();
  }

  async function showResult() {
    try { S.result = await call('GET', '/exam-runtime/result'); } catch { S.result = null; }
    S.view = 'result'; clearInterval(S.tick); draw();
  }

  // ───────────────────────── отрисовка ─────────────────────────
  function draw() {
    if (S.view === 'boot') return;
    if (S.view === 'badkey') { root.innerHTML = langBar() + '<div class="k-center"><div class="k-box"><h1 class="k-h">⚠ ' + esc(t('ex.k.bad_key')) + '</h1><button class="btn btn-outline" id="k-reset">' + esc(t('ex.k.change_key')) + '</button></div></div>'; bindLang(); document.getElementById('k-reset').onclick = () => { try { localStorage.removeItem(KEY); } catch { /* */ } location.reload(); }; return; }
    if (S.view === 'idle') { root.innerHTML = langBar() + '<div class="k-center"><div class="k-box"><img src="/img/logo.png" alt="" style="width:76px"><h1 class="k-h">' + esc(t('ex.k.ready')) + '</h1><p class="ex-muted">' + esc(t('ex.k.ready_text')) + '</p><div class="ex-chip info" style="font-size:15px">' + esc(S.wsCode) + '</div>' + (S.offline ? '<div class="ex-note bad" style="margin-top:16px">' + esc(t('ex.k.offline')) + '</div>' : '') + '</div></div>'; bindLang(); return; }
    if (S.view === 'waiting') {
      const w = S.waiting;
      root.innerHTML = langBar() + '<div class="k-center"><div class="k-box card"><div class="card-pad"><div class="ex-chip info">' + esc(S.wsCode) + '</div><h1 class="k-h" style="margin-top:12px">' + esc(w.student.fullName) + '</h1><div class="ex-muted">ID ' + esc(w.student.loginId) + ' · ' + esc(w.student.groupName) + '</div>' +
        '<div class="ex-note info" style="text-align:left;margin-top:18px"><b style="font-size:17px">' + esc(w.exam.subject) + '</b><div class="ex-row" style="margin-top:6px">' + x.chip(w.exam.kind === 'RESIT' ? 'warn' : 'info', t('ex.kind.' + w.exam.kind)) + x.chip('', w.exam.questions + ' ' + t('ex.s.questions')) + x.chip('', w.exam.durationMin + ' ' + t('ex.k.min')) + '</div><ul style="margin:10px 0 0 18px;padding:0;font-size:13.5px"><li>' + esc(t('ex.k.rule_score')) + '</li><li>' + esc(t('ex.k.rule_skip')) + '</li><li>' + esc(t('ex.k.rule_timer')) + '</li></ul></div>' +
        '<button class="btn btn-primary btn-lg" id="k-start" style="width:100%;margin-top:16px">' + esc(t('ex.k.start')) + '</button></div></div></div>';
      bindLang(); document.getElementById('k-start').onclick = startExam; return;
    }
    if (S.view === 'result') return drawResult();
    if (S.view === 'exam') return drawExam();
  }

  function drawExam() {
    const a = S.att, q = qOf(S.cur), cur = S.answers.get(S.cur), n = a.questions.length;
    const sel = cur ? cur.optionId : null;
    const langs = '<div class="lang-switcher">' + ['az', 'ru', 'en'].map((l) => '<button class="lang-btn' + (AP.i18n.getLang() === l ? ' active' : '') + '" data-l="' + l + '">' + l.toUpperCase() + '</button>').join('') + '</div>';
    root.innerHTML =
      '<div class="k-top"><div style="min-width:0"><b style="font-size:16px">' + esc(a.subject.name) + '</b><div class="ex-muted">' + esc(t('ex.kind.' + a.kind)) + ' · ' + esc(a.student) + '</div></div><div style="flex:1"></div>' + langs + '<div class="k-timer" id="k-timer">--:--:--</div></div>' +
      (S.offline ? '<div class="k-ofl">' + esc(t('ex.k.offline')) + '</div>' : '') +
      '<div class="k-nav" role="navigation">' + a.questions.map((z) => '<button class="k-n ' + state(z.position) + (z.position === S.cur ? ' cur' : '') + '" data-go="' + z.position + '" aria-label="' + z.position + '">' + z.position + '</button>').join('') +
        '<span class="ex-muted" style="margin-left:auto;align-self:center;font-size:12px">● ' + esc(t('ex.k.st_ans')) + ' &nbsp; ◌ ' + esc(t('ex.k.st_skp')) + ' &nbsp; ○ ' + esc(t('ex.k.st_un')) + '</span></div>' +
      '<div class="k-main"><div class="ex-muted" style="margin-bottom:6px">' + esc(t('ex.k.question')) + ' ' + S.cur + ' / ' + n + '</div><div class="k-q ex-rich">' + x.rich(q.body) + '</div>' + (q.image ? '<img class="k-img" alt="" src="' + esc(q.image) + '">' : '') +
        q.options.map((o) => '<button class="k-opt' + (sel === o.id ? ' on' : '') + '" data-opt="' + esc(o.id) + '"><span class="l">' + o.label + '</span><span class="ex-rich">' + x.rich(o.body) + '</span></button>').join('') +
        '<button class="k-opt skip' + (!sel ? ' on' : '') + '" data-opt=""><span class="l">–</span><span>' + esc(t('ex.k.skip')) + '</span></button></div>' +
      '<div class="k-bar"><button class="btn btn-outline btn-lg" id="k-prev"' + (S.cur === 1 ? ' disabled' : '') + '>← ' + esc(t('ex.k.prev')) + '</button><button class="btn btn-outline btn-lg" id="k-next"' + (S.cur === n ? ' disabled' : '') + '>' + esc(t('ex.k.next')) + ' →</button><button class="btn btn-primary btn-lg" id="k-fin">' + esc(t('ex.k.finish')) + '</button></div>';
    bindLang(); tick();
    root.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(Number(b.dataset.go))));
    root.querySelectorAll('[data-opt]').forEach((b) => b.addEventListener('click', () => select(S.cur, b.dataset.opt || null)));
    document.getElementById('k-prev').onclick = () => go(S.cur - 1);
    document.getElementById('k-next').onclick = () => go(S.cur + 1);
    document.getElementById('k-fin').onclick = () => finish(false);
  }

  function onKey(e) {
    if (S.view !== 'exam' || e.ctrlKey || e.metaKey || e.altKey) return;
    const q = qOf(S.cur);
    if (e.key === 'ArrowRight') go(S.cur + 1);
    else if (e.key === 'ArrowLeft') go(S.cur - 1);
    else if (/^[a-eA-E]$/.test(e.key)) { const o = q.options.find((z) => z.label === e.key.toUpperCase()); if (o) select(S.cur, o.id); }
    else if (e.key === '0' || e.key === 's' || e.key === 'S') select(S.cur, null);
  }

  function drawResult() {
    const r = S.result;
    if (!r) { root.innerHTML = langBar() + '<div class="k-center"><div class="k-box"><h1 class="k-h">' + esc(t('ex.k.submitted')) + '</h1></div></div>'; bindLang(); return finishBtn(); }
    if (!r.published) { root.innerHTML = langBar() + '<div class="k-center"><div class="k-box"><div style="font-size:54px">✓</div><h1 class="k-h">' + esc(t('ex.k.submitted')) + '</h1><p class="ex-muted">' + esc(t('ex.k.result_later')) + '</p><button class="btn btn-primary btn-lg" id="k-done">' + esc(t('ex.k.done')) + '</button></div></div>'; bindLang(); return finishBtn(); }
    const why = r.passed ? '' : r.failReason === 'MIN_EXAM_SCORE' ? t('ex.res.why_min').replace('{n}', r.minExamScore) : r.failReason === 'TOTAL_BELOW_PASS' ? t('ex.res.why_total').replace('{n}', r.passTotal) : t('ex.res.why_both').replace('{n}', r.passTotal).replace('{m}', r.minExamScore);
    root.innerHTML = langBar() + '<div class="k-center"><div class="k-box card"><div class="card-pad"><div class="ex-muted">' + esc(r.subject) + '</div><h1 class="k-h">' + esc(t('ex.res.title')) + '</h1>' +
      '<dl class="ex-kv" style="font-size:17px;row-gap:8px;text-align:left;margin:16px auto;max-width:360px"><dt>' + esc(t('ex.res.entry')) + '</dt><dd>' + x.num(r.entryScore) + '</dd><dt>' + esc(t('ex.res.exam')) + '</dt><dd>' + x.num(r.examScore) + ' / ' + r.examMax + '</dd><dt>' + esc(t('ex.res.total')) + '</dt><dd>' + x.num(r.total) + ' / ' + r.totalMax + '</dd><dt>' + esc(t('ex.res.grade')) + '</dt><dd>' + esc(r.letter) + '</dd></dl>' +
      '<div class="k-res" style="color:' + (r.passed ? '#059669' : '#dc2626') + '">' + esc(t(r.passed ? 'ex.res.passed' : 'ex.res.failed')) + '</div>' + (why ? '<div class="ex-note bad" style="margin-top:16px;text-align:left">' + esc(why) + '</div>' : '') +
      (r.appeal ? '<div class="ex-note info" style="margin-top:16px;text-align:left">⚖ ' + esc(t('ex.k.appeal_info').replace('{d}', x.fmtDT(r.appeal.deadline))) + '</div>' : '') +
      '<div class="ex-row" style="justify-content:center;margin-top:18px">' + (r.id ? '<button class="btn btn-outline btn-lg" id="k-review">' + esc(t('ex.k.my_mistakes')) + '</button><button class="btn btn-outline btn-lg" id="k-appeal">' + esc(t('ap.submit_appeal')) + '</button>' : '') +
      '<button class="btn btn-primary btn-lg" id="k-done">' + esc(t('ex.k.done')) + '</button></div></div></div></div>';
    bindLang(); finishBtn();
    // DEMO-вкладка открыта из портала студента: переходим в портал сразу к просмотру работы / мастеру апелляции
    // Просмотр работы и апелляция прямо на экзаменационном ПК (тот же компьютер, 30 минут после сдачи; дальше — в портале)
    const kioskSource = { review: () => call('GET', '/exam-runtime/appeal/review'), submit: (items) => call('POST', '/exam-runtime/appeal', { items }) };
    const open = (appeal) => AP.appeals.openReview(r.id, { source: kioskSource, filter: 'WRONG', appeal });
    const rv = document.getElementById('k-review'); if (rv) rv.onclick = () => open(false);
    const apb = document.getElementById('k-appeal'); if (apb) apb.onclick = () => open(true);
    if (!S.reviewShown) { S.reviewShown = true; open(false); } // по умолчанию сразу показываем неверные ответы
  }
  function finishBtn() { const b = document.getElementById('k-done'); if (b) b.onclick = () => {
    S.reviewShown = false; document.querySelectorAll('.modal-overlay').forEach((m) => m.remove()); if (AUTO()) { try { sessionStorage.removeItem(KEY); sessionStorage.removeItem('ap_demo_auto'); } catch { /* */ } window.close(); location.href = '/portal.html'; return; } S.view = 'idle'; S.att = null; S.result = null; S.cur = 0; S.queue = []; poll(); }; }

  boot();
})();
