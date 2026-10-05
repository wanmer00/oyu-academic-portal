// ============================================================
// Academic Portal — Academic Journal (ЕДИНЫЙ модуль для всех ролей)
//   STUDENT    — свой журнал (read-only, только опубликованное)
//   TEACHER    — журнал своих предмет×группа: таблица, быстрый ввод, детали, bulk, импорт, публикация
//   LEADERSHIP — обзор, аналитика, сравнение групп, блокировка периодов (read-only по оценкам)
//   IT_AUDITOR — read-only история изменений
// Все расчёты и права — на backend. Фронтенд только отображает готовые значения.
// ============================================================
(function (global) {
  'use strict';
  const AP = (global.AP = global.AP || {});

  const t = (k, fb) => AP.i18n.t(k, fb);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tui = () => AP.tui;
  const api = () => AP.api.journal;

  const fmt = (n) => (n == null ? '—' : String(Math.round(Number(n) * 100) / 100));
  const fmt2 = (n) => (n == null ? '—' : Number(n).toFixed(2));
  const pctTxt = (n) => (n == null ? '—' : Math.round(n) + '%');
  const debounce = (fn, ms) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };

  // ───────────────────────── toast (единый для всех оболочек) ─────────────────────────
  function toast(msg, isErr) {
    let el = document.getElementById('jr-toast');
    if (!el) { el = document.createElement('div'); el.id = 'jr-toast'; el.className = 'jr-toast'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); document.body.appendChild(el); }
    el.textContent = msg; el.classList.toggle('err', !!isErr); el.classList.add('show');
    clearTimeout(el._h); el._h = setTimeout(() => el.classList.remove('show'), 3200);
  }

  function errText(e) {
    if (e && e.networkError) return t('journal.err.network');
    const code = e && e.body && e.body.code;
    const map = {
      PERIOD_CLOSED: 'journal.err.period_closed', REASON_REQUIRED: 'journal.err.reason_required', SCORE_OUT_OF_RANGE: 'journal.err.score_range',
      CONFIRMATION_REQUIRED: 'journal.err.confirm_required', IMPORT_INVALID: 'journal.err.import_invalid', TOO_MANY_ANSWERS: 'journal.err.too_many', PERIOD_UNKNOWN: 'journal.err.period_unknown', FUTURE_DATE: 'journal.err.future_date',
    };
    if (code && map[code]) return t(map[code]);
    if (e && e.status === 403) return t('journal.err.forbidden');
    if (e && e.status === 404) return t('journal.err.not_found');
    if (e && e.status === 429) return t('journal.err.rate');
    return (e && e.message) || t('common.error');
  }

  // ───────────────────────── общие визуальные элементы ─────────────────────────
  const termLabel = (term) => t('journal.term.' + term, term);
  const periodLabel = (p) => p.academicYear + ' · ' + termLabel(p.term);
  const statusChip = (s) => '<span class="jr-chip jr-st-' + String(s).toLowerCase() + '">' + esc(t('journal.status.' + s, s)) + '</span>';
  const alertChip = (a) => '<span class="jr-alert jr-al-' + a.toLowerCase() + '" title="' + esc(t('journal.alert.' + a, a)) + '">' + esc(t('journal.alert.' + a, a)) + '</span>';
  const bar = (v, max) => '<div class="jr-bar" role="progressbar" aria-valuemin="0" aria-valuemax="' + max + '" aria-valuenow="' + (v == null ? 0 : v) + '"><i style="width:' + Math.max(0, Math.min(100, max ? ((v || 0) / max) * 100 : 0)) + '%"></i></div>';
  const draftDot = (c) => (c && c.published === false ? '<span class="jr-dot" title="' + esc(t('journal.draft')) + '"></span>' : '');

  const compCell = (c, max) => (c ? '<span class="jr-score"><b>' + fmt(c.score) + '</b><i>/' + max + '</i></span>' + draftDot(c) : '<span class="jr-none">—</span>');
  function seminarCell(s) {
    if (s.eligible) return '<span class="jr-score" title="' + esc(s.answers ? s.answers.map((a) => a.score).join(' · ') : '') + '"><b>' + fmt(s.score) + '</b><i>/' + s.max + '</i></span>' + ((s.answers || []).some((a) => a.published === false) ? '<span class="jr-dot" title="' + esc(t('journal.draft')) + '"></span>' : '');
    return '<span class="jr-pend" title="' + esc(t('journal.seminar_need')) + '">' + esc(t('journal.pending')) + '</span><small class="jr-sub">' + s.count + ' / ' + s.required + '</small>';
  }
  const totalCell = (tt) => (tt.final
    ? '<span class="jr-score jr-total"><b>' + fmt(tt.score) + '</b><i>/' + tt.max + '</i></span>'
    : '<span class="jr-score jr-prov" title="' + esc(t('journal.provisional_hint')) + '"><b>' + fmt(tt.score) + '</b><i>/' + tt.max + '</i></span><small class="jr-sub">' + esc(t('journal.provisional')) + '</small>');

  function card(label, value, sub, cls) {
    return '<div class="jr-kpi ' + (cls || '') + '"><div class="jr-kpi-v">' + value + '</div><div class="jr-kpi-l">' + esc(label) + '</div>' + (sub ? '<div class="jr-kpi-s">' + sub + '</div>' : '') + '</div>';
  }

  function pager(page, pageSize, total, id) {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    return '<div class="jr-pager"><span class="jr-muted">' + esc(t('journal.total_n').replace('{n}', total)) + '</span><span class="jr-spacer"></span>' +
      '<button class="jr-btn" data-pg="' + id + '" data-dir="-1" ' + (page <= 1 ? 'disabled' : '') + '>‹</button><span class="jr-muted">' + page + ' / ' + pages + '</span>' +
      '<button class="jr-btn" data-pg="' + id + '" data-dir="1" ' + (page >= pages ? 'disabled' : '') + '>›</button></div>';
  }

  function askReason(titleKey, hintKey) {
    return new Promise((resolve) => {
      let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
      openJrModal({
        title: t(titleKey || 'journal.reason_title'),
        html: '<div class="jr-note">' + esc(t(hintKey || 'journal.reason_hint')) + '</div><input class="jr-input" id="jr-reason" maxlength="500" placeholder="' + esc(t('journal.reason_ph')) + '" style="width:100%">',
        static: true,
        onClose: () => fin(null),
        buttons: [
          { label: t('common.cancel'), cls: 'btn-outline', onClick: () => { fin(null); } },
          { id: 'ok', label: t('common.save'), cls: 'btn-purple', keep: true, onClick: (h) => { const v = h.$('#jr-reason').value.trim(); if (v.length < 3) { h.$('#jr-reason').focus(); return false; } fin(v); h.close(); return false; } },
        ],
      });
    });
  }

  // Модалки рендерятся в <body>, вне корня .jr — даём телу модалки класс jr, чтобы работали переменные и стили модуля
  function openJrModal(opts) { const h = tui().openModal(opts); h.body.classList.add('jr'); return h; }

  function skeleton(n) { return tui().skeleton(n || 4); }
  async function guarded(el, fn) {
    el.innerHTML = skeleton(4);
    try { await fn(); } catch (e) {
      el.innerHTML = tui().errorBox(errText(e), 'jr-retry');
      const b = el.querySelector('#jr-retry'); if (b) b.addEventListener('click', () => guarded(el, fn));
    }
  }

  function periodSelect(ctx, id) {
    const ps = (ctx.meta.periods || []).slice();
    return '<select class="jr-input" id="' + id + '" aria-label="' + esc(t('journal.period')) + '">' + ps.map((p) => {
      const sel = ctx.period.academicYear === p.academicYear && ctx.period.term === p.term ? ' selected' : '';
      return '<option value="' + esc(p.academicYear + '|' + p.term) + '"' + sel + '>' + esc(periodLabel(p) + (p.status === 'CLOSED' ? ' 🔒' : '')) + '</option>';
    }).join('') + '</select>';
  }
  function bindPeriod(ctx, id, onChange) {
    const el = ctx.root.querySelector('#' + id); if (!el) return;
    el.addEventListener('change', () => { const [y, tm] = el.value.split('|'); ctx.period = { academicYear: y, term: tm }; onChange(); });
  }
  const currentPeriodStatus = (ctx) => { const p = (ctx.meta.periods || []).find((x) => x.academicYear === ctx.period.academicYear && x.term === ctx.period.term); return p ? p.status : 'OPEN'; };
  const periodBadge = (ctx) => (currentPeriodStatus(ctx) === 'CLOSED' ? '<span class="jr-chip jr-st-locked">🔒 ' + esc(t('journal.period_closed')) + '</span>' : '<span class="jr-chip jr-st-open">' + esc(t('journal.period_open')) + '</span>');

  // Заголовок страницы («Academic Journal») уже показывает оболочка (page-title); здесь — описание роли и бейдж
  function header(ctx, subtitleKey) {
    return '<div class="jr-head"><div class="jr-muted">' + esc(t(subtitleKey)) + '</div><div class="jr-head-r"><span class="jr-role">' + esc(t('journal.role.' + ctx.role, ctx.role)) + '</span></div></div>';
  }

  // ═════════════════════════════ STUDENT ═════════════════════════════
  // Посещаемость студента (своя): лимиты по предметам + журнал отметок. Источник — Attendance внутри Academic Journal.
  function studentAttendanceView(ctx) {
    const root = ctx.root;
    root.innerHTML = header(ctx, 'journal.sub.student') + '<div class="jr-bar-row">' + periodSelect(ctx, 'jr-period') + '<span class="jr-spacer"></span><button class="jr-btn" id="jr-refresh">↻ ' + esc(t('journal.refresh')) + '</button></div><div id="jr-body"></div>';
    bindPeriod(ctx, 'jr-period', load);
    root.querySelector('#jr-refresh').addEventListener('click', load);
    const body = root.querySelector('#jr-body');
    const COLOR = { OK: '#10b981', WARNING: '#f59e0b', CRITICAL: '#fb923c', EXCEEDED: '#ef4444' };
    function load() {
      return guarded(body, async () => { ctx.attData = await api().attendance.student(Object.assign({}, ctx.period, ctx.childId ? { studentId: ctx.childId } : {})); paint(); });
    }
    function paint() {
      const d = ctx.attData; const tt = d.totals;
      if (!d.subjects.length) { body.innerHTML = tui().emptyBox(t('journal.student.empty')); return; }
      body.innerHTML =
        '<div class="jr-cards">' + card(t('journal.card.attendance'), pctTxt(tt.rate)) + card(t('journal.att.PRESENT'), tt.present) + card(t('journal.att.LATE'), tt.late) + card(t('journal.att.ABSENT'), tt.absent, '', tt.absent ? 'warn' : '') + card(t('journal.att.EXCUSED'), tt.excused) + '</div>' +
        '<div class="jr-note">' + esc(t('attendance.limit_note')) + '</div>' +
        '<div class="jr-card">' + d.subjects.map((s) => {
          const c = COLOR[s.status] || '#64748b';
          return '<div class="jr-att-row"><div class="jr-att-n"><b>' + esc(s.subject.name) + '</b><div class="jr-muted">' + esc(s.subject.code) + ' · ' + esc(t('journal.col.attendance')) + ': ' + pctTxt(s.rate) + ' (' + s.total + ')</div>' +
            '<div class="jr-bar"><i style="width:' + Math.min(100, s.percentage) + '%;background:' + c + '"></i></div></div>' +
            '<div class="jr-att-ch"><span class="jr-chip" style="color:' + c + '">' + esc(t('attendance.limit_status_' + String(s.status).toLowerCase(), s.status)) + '</span> <span class="jr-muted">' + esc(t('attendance.counted')) + ': <b>' + s.counted + ' / ' + s.max + '</b> · ' + esc(t('attendance.remaining')) + ': <b>' + s.remaining + '</b></span></div></div>' +
            (s.records.length ? '<div class="jr-pills">' + s.records.map((r) => '<span class="jr-pill jr-ab-' + r.status.toLowerCase() + '" title="' + esc(t('journal.att.' + r.status)) + '">' + esc(r.date.slice(5)) + ' · ' + esc(t('journal.att.' + r.status)) + '</span>').join('') + '</div>' : '');
        }).join('') + '</div>';
    }
    load();
  }

  function studentView(ctx) {
    if (ctx.initialMode === 'attendance') return studentAttendanceView(ctx);
    const root = ctx.root;
    root.innerHTML = header(ctx, 'journal.sub.student') + '<div class="jr-bar-row">' + periodSelect(ctx, 'jr-period') + '<span id="jr-pbadge">' + periodBadge(ctx) + '</span><span class="jr-spacer"></span><button class="jr-btn" id="jr-refresh">↻ ' + esc(t('journal.refresh')) + '</button></div><div id="jr-body"></div>';
    bindPeriod(ctx, 'jr-period', load);
    root.querySelector('#jr-refresh').addEventListener('click', load);
    const body = root.querySelector('#jr-body');

    function load() {
      root.querySelector('#jr-pbadge').innerHTML = periodBadge(ctx);
      return guarded(body, async () => { ctx.data = await api().me(ctx.period); paint(); });
    }
    function paint() {
      const d = ctx.data; const c = d.cards; const items = d.items || [];
      if (!items.length) { body.innerHTML = tui().emptyBox(t('journal.student.empty')); return; }
      body.innerHTML =
        '<div class="jr-cards">' +
          card(t('journal.card.gpa'), c.gpa == null ? '—' : fmt2(c.gpa), c.semesterGpa != null ? esc(t('journal.card.sem_gpa')) + ': ' + fmt2(c.semesterGpa) : '') +
          card(t('journal.card.avg_score'), c.averageScore == null ? '—' : fmt(c.averageScore) + '<small> / 100</small>') +
          card(t('journal.card.attendance'), pctTxt(c.attendance)) +
          card(t('journal.card.completed'), c.completedSubjects + '<small> / ' + c.totalSubjects + '</small>') +
        '</div>' +
        '<div class="jr-note">' + esc(t('journal.formula_note')) + '</div>' +
        '<div class="jr-card jr-tablewrap"><table class="jr-table" id="jr-tbl"><thead><tr><th>' + esc(t('journal.col.subject')) + '</th><th>' + esc(t('journal.col.final')) + ' <small>/50</small></th><th>' + esc(t('journal.col.midterm')) + ' <small>/30</small></th><th>' + esc(t('journal.col.seminar')) + ' <small>/20</small></th><th>' + esc(t('journal.col.total')) + ' <small>/100</small></th><th>' + esc(t('journal.col.attendance')) + '</th><th>' + esc(t('journal.col.status')) + '</th></tr></thead><tbody>' +
        items.map((i) => '<tr class="jr-row" tabindex="0" data-sid="' + esc(i.subject.id) + '">' +
          '<td data-l="' + esc(t('journal.col.subject')) + '"><b>' + esc(i.subject.name) + '</b><div class="jr-muted">' + esc(i.subject.code) + '</div></td>' +
          '<td data-l="' + esc(t('journal.col.final')) + '">' + compCell(i.final, 50) + '</td>' +
          '<td data-l="' + esc(t('journal.col.midterm')) + '">' + compCell(i.midterm, 30) + '</td>' +
          '<td data-l="' + esc(t('journal.col.seminar')) + '">' + seminarCell(i.seminar) + '</td>' +
          '<td data-l="' + esc(t('journal.col.total')) + '">' + totalCell(i.total) + (i.letter ? ' <span class="jr-letter">' + esc(i.letter) + '</span>' : '') + '</td>' +
          '<td data-l="' + esc(t('journal.col.attendance')) + '">' + (i.attendance ? pctTxt(i.attendance.rate) : '—') + '</td>' +
          '<td data-l="' + esc(t('journal.col.status')) + '">' + statusChip(i.status) + '</td></tr>').join('') +
        '</tbody></table></div>';
      body.querySelectorAll('.jr-row').forEach((r) => {
        const open = () => studentDetail(ctx, r.dataset.sid);
        r.addEventListener('click', open);
        r.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
      });
    }
    load();
  }

  async function studentDetail(ctx, subjectId) {
    const m = openJrModal({ title: t('journal.detail'), html: skeleton(4), wide: true, buttons: [{ label: t('common.close'), cls: 'btn-outline' }] });
    try {
      const d = await api().meSubject(subjectId, ctx.period);
      const s = d.seminar;
      m.body.innerHTML =
        '<div class="jr-dhead"><div><div class="jr-dtitle">' + esc(d.subject.name) + '</div><div class="jr-muted">' + esc(d.subject.code) + ' · ' + esc(periodLabel(d.period)) + '</div></div><div>' + statusChip(d.status) + '</div></div>' +
        '<div class="jr-grid3">' +
          '<div class="jr-block"><div class="jr-bl">' + esc(t('journal.col.final')) + '</div><div class="jr-bv">' + (d.final ? '<b>' + fmt(d.final.score) + '</b> / 50' : '<span class="jr-none">—</span>') + '</div>' + bar(d.final ? d.final.score : 0, 50) + '</div>' +
          '<div class="jr-block"><div class="jr-bl">' + esc(t('journal.col.midterm')) + '</div><div class="jr-bv">' + (d.midterm ? '<b>' + fmt(d.midterm.score) + '</b> / 30' : '<span class="jr-none">—</span>') + '</div>' + bar(d.midterm ? d.midterm.score : 0, 30) + '</div>' +
          '<div class="jr-block"><div class="jr-bl">' + esc(t('journal.col.seminar')) + '</div><div class="jr-bv">' + (s.eligible ? '<b>' + fmt(s.score) + '</b> / 20' : '<span class="jr-pend">' + esc(t('journal.pending')) + '</span>') + '</div>' + bar(s.eligible ? s.score : 0, 20) + '</div>' +
        '</div>' +
        '<div class="jr-block jr-seminar"><div class="jr-bl">' + esc(t('journal.seminar_progress')) + '</div>' +
          '<div class="jr-kvs"><span>' + esc(t('journal.required')) + '</span><b>' + s.required + ' ' + esc(t('journal.answers')) + '</b></div>' +
          '<div class="jr-kvs"><span>' + esc(t('journal.completed')) + '</span><b>' + s.count + ' ' + esc(t('journal.answers')) + '</b></div>' +
          '<div class="jr-kvs"><span>' + esc(t('journal.progress')) + '</span><b>' + Math.min(s.count, s.required) + ' / ' + s.required + '</b></div>' + bar(Math.min(s.count, s.required), s.required) +
          (s.answers.length ? '<div class="jr-answers">' + s.answers.map((a, i) => '<div class="jr-ans"><span>' + esc(t('journal.answer')) + ' ' + (i + 1) + '</span><b>' + fmt(a.score) + ' / ' + a.max + '</b></div>').join('') + '</div>' : '<div class="jr-muted">' + esc(t('journal.no_answers')) + '</div>') +
          (s.count ? '<div class="jr-kvs"><span>' + esc(t('journal.average')) + '</span><b>' + fmt2(s.average) + '</b></div>' : '') +
          '<div class="jr-kvs"><span>' + esc(t('journal.seminar_score')) + '</span><b>' + (s.eligible ? fmt(s.score) + ' / 20' : esc(t('journal.pending')) + ' — ' + esc(t('journal.seminar_missing').replace('{n}', s.missing))) + '</b></div>' +
        '</div>' +
        '<div class="jr-totalbox ' + (d.total.final ? 'final' : 'prov') + '"><span>' + esc(t('journal.col.total')) + '</span><b>' + fmt(d.total.score) + ' / 100</b>' + (d.total.final ? (d.letter ? '<span class="jr-letter">' + esc(d.letter) + '</span>' : '') : '<em>' + esc(t('journal.provisional')) + '</em>') + '</div>' +
        '<div class="jr-kvs"><span>' + esc(t('journal.col.attendance')) + '</span><b>' + (d.attendance ? pctTxt(d.attendance.rate) + ' (' + (d.attendance.total - d.attendance.absent) + '/' + d.attendance.total + ')' : '—') + '</b></div>' +
        (d.alerts.length ? '<div class="jr-alerts">' + d.alerts.map(alertChip).join('') + '</div>' : '') +
        '<div class="jr-hist-t">' + esc(t('journal.history')) + '</div>' +
        (d.history.length ? '<div class="jr-tablewrap"><table class="jr-table jr-mini"><thead><tr><th>' + esc(t('journal.when')) + '</th><th>' + esc(t('journal.component')) + '</th><th>' + esc(t('journal.change')) + '</th><th>' + esc(t('journal.reason')) + '</th></tr></thead><tbody>' +
          d.history.map((h) => '<tr><td>' + esc(String(h.at).slice(0, 16).replace('T', ' ')) + '</td><td>' + esc(t('journal.comp.' + h.component, h.component)) + '</td><td>' + fmt(h.old) + ' → <b>' + fmt(h.new) + '</b></td><td>' + esc(h.reason || '—') + '</td></tr>').join('') + '</tbody></table></div>' : '<div class="jr-muted">' + esc(t('journal.no_history')) + '</div>');
    } catch (e) { m.body.innerHTML = tui().errorBox(errText(e)); }
  }

  // ═════════════════════════════ TEACHER ═════════════════════════════
  function teacherView(ctx) {
    const root = ctx.root;
    const scope = ctx.meta.scope || { subjects: [], groups: [], pairs: [], faculties: [] };
    // Класс, выбранный на странице «Мои классы» (общий ключ sessionStorage с остальными страницами преподавателя)
    const fromClasses = () => { try { const [code, group] = (sessionStorage.getItem('ap_t_class') || '').split('|'); const s = scope.subjects.find((x) => x.code === code); return s && scope.pairs.some((p) => p.subjectId === s.id && p.groupName === group) ? { subjectId: s.id, groupName: group } : {}; } catch { return {}; } };
    const S = ctx.state = ctx.state || Object.assign({ subjectId: '', groupName: '', faculty: '', status: '', search: '', page: 1, mode: ctx.initialMode || 'table', selected: new Set() }, fromClasses());
    const rememberPair = () => { try { const s = scope.subjects.find((x) => x.id === S.subjectId); if (s && S.groupName) sessionStorage.setItem('ap_t_class', s.code + '|' + S.groupName); } catch { /* ignore */ } };
    const groupsFor = (sid) => (sid ? Array.from(new Set(scope.pairs.filter((p) => p.subjectId === sid).map((p) => p.groupName))) : scope.groups).sort();

    root.innerHTML = header(ctx, 'journal.sub.teacher') +
      '<div class="jr-bar-row">' + periodSelect(ctx, 'jr-period') + '<span id="jr-pbadge">' + periodBadge(ctx) + '</span>' +
        '<select class="jr-input" id="jr-subject" aria-label="' + esc(t('journal.filter.subject')) + '"><option value="">' + esc(t('journal.filter.all_subjects')) + '</option>' + scope.subjects.map((s) => '<option value="' + esc(s.id) + '">' + esc(s.code + ' · ' + s.name) + '</option>').join('') + '</select>' +
        '<select class="jr-input" id="jr-group" aria-label="' + esc(t('journal.filter.group')) + '"></select>' +
        (scope.faculties && scope.faculties.length > 1 ? '<select class="jr-input" id="jr-faculty"><option value="">' + esc(t('journal.filter.all_faculties')) + '</option>' + scope.faculties.map((f) => '<option>' + esc(f) + '</option>').join('') + '</select>' : '') +
        '<select class="jr-input" id="jr-status"><option value="">' + esc(t('journal.filter.all_statuses')) + '</option>' + ['PROVISIONAL', 'READY', 'PUBLISHED', 'LOCKED'].map((s) => '<option value="' + s + '">' + esc(t('journal.status.' + s)) + '</option>').join('') + '</select>' +
        '<input class="jr-input jr-grow" id="jr-search" type="search" placeholder="' + esc(t('journal.filter.search')) + '">' +
      '</div>' +
      '<div id="jr-cards" class="jr-cards"></div>' +
      '<div class="jr-toolbar">' +
        '<div class="jr-seg" role="tablist"><button class="jr-segb" data-mode="table" role="tab">' + esc(t('journal.mode.table')) + '</button><button class="jr-segb" data-mode="grid" role="tab">' + esc(t('journal.mode.grid')) + '</button><button class="jr-segb" data-mode="attendance" role="tab">' + esc(t('journal.mode.attendance')) + '</button></div>' +
        '<span class="jr-spacer"></span>' +
        '<button class="jr-btn" id="jr-bulk">☑ ' + esc(t('journal.bulk')) + '</button>' +
        '<button class="jr-btn jr-primary" id="jr-publish">📢 ' + esc(t('journal.publish')) + '</button>' +
        '<button class="jr-btn" id="jr-unpublish">↩ ' + esc(t('journal.unpublish')) + '</button>' +
        '<button class="jr-btn" id="jr-import">⬆ ' + esc(t('journal.import')) + '</button>' +
        '<button class="jr-btn" id="jr-export">⬇ ' + esc(t('journal.export')) + '</button>' +
        '<button class="jr-btn" id="jr-export-a">⬇ ' + esc(t('journal.export_answers')) + '</button>' +
      '</div>' +
      '<div id="jr-body"></div>';

    const $ = (s) => root.querySelector(s);
    const body = $('#jr-body');
    const fillGroups = () => { const gs = groupsFor(S.subjectId); if (S.groupName && !gs.includes(S.groupName)) S.groupName = ''; $('#jr-group').innerHTML = '<option value="">' + esc(t('journal.filter.all_groups')) + '</option>' + gs.map((g) => '<option' + (g === S.groupName ? ' selected' : '') + '>' + esc(g) + '</option>').join(''); };
    $('#jr-subject').value = S.subjectId; fillGroups(); $('#jr-status').value = S.status; $('#jr-search').value = S.search;
    if ($('#jr-faculty')) $('#jr-faculty').value = S.faculty;

    const paired = () => S.subjectId && S.groupName;
    const params = () => Object.assign({}, ctx.period, { subjectId: S.subjectId, groupName: S.groupName, faculty: S.faculty, status: S.status, search: S.search, page: S.page, pageSize: S.mode === 'grid' ? 100 : 25 });
    const ctxBody = () => ({ subjectId: S.subjectId, groupName: S.groupName, academicYear: ctx.period.academicYear, term: ctx.period.term });
    const reload = () => { S.selected.clear(); rememberPair(); return load(); };

    bindPeriod(ctx, 'jr-period', () => { S.page = 1; reload(); });
    $('#jr-subject').addEventListener('change', (e) => { S.subjectId = e.target.value; S.groupName = ''; fillGroups(); S.page = 1; reload(); });
    $('#jr-group').addEventListener('change', (e) => { S.groupName = e.target.value; S.page = 1; reload(); });
    if ($('#jr-faculty')) $('#jr-faculty').addEventListener('change', (e) => { S.faculty = e.target.value; S.page = 1; reload(); });
    $('#jr-status').addEventListener('change', (e) => { S.status = e.target.value; S.page = 1; reload(); });
    $('#jr-search').addEventListener('input', debounce((e) => { S.search = e.target.value.trim(); S.page = 1; reload(); }, 350));
    root.querySelectorAll('.jr-segb').forEach((b) => b.addEventListener('click', () => { S.mode = b.dataset.mode; S.page = 1; reload(); }));

    function syncToolbar() {
      root.querySelectorAll('.jr-segb').forEach((b) => { const on = b.dataset.mode === S.mode; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
      const closed = currentPeriodStatus(ctx) === 'CLOSED';
      const need = (id, ok, why) => { const b = $(id); b.disabled = !ok; b.title = ok ? '' : t(why); };
      need('#jr-publish', paired() && !closed, closed ? 'journal.hint.closed' : 'journal.hint.pick_pair');
      need('#jr-unpublish', paired() && !closed, closed ? 'journal.hint.closed' : 'journal.hint.pick_pair');
      need('#jr-import', paired() && !closed, closed ? 'journal.hint.closed' : 'journal.hint.pick_pair');
      need('#jr-bulk', paired() && !closed && S.selected.size > 0, closed ? 'journal.hint.closed' : paired() ? 'journal.hint.select_students' : 'journal.hint.pick_pair');
      $('#jr-pbadge').innerHTML = periodBadge(ctx);
      // в режиме посещаемости оценочные действия скрыты
      const att = S.mode === 'attendance';
      ['#jr-publish', '#jr-unpublish', '#jr-import', '#jr-bulk', '#jr-export', '#jr-export-a', '#jr-faculty', '#jr-status'].forEach((sel) => { const e = $(sel); if (e) e.style.display = att ? 'none' : ''; });
    }

    async function load() {
      syncToolbar();
      if (S.mode === 'attendance') { $('#jr-cards').innerHTML = ''; return attendanceView(); }
      if (S.mode === 'grid' && !paired()) { $('#jr-cards').innerHTML = ''; body.innerHTML = tui().emptyBox(t('journal.hint.grid_pick')); return; }
      return guarded(body, async () => {
        const d = await api().records(params());
        ctx.data = d; paint();
      });
    }

    function paintCards() {
      const s = ctx.data.summary;
      $('#jr-cards').innerHTML =
        card(t('journal.card.students'), s.students) +
        card(t('journal.card.average'), s.averageTotal == null ? '—' : fmt(s.averageTotal) + '<small> / 100</small>') +
        card(t('journal.card.missing'), s.missingGrades, '', s.missingGrades ? 'warn' : '') +
        card(t('journal.card.provisional'), s.provisional, s.seminarIncomplete ? esc(t('journal.card.seminar_lt3')).replace('{n}', s.seminarIncomplete) : '', s.provisional ? 'warn' : '') +
        card(t('journal.card.ready'), s.ready, '', s.ready ? 'info' : '') +
        card(t('journal.card.published'), s.published);
    }

    function paint() {
      paintCards(); syncToolbar();
      const d = ctx.data;
      if (!d.items.length) { body.innerHTML = tui().emptyBox(t('journal.empty')); return; }
      if (S.mode === 'grid') return paintGrid();
      const showSubject = !S.subjectId;
      body.innerHTML =
        '<div class="jr-card jr-tablewrap"><table class="jr-table" id="jr-tbl"><thead><tr><th style="width:34px"><input type="checkbox" id="jr-all" class="jr-cb" aria-label="all"></th><th>' + esc(t('journal.col.student')) + '</th>' + (showSubject ? '<th>' + esc(t('journal.col.subject')) + '</th>' : '') +
        '<th>' + esc(t('journal.col.seminar')) + ' <small>/20</small></th><th>' + esc(t('journal.col.midterm')) + ' <small>/30</small></th><th>' + esc(t('journal.col.final')) + ' <small>/50</small></th><th>' + esc(t('journal.col.total')) + ' <small>/100</small></th><th>' + esc(t('journal.col.attendance')) + '</th><th>' + esc(t('journal.col.status')) + '</th></tr></thead><tbody>' +
        d.items.map((r) => '<tr class="jr-row" tabindex="0" data-k="' + esc(r.key) + '">' +
          '<td><input type="checkbox" class="jr-cb jr-sel" data-sid="' + esc(r.student.id) + '"' + (S.selected.has(r.student.id) ? ' checked' : '') + ' aria-label="select"' + (paired() ? '' : ' disabled') + '></td>' +
          '<td data-l="' + esc(t('journal.col.student')) + '"><b>' + esc(r.student.fullName) + '</b><div class="jr-muted">' + esc(r.student.loginId) + ' · ' + esc(r.student.groupName) + '</div></td>' +
          (showSubject ? '<td data-l="' + esc(t('journal.col.subject')) + '">' + esc(r.subject.code) + '</td>' : '') +
          '<td data-l="' + esc(t('journal.col.seminar')) + '">' + seminarCell(r.seminar) + '</td>' +
          '<td data-l="' + esc(t('journal.col.midterm')) + '">' + compCell(r.midterm, 30) + '</td>' +
          '<td data-l="' + esc(t('journal.col.final')) + '">' + compCell(r.final, 50) + '</td>' +
          '<td data-l="' + esc(t('journal.col.total')) + '">' + totalCell(r.total) + '</td>' +
          '<td data-l="' + esc(t('journal.col.attendance')) + '">' + (r.attendance ? pctTxt(r.attendance.rate) : '—') + '</td>' +
          '<td data-l="' + esc(t('journal.col.status')) + '">' + statusChip(r.status) + (r.alerts.filter((a) => a !== 'PROVISIONAL' && a !== 'UNPUBLISHED').length ? ' <span class="jr-warn" title="' + esc(r.alerts.map((a) => t('journal.alert.' + a)).join(' · ')) + '">⚠</span>' : '') + '</td></tr>').join('') +
        '</tbody></table></div>' + pager(S.page, d.pageSize, d.total, 'main');
      const byKey = new Map(d.items.map((r) => [r.key, r]));
      body.querySelectorAll('.jr-row').forEach((row) => {
        const open = () => { const r = byKey.get(row.dataset.k); teacherDetail(ctx, r.student.id, r.subject.id, () => load()); };
        row.addEventListener('click', (e) => { if (e.target.closest('.jr-cb')) return; open(); });
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.target.closest('.jr-cb')) open(); });
      });
      body.querySelectorAll('.jr-sel').forEach((cb) => cb.addEventListener('change', () => { cb.checked ? S.selected.add(cb.dataset.sid) : S.selected.delete(cb.dataset.sid); syncToolbar(); }));
      const all = body.querySelector('#jr-all'); if (all) all.addEventListener('change', () => { body.querySelectorAll('.jr-sel:not(:disabled)').forEach((cb) => { cb.checked = all.checked; all.checked ? S.selected.add(cb.dataset.sid) : S.selected.delete(cb.dataset.sid); }); syncToolbar(); });
      bindPager(body, (dir) => { S.page += dir; load(); });
    }

    // ───────── Quick entry grid ─────────
    function paintGrid() {
      const d = ctx.data; const items = d.items;
      const maxAns = Math.max(3, ...items.map((r) => r.seminar.answers.length)) + 1;
      const closed = currentPeriodStatus(ctx) === 'CLOSED';
      const dis = closed ? ' disabled' : '';
      const cell = (r, ri, ci, kind, val, aid, pub) => '<input class="jr-cellin" inputmode="decimal" autocomplete="off" data-r="' + ri + '" data-c="' + ci + '" data-key="' + esc(r.key) + '" data-kind="' + kind + '" data-aid="' + esc(aid || '') + '" data-pub="' + (pub ? 1 : 0) + '" data-orig="' + (val == null ? '' : val) + '" value="' + (val == null ? '' : val) + '"' + dis + ' aria-label="' + esc(t('journal.comp.' + kind) + ' ' + r.student.fullName) + '">';
      const head = '<th class="jr-sticky">' + esc(t('journal.col.student')) + '</th>' + Array.from({ length: maxAns }, (_, i) => '<th>' + esc(t('journal.sem_short')) + (i + 1) + '</th>').join('') +
        '<th>' + esc(t('journal.col.midterm')) + '<small>/30</small></th><th>' + esc(t('journal.col.final')) + '<small>/50</small></th><th>' + esc(t('journal.col.seminar')) + '<small>/20</small></th><th>' + esc(t('journal.col.total')) + '<small>/100</small></th><th>' + esc(t('journal.col.status')) + '</th>';
      body.innerHTML = '<div class="jr-note">' + esc(t('journal.grid.help')) + '</div><div class="jr-card jr-tablewrap"><table class="jr-table jr-grid" id="jr-grid"><thead><tr>' + head + '</tr></thead><tbody>' +
        items.map((r, ri) => {
          const cols = [];
          for (let i = 0; i < maxAns; i++) { const a = r.seminar.answers[i]; cols.push('<td>' + cell(r, ri, i, 'SEMINAR', a ? a.score : null, a ? a.id : '', a ? a.published : false) + '</td>'); }
          cols.push('<td>' + cell(r, ri, maxAns, 'MIDTERM', r.midterm ? r.midterm.score : null, r.midterm ? r.midterm.id : '', r.midterm ? r.midterm.published : false) + '</td>');
          cols.push('<td>' + cell(r, ri, maxAns + 1, 'FINAL', r.final ? r.final.score : null, r.final ? r.final.id : '', r.final ? r.final.published : false) + '</td>');
          return '<tr data-key="' + esc(r.key) + '"><td class="jr-sticky"><b>' + esc(r.student.fullName) + '</b><div class="jr-muted">' + esc(r.student.loginId) + '</div></td>' + cols.join('') + gridCalc(r) + '</tr>';
        }).join('') + '</tbody></table></div>';
      bindGrid(maxAns);
    }
    const gridCalc = (r) => '<td class="jr-calc" data-calc="sem">' + seminarCell(r.seminar) + '</td><td class="jr-calc" data-calc="tot">' + totalCell(r.total) + '</td><td class="jr-calc" data-calc="st">' + statusChip(r.status) + '</td>';

    function bindGrid(maxAns) {
      const table = body.querySelector('#jr-grid');
      const focusRC = (r, c) => { const el = table.querySelector('.jr-cellin[data-r="' + r + '"][data-c="' + c + '"]'); if (el) { el.focus(); el.select(); return true; } return false; };
      table.addEventListener('focusin', (e) => { if (e.target.classList.contains('jr-cellin')) e.target.select(); });
      // Сохранения идут строго по очереди, а фокус переходит сразу — быстрый набор не теряет и не склеивает значения
      let chain = Promise.resolve();
      const enqueue = (el) => { chain = chain.then(() => commit(el)).catch(() => {}); return chain; };
      table.addEventListener('keydown', (e) => {
        const el = e.target; if (!el.classList.contains('jr-cellin')) return;
        const r = Number(el.dataset.r), c = Number(el.dataset.c);
        if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); enqueue(el); focusRC(r + 1, c) || (e.key === 'Enter' && focusRC(0, c + 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); enqueue(el); focusRC(r - 1, c); }
        else if (e.key === 'ArrowRight' && el.selectionStart === el.value.length) { e.preventDefault(); enqueue(el); focusRC(r, c + 1); }
        else if (e.key === 'ArrowLeft' && el.selectionStart === 0) { e.preventDefault(); enqueue(el); focusRC(r, c - 1); }
        else if (e.key === 'Escape') { el.value = el.dataset.orig; el.classList.remove('bad'); }
      });
      table.addEventListener('change', (e) => { if (e.target.classList.contains('jr-cellin')) enqueue(e.target); });
      async function commit(el) {
        if (el.disabled || el._busy) return;
        const raw = el.value.trim().replace(',', '.');
        const orig = el.dataset.orig;
        if (raw === orig) return;
        const kind = el.dataset.kind; const aid = el.dataset.aid || undefined;
        const max = kind === 'FINAL' ? 50 : kind === 'MIDTERM' ? 30 : 10;
        let score = null;
        if (raw !== '') {
          score = Number(raw);
          if (!Number.isFinite(score) || score < 0 || score > max || Math.abs(score * 100 - Math.round(score * 100)) > 1e-6) {
            el.classList.add('bad'); toast(t('journal.err.score_range').replace('{max}', max), true); el.value = orig; setTimeout(() => el.classList.remove('bad'), 1500); return;
          }
        } else if (kind === 'SEMINAR' && !aid) { return; }
        el._busy = true; el.classList.add('saving');
        let reason;
        try {
          if (el.dataset.pub === '1') { reason = await askReason(); if (reason == null) { el.value = orig; return; } }
          const rec = ctx.data.items.find((r) => r.key === el.dataset.key);
          const resp = await api().cells(Object.assign(ctxBody(), { cells: [{ studentId: rec.student.id, kind, answerId: aid, score, reason }] }));
          el.dataset.orig = raw; // помечаем сохранённое значение сразу: повторный change/blur по этой же ячейке не создаст дубль
          const nr = (resp.records || []).find((r) => r.key === rec.key);
          if (nr) { Object.assign(rec, nr); }
          const newMax = Math.max(3, ...ctx.data.items.map((r) => r.seminar.answers.length)) + 1;
          if (newMax !== maxAns || score === null || (kind === 'SEMINAR' && !aid)) {
            // перерисовка: возвращаем фокус туда, где он сейчас (и набранный текст), а не туда, где была сохранённая ячейка
            const a = document.activeElement;
            const keep = a && a.classList && a.classList.contains('jr-cellin') ? { r: a.dataset.r, c: a.dataset.c, v: a.value } : null;
            paintCards(); paintGrid();
            if (keep) { const ne = table.ownerDocument.querySelector('#jr-grid .jr-cellin[data-r="' + keep.r + '"][data-c="' + keep.c + '"]'); if (ne) { ne.value = keep.v; ne.focus(); } }
          }
          else { refreshRow(rec); paintCards(); }
          el.classList.add('ok'); setTimeout(() => el.classList.remove('ok'), 900);
        } catch (err) {
          toast(errText(err), true); el.value = orig; el.classList.add('bad'); setTimeout(() => el.classList.remove('bad'), 1500);
        } finally { el._busy = false; el.classList.remove('saving'); }
      }
      function refreshRow(rec) {
        const tr = table.querySelector('tr[data-key="' + CSS.escape(rec.key) + '"]'); if (!tr) return;
        const ins = Array.from(tr.querySelectorAll('.jr-cellin'));
        rec.seminar.answers.forEach((a, i) => { if (ins[i]) { ins[i].value = a.score; ins[i].dataset.orig = a.score; ins[i].dataset.aid = a.id; ins[i].dataset.pub = a.published ? 1 : 0; } });
        const mid = ins[maxAns], fin = ins[maxAns + 1];
        if (mid && rec.midterm) { mid.value = rec.midterm.score; mid.dataset.orig = rec.midterm.score; mid.dataset.aid = rec.midterm.id; mid.dataset.pub = rec.midterm.published ? 1 : 0; }
        if (fin && rec.final) { fin.value = rec.final.score; fin.dataset.orig = rec.final.score; fin.dataset.aid = rec.final.id; fin.dataset.pub = rec.final.published ? 1 : 0; }
        tr.querySelector('[data-calc="sem"]').innerHTML = seminarCell(rec.seminar);
        tr.querySelector('[data-calc="tot"]').innerHTML = totalCell(rec.total);
        tr.querySelector('[data-calc="st"]').innerHTML = statusChip(rec.status);
      }
    }


    // ───────── Посещаемость (Academic Journal → Attendance, API /journal/attendance/*) ─────────
    const todayStr = () => new Date().toISOString().slice(0, 10);
    const shiftDay = (d, n) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
    const ATT_ORDER = ['PRESENT', 'LATE', 'ABSENT', 'EXCUSED'];
    const subjCode = () => (scope.subjects.find((x) => x.id === S.subjectId) || {}).code;

    async function attendanceView() {
      const A = S.att = S.att || { date: todayStr(), view: 'mark', draft: {}, data: null, dirty: false, from: shiftDay(todayStr(), -30), to: todayStr(), student: '' };
      if (!paired()) { body.innerHTML = tui().emptyBox(t('journal.attn.pick_pair')); return; }
      body.innerHTML =
        '<div class="jr-bar-row"><div class="jr-seg"><button class="jr-segb" data-av="mark">' + esc(t('journal.attn.view_mark')) + '</button><button class="jr-segb" data-av="stats">' + esc(t('journal.attn.view_stats')) + '</button></div>' +
        (A.view === 'mark'
          ? '<button class="jr-btn" id="ja-prev" aria-label="' + esc(t('journal.attn.prev')) + '">‹</button><input class="jr-input" type="date" id="ja-date" value="' + A.date + '" max="' + todayStr() + '"><button class="jr-btn" id="ja-next" aria-label="' + esc(t('journal.attn.next')) + '">›</button><button class="jr-btn" id="ja-today">' + esc(t('journal.attn.today')) + '</button>'
          : '<label class="jr-muted">' + esc(t('journal.aud.from')) + ' <input class="jr-input" type="date" id="ja-from" value="' + A.from + '"></label><label class="jr-muted">' + esc(t('journal.aud.to')) + ' <input class="jr-input" type="date" id="ja-to" value="' + A.to + '" max="' + todayStr() + '"></label><select class="jr-input" id="ja-stu"><option value="">' + esc(t('journal.attn.all_students')) + '</option></select>') +
        '<span class="jr-spacer"></span><button class="jr-btn" id="ja-export">⬇ ' + esc(t('journal.attn.export')) + '</button></div><div id="ja-body"></div>';
      const ab = body.querySelector('#ja-body');
      body.querySelectorAll('[data-av]').forEach((b) => { b.classList.toggle('on', b.dataset.av === A.view); b.addEventListener('click', async () => { if (A.view === b.dataset.av) return; if (!(await discard())) return; A.view = b.dataset.av; attendanceView(); }); });
      body.querySelector('#ja-export').addEventListener('click', async () => { try { tui().saveBlob(await api().attendance.exportCsv({ groupName: S.groupName, subjectCode: subjCode(), from: A.view === 'stats' ? A.from + 'T00:00:00.000Z' : undefined, to: A.view === 'stats' ? A.to + 'T23:59:59.999Z' : undefined }), 'attendance_' + subjCode() + '.csv'); } catch (e) { toast(errText(e), true); } });
      async function discard() { if (!A.dirty) return true; return tui().confirmDialog({ message: t('journal.attn.unsaved'), confirmLabel: t('journal.attn.discard'), danger: true }); }

      if (A.view === 'mark') {
        const go = async (d) => { if (!d || d > todayStr()) return; if (!(await discard())) { body.querySelector('#ja-date').value = A.date; return; } A.date = d; attendanceView(); };
        body.querySelector('#ja-date').addEventListener('change', (e) => go(e.target.value));
        body.querySelector('#ja-prev').addEventListener('click', () => go(shiftDay(A.date, -1)));
        body.querySelector('#ja-next').addEventListener('click', () => go(shiftDay(A.date, 1)));
        body.querySelector('#ja-today').addEventListener('click', () => go(todayStr()));
        return guarded(ab, async () => {
          const d = await api().attendance.day({ groupName: S.groupName, subjectCode: subjCode(), classDate: new Date(A.date + 'T00:00:00Z').toISOString() });
          A.data = d; A.draft = {}; A.dirty = false; d.students.forEach((s) => { A.draft[s.loginId] = s.status || null; });
          renderMark(ab);
        });
      }
      body.querySelector('#ja-from').addEventListener('change', (e) => { A.from = e.target.value; attendanceView(); });
      body.querySelector('#ja-to').addEventListener('change', (e) => { A.to = e.target.value; attendanceView(); });
      body.querySelector('#ja-stu').addEventListener('change', (e) => { A.student = e.target.value; attendanceView(); });
      return guarded(ab, async () => {
        const all = await api().attendance.stats({ groupName: S.groupName, subjectCode: subjCode(), from: A.from + 'T00:00:00.000Z', to: A.to + 'T00:00:00.000Z' });
        const sel = body.querySelector('#ja-stu'); sel.innerHTML += all.students.map((s) => '<option value="' + esc(s.loginId) + '"' + (s.loginId === A.student ? ' selected' : '') + '>' + esc(s.fullName) + '</option>').join('');
        const d = A.student ? await api().attendance.stats({ groupName: S.groupName, subjectCode: subjCode(), from: A.from + 'T00:00:00.000Z', to: A.to + 'T00:00:00.000Z', studentLoginId: A.student }) : all;
        renderStats(ab, d);
      });
    }

    function renderMark(ab) {
      const A = S.att; const d = A.data;
      const counts = () => { const c = { PRESENT: 0, LATE: 0, ABSENT: 0, EXCUSED: 0, none: 0 }; d.students.forEach((s) => { const v = A.draft[s.loginId]; v ? c[v]++ : c.none++; }); return c; };
      const notes = (d.locked ? '<div class="jr-note jr-note-warn">🔒 ' + esc(t('journal.attn.locked')) + '</div>' : '') +
        (d.calendarEvent ? '<div class="jr-note jr-note-warn">⚠ <b>' + esc(d.calendarEvent.type) + ':</b> ' + esc(d.calendarEvent.title) + '</div>' : '') +
        (!d.scheduled ? '<div class="jr-note">ℹ ' + esc(t('journal.attn.not_scheduled')) + '</div>' : '');
      ab.innerHTML = notes + '<div class="jr-pills" id="ja-sum"></div>' +
        (d.students.length
          ? '<div class="jr-bar-row"><span class="jr-muted">' + esc(t('journal.attn.mark_all')) + ':</span>' + ATT_ORDER.map((s) => '<button class="jr-btn" data-all="' + s + '"' + (d.locked ? ' disabled' : '') + '>' + esc(t('journal.att.' + s)) + '</button>').join('') + '<span class="jr-spacer"></span><button class="jr-btn jr-primary" id="ja-save"' + (d.locked ? ' disabled' : '') + '>' + esc(t('common.save')) + '</button></div><div class="jr-card" id="ja-rows"></div>'
          : tui().emptyBox(t('journal.empty')));
      if (!d.students.length) return;
      const paintRows = () => {
        const c = counts();
        ab.querySelector('#ja-sum').innerHTML = ATT_ORDER.map((s) => '<span class="jr-pill jr-ab-' + s.toLowerCase() + '">' + esc(t('journal.att.' + s)) + ': ' + c[s] + '</span>').join('') + '<span class="jr-pill jr-pill-warn">' + esc(t('journal.attn.unmarked')) + ': ' + c.none + '</span>' + (A.dirty ? '<span class="jr-pill jr-pill-dirty">● ' + esc(t('journal.attn.unsaved_short')) + '</span>' : '');
        ab.querySelector('#ja-rows').innerHTML = d.students.map((s) => '<div class="jr-att-row' + (A.draft[s.loginId] ? '' : ' unmarked') + '"><div class="jr-att-n"><b>' + esc(s.fullName) + '</b><div class="jr-muted">' + esc(s.loginId) + '</div></div><div class="jr-att-ch" role="group" aria-label="' + esc(s.fullName) + '">' +
          ATT_ORDER.map((k) => '<button type="button" class="jr-ab jr-ab-' + k.toLowerCase() + (A.draft[s.loginId] === k ? ' on' : '') + '" data-o="' + esc(s.loginId) + '" data-st="' + k + '" aria-pressed="' + (A.draft[s.loginId] === k) + '"' + (d.locked ? ' disabled' : '') + '>' + esc(t('journal.att.' + k)) + '</button>').join('') + '</div></div>').join('');
        ab.querySelectorAll('.jr-ab').forEach((b) => b.addEventListener('click', () => { A.draft[b.dataset.o] = b.dataset.st; A.dirty = true; paintRows(); }));
      };
      ab.querySelectorAll('[data-all]').forEach((b) => b.addEventListener('click', () => { d.students.forEach((s) => { A.draft[s.loginId] = b.dataset.all; }); A.dirty = true; paintRows(); }));
      ab.querySelector('#ja-save').addEventListener('click', async () => {
        const entries = d.students.filter((s) => A.draft[s.loginId]).map((s) => ({ studentLoginId: s.loginId, status: A.draft[s.loginId] }));
        if (!entries.length) { toast(t('journal.attn.nothing'), true); return; }
        const btn = ab.querySelector('#ja-save'); btn.disabled = true;
        try {
          await api().attendance.mark({ groupName: S.groupName, subjectCode: subjCode(), classDate: new Date(A.date + 'T00:00:00Z').toISOString(), entries });
          toast(t('journal.attn.saved').replace('{n}', entries.length)); A.dirty = false; attendanceView();
        } catch (e) { toast(errText(e), true); btn.disabled = false; }
      });
      paintRows();
    }

    function renderStats(ab, d) {
      const tt = d.totals;
      ab.innerHTML =
        '<div class="jr-cards">' + card(t('journal.attn.class_days'), d.classDays) + card(t('journal.col.attendance'), tt.rate == null ? '—' : tt.rate + '%') + card(t('journal.att.PRESENT'), tt.PRESENT) + card(t('journal.att.LATE'), tt.LATE) + card(t('journal.att.ABSENT'), tt.ABSENT, '', tt.ABSENT ? 'warn' : '') + card(t('journal.att.EXCUSED'), tt.EXCUSED) + '</div>' +
        (d.students.length ? '<div class="jr-card jr-tablewrap"><table class="jr-table"><thead><tr><th>' + esc(t('journal.col.student')) + '</th><th>' + esc(t('journal.att.PRESENT')) + '</th><th>' + esc(t('journal.att.LATE')) + '</th><th>' + esc(t('journal.att.ABSENT')) + '</th><th>' + esc(t('journal.att.EXCUSED')) + '</th><th>' + esc(t('journal.attn.total')) + '</th><th>' + esc(t('journal.col.attendance')) + '</th><th>' + esc(t('journal.attn.limit')) + '</th></tr></thead><tbody>' +
          d.students.map((s) => '<tr><td data-l="' + esc(t('journal.col.student')) + '"><b>' + esc(s.fullName) + '</b><div class="jr-muted">' + esc(s.loginId) + '</div></td><td data-l="' + esc(t('journal.att.PRESENT')) + '">' + s.present + '</td><td data-l="' + esc(t('journal.att.LATE')) + '">' + s.late + '</td><td data-l="' + esc(t('journal.att.ABSENT')) + '">' + s.absent + '</td><td data-l="' + esc(t('journal.att.EXCUSED')) + '">' + s.excused + '</td><td data-l="' + esc(t('journal.attn.total')) + '">' + s.total + '</td><td data-l="' + esc(t('journal.col.attendance')) + '">' + (s.rate == null ? '—' : '<div class="jr-hbar"><div class="jr-hb-track"><i style="width:' + s.rate + '%"></i></div><b>' + s.rate + '%</b></div>') + '</td><td data-l="' + esc(t('journal.attn.limit')) + '">' + (s.limit.exceeded ? '<span class="jr-alert jr-al-low_total">' + esc(t('journal.attn.exceeded')) + '</span> ' : '') + s.limit.counted + ' / ' + s.limit.max + '</td></tr>').join('') + '</tbody></table></div>' : tui().emptyBox(t('journal.empty'))) +
        (d.days.length ? '<div class="jr-hist-t">' + esc(t('journal.attn.by_day')) + '</div><div class="jr-card jr-tablewrap"><table class="jr-table jr-mini"><thead><tr><th>' + esc(t('journal.attn.date')) + '</th><th>' + esc(t('journal.att.PRESENT')) + '</th><th>' + esc(t('journal.att.LATE')) + '</th><th>' + esc(t('journal.att.ABSENT')) + '</th><th>' + esc(t('journal.att.EXCUSED')) + '</th></tr></thead><tbody>' + d.days.map((x) => '<tr><td>' + esc(x.date) + '</td><td>' + x.present + '</td><td>' + x.late + '</td><td>' + x.absent + '</td><td>' + x.excused + '</td></tr>').join('') + '</tbody></table></div>' : '');
    }
    // ───────── Toolbar actions ─────────
    $('#jr-publish').addEventListener('click', async () => {
      if (!paired()) return;
      const ok = await tui().confirmDialog({ title: t('journal.publish'), message: t('journal.publish_confirm').replace('{group}', S.groupName), confirmLabel: t('journal.publish') });
      if (!ok) return;
      try { const r = await api().publish(Object.assign(ctxBody(), S.selected.size ? { studentIds: Array.from(S.selected) } : {})); toast(t('journal.published_n').replace('{n}', r.published).replace('{s}', r.students)); reload(); } catch (e) { toast(errText(e), true); }
    });
    $('#jr-unpublish').addEventListener('click', async () => {
      if (!paired()) return;
      const reason = await askReason('journal.unpublish', 'journal.unpublish_hint'); if (!reason) return;
      try { const r = await api().unpublish(Object.assign(ctxBody(), { reason }, S.selected.size ? { studentIds: Array.from(S.selected) } : {})); toast(t('journal.unpublished_n').replace('{n}', r.unpublished)); reload(); } catch (e) { toast(errText(e), true); }
    });
    $('#jr-bulk').addEventListener('click', () => bulkModal(ctx, S, ctxBody, reload));
    $('#jr-import').addEventListener('click', () => importModal(ctx, ctxBody, reload));
    const doExport = async (kind) => { try { const blob = await api().exportCsv({ academicYear: ctx.period.academicYear, term: ctx.period.term, subjectId: S.subjectId, groupName: S.groupName, faculty: S.faculty, status: S.status, search: S.search, kind }); tui().saveBlob(blob, 'journal-' + kind + '.csv'); } catch (e) { toast(errText(e), true); } };
    $('#jr-export').addEventListener('click', () => doExport('records'));
    $('#jr-export-a').addEventListener('click', () => doExport('answers'));
    load();
  }

  function bindPager(scope, cb) { scope.querySelectorAll('[data-pg]').forEach((b) => b.addEventListener('click', () => cb(Number(b.dataset.dir)))); }

  // ───────── Teacher: detail modal (edit) ─────────
  async function teacherDetail(ctx, studentId, subjectId, onClose) {
    const closed = currentPeriodStatus(ctx) === 'CLOSED';
    const m = openJrModal({ title: t('journal.detail'), html: skeleton(4), wide: true, static: true, onClose, buttons: [{ label: t('common.close'), cls: 'btn-outline' }] });
    const period = () => ({ academicYear: ctx.period.academicYear, term: ctx.period.term });
    async function render() {
      const d = await api().detail(studentId, subjectId, period());
      const r = d.record; const s = r.seminar; const can = r.canEdit && !closed;
      const dis = can ? '' : ' disabled';
      const needReasonNote = '<div class="jr-note jr-note-sm">' + esc(t('journal.reason_hint')) + '</div>';
      m.body.innerHTML =
        '<div class="jr-dhead"><div><div class="jr-dtitle">' + esc(r.student.fullName) + '</div><div class="jr-muted">' + esc(r.student.loginId) + ' · ' + esc(r.student.groupName) + ' · ' + esc(r.subject.code + ' ' + r.subject.name) + '</div></div><div>' + statusChip(r.status) + (closed ? ' <span class="jr-chip jr-st-locked">🔒</span>' : '') + '</div></div>' +
        (can ? needReasonNote + '<div class="jr-reasonrow"><label class="jr-muted" for="jd-reason">' + esc(t('journal.reason')) + '</label><input class="jr-input" id="jd-reason" maxlength="500" placeholder="' + esc(t('journal.reason_ph')) + '"></div>' : '') +
        '<div class="jr-grid3">' +
          '<div class="jr-block"><div class="jr-bl">' + esc(t('journal.col.midterm')) + ' <small>/30</small></div><div class="jr-edit"><input class="jr-input jr-num" id="jd-mid" inputmode="decimal" value="' + (r.midterm ? r.midterm.score : '') + '"' + dis + '><button class="jr-btn jr-primary" id="jd-mid-save"' + dis + '>' + esc(t('common.save')) + '</button></div>' + draftDot(r.midterm) + '</div>' +
          '<div class="jr-block"><div class="jr-bl">' + esc(t('journal.col.final')) + ' <small>/50</small></div><div class="jr-edit"><input class="jr-input jr-num" id="jd-fin" inputmode="decimal" value="' + (r.final ? r.final.score : '') + '"' + dis + '><button class="jr-btn jr-primary" id="jd-fin-save"' + dis + '>' + esc(t('common.save')) + '</button></div>' + draftDot(r.final) + '</div>' +
          '<div class="jr-block"><div class="jr-bl">' + esc(t('journal.col.seminar')) + ' <small>/20</small></div><div class="jr-bv">' + (s.eligible ? '<b>' + fmt(s.score) + '</b> / 20' : '<span class="jr-pend">' + esc(t('journal.pending')) + '</span> <small>' + s.count + ' / ' + s.required + '</small>') + '</div>' + bar(s.eligible ? s.score : 0, 20) + '</div>' +
        '</div>' +
        '<div class="jr-block jr-seminar"><div class="jr-bl">' + esc(t('journal.seminar_answers')) + ' <small>(0–10)</small></div>' +
          (s.answers.length ? s.answers.map((a, i) => '<div class="jr-ansrow"><span>' + esc(t('journal.answer')) + ' ' + (i + 1) + '</span><input class="jr-input jr-num" data-aid="' + esc(a.id) + '" data-orig="' + a.score + '" inputmode="decimal" value="' + a.score + '"' + dis + '><span class="jr-muted">/ 10</span>' + (a.published ? '' : '<span class="jr-dot" title="' + esc(t('journal.draft')) + '"></span>') + '<button class="jr-btn" data-save="' + esc(a.id) + '"' + dis + '>' + esc(t('common.save')) + '</button><button class="jr-btn jr-danger" data-del="' + esc(a.id) + '"' + dis + '>✕</button></div>').join('') : '<div class="jr-muted">' + esc(t('journal.no_answers')) + '</div>') +
          (can ? '<div class="jr-ansrow jr-add"><span>' + esc(t('journal.add_answer')) + '</span><input class="jr-input jr-num" id="jd-new" inputmode="decimal" placeholder="0–10"><button class="jr-btn jr-primary" id="jd-add">+ ' + esc(t('journal.add')) + '</button></div>' : '') +
          '<div class="jr-kvs"><span>' + esc(t('journal.average')) + '</span><b>' + (s.count ? fmt2(s.average) : '—') + '</b></div>' +
          '<div class="jr-kvs"><span>' + esc(t('journal.seminar_score')) + '</span><b>' + (s.eligible ? fmt(s.score) + ' / 20' : esc(t('journal.pending')) + ' — ' + esc(t('journal.seminar_missing').replace('{n}', s.missing))) + '</b></div>' +
        '</div>' +
        '<div class="jr-totalbox ' + (r.total.final ? 'final' : 'prov') + '"><span>' + esc(t('journal.col.total')) + '</span><b>' + fmt(r.total.score) + ' / 100</b>' + (r.total.final ? '' : '<em>' + esc(t('journal.provisional')) + '</em>') + '</div>' +
        '<div class="jr-kvs"><span>' + esc(t('journal.col.attendance')) + '</span><b>' + (r.attendance ? pctTxt(r.attendance.rate) + ' (' + (r.attendance.total - r.attendance.absent) + '/' + r.attendance.total + ')' : '—') + '</b></div>' +
        (r.alerts.length ? '<div class="jr-alerts">' + r.alerts.map(alertChip).join('') + '</div>' : '') +
        '<div class="jr-hist-t">' + esc(t('journal.history')) + '</div>' + historyTable(d.history);
      if (!can) return;
      const reason = () => (m.$('#jd-reason').value.trim() || undefined);
      const run = async (fn) => { try { await fn(); toast(t('journal.saved')); await render(); } catch (e) { toast(errText(e), true); if (e && e.body && e.body.code === 'REASON_REQUIRED') m.$('#jd-reason').focus(); } };
      const num = (v) => { const n = Number(String(v).trim().replace(',', '.')); return String(v).trim() === '' ? null : n; };
      m.$('#jd-mid-save').addEventListener('click', () => { const v = num(m.$('#jd-mid').value); if (v == null) return; run(() => api().setComponent(Object.assign({ studentId, subjectId, type: 'MIDTERM', score: v, reason: reason() }, period()))); });
      m.$('#jd-fin-save').addEventListener('click', () => { const v = num(m.$('#jd-fin').value); if (v == null) return; run(() => api().setComponent(Object.assign({ studentId, subjectId, type: 'FINAL', score: v, reason: reason() }, period()))); });
      m.$('#jd-add').addEventListener('click', () => { const v = num(m.$('#jd-new').value); if (v == null) return; run(() => api().addSeminar(Object.assign({ studentId, subjectId, score: v }, period()))); });
      m.$('#jd-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') m.$('#jd-add').click(); });
      m.body.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', () => { const inp = m.body.querySelector('input[data-aid="' + b.dataset.save + '"]'); const v = num(inp.value); if (v == null) return; run(() => api().updateGrade(b.dataset.save, { score: v, reason: reason() })); }));
      m.body.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => { const ok = await tui().confirmDialog({ message: t('journal.delete_confirm'), danger: true, confirmLabel: t('common.delete') }); if (ok) run(() => api().deleteGrade(b.dataset.del, reason())); }));
    }
    try { await render(); } catch (e) { m.body.innerHTML = tui().errorBox(errText(e)); }
  }

  // Значение аудит-события: число, состояние (DRAFT/PUBLISHED) или разбивка посещаемости {"PRESENT":2}
  function av(v) {
    if (v == null) return '—';
    if (typeof v === 'number') return fmt(v);
    if (typeof v === 'string' && v.charAt(0) === '{') { try { return Object.entries(JSON.parse(v)).map(([k, n]) => t('journal.att.' + k, k) + ' ' + n).join(' · '); } catch { return v; } }
    return t('journal.state.' + v, v);
  }

  function historyTable(h) {
    if (!h.length) return '<div class="jr-muted">' + esc(t('journal.no_history')) + '</div>';
    return '<div class="jr-tablewrap"><table class="jr-table jr-mini"><thead><tr><th>' + esc(t('journal.when')) + '</th><th>' + esc(t('journal.who')) + '</th><th>' + esc(t('journal.action')) + '</th><th>' + esc(t('journal.change')) + '</th><th>' + esc(t('journal.reason')) + '</th></tr></thead><tbody>' +
      h.map((e) => '<tr><td>' + esc(String(e.at).slice(0, 16).replace('T', ' ')) + '</td><td>' + esc(e.actor ? e.actor.fullName : '—') + '<div class="jr-muted">' + esc(e.actor ? e.actor.loginId : '') + '</div></td><td>' + esc(t('journal.act.' + e.action.replace('journal.', ''), e.action)) + (e.component ? ' · ' + esc(t('journal.comp.' + e.component, e.component)) : '') + '</td><td>' + (e.old != null || e.new != null ? esc(av(e.old)) + ' → <b>' + esc(av(e.new)) + '</b>' : '—') + '</td><td>' + esc(e.reason || '—') + '</td></tr>').join('') + '</tbody></table></div>';
  }

  // ───────── Teacher: bulk modal ─────────
  function bulkModal(ctx, S, ctxBody, reload) {
    const ids = Array.from(S.selected);
    const today = new Date().toISOString().slice(0, 10);
    const m = openJrModal({
      title: t('journal.bulk'), wide: true, static: true,
      html: '<div class="jr-note">' + esc(t('journal.bulk_help')) + '</div>' +
        '<div class="jr-kvs"><span>' + esc(t('journal.bulk_selected')) + '</span><b>' + ids.length + ' ' + esc(t('journal.students_word')) + '</b></div>' +
        '<div class="jr-reasonrow"><label class="jr-muted" for="jb-act">' + esc(t('journal.bulk_action')) + '</label><select class="jr-input" id="jb-act"><option value="SEMINAR">' + esc(t('journal.bulk_seminar')) + '</option><option value="ATTENDANCE">' + esc(t('journal.bulk_attendance')) + '</option></select></div>' +
        '<div id="jb-fields"></div><div id="jb-sum" class="jr-note"></div><div class="jr-err" id="jb-err"></div>',
      buttons: [
        { label: t('common.cancel'), cls: 'btn-outline' },
        { id: 'go', label: t('journal.bulk_confirm'), cls: 'btn-purple', keep: true, onClick: async (h) => {
          const act = h.$('#jb-act').value; h.$('#jb-err').textContent = '';
          try {
            const dto = Object.assign(ctxBody(), { action: act, studentIds: ids, confirm: true });
            if (act === 'SEMINAR') { dto.score = Number(h.$('#jb-score').value.replace(',', '.')); if (!Number.isFinite(dto.score)) return false; }
            else { dto.status = h.$('#jb-status').value; dto.classDate = new Date(h.$('#jb-date').value + 'T00:00:00.000Z').toISOString(); }
            const r = await api().bulk(dto);
            toast(t('journal.bulk_done').replace('{n}', r.affected)); h.close(); reload(); return false;
          } catch (e) { h.$('#jb-err').textContent = errText(e); return false; }
        } },
      ],
    });
    const draw = () => {
      const act = m.$('#jb-act').value;
      m.$('#jb-fields').innerHTML = act === 'SEMINAR'
        ? '<div class="jr-reasonrow"><label class="jr-muted" for="jb-score">' + esc(t('journal.bulk_score')) + ' (0–10)</label><input class="jr-input jr-num" id="jb-score" inputmode="decimal" value="8"></div>'
        : '<div class="jr-reasonrow"><label class="jr-muted" for="jb-date">' + esc(t('journal.bulk_date')) + '</label><input class="jr-input" type="date" id="jb-date" value="' + today + '"></div><div class="jr-reasonrow"><label class="jr-muted" for="jb-status">' + esc(t('journal.bulk_status')) + '</label><select class="jr-input" id="jb-status">' + ['PRESENT', 'ABSENT', 'LATE', 'EXCUSED'].map((s) => '<option value="' + s + '">' + esc(t('journal.att.' + s)) + '</option>').join('') + '</select></div>';
      sum();
      m.body.querySelectorAll('#jb-fields input,#jb-fields select').forEach((x) => x.addEventListener('input', sum));
    };
    const sum = () => {
      const act = m.$('#jb-act').value;
      const val = act === 'SEMINAR' ? (m.$('#jb-score').value + ' / 10') : (t('journal.att.' + m.$('#jb-status').value) + ' · ' + m.$('#jb-date').value);
      m.$('#jb-sum').innerHTML = '<b>' + esc(t('journal.bulk_selected')) + ':</b> ' + ids.length + ' ' + esc(t('journal.students_word')) + '<br><b>' + esc(t('journal.bulk_action')) + ':</b> ' + esc(act === 'SEMINAR' ? t('journal.bulk_seminar') : t('journal.bulk_attendance')) + '<br><b>' + esc(act === 'SEMINAR' ? t('journal.bulk_score') : t('journal.bulk_status')) + ':</b> ' + esc(val);
    };
    m.$('#jb-act').addEventListener('change', draw); draw();
  }

  // ───────── Teacher: import modal ─────────
  function importModal(ctx, ctxBody, reload) {
    const cols = ['student_id', 'midterm', 'final', 'seminar'];
    const m = openJrModal({
      title: t('journal.import'), wide: true, static: true,
      html: '<div class="jr-note">' + esc(t('journal.import_help')) + '</div><div class="jr-edit"><input type="file" id="ji-file" accept=".csv,text/csv"><button class="jr-btn" id="ji-tpl">⬇ ' + esc(t('journal.import_template')) + '</button></div>' +
        '<div class="jr-reasonrow"><label class="jr-muted" for="ji-reason">' + esc(t('journal.reason')) + '</label><input class="jr-input" id="ji-reason" maxlength="500" placeholder="' + esc(t('journal.import_reason_ph')) + '"></div><div id="ji-out"></div>',
      buttons: [{ label: t('common.cancel'), cls: 'btn-outline' }, { id: 'apply', label: t('journal.import_apply'), cls: 'btn-purple', hidden: true, keep: true, onClick: async (h) => {
        try { const r = await api().importApply(payload()); toast(t('journal.import_done').replace('{n}', r.applied)); h.close(); reload(); return false; } catch (e) { h.$('#ji-out').insertAdjacentHTML('afterbegin', '<div class="jr-err">' + esc(errText(e)) + '</div>'); return false; }
      } }],
    });
    let rows = [];
    const payload = () => Object.assign(ctxBody(), { rows, reason: m.$('#ji-reason').value.trim() || undefined });
    const toNum = (v) => { const s = String(v == null ? '' : v).trim().replace(',', '.'); return s === '' ? undefined : Number(s); };
    m.$('#ji-tpl').addEventListener('click', () => tui().saveBlob(new Blob(['﻿' + cols.join(',') + '\r\nstudent1.demo,26,43,"6;7;8"\r\n'], { type: 'text/csv' }), 'journal-import-template.csv'));
    m.$('#ji-file').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return; const out = m.$('#ji-out'); m.show('apply', false);
      try {
        const table = tui().parseCsv(await f.text());
        if (table.length < 2) throw new Error(t('journal.import_empty'));
        const head = table[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, ''));
        const idx = (names) => head.findIndex((h) => names.includes(h));
        const iId = idx(['studentid', 'loginid', 'id', 'student']); if (iId < 0) throw new Error(t('journal.import_no_id'));
        const iMid = idx(['midterm', 'mid']), iFin = idx(['final', 'finalexam']), iSubj = idx(['subject', 'subjectcode']), iYear = idx(['academicyear', 'year']), iTerm = idx(['term']);
        const semIdx = head.map((h, i) => (/^seminar\d*$/.test(h) || /^answer\d+$/.test(h) ? i : -1)).filter((i) => i >= 0);
        if (table.length - 1 > 500) throw new Error(t('journal.import_too_many'));
        rows = table.slice(1).map((r) => {
          const o = { studentLoginId: String(r[iId] || '').trim() };
          if (iSubj >= 0 && String(r[iSubj] || '').trim()) o.subjectCode = String(r[iSubj]).trim();
          if (iYear >= 0 && String(r[iYear] || '').trim()) o.academicYear = String(r[iYear]).trim();
          if (iTerm >= 0 && String(r[iTerm] || '').trim()) o.term = String(r[iTerm]).trim().toUpperCase();
          const mid = iMid >= 0 ? toNum(r[iMid]) : undefined; if (mid !== undefined) o.midterm = mid;
          const fin = iFin >= 0 ? toNum(r[iFin]) : undefined; if (fin !== undefined) o.final = fin;
          const sem = [];
          semIdx.forEach((i) => { const v = String(r[i] || '').trim(); if (!v) return; v.split(/[;\s]+/).filter(Boolean).forEach((x) => sem.push(toNum(x))); });
          if (sem.length) o.seminar = sem;
          return o;
        });
        if (rows.some((r) => [r.midterm, r.final, ...(r.seminar || [])].some((v) => v !== undefined && !Number.isFinite(v)))) {
          rows = rows.map((r) => Object.assign(r, { midterm: Number.isFinite(r.midterm) ? r.midterm : undefined, final: Number.isFinite(r.final) ? r.final : undefined, seminar: r.seminar && r.seminar.every(Number.isFinite) ? r.seminar : undefined }));
        }
        out.innerHTML = skeleton(2);
        const p = await api().importPreview(payload());
        const s = p.summary;
        out.innerHTML = '<div class="jr-note">' + esc(t('journal.import_summary').replace('{ok}', s.ok).replace('{u}', s.unchanged).replace('{e}', s.errors)) + '</div>' +
          '<div class="jr-tablewrap jr-preview"><table class="jr-table jr-mini"><thead><tr><th>#</th><th>' + esc(t('journal.col.student')) + '</th><th>' + esc(t('journal.change')) + '</th><th>' + esc(t('journal.col.status')) + '</th></tr></thead><tbody>' +
          p.rows.map((r) => '<tr class="' + (r.status === 'ERROR' ? 'jr-badrow' : '') + '"><td>' + (r.index + 1) + '</td><td>' + esc(r.studentLoginId) + (r.fullName ? '<div class="jr-muted">' + esc(r.fullName) + '</div>' : '') + '</td><td>' +
            (r.changes.length ? r.changes.map((c) => esc(t('journal.comp.' + c.component)) + ' ' + (c.old != null ? fmt(c.old) + ' → ' : '') + '<b>' + fmt(c.new) + '</b>').join('<br>') : '—') + '</td><td>' +
            (r.status === 'ERROR' ? r.errors.map((x) => '<span class="jr-alert">' + esc(t('journal.imperr.' + x, x)) + '</span>').join(' ') : '<span class="jr-chip jr-st-' + (r.status === 'OK' ? 'published' : 'open') + '">' + esc(t('journal.imp.' + r.status)) + '</span>') + '</td></tr>').join('') + '</tbody></table></div>';
        m.show('apply', s.errors === 0 && s.ok > 0);
      } catch (err) { out.innerHTML = '<div class="jr-err">' + esc(errText(err)) + '</div>'; }
    });
  }

  // ═════════════════════════════ LEADERSHIP ═════════════════════════════
  function leadershipView(ctx) {
    const root = ctx.root;
    const S = ctx.state = ctx.state || { tab: 'overview', faculty: '', department: '', subjectId: '', groupName: '', teacherId: '', status: '', search: '', page: 1, compare: new Set() };
    const sc = ctx.meta.scope || { subjects: [], groups: [], teachers: [], faculties: [], departments: [] };
    const sel = (id, val, allKey, items) => '<select class="jr-input" id="' + id + '"><option value="">' + esc(t(allKey)) + '</option>' + items.map((i) => '<option value="' + esc(i.v) + '"' + (i.v === val ? ' selected' : '') + '>' + esc(i.l) + '</option>').join('') + '</select>';

    root.innerHTML = header(ctx, 'journal.sub.leadership') +
      '<div class="jr-bar-row">' + periodSelect(ctx, 'jr-period') + '<span id="jr-pbadge">' + periodBadge(ctx) + '</span>' +
        sel('jl-faculty', S.faculty, 'journal.filter.all_faculties', sc.faculties.map((f) => ({ v: f, l: f }))) +
        sel('jl-dept', S.department, 'journal.filter.all_departments', sc.departments.map((f) => ({ v: f, l: f }))) +
        sel('jl-subject', S.subjectId, 'journal.filter.all_subjects', sc.subjects.map((s) => ({ v: s.id, l: s.code + ' · ' + s.name }))) +
        sel('jl-group', S.groupName, 'journal.filter.all_groups', sc.groups.map((g) => ({ v: g, l: g }))) +
        sel('jl-teacher', S.teacherId, 'journal.filter.all_teachers', sc.teachers.map((x) => ({ v: x.id, l: x.fullName }))) +
        '<select class="jr-input" id="jl-status"><option value="">' + esc(t('journal.filter.all_statuses')) + '</option>' + ['PROVISIONAL', 'READY', 'PUBLISHED', 'LOCKED'].map((s) => '<option value="' + s + '"' + (S.status === s ? ' selected' : '') + '>' + esc(t('journal.status.' + s)) + '</option>').join('') + '</select>' +
        '<input class="jr-input jr-grow" id="jl-search" type="search" value="' + esc(S.search) + '" placeholder="' + esc(t('journal.filter.search')) + '">' +
      '</div>' +
      '<div class="jr-tabs" role="tablist">' + ['overview', 'analytics', 'compare', 'periods'].map((k) => '<button class="jr-tab" data-tab="' + k + '" role="tab">' + esc(t('journal.tab.' + k)) + '</button>').join('') + '<span class="jr-spacer"></span><button class="jr-btn" id="jl-export">⬇ ' + esc(t('journal.export')) + '</button></div>' +
      '<div id="jr-body"></div>';

    const $ = (s) => root.querySelector(s);
    const body = $('#jr-body');
    const filters = () => Object.assign({}, ctx.period, { faculty: S.faculty, department: S.department, subjectId: S.subjectId, groupName: S.groupName, teacherId: S.teacherId, status: S.status, search: S.search });
    const bind = (id, key) => $(id).addEventListener('change', (e) => { S[key] = e.target.value; S.page = 1; load(); });
    bind('#jl-faculty', 'faculty'); bind('#jl-dept', 'department'); bind('#jl-subject', 'subjectId'); bind('#jl-group', 'groupName'); bind('#jl-teacher', 'teacherId'); bind('#jl-status', 'status');
    $('#jl-search').addEventListener('input', debounce((e) => { S.search = e.target.value.trim(); S.page = 1; load(); }, 350));
    bindPeriod(ctx, 'jr-period', () => { S.page = 1; load(); });
    root.querySelectorAll('.jr-tab').forEach((b) => b.addEventListener('click', () => { S.tab = b.dataset.tab; load(); }));
    $('#jl-export').addEventListener('click', async () => { try { tui().saveBlob(await api().exportCsv(Object.assign(filters(), { kind: 'records' })), 'journal-records.csv'); } catch (e) { toast(errText(e), true); } });

    function load() {
      $('#jr-pbadge').innerHTML = periodBadge(ctx);
      root.querySelectorAll('.jr-tab').forEach((b) => { const on = b.dataset.tab === S.tab; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
      $('#jl-export').style.display = S.tab === 'overview' || S.tab === 'analytics' ? '' : 'none';
      const fn = { overview: tabOverview, analytics: tabAnalytics, compare: tabCompare, periods: tabPeriods }[S.tab];
      return guarded(body, fn);
    }

    async function tabOverview() {
      const d = await api().records(Object.assign(filters(), { page: S.page, pageSize: 25 }));
      const s = d.summary;
      body.innerHTML =
        '<div class="jr-cards">' +
          card(t('journal.card.total_students'), s.students) +
          card(t('journal.card.avg_score'), s.averageTotal == null ? '—' : fmt(s.averageTotal) + '<small> / 100</small>') +
          card(t('journal.card.completion'), s.completion == null ? '—' : s.completion + '%', esc(t('journal.card.completed_records')).replace('{n}', s.published + s.ready)) +
          card(t('journal.card.at_risk'), s.atRisk, esc(t('journal.card.at_risk_hint')), s.atRisk ? 'warn' : '') +
          card(t('journal.card.provisional'), s.provisional, '', s.provisional ? 'warn' : '') +
          card(t('journal.card.missing'), s.missingGrades, '', s.missingGrades ? 'warn' : '') +
          card(t('journal.card.low_att'), s.lowAttendance, '', s.lowAttendance ? 'warn' : '') +
          card(t('journal.card.ready'), s.ready, '', s.ready ? 'info' : '') +
        '</div>' +
        (d.items.length ? '<div class="jr-card jr-tablewrap"><table class="jr-table"><thead><tr><th>' + esc(t('journal.col.student')) + '</th><th>' + esc(t('journal.col.subject')) + '</th><th>' + esc(t('journal.col.teacher')) + '</th><th>' + esc(t('journal.col.seminar')) + ' <small>/20</small></th><th>' + esc(t('journal.col.midterm')) + ' <small>/30</small></th><th>' + esc(t('journal.col.final')) + ' <small>/50</small></th><th>' + esc(t('journal.col.total')) + ' <small>/100</small></th><th>' + esc(t('journal.col.attendance')) + '</th><th>' + esc(t('journal.col.status')) + '</th></tr></thead><tbody>' +
          d.items.map((r) => '<tr class="jr-row" tabindex="0" data-k="' + esc(r.key) + '"><td data-l="' + esc(t('journal.col.student')) + '"><b>' + esc(r.student.fullName) + '</b><div class="jr-muted">' + esc(r.student.loginId) + ' · ' + esc(r.student.groupName) + '</div></td><td data-l="' + esc(t('journal.col.subject')) + '">' + esc(r.subject.code) + '</td><td data-l="' + esc(t('journal.col.teacher')) + '">' + esc(r.teachers.join(', ') || '—') + '</td><td data-l="' + esc(t('journal.col.seminar')) + '">' + seminarCell(r.seminar) + '</td><td data-l="' + esc(t('journal.col.midterm')) + '">' + compCell(r.midterm, 30) + '</td><td data-l="' + esc(t('journal.col.final')) + '">' + compCell(r.final, 50) + '</td><td data-l="' + esc(t('journal.col.total')) + '">' + totalCell(r.total) + '</td><td data-l="' + esc(t('journal.col.attendance')) + '">' + (r.attendance ? pctTxt(r.attendance.rate) : '—') + '</td><td data-l="' + esc(t('journal.col.status')) + '">' + statusChip(r.status) + '</td></tr>').join('') +
          '</tbody></table></div>' + pager(S.page, d.pageSize, d.total, 'lead') : tui().emptyBox(t('journal.empty')));
      const byKey = new Map(d.items.map((r) => [r.key, r]));
      body.querySelectorAll('.jr-row').forEach((row) => { const open = () => { const r = byKey.get(row.dataset.k); leaderDetail(ctx, r.student.id, r.subject.id); }; row.addEventListener('click', open); row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); }); });
      bindPager(body, (dir) => { S.page += dir; load(); });
    }

    async function tabAnalytics() {
      const a = await api().analytics(filters());
      const s = a.summary; const av = a.averages;
      const maxBand = Math.max(1, ...Object.values(a.distribution));
      body.innerHTML =
        '<div class="jr-cards">' +
          card(t('journal.an.avg_total'), av.total.value == null ? '—' : fmt(av.total.value) + '<small> / 100</small>') +
          card(t('journal.an.avg_final'), av.final.value == null ? '—' : fmt(av.final.value) + '<small> / 50</small>') +
          card(t('journal.an.avg_midterm'), av.midterm.value == null ? '—' : fmt(av.midterm.value) + '<small> / 30</small>') +
          card(t('journal.an.avg_seminar'), av.seminar.value == null ? '—' : fmt(av.seminar.value) + '<small> / 20</small>') +
          card(t('journal.an.seminar_completion'), a.seminarCompletionRate == null ? '—' : a.seminarCompletionRate + '%') +
          card(t('journal.an.pass_rate'), a.passRate == null ? '—' : a.passRate + '%', esc(t('journal.an.pass_mark')).replace('{n}', a.passMark)) +
          card(t('journal.an.missing_rate'), a.missingGradeRate == null ? '—' : a.missingGradeRate + '%', '', a.missingGradeRate ? 'warn' : '') +
          card(t('journal.card.provisional'), s.provisional, '', s.provisional ? 'warn' : '') +
        '</div>' +
        '<div class="jr-grid2"><div class="jr-card jr-pad"><div class="jr-ctitle">' + esc(t('journal.an.distribution')) + '</div>' +
          Object.entries(a.distribution).map(([k, v]) => '<div class="jr-hbar"><span>' + k + '</span><div class="jr-hb-track"><i style="width:' + Math.round((v / maxBand) * 100) + '%"></i></div><b>' + v + '</b></div>').join('') + '</div>' +
        '<div class="jr-card jr-pad"><div class="jr-ctitle">' + esc(t('journal.an.att_relation')) + '</div><table class="jr-table jr-mini"><thead><tr><th>' + esc(t('journal.col.attendance')) + '</th><th>' + esc(t('journal.an.records')) + '</th><th>' + esc(t('journal.an.avg_total')) + '</th></tr></thead><tbody>' +
          a.attendanceRelation.map((b) => '<tr><td>' + b.from + '–' + b.to + '%</td><td>' + b.records + '</td><td>' + (b.averageTotal == null ? '—' : fmt(b.averageTotal)) + '</td></tr>').join('') + '</tbody></table><div class="jr-muted" style="margin-top:8px">' + esc(t('journal.an.att_note')) + '</div></div></div>' +
        '<div class="jr-card jr-tablewrap" style="margin-top:14px"><table class="jr-table"><thead><tr><th>' + esc(t('journal.col.subject')) + '</th><th>' + esc(t('journal.an.records')) + '</th><th>' + esc(t('journal.an.avg_total')) + '</th><th>' + esc(t('journal.card.completion')) + '</th><th>' + esc(t('journal.an.seminar_completion')) + '</th></tr></thead><tbody>' +
          (a.bySubject.length ? a.bySubject.map((x) => '<tr><td><b>' + esc(x.subject.code) + '</b> <span class="jr-muted">' + esc(x.subject.name) + '</span></td><td>' + x.records + '</td><td>' + (x.averageTotal == null ? '—' : fmt(x.averageTotal)) + '</td><td>' + x.completion + '%</td><td>' + x.seminarCompletion + '%</td></tr>').join('') : '<tr><td colspan="5" class="jr-muted">' + esc(t('journal.empty')) + '</td></tr>') + '</tbody></table></div>';
    }

    async function tabCompare() {
      const groups = sc.groups;
      body.innerHTML = '<div class="jr-card jr-pad"><div class="jr-ctitle">' + esc(t('journal.cmp.pick')) + '</div><div class="jr-checks">' + groups.map((g) => '<label class="jr-check"><input type="checkbox" class="jr-cb" data-g="' + esc(g) + '"' + (S.compare.has(g) ? ' checked' : '') + '> ' + esc(g) + '</label>').join('') + '</div></div><div id="jr-cmp" style="margin-top:14px"></div>';
      const run = async () => {
        const out = body.querySelector('#jr-cmp');
        if (S.compare.size < 2) { out.innerHTML = tui().emptyBox(t('journal.cmp.hint')); return; }
        out.innerHTML = skeleton(3);
        try {
          const r = await api().compare(Object.assign({}, ctx.period, { groups: Array.from(S.compare).join(','), subjectId: S.subjectId }));
          const mx = Math.max(1, ...r.groups.map((g) => g.averageTotal || 0));
          out.innerHTML = '<div class="jr-card jr-tablewrap"><table class="jr-table"><thead><tr><th>' + esc(t('journal.filter.group')) + '</th><th>' + esc(t('journal.card.students')) + '</th><th>' + esc(t('journal.cmp.avg')) + '</th><th>' + esc(t('journal.col.attendance')) + '</th><th>' + esc(t('journal.an.seminar_completion')) + '</th><th>' + esc(t('journal.card.provisional')) + '</th><th>' + esc(t('journal.card.missing')) + '</th><th>' + esc(t('journal.card.at_risk')) + '</th></tr></thead><tbody>' +
            r.groups.map((g) => '<tr><td><b>' + esc(g.groupName) + '</b></td><td>' + g.students + '</td><td><div class="jr-hbar"><div class="jr-hb-track"><i style="width:' + Math.round(((g.averageTotal || 0) / mx) * 100) + '%"></i></div><b>' + (g.averageTotal == null ? '—' : fmt(g.averageTotal)) + '</b></div></td><td>' + pctTxt(g.averageAttendance) + '</td><td>' + (g.seminarCompletion == null ? '—' : g.seminarCompletion + '%') + '</td><td>' + g.provisional + '</td><td>' + g.missingGrades + '</td><td>' + g.atRisk + '</td></tr>').join('') + '</tbody></table></div>';
        } catch (e) { out.innerHTML = tui().errorBox(errText(e)); }
      };
      body.querySelectorAll('[data-g]').forEach((cb) => cb.addEventListener('change', () => { cb.checked ? S.compare.add(cb.dataset.g) : S.compare.delete(cb.dataset.g); run(); }));
      run();
    }

    async function tabPeriods() {
      const meta = await api().meta(); ctx.meta = meta;
      body.innerHTML = '<div class="jr-note">' + esc(t('journal.per.help')) + '</div><div class="jr-card jr-tablewrap"><table class="jr-table"><thead><tr><th>' + esc(t('journal.period')) + '</th><th>' + esc(t('journal.col.status')) + '</th><th></th></tr></thead><tbody>' +
        meta.periods.map((p) => '<tr><td><b>' + esc(periodLabel(p)) + '</b>' + (p.current ? ' <span class="jr-chip jr-st-open">' + esc(t('journal.per.current')) + '</span>' : '') + '</td><td>' + (p.status === 'CLOSED' ? '<span class="jr-chip jr-st-locked">🔒 ' + esc(t('journal.period_closed')) + '</span>' : '<span class="jr-chip jr-st-open">' + esc(t('journal.period_open')) + '</span>') + '</td><td style="text-align:right"><button class="jr-btn ' + (p.status === 'OPEN' ? 'jr-danger' : '') + '" data-pid="' + esc(p.id) + '" data-to="' + (p.status === 'OPEN' ? 'CLOSED' : 'OPEN') + '">' + esc(p.status === 'OPEN' ? t('journal.per.close') : t('journal.per.open')) + '</button></td></tr>').join('') + '</tbody></table></div>';
      body.querySelectorAll('[data-pid]').forEach((b) => b.addEventListener('click', async () => {
        const reason = await askReason(b.dataset.to === 'CLOSED' ? 'journal.per.close' : 'journal.per.open', b.dataset.to === 'CLOSED' ? 'journal.per.close_hint' : 'journal.per.open_hint'); if (!reason) return;
        try { await api().setPeriod(b.dataset.pid, { status: b.dataset.to, reason }); toast(t('journal.saved')); load(); } catch (e) { toast(errText(e), true); }
      }));
    }
    load();
  }

  async function leaderDetail(ctx, studentId, subjectId) {
    const m = openJrModal({ title: t('journal.detail'), html: skeleton(4), wide: true, buttons: [{ label: t('common.close'), cls: 'btn-outline' }] });
    try {
      const d = await api().detail(studentId, subjectId, ctx.period); const r = d.record; const s = r.seminar;
      m.body.innerHTML =
        '<div class="jr-dhead"><div><div class="jr-dtitle">' + esc(r.student.fullName) + '</div><div class="jr-muted">' + esc(r.student.loginId) + ' · ' + esc(r.student.groupName) + ' · ' + esc(r.subject.code + ' ' + r.subject.name) + '</div><div class="jr-muted">' + esc(r.teachers.join(', ')) + '</div></div><div>' + statusChip(r.status) + '</div></div>' +
        '<div class="jr-note">' + esc(t('journal.readonly_note')) + '</div>' +
        '<div class="jr-grid3"><div class="jr-block"><div class="jr-bl">' + esc(t('journal.col.midterm')) + '</div><div class="jr-bv">' + compCell(r.midterm, 30) + '</div></div><div class="jr-block"><div class="jr-bl">' + esc(t('journal.col.final')) + '</div><div class="jr-bv">' + compCell(r.final, 50) + '</div></div><div class="jr-block"><div class="jr-bl">' + esc(t('journal.col.seminar')) + '</div><div class="jr-bv">' + seminarCell(s) + '</div></div></div>' +
        '<div class="jr-block"><div class="jr-bl">' + esc(t('journal.seminar_answers')) + '</div><div class="jr-answers">' + (s.answers.length ? s.answers.map((a, i) => '<div class="jr-ans"><span>' + esc(t('journal.answer')) + ' ' + (i + 1) + '</span><b>' + fmt(a.score) + ' / 10</b>' + (a.published ? '' : ' <span class="jr-dot"></span>') + '</div>').join('') : '<span class="jr-muted">' + esc(t('journal.no_answers')) + '</span>') + '</div><div class="jr-kvs"><span>' + esc(t('journal.average')) + '</span><b>' + (s.count ? fmt2(s.average) : '—') + '</b></div></div>' +
        '<div class="jr-totalbox ' + (r.total.final ? 'final' : 'prov') + '"><span>' + esc(t('journal.col.total')) + '</span><b>' + fmt(r.total.score) + ' / 100</b>' + (r.total.final ? '' : '<em>' + esc(t('journal.provisional')) + '</em>') + '</div>' +
        '<div class="jr-kvs"><span>' + esc(t('journal.col.attendance')) + '</span><b>' + (r.attendance ? pctTxt(r.attendance.rate) : '—') + '</b></div>' +
        (r.alerts.length ? '<div class="jr-alerts">' + r.alerts.map(alertChip).join('') + '</div>' : '') +
        '<div class="jr-hist-t">' + esc(t('journal.history')) + '</div>' + historyTable(d.history);
    } catch (e) { m.body.innerHTML = tui().errorBox(errText(e)); }
  }

  // ═════════════════════════════ IT AUDITOR ═════════════════════════════
  function auditorView(ctx) {
    const root = ctx.root;
    const S = ctx.state = ctx.state || { category: '', actor: '', student: '', subject: '', from: '', to: '', page: 1 };
    root.innerHTML = header(ctx, 'journal.sub.auditor') +
      '<div id="ja-cards" class="jr-cards"></div>' +
      '<div class="jr-bar-row">' +
        '<select class="jr-input" id="ja-cat"><option value="">' + esc(t('journal.aud.all_categories')) + '</option>' + ['grade', 'seminar', 'attendance', 'publish', 'period', 'export'].map((c) => '<option value="' + c + '"' + (S.category === c ? ' selected' : '') + '>' + esc(t('journal.aud.cat.' + c)) + '</option>').join('') + '</select>' +
        '<input class="jr-input" id="ja-actor" value="' + esc(S.actor) + '" placeholder="' + esc(t('journal.aud.actor')) + '">' +
        '<input class="jr-input" id="ja-student" value="' + esc(S.student) + '" placeholder="' + esc(t('journal.aud.student')) + '">' +
        '<input class="jr-input" id="ja-subject" value="' + esc(S.subject) + '" placeholder="' + esc(t('journal.aud.subject')) + '">' +
        '<label class="jr-muted">' + esc(t('journal.aud.from')) + ' <input class="jr-input" type="date" id="ja-from" value="' + esc(S.from) + '"></label>' +
        '<label class="jr-muted">' + esc(t('journal.aud.to')) + ' <input class="jr-input" type="date" id="ja-to" value="' + esc(S.to) + '"></label>' +
        '<span class="jr-spacer"></span><button class="jr-btn" id="ja-refresh">↻ ' + esc(t('journal.refresh')) + '</button>' +
      '</div><div class="jr-note">' + esc(t('journal.aud.note')) + '</div><div id="jr-body"></div>';
    const $ = (s) => root.querySelector(s); const body = $('#jr-body');
    const bindI = (id, key, isDate) => $(id).addEventListener(isDate ? 'change' : 'input', debounce((e) => { S[key] = e.target.value.trim(); S.page = 1; load(); }, 350));
    bindI('#ja-actor', 'actor'); bindI('#ja-student', 'student'); bindI('#ja-subject', 'subject'); bindI('#ja-from', 'from', true); bindI('#ja-to', 'to', true);
    $('#ja-cat').addEventListener('change', (e) => { S.category = e.target.value; S.page = 1; load(); });
    $('#ja-refresh').addEventListener('click', () => { loadStats(); load(); });

    async function loadStats() {
      try {
        const s = await api().auditStats();
        $('#ja-cards').innerHTML = card(t('journal.aud.events7d'), s.total) + card(t('journal.aud.after_publish'), s.changesAfterPublish, esc(t('journal.aud.after_publish_hint')), s.changesAfterPublish ? 'warn' : '') + card(t('journal.aud.unpublished'), s.unpublished) + card(t('journal.aud.actors'), s.actors);
      } catch (e) { $('#ja-cards').innerHTML = ''; }
    }
    function load() {
      return guarded(body, async () => {
        const iso = (d, end) => (d ? new Date(d + (end ? 'T23:59:59.999Z' : 'T00:00:00.000Z')).toISOString() : undefined);
        const d = await api().audit({ category: S.category, actor: S.actor, student: S.student, subject: S.subject, from: iso(S.from), to: iso(S.to, true), page: S.page, pageSize: 25 });
        body.innerHTML = d.items.length ? '<div class="jr-card jr-tablewrap"><table class="jr-table"><thead><tr><th>' + esc(t('journal.when')) + '</th><th>' + esc(t('journal.who')) + '</th><th>' + esc(t('journal.action')) + '</th><th>' + esc(t('journal.aud.entity')) + '</th><th>' + esc(t('journal.change')) + '</th><th>' + esc(t('journal.reason')) + '</th></tr></thead><tbody>' +
          d.items.map((e) => '<tr><td data-l="' + esc(t('journal.when')) + '">' + esc(String(e.at).slice(0, 10)) + '<div class="jr-muted">' + esc(String(e.at).slice(11, 19)) + '</div></td>' +
            '<td data-l="' + esc(t('journal.who')) + '">' + esc(e.actor ? e.actor.fullName : '—') + '<div class="jr-muted">' + esc(e.actor ? e.actor.loginId + ' · ' + t('journal.role.' + e.actor.role, e.actor.role) : '') + '</div></td>' +
            '<td data-l="' + esc(t('journal.action')) + '"><span class="jr-chip jr-cat-' + esc(e.category) + '">' + esc(t('journal.act.' + e.action.replace(/^journal\./, ''), e.action)) + '</span>' + (e.bulk ? ' <small class="jr-muted">bulk</small>' : '') + (e.published ? ' <small class="jr-muted">' + esc(t('journal.aud.published_grade')) + '</small>' : '') + '</td>' +
            '<td data-l="' + esc(t('journal.aud.entity')) + '">' + (e.entity.student ? esc(e.entity.student.fullName || e.entity.student.loginId) + '<div class="jr-muted">' + esc(e.entity.student.loginId) + '</div>' : '') + '<div class="jr-muted">' + esc([e.entity.subjectCode, e.entity.groupName, e.entity.component ? t('journal.comp.' + e.entity.component, e.entity.component) : '', e.entity.academicYear ? e.entity.academicYear + ' ' + (e.entity.term || '') : ''].filter(Boolean).join(' · ')) + '</div></td>' +
            '<td data-l="' + esc(t('journal.change')) + '">' + (e.old != null || e.new != null ? esc(av(e.old)) + ' → <b>' + esc(av(e.new)) + '</b>' + (e.max ? '<small class="jr-muted"> /' + e.max + '</small>' : '') : (e.count != null ? esc(t('journal.aud.count')) + ': ' + e.count : '—')) + '</td>' +
            '<td data-l="' + esc(t('journal.reason')) + '">' + esc(e.reason || '—') + '</td></tr>').join('') + '</tbody></table></div>' + pager(S.page, d.pageSize, d.total, 'aud') : tui().emptyBox(t('journal.aud.empty'));
        bindPager(body, (dir) => { S.page += dir; load(); });
      });
    }
    loadStats(); load();
  }

  // ═════════════════════════════ mount ═════════════════════════════
  const instances = new Map();
  async function mount(target, opts) {
    const root = typeof target === 'string' ? document.getElementById(target) : target;
    if (!root) return;
    const prev = instances.get(root);
    const ctx = prev && prev.role === opts.role ? prev : { root, role: opts.role, state: null, meta: null, period: null, data: null };
    ctx.initialMode = opts.mode || ctx.initialMode;
    instances.set(root, ctx);
    root.classList.add('jr');
    root.innerHTML = skeleton(4);
    ctx.render = () => ({ STUDENT: studentView, TEACHER: teacherView, LEADERSHIP: leadershipView, IT_AUDITOR: auditorView }[ctx.role] || (() => {}))(ctx);
    try {
      ctx.meta = await api().meta();
      if (!ctx.period) ctx.period = Object.assign({}, ctx.meta.currentPeriod);
      ctx.render();
    } catch (e) {
      root.innerHTML = tui().errorBox(errText(e), 'jr-retry');
      const b = root.querySelector('#jr-retry'); if (b) b.addEventListener('click', () => mount(target, opts));
    }
  }
  document.addEventListener('ap:lang-changed', () => { instances.forEach((ctx) => { if (ctx.root.isConnected && ctx.meta && ctx.render) { try { ctx.render(); } catch { /* ignore */ } } }); });

  AP.journal = { mount };
})(window);
