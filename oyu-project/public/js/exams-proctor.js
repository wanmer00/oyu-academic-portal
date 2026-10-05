// ============================================================
// PROCTOR DASHBOARD: найти студента → проверить ID и паспорт → выбрать предмет → допуск → выбрать ПК → START EXAM.
// Допуск, окно, лимиты и токен проверяет backend; проктор не видит вопросы и правильные ответы.
// ============================================================
(function () {
  'use strict';
  const t = (k, fb) => AP.i18n.t(k, fb), x = AP.ex, esc = x.esc, $ = (id) => document.getElementById(id);
  let rooms = [], roomId = '', pcs = [], student = null, exams = [], examId = '', pcId = '';
  let timer = null;

  async function boot() {
    await AP.i18n.load(AP.i18n.getLang());
    document.querySelectorAll('.lang-btn').forEach((b) => { b.classList.toggle('active', b.dataset.lang === AP.i18n.getLang()); b.addEventListener('click', () => AP.i18n.load(b.dataset.lang)); });
    let user = null;
    try { user = await AP.api.refresh(); } catch { /* */ }
    if (!user) { location.href = '/login.html'; return; }
    if (!['PROCTOR', 'ADMIN', 'SUPER_ADMIN'].includes(user.role)) { location.href = '/portal.html'; return; }
    $('pr-logout').onclick = async () => { await AP.api.logout(); location.href = '/login.html'; };
    document.addEventListener('ap:lang-changed', () => { document.querySelectorAll('.lang-btn').forEach((b) => b.classList.toggle('active', b.dataset.lang === AP.i18n.getLang())); AP.i18n.applyToDom(); drawPcs(); drawStudent(); drawExams(); });
    try { rooms = await x.api('/proctor/rooms'); } catch (e) { $('pr-pcs').innerHTML = x.errBox(e); return; }
    if (!rooms.length) { $('pr-pcs').innerHTML = x.empty(t('ex.pc.no_rooms')); return; }
    $('pr-room').innerHTML = rooms.map((r) => '<option value="' + esc(r.id) + '">' + esc(r.code + ' · ' + (r.name || '')) + ' (' + r.workstations + ')</option>').join('');
    roomId = rooms[0].id;
    $('pr-room').onchange = (e) => { roomId = e.target.value; pcId = ''; refresh(); updateGo(); };
    $('pr-q').addEventListener('input', debounce(search, 250));
    $('pr-id').onchange = $('pr-pass').onchange = updateGo;
    $('pr-go').onclick = start;
    await refresh();
    timer = setInterval(refresh, 4000);
  }
  const debounce = (fn, ms) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };

  async function refresh() {
    try { pcs = await x.api('/proctor/rooms/' + roomId + '/status'); $('pr-sync').textContent = new Date().toLocaleTimeString(); drawPcs(); } catch (e) { $('pr-pcs').innerHTML = x.errBox(e); }
  }

  const remaining = (iso) => { const s = Math.max(0, Math.round((new Date(iso) - Date.now()) / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  function drawPcs() {
    const cls = { AVAILABLE: 'ok', WAITING: 'warn', IN_EXAM: 'info' };
    $('pr-pcs').innerHTML = '<div class="ex-pc">' + pcs.map((p) => {
      const a = p.attempt;
      return '<div class="ex-pcell ' + p.state + (pcId === p.id ? ' sel' : '') + '" data-pc="' + esc(p.id) + '"><b>' + esc(p.code) + '</b>' + x.chip(cls[p.state] || '', t('ex.st.PC_' + p.state)) +
        (a ? '<div>' + esc(a.student.fullName) + '</div><div class="ex-muted">' + esc(a.subject) + '</div><div class="ex-muted">' + (p.state === 'IN_EXAM' ? '⏱ ' + remaining(a.expiresAt) : '⌛ ' + remaining(a.expiresAt)) + '</div>' +
          (p.state === 'IN_EXAM' ? '<button class="btn btn-danger btn-sm" data-term="' + esc(a.id) + '">' + esc(t('ex.pc.terminate')) + '</button>' : '<button class="btn btn-outline btn-sm" data-rev="' + esc(a.authorizationId) + '">' + esc(t('ex.pc.revoke')) + '</button>') : '') + '</div>';
    }).join('') + '</div>';
    $('pr-pcs').querySelectorAll('[data-pc]').forEach((c) => c.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const p = pcs.find((z) => z.id === c.dataset.pc);
      if (p.state !== 'AVAILABLE') return;
      pcId = p.id; $('pr-pcsel').innerHTML = '<b>' + esc(p.code) + '</b>'; drawPcs(); updateGo();
    }));
    $('pr-pcs').querySelectorAll('[data-term]').forEach((b) => b.addEventListener('click', () => reasonModal(t('ex.pc.terminate'), async (reason) => { await x.api('/proctor/attempts/' + b.dataset.term + '/terminate', { method: 'POST', body: { reason } }); refresh(); })));
    $('pr-pcs').querySelectorAll('[data-rev]').forEach((b) => b.addEventListener('click', () => reasonModal(t('ex.pc.revoke'), async (reason) => { await x.api('/proctor/authorizations/' + b.dataset.rev, { method: 'DELETE', body: { reason } }); refresh(); })));
  }

  function reasonModal(title, fn) {
    const h = AP.tui.openModal({ title, html: '<div class="form-label">' + esc(t('ex.rv.reason')) + '</div><input class="input" id="pr-reason" maxlength="300">', buttons: [{ label: t('common.cancel'), cls: 'btn-outline' }, { label: title, cls: 'btn-danger', onClick: async () => { const r = h.$('#pr-reason').value.trim(); if (r.length < 3) { x.toast(t('ex.rv.reason_req'), true); return false; } try { await fn(r); } catch (e) { x.toast(x.errMsg(e), true); return false; } } }] });
  }

  async function search() {
    const q = $('pr-q').value.trim(), box = $('pr-found');
    if (q.length < 2) { box.style.display = 'none'; return; }
    try {
      const rows = await x.api('/proctor/students?q=' + encodeURIComponent(q));
      box.style.display = '';
      box.innerHTML = rows.length ? rows.map((s) => '<button data-id="' + esc(s.id) + '"><b>' + esc(s.fullName) + '</b> <code>' + esc(s.loginId) + '</code><div class="ex-muted">' + esc(s.groupName) + ' · ' + esc(s.specialty) + '</div></button>').join('') : '<div class="empty">' + esc(t('ex.pc.not_found')) + '</div>';
      box.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => pick(rows.find((r) => r.id === b.dataset.id))));
    } catch (e) { x.toast(x.errMsg(e), true); }
  }

  async function pick(s) {
    student = s; examId = ''; $('pr-found').style.display = 'none'; $('pr-q').value = '';
    $('pr-id').checked = false; $('pr-pass').checked = false; $('pr-msg').innerHTML = '';
    ['st2', 'st3', 'st4'].forEach((i) => $(i).classList.remove('dis'));
    drawStudent();
    $('pr-exams').innerHTML = x.skel(2);
    try { exams = (await x.api('/proctor/students/' + s.id + '/exams')).exams; } catch (e) { $('pr-exams').innerHTML = x.errBox(e); return; }
    drawExams(); updateGo();
  }
  function drawStudent() {
    if (!student) { $('pr-stu').innerHTML = ''; return; }
    $('pr-stu').innerHTML = '<b style="font-size:16px">' + esc(student.fullName) + '</b><div class="ex-muted">ID <code>' + esc(student.loginId) + '</code> · ' + esc(student.groupName) + ' · ' + esc(t('ex.pc.course').replace('{n}', student.course)) + '</div><div class="ex-muted">' + esc(student.specialty) + '</div>';
  }
  function drawExams() {
    const box = $('pr-exams');
    if (!student) { box.innerHTML = ''; return; }
    if (!exams.length) { box.innerHTML = x.empty(t('ex.pc.no_exams')); return; }
    box.innerHTML = exams.map((e) => '<div class="pr-exam ' + (e.examId === examId ? 'on ' : '') + (e.eligible ? '' : 'bad') + '" data-ex="' + esc(e.examId) + '"><div style="flex:1"><b>' + esc(e.subject.name) + '</b> ' + x.chip(e.kind === 'RESIT' ? 'warn' : 'info', t('ex.kind.' + e.kind)) + '<div class="ex-muted">' + esc(e.window) + ' · ' + esc(e.time) + '</div>' +
      (e.eligible ? '' : '<ul class="ex-reasons">' + e.reasons.map((r) => '<li>' + esc(x.reasonText(r)) + '</li>').join('') + '</ul>') + '</div>' + x.chip(e.eligible ? 'ok' : 'bad', t(e.eligible ? 'ex.pc.eligible' : 'ex.pc.not_eligible')) + '</div>').join('');
    box.querySelectorAll('[data-ex]').forEach((d) => d.addEventListener('click', () => { const e = exams.find((z) => z.examId === d.dataset.ex); if (!e.eligible) return; examId = e.examId; drawExams(); updateGo(); }));
  }
  function updateGo() { $('pr-go').disabled = !(student && examId && pcId && $('pr-id').checked && $('pr-pass').checked); }

  async function start() {
    const btn = $('pr-go'); btn.disabled = true;
    try {
      const r = await x.api('/proctor/authorizations', { method: 'POST', body: { studentId: student.id, examId, workstationId: pcId, idChecked: true, passportChecked: true } });
      $('pr-msg').innerHTML = '<div class="ex-note ok">✓ ' + esc(t('ex.pc.authorized').replace('{pc}', r.workstation).replace('{s}', student.fullName)) + '</div>';
      student = null; examId = ''; pcId = ''; exams = []; ['st2', 'st3', 'st4'].forEach((i) => $(i).classList.add('dis')); drawStudent(); drawExams(); $('pr-pcsel').textContent = t('ex.pc.pick_pc'); refresh();
    } catch (e) {
      $('pr-msg').innerHTML = '<div class="ex-note bad">' + esc(x.errMsg(e)) + '</div>';
      try { exams = (await x.api('/proctor/students/' + student.id + '/exams')).exams; drawExams(); } catch { /* */ }
      refresh();
    }
    updateGo();
  }

  boot();
  window.addEventListener('beforeunload', () => clearInterval(timer));
})();
