// ============================================================
// Exam Review и апелляция по экзамену — часть существующих Requests (Request.type = APPEAL).
// Студент: просмотр работы → выбор спорных вопросов → причина + объяснение → проверка → отправка → статус.
// Преподаватель / руководство: список, рассмотрение по вопросам, эскалация, решение, аналитика.
// Все проверки (владелец, окно, дедлайн, дубликаты, права, баллы) — на backend; здесь только интерфейс.
// ============================================================
(function (global) {
  'use strict';
  const AP = global.AP;
  const X = () => AP.ex, t = (k, fb) => AP.i18n.t(k, fb), esc = (s) => AP.ex.esc(s);
  const STATE_ICON = { CORRECT: '✅', WRONG: '❌', SKIP: '○', PARTIAL: '⚠' };
  const statusChip = (s) => X().chip({ PENDING: 'warn', UNDER_REVIEW: 'info', APPROVED: 'ok', PARTIALLY_APPROVED: 'ok', REJECTED: 'bad', WITHDRAWN: '' }[s] || '', t('requests.status.' + String(s).toLowerCase(), s));
  const pts = (n) => (n > 0 ? '+' + n : String(n));
  const left = (d) => { const ms = new Date(d) - Date.now(); if (ms <= 0) return ''; const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000); return h >= 24 ? Math.floor(h / 24) + t('ap.d') + ' ' + (h % 24) + t('ap.h') : h + t('ap.h') + ' ' + m + t('ap.m'); };

  // ───────────────────────── студент: Exam Review + мастер апелляции ─────────────────────────
  async function openReview(resultId, opts) {
    const x = X();
    let d;
    const src = (opts && opts.source) || { review: () => x.api('/me/exam-results/' + encodeURIComponent(resultId) + '/review'), submit: (items) => x.api('/me/requests', { method: 'POST', body: { type: 'APPEAL', appeal: { resultId, items } } }) };
    try { d = await src.review(); } catch (e) { x.toast(x.errMsg(e), true); return; }
    // по умолчанию — неверные ответы (если их нет — все вопросы)
    const want = (opts && opts.filter) || 'ALL';
    const S = { step: 1, filter: want === 'WRONG' && !d.questions.some((q) => q.state === 'WRONG') ? (d.questions.some((q) => q.state === 'SKIP') ? 'SKIP' : 'ALL') : want, sel: new Set(), items: {}, d };
    const r = d.result, ap = d.appeal;
    const eff = r.revised || r;
    const counts = { WRONG: d.questions.filter((q) => q.state === 'WRONG').length, SKIP: d.questions.filter((q) => q.state === 'SKIP').length };
    const h = AP.tui.openModal({ title: t('ap.review_title'), wide: true, static: true, html: '<div id="ap-wiz" aria-live="polite"></div>', buttons: [{ label: t('common.close'), cls: 'btn-outline' }] });
    const box = h.$('#ap-wiz');
    if (opts && opts.appeal && ap.canAppeal) S.step = 2;

    const header = () => '<div class="ex-row" style="justify-content:space-between;margin-bottom:10px"><div><b style="font-size:16px">' + esc(r.subject ? r.subject.name : '') + '</b><div class="ex-muted">' + esc(t('ex.kind.' + r.kind)) + ' · ' + esc(r.window || '') + ' · ' + esc(x.fmtDate(r.date)) + '</div></div>' +
      '<div style="text-align:right"><div class="ex-score">' + x.num(eff.examScore) + ' / ' + r.examMax + '</div>' + (r.revised ? '<div class="ex-muted">' + esc(t('ap.original')) + ': ' + x.num(r.examScore) + '</div>' : '') + '</div></div>' +
      '<div class="ex-row" style="gap:6px;margin-bottom:12px">' + ['1', '2', '3', '4'].map((n) => '<span class="ex-chip ' + (String(S.step) === n ? 'info' : '') + '">' + n + '. ' + esc(t('ap.step' + n)) + '</span>').join('') + '</div>';

    const windowNote = () => {
      if (ap.canAppeal) return '<div class="ex-note info">⏳ ' + esc(t('ap.window_open').replace('{d}', x.fmtDT(ap.deadline)).replace('{left}', left(ap.deadline))) + '</div>';
      const why = { APPEAL_NOT_OPEN: t('ap.opens_at').replace('{d}', x.fmtDT(ap.openAt)), APPEAL_CLOSED: t('ap.closed'), APPEAL_ACTIVE: t('ap.active'), APPEAL_ALREADY_DECIDED: t('ap.decided'), APPEAL_NOT_AVAILABLE: t('ap.not_available') }[ap.reason] || t('ex.err.' + ap.reason, ap.reason);
      return '<div class="ex-note ' + (ap.reason === 'APPEAL_ACTIVE' ? 'info' : 'warn') + '">' + esc(why) + (ap.request ? ' · <b>#' + esc(ap.request.code) + '</b> ' + statusChip(ap.request.status) : '') + '</div>';
    };

    const qLine = (q, check) => '<div class="ex-q" style="display:flex;gap:10px;align-items:flex-start">' +
      (check ? '<input type="checkbox" data-sel="' + q.position + '" id="ap-q' + q.position + '"' + (S.sel.has(q.position) ? ' checked' : '') + ' aria-label="' + esc(t('ap.question')) + ' ' + q.position + '" style="margin-top:4px;width:18px;height:18px">' : '') +
      '<label for="ap-q' + q.position + '" style="flex:1;cursor:' + (check ? 'pointer' : 'default') + '"><div class="ex-row" style="justify-content:space-between"><b>' + esc(t('ap.question')) + ' ' + q.position + '</b><span>' + STATE_ICON[q.state] + ' <b>' + pts(q.points) + ' / ' + q.maxPoints + '</b> · ' + esc(t('ap.state.' + q.state)) + '</span></div>' +
      '<div class="ex-rich" style="margin:4px 0">' + x.rich(q.text) + '</div>' + (q.image ? '<img class="ex-img" alt="" src="' + esc(q.image) + '">' : '') +
      '<div class="ex-muted">' + esc(t(staff ? 'ap.student_answer' : 'ap.your_answer')) + ': ' + (q.answerLabel ? '<b>' + esc(q.answerLabel) + ')</b> ' + x.rich(q.answerText || '') : esc(t('ap.state.SKIP'))) + '</div>' +
      (q.appeal ? '<div class="ex-muted">⚖ ' + esc(t('ap.reason.' + q.appeal.reason)) + (q.appeal.outcome ? ' · ' + esc(t('ap.outcome.' + q.appeal.outcome)) + (q.appeal.newPoints != null ? ' (' + pts(q.appeal.newPoints) + ')' : '') : '') + (q.appeal.comment ? ' — ' + esc(q.appeal.comment) : '') + '</div>' : '') + '</label></div>';

    function draw() {
      let html = header();
      if (S.step === 1) {
        const F = { ALL: () => true, WRONG: (q) => q.state === 'WRONG', PARTIAL: (q) => q.appeal && q.appeal.outcome === 'PARTIALLY_UPHELD', SKIP: (q) => q.state === 'SKIP', DISPUTED: (q) => q.disputed, APPEALED: (q) => q.disputed && q.appeal && q.appeal.outcome };
        html += windowNote() + '<div class="ex-row" style="margin-bottom:8px"><span>❌ ' + counts.WRONG + ' ' + esc(t('ap.state.WRONG')) + '</span><span>○ ' + counts.SKIP + ' ' + esc(t('ap.state.SKIP')) + '</span><span class="ex-muted">' + esc(t('ap.key_hidden')) + '</span></div>' +
          '<div class="ex-tabs" role="tablist">' + Object.keys(F).map((k) => '<button class="ex-tab' + (S.filter === k ? ' on' : '') + '" data-f="' + k + '" role="tab">' + esc(t('ap.f.' + k)) + ' <span class="ex-n">' + d.questions.filter(F[k]).length + '</span></button>').join('') + '</div>' +
          (d.questions.filter(F[S.filter]).map((q) => qLine(q, false)).join('') || x.empty(t('ap.nothing'))) +
          (ap.canAppeal ? '<div class="ex-row" style="justify-content:flex-end;margin-top:12px"><button class="btn btn-primary" id="ap-next">' + esc(t('ap.submit_appeal')) + ' →</button></div>' : '');
      } else if (S.step === 2) {
        html += windowNote() + '<p class="ex-muted">' + esc(t('ap.select_hint')) + '</p>' + d.questions.filter((q) => q.state !== 'CORRECT').map((q) => qLine(q, true)).join('') +
          '<details style="margin-top:8px"><summary class="ex-muted">' + esc(t('ap.show_correct')) + '</summary>' + d.questions.filter((q) => q.state === 'CORRECT').map((q) => qLine(q, true)).join('') + '</details>' +
          '<div class="ex-row" style="justify-content:space-between;margin-top:12px"><button class="btn btn-outline" id="ap-back">← ' + esc(t('common.back')) + '</button><button class="btn btn-primary" id="ap-next"' + (S.sel.size ? '' : ' disabled') + '>' + esc(t('ap.continue')) + ' (' + S.sel.size + ')</button></div>';
      } else if (S.step === 3) {
        html += [...S.sel].sort((a, b) => a - b).map((p) => {
          const q = d.questions.find((z) => z.position === p), it = S.items[p] || (S.items[p] = { reason: '', explanation: '' });
          return '<div class="ex-q"><b>' + esc(t('ap.question')) + ' ' + p + '</b> · ' + pts(q.points) + ' / ' + q.maxPoints + ' · ' + esc(t('ap.state.' + q.state)) +
            '<div class="form-group" style="margin-top:8px"><label class="form-label" for="ap-r' + p + '">' + esc(t('ap.reason_label')) + '</label><select class="input" id="ap-r' + p + '" data-reason="' + p + '"><option value="">—</option>' + ap.reasons.map((r_) => '<option value="' + r_ + '"' + (it.reason === r_ ? ' selected' : '') + '>' + esc(t('ap.reason.' + r_)) + '</option>').join('') + '</select><div class="ex-muted" id="ap-h' + p + '">' + (it.reason ? esc(t('ap.hint.' + it.reason, '')) : '') + '</div></div>' +
            '<div class="form-group"><label class="form-label" for="ap-e' + p + '">' + esc(t('ap.explanation')) + '</label><textarea class="input" id="ap-e' + p + '" data-expl="' + p + '" rows="3" maxlength="2000" placeholder="' + esc(t('ap.expl_ph')) + '">' + esc(it.explanation) + '</textarea><div class="ex-muted"><span id="ap-c' + p + '">' + it.explanation.trim().length + '</span> / 2000 · ' + esc(t('ap.min10')) + '</div><div class="tui-err" role="alert" id="ap-err' + p + '"></div></div></div>';
        }).join('') + '<div class="ex-row" style="justify-content:space-between;margin-top:12px"><button class="btn btn-outline" id="ap-back">← ' + esc(t('common.back')) + '</button><button class="btn btn-primary" id="ap-next">' + esc(t('ap.continue')) + '</button></div>';
      } else if (S.step === 4) {
        const list = [...S.sel].sort((a, b) => a - b);
        html += '<div class="ex-note info">' + esc(t('ap.summary').replace('{n}', list.length)) + ' · ' + esc(t('ap.original')) + ': <b>' + x.num(eff.examScore) + ' / ' + r.examMax + '</b></div>' +
          list.map((p) => { const q = d.questions.find((z) => z.position === p), it = S.items[p]; return '<div class="ex-q"><b>' + esc(t('ap.question')) + ' ' + p + '</b> · ' + pts(q.points) + ' / ' + q.maxPoints + '<div>' + esc(t('ap.reason.' + it.reason)) + '</div><div class="ex-muted" style="white-space:pre-wrap">' + esc(it.explanation) + '</div></div>'; }).join('') +
          '<div class="ex-muted">' + esc(t('ap.after_submit')) + '</div><div class="tui-err" role="alert" id="ap-serr"></div>' +
          '<div class="ex-row" style="justify-content:space-between;margin-top:12px"><button class="btn btn-outline" id="ap-back">← ' + esc(t('common.back')) + '</button><button class="btn btn-primary" id="ap-submit">' + esc(t('ap.submit_appeal')) + '</button></div>';
      }
      box.innerHTML = html;
      bind();
    }

    function bind() {
      box.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => { S.filter = b.dataset.f; draw(); }));
      box.querySelectorAll('[data-sel]').forEach((c) => c.addEventListener('change', () => { const p = Number(c.dataset.sel); c.checked ? S.sel.add(p) : S.sel.delete(p); const n = box.querySelector('#ap-next'); if (n) { n.disabled = !S.sel.size; n.textContent = t('ap.continue') + ' (' + S.sel.size + ')'; } }));
      box.querySelectorAll('[data-reason]').forEach((s) => s.addEventListener('change', () => { const p = s.dataset.reason; S.items[p].reason = s.value; box.querySelector('#ap-h' + p).textContent = s.value ? t('ap.hint.' + s.value, '') : ''; }));
      box.querySelectorAll('[data-expl]').forEach((a) => a.addEventListener('input', () => { const p = a.dataset.expl; S.items[p].explanation = a.value; box.querySelector('#ap-c' + p).textContent = a.value.trim().length; }));
      const back = box.querySelector('#ap-back'); if (back) back.onclick = () => { S.step--; draw(); };
      const next = box.querySelector('#ap-next');
      if (next) next.onclick = () => {
        if (S.step === 3) {
          let ok = true;
          for (const p of S.sel) {
            const it = S.items[p], e = box.querySelector('#ap-err' + p);
            const msg = !it.reason ? t('ap.err_reason') : it.explanation.trim().length < 10 ? t('ap.err_expl') : '';
            e.textContent = msg; if (msg) { ok = false; }
          }
          if (!ok) { const first = box.querySelector('.tui-err:not(:empty)'); if (first) first.previousElementSibling && first.closest('.ex-q').scrollIntoView({ block: 'center' }); return; }
        }
        S.step++; draw();
      };
      const sub = box.querySelector('#ap-submit');
      if (sub) sub.onclick = async () => {
        sub.disabled = true;
        try {
          const res = await src.submit([...S.sel].sort((a, b) => a - b).map((p) => ({ position: p, reason: S.items[p].reason, explanation: S.items[p].explanation.trim() })));
          x.toast(t('ap.submitted').replace('{code}', res.appeal ? res.appeal.code : ''));
          h.close();
          if (opts && opts.onDone) opts.onDone();
        } catch (e) { box.querySelector('#ap-serr').textContent = x.errMsg(e); sub.disabled = false; }
      };
    }
    draw();
  }

  // ───────────────────────── студент: детали апелляции в Requests ─────────────────────────
  async function openRequest(requestId, onChange) {
    const x = X();
    let r;
    try { r = await x.api('/me/requests/' + encodeURIComponent(requestId)); } catch (e) { x.toast(x.errMsg(e), true); return; }
    const a = r.appeal;
    if (!a) return;
    const h = AP.tui.openModal({
      title: t('ap.appeal') + ' #' + a.code, wide: true,
      html: detailHtml(a, false) + (a.canWithdraw ? '<div class="ex-muted" style="margin-top:8px">' + esc(t('ap.withdraw_hint')) + '</div>' : ''),
      buttons: [
        { label: t('common.close'), cls: 'btn-outline' },
        ...(a.canWithdraw ? [{ label: t('ap.withdraw'), cls: 'btn-danger', onClick: async () => {
          if (!(await AP.tui.confirmDialog({ title: t('ap.withdraw'), message: t('ap.withdraw_confirm'), danger: true }))) return false;
          try { await x.api('/me/requests/' + encodeURIComponent(requestId) + '/withdraw', { method: 'POST', body: {} }); x.toast(t('ap.withdrawn')); if (onChange) onChange(); } catch (e) { x.toast(x.errMsg(e), true); return false; }
        } }] : []),
        { label: t('ap.view_review'), cls: 'btn-primary', onClick: () => { openReview(a.resultId); } },
      ],
    });
    void h;
  }

  function detailHtml(a, staff) {
    const x = X();
    const scoreLine = a.revisedExamScore != null ? x.num(a.originalExamScore) + ' → <b>' + x.num(a.revisedExamScore) + '</b>' : '<b>' + x.num(a.originalExamScore) + '</b>';
    return '<div class="ex-row" style="justify-content:space-between;margin-bottom:10px"><div><b style="font-size:16px">' + esc(a.subject ? a.subject.name : '') + '</b><div class="ex-muted">' + esc(a.exam || '') + (staff && a.student ? ' · ' + esc(a.student.fullName) + ' (' + esc(a.student.loginId) + ', ' + esc(a.student.groupName || '') + ')' : '') + '</div></div>' + statusChip(a.status) + '</div>' +
      '<dl class="ex-kv" style="margin-bottom:12px"><dt>' + esc(t('ap.submitted_at')) + '</dt><dd>' + esc(x.fmtDT(a.submittedAt)) + '</dd><dt>' + esc(t('ap.deadline')) + '</dt><dd>' + esc(x.fmtDT(a.deadline)) + '</dd>' +
      '<dt>' + esc(t('ap.score')) + '</dt><dd>' + scoreLine + ' / 50</dd>' + (a.outcome ? '<dt>' + esc(t('ap.decision')) + '</dt><dd>' + statusChip(a.outcome) + '</dd>' : '') + (a.escalated ? '<dt>' + esc(t('ap.escalated')) + '</dt><dd>' + esc(a.escalationReason || '') + '</dd>' : '') + (a.decisionNote ? '<dt>' + esc(t('ap.note')) + '</dt><dd>' + esc(a.decisionNote) + '</dd>' : '') + '</dl>' +
      '<div class="ex-row" style="gap:4px;margin-bottom:12px;flex-wrap:wrap">' + a.timeline.map((s, i) => (i ? '<span class="ex-muted">→</span>' : '') + '<span class="ex-chip ' + (s.step === 'DECISION' ? 'ok' : s.step === 'WITHDRAWN' ? 'bad' : 'info') + '" title="' + esc(x.fmtDT(s.at)) + '">' + esc(t('ap.tl.' + s.step)) + '</span>').join('') + '</div>' +
      a.items.map((i) => '<div class="ex-q"><div class="ex-row" style="justify-content:space-between"><b>' + esc(t('ap.question')) + ' ' + i.position + '</b><span>' + esc(t('ap.awarded')) + ': <b>' + pts(i.awardedPoints) + ' / ' + i.maxPoints + '</b>' + (i.newPoints != null ? ' → <b>' + pts(i.newPoints) + '</b> ' + X().chip(i.outcome === 'REJECTED' ? 'bad' : i.outcome === 'DECREASED' ? 'warn' : 'ok', t('ap.outcome.' + i.outcome)) : '') + '</span></div>' +
        '<div class="ex-rich ex-muted" style="margin:4px 0">' + x.rich(i.questionText) + '</div><div class="ex-muted">' + esc(t('ap.your_answer')) + ': ' + esc(i.answerText || t('ap.state.SKIP')) + (staff && i.correctAnswer ? ' · ' + esc(t('ap.correct_answer')) + ': <b>' + esc(i.correctAnswer) + '</b>' : '') + '</div>' +
        '<div style="margin-top:6px"><b>' + esc(t('ap.reason_label')) + ':</b> ' + esc(t('ap.reason.' + i.reason)) + '</div><div style="white-space:pre-wrap">' + esc(i.explanation) + '</div>' +
        (i.reviewerComment ? '<div class="ex-note" style="margin:6px 0 0">💬 ' + esc(i.reviewerComment) + '</div>' : '') + '</div>').join('');
  }

  /** Dashboard студента: «результат доступен» + Review / Appeal / окно закрыто */
  async function dashboardAlert(el) {
    if (!el) return;
    const x = X();
    let rows;
    try { rows = await x.api('/me/exam-appeals/summary'); } catch { el.innerHTML = ''; return; }
    const recent = rows.filter((r) => Date.now() - new Date(r.publishedAt) < 14 * 86400000);
    el.innerHTML = recent.map((r) => {
      const a = r.appeal;
      const note = a.canAppeal ? '⏳ ' + t('ap.window_open').replace('{d}', x.fmtDT(a.deadline)).replace('{left}', left(a.deadline)) : a.reason === 'APPEAL_NOT_OPEN' ? t('ap.opens_at').replace('{d}', x.fmtDT(a.openAt)) : a.reason === 'APPEAL_CLOSED' ? t('ap.closed') : a.reason === 'APPEAL_ACTIVE' ? t('ap.active') : a.reason === 'APPEAL_ALREADY_DECIDED' ? t('ap.decided') : '';
      return '<div class="ex-note ' + (r.passed ? 'ok' : 'warn') + '" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><div style="flex:1;min-width:220px"><b>' + esc(t('ap.result_available').replace('{s}', r.subject)) + '</b><div class="ex-muted">' + esc(t('ex.kind.' + r.kind)) + ' · ' + x.num(r.examScore) + ' / 50 · ' + esc(t('ex.res.total')) + ' ' + x.num(r.total) + ' (' + esc(r.letter) + ') · ' + esc(note) + '</div></div>' +
        '<button class="btn btn-outline btn-sm" data-rv="' + esc(r.resultId) + '">' + esc(t('ap.review_exam')) + '</button>' + (a.canAppeal ? '<button class="btn btn-primary btn-sm" data-ap="' + esc(r.resultId) + '">' + esc(t('ap.appeal_result')) + '</button>' : '') + '</div>';
    }).join('');
    el.querySelectorAll('[data-rv]').forEach((b) => b.addEventListener('click', () => openReview(b.dataset.rv)));
    el.querySelectorAll('[data-ap]').forEach((b) => b.addEventListener('click', () => openReview(b.dataset.ap, { appeal: true, onDone: () => dashboardAlert(el) })));
  }

  // ───────────────────────── преподаватель / руководство ─────────────────────────
  /** base: 'teacher' | 'admin'. Список апелляций в пределах области доступа + (для руководства) сводка и аналитика */
  async function staffPanel(root, base, opts) {
    const x = X(), F = (staffPanel._f = staffPanel._f || {});
    const path = '/' + base + '/requests/appeals';
    root.innerHTML = x.skel(3);
    try {
      const q = new URLSearchParams(Object.entries(F).filter(([, v]) => v)).toString();
      const [list, an] = await Promise.all([x.api(path + (q ? '?' + q : '')), base === 'admin' ? x.api(path + '/analytics') : Promise.resolve(null)]);
      const sel = (k, label, options) => '<label>' + esc(label) + '<select class="input" data-flt="' + k + '"><option value="">' + esc(t('ex.f.all')) + '</option>' + options.map(([v, l]) => '<option value="' + esc(v) + '"' + (F[k] === v ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></label>';
      let html = '';
      if (an) {
        const T = an.totals, card = (v, l) => '<div class="stat-card"><div class="stat-val">' + v + '</div><div class="stat-label">' + esc(l) + '</div></div>';
        html += '<div class="stat-grid">' + card(T.pending, t('requests.status.pending')) + card(T.underReview, t('requests.status.under_review')) + card(T.approved, t('requests.status.approved')) + card(T.partiallyApproved, t('requests.status.partially_approved')) + card(T.rejected, t('requests.status.rejected')) + card(T.escalated, t('ap.escalated')) + card(an.averageReviewHours == null ? '—' : an.averageReviewHours + ' ' + t('ap.h'), t('ap.avg_review')) + '</div>' +
          '<div class="ex-grid" style="margin:14px 0"><div class="ex-card"><h3>' + esc(t('ap.top_reasons')) + '</h3>' + (an.topReasons.length ? an.topReasons.map((r) => '<div class="ex-row" style="justify-content:space-between"><span>' + esc(t('ap.reason.' + r.reason)) + '</span><b>' + r.count + '</b></div>').join('') : x.empty(t('ex.res.none'))) + '</div>' +
          '<div class="ex-card"><h3>' + esc(t('ap.top_questions')) + '</h3>' + (an.topQuestions.length ? an.topQuestions.map((q) => '<div class="ex-row" style="justify-content:space-between;gap:10px"><span class="ex-muted" style="flex:1">' + esc(q.text) + '</span><b>' + q.count + '</b></div>').join('') : x.empty(t('ex.res.none'))) + '</div></div>';
      }
      html += '<div class="ex-toolbar">' + sel('status', t('ex.col.status'), ['PENDING', 'UNDER_REVIEW', 'APPROVED', 'PARTIALLY_APPROVED', 'REJECTED', 'WITHDRAWN'].map((s) => [s, t('requests.status.' + s.toLowerCase())])) +
        sel('escalated', t('ap.queue'), [['true', t('ap.escalated_queue')]]) +
        '<label>' + esc(t('ap.student_f')) + '<input class="input" data-flt="student" value="' + esc(F.student || '') + '"></label><label>' + esc(t('ex.f.from')) + '<input class="input" type="date" data-flt="from" value="' + esc(F.from || '') + '"></label><label>' + esc(t('ex.f.to')) + '<input class="input" type="date" data-flt="to" value="' + esc(F.to || '') + '"></label></div>';
      html += list.length ? '<div class="card"><div class="card-pad ex-scroll"><table class="ex-table"><thead><tr><th>#</th><th>' + esc(t('ex.col.student')) + '</th><th>' + esc(t('ex.col.subject')) + '</th><th>' + esc(t('ap.disputed')) + '</th><th>' + esc(t('ex.col.status')) + '</th><th>' + esc(t('ap.submitted_at')) + '</th><th>' + esc(t('ap.deadline')) + '</th><th></th></tr></thead><tbody>' +
        list.map((a) => '<tr><td><code>' + esc(a.code) + '</code>' + (a.escalated ? ' ' + x.chip('warn', '⇧') : '') + '</td><td>' + esc(a.student.fullName) + '<div class="ex-muted">' + esc(a.student.loginId) + ' · ' + esc(a.student.groupName || '') + '</div></td><td>' + esc(a.subject ? a.subject.name : '') + '<div class="ex-muted">' + esc(a.exam || '') + '</div></td><td>' + esc(a.disputed.join(', ')) + '</td><td>' + statusChip(a.status) + '</td><td>' + esc(x.fmtDate(a.submittedAt)) + '</td><td>' + esc(x.fmtDate(a.deadline)) + '</td><td><button class="btn btn-outline btn-sm" data-open="' + esc(a.requestId) + '">' + esc(t('ex.t.open')) + '</button></td></tr>').join('') + '</tbody></table></div></div>' : x.empty(t('ap.none'));
      root.innerHTML = html;
      root.querySelectorAll('[data-flt]').forEach((el) => el.addEventListener('change', () => { F[el.dataset.flt] = el.value; staffPanel(root, base, opts); }));
      root.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => staffDetail(base, b.dataset.open, () => staffPanel(root, base, opts))));
    } catch (e) { root.innerHTML = x.errBox(e); }
  }

  /** Рассмотрение: по каждому вопросу — оставить / повысить / понизить (в пределах вопроса) + комментарий; эскалация; итоговое решение */
  async function staffDetail(base, requestId, onChange) {
    const x = X(), path = '/' + base + '/requests/appeals/' + encodeURIComponent(requestId);
    let a;
    try { a = await x.api(path); } catch (e) { x.toast(x.errMsg(e), true); return; }
    const active = a.status === 'PENDING' || a.status === 'UNDER_REVIEW';
    const can = a.permissions.canDecide && active;
    const editor = (i) => {
      const opts = []; for (let v = i.minPoints; v <= i.maxPoints; v++) opts.push(v);
      return '<div class="ex-row" style="margin-top:8px;align-items:flex-end"><label>' + esc(t('ap.new_points')) + '<select class="input" data-np="' + esc(i.id) + '">' + opts.map((v) => '<option value="' + v + '"' + ((i.newPoints ?? i.awardedPoints) === v ? ' selected' : '') + '>' + pts(v) + (v === i.awardedPoints ? ' · ' + t('ap.keep') : v > i.awardedPoints ? ' · ' + t('ap.increase') : ' · ' + t('ap.decrease')) + '</option>').join('') + '</select></label>' +
        '<label style="flex:1">' + esc(t('ap.reviewer_comment')) + '<input class="input" data-cm="' + esc(i.id) + '" maxlength="1000" value="' + esc(i.reviewerComment || '') + '"></label><button class="btn btn-primary btn-sm" data-save="' + esc(i.id) + '">' + esc(t('common.save')) + '</button></div>';
    };
    const html = () => detailHtml(a, true);
    const h = AP.tui.openModal({
      title: t('ap.appeal') + ' #' + a.code, wide: true, static: true, onClose: () => { if (onChange) onChange(); },
      html: '<div id="apx"></div>',
      buttons: [
        { label: t('common.close'), cls: 'btn-outline' },
        ...(a.status === 'PENDING' && a.permissions.canReview ? [{ label: t('ap.start_review'), cls: 'btn-outline', keep: true, onClick: async () => { try { a = await x.api(path + '/start', { method: 'POST', body: {} }); render(); } catch (e) { x.toast(x.errMsg(e), true); } return false; } }] : []),
        ...(active && !a.escalated && a.permissions.canReview ? [{ label: t('ap.escalate'), cls: 'btn-outline', keep: true, onClick: () => { escalate(); return false; } }] : []),
        ...(can ? [{ label: t('ap.finalize'), cls: 'btn-primary', keep: true, onClick: async () => { finalize(); return false; } }] : []),
      ],
    });
    function render() {
      const box = h.$('#apx');
      // руководство до эскалации — только просмотр: решает преподаватель предмета
      const note = !active ? '' : a.escalated && !a.permissions.canDecide ? t('ap.escalated_wait') : !a.escalated && !a.permissions.canReview ? t('ap.teacher_decides') : '';
      box.innerHTML = (note ? '<div class="ex-note warn">' + esc(note) + '</div>' : '') + html();
      if (can) {
        const qs = box.querySelectorAll('.ex-q');
        a.items.forEach((i, k) => { if (qs[k]) qs[k].insertAdjacentHTML('beforeend', editor(i)); });
        box.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', async () => {
          const id = b.dataset.save, np = Number(box.querySelector('[data-np="' + id + '"]').value), cm = box.querySelector('[data-cm="' + id + '"]').value.trim();
          if (cm.length < 3) { x.toast(t('ap.comment_req'), true); return; }
          try { a = await x.api(path + '/items/' + encodeURIComponent(id), { method: 'PUT', body: { newPoints: np, comment: cm } }); x.toast(t('ap.saved')); render(); } catch (e) { x.toast(x.errMsg(e), true); }
        }));
      }
    }
    function escalate() {
      const e = AP.tui.openModal({ title: t('ap.escalate'), html: '<label class="form-label" for="apx-er">' + esc(t('ap.escalate_reason')) + '</label><textarea class="input" id="apx-er" rows="3" maxlength="1000"></textarea>', buttons: [{ label: t('common.cancel'), cls: 'btn-outline' }, { label: t('ap.escalate'), cls: 'btn-primary', onClick: async () => { const reason = e.$('#apx-er').value.trim(); if (reason.length < 5) { x.toast(t('ap.reason_req'), true); return false; } try { a = await x.api(path + '/escalate', { method: 'POST', body: { reason } }); x.toast(t('ap.escalated_ok')); h.close(); } catch (err) { x.toast(x.errMsg(err), true); return false; } } }] });
    }
    function finalize() {
      const pending = a.items.filter((i) => i.newPoints == null);
      if (pending.length) { x.toast(t('ap.items_pending').replace('{q}', pending.map((i) => 'Q' + i.position).join(', ')), true); return; }
      const delta = a.items.reduce((s, i) => s + (i.newPoints - i.awardedPoints), 0);
      const revised = Math.max(-25, Math.min(50, a.originalExamScore + delta));
      const outcome = !a.items.some((i) => i.newPoints > i.awardedPoints) ? 'REJECTED' : a.items.every((i) => i.outcome === 'UPHELD') ? 'APPROVED' : 'PARTIALLY_APPROVED';
      const f = AP.tui.openModal({
        title: t('ap.final_decision'),
        html: '<dl class="ex-kv" style="font-size:14px;row-gap:6px"><dt>' + esc(t('ap.original')) + '</dt><dd>' + x.num(a.originalExamScore) + ' / 50</dd><dt>' + esc(t('ap.revised')) + '</dt><dd>' + x.num(revised) + ' / 50</dd><dt>' + esc(t('ap.decision')) + '</dt><dd>' + statusChip(outcome) + '</dd></dl>' +
          '<div class="ex-muted" style="margin:8px 0">' + a.items.map((i) => 'Q' + i.position + ': ' + pts(i.awardedPoints) + ' → ' + pts(i.newPoints)).join(' · ') + '</div><div class="ex-note info">' + esc(t('ap.final_hint')) + '</div><label class="form-label" for="apx-note">' + esc(t('ap.note')) + '</label><textarea class="input" id="apx-note" rows="2" maxlength="1000"></textarea>',
        buttons: [{ label: t('common.cancel'), cls: 'btn-outline' }, { label: t('ap.confirm_decision'), cls: 'btn-primary', onClick: async () => { try { a = await x.api(path + '/decide', { method: 'POST', body: { note: f.$('#apx-note').value.trim() || undefined } }); x.toast(t('ap.decided_ok')); h.close(); } catch (e) { x.toast(x.errMsg(e), true); return false; } } }],
      });
    }
    render();
  }

  AP.appeals = { openReview, openRequest, dashboardAlert, staffPanel, staffDetail };
})(window);
