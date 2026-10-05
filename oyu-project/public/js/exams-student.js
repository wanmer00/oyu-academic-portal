// ============================================================
// Вкладка EXAMS студента: Upcoming · Available · Completed · Resits · Results · Retakes.
// Студент ничего не запускает сам: компьютерный экзамен стартует только после авторизации проктора.
// ============================================================
(function (global) {
  'use strict';
  const AP = global.AP;
  const X = () => AP.ex, t = (k, fb) => AP.i18n.t(k, fb), esc = (s) => AP.ex.esc(s);
  const TABS = ['upcoming', 'available', 'completed', 'resits', 'results', 'retakes'];
  let state = { tab: 'available', data: null, root: null };

  async function render(rootId) {
    state.root = document.getElementById(rootId);
    state.root.innerHTML = X().skel(3);
    try { state.data = await X().api('/me/exams'); } catch (e) { state.root.innerHTML = X().errBox(e, 'ex-s-retry'); const b = document.getElementById('ex-s-retry'); if (b) b.onclick = () => render(rootId); return; }
    if (state.tab === 'available' && !state.data.available.length && state.data.upcoming.length) state.tab = 'upcoming';
    draw();
  }

  const count = (k) => {
    const d = state.data;
    return { upcoming: d.upcoming.length, available: d.available.length, completed: d.completed.length, results: d.results.length, resits: d.resits.items.length, retakes: d.retakes.required.length + d.retakes.registered.length }[k];
  };

  function draw() {
    const d = state.data, x = X();
    state.root.innerHTML =
      '<div class="ex-note info">🏛 ' + esc(t('ex.s.how')) + '</div>' +
      (d.demo ? '<div class="ex-note warn"><b>DEMO</b> · ' + esc(t('ex.s.demo_text')) + '<div style="margin-top:8px"><button class="btn btn-primary" id="ex-demo-go">▶ ' + esc(t('ex.s.demo_btn')) + '</button></div></div>' : '') +
      '<div class="ex-tabs" role="tablist">' + TABS.map((k) => '<button class="ex-tab' + (state.tab === k ? ' on' : '') + '" role="tab" data-tab="' + k + '">' + esc(t('ex.tab.' + k)) + ' <span class="ex-n">' + count(k) + '</span></button>').join('') + '</div>' +
      '<div id="ex-s-body"></div>';
    state.root.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; draw(); }));
    const dg = document.getElementById('ex-demo-go');
    if (dg) dg.onclick = async () => {
      dg.disabled = true;
      try { const r = await X().api('/me/demo-exam/start', { method: 'POST', body: {} }); X().toast(t('ex.s.demo_started').replace('{s}', r.subject).replace('{pc}', r.workstation)); window.open('/exam.html?demo=' + encodeURIComponent(r.key), '_blank'); } catch (e) { X().toast(X().errMsg(e), true); } finally { dg.disabled = false; }
    };
    const body = document.getElementById('ex-s-body');
    ({ upcoming: () => examCards(body, d.upcoming, false), available: () => examCards(body, d.available, true), completed: () => completed(body), resits: () => resits(body), results: () => results(body), retakes: () => retakes(body) })[state.tab]();
    void x;
  }

  function examCards(body, list, isAvail) {
    const x = X();
    if (!list.length) { body.innerHTML = x.empty(t(isAvail ? 'ex.s.none_available' : 'ex.s.none_upcoming')); return; }
    body.innerHTML = '<div class="ex-grid">' + list.map((e) => {
      const w = e.window, reasons = e.admission.reasons.filter((r) => !['OUTSIDE_ALLOWED_TIME', 'WEEKDAY_NOT_ALLOWED', 'WINDOW_NOT_STARTED'].includes(r));
      const status = e.startableNow ? x.chip('ok', t('ex.s.startable')) : reasons.length ? x.chip('bad', t('ex.s.not_admitted')) : x.chip('info', t('ex.s.admitted'));
      return '<div class="ex-card"><div class="ex-row" style="justify-content:space-between"><h3>' + esc(e.subject.name) + '</h3>' + status + '</div>' +
        '<div class="ex-row">' + x.chip(e.kind === 'RESIT' ? 'warn' : 'info', t('ex.kind.' + e.kind)) + x.chip('', t('ex.delivery.' + e.delivery)) + x.chip('', e.questions + ' ' + t('ex.s.questions')) + '</div>' +
        '<dl class="ex-kv"><dt>' + esc(t('ex.s.semester')) + '</dt><dd>' + esc(e.semester) + '</dd>' +
          '<dt>' + esc(t('ex.s.dates')) + '</dt><dd>' + esc(x.fmtDate(w.startDate)) + ' – ' + esc(x.fmtDate(w.endDate)) + '</dd>' +
          '<dt>' + esc(t('ex.s.days')) + '</dt><dd>' + x.days(w.weekdays) + '</dd>' +
          '<dt>' + esc(t('ex.s.time')) + '</dt><dd>' + esc(w.startTime) + ' – ' + esc(w.endTime) + '</dd>' +
          (!isAvail && e.nextDate ? '<dt>' + esc(t('ex.s.next_day')) + '</dt><dd>' + esc(x.fmtDate(e.nextDate)) + '</dd>' : '') + '</dl>' +
        (reasons.length ? '<ul class="ex-reasons">' + reasons.map((r) => '<li>' + esc(x.reasonText(r)) + '</li>').join('') + '</ul>' : '') +
        (e.resitPaymentRequired ? '<button class="btn btn-primary btn-sm" data-go="resits">' + esc(t('ex.s.go_resits')) + '</button>' : '') +
        (isAvail && !reasons.length ? '<div class="ex-muted">' + esc(t(e.delivery === 'PAPER' ? 'ex.s.paper_hint' : 'ex.s.proctor_hint')) + '</div>' : '') + '</div>';
    }).join('') + '</div>';
    body.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.go; draw(); }));
  }

  /** Статус каждого предмета в учебном цикле (модель: ENROLLED → COMPLETED | RESIT_* | RETAKE_REQUIRED …) */
  function subjectsCard() {
    const x = X(), s = state.data.subjects;
    if (!s.length) return '';
    const cls = (st) => (st === 'COMPLETED' ? 'ok' : st === 'ENROLLED' ? 'info' : st === 'RETAKE_REQUIRED' || st === 'RESIT_FORFEITED' ? 'bad' : 'warn');
    return '<h3 style="margin:20px 0 8px">' + esc(t('ex.s.subject_status')) + '</h3><div class="card"><div class="card-pad ex-scroll"><table class="ex-table"><thead><tr><th>' + esc(t('ex.col.subject')) + '</th><th>' + esc(t('ex.s.semester')) + '</th><th>' + esc(t('ex.col.status')) + '</th></tr></thead><tbody>' +
      s.map((e) => '<tr><td><b>' + esc(e.subject.name) + '</b>' + (e.attemptNo > 1 ? ' <span class="ex-chip warn">' + esc(t('ex.s.attempt').replace('{n}', e.attemptNo)) + '</span>' : '') + '</td><td>' + esc(e.academicYear.replace('-', '/') + ' · ' + t('ex.term.' + e.term)) + '</td><td>' + x.chip(cls(e.status), x.statusText(e.status)) + '</td></tr>').join('') + '</tbody></table></div></div>';
  }

  function completed(body) {
    const x = X(), d = state.data;
    if (!d.completed.length) { body.innerHTML = x.empty(t('ex.s.none_completed')) + subjectsCard(); return; }
    body.innerHTML = '<div class="card"><div class="card-pad ex-scroll"><table class="ex-table"><thead><tr><th>' + esc(t('ex.col.subject')) + '</th><th>' + esc(t('ex.col.type')) + '</th><th>' + esc(t('ex.col.date')) + '</th><th>' + esc(t('ex.col.status')) + '</th></tr></thead><tbody>' +
      d.completed.map((r) => '<tr><td><b>' + esc(r.subject.name) + '</b><div class="ex-muted">' + esc(r.window) + '</div></td><td>' + x.chip(r.kind === 'RESIT' ? 'warn' : 'info', t('ex.kind.' + r.kind)) + '</td><td>' + esc(x.fmtDT(r.date)) + '</td><td>' +
        (r.status === 'ABSENT' ? x.chip('bad', t('ex.st.ABSENT')) : r.awaitingResult ? x.chip('warn', t('ex.s.awaiting')) : x.chip('ok', x.statusText(r.status))) +
        (r.resultId ? ' <button class="btn btn-outline btn-sm" data-res="' + esc(r.resultId) + '">' + esc(t('ex.s.open_result')) + '</button>' : '') + '</td></tr>').join('') + '</tbody></table></div></div>';
    body.insertAdjacentHTML('beforeend', subjectsCard());
    body.querySelectorAll('[data-res]').forEach((b) => b.addEventListener('click', () => showResult(b.dataset.res)));
  }

  /** Страница результата: Entry / Exam / Total / Grade / Status + понятное объяснение причины провала */
  async function showResult(id) {
    const x = X();
    let r = state.data.results.find((z) => z.id === id);
    if (!r) { try { r = await x.api('/me/exam-results/' + id); } catch (e) { x.toast(x.errMsg(e), true); return; } }
    const why = r.passed ? '' : r.failReason === 'MIN_EXAM_SCORE' ? t('ex.res.why_min', 'Total is sufficient, but the minimum exam score ({n}) was not reached.').replace('{n}', r.minExamScore)
      : r.failReason === 'TOTAL_BELOW_PASS' ? t('ex.res.why_total').replace('{n}', r.passTotal) : r.failReason === 'ABSENT' ? t('ex.res.why_absent') : t('ex.res.why_both').replace('{n}', r.passTotal).replace('{m}', r.minExamScore);
    AP.tui.openModal({
      title: t('ex.res.title') + (r.subject ? ' — ' + r.subject.name : ''), wide: false,
      html: '<div class="ex-row" style="justify-content:space-between;margin-bottom:12px"><span class="ex-chip ' + (r.passed ? 'ok' : 'bad') + '" style="font-size:14px">' + esc(t(r.passed ? 'ex.res.passed' : 'ex.res.failed')) + '</span><span class="ex-letter ' + (r.letter === 'F' ? 'F' : '') + '">' + esc(r.letter) + '</span></div>' +
        '<dl class="ex-kv" style="font-size:14px;row-gap:8px"><dt>' + esc(t('ex.res.entry')) + '</dt><dd>' + x.num(r.entryScore) + '</dd><dt>' + esc(t('ex.res.exam')) + '</dt><dd>' + x.num(r.examScore) + ' / ' + r.examMax + '</dd>' +
        '<dt>' + esc(t('ex.res.total')) + '</dt><dd>' + x.num(r.total) + ' / ' + r.totalMax + '</dd><dt>' + esc(t('ex.res.grade')) + '</dt><dd>' + esc(r.letter) + '</dd>' +
        '<dt>' + esc(t('ex.res.answers')) + '</dt><dd>✓ ' + r.correct + ' · ✗ ' + r.wrong + ' · ○ ' + r.skipped + '</dd></dl>' +
        (why ? '<div class="ex-note bad" style="margin-top:14px">' + esc(why) + '</div>' : '') +
        '<div class="ex-muted" style="margin-top:10px">' + esc(t('ex.res.rule').replace('{t}', r.passTotal).replace('{m}', r.minExamScore)) + '</div>',
      buttons: [
        { label: t('common.close'), cls: 'btn-outline' },
        ...(r.source === 'COMPUTER' || r.source === 'PAPER' || r.source === undefined ? [
          { label: t('ap.review_exam'), cls: 'btn-outline', onClick: () => { AP.appeals.openReview(r.id, { onDone: () => render(state.root.id) }); } },
          { label: t('ap.submit_appeal'), cls: 'btn-primary', onClick: () => { AP.appeals.openReview(r.id, { appeal: true, onDone: () => render(state.root.id) }); } },
        ] : []),
      ],
    });
  }

  function results(body) {
    const x = X(), d = state.data;
    if (!d.results.length) { body.innerHTML = x.empty(t('ex.s.none_results')); return; }
    body.innerHTML = '<div class="ex-grid">' + d.results.map((r) =>
      '<div class="ex-card"><div class="ex-row" style="justify-content:space-between"><h3>' + esc(r.subject ? r.subject.name : '—') + '</h3><span class="ex-letter ' + (r.letter === 'F' ? 'F' : '') + '">' + esc(r.letter) + '</span></div>' +
      '<div class="ex-row">' + x.chip(r.kind === 'RESIT' ? 'warn' : 'info', t('ex.kind.' + r.kind)) + x.chip(r.passed ? 'ok' : 'bad', t(r.passed ? 'ex.res.passed' : 'ex.res.failed')) + '</div>' +
      '<div class="ex-row" style="gap:18px"><div><div class="ex-muted">' + esc(t('ex.res.entry')) + '</div><b>' + x.num(r.entryScore) + '</b></div><div><div class="ex-muted">' + esc(t('ex.res.exam')) + '</div><b>' + x.num(r.examScore) + ' / 50</b></div><div><div class="ex-muted">' + esc(t('ex.res.total')) + '</div><div class="ex-score">' + x.num(r.total) + '</div></div></div>' +
      '<div class="ex-row"><button class="btn btn-outline btn-sm" data-res="' + esc(r.id) + '">' + esc(t('ex.s.details')) + '</button>' + (r.source === 'COMPUTER' || r.source === 'PAPER' ? '<button class="btn btn-primary btn-sm" data-review="' + esc(r.id) + '">' + esc(t('ap.review_exam')) + '</button>' : '') + '</div></div>').join('') + '</div>';
    body.querySelectorAll('[data-review]').forEach((b) => b.addEventListener('click', () => AP.appeals.openReview(b.dataset.review, { onDone: () => render(state.root.id) })));
    body.querySelectorAll('[data-res]').forEach((b) => b.addEventListener('click', () => showResult(b.dataset.res)));
  }

  // ───────────────────────── Resits ─────────────────────────
  function resits(body) {
    const x = X(), r = state.data.resits;
    let html = '<div class="ex-note ' + (r.limit.cycles.some((c) => c.used >= c.max) ? 'warn' : 'info') + '">' + esc(t('ex.rs.rules').replace('{n}', r.limit.max)) +
      (r.limit.cycles.length ? '<div style="margin-top:6px">' + r.limit.cycles.map((c) => x.chip(c.used >= c.max ? 'bad' : 'info', c.cycle + ': ' + c.used + ' / ' + c.max)).join(' ') + '</div>' : '') + '</div>';
    if (!r.items.length) { body.innerHTML = html + x.empty(t('ex.s.none_resits')); return; }
    html += '<div class="ex-grid">' + r.items.map((i) => {
      const st = i.payment;
      const chip = st === 'PAID' ? x.chip('ok', t('ex.pay.PAID')) : st === 'USED' ? x.chip('', t('ex.pay.USED')) : st === 'FORFEITED' ? x.chip('bad', t('ex.pay.FORFEITED')) : st === 'NO_WINDOW' ? x.chip('warn', t('ex.pay.NO_WINDOW')) : i.limitReached ? x.chip('bad', t('ex.rs.limit_chip')) : x.chip('warn', t('ex.pay.ELIGIBLE'));
      return '<div class="ex-card"><div class="ex-row" style="justify-content:space-between"><h3>' + esc(i.subject.name) + '</h3>' + chip + '</div>' +
        '<dl class="ex-kv"><dt>' + esc(t('ex.rs.credits')) + '</dt><dd>' + i.credits + '</dd><dt>' + esc(t('ex.rs.price')) + '</dt><dd>' + x.num(i.creditPrice) + ' AZN</dd><dt>' + esc(t('ex.rs.full')) + '</dt><dd>' + x.num(i.fullCost) + ' AZN</dd><dt>' + esc(t('ex.rs.fee')) + '</dt><dd style="font-size:16px">' + x.num(i.fee) + ' AZN</dd>' +
        (i.window ? '<dt>' + esc(t('ex.rs.window')) + '</dt><dd>' + esc(x.fmtDate(i.window.startDate)) + ' – ' + esc(x.fmtDate(i.window.endDate)) + '</dd><dt>' + esc(t('ex.s.time')) + '</dt><dd>' + esc(i.window.time) + '</dd>' : '') + '</dl>' +
        (i.limitReached ? '<div class="ex-note bad" style="margin:0">' + esc(t('ex.rs.limit_text')) + '</div>' : '') +
        (i.status === 'RESIT_FORFEITED' && !i.window ? '<div class="ex-note warn" style="margin:0">' + esc(t('ex.rs.forfeited_text')) + '</div>' : '') +
        (i.canPay ? '<button class="btn btn-primary" data-pay="' + esc(i.resitId) + '">' + esc(t('ex.rs.pay_btn').replace('{n}', x.num(i.fee))) + '</button>' : '') + '</div>';
    }).join('') + '</div>';
    body.innerHTML = html;
    body.querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', () => payModal(r.items.find((z) => z.resitId === b.dataset.pay))));
  }

  function payModal(i) {
    const x = X();
    AP.tui.openModal({
      title: t('ex.rs.pay_title'),
      html: '<div class="ex-note info">' + esc(t('ex.rs.demo_pay')) + '</div><dl class="ex-kv" style="font-size:14px;row-gap:8px"><dt>' + esc(t('ex.col.subject')) + '</dt><dd>' + esc(i.subject.name) + '</dd>' +
        '<dt>' + esc(t('ex.rs.credits')) + '</dt><dd>' + i.credits + '</dd><dt>' + esc(t('ex.rs.price')) + '</dt><dd>' + x.num(i.creditPrice) + ' AZN</dd><dt>' + esc(t('ex.rs.full')) + '</dt><dd>' + i.credits + ' × ' + x.num(i.creditPrice) + ' = ' + x.num(i.fullCost) + ' AZN</dd>' +
        '<dt>' + esc(t('ex.rs.fee')) + '</dt><dd style="font-size:18px">' + x.num(i.fee) + ' AZN</dd></dl><div class="ex-muted" style="margin-top:10px">' + esc(t('ex.rs.server_calc')) + '</div>',
      buttons: [
        { label: t('common.cancel'), cls: 'btn-outline' },
        { label: t('ex.rs.pay_btn').replace('{n}', x.num(i.fee)), cls: 'btn-primary', onClick: async () => {
          try { await x.api('/me/resits/' + i.resitId + '/pay', { method: 'POST', body: {} }); x.toast(t('ex.rs.paid_ok')); await render(state.root.id); } catch (e) { x.toast(x.errMsg(e), true); await render(state.root.id); }
        } },
      ],
    });
  }

  // ───────────────────────── Retakes ─────────────────────────
  function retakes(body) {
    const x = X(), r = state.data.retakes;
    let html = '<div class="ex-note info">' + esc(t('ex.rt.rules')) + '</div>';
    if (!r.required.length && !r.registered.length) html += x.empty(t('ex.s.none_retakes'));
    for (const q of r.required) {
      html += '<div class="card" style="margin-bottom:14px"><div class="card-pad"><div class="ex-row" style="justify-content:space-between"><h3 style="margin:0">' + esc(q.subject.name) + '</h3>' + x.chip('bad', x.statusText(q.status === 'RESIT_FORFEITED' ? 'RESIT_FORFEITED' : 'RETAKE_REQUIRED')) + '</div>' +
        '<div class="ex-muted" style="margin:4px 0 10px">' + esc(t('ex.rt.reason.' + q.reason)) + '</div>';
      html += '<div class="ex-row" style="align-items:flex-start;gap:14px"><div style="flex:1;min-width:260px"><b>' + esc(t('ex.rt.summer')) + '</b>' +
        (q.summer.length ? q.summer.map((c) => '<div class="ex-note" style="margin:8px 0 0"><b>' + esc(c.title) + '</b><div class="ex-muted">' + esc(x.fmtDate(c.startDate)) + ' – ' + esc(x.fmtDate(c.endDate)) + (c.teacher ? ' · ' + esc(c.teacher) : '') + '</div>' + (c.schedule ? '<div class="ex-muted">' + esc(c.schedule) + '</div>' : '') +
          '<div class="ex-muted">' + esc(t('ex.rt.attendance').replace('{n}', c.minAttendance)) + ' · ' + esc(t('ex.rt.seats').replace('{n}', c.seatsLeft)) + '</div>' +
          '<button class="btn btn-primary btn-sm" style="margin-top:6px" data-reg="' + esc(q.enrollmentId) + '" data-mode="SUMMER" data-course="' + esc(c.courseId) + '"' + (c.seatsLeft ? '' : ' disabled') + '>' + esc(t('ex.rt.register')) + '</button></div>').join('') : '<div class="ex-muted" style="margin-top:6px">' + esc(t('ex.rt.no_summer')) + '</div>') + '</div>';
      html += '<div style="flex:1;min-width:260px"><b>' + esc(t('ex.rt.offering')) + '</b>';
      if (q.next) html += '<div class="ex-note ok" style="margin:8px 0 0"><div class="ex-chip ok">' + esc(t('ex.rt.next_available')) + '</div><div style="margin-top:6px;font-weight:700">' + esc(q.next.academicYear.replace('-', '/')) + ' · ' + esc(t('ex.term.' + q.next.term)) + ' · ' + esc(t('ex.rt.course').replace('{n}', q.next.course)) + '</div><div class="ex-muted">' + esc(t('ex.rt.starts')) + ' ' + esc(x.fmtDate(q.next.startsAt)) + '</div>' +
        '<button class="btn btn-primary btn-sm" style="margin-top:6px" data-reg="' + esc(q.enrollmentId) + '" data-mode="NEXT_OFFERING" data-off="' + esc(q.next.offeringId) + '">' + esc(t('ex.rt.register')) + '</button></div>';
      else html += '<div class="ex-muted" style="margin-top:6px">' + esc(t('ex.rt.no_offering')) + '</div>';
      const others = q.offerings.filter((o) => !q.next || o.offeringId !== q.next.offeringId);
      if (others.length) html += '<div style="margin-top:8px">' + others.map((o) => '<div class="ex-muted">' + esc(o.academicYear.replace('-', '/')) + ' · ' + esc(t('ex.term.' + o.term)) + ' · ' + esc(t('ex.rt.course').replace('{n}', o.course)) + ' — ' + (o.blocked ? x.chip('warn', t('ex.err.' + o.blocked) + (o.missingPrerequisites.length ? ': ' + o.missingPrerequisites.map((m) => m.name).join(', ') : '')) : '<button class="btn btn-outline btn-sm" data-reg="' + esc(q.enrollmentId) + '" data-mode="NEXT_OFFERING" data-off="' + esc(o.offeringId) + '">' + esc(t('ex.rt.register')) + '</button>') + '</div>').join('') + '</div>';
      html += '</div></div></div></div>';
    }
    if (r.registered.length) {
      html += '<h3 style="margin:18px 0 8px">' + esc(t('ex.rt.registered')) + '</h3><div class="ex-grid">' + r.registered.map((g) => '<div class="ex-card"><h3>' + esc(g.subject.name) + '</h3><div class="ex-row">' + x.chip('info', t('ex.rt.mode.' + g.mode)) + x.chip('ok', t('ex.rt.status.' + g.status)) + '</div><div class="ex-muted">' +
        (g.summer ? esc(g.summer.title) + ' · ' + esc(x.fmtDate(g.summer.startDate)) + ' – ' + esc(x.fmtDate(g.summer.endDate)) + (g.summer.schedule ? ' · ' + esc(g.summer.schedule) : '') : g.offering ? esc(g.offering.academicYear.replace('-', '/')) + ' · ' + esc(t('ex.term.' + g.offering.term)) + ' · ' + esc(t('ex.rt.course').replace('{n}', g.offering.course)) : '') + '</div></div>').join('') + '</div>';
    }
    body.innerHTML = html;
    body.querySelectorAll('[data-reg]').forEach((b) => b.addEventListener('click', async () => {
      const ok = await AP.tui.confirmDialog({ title: t('ex.rt.confirm_title'), message: t('ex.rt.confirm_text'), confirmLabel: t('ex.rt.register') });
      if (!ok) return;
      try {
        await x.api('/me/retakes/' + b.dataset.reg + '/register', { method: 'POST', body: b.dataset.mode === 'SUMMER' ? { mode: 'SUMMER', summerCourseId: b.dataset.course } : { mode: 'NEXT_OFFERING', offeringId: b.dataset.off } });
        x.toast(t('ex.rt.registered_ok')); await render(state.root.id);
      } catch (e) { x.toast(x.errMsg(e), true); }
    }));
  }

  /** Статусы предметов: компактная таблица (используется на странице «Мой прогресс» и во вкладке Completed) */
  AP.examsStudent = { render, subjectsHtml: () => '' };
})(window);
