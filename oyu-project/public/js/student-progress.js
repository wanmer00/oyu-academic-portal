// ============================================================
// Академический прогресс студента-бакалавра: кредиты (из 240), статус предметов учебного плана,
// задолженности, выбор выборных предметов, практика и выпускная работа.
// Данные: GET /me/progress, /me/projects, POST /me/electives/:id
// ============================================================
(function (global) {
  'use strict';
  const AP = (global.AP = global.AP || {});
  const t = (k, fb) => AP.i18n.t(k, fb);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const BADGE = { PASSED: 'badge-success', DEBT: 'badge-danger', IN_PROGRESS: 'badge-info', PLANNED: 'badge-gray', NOT_CHOSEN: 'badge-warning' };
  const fmt = (d) => { try { return new Date(d).toLocaleDateString(); } catch { return ''; } };

  const STYLE = '.cfg-row{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--c-border,#e2e8f0);font-size:13px}.cfg-row:last-child{border-bottom:none}.cfg-val{font-family:Consolas,monospace}.tt-prog-bar{height:12px;border-radius:99px;background:var(--c-border,#e2e8f0);overflow:hidden}.tt-prog-bar i{display:block;height:100%;background:linear-gradient(90deg,#2563eb,#16a34a)}.tt-red{color:#dc2626}.tt-green{color:#16a34a}.tt-ul{margin:6px 0 0 18px;font-size:13px}.tt-chk{display:inline-flex;align-items:center;gap:5px;font-size:13px;cursor:pointer}.au-note{padding:10px 12px;border-radius:8px;border:1px solid var(--c-border,#e2e8f0);font-size:12.5px;margin:12px 0}.au-muted{color:var(--c-text2,#64748b);font-size:12px}';
  function ensureStyle() { if (!document.getElementById('sp-style')) { const s = document.createElement('style'); s.id = 'sp-style'; s.textContent = STYLE; document.head.appendChild(s); } }

  async function render(rootId) {
    ensureStyle();
    const root = document.getElementById(rootId);
    root.innerHTML = '<div class="skel" style="height:120px"></div><div class="skel" style="height:220px;margin-top:12px"></div>';
    try {
      const [p, projects] = await Promise.all([AP.api.request('/me/progress'), AP.api.request('/me/projects')]);
      if (!p.hasPlan) { root.innerHTML = '<div class="card"><div class="card-pad"><div class="empty">' + esc(t('sp.no_plan')) + '</div></div></div>'; return; }
      const stat = (v, l, cls) => '<div class="stat-card"><div class="stat-val ' + (cls || '') + '">' + esc(v) + '</div><div class="stat-label">' + esc(l) + '</div></div>';
      root.innerHTML =
        '<div class="card" style="margin-bottom:16px"><div class="card-pad"><div class="card-title">' + esc(p.specialty.name) + ' <span class="au-muted">· ' + esc(p.specialty.code) + ' · ' + esc(p.student.groupName) + '</span></div>' +
          '<div class="au-muted">' + esc(p.specialty.faculty) + ' · ' + esc(p.specialty.department) + '</div>' +
          '<div style="margin:14px 0 6px;display:flex;justify-content:space-between"><b>' + p.earned + ' / ' + p.required + ' ' + esc(t('sp.credits')) + '</b><span>' + p.percent + '%</span></div>' +
          '<div class="tt-prog-bar"><i style="width:' + Math.min(100, p.percent) + '%"></i></div></div></div>' +
        '<div class="stat-grid">' + stat(p.earned, t('sp.earned')) + stat(p.required - p.earned, t('sp.remaining')) + stat(p.debts.length, t('sp.debts'), p.debts.length ? 'tt-red' : 'tt-green') + stat(p.student.semester + ' / 8', t('sp.semester')) + '</div>' +
        (p.debts.length ? '<div class="au-note" style="border-color:#ef4444"><b>' + esc(t('sp.debts_title')) + '</b><ul class="tt-ul">' + p.debts.map((d) => '<li>' + esc(d.semester + ' ' + t('sp.sem_short') + ' · ' + d.subject.code + ' ' + d.subject.name + ' · ' + d.credits + ' ' + t('sp.credits') + (d.total != null ? ' · ' + d.total : '')) + '</li>').join('') + '</ul></div>' : '') +
        (p.electives.some((e) => !e.locked) ? '<div class="card" style="margin:16px 0"><div class="card-pad"><div class="card-title">' + esc(t('sp.electives')) + '</div><div class="au-muted" style="margin-bottom:8px">' + esc(t('sp.electives_hint')) + '</div>' +
          p.electives.filter((e) => !e.locked).map((e) => '<div class="cfg-row" style="align-items:center"><span><b>' + esc(t('sp.semester')) + ' ' + e.semester + '</b> · ' + e.credits + ' ' + esc(t('sp.credits')) + '</span><span>' +
            e.options.map((o) => '<label class="tt-chk" style="margin-left:12px"><input type="radio" name="el-' + esc(e.group) + '" data-el="' + esc(o.id) + '"' + (e.chosenId === o.id ? ' checked' : '') + '> ' + esc(o.subject.name) + '</label>').join('') + '</span></div>').join('') + '</div></div>' : '') +
        (projects.length ? '<div class="card" style="margin:16px 0"><div class="card-pad"><div class="card-title">' + esc(t('sp.projects')) + '</div>' + projects.map((x) =>
          '<div class="cfg-row"><span><b>' + esc(t('sp.type_' + x.type)) + '</b> · ' + esc(x.title) + '<div class="au-muted">' + esc((x.organization || '') + (x.supervisor ? ' · ' + t('sp.supervisor') + ': ' + x.supervisor : '') + (x.startDate ? ' · ' + fmt(x.startDate) + ' – ' + fmt(x.endDate) : '')) + '</div></span><span>' +
          '<span class="badge ' + (x.status === 'COMPLETED' ? 'badge-success' : x.status === 'PLANNED' ? 'badge-gray' : 'badge-info') + '">' + esc(t('sp.st_' + x.status)) + '</span>' + (x.grade != null ? ' <b>' + x.grade + '</b>' : '') + '</span></div>').join('') + '</div></div>' : '') +
        p.semesters.map((s) => '<div class="card" style="margin-bottom:12px"><div class="card-pad"><div class="card-title">' + esc(t('sp.semester')) + ' ' + s.semester + ' <span class="au-muted">· ' + s.credits + ' ' + esc(t('sp.credits')) + '</span></div>' +
          s.items.filter((i) => i.selected || i.status === 'NOT_CHOSEN' || !i.electiveGroup).map((i) => '<div class="cfg-row"><span><code>' + esc(i.subject.code) + '</code> ' + esc(i.subject.name) + (i.kind === 'ELECTIVE' ? ' <span class="badge badge-info">' + esc(t('sp.elective')) + '</span>' : '') + '</span><span>' + i.credits + ' · ' +
            (i.total != null ? i.total + ' · ' : '') + '<span class="badge ' + BADGE[i.status] + '">' + esc(t('sp.s_' + i.status)) + '</span></span></div>').join('') + '</div></div>').join('');
      root.querySelectorAll('[data-el]').forEach((r) => r.addEventListener('change', async () => {
        try { await AP.api.request('/me/electives/' + r.dataset.el, { method: 'POST', body: {} }); render(rootId); }
        catch (e) { alert(e.message); render(rootId); }
      }));
    } catch (e) { root.innerHTML = '<div class="card"><div class="card-pad"><div class="empty au-err">' + esc(e.message) + '</div></div></div>'; }
  }

  AP.studentProgress = { render };
})(window);
