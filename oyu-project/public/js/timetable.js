// ============================================================
// Timetable workspace (Admin Panel → Расписание).
// Все данные — с бэкенда (/timetable/*); права проверяет сервер.
// Вкладки: Расписание · Конфликты · Нагрузка · Версии · Настройки.
// Настройки/нагрузка/аудитории — в timetable-settings.js.
// ============================================================
(function (global) {
  'use strict';
  const AP = (global.AP = global.AP || {});

  function create(ctx) {
    const { t, esc, openModal, confirmDialog, saveBlob } = AP.tui;
    const { toast } = ctx;
    const api = () => AP.api.timetable;
    const $ = (id) => document.getElementById(id);
    const errMsg = (e) => (e && e.message) || t('common.error');
    const skel = (n, h) => Array.from({ length: n || 3 }, () => '<div class="skel" style="height:' + (h || 44) + 'px;margin:10px 0"></div>').join('');
    const empty = (m) => '<div class="empty">' + esc(m || t('ld.no_data')) + '</div>';
    const errBox = (e, id) => '<div class="empty au-err">' + esc(errMsg(e)) + (id ? '<div style="margin-top:10px"><button class="btn btn-outline btn-sm" id="' + id + '">' + esc(t('notif.retry')) + '</button></div>' : '') + '</div>';
    const retry = (id, fn) => { const b = $(id); if (b) b.addEventListener('click', fn); };
    const DAYKEYS = ['', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const dayName = (d) => t('schedule.' + DAYKEYS[d]);
    const dayShort = (d) => dayName(d).slice(0, 3);
    const sel = (id, label, opts, cur, cls) => '<label class="fld' + (cls ? ' ' + cls : '') + '"><span>' + esc(label) + '</span><select class="input" id="' + id + '">' + opts.map(([v, l]) => '<option value="' + esc(v) + '"' + (String(cur) === String(v) ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></label>';
    const fsel = (id, label, opts, cur) => '<div class="form-group"><div class="form-label">' + esc(label) + '</div><select class="input" id="' + id + '">' + opts.map(([v, l]) => '<option value="' + esc(v) + '"' + (String(cur) === String(v) ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></div>';
    const STATUS_CLS = { DRAFT: 'badge-warning', REVIEW: 'badge-info', PUBLISHED: 'badge-success', ARCHIVED: 'badge-gray' };
    const statusBadge = (s) => '<span class="badge ' + (STATUS_CLS[s] || 'badge-gray') + '">' + esc(t('tt.status.' + s, s)) + '</span>';
    const verLabel = (v) => 'v' + v.number + (v.name ? ' · ' + v.name : '');
    const fmtDT = (iso) => { try { return new Date(iso).toLocaleString(AP.i18n.getLang() === 'ru' ? 'ru-RU' : AP.i18n.getLang() === 'en' ? 'en-GB' : 'az-AZ'); } catch { return iso || ''; } };
    const today = () => new Date().toISOString().slice(0, 10);
    const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const mondayOf = (iso) => { const d = new Date(iso + 'T00:00:00Z'); return addDays(iso, 1 - (d.getUTCDay() || 7)); };
    let PERMS = null;
    const canDo = (perm) => !PERMS || !!PERMS[perm];

    const S = {
      year: null, term: null, versions: [], vid: null, ver: null, refs: null, tab: 'schedule',
      view: 'list', by: 'group', value: '', date: today(), page: 1, pageSize: 50,
      f: { search: '', faculty: '', level: '', group: '', teacherId: '', roomId: '', building: '', day: '', type: '' },
    };
    const editable = () => S.ver && (S.ver.status === 'DRAFT' || S.ver.status === 'REVIEW');
    const periodQ = () => ({ academicYear: S.year, term: S.term });

    const shared = { S, api, t, esc, $, errMsg, skel, empty, errBox, retry, sel, fsel, dayName, dayShort, statusBadge, verLabel, fmtDT, toast, openModal, confirmDialog, saveBlob, editable, periodQ, reload: () => load(), loadVersions: () => loadVersions(), canDo };
    const settings = () => AP.timetableSettings.create(shared);

    // ═════════════════════════ ENTRY ═════════════════════════
    async function schedule() {
      const root = $('lx-schedule');
      root.innerHTML = skel(5);
      try {
        if (!PERMS) { try { const me = await AP.api.me(); PERMS = me.permissions || null; } catch { /* сервер всё равно проверит права */ } }
        if (!S.year) {
          const all = await api().versions({});
          const pub = all.find((v) => v.status === 'PUBLISHED') || all[0];
          const now = new Date(), y = now.getUTCMonth() >= 8 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
          S.year = pub ? pub.academicYear : y + '-' + (y + 1);
          S.term = pub ? pub.term : (now.getUTCMonth() >= 8 || now.getUTCMonth() === 0 ? 'FALL' : 'SPRING');
        }
        await loadVersions();
        S.refs = await api().refs(periodQ());
        shell();
        await renderTab();
      } catch (e) { root.innerHTML = errBox(e, 'tt-r'); retry('tt-r', schedule); }
    }

    async function loadVersions(keepId) {
      S.versions = await api().versions(periodQ());
      const pick = S.versions.find((v) => v.id === (keepId || S.vid)) || S.versions.find((v) => v.status === 'PUBLISHED') || S.versions[0] || null;
      S.vid = pick ? pick.id : null; S.ver = pick;
    }

    function shell() {
      const root = $('lx-schedule');
      const tabs = ['schedule', 'conflicts', 'requirements', 'versions', 'settings'];
      root.innerHTML =
        '<div class="au-bar tt-head">' +
          '<label class="fld"><span>' + esc(t('tt.year')) + '</span><input class="input" id="tt-year" value="' + esc(S.year) + '" maxlength="9"></label>' +
          sel('tt-term', t('tt.term_l'), ['FALL', 'SPRING', 'SUMMER'].map((x) => [x, t('tt.term.' + x)]), S.term) +
          '<label class="fld grow"><span>' + esc(t('tt.version')) + '</span><select class="input" id="tt-ver">' + (S.versions.length ? S.versions.map((v) => '<option value="' + esc(v.id) + '"' + (v.id === S.vid ? ' selected' : '') + '>' + esc(verLabel(v) + ' — ' + t('tt.status.' + v.status) + ' (' + v.lessons + ')') + '</option>').join('') : '<option value="">—</option>') + '</select></label>' +
          '<div style="flex:1"></div>' +
          (canDo('schedule.generate') ? '<button class="btn btn-success" id="tt-gen">⚙ ' + esc(t('tt.create')) + '</button>' : '') +
          '<button class="btn btn-outline" id="tt-chk">🔍 ' + esc(t('tt.check')) + '</button>' +
          (canDo('schedule.settings') ? '<button class="btn btn-outline" id="tt-set">⚙ ' + esc(t('tt.settings')) + '</button><button class="btn btn-outline" id="tt-imp">⇪ ' + esc(t('tt.import')) + '</button>' : '') +
          (canDo('schedule.export') ? '<button class="btn btn-outline" id="tt-exp">⇩ ' + esc(t('tt.export')) + '</button>' : '') +
        '</div>' +
        '<div class="tt-tabs" role="tablist">' + tabs.map((k) => '<button class="chip-btn' + (S.tab === k ? ' active' : '') + '" role="tab" data-tab="' + k + '">' + esc(t('tt.tab.' + k)) + '</button>').join('') + '</div>' +
        '<div id="tt-body"></div>';
      const reperiod = async () => { S.year = $('tt-year').value.trim(); S.term = $('tt-term').value; S.vid = null; S.refs = null; await schedule(); };
      $('tt-year').addEventListener('change', reperiod);
      $('tt-term').addEventListener('change', reperiod);
      $('tt-ver').addEventListener('change', async (e) => { S.vid = e.target.value; S.ver = S.versions.find((v) => v.id === S.vid) || null; S.page = 1; await renderTab(); });
      root.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { S.tab = b.dataset.tab; root.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === b)); renderTab(); }));
      const on = (id, fn) => { const b = $(id); if (b) b.addEventListener('click', fn); };
      on('tt-gen', () => wizard());
      on('tt-chk', () => { S.tab = 'conflicts'; shell(); renderTab(); });
      on('tt-set', () => { S.tab = 'settings'; shell(); renderTab(); });
      on('tt-imp', () => { S.tab = 'requirements'; shell(); renderTab().then(() => settings().importDialog()); });
      on('tt-exp', exportDialog);
    }

    async function load() { await loadVersions(S.vid); S.refs = await api().refs(periodQ()); shell(); await renderTab(); }

    async function renderTab() {
      const box = $('tt-body');
      if (!box) return;
      box.innerHTML = skel(4);
      try {
        if (S.tab === 'schedule') await tabSchedule(box);
        else if (S.tab === 'conflicts') await tabConflicts(box);
        else if (S.tab === 'requirements') await settings().requirements(box);
        else if (S.tab === 'versions') await tabVersions(box);
        else if (S.tab === 'settings') await settings().settings(box);
      } catch (e) { box.innerHTML = errBox(e, 'tt-r2'); retry('tt-r2', renderTab); }
    }

    // ═════════════════════════ TAB: SCHEDULE ═════════════════════════
    const noVersion = () => '<div class="card"><div class="card-pad">' + empty(t('tt.no_version')) + (canDo('schedule.generate') ? '<div style="text-align:center"><button class="btn btn-success" id="tt-first">⚙ ' + esc(t('tt.create')) + '</button></div>' : '') + '</div></div>';

    async function tabSchedule(box) {
      if (!S.vid) { box.innerHTML = noVersion(); const b = $('tt-first'); if (b) b.addEventListener('click', () => wizard()); return; }
      const o = await api().overview(S.vid);
      const st = S.ver.stats || {};
      const pct = st.compliancePct != null ? st.compliancePct : null;
      const card = (icon, val, label, cls) => '<div class="stat-card"><div class="stat-icon">' + icon + '</div><div class="stat-val ' + (cls || '') + '">' + esc(val) + '</div><div class="stat-label">' + esc(label) + '</div></div>';
      const r = S.refs, f = S.f;
      const groups = r.groups.filter((g) => (!f.faculty || g.faculty === f.faculty) && (!f.level || g.level === f.level));
      box.innerHTML =
        '<div class="stat-grid">' +
          card('📅', o.lessons, t('tt.st.lessons')) + card('👥', o.groups + ' / ' + o.totals.groups, t('tt.st.groups')) +
          card('👨‍🏫', o.teachers + ' / ' + o.totals.teachers, t('tt.st.teachers')) + card('🚪', o.roomsUsed + ' / ' + o.totals.rooms, t('tt.st.rooms')) +
          card('🔴', st.critical != null ? st.critical : '—', t('tt.st.critical'), st.critical ? 'tt-red' : '') +
          card('🟡', st.warnings != null ? st.warnings : '—', t('tt.st.warnings')) +
          card('🟢', pct != null ? pct + '%' : '—', t('tt.st.compliance'), 'tt-green') +
        '</div>' +
        '<div class="au-bar">' +
          sel('tv-view', t('tt.view'), ['week', 'day', 'month', 'list'].map((x) => [x, t('tt.v.' + x)]), S.view) +
          (S.view === 'week' ? sel('tv-by', t('tt.show_for'), ['group', 'teacher', 'room', 'building'].map((x) => [x, t('tt.by.' + x)]), S.by) + valueSelect() : '') +
          (S.view === 'day' || S.view === 'month' ? '<label class="fld"><span>' + esc(t('tt.date')) + '</span><input class="input" type="date" id="tv-date" value="' + S.date + '"></label>' : '') +
          '<div style="flex:1"></div>' +
          (editable() && canDo('schedule.create') ? '<button class="btn btn-success" id="tv-add">+ ' + esc(t('tt.add_lesson')) + '</button>' : '') +
        '</div>' +
        '<div class="au-bar">' +
          '<label class="fld grow"><span>' + esc(t('common.search')) + '</span><input class="input" id="tf-search" value="' + esc(f.search) + '" placeholder="' + esc(t('tt.search_ph')) + '"></label>' +
          sel('tf-faculty', t('tt.faculty'), [['', t('common.all')]].concat(r.faculties.map((x) => [x, x])), f.faculty) +
          sel('tf-level', t('tt.level'), [['', t('common.all')]].concat(r.levels.map((x) => [x, t('ld.level.' + x, x)])), f.level) +
          sel('tf-group', t('tt.group'), [['', t('common.all')]].concat(groups.map((g) => [g.name, g.name])), f.group) +
          sel('tf-teacher', t('tt.teacher'), [['', t('common.all')]].concat(r.teachers.map((x) => [x.id, x.name])), f.teacherId) +
          sel('tf-building', t('tt.building'), [['', t('common.all')]].concat(r.buildings.map((x) => [x, x])), f.building) +
          sel('tf-room', t('tt.room'), [['', t('common.all')]].concat(r.rooms.filter((x) => !f.building || x.building === f.building).map((x) => [x.id, x.code])), f.roomId) +
          sel('tf-day', t('tt.day'), [['', t('common.all')]].concat([1, 2, 3, 4, 5, 6].map((d) => [String(d), dayName(d)])), f.day) +
          sel('tf-type', t('tt.type'), [['', t('common.all')]].concat(r.lessonTypes.map((x) => [x.code, x.name])), f.type) +
        '</div><div id="tv-box">' + skel(4) + '</div>';
      const bind = (id, key, mapKey) => $(id).addEventListener('change', (e) => { f[mapKey || key] = e.target.value; S.page = 1; if (key === 'faculty' || key === 'level' || key === 'building') f.group = key === 'building' ? f.group : ''; tabSchedule(box); });
      bind('tf-faculty', 'faculty'); bind('tf-level', 'level'); bind('tf-group', 'group'); bind('tf-teacher', 'teacher', 'teacherId');
      bind('tf-building', 'building'); bind('tf-room', 'room', 'roomId'); bind('tf-day', 'day'); bind('tf-type', 'type');
      let tm; $('tf-search').addEventListener('input', (e) => { clearTimeout(tm); tm = setTimeout(() => { f.search = e.target.value.trim(); S.page = 1; drawView(); }, 350); });
      $('tv-view').addEventListener('change', (e) => { S.view = e.target.value; tabSchedule(box); });
      if ($('tv-by')) $('tv-by').addEventListener('change', (e) => { S.by = e.target.value; S.value = ''; tabSchedule(box); });
      if ($('tv-value')) $('tv-value').addEventListener('change', (e) => { S.value = e.target.value; drawView(); });
      if ($('tv-date')) $('tv-date').addEventListener('change', (e) => { S.date = e.target.value || today(); drawView(); });
      if ($('tv-add')) $('tv-add').addEventListener('click', () => lessonDialog());
      await drawView();
    }

    function valueSelect() {
      const r = S.refs;
      const opts = S.by === 'group' ? r.groups.map((g) => [g.name, g.name])
        : S.by === 'teacher' ? r.teachers.map((x) => [x.id, x.name])
        : S.by === 'room' ? r.rooms.map((x) => [x.id, x.code + (x.building ? ' · ' + x.building : '')])
        : r.buildings.map((x) => [x, x]);
      if (!S.value || !opts.some((o) => o[0] === S.value)) S.value = opts.length ? opts[0][0] : '';
      return sel('tv-value', t('tt.by.' + S.by), opts, S.value, 'grow');
    }

    const listParams = () => {
      const f = S.f;
      return { search: f.search, faculty: f.faculty, level: f.level, group: f.group, teacherId: f.teacherId, roomId: f.roomId, building: f.building, day: f.day, type: f.type };
    };

    async function drawView() {
      const box = $('tv-box');
      if (!box) return;
      box.innerHTML = skel(4);
      try {
        if (S.view === 'list') await viewList(box);
        else if (S.view === 'week') await viewWeek(box);
        else if (S.view === 'day') await viewDay(box);
        else await viewMonth(box);
      } catch (e) { box.innerHTML = errBox(e, 'tv-r'); retry('tv-r', drawView); }
    }

    const lessonCell = (l, compact) => {
      const col = l.typeColor || '#2563eb';
      return '<div class="tt-les' + (l.locked ? ' locked' : '') + (l.override ? ' ovr' : '') + '" style="border-left-color:' + esc(col) + '" data-lid="' + esc(l.id) + '" tabindex="0" role="button">' +
        '<b>' + esc(l.subject.code) + '</b> <span class="au-muted">' + esc(l.typeName) + '</span>' + (l.locked ? ' 🔒' : '') + (l.override ? ' ⚠' : '') +
        '<div>' + esc(l.groups.join(', ')) + '</div>' +
        (compact ? '' : '<div class="au-muted">' + esc(l.teacher ? l.teacher.name : '—') + '</div>') +
        '<div class="au-muted">' + esc(l.room ? l.room.code : '—') + (l.parity !== 'BOTH' ? ' · ' + esc(t('ld.parity.' + l.parity, l.parity)) : '') + '</div></div>';
    };
    const bindLessons = (box, items) => box.querySelectorAll('[data-lid]').forEach((el) => {
      const open = () => lessonDrawer(items.find((x) => x.id === el.dataset.lid));
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    });

    async function viewList(box) {
      const d = await api().lessons(S.vid, Object.assign(listParams(), { page: S.page, pageSize: S.pageSize }));
      const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
      box.innerHTML = '<div class="card" style="overflow:hidden">' + (d.items.length ? '<div class="au-table"><table><thead><tr><th>' + esc(t('tt.day')) + '</th><th>' + esc(t('tt.time')) + '</th><th>' + esc(t('tt.lesson')) + '</th><th>' + esc(t('tt.group')) + '</th><th>' + esc(t('tt.teacher')) + '</th><th>' + esc(t('tt.room')) + '</th><th>' + esc(t('tt.parity')) + '</th></tr></thead><tbody>' +
        d.items.map((l) => '<tr class="tt-row" data-lid="' + esc(l.id) + '" tabindex="0"><td>' + esc(dayName(l.day)) + '</td><td><code>' + esc(l.start + '–' + l.end) + '</code></td>' +
          '<td><b>' + esc(l.subject.code) + '</b> · ' + esc(l.subject.name) + '<div class="au-muted">' + esc(l.typeName) + (l.locked ? ' · 🔒' : '') + (l.override ? ' · ⚠ ' + esc(t('tt.override')) : '') + '</div></td>' +
          '<td>' + esc(l.groups.join(', ')) + '<div class="au-muted">' + esc(l.size) + ' ' + esc(t('ld.students_short')) + '</div></td>' +
          '<td>' + (l.teacher ? esc(l.teacher.name) : '<span class="badge badge-warning">' + esc(t('ld.no_teacher')) + '</span>') + '</td>' +
          '<td>' + (l.room ? esc(l.room.code) + '<div class="au-muted">' + esc(l.room.building || '') + ' · ' + esc(l.room.capacity) + '</div>' : '—') + '</td>' +
          '<td class="au-muted">' + esc(t('ld.parity.' + l.parity, l.parity)) + '</td></tr>').join('') +
        '</tbody></table></div>' : empty(t('ld.no_slots'))) + '</div>' +
        '<div class="au-bar" style="margin-top:10px"><span class="au-muted">' + esc(t('tt.total')) + ': ' + d.total + '</span><div style="flex:1"></div>' +
        '<button class="btn btn-outline btn-sm" id="tp-prev"' + (S.page <= 1 ? ' disabled' : '') + '>‹</button><span class="au-muted"> ' + S.page + ' / ' + pages + ' </span><button class="btn btn-outline btn-sm" id="tp-next"' + (S.page >= pages ? ' disabled' : '') + '>›</button></div>';
      $('tp-prev').addEventListener('click', () => { S.page--; drawView(); });
      $('tp-next').addEventListener('click', () => { S.page++; drawView(); });
      bindLessons(box, d.items);
    }

    async function viewWeek(box) {
      if (!S.value) { box.innerHTML = empty(t('tt.pick_entity')); return; }
      const d = await api().entity(S.vid, S.by, S.value);
      const days = (S.refs.config.workingDays || [1, 2, 3, 4, 5]).slice().sort();
      const slots = S.refs.timeSlots.filter((s) => s.isActive);
      // строки сетки: активные слоты; занятия не по сетке выводятся отдельной строкой «вне сетки»
      const rowOf = (l) => slots.findIndex((s) => s.id === l.timeSlotId || (s.startTime === l.start && s.endTime === l.end));
      const rows = slots.map((s) => ({ label: s.label, time: s.startTime + '–' + s.endTime, level: s.level, items: [] }));
      const extra = [];
      d.items.forEach((l) => { const i = rowOf(l); (i >= 0 ? rows[i].items : extra).push(l); });
      const levelOfRow = (r) => r.level ? '<div class="au-muted">' + esc(t('ld.level.' + r.level, r.level)) + '</div>' : '';
      const body = rows.filter((r) => r.items.length || !r.level || true).map((r) =>
        '<tr><th class="tt-time"><b>' + esc(r.label) + '</b><div class="au-muted">' + esc(r.time) + '</div>' + levelOfRow(r) + '</th>' +
        days.map((dd) => '<td>' + r.items.filter((l) => l.day === dd).map((l) => lessonCell(l, S.by !== 'group' ? false : false)).join('') + '</td>').join('') + '</tr>').join('');
      const exBody = extra.length ? '<tr><th class="tt-time">' + esc(t('tt.off_grid')) + '</th>' + days.map((dd) => '<td>' + extra.filter((l) => l.day === dd).map((l) => '<div class="au-muted">' + esc(l.start + '–' + l.end) + '</div>' + lessonCell(l)).join('') + '</td>').join('') + '</tr>' : '';
      box.innerHTML = '<div class="card" style="overflow:hidden"><div class="au-table"><table class="tt-grid"><thead><tr><th></th>' + days.map((dd) => '<th>' + esc(dayName(dd)) + '</th>').join('') + '</tr></thead><tbody>' + body + exBody + '</tbody></table></div></div>' +
        '<div class="au-bar" style="margin-top:10px"><button class="btn btn-outline btn-sm" id="tw-print">🖨 ' + esc(t('tt.print')) + ' / PDF</button></div>';
      bindLessons(box, d.items);
      $('tw-print').addEventListener('click', () => printGrid(d.items, days, slots));
    }

    async function viewDay(box) {
      const f = S.f;
      const d = await api().calendar(S.vid, { from: S.date, to: S.date, group: f.group, teacherId: f.teacherId, roomId: f.roomId, faculty: f.faculty });
      const items = d.items.filter((l) => (!f.type || l.type === f.type) && (!f.day || String(l.day) === f.day));
      items.sort((a, b) => a.start.localeCompare(b.start) || a.groups.join().localeCompare(b.groups.join()));
      box.innerHTML = '<div class="au-note">' + esc(new Date(S.date + 'T00:00:00Z').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })) + ' · ' + items.length + '</div>' +
        '<div class="card"><div class="card-pad">' + (items.length ? items.map((l) =>
          '<div class="tt-dayrow' + (l.cancelled ? ' cancelled' : '') + '"><code>' + esc(l.start + '–' + l.end) + '</code><div style="flex:1">' + lessonCell(l) + '</div>' + (l.cancelled ? '<span class="badge badge-danger">' + esc(t('tt.cancelled')) + '</span>' : '') + '</div>').join('') : empty(t('tt.no_lessons_day'))) + '</div></div>';
      bindLessons(box, items);
    }

    async function viewMonth(box) {
      const first = S.date.slice(0, 8) + '01';
      const dt = new Date(first + 'T00:00:00Z');
      const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      const f = S.f;
      const d = await api().calendar(S.vid, { from: first, to: last, group: f.group, teacherId: f.teacherId, roomId: f.roomId, faculty: f.faculty });
      const by = {};
      d.items.filter((l) => !f.type || l.type === f.type).forEach((l) => { (by[l.date] = by[l.date] || []).push(l); });
      const start = mondayOf(first);
      let cells = '';
      for (let w = 0; w < 6; w++) {
        let row = '';
        for (let i = 0; i < 7; i++) {
          const iso = addDays(start, w * 7 + i), inMonth = iso.slice(0, 7) === first.slice(0, 7), n = (by[iso] || []).length;
          row += '<td class="tt-mcell' + (inMonth ? '' : ' off') + (iso === today() ? ' today' : '') + '" data-d="' + iso + '"><b>' + Number(iso.slice(8)) + '</b>' + (n ? '<div class="tt-cnt">' + n + '</div>' : '') + '</td>';
        }
        cells += '<tr>' + row + '</tr>';
      }
      box.innerHTML = '<div class="au-bar"><button class="btn btn-outline btn-sm" id="tm-prev">‹</button><b style="padding:0 8px">' + esc(dt.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })) + '</b><button class="btn btn-outline btn-sm" id="tm-next">›</button></div>' +
        '<div class="card" style="overflow:hidden"><table class="tt-month"><thead><tr>' + [1, 2, 3, 4, 5, 6, 7].map((x) => '<th>' + esc(dayShort(x)) + '</th>').join('') + '</tr></thead><tbody>' + cells + '</tbody></table></div>';
      const shiftM = (n) => { const x = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + n, 1)); S.date = x.toISOString().slice(0, 10); const inp = $('tv-date'); if (inp) inp.value = S.date; drawView(); };
      $('tm-prev').addEventListener('click', () => shiftM(-1)); $('tm-next').addEventListener('click', () => shiftM(1));
      box.querySelectorAll('[data-d]').forEach((c) => c.addEventListener('click', () => { S.date = c.dataset.d; S.view = 'day'; tabSchedule($('tt-body')); }));
    }

    // PDF: печатная форма (в браузере «Сохранить как PDF»)
    function printGrid(items, days, slots) {
      const w = global.open('', '_blank');
      if (!w) { toast(t('tt.popup_blocked'), true); return; }
      const title = (S.by === 'group' ? S.value : (S.refs[S.by === 'teacher' ? 'teachers' : 'rooms'].find((x) => x.id === S.value) || {}).name || (S.refs.rooms.find((x) => x.id === S.value) || {}).code || S.value);
      const rowFor = (s) => '<tr><th>' + esc(s.label) + '<br><small>' + esc(s.startTime + '–' + s.endTime) + '</small></th>' + days.map((d) => '<td>' + items.filter((l) => l.day === d && (l.timeSlotId === s.id || (l.start === s.startTime && l.end === s.endTime))).map((l) => '<div class="c"><b>' + esc(l.subject.code) + '</b> ' + esc(l.typeName) + '<br>' + esc(l.groups.join(', ')) + '<br>' + esc(l.teacher ? l.teacher.name : '') + ' · ' + esc(l.room ? l.room.code : '') + '</div>').join('') + '</td>').join('') + '</tr>';
      w.document.write('<!doctype html><meta charset="utf-8"><title>' + esc(title) + '</title><style>body{font:12px Arial,sans-serif;margin:16px}h2{margin:0 0 4px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:4px;vertical-align:top}th{background:#eee}.c{margin-bottom:4px;border-left:3px solid #2563eb;padding-left:4px}@page{size:landscape}</style><h2>' + esc(title) + '</h2><div>' + esc(S.year + ' · ' + t('tt.term.' + S.term) + ' · ' + verLabel(S.ver) + ' · ' + t('tt.status.' + S.ver.status)) + '</div><br><table><thead><tr><th></th>' + days.map((d) => '<th>' + esc(dayName(d)) + '</th>').join('') + '</tr></thead><tbody>' + slots.map(rowFor).join('') + '</tbody></table><script>setTimeout(function(){print()},300)<\/script>');
      w.document.close();
    }

    // ═════════════════════════ LESSON DRAWER / EDIT ═════════════════════════
    function lessonDrawer(l) {
      if (!l) return;
      const can = editable();
      openModal({
        title: l.subject.code + ' · ' + l.subject.name, static: false,
        html: '<div class="tt-kv"><span>' + esc(t('tt.type')) + '</span><b>' + esc(l.typeName) + '</b></div>' +
          '<div class="tt-kv"><span>' + esc(t('tt.group')) + '</span><b>' + esc(l.groups.join(', ')) + ' (' + l.size + ')</b></div>' +
          '<div class="tt-kv"><span>' + esc(t('tt.teacher')) + '</span><b>' + esc(l.teacher ? l.teacher.name : '—') + '</b></div>' +
          '<div class="tt-kv"><span>' + esc(t('tt.room')) + '</span><b>' + esc(l.room ? l.room.code + ' · ' + (l.room.building || '') + ' · ' + l.room.capacity : '—') + '</b></div>' +
          '<div class="tt-kv"><span>' + esc(t('tt.when')) + '</span><b>' + esc(dayName(l.day) + ' ' + l.start + '–' + l.end) + '</b></div>' +
          '<div class="tt-kv"><span>' + esc(t('tt.parity')) + '</span><b>' + esc(t('ld.parity.' + l.parity, l.parity)) + '</b></div>' +
          (l.locked ? '<div class="au-note">🔒 ' + esc(t('tt.locked_note')) + '</div>' : '') +
          (l.override ? '<div class="au-note" style="border-color:#f59e0b">⚠ ' + esc(t('tt.override_note')) + '</div>' : '') +
          (l.note ? '<div class="au-muted">' + esc(l.note) + '</div>' : ''),
        buttons: [{ label: t('common.close') }].concat(l.teacher && l.groups.length ? [{ label: '✔ ' + t('tt.open_attendance'), keep: false, onClick: () => { openAttendance(l); } }] : [])
          .concat(can && canDo('schedule.update') ? [
            { label: l.locked ? '🔓 ' + t('tt.unlock') : '🔒 ' + t('tt.lock'), onClick: async () => { try { await api().lockLessons(S.vid, [l.id], !l.locked); toast(t('ld.saved')); drawView(); } catch (e) { toast(errMsg(e), true); return false; } } },
            { label: t('common.edit'), cls: 'btn-primary', onClick: () => { setTimeout(() => lessonDialog(l), 0); } },
          ] : [])
          .concat(can && canDo('schedule.delete') ? [{ label: t('common.delete'), cls: 'btn-danger', onClick: async () => {
            if (!(await confirmDialog({ danger: true, confirmLabel: t('common.delete'), message: t('tt.confirm_delete') }))) return false;
            try { await api().deleteLesson(l.id); toast(t('ld.deleted')); await loadVersions(S.vid); drawView(); } catch (e) { toast(errMsg(e), true); return false; }
          } }] : []),
      });
    }

    // переход к посещаемости Academic Journal для выбранной пары: журнал открывается на вкладке посещаемости нужной группы
    function openAttendance(l) {
      try { sessionStorage.setItem('ap_att_hint', JSON.stringify({ groupName: l.groups[0], subjectCode: l.subject.code })); } catch { /* ignore */ }
      ctx.showPage('journal');
    }

    // диалог создания/редактирования: мгновенная проверка конфликтов (dry-run через сервер при сохранении)
    async function lessonDialog(l) {
      const r = S.refs;
      const slots = r.timeSlots.filter((s) => s.isActive);
      const isNew = !l;
      const cur = l || { subject: { id: r.subjects[0] && r.subjects[0].id }, teacher: null, room: null, groups: S.f.group ? [S.f.group] : [], type: 'lecture', day: 1, timeSlotId: slots[0] && slots[0].id, parity: 'BOTH' };
      const groupsSel = new Set(cur.groups);
      const m = openModal({
        title: isNew ? t('tt.add_lesson') : t('tt.edit_lesson'), wide: true, static: true,
        html: '<div class="form-grid">' +
          fsel('l-subj', t('tt.subject'), r.subjects.map((x) => [x.id, x.code + ' · ' + x.name]), cur.subject.id) +
          fsel('l-teacher', t('tt.teacher'), [['', '— ' + t('ld.no_teacher')]].concat(r.teachers.map((x) => [x.id, x.name])), cur.teacher ? cur.teacher.id : '') +
          fsel('l-type', t('tt.type'), r.lessonTypes.map((x) => [x.code, x.name]), cur.type) +
          fsel('l-room', t('tt.room'), [['', '—']].concat(r.rooms.map((x) => [x.id, x.code + ' · ' + (x.building || '') + ' · ' + x.capacity])), cur.room ? cur.room.id : '') +
          fsel('l-day', t('tt.day'), [1, 2, 3, 4, 5, 6].map((d) => [String(d), dayName(d)]), String(cur.day)) +
          fsel('l-slot', t('tt.slot'), slots.map((s) => [s.id, s.label + ' ' + s.startTime + '–' + s.endTime + (s.level ? ' (' + t('ld.level.' + s.level, s.level) + ')' : '')]), cur.timeSlotId || (slots[0] && slots[0].id)) +
          fsel('l-parity', t('tt.parity'), ['BOTH', 'UPPER', 'LOWER'].map((x) => [x, t('ld.parity.' + x)]), cur.parity) +
          '</div><div class="form-group"><div class="form-label">' + esc(t('tt.groups')) + '</div><input class="input" id="l-gfilter" placeholder="' + esc(t('common.search')) + '"><div class="tt-checks" id="l-groups"></div></div>' +
          '<div id="l-conf"></div>' +
          '<div class="form-group" id="l-ovr-box" style="display:none"><div class="form-label">' + esc(t('tt.override_reason')) + '</div><input class="input" id="l-ovr" maxlength="500"></div>',
        buttons: [{ label: t('common.cancel') }, { label: t('common.save'), cls: 'btn-primary', onClick: async (h) => save(h, false) }],
      });
      const drawGroups = () => {
        const q = m.$('#l-gfilter').value.trim().toLowerCase();
        const list = r.groups.filter((g) => groupsSel.has(g.name) || !q || g.name.toLowerCase().includes(q)).slice(0, 80);
        m.$('#l-groups').innerHTML = list.map((g) => '<label class="tt-chk"><input type="checkbox" data-g="' + esc(g.name) + '"' + (groupsSel.has(g.name) ? ' checked' : '') + '> ' + esc(g.name) + ' <span class="au-muted">(' + g.size + ')</span></label>').join('');
        m.$('#l-groups').querySelectorAll('[data-g]').forEach((c) => c.addEventListener('change', () => { c.checked ? groupsSel.add(c.dataset.g) : groupsSel.delete(c.dataset.g); }));
      };
      m.$('#l-gfilter').addEventListener('input', drawGroups); drawGroups();
      async function save(h, withOverride) {
        const slot = slots.find((s) => s.id === h.$('#l-slot').value);
        const dto = {
          subjectId: h.$('#l-subj').value, teacherId: h.$('#l-teacher').value || null, roomId: h.$('#l-room').value || null,
          groupNames: Array.from(groupsSel), lessonTypeCode: h.$('#l-type').value, dayOfWeek: Number(h.$('#l-day').value),
          timeSlotId: slot ? slot.id : undefined, weekParity: h.$('#l-parity').value,
        };
        if (!dto.groupNames.length) { h.$('#l-conf').innerHTML = '<div class="au-err">' + esc(t('tt.err_groups')) + '</div>'; return false; }
        const reason = h.$('#l-ovr').value.trim();
        if (reason.length >= 3 && canDo('schedule.override')) dto.overrideReason = reason;
        try {
          if (isNew) await api().createLesson(S.vid, dto); else await api().patchLesson(l.id, dto);
          toast(t('ld.saved')); await loadVersions(S.vid); drawView();
        } catch (e) {
          const b = e.body || {};
          if (b.code === 'SCHEDULE_CONFLICT') {
            h.$('#l-conf').innerHTML = '<div class="tt-conf-box"><b>🔴 ' + esc(t('tt.cannot_save')) + '</b>' + conflictList(b.conflicts || []) + (b.warnings && b.warnings.length ? '<b>🟡 ' + esc(t('tt.tab.warnings')) + '</b>' + conflictList(b.warnings) : '') + '</div>';
            if (canDo('schedule.override')) { h.$('#l-ovr-box').style.display = ''; }
          } else h.$('#l-conf').innerHTML = '<div class="au-err">' + esc(b.code === 'OVERRIDE_FORBIDDEN' ? t('tt.override_forbidden') : errMsg(e)) + '</div>';
          return false;
        }
      }
    }

    // ═════════════════════════ CONFLICTS ═════════════════════════
    const fmtItem = (i) => esc(i.subject) + ' · ' + esc((i.groups || []).join(', ')) + ' · ' + esc(dayShort(i.day) + ' ' + i.start + '–' + i.end) + (i.room ? ' · ' + esc(i.room) : '') + (i.teacher ? ' · ' + esc(i.teacher) : '');
    const SHOW_P = ['day', 'gaps', 'run', 'max', 'count', 'span', 'moves', 'need', 'capacity'];
    const paramText = (p) => p && typeof p === 'object' ? SHOW_P.filter((k) => p[k] !== undefined && p[k] !== null).map((k) => esc(t('tt.p.' + k, k)) + ': ' + esc(k === 'day' ? dayName(Number(p[k])) : p[k])).join(' · ') : '';
    function conflictItem(c, withActions) {
      const sev = c.severity === 'critical' ? '🔴' : '🟡';
      return '<div class="tt-conf ' + c.severity + '"><div><b>' + sev + ' ' + esc(t('tt.c.' + c.code, c.code)) + '</b>' + (c.entity && c.entity.name ? ' — ' + esc(c.entity.name) : '') + '</div>' +
        '<div class="au-muted">' + esc(t('tt.cx.' + c.code, '')) + '</div>' +
        (c.items && c.items.length ? '<ul>' + c.items.map((i) => '<li>' + fmtItem(i) + '</li>').join('') + '</ul>' : '') +
        (paramText(c.params) ? '<div class="au-muted">' + paramText(c.params) + '</div>' : '') +
        (withActions && editable() ? '<div class="tt-actions">' +
          (c.items && c.items.length && canDo('schedule.update') ? '<button class="btn btn-outline btn-sm" data-fix="' + esc(c.items[0].lessonId) + '">🛠 ' + esc(t('tt.fix')) + '</button>' : '') +
          (c.lessonIds && c.lessonIds.length && canDo('schedule.generate') ? '<button class="btn btn-outline btn-sm" data-regen="' + esc(c.lessonIds.join(',')) + '">↻ ' + esc(t('tt.regen_affected')) + '</button>' : '') + '</div>' : '') + '</div>';
    }
    const conflictList = (arr) => '<div>' + arr.map((c) => conflictItem(c, false)).join('') + '</div>';

    async function tabConflicts(box) {
      if (!S.vid) { box.innerHTML = noVersion(); return; }
      S.cf = S.cf || { sev: '', code: '' };
      const d = await api().conflicts(S.vid, { refresh: 'true', severity: S.cf.sev, code: S.cf.code, take: 300 });
      const st = d.stats || {};
      S.ver.stats = st;
      const codes = Object.keys(d.byCode || {});
      box.innerHTML =
        '<div class="stat-grid">' +
          '<div class="stat-card"><div class="stat-icon">🔴</div><div class="stat-val tt-red">' + (st.critical || 0) + '</div><div class="stat-label">' + esc(t('tt.st.critical')) + '</div></div>' +
          '<div class="stat-card"><div class="stat-icon">🟡</div><div class="stat-val">' + (st.warnings || 0) + '</div><div class="stat-label">' + esc(t('tt.st.warnings')) + '</div></div>' +
          '<div class="stat-card"><div class="stat-icon">🟢</div><div class="stat-val tt-green">' + (st.compliancePct != null ? st.compliancePct + '%' : '—') + '</div><div class="stat-label">' + esc(t('tt.st.compliance')) + '</div></div>' +
        '</div>' +
        (st.critical ? '<div class="au-note" style="border-color:#ef4444">⛔ ' + esc(t('tt.publish_blocked')) + '</div>' : '<div class="au-note">✓ ' + esc(t('tt.publish_ok')) + '</div>') +
        '<div class="au-bar">' + sel('tc-sev', t('tt.severity'), [['', t('common.all')], ['critical', '🔴 ' + t('tt.st.critical')], ['warning', '🟡 ' + t('tt.st.warnings')]], S.cf.sev) +
          sel('tc-code', t('tt.code'), [['', t('common.all')]].concat(codes.map((c) => [c, t('tt.c.' + c, c) + ' (' + d.byCode[c] + ')'])), S.cf.code) +
          '<div style="flex:1"></div><button class="btn btn-outline" id="tc-refresh">↻ ' + esc(t('tt.recheck')) + '</button>' +
          (editable() && canDo('schedule.generate') && st.critical ? '<button class="btn btn-success" id="tc-regen-all">↻ ' + esc(t('tt.regen_all_critical')) + '</button>' : '') + '</div>' +
        '<div class="card"><div class="card-pad">' + (d.items.length ? d.items.map((c) => conflictItem(c, true)).join('') + (d.truncated ? '<div class="au-muted">' + esc(t('tt.truncated').replace('{n}', d.total)) + '</div>' : '') : empty(t('tt.no_conflicts'))) + '</div></div>';
      $('tc-sev').addEventListener('change', (e) => { S.cf.sev = e.target.value; tabConflicts(box); });
      $('tc-code').addEventListener('change', (e) => { S.cf.code = e.target.value; tabConflicts(box); });
      $('tc-refresh').addEventListener('click', () => tabConflicts(box));
      if ($('tc-regen-all')) $('tc-regen-all').addEventListener('click', async () => {
        const ids = Array.from(new Set(d.items.filter((c) => c.severity === 'critical').flatMap((c) => c.lessonIds)));
        if (ids.length) regenerate({ lessonIds: ids });
      });
      box.querySelectorAll('[data-fix]').forEach((b) => b.addEventListener('click', async () => {
        try { const all = await api().lessons(S.vid, { pageSize: 500, search: '' }); const l = all.items.find((x) => x.id === b.dataset.fix); if (l) lessonDialog(l); else { const it = await api().entity(S.vid, 'group', d.items.flatMap((c) => c.items).find((i) => i.lessonId === b.dataset.fix).groups[0]); lessonDialog(it.items.find((x) => x.id === b.dataset.fix)); } }
        catch (e) { toast(errMsg(e), true); }
      }));
      box.querySelectorAll('[data-regen]').forEach((b) => b.addEventListener('click', () => regenerate({ lessonIds: b.dataset.regen.split(',') })));
    }

    // ═════════════════════════ VERSIONS ═════════════════════════
    async function tabVersions(box) {
      await loadVersions(S.vid);
      const vs = S.versions;
      box.innerHTML = '<div class="au-bar"><div style="flex:1"></div>' + (canDo('schedule.create') ? '<button class="btn btn-success" id="tvv-new">+ ' + esc(t('tt.new_draft')) + '</button>' : '') + '</div>' +
        '<div class="card" style="overflow:hidden">' + (vs.length ? '<div class="au-table"><table><thead><tr><th>' + esc(t('tt.version')) + '</th><th>' + esc(t('common.status')) + '</th><th>' + esc(t('tt.st.lessons')) + '</th><th>🔴 / 🟡 / 🟢</th><th>' + esc(t('tt.created')) + '</th><th></th></tr></thead><tbody>' +
          vs.map((v) => {
            const s = v.stats || {};
            return '<tr><td><b>v' + v.number + '</b>' + (v.name ? ' · ' + esc(v.name) : '') + (v.parentId ? '<div class="au-muted">← v' + esc((vs.find((x) => x.id === v.parentId) || {}).number || '?') + '</div>' : '') + (v.note ? '<div class="au-muted">' + esc(v.note) + '</div>' : '') + '</td>' +
              '<td>' + statusBadge(v.status) + (v.publishedAt ? '<div class="au-muted">' + esc(fmtDT(v.publishedAt)) + '</div>' : '') + '</td><td>' + v.lessons + '</td>' +
              '<td>' + (s.critical != null ? s.critical + ' / ' + s.warnings + ' / ' + (s.compliancePct != null ? s.compliancePct + '%' : '—') : '—') + '</td>' +
              '<td class="au-muted">' + esc(fmtDT(v.createdAt)) + (v.createdBy ? '<div>' + esc(v.createdBy.fullName) + '</div>' : '') + '</td>' +
              '<td style="white-space:nowrap">' +
                '<button class="btn btn-outline btn-sm" data-open="' + esc(v.id) + '">' + esc(t('tt.open')) + '</button> ' +
                (v.id !== S.vid || true ? '<button class="btn btn-outline btn-sm" data-diff="' + esc(v.id) + '">' + esc(t('tt.diff')) + '</button> ' : '') +
                (canDo('schedule.create') ? '<button class="btn btn-outline btn-sm" data-restore="' + esc(v.id) + '">' + esc(v.status === 'PUBLISHED' ? t('tt.copy') : t('tt.rollback')) + '</button> ' : '') +
                (v.status === 'DRAFT' && canDo('schedule.update') ? '<button class="btn btn-outline btn-sm" data-act="review" data-id="' + esc(v.id) + '">' + esc(t('tt.to_review')) + '</button> ' : '') +
                (v.status === 'REVIEW' && canDo('schedule.update') ? '<button class="btn btn-outline btn-sm" data-act="draft" data-id="' + esc(v.id) + '">' + esc(t('tt.to_draft')) + '</button> ' : '') +
                ((v.status === 'DRAFT' || v.status === 'REVIEW') && canDo('schedule.publish') ? '<button class="btn btn-success btn-sm" data-pub="' + esc(v.id) + '">' + esc(t('tt.publish')) + '</button> ' : '') +
                (v.status !== 'PUBLISHED' && v.status !== 'ARCHIVED' && canDo('schedule.update') ? '<button class="btn btn-outline btn-sm" data-act="archive" data-id="' + esc(v.id) + '">' + esc(t('tt.archive')) + '</button>' : '') +
              '</td></tr>';
          }).join('') + '</tbody></table></div>' : empty(t('tt.no_version'))) + '</div>';
      const on = (sel2, fn) => box.querySelectorAll(sel2).forEach((b) => b.addEventListener('click', () => fn(b)));
      if ($('tvv-new')) $('tvv-new').addEventListener('click', newDraftDialog);
      on('[data-open]', async (b) => { S.vid = b.dataset.open; S.ver = S.versions.find((v) => v.id === S.vid); S.tab = 'schedule'; shell(); renderTab(); });
      on('[data-diff]', (b) => diffDialog(b.dataset.diff));
      on('[data-restore]', async (b) => {
        if (!(await confirmDialog({ message: t('tt.confirm_restore') }))) return;
        try { const nv = await api().versionAction(b.dataset.restore, 'restore'); toast(t('tt.draft_created')); await loadVersions(nv.id); shell(); renderTab(); } catch (e) { toast(errMsg(e), true); }
      });
      on('[data-act]', async (b) => {
        if (b.dataset.act === 'archive' && !(await confirmDialog({ message: t('tt.confirm_archive') }))) return;
        try { await api().versionAction(b.dataset.id, b.dataset.act); toast(t('ld.saved')); await loadVersions(S.vid); shell(); renderTab(); } catch (e) { toast(errMsg(e), true); }
      });
      on('[data-pub]', (b) => publish(b.dataset.pub));
    }

    async function publish(id) {
      const v = S.versions.find((x) => x.id === id);
      if (!(await confirmDialog({ message: t('tt.confirm_publish').replace('{v}', 'v' + v.number), confirmLabel: t('tt.publish') }))) return;
      try {
        await api().versionAction(id, 'publish');
        toast(t('tt.published'));
        await loadVersions(id); shell(); renderTab();
      } catch (e) {
        const b = e.body || {};
        if (b.code === 'PUBLISH_BLOCKED') {
          openModal({ title: '⛔ ' + t('tt.publish_blocked_title'), wide: true, html: '<div class="au-note" style="border-color:#ef4444">' + esc(t('tt.publish_blocked')) + '</div>' + (b.conflicts ? conflictList(b.conflicts.slice(0, 15)) : ''), buttons: [{ label: t('common.close') }, { label: t('tt.show_conflicts'), cls: 'btn-primary', onClick: () => { S.vid = id; S.ver = v; S.tab = 'conflicts'; shell(); renderTab(); } }] });
        } else toast(errMsg(e), true);
      }
    }

    function newDraftDialog() {
      openModal({
        title: t('tt.new_draft'), static: true,
        html: fsel('nd-from', t('tt.copy_from'), [['', t('tt.empty_version')]].concat(S.versions.map((v) => [v.id, verLabel(v) + ' — ' + t('tt.status.' + v.status)])), S.vid || '') +
          '<div class="form-group"><div class="form-label">' + esc(t('tt.name')) + '</div><input class="input" id="nd-name" maxlength="80"></div><div class="au-err" id="nd-err"></div>',
        buttons: [{ label: t('common.cancel') }, { label: t('common.save'), cls: 'btn-primary', onClick: async (h) => {
          try { const nv = await api().createVersion({ academicYear: S.year, term: S.term, fromVersionId: h.$('#nd-from').value || null, name: h.$('#nd-name').value.trim() || undefined }); toast(t('tt.draft_created')); await loadVersions(nv.id); shell(); renderTab(); }
          catch (e) { h.$('#nd-err').textContent = errMsg(e); return false; }
        } }],
      });
    }

    async function diffDialog(id) {
      const others = S.versions.filter((v) => v.id !== id);
      if (!others.length) { toast(t('tt.diff_none'), true); return; }
      const m = openModal({ title: t('tt.diff'), wide: true, html: fsel('df-against', t('tt.diff_against'), others.map((v) => [v.id, verLabel(v) + ' — ' + t('tt.status.' + v.status)]), (others.find((v) => v.status === 'PUBLISHED') || others[0]).id) + '<div id="df-out">' + skel(2) + '</div>', buttons: [{ label: t('common.close') }] });
      const run = async () => {
        const out = m.$('#df-out'); out.innerHTML = skel(2);
        try {
          const d = await api().diff(id, m.$('#df-against').value);
          const brief = (l) => dayShort(l.day) + ' ' + l.start + '–' + l.end + (l.room ? ' · ' + l.room : '') + (l.teacher ? ' · ' + l.teacher : '');
          const line = (l) => '<li>' + esc((l.subject || '') + ' · ' + (l.groups || []).join(', ') + ' · ' + dayShort(l.day) + ' ' + l.start + '–' + l.end + (l.room ? ' · ' + l.room : '') + (l.teacher ? ' · ' + l.teacher : '')) + '</li>';
          out.innerHTML = '<div class="au-note">+' + d.summary.added + ' / −' + d.summary.removed + ' / ✎' + d.summary.changed + '</div>' +
            (d.added.length ? '<b>➕ ' + esc(t('tt.diff_added')) + '</b><ul class="tt-ul">' + d.added.map(line).join('') + '</ul>' : '') +
            (d.removed.length ? '<b>➖ ' + esc(t('tt.diff_removed')) + '</b><ul class="tt-ul">' + d.removed.map(line).join('') + '</ul>' : '') +
            (d.changed.length ? '<b>✎ ' + esc(t('tt.diff_changed')) + '</b><ul class="tt-ul">' + d.changed.map((c) => '<li><b>' + esc(c.before.subject + ' · ' + c.before.groups.join(', ')) + '</b> (' + esc((c.fields || []).map((f) => t('tt.f.' + f, f)).join(', ')) + '): ' + esc(brief(c.before)) + ' → ' + esc(brief(c.after)) + '</li>').join('') + '</ul>' : '');
        } catch (e) { out.innerHTML = errBox(e); }
      };
      m.$('#df-against').addEventListener('change', run); run();
    }

    // ═════════════════════════ GENERATION WIZARD ═════════════════════════
    function wizard(preset) {
      const r = S.refs;
      const pick = { levels: new Set(), faculties: new Set(), groups: new Set(), teachers: new Set(), rooms: new Set() };
      const mode0 = preset && preset.mode ? preset.mode : 'FRESH';
      const m = openModal({
        title: '⚙ ' + t('tt.wiz.title'), wide: true, static: true,
        html: '<div class="au-note">' + esc(t('tt.wiz.hint')) + '</div><div class="form-grid">' +
          fsel('w-mode', t('tt.wiz.mode'), [['FRESH', t('tt.wiz.mode_fresh')], ['REGENERATE', t('tt.wiz.mode_regen')]], mode0) +
          fsel('w-base', t('tt.wiz.base'), [['', '—']].concat(S.versions.map((v) => [v.id, verLabel(v) + ' — ' + t('tt.status.' + v.status)])), mode0 === 'REGENERATE' ? S.vid || '' : (preset && preset.base) || '') +
          '<div class="form-group"><div class="form-label">' + esc(t('tt.wiz.time')) + '</div><input class="input" id="w-time" type="number" min="5" max="1800" value="' + esc(r.config.timeLimitSec || 60) + '"></div>' +
          '<div class="form-group"><div class="form-label">' + esc(t('tt.wiz.seed')) + '</div><input class="input" id="w-seed" type="number" min="1" placeholder="auto"></div></div>' +
          '<div class="tt-wiz-grid">' +
            wizList('levels', t('tt.level'), r.levels.map((x) => [x, t('ld.level.' + x, x)])) +
            wizList('faculties', t('tt.faculty'), r.faculties.map((x) => [x, x])) +
            wizList('groups', t('tt.group'), r.groups.map((g) => [g.name, g.name + ' (' + g.size + ')']), true) +
            wizList('teachers', t('tt.teacher'), r.teachers.map((x) => [x.id, x.name]), true) +
            wizList('rooms', t('tt.room'), r.rooms.map((x) => [x.id, x.code + (x.building ? ' · ' + x.building : '')]), true) +
            wizList('days', t('tt.day'), [1, 2, 3, 4, 5, 6].map((d) => [String(d), dayName(d)])) +
          '</div><div class="au-muted">' + esc(t('tt.wiz.empty_all')) + '</div><div class="au-err" id="w-err"></div>',
        buttons: [{ label: t('common.cancel') }, { label: '▶ ' + t('tt.wiz.start'), cls: 'btn-success', onClick: async (h) => {
          const scope = {};
          Object.keys(pick).concat(['days']).forEach((k) => { const v = Array.from((h.pick || pick)[k] || []); if (v.length) scope[k] = k === 'days' ? v.map(Number) : v; });
          if (preset && preset.lessonIds) scope.lessonIds = preset.lessonIds;
          const dto = { academicYear: S.year, term: S.term, mode: h.$('#w-mode').value, baseVersionId: h.$('#w-base').value || null, scope, timeLimitSec: Number(h.$('#w-time').value) || undefined };
          if (h.$('#w-seed').value) dto.seed = Number(h.$('#w-seed').value);
          if (dto.mode === 'REGENERATE' && !dto.baseVersionId) { h.$('#w-err').textContent = t('tt.wiz.need_base'); return false; }
          try { const job = await api().generate(dto); setTimeout(() => progress(job.job.id), 0); }
          catch (e) { h.$('#w-err').textContent = (e.body && e.body.code === 'JOB_ACTIVE') ? t('tt.wiz.job_active') : errMsg(e); return false; }
        } }],
      });
      pick.days = new Set();
      m.pick = pick;
      m.body.querySelectorAll('[data-wl]').forEach((box) => {
        const k = box.dataset.wl;
        box.querySelectorAll('input[type=checkbox]').forEach((c) => c.addEventListener('change', () => { c.checked ? pick[k].add(c.value) : pick[k].delete(c.value); }));
        const f = box.querySelector('.tt-wl-f');
        if (f) f.addEventListener('input', () => { const q = f.value.toLowerCase(); box.querySelectorAll('.tt-chk').forEach((x) => { x.style.display = !q || x.textContent.toLowerCase().includes(q) ? '' : 'none'; }); });
      });
      m.$('#w-mode').addEventListener('change', (e) => { if (e.target.value === 'REGENERATE' && !m.$('#w-base').value) m.$('#w-base').value = S.vid || ''; });
    }
    const wizList = (key, title, opts, filter) => '<div class="tt-wl" data-wl="' + key + '"><div class="form-label">' + esc(title) + '</div>' + (filter ? '<input class="input tt-wl-f" placeholder="' + esc(t('common.search')) + '">' : '') + '<div class="tt-checks">' + opts.map(([v, l]) => '<label class="tt-chk"><input type="checkbox" value="' + esc(v) + '"> ' + esc(l) + '</label>').join('') + '</div></div>';

    // регенерация затронутых занятий (точечно) на новом черновике
    async function regenerate(scope) {
      if (!(await confirmDialog({ message: t('tt.regen_confirm') }))) return;
      try {
        const job = await api().generate({ academicYear: S.year, term: S.term, mode: 'REGENERATE', baseVersionId: S.vid, scope, timeLimitSec: S.refs.config.timeLimitSec || 30 });
        progress(job.job.id);
      } catch (e) { toast((e.body && e.body.code === 'JOB_ACTIVE') ? t('tt.wiz.job_active') : errMsg(e), true); }
    }

    function progress(jobId) {
      let stop = false, timer = null;
      const m = openModal({
        title: t('tt.job.title'), static: true, wide: true,
        html: '<div id="jp-box">' + skel(2) + '</div>',
        onClose: () => { stop = true; clearTimeout(timer); },
        buttons: [
          { id: 'cancel', label: t('tt.job.cancel'), cls: 'btn-danger', keep: true, onClick: async () => { try { await api().cancelJob(jobId); } catch (e) { toast(errMsg(e), true); } } },
          { id: 'open', label: t('tt.job.open'), cls: 'btn-primary', hidden: true, onClick: async (h) => { const j = h.job; await loadVersions(j.versionId); S.tab = 'schedule'; shell(); renderTab(); } },
          { id: 'close', label: t('common.close'), keep: false },
        ],
      });
      const draw = (j) => {
        const box = m.$('#jp-box');
        const res = j.result || {};
        const running = j.status === 'QUEUED' || j.status === 'RUNNING';
        let html = '<div class="tt-prog"><div class="tt-prog-bar"><i style="width:' + (j.progress || 0) + '%"></i></div><div class="au-muted">' + esc(t('tt.job.status.' + j.status)) + ' · ' + esc(t('tt.job.phase.' + (j.phase || ''), j.phase || '')) + ' · ' + (j.progress || 0) + '%' + (res.placed != null && running ? ' · ' + esc(t('tt.job.placed')) + ': ' + res.placed + '/' + res.total : '') + '</div></div>';
        if (j.status === 'FAILED') html += '<div class="au-err">' + esc(j.error || t('common.error')) + '</div>';
        if (j.status === 'DONE') {
          html += '<div class="stat-grid">' +
            '<div class="stat-card"><div class="stat-val">' + res.successPct + '%</div><div class="stat-label">' + esc(t('tt.job.success')) + ' (' + res.placed + '/' + res.sessionsTotal + ')</div></div>' +
            '<div class="stat-card"><div class="stat-val tt-red">' + res.critical + '</div><div class="stat-label">🔴 ' + esc(t('tt.st.critical')) + '</div></div>' +
            '<div class="stat-card"><div class="stat-val">' + res.warnings + '</div><div class="stat-label">🟡 ' + esc(t('tt.st.warnings')) + '</div></div>' +
            '<div class="stat-card"><div class="stat-val tt-green">' + (res.compliancePct != null ? res.compliancePct + '%' : '—') + '</div><div class="stat-label">🟢 ' + esc(t('tt.st.compliance')) + '</div></div></div>' +
            '<div class="au-muted">' + esc(t('tt.job.summary').replace('{g}', res.groups).replace('{t}', res.teachers).replace('{r}', res.roomsUsed).replace('{s}', Math.round((res.elapsedMs || 0) / 100) / 10)) + '</div>';
          if (res.unplacedCount) html += '<div class="au-note" style="border-color:#f59e0b"><b>' + esc(t('tt.job.unplaced').replace('{n}', res.unplacedCount)) + '</b><ul class="tt-ul">' + (res.unplaced || []).slice(0, 12).map((u) => '<li>' + esc((u.subject || '?') + ' · ' + (u.groups || []).join(', ') + ' · ' + (u.type || '') + ' — ' + t('tt.u.' + u.code, u.code)) + '</li>').join('') + '</ul></div>';
        }
        box.innerHTML = html;
        m.show('cancel', running); m.show('open', j.status === 'DONE'); m.job = j;
      };
      const poll = async () => {
        if (stop) return;
        try {
          const j = await api().job(jobId); draw(j);
          if (j.status === 'QUEUED' || j.status === 'RUNNING') timer = setTimeout(poll, 1500);
          else { await loadVersions(j.status === 'DONE' ? j.versionId : S.vid); }
        } catch (e) { m.$('#jp-box').innerHTML = errBox(e); }
      };
      poll();
    }

    // ═════════════════════════ EXPORT ═════════════════════════
    function exportDialog() {
      if (!S.vid) { toast(t('tt.no_version'), true); return; }
      const r = S.refs;
      const byOpts = { all: [], group: r.groups.map((g) => [g.name, g.name]), teacher: r.teachers.map((x) => [x.id, x.name]), room: r.rooms.map((x) => [x.id, x.code]), faculty: r.faculties.map((x) => [x, x]), day: [1, 2, 3, 4, 5, 6].map((d) => [String(d), dayName(d)]) };
      const m = openModal({
        title: '⇩ ' + t('tt.export'), static: true,
        html: '<div class="form-grid">' + fsel('x-fmt', t('tt.fmt'), [['xlsx', 'Excel (.xlsx)'], ['csv', 'CSV'], ['pdf', 'PDF (' + t('tt.print') + ')']], 'xlsx') +
          fsel('x-by', t('tt.show_for'), ['all', 'group', 'teacher', 'room', 'faculty', 'day'].map((x) => [x, t('tt.exp.' + x)]), 'all') + '</div><div id="x-val"></div><div class="au-err" id="x-err"></div>',
        buttons: [{ label: t('common.cancel') }, { label: t('tt.export'), cls: 'btn-primary', onClick: async (h) => {
          const by = h.$('#x-by').value, fmt = h.$('#x-fmt').value, val = h.$('#x-val select') ? h.$('#x-val select').value : undefined;
          if (by !== 'all' && !val) { h.$('#x-err').textContent = t('tt.pick_entity'); return false; }
          try {
            if (fmt === 'pdf') {
              const by2 = by === 'group' || by === 'teacher' || by === 'room' ? by : null;
              if (!by2) { h.$('#x-err').textContent = t('tt.pdf_only_entity'); return false; }
              const d = await api().entity(S.vid, by2, val);
              S.by = by2; S.value = val;
              printGrid(d.items, (r.config.workingDays || [1, 2, 3, 4, 5]).slice().sort(), r.timeSlots.filter((s) => s.isActive));
            } else {
              const blob = await api().exportFile(S.vid, { format: fmt, by, value: by === 'day' ? undefined : val, day: by === 'day' ? val : undefined, lang: AP.i18n.getLang() });
              saveBlob(blob, 'timetable-v' + S.ver.number + '-' + S.year + '.' + fmt);
            }
          } catch (e) { h.$('#x-err').textContent = errMsg(e); return false; }
        } }],
      });
      const draw = () => { const o = byOpts[m.$('#x-by').value]; m.$('#x-val').innerHTML = o.length ? fsel('x-v', t('tt.value'), o, o[0][0]) : ''; };
      m.$('#x-by').addEventListener('change', draw); draw();
    }

    // Аудитории — часть настроек, но доступны и отдельной страницей меню
    async function rooms() {
      const root = $('lx-rooms');
      root.innerHTML = skel(4);
      try { await settings().rooms(root); } catch (e) { root.innerHTML = errBox(e, 'rm-r'); retry('rm-r', rooms); }
    }

    // Глубокие ссылки из бокового меню: открыть вкладку/подраздел или мастер генерации
    async function open(o) {
      if (o && o.tab) S.tab = o.tab;
      if (o && o.sub) S.sub = o.sub;
      await schedule();
      if (o && o.wizard && S.refs && canDo('schedule.generate')) wizard();
    }

    return { schedule, rooms, open };
  }

  AP.timetableUI = { create };
})(window);
