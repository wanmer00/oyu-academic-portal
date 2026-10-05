// ============================================================
// Teacher workspace — страницы: dashboard, classes, journal, attendance,
// assignments, materials, analytics, requests.
// Все данные — с бэкенда; права проверяет сервер (UI лишь отражает их).
// ============================================================
(function (global) {
  'use strict';
  const AP = (global.AP = global.AP || {});

  function create(ctx) {
    const { t, esc, openModal, confirmDialog, skeleton, errorBox, emptyBox, saveBlob } = AP.tui;
    const { toast, fmtDate, fmtDateTime, gradeColor, showPage } = ctx;
    const api = () => AP.api.teacher;
    const DOW = ['', 'schedule.monday', 'schedule.tuesday', 'schedule.wednesday', 'schedule.thursday', 'schedule.friday', 'schedule.saturday', 'schedule.sunday'];
    const $ = (id) => document.getElementById(id);
    const errMsg = (e) => (e && e.message) || t('common.error');

    // ── Выбранный класс (предмет × группа) запоминаем между страницами ──
    let classesCache = null;
    async function getClasses(force) {
      if (!classesCache || force) classesCache = await api().classes();
      return classesCache;
    }
    const clsKey = (c) => c.subject.code + '|' + c.groupName;
    function selectedKey() { try { return sessionStorage.getItem('ap_t_class') || ''; } catch { return ''; } }
    function setSelected(key) { try { sessionStorage.setItem('ap_t_class', key); } catch { /* ignore */ } }
    function pickClass(list) {
      return list.find((c) => clsKey(c) === selectedKey()) || list[0] || null;
    }
    function classOptions(list, selKey, withAll) {
      return (withAll ? '<option value="">' + esc(t('tch.all_classes')) + '</option>' : '') +
        list.map((c) => '<option value="' + esc(clsKey(c)) + '"' + (clsKey(c) === selKey ? ' selected' : '') + '>' + esc(c.subject.code + ' · ' + c.groupName) + '</option>').join('');
    }
    const gradeBadge = (v) => {
      if (v == null) return '<span class="badge badge-gray">—</span>';
      const c = gradeColor(Number(v));
      return '<span class="badge" style="background:' + c.bg + ';color:' + c.c + '">' + Number(v).toFixed(1) + '</span>';
    };
    const rateBadge = (r) => r == null ? '<span class="badge badge-gray">—</span>'
      : '<span class="badge ' + (r >= 85 ? 'badge-success' : r >= 70 ? 'badge-warning' : 'badge-danger') + '">' + r + '%</span>';
    const stat = (icon, val, label) => '<div class="stat-card"><div class="stat-icon" style="background:#ede9fe;color:#5b21b6">' + icon + '</div><div class="stat-val">' + esc(val) + '</div><div class="stat-label">' + esc(label) + '</div></div>';
    const noClassesHtml = '<div class="card"><div class="empty">' + esc(t('tch.no_classes')) + '</div></div>';
    const statusLabel = (s) => t('tch.status.' + s, s);
    const asgBadge = (s) => '<span class="badge ' + ({ DRAFT: 'badge-gray', PUBLISHED: 'badge-success', CLOSED: 'badge-warning' }[s] || 'badge-gray') + '">' + esc(statusLabel(s)) + '</span>';
    const today = () => new Date().toISOString().slice(0, 10);

    // ═══════════════════ DASHBOARD ═══════════════════
    async function dashboard() {
      const root = $('tx-dashboard');
      root.innerHTML = '<div class="stat-grid">' + '<div class="skel" style="height:110px"></div>'.repeat(4) + '</div>' + skeleton(3);
      try {
        const d = await api().dashboard();
        const qa = [
          ['t-journal', 'tch.qa_journal'], ['t-attendance', 'tch.qa_attendance'],
          ['t-assignments', 'tch.qa_new_assignment', 'new-assignment'], ['t-materials', 'tch.qa_new_material', 'new-material'], ['t-analytics', 'tch.qa_analytics'],
        ];
        root.innerHTML =
          '<div class="qa-row" id="td-qa">' + qa.map((q, i) => '<button class="qa-btn" data-i="' + i + '"><span>' + esc(t(q[1])) + '</span></button>').join('') + '</div>' +
          '<div class="stat-grid">' +
            stat('👥', d.counts.students, t('tch.students')) +
            stat('📚', d.counts.subjects + ' / ' + d.counts.groups, t('tch.subjects_groups')) +
            stat('📝', d.pendingGrading.count, t('tch.pending_grading')) +
            stat('✉️', d.requests.pending, t('tch.pending_requests')) +
          '</div>' +
          '<div class="tui-grid-2">' +
            '<div class="card"><div class="card-pad"><div class="card-title">' + esc(t('tch.today_classes')) + '</div>' +
              (d.today.length ? d.today.map((c) => {
                const done = c.studentsCount > 0 && c.attendanceMarked >= c.studentsCount;
                return '<div class="tui-row"><div style="min-width:0"><div class="t">' + esc(c.subject.code + ' · ' + c.subject.name) + '</div>' +
                  '<div class="s">' + esc(c.startTime + '–' + c.endTime) + ' · ' + esc(c.groupName) + ' · 🏛 ' + esc(c.room) + '</div></div>' +
                  '<div class="tui-actions"><span class="badge ' + (done ? 'badge-success' : 'badge-warning') + '">' + esc(t('tch.attendance')) + ': ' + c.attendanceMarked + '/' + c.studentsCount + '</span>' +
                  '<button class="btn btn-outline btn-sm" data-att="' + esc(c.subject.code + '|' + c.groupName) + '">' + esc(t('tch.mark')) + '</button></div></div>';
              }).join('') : emptyBox(t('tch.no_classes_today'))) + '</div></div>' +
            '<div class="card"><div class="card-pad"><div class="card-title">' + esc(t('tch.pending_grading')) + '</div>' +
              (d.pendingGrading.items.length ? d.pendingGrading.items.map((s) =>
                '<div class="tui-row"><div style="min-width:0"><div class="t">' + esc(s.assignmentTitle) + '</div>' +
                '<div class="s">' + esc(s.student.fullName) + ' · ' + esc(s.subject.code) + (s.submittedAt ? ' · ' + esc(fmtDate(s.submittedAt)) : '') + '</div></div>' +
                '<button class="btn btn-purple btn-sm" data-subs="' + esc(s.assignmentId) + '" data-title="' + esc(s.assignmentTitle) + '">' + esc(t('tch.grade')) + '</button></div>').join('')
                : emptyBox(t('tch.nothing_to_grade'))) + '</div></div>' +
            '<div class="card"><div class="card-pad"><div class="card-title">' + esc(t('tch.assignment_activity')) + '</div>' +
              '<div class="pill-group"><span class="pill pill-ok">' + esc(statusLabel('PUBLISHED')) + ': ' + d.assignments.published + '</span>' +
              '<span class="pill pill-info">' + esc(statusLabel('DRAFT')) + ': ' + d.assignments.draft + '</span>' +
              '<span class="pill pill-danger">' + esc(statusLabel('CLOSED')) + ': ' + d.assignments.closed + '</span></div>' +
              '<div class="tui-muted" style="margin-bottom:6px">' + esc(t('tch.submissions_7d')) + ': <b>' + d.assignments.submissionsLast7d + '</b></div>' +
              (d.assignments.dueSoon.length ? d.assignments.dueSoon.map((a) =>
                '<div class="tui-row"><div style="min-width:0"><div class="t">' + esc(a.title) + '</div><div class="s">' + esc(a.subject.code) + ' · ' + esc(t('tch.submitted')) + ': ' + a.submitted + '</div></div>' +
                '<span class="badge badge-warning">' + esc(fmtDate(a.dueDate)) + '</span></div>').join('') : emptyBox(t('tch.no_active_assignments'))) + '</div></div>' +
            '<div class="card"><div class="card-pad"><div class="card-title">' + esc(t('tch.attendance')) + ' · ' + esc(t('tch.today')) + '</div>' +
              '<div class="tui-kv"><span>' + esc(t('tch.classes_today')) + '</span><b>' + d.attendanceToday.classes + '</b></div>' +
              '<div class="tui-kv"><span>' + esc(t('tch.att_completed')) + '</span><b>' + d.attendanceToday.completed + '</b></div>' +
              '<div class="tui-kv"><span>' + esc(t('tch.att_pending')) + '</span><b>' + d.attendanceToday.pending + '</b></div>' +
              '<div class="tui-kv"><span>' + esc(t('tch.pending_requests')) + '</span><b>' + d.requests.pending + '</b></div>' +
              '<div style="margin-top:10px"><button class="btn btn-outline btn-sm" id="td-req">' + esc(t('tch.open_requests')) + '</button></div></div></div>' +
          '</div>';
        root.querySelectorAll('#td-qa .qa-btn').forEach((b) => b.addEventListener('click', async () => {
          const q = qa[Number(b.dataset.i)];
          await showPage(q[0]);
          if (q[2] === 'new-assignment') openAssignmentForm();
          if (q[2] === 'new-material') openMaterialForm();
        }));
        root.querySelectorAll('[data-att]').forEach((b) => b.addEventListener('click', async () => { setSelected(b.dataset.att); await showPage('t-attendance'); }));
        root.querySelectorAll('[data-subs]').forEach((b) => b.addEventListener('click', () => openSubmissions(b.dataset.subs, b.dataset.title)));
        $('td-req').addEventListener('click', () => showPage('t-requests'));
      } catch (e) {
        root.innerHTML = errorBox(errMsg(e), 'td-retry');
        const r = $('td-retry'); if (r) r.addEventListener('click', dashboard);
      }
    }

    // ═══════════════════ CLASSES ═══════════════════
    async function classes() {
      const root = $('tx-classes');
      root.innerHTML = '<div class="tui-grid">' + '<div class="skel" style="height:220px"></div>'.repeat(3) + '</div>';
      try {
        const list = await getClasses(true);
        if (!list.length) { root.innerHTML = noClassesHtml; return; }
        root.innerHTML = '<div class="tui-grid">' + list.map((c) => {
          const nc = c.nextClass;
          return '<div class="card"><div class="card-pad">' +
            '<div class="tui-card-head"><div><div class="tui-title">' + esc(c.subject.code + ' · ' + c.subject.name) + '</div><div class="tui-muted">' + esc(c.groupName) + '</div></div>' +
            (c.pendingGrading ? '<span class="badge badge-warning">' + c.pendingGrading + ' ' + esc(t('tch.to_grade')) + '</span>' : '') + '</div>' +
            '<div class="tui-kv"><span>' + esc(t('tch.students')) + '</span><b>' + c.studentsCount + '</b></div>' +
            '<div class="tui-kv"><span>' + esc(t('tch.avg_grade')) + '</span>' + gradeBadge(c.averageGrade) + '</div>' +
            '<div class="tui-kv"><span>' + esc(t('tch.attendance_rate')) + '</span>' + rateBadge(c.attendanceRate) + '</div>' +
            '<div class="tui-kv"><span>' + esc(t('tch.next_class')) + '</span><b>' + (nc ? esc(fmtDate(nc.date) + ' · ' + nc.startTime + ' · ' + nc.room) : '—') + '</b></div>' +
            '<div class="tui-muted" style="margin:8px 0">' + c.slots.map((s) => esc(t(DOW[s.dayOfWeek]).slice(0, 3) + ' ' + s.startTime)).join(' · ') + '</div>' +
            '<div class="tui-actions">' + [['t-journal', 'nav.journal'], ['t-attendance', 'tch.qa_attendance'], ['t-assignments', 'assignments.title'], ['t-analytics', 'nav.analytics']]
              .map(([p, k]) => '<button class="btn btn-outline btn-sm" data-go="' + p + '" data-key="' + esc(clsKey(c)) + '">' + esc(t(k)) + '</button>').join('') + '</div>' +
            '</div></div>';
        }).join('') + '</div>';
        root.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', async () => { setSelected(b.dataset.key); await showPage(b.dataset.go); }));
      } catch (e) {
        root.innerHTML = errorBox(errMsg(e), 'tc-retry');
        const r = $('tc-retry'); if (r) r.addEventListener('click', classes);
      }
    }

    // ═══════════════════ JOURNAL ═══════════════════
    // Academic Journal — единый модуль для всех ролей (js/journal.js); здесь только точка входа.
    async function journal() {
      AP.journal.mount('tx-journal', { role: 'TEACHER' });
    }
    // ═══════════════════ ATTENDANCE ═══════════════════
    // Посещаемость — режим единого Academic Journal (js/journal.js): отметка по группе/дате и статистика за период.
    async function attendance() {
      AP.journal.mount('tx-attendance', { role: 'TEACHER', mode: 'attendance' });
    }

    // ═══════════════════ ASSIGNMENTS ═══════════════════
    const AS = { items: [], filter: '' };
    async function assignments() {
      const root = $('tx-assignments');
      root.innerHTML = skeleton(4);
      try {
        const [items, list] = await Promise.all([api().assignments(), getClasses()]);
        AS.items = items;
        root.innerHTML =
          '<div class="tui-bar"><select class="input" id="tas-status" aria-label="' + esc(t('common.status')) + '"><option value="">' + esc(t('tch.all_statuses')) + '</option>' +
            ['DRAFT', 'PUBLISHED', 'CLOSED'].map((s) => '<option value="' + s + '"' + (AS.filter === s ? ' selected' : '') + '>' + esc(statusLabel(s)) + '</option>').join('') + '</select>' +
            '<div class="tui-spacer"></div><button class="btn btn-purple btn-sm" id="tas-new"' + (list.length ? '' : ' disabled') + '>+ ' + esc(t('teacher.new_assignment')) + '</button></div>' +
          '<div class="card" style="overflow:hidden"><div class="tui-table-wrap"><table><thead><tr><th>' + esc(t('grades.subject')) + '</th><th>' + esc(t('assignments.name')) + '</th><th>' + esc(t('assignments.due_date')) + '</th><th>' + esc(t('common.status')) + '</th><th>' + esc(t('assignments.submissions')) + '</th><th></th></tr></thead><tbody id="tas-body"></tbody></table></div><div id="tas-empty"></div></div>';
        $('tas-status').addEventListener('change', (e) => { AS.filter = e.target.value; renderAssignmentRows(); });
        $('tas-new').addEventListener('click', () => openAssignmentForm());
        renderAssignmentRows();
      } catch (e) {
        root.innerHTML = errorBox(errMsg(e), 'tas-retry');
        const r = $('tas-retry'); if (r) r.addEventListener('click', assignments);
      }
    }
    function renderAssignmentRows() {
      const rows = AS.items.filter((a) => !AS.filter || a.status === AS.filter);
      $('tas-empty').innerHTML = rows.length ? '' : emptyBox(t('assignments.no_assignments'));
      $('tas-body').innerHTML = rows.map((a) => {
        const acts = [];
        if (a.status === 'DRAFT') acts.push(['PUBLISHED', 'tch.publish', 'btn-success']);
        if (a.status === 'PUBLISHED') { acts.push(['CLOSED', 'tch.close', 'btn-outline']); if (!a.submissionsCount) acts.push(['DRAFT', 'tch.unpublish', 'btn-outline']); }
        if (a.status === 'CLOSED') acts.push(['PUBLISHED', 'tch.reopen', 'btn-outline']);
        return '<tr><td><b>' + esc(a.subject.code) + '</b><div class="tui-muted">' + esc(a.subject.name) + '</div></td>' +
          '<td><div style="font-weight:600">' + esc(a.title) + '</div><div class="tui-muted">' + esc(a.description.slice(0, 90)) + '</div>' +
          (a.materials.length ? '<div class="tui-muted">📎 ' + a.materials.length + ' ' + esc(t('materials.title').toLowerCase()) + '</div>' : '') + '</td>' +
          '<td>' + esc(fmtDateTime(a.dueDate)) + '</td><td>' + asgBadge(a.status) + '</td>' +
          '<td><span class="badge badge-info">' + a.submissionsCount + '</span> ' + (a.pendingCount ? '<span class="badge badge-warning">' + a.pendingCount + ' ' + esc(t('tch.to_grade')) + '</span>' : '') + '</td>' +
          '<td><div class="tui-actions"><button class="btn btn-outline btn-sm" data-subs="' + esc(a.id) + '" data-title="' + esc(a.title) + '">' + esc(t('assignments.submissions')) + '</button>' +
          '<button class="btn btn-outline btn-sm" data-edit="' + esc(a.id) + '">' + esc(t('common.edit', 'Edit')) + '</button>' +
          acts.map(([st, k, cls]) => '<button class="btn ' + cls + ' btn-sm" data-st="' + st + '" data-id="' + esc(a.id) + '" data-title="' + esc(a.title) + '">' + esc(t(k)) + '</button>').join('') + '</div></td></tr>';
      }).join('');
      const tb = $('tas-body');
      tb.querySelectorAll('[data-subs]').forEach((b) => b.addEventListener('click', () => openSubmissions(b.dataset.subs, b.dataset.title)));
      tb.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openAssignmentForm(AS.items.find((x) => x.id === b.dataset.edit))));
      tb.querySelectorAll('[data-st]').forEach((b) => b.addEventListener('click', async () => {
        const st = b.dataset.st;
        if (!(await confirmDialog({ message: t('tch.confirm_status_' + st).replace('{title}', b.dataset.title) }))) return;
        try { await api().setAssignmentStatus(b.dataset.id, st); toast(t('tch.status_changed')); await assignments(); }
        catch (e) { toast(errMsg(e), true); }
      }));
    }
    const toLocalInput = (iso) => { const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); };
    async function openAssignmentForm(a) {
      const list = await getClasses();
      const subjects = Array.from(new Map(list.map((c) => [c.subject.code, c.subject])).values());
      const editing = !!a;
      openModal({
        title: editing ? t('tch.edit_assignment') : t('teacher.new_assignment'), wide: true, static: true,
        html: '<div class="form-group"><div class="form-label">' + esc(t('teacher.select_subject')) + '</div><select class="input" id="af-subj"' + (editing ? ' disabled' : '') + '>' +
            subjects.map((s) => '<option value="' + esc(s.code) + '"' + (editing && a.subject.code === s.code ? ' selected' : '') + '>' + esc(s.code + ' · ' + s.name) + '</option>').join('') + '</select></div>' +
          '<div class="form-group"><div class="form-label">' + esc(t('assignments.name')) + '</div><input class="input" id="af-title" maxlength="200" value="' + esc(editing ? a.title : '') + '"></div>' +
          '<div class="form-group"><div class="form-label">' + esc(t('assignments.description')) + '</div><textarea class="input" id="af-desc" maxlength="5000">' + esc(editing ? a.description : '') + '</textarea></div>' +
          '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px">' +
          '<div class="form-group"><div class="form-label">' + esc(t('assignments.due_date')) + '</div><input class="input" id="af-due" type="datetime-local" value="' + (editing ? toLocalInput(a.dueDate) : '') + '"></div>' +
          '<div class="form-group"><div class="form-label">' + esc(t('assignments.max_grade')) + '</div><input class="input" id="af-max" type="number" min="1" max="100" value="' + (editing ? a.maxGrade : 100) + '"></div></div>' +
          (editing ? '<div class="tui-note">' + esc(t('common.status')) + ': ' + asgBadge(a.status) + (a.materials.length ? '<br>📎 ' + a.materials.map((m) => esc(m.title)).join(', ') : '<br>' + esc(t('tch.no_linked_materials'))) + '</div>'
            : '<label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" class="tui-cb" id="af-pub" checked> ' + esc(t('tch.publish_now')) + '</label>') +
          '<div class="tui-err" id="af-err" role="alert"></div>',
        buttons: [{ label: t('common.cancel') }, { label: t('common.save'), cls: 'btn-purple', onClick: async (h) => {
          const title = h.$('#af-title').value.trim(), desc = h.$('#af-desc').value.trim(), due = h.$('#af-due').value, max = Number(h.$('#af-max').value);
          if (title.length < 3) { h.$('#af-err').textContent = t('tch.err.title_short'); return false; }
          if (!desc) { h.$('#af-err').textContent = t('tch.err.desc_required'); return false; }
          if (!due || Number.isNaN(new Date(due).getTime())) { h.$('#af-err').textContent = t('tch.err.due_required'); return false; }
          if (!(max >= 1 && max <= 100)) { h.$('#af-err').textContent = t('tch.err.max_range'); return false; }
          try {
            if (editing) await api().updateAssignment(a.id, { title, description: desc, dueDate: new Date(due).toISOString(), maxGrade: max });
            else await api().createAssignment({ subjectCode: h.$('#af-subj').value, title, description: desc, dueDate: new Date(due).toISOString(), maxGrade: max, publish: h.$('#af-pub').checked });
            toast(t('tch.saved')); await assignments();
          } catch (e) { h.$('#af-err').textContent = errMsg(e); return false; }
        } }],
      });
    }

    // Проверка работ (модалка вместо prompt)
    async function openSubmissions(assignmentId, title) {
      const m = openModal({ title: title || t('assignments.submissions'), wide: true, html: skeleton(3), buttons: [{ label: t('common.close') }] });
      const load = async () => {
        try {
          const subs = await api().assignmentSubmissions(assignmentId);
          m.body.innerHTML = subs.length
            ? '<div class="tui-table-wrap"><table><thead><tr><th>' + esc(t('tch.student')) + '</th><th>' + esc(t('common.status')) + '</th><th>' + esc(t('grades.value')) + '</th><th></th></tr></thead><tbody>' +
              subs.map((s) => '<tr><td><b>' + esc(s.student.fullName) + '</b> <code>' + esc(s.student.loginId) + '</code><div class="tui-muted">' + (s.fileName ? esc(s.fileName) + ' · ' : '') + esc((s.studentNotes || '').slice(0, 80)) + '</div></td>' +
                '<td><span class="badge badge-gray">' + esc(s.status) + '</span></td><td>' + (s.grade != null ? Number(s.grade).toFixed(1) : '—') + '</td>' +
                '<td><button class="btn btn-purple btn-sm" data-gs="' + esc(s.id) + '" data-n="' + esc(s.student.fullName) + '" data-g="' + (s.grade ?? '') + '" data-f="' + esc(s.feedback || '') + '">' + esc(t('teacher.grade_submission')) + '</button></td></tr>').join('') + '</tbody></table></div>'
            : emptyBox(t('tch.no_submissions'));
          m.body.querySelectorAll('[data-gs]').forEach((b) => b.addEventListener('click', () => openGradeSubmission(b.dataset, load)));
        } catch (e) { m.body.innerHTML = errorBox(errMsg(e)); }
      };
      await load();
    }
    function openGradeSubmission(ds, after) {
      openModal({
        title: t('teacher.grade_submission') + ' · ' + ds.n,
        html: '<div class="form-group"><div class="form-label">' + esc(t('teacher.value')) + '</div><input class="input" id="gs-v" type="number" min="0" max="100" step="0.1" value="' + esc(ds.g) + '"></div>' +
          '<div class="form-group"><div class="form-label">' + esc(t('teacher.feedback')) + '</div><textarea class="input" id="gs-f" maxlength="2000">' + esc(ds.f) + '</textarea></div><div class="tui-err" id="gs-err" role="alert"></div>',
        buttons: [{ label: t('common.cancel') }, { label: t('common.save'), cls: 'btn-purple', onClick: async (h) => {
          const raw = h.$('#gs-v').value; const v = Number(raw);
          if (raw === '' || !(v >= 0 && v <= 100)) { h.$('#gs-err').textContent = t('tch.err.invalid_value'); return false; }
          try { await api().gradeSubmission(ds.gs, { grade: v, feedback: h.$('#gs-f').value.trim() || undefined }); toast(t('teacher.grade_updated')); await after(); if ($('tx-assignments').offsetParent) assignments(); if ($('tx-dashboard').offsetParent) dashboard(); }
          catch (e) { h.$('#gs-err').textContent = errMsg(e); return false; }
        } }],
      });
    }

    // ═══════════════════ MATERIALS ═══════════════════
    const M = { items: [], q: '', subject: '' };
    async function materials() {
      const root = $('tx-materials');
      root.innerHTML = skeleton(4);
      try {
        const [items, list] = await Promise.all([api().materials(), getClasses()]);
        M.items = items;
        const subjects = Array.from(new Map(items.map((m) => [m.subject.code, m.subject])).values());
        root.innerHTML =
          '<div class="tui-bar"><input class="input grow" id="tm-q" type="search" placeholder="🔍 ' + esc(t('common.search')) + '" aria-label="' + esc(t('common.search')) + '">' +
            '<select class="input" id="tm-subj"><option value="">' + esc(t('tch.all_subjects')) + '</option>' + subjects.map((s) => '<option value="' + esc(s.code) + '">' + esc(s.code) + '</option>').join('') + '</select>' +
            '<button class="btn btn-purple btn-sm" id="tm-new"' + (list.length ? '' : ' disabled') + '>+ ' + esc(t('teacher.new_material')) + '</button></div>' +
          '<div class="card" style="overflow:hidden"><div class="tui-table-wrap"><table><thead><tr><th>' + esc(t('materials.name')) + '</th><th>' + esc(t('grades.subject')) + '</th><th>' + esc(t('materials.type')) + '</th><th>' + esc(t('tch.linked_assignment')) + '</th><th>' + esc(t('tch.author')) + '</th><th></th></tr></thead><tbody id="tm-body"></tbody></table></div><div id="tm-empty"></div></div>';
        $('tm-q').addEventListener('input', (e) => { M.q = e.target.value; renderMaterialRows(); });
        $('tm-subj').addEventListener('change', (e) => { M.subject = e.target.value; renderMaterialRows(); });
        $('tm-new').addEventListener('click', () => openMaterialForm());
        renderMaterialRows();
      } catch (e) {
        root.innerHTML = errorBox(errMsg(e), 'tm-retry');
        const r = $('tm-retry'); if (r) r.addEventListener('click', materials);
      }
    }
    function renderMaterialRows() {
      const q = M.q.trim().toLowerCase();
      const rows = M.items.filter((m) => (!M.subject || m.subject.code === M.subject) && (!q || m.title.toLowerCase().includes(q)));
      $('tm-empty').innerHTML = rows.length ? '' : emptyBox(t('materials.no_materials'));
      $('tm-body').innerHTML = rows.map((m) =>
        '<tr><td><b>' + esc(m.title) + '</b><div class="tui-muted">' + esc(fmtDate(m.createdAt)) + '</div></td><td>' + esc(m.subject.code) + '</td><td><span class="badge badge-gray">' + esc(m.type) + '</span></td>' +
        '<td>' + (m.assignment ? esc(m.assignment.title) : '—') + '</td><td class="tui-muted">' + (m.mine ? '<span class="badge badge-purple">' + esc(t('tch.mine')) + '</span>' : esc(m.author || '—')) + '</td>' +
        '<td><div class="tui-actions">' + (m.url ? '<a class="btn btn-outline btn-sm" href="' + esc(m.url) + '" target="_blank" rel="noopener noreferrer">' + esc(t('materials.open')) + ' ↗</a>' : '') +
        (m.mine ? '<button class="btn btn-outline btn-sm" data-edit="' + esc(m.id) + '">' + esc(t('common.edit', 'Edit')) + '</button><button class="btn btn-danger btn-sm" data-del="' + esc(m.id) + '" data-title="' + esc(m.title) + '" aria-label="' + esc(t('common.delete', 'Delete')) + '">✕</button>' : '') + '</div></td></tr>').join('');
      const tb = $('tm-body');
      tb.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openMaterialForm(M.items.find((x) => x.id === b.dataset.edit))));
      tb.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        if (!(await confirmDialog({ message: t('tch.confirm_delete_material').replace('{title}', b.dataset.title), danger: true, confirmLabel: t('common.delete', 'Delete') }))) return;
        try { await api().deleteMaterial(b.dataset.del); toast(t('materials.deleted')); await materials(); } catch (e) { toast(errMsg(e), true); }
      }));
    }
    async function openMaterialForm(mat) {
      const [list, asg] = await Promise.all([getClasses(), api().assignments()]);
      const subjects = Array.from(new Map(list.map((c) => [c.subject.code, c.subject])).values());
      const editing = !!mat;
      const asgOpts = (code) => '<option value="">—</option>' + asg.filter((a) => a.subject.code === code).map((a) => '<option value="' + esc(a.id) + '"' + (editing && mat.assignment && mat.assignment.id === a.id ? ' selected' : '') + '>' + esc(a.title) + '</option>').join('');
      openModal({
        title: editing ? t('tch.edit_material') : t('teacher.new_material'), static: true,
        html: '<div class="form-group"><div class="form-label">' + esc(t('teacher.select_subject')) + '</div><select class="input" id="mf-subj"' + (editing ? ' disabled' : '') + '>' +
            subjects.map((s) => '<option value="' + esc(s.code) + '"' + (editing && mat.subject.code === s.code ? ' selected' : '') + '>' + esc(s.code + ' · ' + s.name) + '</option>').join('') + '</select></div>' +
          '<div class="form-group"><div class="form-label">' + esc(t('materials.name')) + '</div><input class="input" id="mf-title" maxlength="200" value="' + esc(editing ? mat.title : '') + '"></div>' +
          '<div class="form-group"><div class="form-label">' + esc(t('materials.type')) + '</div><select class="input" id="mf-type">' + ['LINK', 'PDF', 'DOC', 'VIDEO', 'OTHER'].map((k) => '<option value="' + k + '"' + (editing && mat.type === k ? ' selected' : '') + '>' + k + '</option>').join('') + '</select></div>' +
          '<div class="form-group"><div class="form-label">URL (https://…)</div><input class="input" id="mf-url" type="url" maxlength="2000" placeholder="https://" value="' + esc(editing ? mat.url || '' : '') + '"></div>' +
          '<div class="form-group"><div class="form-label">' + esc(t('tch.linked_assignment')) + '</div><select class="input" id="mf-asg"></select></div><div class="tui-err" id="mf-err" role="alert"></div>',
        buttons: [{ label: t('common.cancel') }, { label: t('common.save'), cls: 'btn-purple', onClick: async (h) => {
          const title = h.$('#mf-title').value.trim(), url = h.$('#mf-url').value.trim(), aid = h.$('#mf-asg').value;
          if (!title) { h.$('#mf-err').textContent = t('tch.err.title_short'); return false; }
          if (url && !/^https?:\/\//i.test(url)) { h.$('#mf-err').textContent = t('tch.err.url_http'); return false; }
          if (!url && !(editing && mat.fileName)) { h.$('#mf-err').textContent = t('tch.err.url_required'); return false; }
          try {
            if (editing) await api().updateMaterial(mat.id, { title, type: h.$('#mf-type').value, url: url || null, assignmentId: aid || null });
            else await api().createMaterial({ subjectCode: h.$('#mf-subj').value, title, type: h.$('#mf-type').value, url: url || undefined, assignmentId: aid || undefined });
            toast(t('tch.saved')); await materials();
          } catch (e) { h.$('#mf-err').textContent = errMsg(e); return false; }
        } }],
      });
      const sync = () => { $('mf-asg').innerHTML = asgOpts($('mf-subj').value); };
      sync(); $('mf-subj').addEventListener('change', sync);
    }

    // ═══════════════════ ANALYTICS ═══════════════════
    const AN = { key: '' };
    function distChart(dist) {
      const max = Math.max(1, ...dist.map((d) => d.count));
      const colors = ['#ef4444', '#f59e0b', '#eab308', '#3b82f6', '#10b981'];
      return '<div class="tui-bar-chart">' + dist.map((d, i) => '<div class="tui-bar-line"><span>' + esc(d.range) + '</span><div class="tui-bar-track"><div class="tui-bar-fill" style="width:' + Math.round((d.count / max) * 100) + '%;background:' + colors[i] + '"></div></div><b>' + d.count + '</b></div>').join('') + '</div>';
    }
    async function analytics() {
      const root = $('tx-analytics');
      root.innerHTML = skeleton(4);
      try {
        const list = await getClasses();
        if (!list.length) { root.innerHTML = noClassesHtml; return; }
        const [code, group] = AN.key ? AN.key.split('|') : ['', ''];
        const d = await api().analytics({ subjectCode: code, groupName: group });
        const o = d.overview;
        root.innerHTML =
          '<div class="tui-bar"><select class="input" id="tn-class" aria-label="' + esc(t('tch.class')) + '">' + classOptions(list, AN.key, true) + '</select></div>' +
          '<div class="stat-grid">' + stat('📊', o.averageGrade != null ? o.averageGrade : '—', t('tch.avg_grade')) + stat('✅', o.attendanceRate != null ? o.attendanceRate + '%' : '—', t('tch.attendance_rate')) +
            stat('📝', o.assignmentCompletion != null ? o.assignmentCompletion + '%' : '—', t('tch.assignment_completion')) + stat('👥', o.students, t('tch.students')) + '</div>' +
          '<div class="tui-grid-2"><div class="card"><div class="card-pad"><div class="card-title">' + esc(t('tch.grade_distribution')) + ' <span class="tui-muted">(' + o.gradesCount + ')</span></div>' +
            (o.gradesCount ? distChart(o.distribution) : emptyBox(t('grades.no_grades'))) + '</div></div>' +
            '<div class="card"><div class="card-pad"><div class="card-title">' + esc(t('tch.by_class')) + '</div>' +
            d.classes.map((c) => '<div class="tui-row"><div style="min-width:0"><div class="t">' + esc(c.subject.code + ' · ' + c.groupName) + '</div><div class="s">' + c.studentsCount + ' ' + esc(t('tch.students')) + '</div></div>' +
              '<div class="tui-actions">' + gradeBadge(c.averageGrade) + rateBadge(c.attendanceRate) + '<span class="badge badge-info">' + (c.assignmentCompletion != null ? c.assignmentCompletion + '%' : '—') + '</span></div></div>').join('') + '</div></div></div>' +
          '<div class="card"><div class="card-pad"><div class="card-title">⚠ ' + esc(t('tch.at_risk')) + '</div>' +
            (d.atRisk.length ? '<div class="tui-table-wrap"><table><thead><tr><th>' + esc(t('tch.student')) + '</th><th>' + esc(t('tch.class')) + '</th><th>' + esc(t('tch.avg_grade')) + '</th><th>' + esc(t('tch.attendance')) + '</th><th>' + esc(t('tch.reason')) + '</th></tr></thead><tbody>' +
              d.atRisk.map((r) => '<tr><td><b>' + esc(r.fullName) + '</b><div class="tui-muted">' + esc(r.loginId) + '</div></td><td>' + esc(r.subject.code + ' · ' + r.groupName) + '</td><td>' + gradeBadge(r.averageGrade) + '</td><td>' + rateBadge(r.attendanceRate) + '</td><td>' + r.reasons.map((x) => '<span class="badge badge-danger" style="margin-right:4px">' + esc(t('tch.reason_' + x)) + '</span>').join('') + '</td></tr>').join('') + '</tbody></table></div>'
              : emptyBox('✅ ' + t('tch.no_risk'))) + '</div></div>';
        $('tn-class').addEventListener('change', (e) => { AN.key = e.target.value; analytics(); });
      } catch (e) {
        root.innerHTML = errorBox(errMsg(e), 'tn-retry');
        const r = $('tn-retry'); if (r) r.addEventListener('click', analytics);
      }
    }

    // ═══════════════════ REQUESTS ═══════════════════
    const R = { status: '' };
    async function requests() {
      const root = $('tx-requests');
      const tabs = '<div class="ex-tabs" role="tablist"><button class="ex-tab' + (R.view !== 'appeals' ? ' on' : '') + '" data-rv="all">' + esc(t('ap.tab_all')) + '</button><button class="ex-tab' + (R.view === 'appeals' ? ' on' : '') + '" data-rv="appeals">' + esc(t('ap.tab_exam_appeals')) + '</button></div>';
      const bindTabs = () => root.querySelectorAll('[data-rv]').forEach((b) => b.addEventListener('click', () => { R.view = b.dataset.rv; requests(); }));
      if (R.view === 'appeals') { root.innerHTML = tabs + '<div id="tx-appeals"></div>'; bindTabs(); return AP.appeals.staffPanel($('tx-appeals'), 'teacher'); }
      root.innerHTML = skeleton(4);
      try {
        const items = await api().requests(R.status);
        const typeMap = { APPEAL: t('requests.appeal'), OTHER: t('requests.other'), CERTIFICATE: t('requests.certificate'), TRANSFER: t('requests.transfer') };
        const st = { PENDING: ['badge-warning', t('requests.status.pending')], UNDER_REVIEW: ['badge-info', t('requests.status.under_review')], APPROVED: ['badge-success', t('requests.status.approved')], PARTIALLY_APPROVED: ['badge-success', t('requests.status.partially_approved')], REJECTED: ['badge-danger', t('requests.status.rejected')], WITHDRAWN: ['badge-gray', t('requests.status.withdrawn')] };
        root.innerHTML = tabs +
          '<div class="tui-note">' + esc(t('tch.requests_scope')) + '</div>' +
          '<div class="tui-bar"><select class="input" id="tr-status" aria-label="' + esc(t('common.status')) + '"><option value="">' + esc(t('tch.all_statuses')) + '</option>' +
            Object.keys(st).map((k) => '<option value="' + k + '"' + (R.status === k ? ' selected' : '') + '>' + esc(st[k][1]) + '</option>').join('') + '</select></div>' +
          '<div class="card" style="overflow:hidden">' + (items.length ? '<div class="tui-table-wrap"><table><thead><tr><th>' + esc(t('requests.student')) + '</th><th>' + esc(t('requests.type')) + '</th><th>' + esc(t('requests.description')) + '</th><th>' + esc(t('common.status')) + '</th><th>' + esc(t('grades.date')) + '</th><th></th></tr></thead><tbody>' +
            items.map((r) => { const u = r.user || {}; const s = st[r.status] || ['badge-gray', r.status];
              return '<tr><td><b>' + esc((u.fullName || '').split(' ').slice(0, 2).join(' ')) + '</b><div class="tui-muted">' + esc(u.loginId || '') + (u.student ? ' · ' + esc(u.student.groupName) : '') + '</div></td>' +
                '<td><span class="badge badge-gray">' + esc(typeMap[r.type] || r.type) + '</span></td><td style="white-space:normal;max-width:280px" class="tui-muted">' + esc(r.description) + (r.adminNote ? '<div><i>↪ ' + esc(r.adminNote) + '</i></div>' : '') + '</td>' +
                '<td><span class="badge ' + s[0] + '">' + esc(s[1]) + '</span></td><td class="tui-muted">' + esc(fmtDate(r.createdAt)) + '</td>' +
                '<td>' + (r.examAppeal ? '<button class="btn btn-primary btn-sm" data-appeal="' + esc(r.id) + '">' + esc(t('ap.review_appeal')) + '</button>' : '<button class="btn btn-outline btn-sm" data-reply="' + esc(r.id) + '">' + esc(t('requests.reply')) + '</button>') + '</td></tr>'; }).join('') + '</tbody></table></div>'
            : emptyBox(t('tch.no_requests'))) + '</div>';
        bindTabs();
        root.querySelectorAll('[data-appeal]').forEach((b) => b.addEventListener('click', () => AP.appeals.staffDetail('teacher', b.dataset.appeal, requests)));
        $('tr-status').addEventListener('change', (e) => { R.status = e.target.value; requests(); });
        root.querySelectorAll('[data-reply]').forEach((b) => b.addEventListener('click', () => openReply(items.find((x) => x.id === b.dataset.reply))));
      } catch (e) {
        root.innerHTML = errorBox(errMsg(e), 'tr-retry');
        const r = $('tr-retry'); if (r) r.addEventListener('click', requests);
      }
    }
    function openReply(r) {
      const u = r.user || {};
      openModal({
        title: t('requests.reply_title'), static: true,
        html: '<div class="tui-note"><b>' + esc(u.fullName || '') + '</b> <code>' + esc(u.loginId || '') + '</code><div style="white-space:pre-wrap;margin-top:4px">' + esc(r.description) + '</div></div>' +
          '<div class="form-group"><div class="form-label">' + esc(t('common.status')) + '</div><select class="input" id="rp-st"><option value="APPROVED">' + esc(t('requests.status.approved')) + '</option><option value="REJECTED">' + esc(t('requests.status.rejected')) + '</option><option value="PENDING">' + esc(t('requests.status.pending')) + '</option></select></div>' +
          '<div class="form-group"><div class="form-label">' + esc(t('requests.note')) + '</div><textarea class="input" id="rp-note" maxlength="1000">' + esc(r.adminNote || '') + '</textarea></div><div class="tui-err" id="rp-err" role="alert"></div>',
        buttons: [{ label: t('common.cancel') }, { label: t('common.save'), cls: 'btn-purple', onClick: async (h) => {
          if (!(await confirmDialog({ message: t('tch.confirm_reply').replace('{name}', u.fullName || '') }))) return false;
          try { await api().replyRequest(r.id, { status: h.$('#rp-st').value, adminNote: h.$('#rp-note').value.trim() || undefined }); toast(t('requests.replied')); await requests(); }
          catch (e) { h.$('#rp-err').textContent = errMsg(e); return false; }
        } }],
      });
      $('rp-st').value = r.status === 'PENDING' ? 'APPROVED' : r.status;
    }

    // ═══════════════════ TIMETABLE ═══════════════════
    // Моё расписание (опубликованное) на 2 недели + переход к посещаемости пары, и мои пожелания по времени.
    const TT = { avail: null };
    async function timetable() {
      const root = $('tx-timetable');
      root.innerHTML = skeleton(4);
      try {
        const A = AP.api.timetable;
        const from = new Date().toISOString().slice(0, 10), to = new Date(Date.now() + 13 * 86400000).toISOString().slice(0, 10);
        const [cal, av, list] = await Promise.all([A.myCalendar({ from, to }), A.myAvailability(), getClasses()]);
        TT.avail = av;
        const byDate = {};
        cal.items.forEach((x) => { (byDate[x.date] = byDate[x.date] || []).push(x); });
        const dates = Object.keys(byDate).sort();
        root.innerHTML =
          '<div class="card"><div class="card-pad"><div class="card-title">' + esc(t('tt.my_lessons')) + '</div>' +
          (dates.length ? dates.map((d) => '<div class="tui-kv" style="align-items:flex-start;flex-direction:column;gap:6px"><b>' + esc(fmtDate(d)) + '</b>' + byDate[d].map((x) =>
            '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><code>' + esc(x.start + '–' + x.end) + '</code><span>' + esc(x.subject.code + ' · ' + x.group) + '</span><span class="tui-muted">' + esc(x.room || '') + (x.building ? ' · ' + esc(x.building) : '') + '</span>' +
            (x.cancelled ? '<span class="badge badge-danger">' + esc(t('tt.cancelled')) + '</span>' : (x.attendance ? '<button class="btn btn-outline btn-sm" data-att="' + esc(x.attendance.subjectCode + '|' + x.attendance.groupName) + '">✔ ' + esc(t('tt.open_attendance')) + '</button>' : '')) + '</div>').join('') + '</div>').join('') : emptyBox(t('tt.no_lessons_day'))) +
          '</div></div>' +
          '<div class="card" style="margin-top:16px"><div class="card-pad"><div class="card-title">' + esc(t('tt.avail_title')) + '</div><div class="tui-muted" style="margin-bottom:10px">' + esc(t('tt.avail_hint')) + '</div><div id="tt-av"></div>' +
          '<div style="margin-top:12px"><button class="btn btn-purple" id="tt-av-save">' + esc(t('common.save')) + '</button></div></div></div>';
        root.querySelectorAll('[data-att]').forEach((b) => b.addEventListener('click', async () => { setSelected(b.dataset.att); await showPage('t-attendance'); }));
        drawAvail(av);
        $('tt-av-save').addEventListener('click', async () => {
          try { await A.setMyAvailability({ rules: availToRules() }); toast(t('ld.saved')); } catch (e) { toast(errMsg(e), true); }
        });
      } catch (e) {
        root.innerHTML = errorBox(errMsg(e), 'tt-retry');
        const r = $('tt-retry'); if (r) r.addEventListener('click', timetable);
      }
    }
    // сетка «день × слот»: пусто → недоступен → желателен
    let availCells = {};
    function drawAvail(av) {
      const days = [1, 2, 3, 4, 5, 6];
      availCells = {};
      av.rules.forEach((r) => {
        const ds = r.days.length ? r.days : days, ss = r.timeSlotIds.length ? r.timeSlotIds : av.timeSlots.map((s) => s.id);
        ds.forEach((d) => ss.forEach((sid) => { availCells[d + '|' + sid] = r.kind; }));
      });
      const box = $('tt-av');
      const paint = () => {
        box.innerHTML = '<div class="tui-table-wrap"><table><thead><tr><th></th>' + days.map((d) => '<th>' + esc(t(DOW[d]).slice(0, 3)) + '</th>').join('') + '</tr></thead><tbody>' +
          av.timeSlots.map((s) => '<tr><th style="white-space:nowrap">' + esc(s.label + ' ' + s.startTime + '–' + s.endTime) + '</th>' + days.map((d) => {
            const k = availCells[d + '|' + s.id];
            return '<td style="text-align:center"><button class="btn btn-sm ' + (k === 'UNAVAILABLE' ? 'btn-danger' : k === 'PREFERRED' ? 'btn-success' : 'btn-outline') + '" data-c="' + d + '|' + esc(s.id) + '" style="min-width:44px" aria-label="' + esc(t('tt.avail_' + (k || 'NONE'))) + '">' + (k === 'UNAVAILABLE' ? '✕' : k === 'PREFERRED' ? '★' : '·') + '</button></td>';
          }).join('') + '</tr>').join('') + '</tbody></table></div><div class="tui-muted" style="margin-top:6px">✕ ' + esc(t('tt.avail_UNAVAILABLE')) + ' · ★ ' + esc(t('tt.avail_PREFERRED')) + '</div>';
        box.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => {
          const k = availCells[b.dataset.c];
          if (!k) availCells[b.dataset.c] = 'UNAVAILABLE'; else if (k === 'UNAVAILABLE') availCells[b.dataset.c] = 'PREFERRED'; else delete availCells[b.dataset.c];
          paint();
        }));
      };
      paint();
    }
    function availToRules() {
      const rules = [];
      ['UNAVAILABLE', 'PREFERRED'].forEach((kind) => {
        const byDay = {};
        Object.entries(availCells).filter(([, v]) => v === kind).forEach(([key]) => { const [d, sid] = key.split('|'); (byDay[d] = byDay[d] || []).push(sid); });
        Object.entries(byDay).forEach(([d, sids]) => rules.push({ kind, days: [Number(d)], timeSlotIds: sids }));
      });
      return rules;
    }
    return { dashboard, classes, journal, attendance, assignments, materials, analytics, requests, timetable, invalidate() { classesCache = null; } };
  }

  AP.teacherUI = { create };
})(window);
