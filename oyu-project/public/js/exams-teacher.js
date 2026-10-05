// ============================================================
// Преподаватель → My Exams: банк вопросов (версии), редактор, импорт CSV/XLSX, отправка на проверку, результаты.
// Утверждает вопросы только Management; утверждённую версию изменить нельзя — создаётся новая.
// ============================================================
(function (global) {
  'use strict';
  const AP = global.AP;
  const X = () => AP.ex, t = (k, fb) => AP.i18n.t(k, fb), esc = (s) => AP.ex.esc(s);
  let root = null, tab = 'banks', cur = null;
  const L5 = ['A', 'B', 'C', 'D', 'E'];

  async function render(rootId) {
    root = document.getElementById(rootId);
    if (cur) return editor(cur);
    root.innerHTML = '<div class="ex-tabs"><button class="ex-tab' + (tab === 'banks' ? ' on' : '') + '" data-t="banks">' + esc(t('ex.t.banks')) + '</button><button class="ex-tab' + (tab === 'results' ? ' on' : '') + '" data-t="results">' + esc(t('ex.t.results')) + '</button></div><div id="ex-t-body">' + X().skel(3) + '</div>';
    root.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.t; render(rootId); }));
    return tab === 'banks' ? banks() : results();
  }

  const stChip = (s) => X().chip(s === 'APPROVED' ? 'ok' : s === 'REJECTED' ? 'bad' : s === 'SUBMITTED' || s === 'UNDER_REVIEW' ? 'warn' : s === 'DRAFT' ? 'info' : '', X().statusText(s));

  async function banks() {
    const x = X(), body = document.getElementById('ex-t-body');
    let list;
    try { list = await x.api('/teacher/exams'); } catch (e) { body.innerHTML = x.errBox(e); return; }
    if (!list.length) { body.innerHTML = x.empty(t('ex.t.none')); return; }
    body.innerHTML = '<div class="ex-note info">' + esc(t('ex.t.rules')) + '</div><div class="card"><div class="card-pad ex-scroll"><table class="ex-table"><thead><tr><th>' + esc(t('ex.col.subject')) + '</th><th>' + esc(t('ex.t.exam_types')) + '</th><th>' + esc(t('ex.t.deadline')) + '</th><th>' + esc(t('ex.col.status')) + '</th><th>' + esc(t('ex.t.version')) + '</th><th></th></tr></thead><tbody>' +
      list.map((r) => {
        const cv = r.openVersion || r.approvedVersion || r.versions[0];
        return '<tr><td><b>' + esc(r.subject.name) + '</b><div class="ex-muted">' + esc(r.subject.code) + ' · ' + r.subject.credits + ' ' + esc(t('ex.rs.credits').toLowerCase()) + '</div></td>' +
          '<td>' + (r.exams.length ? r.exams.map((e) => '<div class="ex-muted">' + x.chip(e.kind === 'RESIT' ? 'warn' : 'info', t('ex.kind.' + e.kind)) + ' ' + esc(x.fmtDate(e.startDate)) + ' · ' + esc(t('ex.delivery.' + e.delivery)) + '</div>').join('') : '<span class="ex-muted">—</span>') + '</td>' +
          '<td>' + (r.deadline ? esc(x.fmtDT(r.deadline)) + (r.overdue ? '<div>' + x.chip('bad', t('ex.st.OVERDUE')) + '</div>' : r.locked ? '<div>' + x.chip('warn', t('ex.t.locked')) + '</div>' : '') : '<span class="ex-muted">—</span>') + '</td>' +
          '<td>' + stChip(r.status) + (r.approvedVersion && r.openVersion ? '<div class="ex-muted">' + esc(t('ex.t.active_v').replace('{n}', r.approvedVersion.version)) + '</div>' : '') + '</td>' +
          '<td>' + (cv ? 'v' + cv.version + ' · ' + cv.questions + ' ' + esc(t('ex.s.questions')) : '—') + '</td>' +
          '<td style="text-align:right"><button class="btn btn-primary btn-sm" data-open="' + esc(r.subject.id) + '">' + esc(t(r.openVersion && r.openVersion.status === 'DRAFT' ? 'ex.t.edit' : 'ex.t.open')) + '</button></td></tr>';
      }).join('') + '</tbody></table></div></div>';
    body.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openSubject(list.find((r) => r.subject.id === b.dataset.open))));
  }

  /** Выбор версии: открыть черновик, либо создать новую (ревизию) на основе утверждённой/отклонённой */
  async function openSubject(row) {
    const x = X();
    try {
      const open = row.openVersion;
      if (open) { cur = { id: open.id, subject: row.subject }; return editor(cur); }
      const last = row.versions[0];
      if (last && last.status === 'REJECTED') {
        const ok = await AP.tui.confirmDialog({ title: t('ex.t.revise'), message: t('ex.t.revise_text').replace('{reason}', last.rejectionReason || '') });
        if (!ok) return;
      } else if (row.approvedVersion) {
        const ok = await AP.tui.confirmDialog({ title: t('ex.t.new_version'), message: t('ex.t.new_version_text') });
        if (!ok) return;
      }
      const v = await x.api('/teacher/question-banks/' + row.subject.id + '/versions', { method: 'POST', body: {} });
      cur = { id: v.id, subject: row.subject };
      editor(cur);
    } catch (e) { x.toast(x.errMsg(e), true); }
  }

  async function editor(c) {
    const x = X();
    root.innerHTML = x.skel(2);
    let v;
    try { v = await x.api('/teacher/question-banks/versions/' + c.id); } catch (e) { cur = null; root.innerHTML = x.errBox(e); return; }
    const need = v.minRequired;
    root.innerHTML =
      '<div class="ex-row" style="margin-bottom:12px"><button class="btn btn-outline btn-sm" id="ex-t-back">← ' + esc(t('common.back')) + '</button><h3 style="margin:0">' + esc(v.subject.name) + ' · v' + v.version + '</h3>' + stChip(v.status) + x.chip(v.questions.length >= need ? 'ok' : 'warn', v.questions.length + ' / ' + need + ' ' + t('ex.s.questions')) + '</div>' +
      (v.status === 'REJECTED' && v.rejectionReason ? '<div class="ex-note bad"><b>' + esc(t('ex.t.rejected_reason')) + ':</b> ' + esc(v.rejectionReason) + '</div>' : '') +
      (!v.editable ? '<div class="ex-note warn">' + esc(t('ex.t.readonly')) + '</div>' : '') +
      (v.editable ? '<div class="ex-toolbar"><button class="btn btn-primary" id="ex-t-add">+ ' + esc(t('ex.t.add')) + '</button><button class="btn btn-outline" id="ex-t-import">⬆ ' + esc(t('ex.t.import')) + '</button><button class="btn btn-outline" id="ex-t-tpl">⬇ ' + esc(t('ex.t.template')) + '</button><span style="flex:1"></span><button class="btn btn-primary" id="ex-t-submit"' + (v.questions.length < need ? ' disabled' : '') + '>' + esc(t('ex.t.submit')) + '</button></div>' : '') +
      (v.questions.length ? v.questions.map((q) => qCard(q, v.editable)).join('') : x.empty(t('ex.t.no_questions')));
    document.getElementById('ex-t-back').onclick = () => { cur = null; render(root.id); };
    if (v.editable) {
      document.getElementById('ex-t-add').onclick = () => questionModal(v, null);
      document.getElementById('ex-t-import').onclick = () => importModal(v);
      document.getElementById('ex-t-tpl').onclick = async () => { try { const b = await x.fetchBlob('/teacher/question-banks/import-template'); AP.tui.saveBlob(b, 'questions-template.csv'); } catch (e) { x.toast(x.errMsg(e), true); } };
      document.getElementById('ex-t-submit').onclick = async () => {
        const ok = await AP.tui.confirmDialog({ title: t('ex.t.submit'), message: t('ex.t.submit_text') });
        if (!ok) return;
        try { await x.api('/teacher/question-banks/versions/' + v.id + '/submit', { method: 'POST', body: {} }); x.toast(t('ex.t.submitted')); editor(c); } catch (e) { x.toast(x.errMsg(e), true); }
      };
      root.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => questionModal(v, v.questions.find((q) => q.id === b.dataset.edit))));
      root.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        const ok = await AP.tui.confirmDialog({ title: t('ex.t.delete'), message: t('ex.t.delete_text'), danger: true });
        if (!ok) return;
        try { await x.api('/teacher/question-banks/versions/' + v.id + '/questions/' + b.dataset.del, { method: 'DELETE' }); editor(c); } catch (e) { x.toast(x.errMsg(e), true); }
      }));
    }
  }

  function qCard(q, editable) {
    const x = X();
    return '<div class="ex-q"><div class="ex-row" style="justify-content:space-between"><b>#' + q.ordinal + '</b>' + (editable ? '<span><button class="btn btn-outline btn-sm" data-edit="' + esc(q.id) + '">' + esc(t('common.edit')) + '</button> <button class="btn btn-outline btn-sm" data-del="' + esc(q.id) + '">🗑</button></span>' : '') + '</div>' +
      '<div class="ex-rich">' + x.rich(q.body) + '</div>' + (q.image ? '<img class="ex-img" alt="" src="' + esc(q.image) + '">' : '') +
      q.options.map((o) => '<div class="ex-ans' + (o.label === q.correct ? ' ok' : '') + '"><b>' + o.label + ')</b> <span class="ex-rich">' + x.rich(o.body) + '</span>' + (o.label === q.correct ? ' ✓' : '') + '</div>').join('') + '</div>';
  }

  /** Модальное окно вопроса: форматирование, A–E, правильный ответ, изображение, предпросмотр */
  function questionModal(v, q) {
    const x = X();
    let image = q ? q.image || null : null;
    const opt = (l) => (q ? (q.options.find((o) => o.label === l) || {}).body || '' : '');
    const h = AP.tui.openModal({
      title: q ? t('ex.t.edit_q') + ' #' + q.ordinal : t('ex.t.add'), wide: true, static: true,
      html: '<div class="form-group"><div class="form-label">' + esc(t('ex.t.q_text')) + '</div>' +
        '<div class="ex-tool"><button type="button" data-w="**|**" title="bold"><b>B</b></button><button type="button" data-w="*|*" title="italic"><i>I</i></button><button type="button" data-w="^{|}" title="sup">x²</button><button type="button" data-w="_{|}" title="sub">x₂</button><button type="button" data-w="`|`" title="code">&lt;/&gt;</button></div>' +
        '<textarea class="input" id="ex-q-body" rows="4" maxlength="4000">' + esc(q ? q.body : '') + '</textarea><div class="ex-muted">' + esc(t('ex.t.format_hint')) + '</div></div>' +
        L5.map((l) => '<div class="ex-opt"><b>' + l + '</b><input class="input" id="ex-q-o' + l + '" maxlength="1000" value="' + esc(opt(l)) + '"><label class="tt-chk"><input type="radio" name="ex-q-ok" value="' + l + '"' + (q && q.correct === l ? ' checked' : '') + '> ' + esc(t('ex.t.correct')) + '</label></div>').join('') +
        '<div class="form-group" style="margin-top:10px"><div class="form-label">' + esc(t('ex.t.image')) + '</div><input type="file" id="ex-q-img" accept="image/png,image/jpeg,image/webp"> <button type="button" class="btn btn-outline btn-sm" id="ex-q-imgx" style="display:none">✕</button><div id="ex-q-imgp"></div></div>' +
        '<div class="form-label" style="margin-top:8px">' + esc(t('ex.t.preview')) + '</div><div class="ex-q" id="ex-q-prev"></div>',
      buttons: [
        { label: t('common.cancel'), cls: 'btn-outline' },
        { label: t('common.save'), cls: 'btn-primary', onClick: async () => {
          const body = h.$('#ex-q-body').value.trim(), correct = (h.$('input[name=ex-q-ok]:checked') || {}).value;
          if (!correct) { x.toast(t('ex.t.pick_correct'), true); return false; }
          const dto = { body, correct, options: L5.map((l) => ({ label: l, body: h.$('#ex-q-o' + l).value.trim() })), image };
          try {
            if (q) await x.api('/teacher/question-banks/versions/' + v.id + '/questions/' + q.id, { method: 'PUT', body: dto });
            else await x.api('/teacher/question-banks/versions/' + v.id + '/questions', { method: 'POST', body: dto });
            editor(cur);
          } catch (e) { x.toast(x.errMsg(e), true); return false; }
        } },
      ],
    });
    const prev = () => {
      const ok = (h.$('input[name=ex-q-ok]:checked') || {}).value;
      h.$('#ex-q-prev').innerHTML = '<div class="ex-rich">' + x.rich(h.$('#ex-q-body').value) + '</div>' + (image ? '<img class="ex-img" alt="" src="' + esc(image) + '">' : '') + L5.map((l) => '<div class="ex-ans' + (ok === l ? ' ok' : '') + '"><b>' + l + ')</b> <span class="ex-rich">' + x.rich(h.$('#ex-q-o' + l).value) + '</span></div>').join('');
      h.$('#ex-q-imgp').innerHTML = image ? '<img class="ex-img" alt="" src="' + esc(image) + '" style="max-height:90px">' : '';
      h.$('#ex-q-imgx').style.display = image ? '' : 'none';
    };
    h.el.addEventListener('input', prev); h.el.addEventListener('change', prev);
    h.el.querySelectorAll('.ex-tool [data-w]').forEach((b) => b.addEventListener('click', () => {
      const ta = h.$('#ex-q-body'), [a, z] = b.dataset.w.split('|'), s = ta.selectionStart, e = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + a + ta.value.slice(s, e) + z + ta.value.slice(e); ta.focus(); ta.setSelectionRange(s + a.length, e + a.length); prev();
    }));
    h.$('#ex-q-img').addEventListener('change', async (ev) => {
      const f = ev.target.files[0]; if (!f) return;
      if (f.size > 400 * 1024) { x.toast(t('ex.t.image_big'), true); ev.target.value = ''; return; }
      image = await x.fileToDataUrl(f); prev();
    });
    h.$('#ex-q-imgx').addEventListener('click', () => { image = null; h.$('#ex-q-img').value = ''; prev(); });
    prev();
  }

  function importModal(v) {
    const x = X();
    const h = AP.tui.openModal({
      title: t('ex.t.import'), wide: true,
      html: '<div class="ex-note info">' + esc(t('ex.t.import_hint')) + '</div><input type="file" id="ex-imp-file" accept=".csv,.xlsx"><div id="ex-imp-res" style="margin-top:12px"></div>',
      buttons: [
        { label: t('common.cancel'), cls: 'btn-outline' },
        { id: 'go', label: t('ex.t.import_go'), cls: 'btn-primary', onClick: async () => {
          const f = h.$('#ex-imp-file').files[0]; if (!f) { x.toast(t('ex.t.pick_file'), true); return false; }
          try {
            const b64 = await x.fileToB64(f);
            const dry = await x.api('/teacher/question-banks/versions/' + v.id + '/import', { method: 'POST', body: { fileName: f.name, contentBase64: b64, dryRun: true } });
            if (dry.errors.length) {
              h.$('#ex-imp-res').innerHTML = '<div class="ex-note bad"><b>' + esc(t('ex.t.import_errors').replace('{n}', dry.errors.length)) + '</b><ul class="ex-reasons">' + dry.errors.slice(0, 30).map((e) => '<li>' + esc(t('ex.t.row')) + ' ' + e.row + ': ' + esc(t('ex.err.' + e.code, e.code)) + '</li>').join('') + '</ul></div>';
              return false;
            }
            const done = await x.api('/teacher/question-banks/versions/' + v.id + '/import', { method: 'POST', body: { fileName: f.name, contentBase64: b64 } });
            x.toast(t('ex.t.imported').replace('{n}', done.imported)); editor(cur);
          } catch (e) { x.toast(x.errMsg(e), true); return false; }
        } },
      ],
    });
  }

  async function results() {
    const x = X(), body = document.getElementById('ex-t-body');
    let rows;
    try { rows = await x.api('/teacher/exam-results'); } catch (e) { body.innerHTML = x.errBox(e); return; }
    if (!rows.length) { body.innerHTML = x.empty(t('ex.t.no_results')); return; }
    body.innerHTML = '<div class="ex-note info">' + esc(t('ex.t.results_hint')) + '</div><div class="card"><div class="card-pad ex-scroll"><table class="ex-table"><thead><tr><th>' + esc(t('ex.col.student')) + '</th><th>ID</th><th>' + esc(t('ex.col.group')) + '</th><th>' + esc(t('ex.col.subject')) + '</th><th>' + esc(t('ex.res.exam')) + '</th><th>' + esc(t('ex.res.total')) + '</th><th>' + esc(t('ex.res.grade')) + '</th><th>' + esc(t('ex.col.status')) + '</th><th>' + esc(t('ex.col.date')) + '</th></tr></thead><tbody>' +
      rows.map((r) => '<tr><td>' + esc(r.student.fullName) + '</td><td><code>' + esc(r.student.loginId) + '</code></td><td>' + esc(r.student.groupName) + '</td><td>' + esc(r.subject ? r.subject.name : '') + '</td><td>' + x.num(r.examScore) + '</td><td>' + x.num(r.total) + '</td><td><span class="ex-letter ' + (r.letter === 'F' ? 'F' : '') + '">' + esc(r.letter) + '</span></td><td>' + x.chip(r.passed ? 'ok' : 'bad', t(r.passed ? 'ex.res.passed' : 'ex.res.failed')) + '</td><td>' + esc(x.fmtDate(r.date)) + '</td></tr>').join('') + '</tbody></table></div></div>';
  }

  AP.examsTeacher = { render };
})(window);
