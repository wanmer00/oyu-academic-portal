// ============================================================
// SUPER_ADMIN / Admin Panel: справочники (студенты, преподаватели, группы, предметы, учебные планы),
// роли и разрешения, активные сессии, состояние системы, настройки demo, глобальный поиск, уведомления.
// Все данные — с бэкенда; права проверяет сервер. Существующие модули (журнал, расписание, безопасность) не дублируются.
// ============================================================
(function (global) {
  'use strict';
  const AP = (global.AP = global.AP || {});

  function create(ctx) {
    const { t, esc, openModal, confirmDialog } = AP.tui;
    const { toast, showPage } = ctx;
    const A = () => AP.api.admin;
    const $ = (id) => document.getElementById(id);
    const T = (k, fb) => t('sa.' + k, fb);
    const errMsg = (e) => (e && e.message) || t('common.error');
    const skel = (n) => Array.from({ length: n || 3 }, () => '<div class="skel" style="height:44px;margin:10px 0"></div>').join('');
    const empty = (m) => '<div class="empty">' + esc(m || T('none')) + '</div>';
    const errBox = (e, id) => '<div class="empty au-err">' + esc(errMsg(e)) + '<div style="margin-top:10px"><button class="btn btn-outline btn-sm" id="' + id + '">' + esc(t('notif.retry')) + '</button></div></div>';
    const fmtDT = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return iso || ''; } };
    const sel = (id, label, opts, cur) => '<label class="fld"><span>' + esc(label) + '</span><select class="input" id="' + id + '">' + opts.map(([v, l]) => '<option value="' + esc(v) + '"' + (String(cur) === String(v) ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></label>';
    const statusBadge = (s) => '<span class="badge ' + ({ ACTIVE: 'badge-success', SUSPENDED: 'badge-warning', ARCHIVED: 'badge-gray', DELETED: 'badge-danger' }[s] || 'badge-gray') + '">' + esc(t('ld.ustatus.' + s, s)) + '</span>';
    const state = { search: { students: '', teachers: '', subjects: '' } };

    // ── универсальная форма в модальном окне ──
    // fields: [{k, label, type: text|email|number|select|textarea, opts, req, step}]
    function openForm({ title, fields, values, save, wide }) {
      const v = values || {};
      const input = (f) => {
        const val = v[f.k] == null ? '' : v[f.k];
        if (f.type === 'select') return '<select class="input" id="ff-' + f.k + '">' + f.opts.map(([o, l]) => '<option value="' + esc(o) + '"' + (String(val) === String(o) ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>';
        if (f.type === 'textarea') return '<textarea class="input" id="ff-' + f.k + '" rows="3">' + esc(val) + '</textarea>';
        return '<input class="input" id="ff-' + f.k + '" type="' + (f.type || 'text') + '" value="' + esc(val) + '"' + (f.req ? ' required' : '') + (f.type === 'number' ? ' step="' + (f.step || 1) + '"' : '') + '>';
      };
      openModal({
        title, wide: !!wide, static: true,
        html: '<div class="form-grid">' + fields.map((f) => '<div class="form-group"><div class="form-label">' + esc(f.label) + '</div>' + input(f) + '</div>').join('') + '</div><div class="au-err" id="ff-err" role="alert"></div>',
        buttons: [{ label: t('common.cancel') }, { label: t('common.save'), cls: 'btn-primary', onClick: async (h) => {
          const out = {};
          for (const f of fields) {
            let x = h.$('#ff-' + f.k).value;
            if (f.type === 'number') x = x === '' ? undefined : Number(x);
            else if (typeof x === 'string') x = x.trim();
            if (x !== undefined && x !== '') out[f.k] = x;
            else if (f.nullable && x === '') out[f.k] = null;
          }
          try { await save(out); toast(t('ld.saved')); } catch (e) { h.$('#ff-err').textContent = errMsg(e); return false; }
        } }],
      });
    }
    const LEVELS = [['BACHELOR', t('ld.level.BACHELOR')], ['MASTER', t('ld.level.MASTER')], ['PHD', t('ld.level.PHD')]];

    // ═════════════════════════ СТУДЕНТЫ ═════════════════════════
    const SF = { group: '', status: '' };
    const cache = new Map();
    async function students(append) {
      const root = $('sa-students');
      if (!append) root.innerHTML = skel(5);
      try {
        const groups = await A().groups();
        if (!append) {
          root.innerHTML = '<div class="au-bar"><label class="fld grow"><span>' + esc(t('common.search')) + '</span><input class="input" id="st-q" value="' + esc(state.search.students) + '"></label>' +
            sel('st-g', T('group'), [['', t('common.all')]].concat(groups.map((g) => [g.groupName, g.groupName])), SF.group) +
            sel('st-s', t('common.status'), [['', t('common.all')], ['ACTIVE', t('ld.ustatus.ACTIVE')], ['ARCHIVED', t('ld.ustatus.ARCHIVED')]], SF.status) +
            '<div style="flex:1"></div><button class="btn btn-success" id="st-add">+ ' + esc(T('add_student')) + '</button></div><div id="st-box"></div>';
          let tm; $('st-q').addEventListener('input', (e) => { clearTimeout(tm); tm = setTimeout(() => { state.search.students = e.target.value.trim(); students(); }, 350); });
          $('st-g').addEventListener('change', (e) => { SF.group = e.target.value; students(); });
          $('st-s').addEventListener('change', (e) => { SF.status = e.target.value; students(); });
          $('st-add').addEventListener('click', () => studentForm(null, groups));
        }
        if (!append) cache.clear();
        const d = await A().students({ search: state.search.students, groupName: SF.group, status: SF.status, take: 50, cursor: append || undefined });
        d.items.forEach((s) => cache.set(s.id, s));
        const rows = d.items.map((s) => '<tr><td><code>' + esc(s.loginId) + '</code></td><td><b>' + esc(s.fullName) + '</b><div class="au-muted">' + esc(s.email) + '</div></td><td>' + esc(s.groupName) + '</td><td>' + esc(s.specialty) + '<div class="au-muted">' + esc(s.faculty) + '</div></td><td>' + s.course + ' / ' + s.semester + '</td><td>' + esc(t('ld.level.' + s.level, s.level)) + '</td><td>' + statusBadge(s.status) + '</td>' +
          '<td style="white-space:nowrap"><button class="btn btn-outline btn-sm" data-e="' + esc(s.id) + '">' + esc(t('common.edit')) + '</button> <button class="btn btn-outline btn-sm" data-a="' + esc(s.id) + '" data-on="' + (s.status === 'ARCHIVED' ? '0' : '1') + '">' + esc(s.status === 'ARCHIVED' ? T('unarchive') : T('archive')) + '</button></td></tr>').join('');
        const box = $('st-box');
        if (append) { box.querySelector('tbody').insertAdjacentHTML('beforeend', rows); box.querySelector('.more')?.remove(); }
        else box.innerHTML = '<div class="card" style="overflow:hidden">' + (d.items.length ? '<div class="au-table"><table><thead><tr><th>Login ID</th><th>' + esc(T('student')) + '</th><th>' + esc(T('group')) + '</th><th>' + esc(T('specialty')) + '</th><th>' + esc(T('course_sem')) + '</th><th>' + esc(T('level')) + '</th><th>' + esc(t('common.status')) + '</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' : empty()) + '</div><div class="au-muted" style="margin:8px 0">' + esc(T('total')) + ': ' + d.total + '</div>';
        if (d.nextCursor && d.items.length) box.insertAdjacentHTML('beforeend', '<div class="more" style="text-align:center;margin:10px"><button class="btn btn-outline" id="st-more">' + esc(t('ld.load_more')) + '</button></div>');
        if ($('st-more')) $('st-more').addEventListener('click', () => students(d.nextCursor));
        box.querySelectorAll('[data-e]').forEach((b) => b.onclick = () => studentForm(cache.get(b.dataset.e), groups));
        box.querySelectorAll('[data-a]').forEach((b) => b.onclick = async () => {
          if (b.dataset.on === '1' && !(await confirmDialog({ message: T('confirm_archive') }))) return;
          try { await A().archiveStudent(b.dataset.a, b.dataset.on === '1'); toast(t('ld.saved')); students(); } catch (e) { toast(errMsg(e), true); }
        });
      } catch (e) { root.innerHTML = errBox(e, 'st-r'); $('st-r').onclick = () => students(); }
    }
    function studentForm(s, groups) {
      const fields = [
        { k: 'fullName', label: T('full_name'), req: true }, { k: 'email', label: 'Email', type: 'email', req: true },
        { k: 'groupName', label: T('group'), req: true }, { k: 'faculty', label: T('faculty'), req: true }, { k: 'specialty', label: T('specialty'), req: true },
        { k: 'course', label: T('course'), type: 'number', req: true }, { k: 'semester', label: T('semester'), type: 'number', req: true }, { k: 'level', label: T('level'), type: 'select', opts: LEVELS },
      ];
      openForm({ title: s ? T('edit_student') : T('add_student'), fields, wide: true, values: s || { course: 1, semester: 1, level: 'BACHELOR', groupName: groups[0] ? groups[0].groupName : '' },
        save: async (v) => { if (s) await A().updateStudent(s.id, v); else await A().createStudent(v); students(); } });
    }

    // ═════════════════════════ ПРЕПОДАВАТЕЛИ ═════════════════════════
    async function teachers() {
      const root = $('sa-teachers');
      root.innerHTML = skel(5);
      try {
        const list = await A().teachers({ search: state.search.teachers });
        root.innerHTML = '<div class="au-bar"><label class="fld grow"><span>' + esc(t('common.search')) + '</span><input class="input" id="tc-q" value="' + esc(state.search.teachers) + '"></label><div style="flex:1"></div><button class="btn btn-success" id="tc-add">+ ' + esc(T('add_teacher')) + '</button></div>' +
          '<div class="card" style="overflow:hidden">' + (list.length ? '<div class="au-table"><table><thead><tr><th>Login ID</th><th>' + esc(T('teacher')) + '</th><th>' + esc(T('department')) + '</th><th>' + esc(T('load')) + '</th><th>' + esc(t('common.status')) + '</th><th></th></tr></thead><tbody>' +
            list.map((x) => '<tr><td><code>' + esc(x.loginId) + '</code></td><td><b>' + esc(x.fullName) + '</b><div class="au-muted">' + esc(x.title) + ' · ' + esc(x.experience) + ' ' + esc(T('years')) + '</div></td><td>' + esc(x.department) + '</td><td class="au-muted">' + esc(x.pairs.map((p) => p.subjectCode + ' · ' + p.groupName).join('; ') || '—') + '</td><td>' + statusBadge(x.status) + '</td><td><button class="btn btn-outline btn-sm" data-e="' + esc(x.userId) + '">' + esc(t('common.edit')) + '</button></td></tr>').join('') + '</tbody></table></div>' : empty()) + '</div>';
        let tm; $('tc-q').addEventListener('input', (e) => { clearTimeout(tm); tm = setTimeout(() => { state.search.teachers = e.target.value.trim(); teachers(); }, 350); });
        $('tc-add').addEventListener('click', () => teacherForm(null));
        root.querySelectorAll('[data-e]').forEach((b) => b.onclick = () => teacherForm(list.find((x) => x.userId === b.dataset.e)));
      } catch (e) { root.innerHTML = errBox(e, 'tc-r'); $('tc-r').onclick = teachers; }
    }
    function teacherForm(x) {
      openForm({ title: x ? T('edit_teacher') : T('add_teacher'), values: x || { experience: 0 }, wide: true,
        fields: [{ k: 'fullName', label: T('full_name'), req: true }, { k: 'email', label: 'Email', type: 'email', req: true }, { k: 'department', label: T('department'), req: true }, { k: 'title', label: T('position'), req: true }, { k: 'experience', label: T('years'), type: 'number', req: true }],
        save: async (v) => { if (x) await A().updateTeacher(x.userId, v); else await A().createTeacher(v); teachers(); } });
    }

    // ═════════════════════════ ГРУППЫ ═════════════════════════
    async function groups() {
      const root = $('sa-groups');
      root.innerHTML = skel(4);
      try {
        const list = await A().groups();
        root.innerHTML = '<div class="card" style="overflow:hidden">' + (list.length ? '<div class="au-table"><table><thead><tr><th>' + esc(T('group')) + '</th><th>' + esc(T('level')) + '</th><th>' + esc(T('students')) + '</th><th>' + esc(T('teachers')) + '</th><th>' + esc(T('subjects')) + '</th><th>' + esc(T('attendance_30d')) + '</th><th></th></tr></thead><tbody>' +
          list.map((g) => '<tr><td><b>' + esc(g.groupName) + '</b></td><td>' + esc(t('ld.level.' + g.level, g.level)) + '</td><td>' + g.studentsCount + '</td><td>' + g.teachers + '</td><td>' + g.subjects + '</td><td>' + (g.attendanceRate30d != null ? g.attendanceRate30d + '%' : '—') + '</td><td><button class="btn btn-outline btn-sm" data-g="' + esc(g.groupName) + '">' + esc(T('open')) + '</button></td></tr>').join('') + '</tbody></table></div>' : empty()) + '</div>';
        root.querySelectorAll('[data-g]').forEach((b) => b.onclick = () => groupDetail(b.dataset.g));
      } catch (e) { root.innerHTML = errBox(e, 'gr-r'); $('gr-r').onclick = groups; }
    }
    async function groupDetail(name) {
      try {
        const g = await A().group(name);
        const members = g.members || g.students || [];
        const slots = g.slots || g.schedule || [];
        openModal({
          title: name, wide: true,
          html: '<div class="au-bar"><button class="btn btn-outline btn-sm" id="gd-ren">' + esc(T('rename')) + '</button></div>' +
            '<div class="card-title">' + esc(T('students')) + ' (' + members.length + ')</div><div class="au-muted">' + esc(members.map((m) => m.fullName || (m.user && m.user.fullName)).filter(Boolean).join(', ') || '—') + '</div>' +
            '<div class="card-title" style="margin-top:14px">' + esc(T('schedule')) + ' (' + slots.length + ')</div><ul class="tt-ul">' + slots.slice(0, 30).map((s) => '<li>' + esc(((s.subject && (s.subject.code || s.subject)) || s.subjectCode || '') + ' · ' + t('schedule.' + ['', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'][s.dayOfWeek], s.dayOfWeek) + ' ' + s.startTime + '–' + s.endTime + ' · ' + (s.room || '')) + '</li>').join('') + '</ul>',
          buttons: [{ label: t('common.close') }],
        });
        $('gd-ren').addEventListener('click', () => { openForm({ title: T('rename'), values: { newName: name }, fields: [{ k: 'newName', label: T('group'), req: true }], save: async (v) => { await A().renameGroup(name, v.newName); groups(); } }); });
      } catch (e) { toast(errMsg(e), true); }
    }

    // ═════════════════════════ ПРЕДМЕТЫ и УЧЕБНЫЕ ПЛАНЫ ═════════════════════════
    async function subjects() {
      const root = $('sa-subjects');
      root.innerHTML = skel(5);
      try {
        const list = await A().subjects({ search: state.search.subjects });
        root.innerHTML = '<div class="au-bar"><label class="fld grow"><span>' + esc(t('common.search')) + '</span><input class="input" id="sj-q" value="' + esc(state.search.subjects) + '"></label><div style="flex:1"></div><button class="btn btn-success" id="sj-add">+ ' + esc(T('add_subject')) + '</button></div>' +
          '<div class="card" style="overflow:hidden">' + (list.length ? '<div class="au-table"><table><thead><tr><th>' + esc(T('code')) + '</th><th>' + esc(T('subject')) + '</th><th>' + esc(T('credits')) + '</th><th>' + esc(T('semester')) + '</th><th>' + esc(T('usage')) + '</th><th>' + esc(t('common.status')) + '</th><th></th></tr></thead><tbody>' +
            list.map((s) => '<tr><td><span class="tt-dot" style="background:' + esc(s.color || '#94a3b8') + '"></span><code>' + esc(s.code) + '</code></td><td>' + esc(s.name) + '</td><td>' + s.credits + '</td><td>' + s.semester + '</td><td class="au-muted">' + esc(T('u_slots') + ' ' + s.usage.slots + ' · ' + T('u_grades') + ' ' + s.usage.grades + ' · ' + T('u_att') + ' ' + s.usage.attendance) + '</td><td>' + (s.isActive ? '<span class="badge badge-success">' + esc(T('active')) + '</span>' : '<span class="badge badge-gray">' + esc(T('inactive')) + '</span>') + '</td><td style="white-space:nowrap"><button class="btn btn-outline btn-sm" data-e="' + esc(s.id) + '">' + esc(t('common.edit')) + '</button> <button class="btn btn-danger btn-sm" data-d="' + esc(s.id) + '">✕</button></td></tr>').join('') + '</tbody></table></div>' : empty()) + '</div>';
        let tm; $('sj-q').addEventListener('input', (e) => { clearTimeout(tm); tm = setTimeout(() => { state.search.subjects = e.target.value.trim(); subjects(); }, 350); });
        $('sj-add').addEventListener('click', () => subjectForm(null));
        root.querySelectorAll('[data-e]').forEach((b) => b.onclick = () => subjectForm(list.find((x) => x.id === b.dataset.e)));
        root.querySelectorAll('[data-d]').forEach((b) => b.onclick = async () => {
          if (!(await confirmDialog({ danger: true, confirmLabel: t('common.delete'), message: T('confirm_delete_subject') }))) return;
          try { await A().deleteSubject(b.dataset.d); toast(t('ld.deleted')); subjects(); } catch (e) { toast(errMsg(e), true); }
        });
      } catch (e) { root.innerHTML = errBox(e, 'sj-r'); $('sj-r').onclick = subjects; }
    }
    function subjectForm(s) {
      const fields = [{ k: 'code', label: T('code'), req: true }, { k: 'name', label: T('subject'), req: true }, { k: 'credits', label: T('credits'), type: 'number', req: true }, { k: 'semester', label: T('semester'), type: 'number', req: true }, { k: 'color', label: T('color'), type: 'text' }, { k: 'description', label: T('description'), type: 'textarea', nullable: true }];
      if (s) { fields.shift(); fields.push({ k: 'isActive', label: t('common.status'), type: 'select', opts: [['true', T('active')], ['false', T('inactive')]] }); }
      openForm({ title: s ? T('edit_subject') : T('add_subject'), fields, wide: true, values: s ? Object.assign({}, s, { isActive: String(s.isActive) }) : { credits: 5, semester: 1, color: '#3b82f6' },
        save: async (v) => { if (s) { if ('isActive' in v) v.isActive = v.isActive === 'true'; await A().updateSubject(s.id, v); } else await A().createSubject(v); subjects(); } });
    }
    // ═════════════════════════ ОРГСТРУКТУРА: факультеты → кафедры → специальности → группы ═════════════════════════
    const posLabel = (p) => (p ? t('pos.' + p, p) : '');
    let orgCache = null;
    async function loadOrg(force) { if (!orgCache || force) orgCache = await AP.api.request('/admin/org'); return orgCache; }
    async function org() {
      const root = $('sa-org');
      root.innerHTML = skel(4);
      try {
        const o = await loadOrg(true);
        const person = (p) => p ? '<span class="org-person">' + esc(posLabel(p.position)) + ': <b>' + esc(p.fullName) + '</b> <code>' + esc(p.loginId) + '</code></span>' : '';
        const totals = { f: o.faculties.length, d: 0, s: 0, g: 0, st: 0 };
        o.faculties.forEach((f) => f.departments.forEach((d) => { totals.d++; d.specialties.forEach((s) => { totals.s++; s.groups.forEach((g) => { totals.g++; totals.st += g.students; }); }); }));
        root.innerHTML =
          (o.scope && o.scope.kind !== 'ALL' ? '<div class="au-note">🔎 ' + esc(T('org_scope')) + ': <b>' + esc(posLabel(o.scope.position)) + '</b> — ' + esc(o.scope.label || '') + '</div>' : '') +
          '<div class="stat-grid">' + [['🏛', totals.f, T('org_faculties')], ['📚', totals.d, T('org_departments')], ['🎓', totals.s, T('org_specialties')], ['👥', totals.g, T('org_groups')], ['🧑‍🎓', totals.st, T('students')]]
            .map(([i, v, l]) => '<div class="stat-card"><div class="stat-icon">' + i + '</div><div class="stat-val">' + v + '</div><div class="stat-label">' + esc(l) + '</div></div>').join('') + '</div>' +
          (o.leaders.length ? '<div class="card" style="margin-bottom:14px"><div class="card-pad"><div class="card-title">' + esc(T('org_leadership')) + '</div>' + o.leaders.map(person).join(' · ') + '</div></div>' : '') +
          o.faculties.map((f) => '<details class="card org-fac" open><summary class="card-pad"><b>🏛 ' + esc(f.name) + '</b> ' + person(f.dean) + '</summary><div class="card-pad" style="padding-top:0">' +
            f.departments.map((d) => '<div class="org-dep"><div class="org-dep-h">📚 ' + esc(d.name) + ' ' + person(d.head) + '</div>' +
              '<div class="au-table"><table><thead><tr><th>' + esc(T('code')) + '</th><th>' + esc(T('specialty')) + '</th><th>' + esc(T('org_groups')) + '</th><th>' + esc(T('org_plan')) + '</th></tr></thead><tbody>' +
              d.specialties.map((s) => '<tr><td><code>' + esc(s.code) + '</code></td><td>' + esc(s.name) + '<div class="au-muted">' + esc(t('ld.level.' + s.level, s.level)) + ' · ' + s.durationYears + ' ' + esc(T('years_short')) + ' · ' + s.totalCredits + ' ' + esc(T('credits')) + '</div></td>' +
                '<td>' + (s.groups.length ? s.groups.map((g) => '<span class="org-grp' + (g.inScope ? '' : ' off') + '" title="' + esc(g.tutor ? T('org_tutor') + ': ' + g.tutor.fullName : '') + '">' + esc(g.name) + ' · ' + g.course + ' ' + esc(T('course_short')) + ' · ' + g.students + (g.tutor ? ' · 🧑‍🏫' : '') + '</span>').join(' ') : '<span class="au-muted">—</span>') + '</td>' +
                '<td>' + (s.curriculumItems ? '<button class="btn btn-outline btn-sm" data-plan="' + esc(s.id) + '">' + esc(T('open')) + '</button>' : '<span class="au-muted">' + esc(T('org_no_plan')) + '</span>') + '</td></tr>').join('') +
              '</tbody></table></div></div>').join('') + '</div></details>').join('');
        root.querySelectorAll('[data-plan]').forEach((b) => b.onclick = () => planModal(b.dataset.plan));
      } catch (e) { root.innerHTML = errBox(e, 'org-r'); $('org-r').onclick = org; }
    }
    function planHtml(cu) {
      const sp = cu.specialty;
      return '<div class="au-note">' + esc(sp.faculty) + ' · ' + esc(sp.department) + ' · <code>' + esc(sp.code) + '</code> · ' + esc(t('ld.level.' + sp.level, sp.level)) + ' · ' + sp.durationYears + ' ' + esc(T('years_short')) + ' · <b>' + cu.plannedCredits + ' / ' + sp.totalCredits + '</b> ' + esc(T('credits')) + '</div>' +
        '<div class="org-plan">' + cu.semesters.map((s) => '<div class="card"><div class="card-pad"><div class="card-title">' + esc(T('semester')) + ' ' + s.semester + ' <span class="au-muted">(' + esc(T('course')) + ' ' + Math.ceil(s.semester / 2) + ') · ' + s.credits + ' ' + esc(T('credits')) + '</span></div>' +
          s.items.map((i) => '<div class="cfg-row"><span><span class="tt-dot" style="background:' + esc(i.subject.color || '#94a3b8') + '"></span><code>' + esc(i.subject.code) + '</code> ' + esc(i.subject.name) + (i.kind === 'ELECTIVE' ? ' <span class="badge badge-info">' + esc(T('elective')) + '</span>' : '') + '</span><span class="cfg-val">' + i.credits + ' · ' + esc(T('ctl_' + i.control, i.control)) + '</span></div>').join('') + '</div></div>').join('') + '</div>' +
        '<div class="au-muted" style="margin-top:8px">' + esc(T('plan_note')) + '</div>';
    }
    async function planModal(id) {
      try { const cu = await AP.api.request('/admin/org/specialties/' + id + '/curriculum'); openModal({ title: cu.specialty.code + ' · ' + cu.specialty.name, wide: true, html: planHtml(cu), buttons: [{ label: t('common.close') }] }); }
      catch (e) { toast(errMsg(e), true); }
    }
    // Учебные планы: выбор специальности → план по 8 семестрам (240 кредитов)
    const CU = { spec: '' };
    async function curricula() {
      const root = $('sa-curricula');
      root.innerHTML = skel(4);
      try {
        const o = await loadOrg();
        const specs = o.faculties.flatMap((f) => f.departments.flatMap((d) => d.specialties.filter((s) => s.curriculumItems).map((s) => [s.id, s.code + ' · ' + s.name])));
        if (!specs.length) { root.innerHTML = empty(T('org_no_plan')); return; }
        if (!CU.spec || !specs.some((s) => s[0] === CU.spec)) CU.spec = specs[0][0];
        root.innerHTML = '<div class="au-bar">' + sel('cu-spec', T('specialty'), specs, CU.spec) + '</div><div id="cu-box">' + skel(3) + '</div>';
        $('cu-spec').addEventListener('change', (e) => { CU.spec = e.target.value; curricula(); });
        $('cu-box').innerHTML = planHtml(await AP.api.request('/admin/org/specialties/' + CU.spec + '/curriculum'));
      } catch (e) { root.innerHTML = errBox(e, 'cu-r'); $('cu-r').onclick = curricula; }
    }
    // ═════════════════════════ ЗАДОЛЖЕННОСТИ ═════════════════════════
    async function debts() {
      const root = $('sa-debts');
      root.innerHTML = skel(4);
      try {
        const d = await AP.api.request('/admin/debts');
        root.innerHTML = '<div class="au-note">' + esc(T('debts_hint')) + '</div><div class="au-muted" style="margin:6px 0">' + esc(T('total')) + ': ' + d.total + '</div>' +
          '<div class="card" style="overflow:hidden">' + (d.items.length ? '<div class="au-table"><table><thead><tr><th>' + esc(T('student')) + '</th><th>' + esc(T('group')) + '</th><th>' + esc(T('specialty')) + '</th><th>' + esc(T('credits')) + '</th><th>' + esc(T('debts_list')) + '</th></tr></thead><tbody>' +
            d.items.map((x) => '<tr><td><b>' + esc(x.student.fullName) + '</b><div class="au-muted">' + esc(x.student.loginId) + '</div></td><td>' + esc(x.student.groupName) + '</td><td>' + esc(x.specialty || '—') + '</td><td>' + x.earned + ' / ' + x.required + '</td>' +
              '<td class="au-muted">' + esc(x.debts.map((b) => b.subject.code + ' ' + b.subject.name + ' (' + b.semester + ')').join('; ')) + '</td></tr>').join('') + '</tbody></table></div>' : empty(T('no_debts'))) + '</div>';
      } catch (e) { root.innerHTML = errBox(e, 'db-r'); $('db-r').onclick = debts; }
    }

    // ═════════════════════════ ПРАКТИКА И ВЫПУСКНЫЕ РАБОТЫ ═════════════════════════
    const PF = { type: '', status: '' };
    const ST = ['PLANNED', 'IN_PROGRESS', 'SUBMITTED', 'DEFENDED', 'COMPLETED'];
    async function projects() {
      const root = $('sa-projects');
      root.innerHTML = skel(4);
      try {
        const list = await AP.api.request('/admin/projects' + (PF.type || PF.status ? '?' + new URLSearchParams(Object.fromEntries(Object.entries(PF).filter(([, v]) => v))) : ''));
        root.innerHTML = '<div class="au-bar">' + sel('pj-t', T('type'), [['', t('common.all')], ['PRACTICE', t('sp.type_PRACTICE')], ['THESIS', t('sp.type_THESIS')]], PF.type) + sel('pj-s', t('common.status'), [['', t('common.all')]].concat(ST.map((s) => [s, t('sp.st_' + s)])), PF.status) + '</div>' +
          '<div class="card" style="overflow:hidden">' + (list.length ? '<div class="au-table"><table><thead><tr><th>' + esc(T('student')) + '</th><th>' + esc(T('group')) + '</th><th>' + esc(T('type')) + '</th><th>' + esc(T('title')) + '</th><th>' + esc(T('supervisor')) + '</th><th>' + esc(t('common.status')) + '</th><th></th></tr></thead><tbody>' +
            list.map((x) => '<tr><td><b>' + esc(x.student.fullName) + '</b></td><td>' + esc(x.student.groupName) + '</td><td>' + esc(t('sp.type_' + x.type)) + '</td><td>' + esc(x.title) + (x.organization ? '<div class="au-muted">' + esc(x.organization) + '</div>' : '') + '</td><td>' + esc(x.supervisor || '—') + '</td>' +
              '<td><span class="badge ' + (x.status === 'COMPLETED' ? 'badge-success' : x.status === 'PLANNED' ? 'badge-gray' : 'badge-info') + '">' + esc(t('sp.st_' + x.status)) + '</span>' + (x.grade != null ? ' <b>' + x.grade + '</b>' : '') + '</td>' +
              '<td><button class="btn btn-outline btn-sm" data-e="' + esc(x.id) + '">' + esc(t('common.edit')) + '</button></td></tr>').join('') + '</tbody></table></div>' : empty()) + '</div>';
        $('pj-t').addEventListener('change', (e) => { PF.type = e.target.value; projects(); });
        $('pj-s').addEventListener('change', (e) => { PF.status = e.target.value; projects(); });
        root.querySelectorAll('[data-e]').forEach((b) => b.onclick = () => {
          const x = list.find((y) => y.id === b.dataset.e);
          openForm({ title: x.student.fullName + ' · ' + t('sp.type_' + x.type), values: { status: x.status, grade: x.grade, note: x.note }, fields: [{ k: 'status', label: t('common.status'), type: 'select', opts: ST.map((s) => [s, t('sp.st_' + s)]) }, { k: 'grade', label: T('grade'), type: 'number', nullable: true }, { k: 'note', label: T('note'), type: 'textarea', nullable: true }],
            save: async (v) => { await AP.api.request('/admin/projects/' + x.id, { method: 'PATCH', body: v }); projects(); } });
        });
      } catch (e) { root.innerHTML = errBox(e, 'pj-r'); $('pj-r').onclick = projects; }
    }
    // ═════════════════════════ РОЛИ И РАЗРЕШЕНИЯ ═════════════════════════
    async function roles() {
      const root = $('sa-roles');
      root.innerHTML = skel(5);
      try {
        const d = await A().roles();
        const editable = d.roles.filter((r) => !r.locked);
        const groupsOf = {};
        d.catalog.forEach((p) => { (groupsOf[p.group] = groupsOf[p.group] || []).push(p); });
        const head = d.roles.map((r) => '<th>' + esc(t('ld.role.' + r.role, r.role)) + '<div class="au-muted">' + r.users + '</div></th>').join('');
        root.innerHTML = '<div class="au-note">🔒 ' + esc(T('roles_hint')) + '</div><div class="card" style="overflow:auto"><table class="sa-matrix"><thead><tr><th>' + esc(T('permission')) + '</th>' + head + '</tr></thead><tbody>' +
          Object.keys(groupsOf).map((g) => '<tr class="grp"><td colspan="' + (d.roles.length + 1) + '"><b>' + esc(g) + '</b></td></tr>' + groupsOf[g].map((p) => '<tr><td><code>' + esc(p.key) + '</code></td>' + d.roles.map((r) => {
            const cur = r.permissions[p.key] || '';
            if (r.locked) return '<td><span class="badge badge-success">ALL</span></td>';
            return '<td><select class="input sa-scope" data-role="' + r.role + '" data-perm="' + esc(p.key) + '"><option value="">—</option>' + p.scopes.map((s) => '<option value="' + s + '"' + (cur === s ? ' selected' : '') + '>' + s + '</option>').join('') + '</select></td>';
          }).join('') + '</tr>').join('')).join('') + '</tbody></table></div>';
        void editable;
        root.querySelectorAll('.sa-scope').forEach((s) => s.addEventListener('change', async () => {
          try { await A().setPermission(s.dataset.role, s.dataset.perm, s.value || null); toast(t('ld.saved')); } catch (e) { toast(errMsg(e), true); roles(); }
        }));
      } catch (e) { root.innerHTML = errBox(e, 'rl-r'); $('rl-r').onclick = roles; }
    }

    // ═════════════════════════ СЕССИИ ═════════════════════════
    async function sessions() {
      const root = $('sa-sessions');
      root.innerHTML = skel(4);
      try {
        const d = await A().sessions();
        root.innerHTML = '<div class="card" style="overflow:hidden">' + (d.items.length ? '<div class="au-table"><table><thead><tr><th>' + esc(T('user')) + '</th><th>IP</th><th>' + esc(T('device')) + '</th><th>' + esc(T('started')) + '</th><th>' + esc(T('expires')) + '</th><th></th></tr></thead><tbody>' +
          d.items.map((s) => '<tr><td><b>' + esc(s.user.fullName) + '</b><div class="au-muted">' + esc(s.user.loginId) + ' · ' + esc(t('ld.role.' + s.user.role, s.user.role)) + '</div></td><td>' + esc(s.ip || '—') + '</td><td class="au-muted" style="max-width:260px;overflow:hidden;text-overflow:ellipsis">' + esc(s.userAgent || '—') + '</td><td>' + esc(fmtDT(s.createdAt)) + '</td><td>' + esc(fmtDT(s.expiresAt)) + '</td><td><button class="btn btn-danger btn-sm" data-r="' + esc(s.id) + '">' + esc(T('revoke')) + '</button></td></tr>').join('') + '</tbody></table></div>' : empty()) + '</div>';
        root.querySelectorAll('[data-r]').forEach((b) => b.onclick = async () => {
          if (!(await confirmDialog({ danger: true, confirmLabel: T('revoke'), message: T('confirm_revoke') }))) return;
          try { await A().revokeSession(b.dataset.r); toast(t('ld.saved')); sessions(); } catch (e) { toast(errMsg(e), true); }
        });
      } catch (e) { root.innerHTML = errBox(e, 'ss-r'); $('ss-r').onclick = sessions; }
    }

    // ═════════════════════════ СОСТОЯНИЕ СИСТЕМЫ ═════════════════════════
    async function health() {
      const root = $('sa-health');
      root.innerHTML = skel(4);
      try {
        const h = await A().health();
        const up = (s) => { const d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return (d ? d + 'd ' : '') + hr + 'h ' + m + 'm'; };
        const card = (icon, val, label, sub, ok) => '<div class="stat-card"><div class="stat-icon">' + icon + '</div><div class="stat-val" style="' + (ok === false ? 'color:#dc2626' : '') + '">' + esc(val) + '</div><div class="stat-label">' + esc(label) + '</div>' + (sub ? '<div class="au-muted" style="margin-top:4px">' + esc(sub) + '</div>' : '') + '</div>';
        const jobs = h.backgroundJobs.byStatus;
        root.innerHTML = '<div class="stat-grid">' +
          card('🟢', h.api.ok ? 'OK' : 'ERR', 'API', up(h.api.uptimeSec) + ' · ' + h.api.node, h.api.ok) +
          card('🗄', h.database.ok ? h.database.latencyMs + ' ms' : 'ERR', T('database'), h.database.ok ? 'PostgreSQL' : '', h.database.ok) +
          card('🧠', h.memory.rssMb + ' MB', T('memory'), 'heap ' + h.memory.heapUsedMb + ' MB') +
          card('🔐', h.activity.activeSessions, T('active_sessions'), '') +
          card('📝', h.activity.auditEvents24h, T('audit24'), '') +
          card('⚠️', h.activity.failedLogins24h, T('failed24'), '', h.activity.failedLogins24h < 20) +
          card('⚙️', (jobs.RUNNING || 0) + (jobs.QUEUED || 0), T('jobs_active'), T('jobs_done') + ': ' + (jobs.DONE || 0) + ' · ' + T('jobs_failed') + ': ' + (jobs.FAILED || 0), !(jobs.FAILED > 0)) +
          card('🤖', h.ai.mode, 'AI', '') + '</div>' +
          '<div class="card"><div class="card-pad"><div class="card-title">' + esc(T('records')) + '</div>' + Object.entries(h.counts).map(([k, v]) => '<div class="cfg-row"><span class="cfg-key">' + esc(T('c_' + k, k)) + '</span><span class="cfg-val">' + v + '</span></div>').join('') + '</div></div>' +
          (h.backgroundJobs.lastFailed ? '<div class="au-note" style="border-color:#ef4444">' + esc(T('last_failed_job')) + ': ' + esc(fmtDT(h.backgroundJobs.lastFailed.createdAt)) + ' — ' + esc(h.backgroundJobs.lastFailed.error || '') + '</div>' : '') +
          '<div class="au-muted">' + esc(T('health_note')) + '</div>';
      } catch (e) { root.innerHTML = errBox(e, 'hl-r'); $('hl-r').onclick = health; }
    }

    // ═════════════════════════ НАСТРОЙКИ DEMO ═════════════════════════
    async function demo() {
      const root = $('sa-demo');
      root.innerHTML = skel(3);
      let status = { demo: false };
      try { status = await fetch(AP.api.baseUrl + '/api/v1/demo/status').then((r) => r.json()); } catch { /* ignore */ }
      root.innerHTML = '<div class="card"><div class="card-pad"><div class="card-title">Odlar Yurdu University — Academic Management Portal</div>' +
        '<div class="cfg-row"><span class="cfg-key">DEMO_MODE</span><span class="cfg-val">' + (status.demo ? '<span class="badge badge-success">ON</span>' : '<span class="badge badge-gray">OFF</span>') + '</span></div>' +
        '<div class="au-note" style="margin-top:12px">' + esc(T('demo_reset_note')) + '</div>' +
        '<pre class="sa-pre">docker compose exec portal-api node dist/demo/reset.cli.js</pre>' +
        '<div style="margin-top:12px"><button class="btn btn-outline" id="dm-viewas">👁 ' + esc(t('va.btn')) + '</button></div></div></div>';
      $('dm-viewas').addEventListener('click', () => AP.viewAs.openPicker());
    }

    // ═════════════════════════ ГЛОБАЛЬНЫЙ ПОИСК ═════════════════════════
    const TARGET = { student: 'students', teacher: 'teachers', group: 'groups', subject: 'subjects', room: 'rooms', request: 'requests', announcement: 'announcements' };
    function mountSearch(input, box) {
      input.placeholder = '🔍 ' + T('search_ph');
      let tm, seq = 0;
      const close = () => { box.style.display = 'none'; };
      input.addEventListener('input', () => {
        clearTimeout(tm);
        const q = input.value.trim();
        if (q.length < 2) { close(); return; }
        tm = setTimeout(async () => {
          const my = ++seq;
          try {
            const d = await A().search(q);
            if (my !== seq) return;
            box.innerHTML = d.results.length ? d.results.map((r, i) => '<button type="button" class="sa-hit" data-i="' + i + '"><span class="sa-hit-t">' + esc(T('type_' + r.type, r.type)) + '</span><b>' + esc(r.title) + '</b><span class="au-muted">' + esc(r.sub) + '</span></button>').join('') : '<div class="au-muted" style="padding:10px">' + esc(T('none')) + '</div>';
            box.style.display = 'block';
            box.querySelectorAll('.sa-hit').forEach((b) => b.addEventListener('click', () => {
              const r = d.results[Number(b.dataset.i)];
              if (['students', 'teachers', 'subjects'].includes(TARGET[r.type])) state.search[TARGET[r.type]] = r.title.split(' · ')[0];
              close(); input.value = ''; showPage(TARGET[r.type]);
            }));
          } catch { close(); }
        }, 300);
      });
      document.addEventListener('click', (e) => { if (!box.contains(e.target) && e.target !== input) close(); });
    }

    // ═════════════════════════ УВЕДОМЛЕНИЯ ═════════════════════════
    function mountBell(btn, badge, panel) {
      const N = () => AP.api.notifications;
      const refresh = async () => { try { const c = await N().unreadCount(); const n = (c && (c.count != null ? c.count : c.unread)) || 0; badge.textContent = n > 99 ? '99+' : String(n); badge.style.display = n ? '' : 'none'; } catch { /* ignore */ } };
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
        panel.style.display = 'block'; panel.innerHTML = skel(2);
        try {
          const d = await N().list({ take: 10 });
          const items = d.items || d;
          panel.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px"><b>' + esc(T('notifications')) + '</b><button class="btn btn-outline btn-sm" id="nt-all">' + esc(T('mark_all')) + '</button></div>' +
            (items.length ? items.map((n) => '<div class="sa-nt' + (n.readAt ? '' : ' unread') + '"><b>' + esc(n.title) + '</b><div class="au-muted">' + esc(n.message) + '</div><div class="au-muted">' + esc(fmtDT(n.createdAt)) + '</div></div>').join('') : '<div class="au-muted" style="padding:10px">' + esc(T('none')) + '</div>');
          const all = $('nt-all'); if (all) all.addEventListener('click', async () => { try { await N().markAllRead(); refresh(); btn.click(); } catch (er) { toast(errMsg(er), true); } });
        } catch (er) { panel.innerHTML = '<div class="au-err" style="padding:10px">' + esc(errMsg(er)) + '</div>'; }
      });
      document.addEventListener('click', (e) => { if (!panel.contains(e.target) && e.target !== btn) panel.style.display = 'none'; });
      refresh(); setInterval(refresh, 60000);
    }


    // ═════════════════════════ ДОПОЛНЕНИЯ ДАШБОРДА SUPER_ADMIN: состояние системы и последние события ═════════════════════════
    async function dashboardExtras() {
      const root = $('lx-dashboard');
      if (!root) return;
      let box = $('sa-dash-extra');
      if (!box) { box = document.createElement('div'); box.id = 'sa-dash-extra'; box.style.marginTop = '16px'; root.appendChild(box); }
      box.innerHTML = skel(2);
      try {
        const [h, ev] = await Promise.all([A().health(), AP.api.request('/admin/audit/audit-logs?take=8')]);
        const items = ev.items || ev.logs || ev;
        box.innerHTML = '<div class="grid-2" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px">' +
          '<div class="card"><div class="card-pad"><div class="card-title">' + esc(T('system_state')) + '</div>' +
            '<div class="cfg-row"><span class="cfg-key">API</span><span class="cfg-val"><span class="status-dot"></span>' + (h.api.ok ? 'OK' : 'ERR') + '</span></div>' +
            '<div class="cfg-row"><span class="cfg-key">' + esc(T('database')) + '</span><span class="cfg-val">' + (h.database.ok ? h.database.latencyMs + ' ms' : 'ERR') + '</span></div>' +
            '<div class="cfg-row"><span class="cfg-key">' + esc(T('c_subjects')) + '</span><span class="cfg-val">' + h.counts.subjects + '</span></div>' +
            '<div class="cfg-row"><span class="cfg-key">' + esc(T('c_rooms')) + '</span><span class="cfg-val">' + h.counts.rooms + '</span></div>' +
            '<div class="cfg-row"><span class="cfg-key">' + esc(T('active_sessions')) + '</span><span class="cfg-val">' + h.activity.activeSessions + '</span></div>' +
            '<div class="cfg-row"><span class="cfg-key">' + esc(T('failed24')) + '</span><span class="cfg-val">' + h.activity.failedLogins24h + '</span></div></div></div>' +
          '<div class="card"><div class="card-pad"><div class="card-title">' + esc(T('recent_events')) + '</div>' +
            (items.length ? items.map((e) => '<div class="cfg-row"><span class="cfg-key">' + esc(e.action) + '</span><span class="cfg-val">' + esc((e.actor && (e.actor.fullName || e.actor.loginId)) || e.actorName || '—') + ' · ' + esc(fmtDT(e.createdAt)) + '</span></div>').join('') : empty()) +
          '</div></div></div>';
      } catch (e) { box.innerHTML = '<div class="au-err">' + esc(errMsg(e)) + '</div>'; }
    }
    return { debts, projects, org, posLabel, dashboardExtras, students, teachers, groups, subjects, curricula, roles, sessions, health, demo, mountSearch, mountBell };
  }

  AP.superAdminUI = { create };
})(window);
