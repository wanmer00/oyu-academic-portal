// ============================================================
// Leadership workspace: dashboard, KPI, users, requests, schedule,
// rooms, calendar, announcements, payments.
// Все данные — с бэкенда (/leadership/*); права проверяет сервер.
// ============================================================
(function (global) {
  'use strict';
  const AP = (global.AP = global.AP || {});

  function create(ctx) {
    const { t, esc, openModal, confirmDialog } = AP.tui;
    const { columns, hbars, shortWeek } = AP.charts;
    const { toast } = ctx;
    const api = () => AP.api.leadership;
    const $ = (id) => document.getElementById(id);
    const lang = () => AP.i18n.getLang();
    const loc = () => (lang() === 'en' ? 'en-GB' : lang() === 'ru' ? 'ru-RU' : 'az-AZ');
    const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString(loc(), { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return iso; } };
    const fmtDT = (iso) => { try { return new Date(iso).toLocaleString(loc()); } catch { return iso; } };
    const errMsg = (e) => (e && e.message) || t('common.error');
    const skel = (n, h) => Array.from({ length: n || 3 }, () => '<div class="skel" style="height:' + (h || 44) + 'px;margin:10px 0"></div>').join('');
    const empty = (msg) => '<div class="empty">' + esc(msg || t('ld.no_data')) + '</div>';
    const errBox = (e, id) => '<div class="empty au-err">' + esc(errMsg(e)) + (id ? '<div style="margin-top:10px"><button class="btn btn-outline btn-sm" id="' + id + '">' + esc(t('notif.retry')) + '</button></div>' : '') + '</div>';
    const retry = (id, fn) => { const b = $(id); if (b) b.addEventListener('click', fn); };
    const stat = (icon, val, label, sub, go) =>
      '<div class="stat-card' + (go ? ' clickable' : '') + '"' + (go ? ' data-go="' + go + '" role="button" tabindex="0"' : '') + '><div class="stat-icon">' + icon + '</div>' +
      '<div class="stat-val">' + esc(val) + '</div><div class="stat-label">' + esc(label) + '</div>' + (sub ? '<div class="au-muted" style="margin-top:4px">' + sub + '</div>' : '') + '</div>';
    const bindGo = (root) => root.querySelectorAll('[data-go]').forEach((el) => {
      const go = () => ctx.showPage(el.dataset.go);
      el.addEventListener('click', go);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
    const roleBadge = (r) => '<span class="badge ' + ({ STUDENT: 'badge-info', TEACHER: 'badge-purple', ADMIN: 'badge-warning', SUPER_ADMIN: 'badge-warning' }[r] || 'badge-gray') + '">' + esc(t('ld.role.' + r, r)) + '</span>';
    const statusBadge = (s) => '<span class="badge ' + ({ ACTIVE: 'badge-success', SUSPENDED: 'badge-warning', DELETED: 'badge-danger' }[s] || 'badge-gray') + '">' + esc(t('ld.ustatus.' + s, s)) + '</span>';
    const reqBadge = (s) => '<span class="badge ' + ({ PENDING: 'badge-warning', UNDER_REVIEW: 'badge-info', APPROVED: 'badge-success', PARTIALLY_APPROVED: 'badge-success', REJECTED: 'badge-danger' }[s] || 'badge-gray') + '">' + esc(t('requests.status.' + s.toLowerCase(), s)) + '</span>';
    const reqType = (x) => t('requests.' + ({ CERTIFICATE: 'certificate', APPEAL: 'appeal', TRANSFER: 'transfer', OTHER: 'other' }[x] || 'other'), x);
    const payBadge = (s) => '<span class="badge ' + ({ PAID: 'badge-success', PENDING: 'badge-warning', PROCESSING: 'badge-info', FAILED: 'badge-danger', REFUNDED: 'badge-gray' }[s] || 'badge-gray') + '">' + esc(t('ld.pay.' + s, s)) + '</span>';
    const azn = (n) => Math.round(Number(n) || 0).toLocaleString(loc()) + ' AZN';
    const DAYS = [1, 2, 3, 4, 5, 6, 7];
    const dayName = (d) => t(['', 'schedule.monday', 'schedule.tuesday', 'schedule.wednesday', 'schedule.thursday', 'schedule.friday', 'schedule.saturday', 'schedule.sunday'][d]);
    const conflictText = (c) => {
      if (c.kind === 'CAPACITY') return t('ld.conf.CAPACITY').replace('{room}', c.roomCode).replace('{cap}', c.capacity).replace('{size}', c.groupSize);
      if (c.kind === 'ROOM_EVENT') return t('ld.conf.ROOM_EVENT').replace('{title}', c.title).replace('{date}', c.date);
      if (c.kind === 'GROUP_EVENT') return t('ld.conf.GROUP_EVENT').replace('{title}', c.title).replace('{date}', c.date);
      if (c.kind === 'ROOM_CLASS' || c.kind === 'GROUP_CLASS') return t('ld.conf.' + c.kind).replace('{subject}', c.subject).replace('{group}', c.groupName).replace('{day}', dayName(c.dayOfWeek)).replace('{time}', c.startTime + '–' + c.endTime).replace('{room}', c.roomCode || '');
      return t('ld.conf.' + c.kind, c.kind) + (c.subject ? ': ' + c.subject + (c.groupName ? ' (' + c.groupName + ')' : '') + (c.startTime ? ' ' + c.startTime + '–' + c.endTime : '') : '');
    };
    const conflictList = (arr) => '<ul style="margin:6px 0 0 18px;font-size:13px">' + arr.map((c) => '<li>' + esc(conflictText(c)) + '</li>').join('') + '</ul>';

    // ═════════════════════════ DASHBOARD ═════════════════════════
    async function dashboard() {
      const root = $('lx-dashboard');
      root.innerHTML = '<div class="stat-grid">' + '<div class="skel" style="height:118px"></div>'.repeat(8) + '</div>';
      try {
        const d = await api().dashboard();
        const rq = d.requests.byStatus, pay = d.payments.byStatus;
        root.innerHTML =
          '<div class="stat-grid">' +
            stat('🎓', d.students.total, t('ld.students'), esc(t('ld.groups_n').replace('{n}', d.students.groups)), 'users') +
            stat('👨‍🏫', d.teachers.total, t('ld.teachers'), esc(t('ld.with_schedule').replace('{n}', d.teachers.withSchedule)), 'users') +
            stat('✅', d.attendance.rate30d != null ? d.attendance.rate30d + '%' : '—', t('ld.attendance_30d'), esc(t('ld.overall') + ': ' + (d.attendance.rateAll != null ? d.attendance.rateAll + '%' : '—')), 'kpi') +
            stat('⭐', d.academic.averageGrade ?? '—', t('ld.avg_grade'), esc(t('ld.grades_7d').replace('{n}', d.academic.grades7d)), 'kpi') +
            stat('📋', rq.PENDING || 0, t('ld.pending_requests'), d.requests.pendingOlderThan7d ? '<span class="badge badge-danger">' + esc(t('ld.older_7d').replace('{n}', d.requests.pendingOlderThan7d)) + '</span>' : '', 'requests') +
            stat('💳', azn(d.payments.overdue.amount), t('ld.overdue_payments'), esc(t('ld.invoices_n').replace('{n}', d.payments.overdue.count)), 'payments') +
            stat('📅', d.schedule.today, t('ld.classes_today'), d.schedule.conflicts ? '<span class="badge badge-danger">' + esc(t('ld.conflicts_n').replace('{n}', d.schedule.conflicts)) + '</span>' : esc(t('ld.no_conflicts')), 'schedule') +
            stat('📢', d.announcements.total, t('ld.announcements'), esc(t('ld.pinned_n').replace('{n}', d.announcements.pinned)), 'announcements') +
          '</div>' +
          '<div class="au-grid-3">' +
            '<div class="card"><div class="card-pad"><div class="card-title">' + esc(t('ld.academic_activity')) + '</div>' +
              kv(t('ld.grades_total'), d.academic.gradesTotal) + kv(t('ld.grades_week'), d.academic.grades7d) + kv(t('ld.submissions_week'), d.academic.submissions7d) + kv(t('ld.active_assignments'), d.academic.activeAssignments) + '</div></div>' +
            '<div class="card"><div class="card-pad"><div class="card-title">' + esc(t('ld.requests')) + '</div>' +
              ['PENDING', 'APPROVED', 'REJECTED'].map((s) => kv(t('requests.status.' + s.toLowerCase()), rq[s] || 0)).join('') + '</div></div>' +
            '<div class="card"><div class="card-pad"><div class="card-title">' + esc(t('ld.payments')) + '</div>' +
              ['PAID', 'PENDING', 'PROCESSING', 'FAILED'].filter((s) => pay[s]).map((s) => kv(t('ld.pay.' + s), pay[s].count + ' · ' + azn(pay[s].amount))).join('') + '</div></div>' +
          '</div>' +
          '<div class="au-grid-2">' +
            '<div class="card"><div class="card-pad"><div class="card-title">' + esc(t('ld.schedule')) + '</div>' +
              kv(t('ld.slots_total'), d.schedule.slots) + kv(t('ld.rooms'), d.schedule.rooms) + kv(t('ld.classes_today'), d.schedule.today) +
              kv(t('ld.conflicts'), d.schedule.conflicts ? '<span class="badge badge-danger">' + d.schedule.conflicts + '</span>' : '<span class="badge badge-success">0</span>', true) +
              kv(t('ld.users_by_role'), Object.entries(d.users.byRole).map(([r, n]) => esc(t('ld.role.' + r, r)) + ' ' + n).join(' · '), true) + '</div></div>' +
            '<div class="card"><div class="card-pad"><div class="card-title">' + esc(t('ld.latest_announcements')) + '</div>' +
              (d.announcements.recent.length ? d.announcements.recent.map((a) => '<div class="au-row"><div style="min-width:0"><div class="t">' + esc(a.title) + '</div><div class="s">' + esc(fmtDate(a.createdAt)) + ' · ' + esc(t('ld.aud.' + a.audience, a.audience)) + '</div></div><span class="badge badge-gray">' + esc(t('home.prio.' + a.priority, a.priority)) + '</span></div>').join('') : empty()) +
            '</div></div>' +
          '</div>';
        bindGo(root);
      } catch (e) { root.innerHTML = errBox(e, 'ld-r'); retry('ld-r', dashboard); }
    }
    const kv = (k, v, raw) => '<div class="au-kv"><span>' + esc(k) + '</span><b>' + (raw ? v : esc(v)) + '</b></div>';

    // ═════════════════════════ KPI ═════════════════════════
    let kpiWeeks = 12;
    async function kpi() {
      const root = $('lx-kpi');
      root.innerHTML = skel(4, 180);
      try {
        const k = await api().kpi(kpiWeeks);
        const wk = (w) => shortWeek(w, lang());
        const card = (title, body, note) => '<div class="card"><div class="card-pad"><div class="card-title">' + esc(title) + '</div>' + (note ? '<div class="au-muted" style="margin:-8px 0 10px">' + esc(note) + '</div>' : '') + body + '</div></div>';
        const att = k.attendanceTrend.length
          ? columns(k.attendanceTrend.map((r) => ({ label: wk(r.week), present: r.present, late: r.late, excused: r.excused, absent: r.absent, rate: r.rate })),
            [{ key: 'present', color: '#10b981', label: t('attendance.present') }, { key: 'late', color: '#f59e0b', label: t('attendance.late') }, { key: 'excused', color: '#3b82f6', label: t('attendance.excused') }, { key: 'absent', color: '#ef4444', label: t('attendance.absent') }],
            { valueFmt: (r) => (r.rate != null ? r.rate + '%' : ''), aria: t('ld.attendance_trend') })
          : empty();
        const acad = k.academicTrend.length ? hbars(k.academicTrend.map((r) => ({ label: r.period, value: r.average, color: r.average >= 75 ? '#10b981' : r.average >= 60 ? '#f59e0b' : '#ef4444', n: r.grades })), { max: 100, fmt: (i) => i.value }) : empty();
        const subs = k.submissionsTrend.length ? columns(k.submissionsTrend.map((r) => ({ label: wk(r.week), n: r.count })), [{ key: 'n', color: '#6366f1', label: t('ld.submissions') }], { aria: t('ld.submissions') }) : empty();
        const req = k.requestTrend.length ? columns(k.requestTrend.map((r) => ({ label: wk(r.week), pending: r.pending, approved: r.approved, rejected: r.rejected })),
          [{ key: 'approved', color: '#10b981', label: t('requests.status.approved') }, { key: 'pending', color: '#f59e0b', label: t('requests.status.pending') }, { key: 'rejected', color: '#ef4444', label: t('requests.status.rejected') }], { aria: t('ld.request_activity') }) : empty();
        const pay = k.paymentTrend.length ? columns(k.paymentTrend.map((r) => ({ label: wk(r.week), amount: r.amount, count: r.count })), [{ key: 'amount', color: '#0891b2', label: 'AZN' }], { valueFmt: (r) => (r.amount ? Math.round(r.amount / 100) / 10 + 'k' : ''), aria: t('ld.payment_activity') }) : empty();
        const enr = k.enrollment;
        root.innerHTML =
          '<div class="au-bar"><label class="fld"><span>' + esc(t('ld.period')) + '</span><select class="input" id="kpi-weeks">' + [8, 12, 26, 52].map((w) => '<option value="' + w + '"' + (w === kpiWeeks ? ' selected' : '') + '>' + esc(t('ld.last_weeks').replace('{n}', w)) + '</option>').join('') + '</select></label></div>' +
          '<div class="au-grid-2">' +
            card(t('ld.enrollment'), '<div class="au-muted" style="margin-bottom:6px">' + esc(t('ld.by_level')) + '</div>' + hbars(enr.byLevel.map((r) => ({ label: t('ld.level.' + r.level, r.level), value: r.count }))) +
              '<div class="au-muted" style="margin:10px 0 6px">' + esc(t('ld.by_course')) + '</div>' + hbars(enr.byCourse.map((r) => ({ label: t('ld.course_n').replace('{n}', r.course), value: r.count, color: '#6366f1' }))) +
              '<div class="au-muted" style="margin:10px 0 6px">' + esc(t('ld.by_group')) + '</div>' + hbars(enr.byGroup.map((r) => ({ label: r.groupName, value: r.count, color: '#0891b2' }))), t('ld.enrollment_note')) +
            card(t('ld.attendance_trend'), att, t('ld.attendance_trend_note')) +
          '</div>' +
          '<div class="au-grid-2">' +
            card(t('ld.academic_trend'), acad, t('ld.academic_trend_note')) +
            card(t('ld.submissions_trend'), subs) +
          '</div>' +
          '<div class="au-grid-2">' +
            card(t('ld.request_activity'), req + (k.requestByType.length ? '<div style="margin-top:12px">' + hbars(summ(k.requestByType, 'type').map((r) => ({ label: reqType(r.key), value: r.count, color: '#64748b' }))) + '</div>' : '')) +
            card(t('ld.payment_activity'), pay + (k.paymentByStatus.length ? '<div style="margin-top:12px">' + hbars(k.paymentByStatus.map((r) => ({ label: t('ld.pay.' + r.status, r.status), value: r.amount, count: r.count, color: r.status === 'PAID' ? '#10b981' : r.status === 'FAILED' ? '#ef4444' : '#f59e0b' })), { fmt: (i) => azn(i.value) }) + '</div>' : '')) +
          '</div>';
        $('kpi-weeks').addEventListener('change', (e) => { kpiWeeks = Number(e.target.value); kpi(); });
      } catch (e) { root.innerHTML = errBox(e, 'kpi-r'); retry('kpi-r', kpi); }
    }
    const summ = (rows, key) => { const m = new Map(); rows.forEach((r) => m.set(r[key], (m.get(r[key]) || 0) + r.count)); return Array.from(m, ([k, count]) => ({ key: k, count })); };

    // ═════════════════════════ USERS ═════════════════════════
    const U = { q: '', role: '', status: '', locked: false, items: [], next: null, total: 0, timer: null };
    async function users() {
      const root = $('lx-users');
      root.innerHTML =
        '<div class="au-bar">' +
          '<label class="fld grow"><span>' + esc(t('common.search')) + '</span><input class="input" type="search" id="u-q" value="' + esc(U.q) + '" placeholder="' + esc(t('ld.search_users')) + '"></label>' +
          '<label class="fld"><span>' + esc(t('common.role')) + '</span><select class="input" id="u-role"><option value="">' + esc(t('common.all')) + '</option>' + ['STUDENT', 'TEACHER', 'ADMIN', 'SUPER_ADMIN'].map((r) => '<option value="' + r + '"' + (U.role === r ? ' selected' : '') + '>' + esc(t('ld.role.' + r)) + '</option>').join('') + '</select></label>' +
          '<label class="fld"><span>' + esc(t('common.status')) + '</span><select class="input" id="u-status"><option value="">' + esc(t('ld.not_deleted')) + '</option>' + ['ACTIVE', 'SUSPENDED', 'DELETED'].map((s) => '<option value="' + s + '"' + (U.status === s ? ' selected' : '') + '>' + esc(t('ld.ustatus.' + s)) + '</option>').join('') + '</select></label>' +
          '<label style="display:flex;gap:6px;align-items:center;font-size:13px;padding-bottom:8px"><input type="checkbox" id="u-locked"' + (U.locked ? ' checked' : '') + '> ' + esc(t('ld.only_locked')) + '</label>' +
        '</div>' +
        '<div class="card" style="overflow:hidden"><div class="au-table"><table><thead><tr><th>Login ID</th><th>' + esc(t('common.name')) + '</th><th>' + esc(t('common.role')) + '</th><th>' + esc(t('ld.details')) + '</th><th>' + esc(t('common.status')) + '</th><th>' + esc(t('ld.last_login')) + '</th></tr></thead><tbody id="u-body"></tbody></table></div><div id="u-foot"></div></div>';
      const reload = () => loadUsers(true);
      $('u-q').addEventListener('input', (e) => { U.q = e.target.value.trim(); clearTimeout(U.timer); U.timer = setTimeout(reload, 300); });
      $('u-role').addEventListener('change', (e) => { U.role = e.target.value; reload(); });
      $('u-status').addEventListener('change', (e) => { U.status = e.target.value; reload(); });
      $('u-locked').addEventListener('change', (e) => { U.locked = e.target.checked; reload(); });
      await loadUsers(true);
    }
    async function loadUsers(reset) {
      const body = $('u-body'), foot = $('u-foot');
      if (reset) { U.items = []; U.next = null; body.innerHTML = '<tr><td colspan="6">' + skel(4) + '</td></tr>'; }
      try {
        const r = await api().users({ search: U.q, role: U.role, status: U.status, locked: U.locked ? 'true' : '', take: 50, cursor: reset ? '' : U.next });
        U.items = U.items.concat(r.items); U.next = r.nextCursor; U.total = r.total;
        body.innerHTML = U.items.length ? U.items.map((u) => '<tr class="clickable" data-uid="' + esc(u.id) + '" tabindex="0">' +
          '<td><code>' + esc(u.loginId) + '</code></td><td><b>' + esc(u.fullName) + '</b><div class="au-muted">' + esc(u.email) + '</div></td><td>' + roleBadge(u.role) + '</td>' +
          '<td class="au-muted">' + esc(u.student ? u.student.groupName + ' · ' + t('ld.course_n').replace('{n}', u.student.course) : u.teacher ? u.teacher.title + ' · ' + u.teacher.department : '—') + '</td>' +
          '<td>' + statusBadge(u.status) + (u.locked ? ' <span class="badge badge-danger">🔒 ' + esc(t('ld.locked')) + '</span>' : '') + '</td>' +
          '<td class="au-muted">' + (u.lastLoginAt ? esc(fmtDT(u.lastLoginAt)) : '—') + '</td></tr>').join('') : '<tr><td colspan="6">' + empty(t('ld.no_users')) + '</td></tr>';
        foot.innerHTML = '<div class="pager"><span>' + esc(t('ld.shown_of').replace('{n}', U.items.length).replace('{total}', U.total)) + '</span>' + (U.next ? '<button class="btn btn-outline btn-sm" id="u-more">' + esc(t('ld.load_more')) + '</button>' : '') + '</div>';
        retry('u-more', () => loadUsers(false));
        body.querySelectorAll('[data-uid]').forEach((tr) => {
          const open = () => openUser(tr.dataset.uid);
          tr.addEventListener('click', open);
          tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
        });
      } catch (e) { body.innerHTML = '<tr><td colspan="6">' + errBox(e, 'u-r') + '</td></tr>'; retry('u-r', () => loadUsers(true)); }
    }
    async function openUser(id) {
      const m = openModal({ title: t('ld.profile'), wide: true, html: skel(4), buttons: [{ label: t('common.close') }] });
      try {
        const u = await api().user(id);
        const ss = u.studentStats, ts = u.teacherStats;
        m.body.innerHTML =
          '<div style="display:flex;gap:14px;align-items:center;margin-bottom:14px;flex-wrap:wrap"><div style="width:56px;height:56px;border-radius:50%;background:#1e3a5f;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:20px">' +
            esc(u.fullName.split(' ').slice(0, 2).map((s) => s[0]).join('')) + '</div><div><div style="font-size:18px;font-weight:700">' + esc(u.fullName) + '</div><div style="margin-top:4px">' + roleBadge(u.role) + ' ' + statusBadge(u.status) + (u.locked ? ' <span class="badge badge-danger">🔒 ' + esc(t('ld.locked')) + '</span>' : '') + '</div></div></div>' +
          '<div class="au-grid-2" style="margin-bottom:0"><div>' +
            kv('Login ID', u.loginId) + kv('Email', u.email) + kv(t('common.phone'), u.phone || '—') + kv(t('ld.language'), (u.preferredLang || '').toUpperCase()) +
            kv(t('ld.registered'), fmtDate(u.createdAt)) + kv(t('ld.last_login'), u.lastLoginAt ? fmtDT(u.lastLoginAt) : '—') +
          '</div><div>' +
            (u.student ? kv(t('ld.group'), u.student.groupName) + kv(t('ld.faculty'), u.student.faculty) + kv(t('ld.specialty'), u.student.specialty) + kv(t('ld.course_sem'), u.student.course + ' / ' + u.student.semester) + kv(t('ld.level_l'), t('ld.level.' + u.student.level, u.student.level)) : '') +
            (ss ? kv(t('ld.avg_grade'), ss.averageGrade ?? '—') + kv(t('ld.attendance'), ss.attendanceRate != null ? ss.attendanceRate + '%' : '—') + kv(t('ld.debt'), azn(ss.debtAzn)) : '') +
            (u.teacher ? kv(t('ld.department'), u.teacher.department) + kv(t('ld.title_l'), u.teacher.title) + kv(t('ld.experience'), u.teacher.experience) : '') +
            (ts ? kv(t('ld.subjects'), ts.subjects.join(', ') || '—') + kv(t('ld.groups'), ts.groups.join(', ') || '—') + kv(t('ld.slots_week'), ts.slots) : '') +
            kv(t('ld.logins_30d'), u.activity.logins30d) + kv(t('ld.failed_30d'), u.activity.failedLogins30d) +
          '</div></div>' +
          (u.recentRequests.length ? '<div class="card-title" style="margin-top:14px">' + esc(t('ld.recent_requests')) + '</div>' + u.recentRequests.map((r) => '<div class="au-row"><span>' + esc(reqType(r.type)) + ' · ' + esc(fmtDate(r.createdAt)) + '</span>' + reqBadge(r.status) + '</div>').join('') : '') +
          '<div class="au-note" style="margin-top:14px">' + esc(t('ld.profile_readonly')) + '</div>';
      } catch (e) { m.body.innerHTML = errBox(e); }
    }

    // ═════════════════════════ REQUESTS ═════════════════════════
    const R = { scope: 'admin', status: 'PENDING', type: '' };
    async function requests() {
      const root = $('lx-requests');
      const TABS = [['ALL', t('ap.tab_all')], ['APPEALS', t('ap.tab_appeals')], ['CERTIFICATE', t('ap.tab_certificates')], ['OTHER', t('ap.tab_other')]];
      const tabs = '<div class="ex-tabs" role="tablist">' + TABS.map(([k, l]) => '<button class="ex-tab' + ((R.tab || 'ALL') === k ? ' on' : '') + '" data-rtab="' + k + '">' + esc(l) + '</button>').join('') + '</div>';
      const bindTabs = () => root.querySelectorAll('[data-rtab]').forEach((b) => b.addEventListener('click', () => { R.tab = b.dataset.rtab; R.type = R.tab === 'CERTIFICATE' ? 'CERTIFICATE' : R.tab === 'OTHER' ? 'OTHER' : ''; requests(); }));
      if (R.tab === 'APPEALS') { root.innerHTML = tabs + '<div id="lx-appeals"></div>'; bindTabs(); return AP.appeals.staffPanel($('lx-appeals'), 'admin'); }
      root.innerHTML = tabs +
        '<div class="au-note">' + esc(t('ld.requests_scope')) + '</div>' +
        '<div class="au-bar">' +
          '<label class="fld"><span>' + esc(t('ld.scope')) + '</span><select class="input" id="r-scope"><option value="admin"' + (R.scope === 'admin' ? ' selected' : '') + '>' + esc(t('ld.scope_admin')) + '</option><option value="all"' + (R.scope === 'all' ? ' selected' : '') + '>' + esc(t('ld.scope_all')) + '</option></select></label>' +
          '<label class="fld"><span>' + esc(t('common.status')) + '</span><select class="input" id="r-status"><option value="">' + esc(t('common.all')) + '</option>' + ['PENDING', 'UNDER_REVIEW', 'APPROVED', 'PARTIALLY_APPROVED', 'REJECTED', 'WITHDRAWN'].map((s) => '<option value="' + s + '"' + (R.status === s ? ' selected' : '') + '>' + esc(t('requests.status.' + s.toLowerCase())) + '</option>').join('') + '</select></label>' +
          '<label class="fld"><span>' + esc(t('requests.type')) + '</span><select class="input" id="r-type"><option value="">' + esc(t('common.all')) + '</option>' + ['CERTIFICATE', 'TRANSFER', 'OTHER', 'APPEAL'].map((s) => '<option value="' + s + '"' + (R.type === s ? ' selected' : '') + '>' + esc(reqType(s)) + '</option>').join('') + '</select></label>' +
        '</div><div id="r-box">' + skel(4) + '</div>';
      bindTabs();
      $('r-scope').addEventListener('change', (e) => { R.scope = e.target.value; loadRequests(); });
      $('r-status').addEventListener('change', (e) => { R.status = e.target.value; loadRequests(); });
      $('r-type').addEventListener('change', (e) => { R.type = e.target.value; loadRequests(); });
      await loadRequests();
    }
    async function loadRequests() {
      const box = $('r-box');
      box.innerHTML = skel(4);
      try {
        const items = await api().requests({ scope: R.scope, status: R.status, type: R.type });
        box.innerHTML = '<div class="card" style="overflow:hidden">' + (items.length ? '<div class="au-table"><table><thead><tr><th>' + esc(t('requests.student')) + '</th><th>' + esc(t('requests.type')) + '</th><th>' + esc(t('requests.description')) + '</th><th>' + esc(t('common.status')) + '</th><th>' + esc(t('ld.created')) + '</th><th></th></tr></thead><tbody>' +
          items.map((r) => '<tr><td><b>' + esc(r.user.fullName) + '</b><div class="au-muted">' + esc(r.user.loginId) + (r.user.student ? ' · ' + esc(r.user.student.groupName) : '') + '</div></td>' +
            '<td><span class="badge badge-gray">' + esc(reqType(r.type)) + '</span></td>' +
            '<td style="white-space:normal;max-width:320px" class="au-muted">' + esc(r.description) + (r.adminNote ? '<div><i>↪ ' + esc(r.adminNote) + '</i></div>' : '') + '</td>' +
            '<td>' + reqBadge(r.status) + '</td><td class="au-muted">' + esc(fmtDate(r.createdAt)) + (r.updatedAt !== r.createdAt ? '<div>' + esc(t('ld.updated')) + ': ' + esc(fmtDate(r.updatedAt)) + '</div>' : '') + '</td>' +
            '<td>' + (r.isExamAppeal ? '<button class="btn btn-outline btn-sm" data-appeal="' + esc(r.id) + '">' + esc(t('ap.details')) + '</button>' : r.editable && r.allowedStatuses.length ? '<button class="btn btn-outline btn-sm" data-rid="' + esc(r.id) + '">' + esc(t('ld.decide')) + '</button>' : '<span class="au-muted">' + esc(r.editable ? '—' : t('ld.teacher_handles')) + '</span>') + '</td></tr>').join('') +
          '</tbody></table></div>' : empty(t('ld.no_requests'))) + '</div>';
        box.querySelectorAll('[data-rid]').forEach((b) => b.addEventListener('click', () => openDecision(items.find((x) => x.id === b.dataset.rid))));
        box.querySelectorAll('[data-appeal]').forEach((b) => b.addEventListener('click', () => AP.appeals.staffDetail('admin', b.dataset.appeal, loadRequests)));
      } catch (e) { box.innerHTML = errBox(e, 'r-r'); retry('r-r', loadRequests); }
    }
    function openDecision(r) {
      openModal({
        title: t('ld.decision') + ' · ' + reqType(r.type), static: true,
        html: '<div class="au-note"><b>' + esc(r.user.fullName) + '</b> <code>' + esc(r.user.loginId) + '</code><div style="white-space:pre-wrap;margin-top:4px">' + esc(r.description) + '</div></div>' +
          '<div class="form-group"><div class="form-label">' + esc(t('ld.new_status')) + '</div><select class="input" id="d-st">' + r.allowedStatuses.map((s) => '<option value="' + s + '">' + esc(t('requests.status.' + s.toLowerCase())) + '</option>').join('') + '</select></div>' +
          '<div class="form-group"><div class="form-label">' + esc(t('requests.note')) + '</div><textarea class="input" id="d-note" maxlength="500">' + esc(r.adminNote || '') + '</textarea></div><div class="au-err" id="d-err" role="alert"></div>',
        buttons: [{ label: t('common.cancel') }, { label: t('common.save'), cls: 'btn-primary', onClick: async (h) => {
          const st = h.$('#d-st').value;
          if (!(await confirmDialog({ message: t('ld.confirm_status').replace('{from}', t('requests.status.' + r.status.toLowerCase())).replace('{to}', t('requests.status.' + st.toLowerCase())).replace('{name}', r.user.fullName) }))) return false;
          try { await api().updateRequest(r.id, { status: st, adminNote: h.$('#d-note').value.trim() || undefined }); toast(t('ld.saved')); await loadRequests(); }
          catch (e) { h.$('#d-err').textContent = errMsg(e); return false; }
        } }],
      });
    }

    // ═════════════════════════ SCHEDULE ═════════════════════════
    const S = { group: '', teacher: '', room: '', day: '', refs: null };
    async function refs() {
      if (!S.refs) {
        const [groups, teachers, rooms, subjects] = await Promise.all([api().groups(), api().teachers(), api().rooms(), api().subjects()]);
        S.refs = { groups, teachers, rooms, subjects };
      }
      return S.refs;
    }
    const sel = (id, label, opts, cur) => '<label class="fld"><span>' + esc(label) + '</span><select class="input" id="' + id + '">' + opts.map(([v, l]) => '<option value="' + esc(v) + '"' + (String(cur) === String(v) ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></label>';
    const fsel = (id, label, opts, cur) => '<div class="form-group"><div class="form-label">' + esc(label) + '</div><select class="input" id="' + id + '">' + opts.map(([v, l]) => '<option value="' + esc(v) + '"' + (String(cur) === String(v) ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></div>';

    // ═════════════════════════ CALENDAR ═════════════════════════
    const C = { month: new Date().toISOString().slice(0, 7), type: '' };
    const EVT = ['HOLIDAY', 'MOURNING', 'EXAM', 'LECTURE_CANCELLED', 'ACADEMIC', 'OTHER'];
    const evBadge = (x) => '<span class="badge ' + ({ HOLIDAY: 'badge-success', MOURNING: 'badge-gray', EXAM: 'badge-danger', LECTURE_CANCELLED: 'badge-warning', ACADEMIC: 'badge-info', OTHER: 'badge-purple' }[x] || 'badge-gray') + '">' + esc(t('ld.evt.' + x, x)) + '</span>';
    async function calendar() {
      const root = $('lx-calendar');
      root.innerHTML =
        '<div class="au-bar"><label class="fld"><span>' + esc(t('ld.month')) + '</span><input class="input" type="month" id="c-month" value="' + esc(C.month) + '"></label>' +
          '<label class="fld"><span>' + esc(t('ld.type')) + '</span><select class="input" id="c-type"><option value="">' + esc(t('common.all')) + '</option>' + EVT.map((x) => '<option value="' + x + '"' + (C.type === x ? ' selected' : '') + '>' + esc(t('ld.evt.' + x)) + '</option>').join('') + '</select></label>' +
          '<button class="btn btn-outline" id="c-all">' + esc(t('ld.all_dates')) + '</button><div style="flex:1"></div><button class="btn btn-success" id="c-add">+ ' + esc(t('ld.add_event')) + '</button></div><div id="c-box">' + skel(4) + '</div>';
      $('c-month').addEventListener('change', (e) => { C.month = e.target.value; loadEvents(); });
      $('c-type').addEventListener('change', (e) => { C.type = e.target.value; loadEvents(); });
      $('c-all').addEventListener('click', () => { C.month = ''; $('c-month').value = ''; loadEvents(); });
      $('c-add').addEventListener('click', () => openEvent());
      await loadEvents();
    }
    async function loadEvents() {
      const box = $('c-box');
      box.innerHTML = skel(4);
      try {
        let params = {};
        if (C.month) {
          const [y, m] = C.month.split('-').map(Number);
          params = { from: new Date(Date.UTC(y, m - 1, 1)).toISOString(), to: new Date(Date.UTC(y, m, 0, 23, 59, 59)).toISOString() };
        }
        const items = (await api().calendar(params)).filter((e) => !C.type || e.type === C.type);
        box.innerHTML = '<div class="card" style="overflow:hidden">' + (items.length ? '<div class="au-table"><table><thead><tr><th>' + esc(t('ld.date')) + '</th><th>' + esc(t('ld.type')) + '</th><th>' + esc(t('ld.title')) + '</th><th>' + esc(t('ld.time')) + '</th><th>' + esc(t('ld.room')) + '</th><th>' + esc(t('ld.scope_l')) + '</th><th></th></tr></thead><tbody>' +
          items.map((e) => '<tr><td>' + esc(fmtDate(e.eventDate)) + (e.endDate ? ' – ' + esc(fmtDate(e.endDate)) : '') + '</td><td>' + evBadge(e.type) + '</td>' +
            '<td><b>' + esc(e.title) + '</b>' + (e.description ? '<div class="au-muted">' + esc(e.description.slice(0, 100)) + '</div>' : '') + '</td>' +
            '<td class="au-muted">' + esc(e.startTime ? e.startTime + '–' + e.endTime : t('ld.all_day')) + '</td><td>' + esc(e.roomCode || '—') + '</td>' +
            '<td class="au-muted">' + esc(e.groupName || t('ld.everyone')) + '</td>' +
            '<td style="white-space:nowrap"><button class="btn btn-outline btn-sm" data-edit="' + esc(e.id) + '">' + esc(t('common.edit')) + '</button> <button class="btn btn-danger btn-sm" data-del="' + esc(e.id) + '" aria-label="' + esc(t('common.delete')) + '">✕</button></td></tr>').join('') +
          '</tbody></table></div>' : empty(t('ld.no_events'))) + '</div>';
        box.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openEvent(items.find((x) => x.id === b.dataset.edit))));
        box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
          const ev = items.find((x) => x.id === b.dataset.del);
          if (!(await confirmDialog({ danger: true, confirmLabel: t('common.delete'), message: t('ld.confirm_delete_event').replace('{title}', ev.title) }))) return;
          try { await api().deleteEvent(ev.id); toast(t('ld.deleted')); await loadEvents(); } catch (e) { toast(errMsg(e), true); }
        }));
      } catch (e) { box.innerHTML = errBox(e, 'c-r'); retry('c-r', loadEvents); }
    }
    async function openEvent(ev) {
      const r = await refs();
      const d10 = (iso) => (iso ? String(iso).slice(0, 10) : '');
      const m = openModal({
        title: ev ? t('ld.edit_event') : t('ld.add_event'), wide: true, static: true,
        html: '<div class="form-grid">' +
          '<div class="form-group" style="grid-column:1/-1"><div class="form-label">' + esc(t('ld.title')) + '</div><input class="input" id="e-title" maxlength="200" value="' + esc(ev ? ev.title : '') + '"></div>' +
          fsel('e-type', t('ld.type'), EVT.map((x) => [x, t('ld.evt.' + x)]), ev ? ev.type : 'ACADEMIC') +
          '<div class="form-group"><div class="form-label">' + esc(t('ld.date')) + '</div><input class="input" type="date" id="e-date" value="' + esc(d10(ev && ev.eventDate)) + '"></div>' +
          '<div class="form-group"><div class="form-label">' + esc(t('ld.end_date')) + '</div><input class="input" type="date" id="e-end" value="' + esc(d10(ev && ev.endDate)) + '"></div>' +
          '<div class="form-group"><div class="form-label">' + esc(t('ld.start')) + '</div><input class="input" type="time" id="e-st" value="' + esc(ev && ev.startTime || '') + '"></div>' +
          '<div class="form-group"><div class="form-label">' + esc(t('ld.end')) + '</div><input class="input" type="time" id="e-et" value="' + esc(ev && ev.endTime || '') + '"></div>' +
          fsel('e-room', t('ld.room'), [['', '—']].concat(r.rooms.map((x) => [x.code, x.code + ' · ' + x.capacity])), ev ? ev.roomCode || '' : '') +
          fsel('e-group', t('ld.scope_l'), [['', t('ld.everyone')]].concat(r.groups.map((g) => [g.groupName, g.groupName])), ev ? ev.groupName || '' : '') +
          '<div class="form-group" style="grid-column:1/-1"><div class="form-label">' + esc(t('ld.description')) + '</div><textarea class="input" id="e-desc" maxlength="2000">' + esc(ev ? ev.description || '' : '') + '</textarea></div>' +
          '</div><label id="e-allow-wrap" style="display:none;gap:8px;align-items:center;font-size:13px;margin-top:4px"><input type="checkbox" id="e-allow"> ' + esc(t('ld.allow_class_overlap')) + '</label>' +
          '<div id="e-check" style="margin-top:10px"></div><div class="au-err" id="e-err" role="alert"></div>',
        buttons: [
          { label: t('common.cancel') },
          { id: 'check', label: t('ld.check_conflicts'), cls: 'btn-outline', keep: true, onClick: async (h) => { await runCheck(h); return false; } },
          { label: t('common.save'), cls: 'btn-primary', onClick: async (h) => {
            const dto = collect(h);
            if (!dto) return false;
            try {
              const res = ev ? await api().updateEvent(ev.id, dto) : await api().createEvent(dto);
              toast(res.warnings && res.warnings.length ? t('ld.saved_with_warnings').replace('{n}', res.warnings.length) : t('ld.saved'));
              await loadEvents();
            } catch (e) {
              const c = e.body && e.body.conflicts;
              h.$('#e-err').innerHTML = (c ? '<b>' + esc(t('ld.conflicts')) + ':</b>' + conflictList(c) : esc(errMsg(e)));
              if (c && c.every((x) => x.kind === 'ROOM_CLASS')) h.$('#e-allow-wrap').style.display = 'flex';
              return false;
            }
          } },
        ],
      });
      function collect(h) {
        h.$('#e-err').textContent = '';
        const title = h.$('#e-title').value.trim(), date = h.$('#e-date').value, end = h.$('#e-end').value, st = h.$('#e-st').value, et = h.$('#e-et').value;
        if (!title) { h.$('#e-err').textContent = t('ld.err.title'); return null; }
        if (!date) { h.$('#e-err').textContent = t('ld.err.date'); return null; }
        if (end && end < date) { h.$('#e-err').textContent = t('ld.err.end_date'); return null; }
        if ((st && !et) || (!st && et) || (st && et && st >= et)) { h.$('#e-err').textContent = t('ld.err.time'); return null; }
        const dto = {
          title, type: h.$('#e-type').value, eventDate: new Date(date + 'T00:00:00Z').toISOString(),
          endDate: end ? new Date(end + 'T00:00:00Z').toISOString() : null,
          startTime: st || null, endTime: et || null, roomCode: h.$('#e-room').value || null, groupName: h.$('#e-group').value || null,
          description: h.$('#e-desc').value.trim() || null,
        };
        if (h.$('#e-allow').checked) dto.allowScheduleOverlap = true;
        return dto;
      }
      async function runCheck(h) {
        const dto = collect(h); if (!dto) return;
        delete dto.allowScheduleOverlap;
        if (ev) dto.excludeId = ev.id;
        try {
          const c = await api().checkEvent(dto);
          const box = h.$('#e-check');
          if (!c.blocking.length && !c.warnings.length) { box.innerHTML = '<div class="au-note">✓ ' + esc(t('ld.no_conflicts')) + '</div>'; return; }
          box.innerHTML = (c.blocking.length ? '<div class="au-note" style="border-color:#ef4444"><b>' + esc(t('ld.blocking')) + '</b>' + conflictList(c.blocking) + '</div>' : '') +
            (c.warnings.length ? '<div class="au-note" style="border-color:#f59e0b"><b>' + esc(t('ld.warnings')) + '</b>' + conflictList(c.warnings) + '</div>' : '');
          if (c.blocking.length && c.blocking.every((x) => x.kind === 'ROOM_CLASS')) h.$('#e-allow-wrap').style.display = 'flex';
        } catch (e) { h.$('#e-err').textContent = errMsg(e); }
      }
      return m;
    }

    // ═════════════════════════ PAYMENTS ═════════════════════════
    const P = { status: '', type: '' };
    async function payments() {
      const root = $('lx-payments');
      root.innerHTML = skel(4, 90);
      try {
        const [ov, list] = await Promise.all([api().paymentsOverview(), api().payments({ status: P.status, type: P.type })]);
        const s = ov.summary;
        root.innerHTML =
          '<div class="au-note">' + esc(t('ld.payments_demo')) + '</div>' +
          '<div class="stat-grid">' + stat('💰', azn(s.paidAzn), t('ld.collected')) + stat('⏰', azn(s.debtAzn), t('ld.outstanding')) + stat('👥', s.debtorsCount, t('ld.debtors')) + stat('🧾', s.totalCount, t('ld.invoices')) + '</div>' +
          '<div class="au-grid-2"><div class="card"><div class="card-pad"><div class="card-title">' + esc(t('ld.debt_by_group')) + '</div>' +
            (ov.byGroup.length ? hbars(ov.byGroup.map((g) => ({ label: g.groupName, value: g.debt, color: '#ef4444' })), { fmt: (i) => azn(i.value) }) : empty()) + '</div></div>' +
            '<div class="card"><div class="card-pad"><div class="card-title">' + esc(t('ld.top_debtors')) + '</div>' +
            (ov.topDebtors.length ? ov.topDebtors.slice(0, 6).map((d) => '<div class="au-row"><div><div class="t">' + esc(d.fullName) + '</div><div class="s">' + esc(d.loginId + ' · ' + d.groupName) + '</div></div><b>' + esc(azn(d.debtAzn)) + '</b></div>').join('') : empty()) + '</div></div></div>' +
          '<div class="au-bar">' + sel('p-status', t('common.status'), [['', t('common.all')]].concat(['PAID', 'PENDING', 'PROCESSING', 'FAILED', 'REFUNDED'].map((x) => [x, t('ld.pay.' + x)])), P.status) +
            sel('p-type', t('ld.type'), [['', t('common.all')]].concat(['TUITION', 'RETAKE', 'LIBRARY', 'DORM', 'ALT_GROUP', 'OTHER'].map((x) => [x, t('ld.ptype.' + x, x)])), P.type) + '</div>' +
          '<div class="card" style="overflow:hidden">' + (list.items.length ? '<div class="au-table"><table><thead><tr><th>' + esc(t('requests.student')) + '</th><th>№</th><th>' + esc(t('ld.type')) + '</th><th>' + esc(t('ld.amount')) + '</th><th>' + esc(t('common.status')) + '</th><th>' + esc(t('ld.due_paid')) + '</th></tr></thead><tbody>' +
            list.items.map((p) => '<tr><td><b>' + esc(p.student.fullName) + '</b><div class="au-muted">' + esc(p.student.loginId + ' · ' + (p.student.groupName || '')) + '</div></td><td><code style="font-size:11px">' + esc(p.invoiceNumber) + '</code></td>' +
              '<td>' + esc(t('ld.ptype.' + p.type, p.type)) + '<div class="au-muted">' + esc(p.description) + '</div></td><td><b>' + esc(Number(p.amount).toFixed(2) + ' ' + p.currency) + '</b></td><td>' + payBadge(p.status) + '</td>' +
              '<td class="au-muted">' + esc(p.paidAt ? '✓ ' + fmtDate(p.paidAt) : fmtDate(p.dueDate)) + (p.status !== 'PAID' && new Date(p.dueDate) < new Date() ? ' <span class="badge badge-danger">' + esc(t('ld.overdue')) + '</span>' : '') + '</td></tr>').join('') +
            '</tbody></table></div>' : empty(t('ld.no_payments'))) + '</div>';
        $('p-status').addEventListener('change', (e) => { P.status = e.target.value; payments(); });
        $('p-type').addEventListener('change', (e) => { P.type = e.target.value; payments(); });
      } catch (e) { root.innerHTML = errBox(e, 'p-r'); retry('p-r', payments); }
    }

    // ═════════════════════════ ANNOUNCEMENTS ═════════════════════════
    async function announcements() {
      const root = $('lx-announcements');
      root.innerHTML = skel(3, 90);
      try {
        const items = await api().announcements();
        root.innerHTML = '<div class="au-bar"><div style="flex:1"></div><button class="btn btn-primary" id="an-add">+ ' + esc(t('ld.new_announcement')) + '</button></div>' +
          (items.length ? items.map((a) => '<div class="card" style="margin-bottom:12px"><div class="card-pad"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><div style="font-weight:700;font-size:15px">' + (a.pinned ? '📌 ' : '') + esc(a.title) + '</div>' +
            '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"><span class="badge badge-gray">' + esc(t('home.prio.' + a.priority, a.priority)) + '</span><span class="badge badge-info">' + esc(t('ld.aud.' + a.audience, a.audience)) + (a.groupName ? ' · ' + esc(a.groupName) : '') + '</span>' +
            '<button class="btn btn-outline btn-sm" data-edit="' + esc(a.id) + '">' + esc(t('common.edit')) + '</button><button class="btn btn-danger btn-sm" data-del="' + esc(a.id) + '" aria-label="' + esc(t('common.delete')) + '">✕</button></div></div>' +
            '<div class="au-muted" style="white-space:pre-wrap;margin-top:8px;font-size:13px">' + esc(a.body) + '</div><div class="au-muted" style="margin-top:6px;font-size:11px">' + esc(fmtDT(a.createdAt)) + '</div></div></div>').join('') : '<div class="card">' + empty(t('ld.no_announcements')) + '</div>');
        $('an-add').addEventListener('click', () => openAnn());
        root.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openAnn(items.find((x) => x.id === b.dataset.edit))));
        root.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
          const a = items.find((x) => x.id === b.dataset.del);
          if (!(await confirmDialog({ danger: true, confirmLabel: t('common.delete'), message: t('ld.confirm_delete_ann').replace('{title}', a.title) }))) return;
          try { await api().deleteAnnouncement(a.id); toast(t('ld.deleted')); await announcements(); } catch (e) { toast(errMsg(e), true); }
        }));
      } catch (e) { root.innerHTML = errBox(e, 'an-r'); retry('an-r', announcements); }
    }
    async function openAnn(a) {
      const r = await refs();
      openModal({
        title: a ? t('ld.edit_announcement') : t('ld.new_announcement'), static: true,
        html: '<div class="form-group"><div class="form-label">' + esc(t('ld.title')) + '</div><input class="input" id="a-title" maxlength="200" value="' + esc(a ? a.title : '') + '"></div>' +
          '<div class="form-group"><div class="form-label">' + esc(t('ld.text')) + '</div><textarea class="input" id="a-body" maxlength="5000">' + esc(a ? a.body : '') + '</textarea></div>' +
          '<div class="form-grid">' + fsel('a-aud', t('ld.audience'), ['ALL', 'STUDENTS', 'TEACHERS', 'ADMINS', 'GROUP'].map((x) => [x, t('ld.aud.' + x)]), a ? a.audience : 'ALL') +
          fsel('a-prio', t('ld.priority'), ['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((x) => [x, t('home.prio.' + x)]), a ? a.priority : 'NORMAL') +
          fsel('a-group', t('ld.group'), [['', '—']].concat(r.groups.map((g) => [g.groupName, g.groupName])), a ? a.groupName || '' : '') + '</div>' +
          '<label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" id="a-pin"' + (a && a.pinned ? ' checked' : '') + '> 📌 ' + esc(t('ld.pin')) + '</label><div class="au-err" id="a-err" role="alert"></div>',
        buttons: [{ label: t('common.cancel') }, { label: t('common.save'), cls: 'btn-primary', onClick: async (h) => {
          const dto = { title: h.$('#a-title').value.trim(), body: h.$('#a-body').value.trim(), audience: h.$('#a-aud').value, priority: h.$('#a-prio').value, pinned: h.$('#a-pin').checked, groupName: h.$('#a-group').value || undefined };
          if (!dto.title || dto.body.length < 2) { h.$('#a-err').textContent = t('ld.err.title'); return false; }
          if (dto.audience === 'GROUP' && !dto.groupName) { h.$('#a-err').textContent = t('ld.err.group'); return false; }
          if (!a && !(await confirmDialog({ message: t('ld.confirm_publish_ann') }))) return false;
          try { if (a) await api().updateAnnouncement(a.id, dto); else await api().createAnnouncement(dto); toast(t('ld.saved')); await announcements(); }
          catch (e) { h.$('#a-err').textContent = errMsg(e); return false; }
        } }],
      });
    }

    return { dashboard, kpi, users, requests, calendar, payments, announcements };
  }

  AP.leadershipUI = { create };
})(window);
