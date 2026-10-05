// ============================================================
// Management → Экзамены: окна и экзамены, проверка вопросов, рабочие места и проктора, бумажные экзамены,
// resit и платежи, retake/предложения/летние курсы, результаты, аналитика, аудит. Все правила проверяет backend.
// ============================================================
(function (global) {
  'use strict';
  const AP = global.AP;
  const X = () => AP.ex, t = (k, fb) => AP.i18n.t(k, fb), esc = (s) => AP.ex.esc(s);
  const $ = (id) => document.getElementById(id);

  function create(shell) {
    const toast = shell.toast;
    const err = (e) => toast(X().errMsg(e), true);
    const cache = {};
    const org = async () => cache.org || (cache.org = await X().api('/admin/org'));
    const subjects = async () => cache.subjects || (cache.subjects = await X().api('/admin/subjects'));
    const rooms = async () => cache.rooms || (cache.rooms = await X().api('/admin/rooms'));
    const sel = (id, label, opts, val, attrs) => '<label>' + esc(label) + '<select class="input" id="' + id + '"' + (attrs || '') + '>' + opts.map(([v, l]) => '<option value="' + esc(v) + '"' + (String(v) === String(val) ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></label>';
    const inp = (id, label, val, type, attrs) => '<label>' + esc(label) + '<input class="input" id="' + id + '" type="' + (type || 'text') + '" value="' + esc(val == null ? '' : val) + '"' + (attrs || '') + '></label>';
    const winChip = (s) => X().chip(s === 'PUBLISHED' ? 'ok' : s === 'DRAFT' ? 'info' : s === 'CANCELLED' ? 'bad' : '', X().statusText('W_' + s));
    const load = async (rootId, fn) => {
      const root = $(rootId); root.innerHTML = X().skel(3);
      try { await fn(root); } catch (e) { root.innerHTML = X().errBox(e, rootId + '-r'); const b = $(rootId + '-r'); if (b) b.onclick = () => load(rootId, fn); }
    };

    // ───────────────────────── Окна и экзамены ─────────────────────────
    let openWin = null;
    async function windows() {
      if (openWin) return windowDetail(openWin);
      return load('ex-windows', async (root) => {
        const x = X(), list = await x.api('/admin/exam-windows');
        root.innerHTML = '<div class="ex-toolbar"><button class="btn btn-primary" id="exw-new">+ ' + esc(t('ex.w.new')) + '</button></div>' +
          (list.length ? '<div class="card"><div class="card-pad ex-scroll"><table class="ex-table"><thead><tr><th>' + esc(t('ex.w.title')) + '</th><th>' + esc(t('ex.col.type')) + '</th><th>' + esc(t('ex.w.cycle')) + '</th><th>' + esc(t('ex.s.dates')) + '</th><th>' + esc(t('ex.s.days')) + '</th><th>' + esc(t('ex.s.time')) + '</th><th>' + esc(t('ex.col.status')) + '</th><th></th></tr></thead><tbody>' +
            list.map((w) => '<tr><td><b>' + esc(w.title) + '</b><div class="ex-muted">v' + w.version + ' · ' + w.examCount + ' ' + esc(t('ex.w.exams_n')) + '</div></td><td>' + x.chip(w.kind === 'RESIT' ? 'warn' : 'info', t('ex.kind.' + w.kind)) + '</td><td>' + esc(w.academicYear.replace('-', '/') + ' · ' + t('ex.term.' + w.term)) + '</td><td>' + esc(x.fmtDate(w.startDate)) + ' – ' + esc(x.fmtDate(w.endDate)) + '</td><td>' + x.days(w.allowedWeekdays) + '</td><td>' + esc(w.startTime) + '–' + esc(w.endTime) + '</td><td>' + winChip(w.status) + '</td><td><button class="btn btn-outline btn-sm" data-open="' + esc(w.id) + '">' + esc(t('ex.t.open')) + '</button></td></tr>').join('') + '</tbody></table></div></div>' : x.empty(t('ex.w.none')));
        $('exw-new').onclick = () => windowModal(null, list);
        root.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => { openWin = b.dataset.open; windowDetail(openWin); }));
      });
    }

    async function windowModal(w, list) {
      const x = X(), o = await org();
      const groups = o.faculties.flatMap((f) => f.departments.flatMap((d) => d.specialties.flatMap((s) => s.groups.map((g) => g.name))));
      const sc = w ? w.scopes : [];
      const finals = (list || []).filter((z) => z.kind === 'FINAL');
      const today = new Date().toISOString().slice(0, 10);
      const h = AP.tui.openModal({
        title: w ? t('ex.w.edit') : t('ex.w.new'), wide: true, static: true,
        html: '<div class="form-grid">' + inp('exw-title', t('ex.w.title'), w ? w.title : '', 'text', ' maxlength="120"') +
          sel('exw-kind', t('ex.col.type'), [['FINAL', t('ex.kind.FINAL')], ['RESIT', t('ex.kind.RESIT')]], w ? w.kind : 'FINAL', w ? ' disabled' : '') +
          inp('exw-year', t('ex.w.year'), w ? w.academicYear : '2026-2027', 'text', ' placeholder="2026-2027"') + sel('exw-term', t('ex.w.term'), [['FALL', t('ex.term.FALL')], ['SPRING', t('ex.term.SPRING')], ['SUMMER', t('ex.term.SUMMER')]], w ? w.term : 'FALL') +
          inp('exw-start', t('ex.w.start'), w ? w.startDate : today, 'date') + inp('exw-end', t('ex.w.end'), w ? w.endDate : '', 'date') +
          inp('exw-tstart', t('ex.w.tstart'), w ? w.startTime : '10:00', 'time') + inp('exw-tend', t('ex.w.tend'), w ? w.endTime : '12:00', 'time') +
          inp('exw-max', t('ex.w.max_week'), w ? w.maxPerWeek : 3, 'number', ' min="1" max="7"') +
          inp('exw-deadline', t('ex.w.deadline'), w ? new Date(w.questionDeadline).toISOString().slice(0, 16) : '', 'datetime-local') +
          '<div id="exw-fin-wrap" style="display:none">' + sel('exw-final', t('ex.w.final_window'), finals.map((f) => [f.id, f.title]), w ? w.finalWindowId : '') + '</div></div>' +
          '<div class="form-label" style="margin-top:10px">' + esc(t('ex.s.days')) + '</div><div class="ex-row">' + [1, 2, 3, 4, 5, 6, 7].map((d) => '<label class="tt-chk"><input type="checkbox" data-wd="' + d + '"' + ((w ? w.allowedWeekdays : [1, 3, 5]).includes(d) ? ' checked' : '') + '> ' + esc(x.dayName(d)) + '</label>').join('') + '</div>' +
          '<div class="form-grid" style="margin-top:10px">' +
          '<label>' + esc(t('ex.w.faculties')) + '<select class="input" id="exw-fac" multiple size="4">' + o.faculties.map((f) => '<option value="' + esc(f.id) + '"' + (sc.some((s) => s.facultyId === f.id) ? ' selected' : '') + '>' + esc(f.name) + '</option>').join('') + '</select></label>' +
          '<label>' + esc(t('ex.w.groups')) + '<select class="input" id="exw-grp" multiple size="4">' + groups.map((g) => '<option' + (sc.some((s) => s.groupName === g) ? ' selected' : '') + '>' + esc(g) + '</option>').join('') + '</select></label></div><div class="ex-muted">' + esc(t('ex.w.scope_hint')) + '</div>',
        buttons: [
          { label: t('common.cancel'), cls: 'btn-outline' },
          { label: t('common.save'), cls: 'btn-primary', onClick: async () => {
            const sel_ = (id) => Array.from(h.$('#' + id).selectedOptions).map((o_) => o_.value);
            const dto = {
              title: h.$('#exw-title').value.trim(), kind: h.$('#exw-kind').value, academicYear: h.$('#exw-year').value.trim(), term: h.$('#exw-term').value, startDate: h.$('#exw-start').value, endDate: h.$('#exw-end').value,
              allowedWeekdays: Array.from(h.el.querySelectorAll('[data-wd]:checked')).map((c) => Number(c.dataset.wd)), startTime: h.$('#exw-tstart').value, endTime: h.$('#exw-tend').value, maxPerWeek: Number(h.$('#exw-max').value),
              scopes: [...sel_('exw-fac').map((facultyId) => ({ facultyId })), ...sel_('exw-grp').map((groupName) => ({ groupName }))],
            };
            const dl = h.$('#exw-deadline').value; if (dl) dto.questionDeadline = new Date(dl).toISOString();
            if (dto.kind === 'RESIT') dto.finalWindowId = h.$('#exw-final').value;
            try {
              if (w) { delete dto.kind; await x.api('/admin/exam-windows/' + w.id, { method: 'PUT', body: dto }); } else await x.api('/admin/exam-windows', { method: 'POST', body: dto });
              toast(t('ex.w.saved')); if (w) windowDetail(w.id); else windows();
            } catch (e) { err(e); return false; }
          } },
        ],
      });
      const fin = () => { h.$('#exw-fin-wrap').style.display = h.$('#exw-kind').value === 'RESIT' ? '' : 'none'; };
      h.$('#exw-kind').addEventListener('change', fin); fin();
    }

    async function windowDetail(id) {
      return load('ex-windows', async (root) => {
        const x = X(), w = await x.api('/admin/exam-windows/' + id);
        const edit = w.status === 'DRAFT' || w.status === 'PUBLISHED';
        root.innerHTML = '<div class="ex-row" style="margin-bottom:12px"><button class="btn btn-outline btn-sm" id="exw-back">← ' + esc(t('common.back')) + '</button><h3 style="margin:0">' + esc(w.title) + '</h3>' + winChip(w.status) + x.chip(w.kind === 'RESIT' ? 'warn' : 'info', t('ex.kind.' + w.kind)) + '<span class="ex-muted">v' + w.version + '</span></div>' +
          '<div class="card" style="margin-bottom:14px"><div class="card-pad"><dl class="ex-kv"><dt>' + esc(t('ex.w.cycle')) + '</dt><dd>' + esc(w.academicYear.replace('-', '/') + ' · ' + t('ex.term.' + w.term)) + '</dd><dt>' + esc(t('ex.s.dates')) + '</dt><dd>' + esc(x.fmtDate(w.startDate)) + ' – ' + esc(x.fmtDate(w.endDate)) + '</dd><dt>' + esc(t('ex.s.days')) + '</dt><dd>' + x.days(w.allowedWeekdays) + '</dd><dt>' + esc(t('ex.s.time')) + '</dt><dd>' + esc(w.startTime) + ' – ' + esc(w.endTime) + '</dd><dt>' + esc(t('ex.w.max_week')) + '</dt><dd>' + w.maxPerWeek + '</dd><dt>' + esc(t('ex.w.deadline')) + '</dt><dd>' + esc(x.fmtDT(w.questionDeadline)) + '</dd><dt>' + esc(t('ex.w.scope')) + '</dt><dd>' + (w.scopes.length ? w.scopes.length + ' ' + esc(t('ex.w.scope_n')) : esc(t('ex.w.scope_all'))) + '</dd></dl>' +
          '<div class="ex-row" style="margin-top:12px">' + (edit ? '<button class="btn btn-outline btn-sm" id="exw-edit">' + esc(t('common.edit')) + '</button>' : '') + (w.status === 'DRAFT' ? '<button class="btn btn-primary btn-sm" id="exw-pub">' + esc(t('ex.w.publish')) + '</button>' : '') +
          (w.kind === 'FINAL' && w.status !== 'CANCELLED' ? '<button class="btn btn-outline btn-sm" id="exw-resit">' + esc(t('ex.w.make_resit')) + '</button>' : '') + (w.kind === 'FINAL' && w.status === 'PUBLISHED' ? '<button class="btn btn-outline btn-sm" id="exw-sync">' + esc(t('ex.w.sync')) + '</button>' : '') +
          (w.status === 'PUBLISHED' ? '<button class="btn btn-danger btn-sm" id="exw-close">' + esc(t('ex.w.close')) + '</button>' : '') + (w.status === 'DRAFT' || w.status === 'PUBLISHED' ? '<button class="btn btn-outline btn-sm" id="exw-cancel">' + esc(t('ex.w.cancel')) + '</button>' : '') + '</div></div></div>' +
          '<div class="ex-row" style="justify-content:space-between;margin-bottom:8px"><h3 style="margin:0">' + esc(t('ex.w.exams')) + '</h3>' + (edit ? '<button class="btn btn-primary btn-sm" id="exw-addex">+ ' + esc(t('ex.w.add_exam')) + '</button>' : '') + '</div>' +
          (w.exams.length ? '<div class="card"><div class="card-pad ex-scroll"><table class="ex-table"><thead><tr><th>' + esc(t('ex.col.subject')) + '</th><th>' + esc(t('ex.w.delivery')) + '</th><th>' + esc(t('ex.w.bank')) + '</th><th>' + esc(t('ex.w.attempts')) + '</th><th></th></tr></thead><tbody>' +
            w.exams.map((e) => '<tr><td><b>' + esc(e.subject.name) + '</b><div class="ex-muted">' + esc(e.subject.code) + ' · ' + e.subject.credits + ' ' + esc(t('ex.rs.credits').toLowerCase()) + '</div></td><td>' + x.chip('', t('ex.delivery.' + e.delivery)) + '</td><td>' + x.chip(e.bank.ready ? 'ok' : e.bank.status === 'NONE' ? 'bad' : 'warn', x.statusText(e.bank.status === 'NONE' ? 'NOT_STARTED' : e.bank.status)) + (e.bank.version ? ' <span class="ex-muted">v' + e.bank.version + ' · ' + e.bank.questions + ' ' + esc(t('ex.s.questions')) + '</span>' : '') + (e.overdue ? ' ' + x.chip('bad', t('ex.st.OVERDUE')) : '') + '</td><td>' + (e.attempts + e.sheets) + '</td><td style="text-align:right">' + (e.attempts + e.sheets === 0 && edit ? '<button class="btn btn-outline btn-sm" data-rm="' + esc(e.id) + '">🗑</button>' : '') + '</td></tr>').join('') + '</tbody></table></div></div>' : x.empty(t('ex.w.no_exams')));
        $('exw-back').onclick = () => { openWin = null; windows(); };
        const act = (btn, fn) => { const b = $(btn); if (b) b.onclick = async () => { try { await fn(); } catch (e) { err(e); } }; };
        act('exw-edit', () => windowModal(w, null));
        act('exw-pub', async () => { await x.api('/admin/exam-windows/' + id + '/publish', { method: 'POST', body: {} }); toast(t('ex.w.published')); windowDetail(id); });
        act('exw-sync', async () => { const r = await x.api('/admin/exam-windows/' + id + '/sync-enrollments', { method: 'POST', body: {} }); toast(t('ex.w.synced').replace('{n}', r.created)); });
        act('exw-resit', async () => { const r = await x.api('/admin/exam-windows/' + id + '/resit-window', { method: 'POST', body: {} }); toast(t('ex.w.resit_created').replace('{d}', x.fmtDate(r.startDate))); openWin = r.id; windowDetail(r.id); });
        act('exw-close', async () => { if (await AP.tui.confirmDialog({ title: t('ex.w.close'), message: t('ex.w.close_text'), danger: true })) { const r = await x.api('/admin/exam-windows/' + id + '/close', { method: 'POST', body: {} }); toast(t('ex.w.closed').replace('{a}', r.absent || 0).replace('{f}', r.forfeited || 0)); windowDetail(id); } });
        act('exw-cancel', async () => { if (await AP.tui.confirmDialog({ title: t('ex.w.cancel'), message: t('ex.w.cancel_text'), danger: true })) { await x.api('/admin/exam-windows/' + id + '/cancel', { method: 'POST', body: {} }); windowDetail(id); } });
        act('exw-addex', async () => {
          const subs = await subjects();
          const h = AP.tui.openModal({ title: t('ex.w.add_exam'), html: '<div class="form-grid">' + sel('exa-sub', t('ex.col.subject'), subs.map((s) => [s.id, s.code + ' · ' + s.name]), '') + sel('exa-del', t('ex.w.delivery'), [['COMPUTER', t('ex.delivery.COMPUTER')], ['PAPER', t('ex.delivery.PAPER')]], 'COMPUTER') + '</div>',
            buttons: [{ label: t('common.cancel'), cls: 'btn-outline' }, { label: t('common.save'), cls: 'btn-primary', onClick: async () => { try { await x.api('/admin/exam-windows/' + id + '/exams', { method: 'POST', body: { subjectId: h.$('#exa-sub').value, delivery: h.$('#exa-del').value } }); windowDetail(id); } catch (e) { err(e); return false; } } }] });
        });
        root.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', async () => { try { await x.api('/admin/exams/' + b.dataset.rm, { method: 'DELETE' }); windowDetail(id); } catch (e) { err(e); } }));
      });
    }

    // ───────────────────────── Проверка вопросов ─────────────────────────
    let reviewFilter = '';
    async function review() {
      return load('ex-review', async (root) => {
        const x = X(), list = await x.api('/admin/question-reviews' + (reviewFilter ? '?status=' + reviewFilter : ''));
        root.innerHTML = '<div class="ex-toolbar">' + sel('exr-st', t('ex.col.status'), [['', t('ex.f.all')], ['SUBMITTED', x.statusText('SUBMITTED')], ['UNDER_REVIEW', x.statusText('UNDER_REVIEW')], ['REJECTED', x.statusText('REJECTED')], ['APPROVED', x.statusText('APPROVED')]], reviewFilter) + '</div>' +
          (list.length ? '<div class="card"><div class="card-pad ex-scroll"><table class="ex-table"><thead><tr><th>' + esc(t('ex.col.subject')) + '</th><th>' + esc(t('ex.t.version')) + '</th><th>' + esc(t('ex.rv.author')) + '</th><th>' + esc(t('ex.s.questions')) + '</th><th>' + esc(t('ex.col.status')) + '</th><th>' + esc(t('ex.rv.submitted')) + '</th><th></th></tr></thead><tbody>' +
            list.map((v) => '<tr><td><b>' + esc(v.subject.name) + '</b></td><td>v' + v.version + '</td><td>' + esc(v.author) + '</td><td>' + v.questions + '</td><td>' + x.chip(v.status === 'APPROVED' ? 'ok' : v.status === 'REJECTED' ? 'bad' : 'warn', x.statusText(v.status)) + (v.rejectionReason ? '<div class="ex-muted">' + esc(v.rejectionReason) + '</div>' : '') + '</td><td>' + esc(v.submittedAt ? x.fmtDT(v.submittedAt) : '—') + '</td><td><button class="btn btn-outline btn-sm" data-rv="' + esc(v.id) + '">' + esc(t('ex.t.open')) + '</button></td></tr>').join('') + '</tbody></table></div></div>' : x.empty(t('ex.rv.none')));
        $('exr-st').onchange = (e) => { reviewFilter = e.target.value; review(); };
        root.querySelectorAll('[data-rv]').forEach((b) => b.addEventListener('click', () => reviewModal(b.dataset.rv)));
      });
    }

    async function reviewModal(id) {
      const x = X();
      let v;
      try { v = await x.api('/admin/question-reviews/' + id); } catch (e) { err(e); return; }
      const h = AP.tui.openModal({
        title: v.subject.name + ' · v' + v.version, wide: true,
        html: '<div class="ex-row" style="margin-bottom:10px">' + x.chip(v.status === 'APPROVED' ? 'ok' : v.status === 'REJECTED' ? 'bad' : 'warn', x.statusText(v.status)) + '<span class="ex-muted">' + esc(t('ex.rv.author')) + ': ' + esc(v.author) + (v.reviewer ? ' · ' + esc(t('ex.rv.reviewer')) + ': ' + esc(v.reviewer) : '') + '</span></div>' +
          (v.rejectionReason ? '<div class="ex-note bad">' + esc(v.rejectionReason) + '</div>' : '') +
          v.questions.map((q) => '<div class="ex-q"><b>#' + q.ordinal + '</b> <span class="ex-rich">' + x.rich(q.body) + '</span>' + (q.image ? '<br><img class="ex-img" alt="" src="' + esc(q.image) + '">' : '') + q.options.map((o) => '<div class="ex-ans' + (o.label === q.correct ? ' ok' : '') + '"><b>' + o.label + ')</b> <span class="ex-rich">' + x.rich(o.body) + '</span>' + (o.label === q.correct ? ' ✓' : '') + '</div>').join('') + '</div>').join(''),
        buttons: [
          { label: t('common.close'), cls: 'btn-outline' },
          { id: 'claim', label: t('ex.rv.start'), cls: 'btn-primary', hidden: v.status !== 'SUBMITTED', keep: true, onClick: async (hh) => { try { await x.api('/admin/question-reviews/' + id + '/claim', { method: 'POST', body: {} }); hh.close(); reviewModal(id); review(); } catch (e) { err(e); } return false; } },
          { id: 'rej', label: t('ex.rv.reject'), cls: 'btn-danger', hidden: v.status !== 'UNDER_REVIEW', keep: true, onClick: () => { rejectModal(id); return false; } },
          { id: 'ok', label: t('ex.rv.approve'), cls: 'btn-primary', hidden: v.status !== 'UNDER_REVIEW', keep: true, onClick: async (hh) => { try { await x.api('/admin/question-reviews/' + id + '/approve', { method: 'POST', body: {} }); toast(t('ex.rv.approved')); hh.close(); review(); } catch (e) { err(e); } return false; } },
        ],
      });
      void h;
    }
    function rejectModal(id) {
      const x = X();
      const h = AP.tui.openModal({ title: t('ex.rv.reject'), html: '<div class="form-label">' + esc(t('ex.rv.reason')) + '</div><textarea class="input" id="exr-reason" rows="4" maxlength="2000" placeholder="' + esc(t('ex.rv.reason_ph')) + '"></textarea>',
        buttons: [{ label: t('common.cancel'), cls: 'btn-outline' }, { label: t('ex.rv.reject'), cls: 'btn-danger', onClick: async () => { const reason = h.$('#exr-reason').value.trim(); if (reason.length < 5) { toast(t('ex.rv.reason_req'), true); return false; } try { await x.api('/admin/question-reviews/' + id + '/reject', { method: 'POST', body: { reason } }); toast(t('ex.rv.rejected')); document.querySelectorAll('.modal-overlay').forEach((m) => m.remove()); review(); } catch (e) { err(e); return false; } } }] });
    }

    // ───────────────────────── Рабочие места и проктора ─────────────────────────
    async function workstations() {
      return load('ex-workstations', async (root) => {
        const x = X();
        const [ws, pr, rm] = await Promise.all([x.api('/admin/exam-workstations'), x.api('/admin/exam-proctors'), rooms()]);
        const stCls = { AVAILABLE: 'ok', WAITING: 'warn', IN_EXAM: 'info' };
        root.innerHTML = '<div class="ex-note info">' + esc(t('ex.ws.hint')) + '</div><div class="ex-row" style="justify-content:space-between;margin-bottom:8px"><h3 style="margin:0">' + esc(t('ex.ws.pcs')) + ' (' + ws.length + ')</h3><button class="btn btn-primary btn-sm" id="exs-bulk">+ ' + esc(t('ex.ws.bulk')) + '</button></div>' +
          (ws.length ? '<div class="card"><div class="card-pad ex-scroll"><table class="ex-table"><thead><tr><th>' + esc(t('ex.ws.room')) + '</th><th>PC</th><th>' + esc(t('ex.col.status')) + '</th><th>' + esc(t('ex.ws.online')) + '</th><th>' + esc(t('ex.ws.key')) + '</th><th>' + esc(t('ex.ws.last_ip')) + '</th><th></th></tr></thead><tbody>' +
            ws.map((w) => '<tr><td>' + esc(w.room.code) + '<div class="ex-muted">' + esc(w.room.building || '') + '</div></td><td><b>' + esc(w.code) + '</b></td><td>' + (w.isActive ? x.chip(stCls[w.state] || '', x.statusText('PC_' + w.state)) : x.chip('bad', x.statusText('PC_DISABLED'))) + '</td><td>' + (w.online ? x.chip('ok', 'online') : x.chip('', 'offline')) + '</td><td>' + (w.hasKey ? '🔑' : '—') + '</td><td>' + esc(w.lastSeenIp || '—') + '</td><td style="text-align:right"><button class="btn btn-outline btn-sm" data-key="' + esc(w.id) + '">' + esc(t('ex.ws.new_key')) + '</button> <button class="btn btn-outline btn-sm" data-act="' + esc(w.id) + '" data-on="' + (w.isActive ? '0' : '1') + '">' + esc(t(w.isActive ? 'ex.ws.disable' : 'ex.ws.enable')) + '</button></td></tr>').join('') + '</tbody></table></div></div>' : x.empty(t('ex.ws.none'))) +
          '<div class="ex-row" style="justify-content:space-between;margin:22px 0 8px"><h3 style="margin:0">' + esc(t('ex.pr.title')) + '</h3><button class="btn btn-primary btn-sm" id="exs-newproc">+ ' + esc(t('ex.pr.new')) + '</button></div>' +
          (pr.length ? '<div class="card"><div class="card-pad ex-scroll"><table class="ex-table"><thead><tr><th>' + esc(t('ex.pr.name')) + '</th><th>Login ID</th><th>' + esc(t('ex.ws.room')) + '</th><th></th></tr></thead><tbody>' + pr.map((p) => '<tr><td>' + esc(p.fullName) + '</td><td><code>' + esc(p.loginId) + '</code></td><td>' + (p.rooms.map((r) => x.chip('', r.code)).join(' ') || '<span class="ex-muted">—</span>') + '</td><td style="text-align:right"><button class="btn btn-outline btn-sm" data-rooms="' + esc(p.id) + '">' + esc(t('ex.pr.assign')) + '</button></td></tr>').join('') + '</tbody></table></div></div>' : x.empty(t('ex.pr.none')));
        $('exs-bulk').onclick = () => {
          const h = AP.tui.openModal({ title: t('ex.ws.bulk'), html: '<div class="form-grid">' + sel('exb-room', t('ex.ws.room'), rm.map((r) => [r.id, r.code + ' · ' + (r.name || '')]), '') + inp('exb-prefix', t('ex.ws.prefix'), 'PC-') + inp('exb-count', t('ex.ws.count'), 30, 'number', ' min="1" max="100"') + inp('exb-cidr', t('ex.ws.cidr'), '', 'text', ' placeholder="10.20.0.0/24"') + '</div>',
            buttons: [{ label: t('common.cancel'), cls: 'btn-outline' }, { label: t('common.save'), cls: 'btn-primary', onClick: async () => { try { const r = await x.api('/admin/exam-workstations/bulk', { method: 'POST', body: { roomId: h.$('#exb-room').value, prefix: h.$('#exb-prefix').value, count: Number(h.$('#exb-count').value), allowedCidr: h.$('#exb-cidr').value.trim() || null } }); toast(t('ex.ws.created').replace('{n}', r.created)); workstations(); } catch (e) { err(e); return false; } } }] });
        };
        root.querySelectorAll('[data-key]').forEach((b) => b.addEventListener('click', async () => {
          if (!(await AP.tui.confirmDialog({ title: t('ex.ws.new_key'), message: t('ex.ws.key_warn') }))) return;
          try {
            const r = await x.api('/admin/exam-workstations/' + b.dataset.key + '/rotate-key', { method: 'POST', body: {} });
            const url = location.origin + '/exam.html';
            AP.tui.openModal({ title: t('ex.ws.key_title'), html: '<div class="ex-note warn">' + esc(t('ex.ws.key_once')) + '</div><input class="input" readonly id="exk-val" value="' + esc(r.key) + '" onclick="this.select()"><div class="ex-muted" style="margin-top:10px">' + esc(t('ex.ws.key_install')) + ' <code>' + esc(url) + '</code></div>', buttons: [{ label: t('ex.ws.copy'), cls: 'btn-outline', keep: true, onClick: () => { const v = document.getElementById('exk-val'); v.select(); try { navigator.clipboard.writeText(v.value); } catch { document.execCommand('copy'); } toast(t('ex.ws.copied')); return false; } }, { label: t('common.close'), cls: 'btn-primary' }] });
            workstations();
          } catch (e) { err(e); }
        }));
        root.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => { try { await x.api('/admin/exam-workstations/' + b.dataset.act + '/active', { method: 'POST', body: { isActive: b.dataset.on === '1' } }); workstations(); } catch (e) { err(e); } }));
        $('exs-newproc').onclick = () => {
          const h = AP.tui.openModal({ title: t('ex.pr.new'), html: '<div class="form-grid">' + inp('exp-name', t('ex.pr.name'), '', 'text', ' maxlength="120"') + inp('exp-mail', 'Email', '', 'email') + '</div><div class="ex-muted">' + esc(t('ex.pr.new_hint')) + '</div>',
            buttons: [{ label: t('common.cancel'), cls: 'btn-outline' }, { label: t('common.save'), cls: 'btn-primary', onClick: async () => { try { const r = await x.api('/admin/users', { method: 'POST', body: { role: 'PROCTOR', fullName: h.$('#exp-name').value.trim(), email: h.$('#exp-mail').value.trim() } }); AP.tui.openModal({ title: t('ex.pr.created'), html: '<dl class="ex-kv"><dt>Login ID</dt><dd><code>' + esc(r.user.loginId) + '</code></dd><dt>' + esc(t('ex.pr.temp_pw')) + '</dt><dd><code>' + esc(r.temporaryPassword || '—') + '</code></dd></dl>', buttons: [{ label: t('common.close'), cls: 'btn-primary' }] }); workstations(); } catch (e) { err(e); return false; } } }] });
        };
        root.querySelectorAll('[data-rooms]').forEach((b) => b.addEventListener('click', () => {
          const p = pr.find((z) => z.id === b.dataset.rooms), lab = rm.filter((r) => ws.some((w) => w.room.id === r.id));
          const h = AP.tui.openModal({ title: t('ex.pr.assign') + ' — ' + p.fullName, html: lab.map((r) => '<label class="tt-chk" style="display:flex;margin:6px 0"><input type="checkbox" value="' + esc(r.id) + '"' + (p.rooms.some((z) => z.id === r.id) ? ' checked' : '') + '> ' + esc(r.code + ' · ' + (r.name || '')) + '</label>').join('') || x.empty(t('ex.ws.none')),
            buttons: [{ label: t('common.cancel'), cls: 'btn-outline' }, { label: t('common.save'), cls: 'btn-primary', onClick: async () => { try { await x.api('/admin/exam-proctors/' + p.id + '/rooms', { method: 'PUT', body: { roomIds: Array.from(h.el.querySelectorAll('input:checked')).map((c) => c.value) } }); workstations(); } catch (e) { err(e); return false; } } }] });
        }));
      });
    }

    // ───────────────────────── Бумажные экзамены ─────────────────────────
    let paperExam = '';
    async function paper() {
      return load('ex-paper', async (root) => {
        const x = X(), wins = (await x.api('/admin/exam-windows')).filter((w) => w.status === 'PUBLISHED');
        const papers = [];
        for (const w of wins) { const d = await x.api('/admin/exam-windows/' + w.id); d.exams.filter((e) => e.delivery === 'PAPER').forEach((e) => papers.push({ id: e.id, label: d.title + ' — ' + e.subject.name })); }
        if (!papers.length) { root.innerHTML = x.empty(t('ex.pp.none')); return; }
        if (!paperExam || !papers.some((p) => p.id === paperExam)) paperExam = papers[0].id;
        const [sheets, queue] = await Promise.all([x.api('/admin/paper/exams/' + paperExam + '/sheets'), x.api('/admin/paper/review')]);
        root.innerHTML = '<div class="ex-note info">' + esc(t('ex.pp.hint')) + '</div><div class="ex-toolbar">' + sel('exp-exam', t('ex.w.exams'), papers.map((p) => [p.id, p.label]), paperExam) + '<button class="btn btn-primary" id="exp-gen">' + esc(t('ex.pp.generate')) + '</button><button class="btn btn-outline" id="exp-print">🖨 ' + esc(t('ex.pp.print_all')) + '</button></div>' +
          (queue.length ? '<div class="ex-note warn"><b>' + esc(t('ex.pp.review_queue')) + ' (' + queue.length + ')</b> ' + queue.map((q) => '<button class="btn btn-outline btn-sm" data-rev="' + esc(q.id) + '">' + esc(q.student.fullName) + ' · ' + q.pending + '</button>').join(' ') + '</div>' : '') +
          (sheets.length ? '<div class="card"><div class="card-pad ex-scroll"><table class="ex-table"><thead><tr><th>' + esc(t('ex.col.student')) + '</th><th>' + esc(t('ex.col.group')) + '</th><th>' + esc(t('ex.pp.code')) + '</th><th>' + esc(t('ex.col.status')) + '</th><th>' + esc(t('ex.res.total')) + '</th><th></th></tr></thead><tbody>' +
            sheets.map((s) => '<tr><td>' + esc(s.student.fullName) + '<div class="ex-muted">' + esc(s.student.loginId) + '</div></td><td>' + esc(s.student.groupName) + '</td><td><code>' + esc(s.sheetCode) + '</code></td><td>' + x.chip(s.status === 'SCORED' ? 'ok' : s.status === 'MANUAL_REVIEW_REQUIRED' ? 'bad' : 'info', x.statusText('SHEET_' + s.status)) + '</td><td>' + (s.result ? x.num(s.result.total) + ' ' + x.chip(s.result.passed ? 'ok' : 'bad', t(s.result.passed ? 'ex.res.passed' : 'ex.res.failed')) : '—') + '</td><td style="text-align:right"><button class="btn btn-outline btn-sm" data-print="' + esc(s.id) + '">🖨</button> ' +
              (s.status !== 'SCORED' ? '<label class="btn btn-outline btn-sm" style="cursor:pointer">' + esc(t('ex.pp.scan')) + '<input type="file" accept="image/png,image/jpeg,image/webp" data-scan="' + esc(s.id) + '" hidden></label>' : '') + (s.status === 'MANUAL_REVIEW_REQUIRED' ? ' <button class="btn btn-primary btn-sm" data-rev="' + esc(s.id) + '">' + esc(t('ex.pp.review')) + '</button>' : '') + '</td></tr>').join('') + '</tbody></table></div></div>' : x.empty(t('ex.pp.no_sheets')));
        $('exp-exam').onchange = (e) => { paperExam = e.target.value; paper(); };
        $('exp-gen').onclick = async () => { try { const r = await x.api('/admin/paper/exams/' + paperExam + '/generate', { method: 'POST', body: {} }); toast(t('ex.pp.generated').replace('{n}', r.created).replace('{s}', r.skipped.length)); paper(); } catch (e) { err(e); } };
        $('exp-print').onclick = () => x.openPrint('/admin/paper/exams/' + paperExam + '/print');
        root.querySelectorAll('[data-print]').forEach((b) => b.addEventListener('click', () => x.openPrint('/admin/paper/sheets/' + b.dataset.print + '/print')));
        root.querySelectorAll('[data-scan]').forEach((i) => i.addEventListener('change', async () => {
          const f = i.files[0]; if (!f) return;
          try { const r = await x.api('/admin/paper/sheets/' + i.dataset.scan + '/scan', { method: 'POST', body: { mimeType: f.type, dataBase64: await x.fileToB64(f) } }); toast(t(r.status === 'SCORED' ? 'ex.pp.scored' : 'ex.pp.needs_review')); paper(); if (r.status === 'MANUAL_REVIEW_REQUIRED') sheetReview(r.id); } catch (e) { err(e); }
        }));
        root.querySelectorAll('[data-rev]').forEach((b) => b.addEventListener('click', () => sheetReview(b.dataset.rev)));
      });
    }

    /** Ручная проверка бланка: скан + сетка 25 вопросов; каждое изменение пишется в Audit Log с причиной */
    async function sheetReview(id) {
      const x = X();
      let d;
      try { d = await x.api('/admin/paper/sheets/' + id); } catch (e) { err(e); return; }
      let url = null;
      if (d.scans.length) { try { url = URL.createObjectURL(await x.fetchBlob('/admin/paper/sheets/' + id + '/scan-image?v=' + Date.now())); } catch { /* нет скана */ } }
      const locked = d.status === 'SCORED';
      const cell = (q) => '<div class="c' + (q.flags.some((f) => f !== 'EMPTY') && !q.reviewed ? ' flag' : q.reviewed ? ' done' : '') + '"><b>#' + q.position + '</b><div class="ex-muted">' + esc(t('ex.pp.detected')) + ': ' + (q.detected || (q.flags.includes('EMPTY') ? '—' : '?')) + '</div>' + q.flags.filter((f) => f !== 'EMPTY').map((f) => '<span class="ex-flag">' + esc(f) + '</span>').join(' ') +
        '<select class="input" data-pos="' + q.position + '" style="margin-top:4px;padding:3px"' + (locked ? ' disabled' : '') + '><option value="">' + esc(t('ex.pp.skip')) + '</option>' + 'ABCDE'.split('').map((l) => '<option' + (q.final === l ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></div>';
      const h = AP.tui.openModal({
        title: d.student.fullName + ' · ' + d.sheetCode, wide: true, static: true, onClose: () => { if (url) URL.revokeObjectURL(url); paper(); },
        html: '<div class="ex-row" style="margin-bottom:8px">' + x.chip(d.status === 'SCORED' ? 'ok' : 'bad', x.statusText('SHEET_' + d.status)) + '<span class="ex-muted">' + esc(d.subject) + '</span></div>' +
          (d.scans[0] && d.scans[0].note ? '<div class="ex-note bad">' + esc(t('ex.pp.omr_err.' + d.scans[0].note, d.scans[0].note)) + '</div>' : '') +
          (url ? '<details open><summary>' + esc(t('ex.pp.scan_image')) + '</summary><img alt="scan" src="' + url + '" style="max-width:100%;border:1px solid var(--c-border);border-radius:8px"></details>' : '') +
          '<div class="ex-note info" style="margin-top:10px">' + esc(t('ex.pp.review_hint')) + '</div><div class="form-group"><div class="form-label">' + esc(t('ex.pp.reason')) + '</div><input class="input" id="exv-reason" value="' + esc(t('ex.pp.reason_default')) + '"></div><div class="ex-sheet" id="exv-grid">' + d.questions.map(cell).join('') + '</div>',
        buttons: [{ label: t('common.close'), cls: 'btn-outline' }, ...(locked ? [] : [{ label: t('ex.pp.confirm'), cls: 'btn-primary', keep: true, onClick: async (hh) => { try { await markReviewed(hh); await x.api('/admin/paper/sheets/' + id + '/confirm', { method: 'POST', body: {} }); toast(t('ex.pp.scored')); hh.close(); } catch (e) { err(e); } return false; } }])],
      });
      // изменения отправляются при подтверждении (или сразу при выборе — чтобы отражалось в аудите по каждому вопросу)
      const reason = () => h.$('#exv-reason').value.trim() || t('ex.pp.reason_default');
      h.el.querySelectorAll('select[data-pos]').forEach((s) => s.addEventListener('change', async () => {
        try { await x.api('/admin/paper/sheets/' + id + '/answers/' + s.dataset.pos, { method: 'PUT', body: { letter: s.value || null, reason: reason() } }); s.closest('.c').classList.remove('flag'); s.closest('.c').classList.add('done'); } catch (e) { err(e); }
      }));
      async function markReviewed() {
        // сомнительные вопросы без явного решения подтверждаются текущим значением (SKIP/буква) — фиксируется в аудите
        const cells = Array.from(h.el.querySelectorAll('.c.flag select[data-pos]'));
        for (const s of cells) await x.api('/admin/paper/sheets/' + id + '/answers/' + s.dataset.pos, { method: 'PUT', body: { letter: s.value || null, reason: reason() } });
      }
    }

    // ───────────────────────── Resit и платежи ─────────────────────────
    async function resits() {
      return load('ex-resits', async (root) => {
        const x = X(), list = await x.api('/admin/exam-resits');
        const sum = list.filter((r) => r.payment && r.payment.status === 'PAID').reduce((a, r) => a + r.payment.amount, 0);
        root.innerHTML = '<div class="stat-grid"><div class="stat-card"><div class="stat-val">' + list.length + '</div><div class="stat-label">' + esc(t('ex.rs.records')) + '</div></div><div class="stat-card"><div class="stat-val">' + list.filter((r) => r.status === 'PAID').length + '</div><div class="stat-label">' + esc(t('ex.pay.PAID')) + '</div></div><div class="stat-card"><div class="stat-val">' + x.num(sum) + ' AZN</div><div class="stat-label">' + esc(t('ex.rs.revenue')) + '</div></div></div>' +
          (list.length ? '<div class="card"><div class="card-pad ex-scroll"><table class="ex-table"><thead><tr><th>' + esc(t('ex.col.student')) + '</th><th>' + esc(t('ex.col.subject')) + '</th><th>' + esc(t('ex.w.cycle')) + '</th><th>' + esc(t('ex.rs.credits')) + '</th><th>' + esc(t('ex.rs.fee')) + '</th><th>' + esc(t('ex.col.status')) + '</th><th>' + esc(t('ex.rs.invoice')) + '</th><th></th></tr></thead><tbody>' +
            list.map((r) => '<tr><td>' + esc(r.student.fullName) + '<div class="ex-muted">' + esc(r.student.groupName) + '</div></td><td>' + esc(r.subject.name) + '</td><td>' + esc(r.cycle) + '</td><td>' + r.credits + '</td><td>' + x.num(r.fee) + ' AZN</td><td>' + x.chip(r.status === 'PAID' ? 'ok' : r.status === 'USED' ? '' : r.status === 'FORFEITED' ? 'bad' : 'warn', t('ex.pay.' + r.status)) + '</td><td>' + (r.payment ? '<code>' + esc(r.payment.invoice) + '</code>' : '—') + '</td><td>' + (r.status === 'PAID' ? '<button class="btn btn-outline btn-sm" data-refund="' + esc(r.id) + '">' + esc(t('ex.rs.refund')) + '</button>' : '') + '</td></tr>').join('') + '</tbody></table></div></div>' : x.empty(t('ex.rs.none_admin')));
        root.querySelectorAll('[data-refund]').forEach((b) => b.addEventListener('click', () => {
          const h = AP.tui.openModal({ title: t('ex.rs.refund'), html: '<div class="form-label">' + esc(t('ex.rv.reason')) + '</div><input class="input" id="exf-reason" maxlength="300">', buttons: [{ label: t('common.cancel'), cls: 'btn-outline' }, { label: t('ex.rs.refund'), cls: 'btn-danger', onClick: async () => { try { await x.api('/admin/exam-resits/' + b.dataset.refund + '/refund', { method: 'POST', body: { reason: h.$('#exf-reason').value.trim() } }); resits(); } catch (e) { err(e); return false; } } }] });
        }));
      });
    }

    // ───────────────────────── Retake / предложения / летние курсы ─────────────────────────
    let rtTab = 'retakes';
    async function retakes() {
      const x = X();
      const root = $('ex-retakes');
      root.innerHTML = '<div class="ex-tabs">' + ['retakes', 'offerings', 'summer'].map((k) => '<button class="ex-tab' + (rtTab === k ? ' on' : '') + '" data-rt="' + k + '">' + esc(t('ex.rt.tab.' + k)) + '</button>').join('') + '</div><div id="ex-rt-body">' + x.skel(2) + '</div>';
      root.querySelectorAll('[data-rt]').forEach((b) => b.addEventListener('click', () => { rtTab = b.dataset.rt; retakes(); }));
      const body = $('ex-rt-body');
      try {
        if (rtTab === 'retakes') {
          const d = await x.api('/admin/exam-retakes');
          body.innerHTML = '<h3>' + esc(t('ex.rt.required_list')) + ' (' + d.required.length + ')</h3>' + tbl([t('ex.col.student'), t('ex.col.group'), t('ex.col.subject')], d.required.map((r) => [esc(r.student.fullName), esc(r.student.groupName), esc(r.subject.name)]), t('ex.rt.none_required')) +
            '<h3 style="margin-top:20px">' + esc(t('ex.rt.registered')) + ' (' + d.registered.length + ')</h3>' + tbl([t('ex.col.student'), t('ex.col.subject'), t('ex.rt.path'), t('ex.col.status')], d.registered.map((r) => [esc(r.student.fullName), esc(r.subject.name), esc(r.mode === 'SUMMER' ? (r.summer || '') : r.offering ? r.offering.academicYear.replace('-', '/') + ' · ' + t('ex.term.' + r.offering.term) : ''), x.chip('ok', t('ex.rt.status.' + r.status))]), t('ex.s.none_retakes'));
        } else if (rtTab === 'offerings') {
          const list = await x.api('/admin/subject-offerings');
          body.innerHTML = '<div class="ex-toolbar"><button class="btn btn-primary" id="exo-new">+ ' + esc(t('ex.of.new')) + '</button></div><div class="ex-note info">' + esc(t('ex.of.hint')) + '</div>' + tbl([t('ex.col.subject'), t('ex.w.year'), t('ex.w.term'), t('ex.rt.course_h'), t('ex.of.cycle_h'), t('ex.of.prereq'), t('ex.col.status')], list.map((o) => [esc(o.subject.name), esc(o.academicYear.replace('-', '/')), esc(t('ex.term.' + o.term)), String(o.course), esc(t('ex.of.cycle.' + o.cycle)), esc(o.prerequisites.map((p) => p.name).join(', ') || '—'), x.chip(o.isAvailable ? 'ok' : 'bad', t(o.isAvailable ? 'ex.of.available' : 'ex.of.unavailable')) + ' <button class="btn btn-outline btn-sm" data-tog="' + esc(o.id) + '" data-v="' + (o.isAvailable ? '0' : '1') + '">⇄</button>']), t('ex.of.none'));
          $('exo-new').onclick = offeringModal;
          body.querySelectorAll('[data-tog]').forEach((b) => b.addEventListener('click', async () => { try { await x.api('/admin/subject-offerings/' + b.dataset.tog, { method: 'PUT', body: { isAvailable: b.dataset.v === '1' } }); retakes(); } catch (e) { err(e); } }));
        } else {
          const list = await x.api('/admin/summer-retakes');
          body.innerHTML = '<div class="ex-toolbar"><button class="btn btn-primary" id="exs-newp">+ ' + esc(t('ex.su.new')) + '</button></div>' + (list.length ? list.map((p) => '<div class="card" style="margin-bottom:14px"><div class="card-pad"><div class="ex-row" style="justify-content:space-between"><h3 style="margin:0">' + esc(p.title) + '</h3><span>' + x.chip(p.status === 'OPEN' ? 'ok' : '', p.status) + ' <button class="btn btn-outline btn-sm" data-pst="' + esc(p.id) + '" data-v="' + (p.status === 'OPEN' ? 'CLOSED' : 'OPEN') + '">⇄</button> <button class="btn btn-primary btn-sm" data-addc="' + esc(p.id) + '">+ ' + esc(t('ex.su.course')) + '</button></span></div><div class="ex-muted">' + esc(x.fmtDate(p.startDate)) + ' – ' + esc(x.fmtDate(p.endDate)) + ' · ' + esc(t('ex.su.reg_until')) + ' ' + esc(x.fmtDT(p.registrationClosesAt)) + '</div>' +
            tbl([t('ex.col.subject'), t('ex.su.teacher'), t('ex.su.schedule'), t('ex.su.seats'), t('ex.su.attendance'), t('ex.su.assessment')], p.courses.map((c) => [esc(c.subject.name), esc(c.teacher || '—'), esc(c.schedule || '—'), c.registered + ' / ' + c.maxStudents, c.minAttendance + '%', esc(t('ex.su.as.' + c.assessment))]), t('ex.su.no_courses')) + '</div></div>').join('') : x.empty(t('ex.su.none')));
          $('exs-newp').onclick = periodModal;
          body.querySelectorAll('[data-pst]').forEach((b) => b.addEventListener('click', async () => { try { await x.api('/admin/summer-retakes/' + b.dataset.pst + '/status', { method: 'POST', body: { status: b.dataset.v } }); retakes(); } catch (e) { err(e); } }));
          body.querySelectorAll('[data-addc]').forEach((b) => b.addEventListener('click', () => courseModal(b.dataset.addc)));
        }
      } catch (e) { body.innerHTML = x.errBox(e); }
    }
    function tbl(head, rows, emptyText) {
      if (!rows.length) return X().empty(emptyText);
      return '<div class="card"><div class="card-pad ex-scroll"><table class="ex-table"><thead><tr>' + head.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' + rows.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table></div></div>';
    }
    async function offeringModal() {
      const x = X(), subs = await subjects(), o = await org();
      const specs = o.faculties.flatMap((f) => f.departments.flatMap((d) => d.specialties.map((s) => [s.id, s.code + ' · ' + s.name])));
      const h = AP.tui.openModal({ title: t('ex.of.new'), wide: true, html: '<div class="form-grid">' + sel('eo-sub', t('ex.col.subject'), subs.map((s) => [s.id, s.code + ' · ' + s.name]), '') + sel('eo-spec', t('ex.of.specialty'), [['', t('ex.of.any')], ...specs], '') + inp('eo-year', t('ex.w.year'), '2027-2028') + sel('eo-term', t('ex.w.term'), [['FALL', t('ex.term.FALL')], ['SPRING', t('ex.term.SPRING')]], 'FALL') +
        inp('eo-course', t('ex.rt.course_h'), 1, 'number', ' min="1" max="6"') + inp('eo-sem', t('ex.s.semester'), 1, 'number', ' min="1" max="12"') + sel('eo-cycle', t('ex.of.cycle_h'), [['EVERY_YEAR', t('ex.of.cycle.EVERY_YEAR')], ['EVEN_YEARS', t('ex.of.cycle.EVEN_YEARS')], ['ODD_YEARS', t('ex.of.cycle.ODD_YEARS')]], 'EVERY_YEAR') + inp('eo-start', t('ex.rt.starts'), '', 'date') + inp('eo-close', t('ex.of.enroll_close'), '', 'date') + '</div>' +
        '<label style="display:block;margin-top:8px">' + esc(t('ex.of.prereq')) + '<select class="input" id="eo-pre" multiple size="5">' + subs.map((s) => '<option value="' + esc(s.id) + '">' + esc(s.code + ' · ' + s.name) + '</option>').join('') + '</select></label>',
        buttons: [{ label: t('common.cancel'), cls: 'btn-outline' }, { label: t('common.save'), cls: 'btn-primary', onClick: async () => { try { await x.api('/admin/subject-offerings', { method: 'POST', body: { subjectId: h.$('#eo-sub').value, specialtyId: h.$('#eo-spec').value || null, academicYear: h.$('#eo-year').value.trim(), term: h.$('#eo-term').value, course: Number(h.$('#eo-course').value), semester: Number(h.$('#eo-sem').value), cycle: h.$('#eo-cycle').value, startsAt: h.$('#eo-start').value, enrollmentClosesAt: h.$('#eo-close').value || null, prerequisiteIds: Array.from(h.$('#eo-pre').selectedOptions).map((s) => s.value) } }); retakes(); } catch (e) { err(e); return false; } } }] });
    }
    function periodModal() {
      const x = X();
      const h = AP.tui.openModal({ title: t('ex.su.new'), html: '<div class="form-grid">' + inp('ep-title', t('ex.w.title'), 'Summer retake 2027') + inp('ep-year', t('ex.w.year'), '2026-2027') + inp('ep-start', t('ex.w.start'), '', 'date') + inp('ep-end', t('ex.w.end'), '', 'date') + inp('ep-reg', t('ex.su.reg_until'), '', 'datetime-local') + '</div>',
        buttons: [{ label: t('common.cancel'), cls: 'btn-outline' }, { label: t('common.save'), cls: 'btn-primary', onClick: async () => { try { await x.api('/admin/summer-retakes', { method: 'POST', body: { title: h.$('#ep-title').value.trim(), academicYear: h.$('#ep-year').value.trim(), startDate: h.$('#ep-start').value, endDate: h.$('#ep-end').value, registrationClosesAt: new Date(h.$('#ep-reg').value).toISOString() } }); retakes(); } catch (e) { err(e); return false; } } }] });
    }
    async function courseModal(periodId) {
      const x = X(), subs = await subjects();
      const h = AP.tui.openModal({ title: t('ex.su.course'), html: '<div class="form-grid">' + sel('ec-sub', t('ex.col.subject'), subs.map((s) => [s.id, s.code + ' · ' + s.name]), '') + inp('ec-sched', t('ex.su.schedule'), '', 'text', ' maxlength="200"') + inp('ec-max', t('ex.su.seats'), 30, 'number') + inp('ec-att', t('ex.su.attendance') + ' %', 75, 'number') + sel('ec-as', t('ex.su.assessment'), ['FINAL_EXAM', 'PROJECT', 'COURSEWORK'].map((a) => [a, t('ex.su.as.' + a)]), 'FINAL_EXAM') + '</div>',
        buttons: [{ label: t('common.cancel'), cls: 'btn-outline' }, { label: t('common.save'), cls: 'btn-primary', onClick: async () => { try { await x.api('/admin/summer-retakes/' + periodId + '/courses', { method: 'POST', body: { subjectId: h.$('#ec-sub').value, schedule: h.$('#ec-sched').value.trim() || null, maxStudents: Number(h.$('#ec-max').value), minAttendance: Number(h.$('#ec-att').value), assessment: h.$('#ec-as').value } }); retakes(); } catch (e) { err(e); return false; } } }] });
    }

    // ───────────────────────── Результаты / аналитика / аудит ─────────────────────────
    const F = { results: {}, analytics: {} };
    async function filtersHtml(key, withStatus) {
      const x = X(), [o, ws] = await Promise.all([org(), x.api('/admin/exam-windows')]);
      const groups = o.faculties.flatMap((f) => f.departments.flatMap((d) => d.specialties.flatMap((s) => s.groups.map((g) => g.name))));
      const specs = o.faculties.flatMap((f) => f.departments.flatMap((d) => d.specialties.map((s) => [s.id, s.code + ' · ' + s.name])));
      const f = F[key];
      return '<div class="ex-toolbar">' + sel('exf-win', t('ex.f.window'), [['', t('ex.f.all')], ...ws.map((w) => [w.id, w.title])], f.windowId) + sel('exf-fac', t('ex.f.faculty'), [['', t('ex.f.all')], ...o.faculties.map((z) => [z.id, z.name])], f.facultyId) + sel('exf-spec', t('ex.f.program'), [['', t('ex.f.all')], ...specs], f.specialtyId) + sel('exf-grp', t('ex.col.group'), [['', t('ex.f.all')], ...groups.map((g) => [g, g])], f.groupName) +
        sel('exf-sub', t('ex.col.subject'), [['', t('ex.f.all')], ...(await subjects()).map((s) => [s.id, s.code + ' · ' + s.name])], f.subjectId) + sel('exf-kind', t('ex.col.type'), [['', t('ex.f.all')], ['FINAL', t('ex.kind.FINAL')], ['RESIT', t('ex.kind.RESIT')]], f.kind) +
        (withStatus ? sel('exf-st', t('ex.col.status'), [['', t('ex.f.all')], ['PASSED', t('ex.res.passed')], ['FAILED', t('ex.res.failed')], ['ABSENT', t('ex.st.ABSENT')]], f.status) : '') + inp('exf-from', t('ex.f.from'), f.from, 'date') + inp('exf-to', t('ex.f.to'), f.to, 'date') + '</div>';
    }
    function bindFilters(key, again) {
      const map = { 'exf-win': 'windowId', 'exf-fac': 'facultyId', 'exf-spec': 'specialtyId', 'exf-grp': 'groupName', 'exf-sub': 'subjectId', 'exf-kind': 'kind', 'exf-st': 'status', 'exf-from': 'from', 'exf-to': 'to' };
      Object.entries(map).forEach(([id, k]) => { const el = $(id); if (el) el.onchange = (e) => { F[key][k] = e.target.value; again(); }; });
    }
    const qs = (o) => { const p = new URLSearchParams(); Object.entries(o).forEach(([k, v]) => { if (v) p.set(k, v); }); const s = p.toString(); return s ? '?' + s : ''; };

    async function results() {
      return load('ex-results', async (root) => {
        const x = X(), rows = await x.api('/admin/exam-results' + qs(F.results));
        const pending = rows.filter((r) => !r.published);
        root.innerHTML = await filtersHtml('results', true) + '<div class="ex-row" style="margin-bottom:10px"><span class="ex-muted">' + rows.length + ' ' + esc(t('ex.rs.records')) + '</span>' + (pending.length ? '<button class="btn btn-primary btn-sm" id="exr-pub">' + esc(t('ex.res.publish').replace('{n}', pending.length)) + '</button>' : '') + '</div>' +
          (rows.length ? '<div class="card"><div class="card-pad ex-scroll"><table class="ex-table"><thead><tr><th>' + esc(t('ex.col.student')) + '</th><th>' + esc(t('ex.col.group')) + '</th><th>' + esc(t('ex.col.subject')) + '</th><th>' + esc(t('ex.col.type')) + '</th><th>' + esc(t('ex.res.entry')) + '</th><th>' + esc(t('ex.res.exam')) + '</th><th>' + esc(t('ex.res.total')) + '</th><th>' + esc(t('ex.res.grade')) + '</th><th>' + esc(t('ex.col.status')) + '</th><th>' + esc(t('ex.col.date')) + '</th></tr></thead><tbody>' +
            rows.slice(0, 500).map((r) => '<tr><td>' + esc(r.student.fullName) + '<div class="ex-muted">' + esc(r.student.loginId) + '</div></td><td>' + esc(r.student.groupName) + '</td><td>' + esc(r.subject ? r.subject.name : '') + '</td><td>' + x.chip(r.kind === 'RESIT' ? 'warn' : 'info', t('ex.kind.' + r.kind)) + (r.source !== 'COMPUTER' ? ' <span class="ex-muted">' + esc(r.source) + '</span>' : '') + '</td><td>' + x.num(r.entryScore) + '</td><td>' + x.num(r.examScore) + '</td><td><b>' + x.num(r.total) + '</b></td><td><span class="ex-letter ' + (r.letter === 'F' ? 'F' : '') + '">' + esc(r.letter) + '</span></td><td>' + x.chip(r.passed ? 'ok' : 'bad', t(r.passed ? 'ex.res.passed' : 'ex.res.failed')) + (r.failReason ? '<div class="ex-muted">' + esc(t('ex.res.reason.' + r.failReason, r.failReason)) + '</div>' : '') + (!r.published ? ' ' + x.chip('warn', t('ex.res.unpublished')) : '') + '</td><td>' + esc(x.fmtDate(r.date)) + '</td></tr>').join('') + '</tbody></table></div></div>' : x.empty(t('ex.res.none')));
        bindFilters('results', results);
        const pb = $('exr-pub'); if (pb) pb.onclick = async () => { try { await x.api('/admin/exam-results/publish', { method: 'POST', body: { ids: pending.map((r) => r.id).slice(0, 1000) } }); toast(t('ex.res.published')); results(); } catch (e) { err(e); } };
      });
    }

    async function analytics() {
      return load('ex-analytics', async (root) => {
        const x = X(), a = await x.api('/admin/exam-analytics' + qs(F.analytics));
        const maxG = Math.max(1, ...Object.values(a.grades));
        const card = (v, l, c) => '<div class="stat-card"><div class="stat-val ' + (c || '') + '">' + v + '</div><div class="stat-label">' + esc(l) + '</div></div>';
        root.innerHTML = await filtersHtml('analytics', false) + '<div class="stat-grid">' + card(a.totals.invited, t('ex.an.invited')) + card(a.totals.completed, t('ex.an.completed')) + card(a.totals.active, t('ex.an.active')) + card(a.totals.notTaken, t('ex.an.not_taken')) + card(a.totals.absent, t('ex.an.absent')) + card(a.totals.passed, t('ex.an.passed'), 'tt-green') + card(a.totals.failed, t('ex.an.failed'), a.totals.failed ? 'tt-red' : '') + card(x.num(a.averages.examScore), t('ex.an.avg_exam')) + card(x.num(a.averages.total), t('ex.an.avg_total')) + '</div>' +
          '<div class="ex-grid" style="margin-top:16px"><div class="ex-card"><h3>' + esc(t('ex.an.grades')) + '</h3>' + Object.entries(a.grades).map(([k, v]) => '<div class="ex-row"><b style="width:22px">' + k + '</b><div class="ex-bar" style="flex:1"><i style="width:' + Math.round((v / maxG) * 100) + '%"></i></div><span style="width:34px;text-align:right">' + v + '</span></div>').join('') + '</div>' +
          '<div class="ex-card"><h3>' + esc(t('ex.an.resit_retake')) + '</h3><dl class="ex-kv"><dt>' + esc(t('ex.an.resit_eligible')) + '</dt><dd>' + a.resit.eligible + '</dd>' + Object.entries(a.resit.byStatus).map(([k, v]) => '<dt>' + esc(t('ex.pay.' + k)) + '</dt><dd>' + v + '</dd>').join('') + '<dt>' + esc(t('ex.an.retake_required')) + '</dt><dd>' + a.retakeRequired + '</dd></dl></div>' +
          '<div class="ex-card"><h3>' + esc(t('ex.an.payments')) + '</h3>' + (a.payments.length ? '<dl class="ex-kv">' + a.payments.map((p) => '<dt>' + esc(p.status) + ' (' + p.count + ')</dt><dd>' + x.num(p.amount) + ' AZN</dd>').join('') + '</dl>' : x.empty(t('ex.res.none'))) + '</div></div>' +
          '<h3 style="margin:18px 0 8px">' + esc(t('ex.an.subject_failure')) + '</h3>' + tbl([t('ex.col.subject'), t('ex.an.taken'), t('ex.an.failed'), t('ex.an.rate')], a.subjectFailure.slice(0, 40).map((s) => [esc(s.subject), String(s.taken), String(s.failed), x.chip(s.rate > 40 ? 'bad' : s.rate > 20 ? 'warn' : 'ok', s.rate + '%')]), t('ex.res.none'));
        bindFilters('analytics', analytics);
      });
    }

    const AF = { action: '', entity: '', from: '', to: '' };
    async function audit() {
      return load('ex-audit', async (root) => {
        const x = X(), rows = await x.api('/admin/exam-audit' + qs(AF));
        root.innerHTML = '<div class="ex-toolbar">' + inp('exa-action', t('ex.au.action'), AF.action, 'text', ' placeholder="student_authorized"') + inp('exa-entity', t('ex.au.entity'), AF.entity, 'text', ' placeholder="ExamAttempt"') + inp('exa-from', t('ex.f.from'), AF.from, 'date') + inp('exa-to', t('ex.f.to'), AF.to, 'date') + '</div><div class="ex-note info">' + esc(t('ex.au.hint')) + '</div>' +
          (rows.length ? '<div class="card"><div class="card-pad ex-scroll"><table class="ex-table"><thead><tr><th>' + esc(t('ex.au.time')) + '</th><th>' + esc(t('ex.au.user')) + '</th><th>' + esc(t('ex.au.action')) + '</th><th>' + esc(t('ex.au.entity')) + '</th><th>' + esc(t('ex.col.status')) + '</th><th>' + esc(t('ex.au.meta')) + '</th></tr></thead><tbody>' +
            rows.map((r) => '<tr><td style="white-space:nowrap">' + esc(x.fmtDT(r.at)) + '</td><td>' + (r.actor ? esc(r.actor.loginId) + '<div class="ex-muted">' + esc(r.actor.role) + '</div>' : '<span class="ex-muted">system</span>') + '</td><td><code>' + esc(r.action.replace('exam.', '')) + '</code></td><td>' + esc(r.entity) + '<div class="ex-muted">' + esc((r.entityId || '').slice(0, 10)) + '</div></td><td>' + x.chip(r.result === 'SUCCESS' ? 'ok' : 'bad', r.result) + '</td><td><details><summary>JSON</summary><pre style="margin:4px 0 0;font-size:11px;white-space:pre-wrap;max-width:420px">' + esc(JSON.stringify(r.meta, null, 1)) + '</pre></details></td></tr>').join('') + '</tbody></table></div></div>' : x.empty(t('ex.res.none')));
        const again = () => { AF.action = $('exa-action').value.trim(); AF.entity = $('exa-entity').value.trim(); AF.from = $('exa-from').value; AF.to = $('exa-to').value; audit(); };
        ['exa-action', 'exa-entity'].forEach((i) => $(i).addEventListener('keydown', (e) => { if (e.key === 'Enter') again(); })); ['exa-from', 'exa-to'].forEach((i) => $(i).addEventListener('change', again));
      });
    }

    return { windows, review, workstations, paper, resits, retakes, results, analytics, audit };
  }

  AP.examsAdmin = { create };
})(window);
