// ============================================================
// IT Auditor workspace: overview, anomalies, audit log, login activity,
// configuration (read-only), dependencies.
// Аудитор НЕ может менять конфигурацию безопасности — такого API нет.
// Единственное действие записи — статус разбора аномалии.
// ============================================================
(function (global) {
  'use strict';
  const AP = (global.AP = global.AP || {});

  function create(ctx) {
    const { t, esc, openModal, confirmDialog } = AP.tui;
    const { columns, hbars } = AP.charts;
    const { toast } = ctx;
    const api = () => AP.api.security;
    const $ = (id) => document.getElementById(id);
    const lang = () => AP.i18n.getLang();
    const loc = () => (lang() === 'en' ? 'en-GB' : lang() === 'ru' ? 'ru-RU' : 'az-AZ');
    const fmtDT = (iso) => { try { return new Date(iso).toLocaleString(loc()); } catch { return iso; } };
    const errMsg = (e) => (e && e.message) || t('common.error');
    const skel = (n, h) => Array.from({ length: n || 3 }, () => '<div class="skel" style="height:' + (h || 40) + 'px;margin:10px 0"></div>').join('');
    const empty = (msg) => '<div class="empty">' + esc(msg || t('au.no_data')) + '</div>';
    const errBox = (e, id) => '<div class="empty au-err">' + esc(errMsg(e)) + (id ? '<div style="margin-top:10px"><button class="btn btn-outline btn-sm" id="' + id + '">' + esc(t('notif.retry')) + '</button></div>' : '') + '</div>';
    const retry = (id, fn) => { const b = $(id); if (b) b.addEventListener('click', fn); };
    const sev = (s) => '<span class="badge sev-' + esc(s) + '">' + esc(t('au.sev.' + s, s)) + '</span>';
    const stBadge = (s) => '<span class="badge ' + ({ OPEN: 'badge-danger', ACKNOWLEDGED: 'badge-warn', RESOLVED: 'badge-ok', FALSE_POSITIVE: 'badge-gray' }[s] || 'badge-gray') + '">' + esc(t('au.fstatus.' + s, s)) + '</span>';
    const stat = (val, label, tone, go) => {
      const color = tone === 'danger' ? '#f87171' : tone === 'warn' ? '#fbbf24' : tone === 'ok' ? '#34d399' : '';
      return '<div class="stat-card' + (go ? ' clickable' : '') + '"' + (go ? ' data-go="' + go + '" role="button" tabindex="0"' : '') + '><div class="stat-val"' + (color ? ' style="color:' + color + '"' : '') + '>' + esc(val) + '</div><div class="stat-label">' + esc(label) + '</div></div>';
    };
    const who = (a) => (a ? '<b>' + esc(a.fullName) + '</b> <span class="au-muted">· ' + esc(a.loginId) + '</span>' : '<span class="badge badge-gray">' + esc(t('au.system')) + '</span>');
    const reasonLabel = (r) => t('au.reason.' + (r || 'unknown'), r || '—');
    const bindGo = (root) => root.querySelectorAll('[data-go]').forEach((el) => {
      const go = () => ctx.showPage(el.dataset.go);
      el.addEventListener('click', go);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });

    // ═════════════════════════ OVERVIEW ═════════════════════════
    async function overview() {
      const root = $('ax-overview');
      root.innerHTML = '<div class="stat-grid">' + '<div class="skel" style="height:90px"></div>'.repeat(4) + '</div>' + skel(4);
      try {
        const o = await api().overview();
        const k = o.kpi;
        root.innerHTML =
          '<div class="stat-grid">' +
            stat(k.failedLogins24h, t('au.failed_24h'), k.failedLogins24h ? 'warn' : 'ok', 'logins') +
            stat(k.lockedAccounts, t('au.locked_accounts'), k.lockedAccounts ? 'danger' : 'ok', 'logins') +
            stat(k.openAnomalies, t('au.open_anomalies'), k.criticalOpenAnomalies ? 'danger' : k.openAnomalies ? 'warn' : 'ok', 'anomalies') +
            stat(k.importantEvents7d, t('au.important_7d'), '', 'audit') +
          '</div>' +
          '<div class="au-grid-2">' +
            '<div class="card"><div class="card-pad"><div class="card-title">' + esc(t('au.top_anomalies')) + '</div>' +
              (o.topAnomalies.length ? o.topAnomalies.map((a) => '<div class="au-row"><div style="min-width:0"><div class="t">' + esc(t('au.atype.' + a.type)) + '</div><div class="s">' + esc(subjectText(a)) + ' · ' + esc(fmtDT(a.at)) + '</div></div>' + sev(a.severity) + '</div>').join('') : empty(t('au.no_open_anomalies'))) +
              '<div style="margin-top:10px"><button class="btn btn-outline btn-sm" data-go="anomalies">' + esc(t('au.open_anomalies_page')) + '</button></div></div></div>' +
            '<div class="card"><div class="card-pad"><div class="card-title">' + esc(t('au.recent_failed')) + '</div>' +
              (o.recentFailedLogins.length ? o.recentFailedLogins.map((l) => '<div class="au-row"><div><div class="t"><code>' + esc(l.loginId) + '</code></div><div class="s">' + esc(fmtDT(l.createdAt)) + ' · ' + esc(l.ip || '—') + '</div></div><span class="badge badge-danger">' + esc(reasonLabel(l.reason)) + '</span></div>').join('') : empty()) + '</div></div>' +
          '</div>' +
          '<div class="au-grid-2">' +
            '<div class="card"><div class="card-pad"><div class="card-title">' + esc(t('au.important_events')) + '</div>' +
              (o.importantEvents.length ? o.importantEvents.map((e) => '<div class="au-row"><div style="min-width:0"><div class="t"><span class="pill">' + esc(e.action) + '</span></div><div class="s">' + (e.actor ? esc(e.actor.fullName) : esc(t('au.system'))) + ' · ' + esc(fmtDT(e.createdAt)) + '</div></div>' + sev(e.severity) + '</div>').join('') : empty()) + '</div></div>' +
            '<div class="card"><div class="card-pad"><div class="card-title">' + esc(t('au.locked_accounts')) + '</div>' +
              (o.lockedAccounts.length ? o.lockedAccounts.map((u) => '<div class="au-row"><div><div class="t">' + esc(u.fullName) + '</div><div class="s">' + esc(u.loginId) + ' · ' + esc(t('au.until')) + ' ' + esc(fmtDT(u.lockedUntil)) + '</div></div><span class="badge badge-danger">' + u.failedLogins + ' ' + esc(t('au.fails')) + '</span></div>').join('') : empty(t('au.no_locked'))) +
              '<div class="card-title" style="margin-top:16px">' + esc(t('au.controls')) + '</div>' +
              Object.entries(o.health).map(([key, v]) => '<div class="au-kv"><span>' + esc(t('au.ctl.' + key, key)) + '</span><span class="badge ' + (v ? 'badge-ok' : 'badge-warn') + '">' + esc(v ? t('au.on') : t('au.off')) + '</span></div>').join('') +
            '</div></div>' +
          '</div>' +
          '<div class="card"><div class="card-pad"><div class="card-title">' + esc(t('au.recent_audit')) + '</div>' +
            (o.recentAudit.length ? o.recentAudit.map((e) => '<div class="au-row"><div style="min-width:0"><div class="t"><span class="pill">' + esc(e.action) + '</span> <span class="au-muted">' + esc(e.targetType) + '</span></div><div class="s">' + (e.actor ? esc(e.actor.fullName) : esc(t('au.system'))) + ' · ' + esc(fmtDT(e.createdAt)) + ' · ' + esc(e.ip || '—') + '</div></div>' + sev(e.severity) + '</div>').join('') : empty()) +
          '</div></div>';
        bindGo(root);
      } catch (e) { root.innerHTML = errBox(e, 'ao-r'); retry('ao-r', overview); }
    }
    function subjectText(a) {
      return a.subject.kind === 'ip' ? 'IP ' + a.subject.id : (a.subject.name ? a.subject.name + ' · ' : '') + a.subject.id;
    }
    function reasonText(a) {
      const p = a.params || {};
      return t('au.areason.' + a.type)
        .replace('{count}', p.count ?? p.total ?? '')
        .replace('{accounts}', p.accounts ?? '')
        .replace('{ips}', Array.isArray(p.ips) ? p.ips.join(' / ') : (p.ips ?? ''))
        .replace('{minutes}', p.withinMinutes ?? '')
        .replace('{reads}', p.reads ?? '')
        .replace('{ip}', p.ip ?? '—')
        .replace('{until}', p.lockedUntil ? fmtDT(p.lockedUntil) : '')
        .replace('{failed}', p.failedLogins ?? '');
    }

    // ═════════════════════════ ANOMALIES ═════════════════════════
    const AN = { hours: 168, type: '', severity: '', status: 'OPEN' };
    async function anomalies() {
      const root = $('ax-anomalies');
      root.innerHTML =
        '<div class="au-note">' + esc(t('au.anomalies_note')) + '</div>' +
        '<div class="au-bar">' +
          fsel('an-hours', t('au.window'), [[24, t('au.h24')], [168, t('au.d7')], [720, t('au.d30')]], AN.hours) +
          fsel('an-type', t('au.type'), [['', t('common.all')]].concat(['BRUTE_FORCE_IP', 'TARGETED_ACCOUNT', 'PARALLEL_SESSIONS', 'UNUSUAL_HOUR_LOGIN', 'MASS_ACTIVITY', 'TOKEN_REUSE', 'ACCOUNT_LOCKED'].map((x) => [x, t('au.atype.' + x)])), AN.type) +
          fsel('an-sev', t('au.severity'), [['', t('common.all')]].concat(['critical', 'high', 'medium', 'low'].map((x) => [x, t('au.sev.' + x)])), AN.severity) +
          fsel('an-status', t('common.status'), [['', t('common.all')]].concat(['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'FALSE_POSITIVE'].map((x) => [x, t('au.fstatus.' + x)])), AN.status) +
        '</div><div id="an-sum"></div><div id="an-box">' + skel(5) + '</div>';
      [['an-hours', 'hours'], ['an-type', 'type'], ['an-sev', 'severity'], ['an-status', 'status']].forEach(([id, k]) => $(id).addEventListener('change', (e) => { AN[k] = k === 'hours' ? Number(e.target.value) : e.target.value; loadAnomalies(); }));
      await loadAnomalies();
    }
    async function loadAnomalies() {
      const box = $('an-box');
      box.innerHTML = skel(5);
      try {
        const r = await api().anomalies({ hours: AN.hours, type: AN.type, severity: AN.severity, status: AN.status });
        const c = r.counts;
        $('an-sum').innerHTML = '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">' +
          ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'FALSE_POSITIVE'].map((s) => '<span class="pill">' + esc(t('au.fstatus.' + s)) + ': ' + (c.byStatus[s] || 0) + '</span>').join('') + '</div>';
        box.innerHTML = '<div class="card" style="overflow:hidden">' + (r.items.length ? '<div class="au-table"><table><thead><tr><th>' + esc(t('au.anomaly')) + '</th><th>' + esc(t('au.reason_h')) + '</th><th>' + esc(t('au.time')) + '</th><th>' + esc(t('au.affected')) + '</th><th>' + esc(t('common.status')) + '</th><th></th></tr></thead><tbody>' +
          r.items.map((a, i) => '<tr><td><b>' + esc(t('au.atype.' + a.type)) + '</b><div style="margin-top:3px">' + sev(a.severity) + '</div></td>' +
            '<td style="white-space:normal;max-width:300px">' + esc(reasonText(a)) + '</td><td class="au-muted">' + esc(fmtDT(a.at)) + '</td>' +
            '<td>' + (a.subject.kind === 'ip' ? '<code>' + esc(a.subject.id) + '</code>' : '<b>' + esc(a.subject.name || '—') + '</b><div class="au-muted">' + esc(a.subject.id) + (a.subject.role ? ' · ' + esc(a.subject.role) : '') + '</div>') + '</td>' +
            '<td>' + stBadge(a.status) + (a.reviewedBy ? '<div class="au-muted" style="font-size:11px;margin-top:3px">' + esc(a.reviewedBy) + '</div>' : '') + '</td>' +
            '<td><button class="btn btn-outline btn-sm" data-i="' + i + '">' + esc(t('au.review')) + '</button></td></tr>').join('') +
          '</tbody></table></div>' : empty(t('au.no_anomalies'))) + '</div>';
        box.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => openReview(r.items[Number(b.dataset.i)])));
      } catch (e) { box.innerHTML = errBox(e, 'an-r'); retry('an-r', loadAnomalies); }
    }
    function openReview(a) {
      openModal({
        title: t('au.atype.' + a.type), static: true,
        html: '<div class="au-note">' + sev(a.severity) + ' ' + esc(reasonText(a)) + '<div style="margin-top:6px">' + esc(t('au.affected')) + ': <b>' + esc(subjectText(a)) + '</b> · ' + esc(fmtDT(a.at)) + '</div></div>' +
          '<div class="au-muted" style="margin-bottom:10px">' + esc(t('au.what_to_do.' + a.type)) + '</div>' +
          '<div class="form-group"><div class="form-label">' + esc(t('common.status')) + '</div><select class="input" id="rv-st">' + ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'FALSE_POSITIVE'].map((s) => '<option value="' + s + '"' + (s === a.status ? ' selected' : '') + '>' + esc(t('au.fstatus.' + s)) + '</option>').join('') + '</select></div>' +
          '<div class="form-group"><div class="form-label">' + esc(t('au.note')) + '</div><textarea class="input" id="rv-note" maxlength="500">' + esc(a.note || '') + '</textarea></div>' +
          '<div class="au-muted" style="font-size:11.5px">' + esc(t('au.review_hint')) + '</div><div class="au-err" id="rv-err" role="alert"></div>',
        buttons: [{ label: t('common.cancel') }, { label: t('common.save'), cls: 'btn-primary', onClick: async (h) => {
          const st = h.$('#rv-st').value;
          if (st !== a.status && (st === 'RESOLVED' || st === 'FALSE_POSITIVE') && !(await confirmDialog({ message: t('au.confirm_close').replace('{status}', t('au.fstatus.' + st)) }))) return false;
          try { await api().reviewAnomaly(a.key, st, h.$('#rv-note').value.trim()); toast(t('au.saved')); await loadAnomalies(); }
          catch (e) { h.$('#rv-err').textContent = errMsg(e); return false; }
        } }],
      });
    }

    // ═════════════════════════ AUDIT LOG ═════════════════════════
    const AU = { from: '', to: '', user: '', action: '', severity: '', items: [], next: null, total: 0, timer: null, facets: null };
    async function audit() {
      const root = $('ax-audit');
      if (!AU.facets) { try { AU.facets = await api().auditFacets(); } catch { AU.facets = { actions: [], targetTypes: [] }; } }
      root.innerHTML =
        '<div class="au-bar">' +
          '<label class="fld"><span>' + esc(t('au.from')) + '</span><input class="input" type="date" id="al-from" value="' + esc(AU.from) + '"></label>' +
          '<label class="fld"><span>' + esc(t('au.to')) + '</span><input class="input" type="date" id="al-to" value="' + esc(AU.to) + '"></label>' +
          '<label class="fld grow"><span>' + esc(t('au.user')) + '</span><input class="input" type="search" id="al-user" value="' + esc(AU.user) + '" placeholder="' + esc(t('au.user_ph')) + '"></label>' +
          '<label class="fld"><span>' + esc(t('au.event_type')) + '</span><input class="input" id="al-action" list="al-actions" value="' + esc(AU.action) + '" placeholder="grade., auth., …"><datalist id="al-actions">' + AU.facets.actions.map((a) => '<option value="' + esc(a.action) + '">' + a.count + '</option>').join('') + '</datalist></label>' +
          fsel('al-sev', t('au.severity'), [['', t('common.all')]].concat(['critical', 'high', 'medium', 'low'].map((x) => [x, t('au.sev.' + x)])), AU.severity) +
          '<button class="btn btn-outline" id="al-reset">' + esc(t('au.reset')) + '</button>' +
        '</div>' +
        '<div class="card" style="overflow:hidden"><div class="au-table"><table><thead><tr><th>' + esc(t('au.time')) + '</th><th>' + esc(t('au.actor')) + '</th><th>' + esc(t('au.event_type')) + '</th><th>' + esc(t('au.severity')) + '</th><th>' + esc(t('au.target')) + '</th><th>IP</th></tr></thead><tbody id="al-body"></tbody></table></div><div id="al-foot"></div></div>';
      const reload = () => loadAudit(true);
      const debounce = () => { clearTimeout(AU.timer); AU.timer = setTimeout(reload, 350); };
      $('al-from').addEventListener('change', (e) => { AU.from = e.target.value; reload(); });
      $('al-to').addEventListener('change', (e) => { AU.to = e.target.value; reload(); });
      $('al-user').addEventListener('input', (e) => { AU.user = e.target.value.trim(); debounce(); });
      $('al-action').addEventListener('input', (e) => { AU.action = e.target.value.trim(); debounce(); });
      $('al-sev').addEventListener('change', (e) => { AU.severity = e.target.value; reload(); });
      $('al-reset').addEventListener('click', () => { Object.assign(AU, { from: '', to: '', user: '', action: '', severity: '' }); audit(); });
      await loadAudit(true);
    }
    async function loadAudit(reset) {
      const body = $('al-body'), foot = $('al-foot');
      if (reset) { AU.items = []; AU.next = null; body.innerHTML = '<tr><td colspan="6">' + skel(5) + '</td></tr>'; }
      if (AU.from && AU.to && AU.from > AU.to) { body.innerHTML = '<tr><td colspan="6">' + errBox({ message: t('au.err_range') }) + '</td></tr>'; foot.innerHTML = ''; return; }
      try {
        const r = await api().auditLogs({ from: AU.from, to: AU.to, user: AU.user, action: AU.action, severity: AU.severity, take: 50, cursor: reset ? '' : AU.next });
        AU.items = AU.items.concat(r.items); AU.next = r.nextCursor; AU.total = r.total;
        body.innerHTML = AU.items.length ? AU.items.map((a) => '<tr class="clickable" data-id="' + esc(a.id) + '" tabindex="0"><td class="au-muted" style="white-space:nowrap">' + esc(fmtDT(a.createdAt)) + '</td><td>' + who(a.actor) + '</td>' +
          '<td><span class="pill">' + esc(a.action) + '</span></td><td>' + sev(a.severity) + '</td><td class="au-muted">' + esc(a.targetType) + (a.targetId ? ' · ' + esc(String(a.targetId).slice(-8)) : '') + '</td>' +
          '<td style="font-family:Consolas,monospace;font-size:12px" class="au-muted">' + esc(a.ip || '—') + '</td></tr>').join('') : '<tr><td colspan="6">' + empty(t('au.no_events')) + '</td></tr>';
        foot.innerHTML = '<div class="pager"><span>' + esc(t('au.shown_of').replace('{n}', AU.items.length).replace('{total}', AU.total)) + '</span>' + (AU.next ? '<button class="btn btn-outline btn-sm" id="al-more">' + esc(t('au.load_more')) + '</button>' : '') + '</div>';
        retry('al-more', () => loadAudit(false));
        body.querySelectorAll('[data-id]').forEach((tr) => {
          const open = () => openAudit(tr.dataset.id);
          tr.addEventListener('click', open);
          tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
        });
      } catch (e) { body.innerHTML = '<tr><td colspan="6">' + errBox(e, 'al-r') + '</td></tr>'; retry('al-r', () => loadAudit(true)); }
    }
    async function openAudit(id) {
      const m = openModal({ title: t('au.event_details'), wide: true, html: skel(3), buttons: [{ label: t('common.close') }] });
      try {
        const a = await api().auditLog(id);
        m.body.innerHTML =
          '<div class="au-kv"><span>' + esc(t('au.time')) + '</span><b>' + esc(fmtDT(a.createdAt)) + '</b></div>' +
          '<div class="au-kv"><span>' + esc(t('au.event_type')) + '</span><span class="pill">' + esc(a.action) + '</span></div>' +
          '<div class="au-kv"><span>' + esc(t('au.severity')) + '</span>' + sev(a.severity) + '</div>' +
          '<div class="au-kv"><span>' + esc(t('au.actor')) + '</span><span>' + who(a.actor) + '</span></div>' +
          '<div class="au-kv"><span>' + esc(t('au.target')) + '</span><span>' + esc(a.targetType + (a.targetId ? ' · ' + a.targetId : '')) + '</span></div>' +
          '<div class="au-kv"><span>IP</span><code>' + esc(a.ip || '—') + '</code></div>' +
          '<div class="au-kv"><span>User agent</span><span class="au-muted" style="max-width:60%;text-align:right">' + esc(a.userAgent || '—') + '</span></div>' +
          '<div class="form-label" style="margin-top:12px">' + esc(t('au.changes')) + '</div>' + (a.diff ? '<pre class="au-json">' + esc(JSON.stringify(a.diff, null, 2)) + '</pre>' : empty('—')) +
          '<div class="au-muted" style="font-size:11.5px">' + esc(t('au.redacted_note')) + '</div>';
      } catch (e) { m.body.innerHTML = errBox(e); }
    }

    // ═════════════════════════ LOGIN ACTIVITY ═════════════════════════
    const LG = { hours: 24, result: '', reason: '', search: '', items: [], next: null, total: 0, timer: null };
    async function logins() {
      const root = $('ax-logins');
      root.innerHTML = '<div class="au-bar">' + fsel('lg-hours', t('au.window'), [[24, t('au.h24')], [168, t('au.d7')], [720, t('au.d30')]], LG.hours) + '</div><div id="lg-sum">' + skel(2, 90) + '</div>' +
        '<div class="au-bar" style="margin-top:6px">' +
          fsel('lg-result', t('au.result'), [['', t('common.all')], ['true', t('au.successful')], ['false', t('au.failed')]], LG.result) +
          fsel('lg-reason', t('au.reason_h'), [['', t('common.all')]].concat(['bad_password', 'locked', 'not_found', 'inactive'].map((x) => [x, reasonLabel(x)])), LG.reason) +
          '<label class="fld grow"><span>Login ID</span><input class="input" type="search" id="lg-q" maxlength="20" value="' + esc(LG.search) + '"></label>' +
        '</div>' +
        '<div class="card" style="overflow:hidden"><div class="au-table"><table><thead><tr><th>' + esc(t('au.time')) + '</th><th>Login ID</th><th>' + esc(t('common.name')) + '</th><th>' + esc(t('au.result')) + '</th><th>IP</th><th>User agent</th></tr></thead><tbody id="lg-body"></tbody></table></div><div id="lg-foot"></div></div>';
      $('lg-hours').addEventListener('change', (e) => { LG.hours = Number(e.target.value); loadLoginSummary(); loadLogins(true); });
      $('lg-result').addEventListener('change', (e) => { LG.result = e.target.value; loadLogins(true); });
      $('lg-reason').addEventListener('change', (e) => { LG.reason = e.target.value; loadLogins(true); });
      $('lg-q').addEventListener('input', (e) => { LG.search = e.target.value.trim(); clearTimeout(LG.timer); LG.timer = setTimeout(() => loadLogins(true), 350); });
      await Promise.all([loadLoginSummary(), loadLogins(true)]);
    }
    async function loadLoginSummary() {
      const box = $('lg-sum');
      try {
        const a = await api().loginActivity(LG.hours);
        const tt = a.totals;
        const lbl = (iso) => { const d = new Date(iso); return a.windowHours <= 48 ? d.toLocaleTimeString(loc(), { hour: '2-digit' }) : d.toLocaleDateString(loc(), { day: '2-digit', month: '2-digit' }); };
        box.innerHTML =
          '<div class="stat-grid">' + stat(tt.successful, t('au.successful'), 'ok') + stat(tt.failed, t('au.failed'), tt.failed ? 'warn' : 'ok') + stat(tt.lockedEvents, t('au.locked_attempts'), tt.lockedEvents ? 'danger' : 'ok') + stat(tt.currentlyLockedAccounts, t('au.locked_now'), tt.currentlyLockedAccounts ? 'danger' : 'ok') + '</div>' +
          '<div class="au-grid-2"><div class="card"><div class="card-pad"><div class="card-title">' + esc(t('au.timeline')) + '</div>' +
            (tt.events ? columns(a.timeline.map((b) => ({ label: lbl(b.t), success: b.success, failed: b.failed })), [{ key: 'success', color: '#10b981', label: t('au.successful') }, { key: 'failed', color: '#ef4444', label: t('au.failed') }], { aria: t('au.timeline') }) : empty()) + '</div></div>' +
            '<div class="card"><div class="card-pad"><div class="card-title">' + esc(t('au.failed_by_reason')) + '</div>' +
            (Object.keys(a.failedByReason).length ? hbars(Object.entries(a.failedByReason).map(([r, n]) => ({ label: reasonLabel(r), value: n, color: '#ef4444' }))) : empty(t('au.no_failed'))) +
            '<div class="au-kv" style="margin-top:10px"><span>' + esc(t('au.unique_failed_ips')) + '</span><b>' + tt.uniqueFailedIps + '</b></div></div></div></div>';
      } catch (e) { box.innerHTML = errBox(e); }
    }
    async function loadLogins(reset) {
      const body = $('lg-body'), foot = $('lg-foot');
      if (reset) { LG.items = []; LG.next = null; body.innerHTML = '<tr><td colspan="6">' + skel(5) + '</td></tr>'; }
      try {
        const from = new Date(Date.now() - LG.hours * 3600_000).toISOString();
        const r = await api().loginLogs({ from, success: LG.result, reason: LG.reason, search: LG.search, take: 50, cursor: reset ? '' : LG.next });
        LG.items = LG.items.concat(r.items); LG.next = r.nextCursor; LG.total = r.total;
        body.innerHTML = LG.items.length ? LG.items.map((l) => '<tr><td class="au-muted" style="white-space:nowrap">' + esc(fmtDT(l.createdAt)) + '</td><td><code>' + esc(l.loginId) + '</code></td><td>' + (l.user ? esc(l.user.fullName) : '<span class="badge badge-gray">' + esc(t('au.unknown')) + '</span>') + '</td>' +
          '<td>' + (l.success ? '<span class="badge badge-ok">' + esc(t('au.successful')) + '</span>' : '<span class="badge badge-danger">' + esc(reasonLabel(l.reason)) + '</span>') + '</td>' +
          '<td style="font-family:Consolas,monospace;font-size:12px" class="au-muted">' + esc(l.ip || '—') + '</td><td class="au-muted" style="font-size:11px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(l.userAgent || '') + '</td></tr>').join('') : '<tr><td colspan="6">' + empty(t('au.no_events')) + '</td></tr>';
        foot.innerHTML = '<div class="pager"><span>' + esc(t('au.shown_of').replace('{n}', LG.items.length).replace('{total}', LG.total)) + '</span>' + (LG.next ? '<button class="btn btn-outline btn-sm" id="lg-more">' + esc(t('au.load_more')) + '</button>' : '') + '</div>';
        retry('lg-more', () => loadLogins(false));
      } catch (e) { body.innerHTML = '<tr><td colspan="6">' + errBox(e, 'lg-r') + '</td></tr>'; retry('lg-r', () => loadLogins(true)); }
    }

    // ═════════════════════════ CONFIG (read-only) / DEPS ═════════════════════════
    async function config() {
      const root = $('ax-config');
      root.innerHTML = skel(4, 90);
      try {
        const c = await api().config();
        root.innerHTML = '<div class="au-note">🔒 ' + esc(t('au.config_readonly')) + '</div>' +
          [['password', c.password], ['jwt', c.jwt], ['session', c.session], ['transport', c.transport], ['headers', c.headers], ['rateLimit', c.rateLimit], ['cors', c.cors], ['audit', c.audit], ['validation', c.validation]].map(([k, obj]) =>
            '<div class="card" style="margin-bottom:14px"><div class="card-pad"><div class="card-title">' + esc(t('au.cfg.' + k, k)) + '</div>' +
            Object.entries(obj).map(([kk, v]) => '<div class="cfg-row"><span class="cfg-key">' + esc(kk) + '</span><span class="cfg-val">' + esc(Array.isArray(v) ? v.join(', ') : String(v)) + '</span></div>').join('') + '</div></div>').join('');
      } catch (e) { root.innerHTML = errBox(e, 'cf-r'); retry('cf-r', config); }
    }
    async function deps() {
      const root = $('ax-deps');
      root.innerHTML = skel(3);
      try {
        const d = await api().dependencies();
        root.innerHTML = '<div class="card"><div class="card-pad">' +
          '<div class="cfg-row"><span class="cfg-key">' + esc(t('au.deps_total')) + '</span><span class="cfg-val">' + d.totalDependencies + '</span></div>' +
          '<div class="cfg-row"><span class="cfg-key">' + esc(t('au.deps_dev')) + '</span><span class="cfg-val">' + d.totalDevDependencies + '</span></div>' +
          '<div class="card-title" style="margin-top:18px">' + esc(t('au.deps_critical')) + '</div>' +
          Object.entries(d.criticalSecurityDependencies).map(([k, v]) => '<div class="cfg-row"><span class="cfg-key">' + esc(k) + '</span><span class="pill">' + esc(v) + '</span></div>').join('') +
          '<div class="au-note" style="margin-top:14px">' + esc(t('au.deps_note')) + '</div></div></div>';
      } catch (e) { root.innerHTML = errBox(e, 'dp-r'); retry('dp-r', deps); }
    }

    const fsel = (id, label, opts, cur) => '<label class="fld"><span>' + esc(label) + '</span><select class="input" id="' + id + '">' + opts.map(([v, l]) => '<option value="' + esc(v) + '"' + (String(cur) === String(v) ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></label>';

    return { overview, anomalies, audit, logins, config, deps };
  }

  AP.auditorUI = { create };
})(window);
