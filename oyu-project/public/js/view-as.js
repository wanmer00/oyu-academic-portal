// ============================================================
// «Просмотреть как роль» (View as) — только SUPER_ADMIN.
// Безопасный предпросмотр: сервер подменяет пользователя запроса, режим строго «только чтение»,
// роль SUPER_ADMIN не меняется; вход и выход пишутся в Audit Log.
// ============================================================
(function (global) {
  'use strict';
  const AP = (global.AP = global.AP || {});
  const t = (k, fb) => AP.i18n.t(k, fb);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const home = (role) => (role === 'ADMIN' || role === 'SUPER_ADMIN' ? '/admin-dashboard.html' : role === 'PROCTOR' ? '/proctor.html' : '/portal.html');

  /** Постоянная плашка сверху, пока включён предпросмотр */
  function banner() {
    const va = AP.api.viewAs.get();
    const old = document.getElementById('va-banner');
    if (old) old.remove();
    if (!va) return;
    const el = document.createElement('div');
    el.id = 'va-banner';
    el.setAttribute('role', 'status');
    el.innerHTML = '<span>👁 ' + esc(t('va.banner').replace('{name}', va.fullName).replace('{role}', t('va.role.' + va.role, va.role))) + '</span><button type="button" id="va-exit">' + esc(t('va.exit')) + '</button>';
    document.body.prepend(el);
    document.body.classList.add('va-active');
    document.getElementById('va-exit').addEventListener('click', exit);
  }

  async function exit() {
    try { await AP.api.viewAs.end(); } catch { AP.api.viewAs.get() && sessionStorage.removeItem('ap_view_as'); }
    location.href = '/admin-dashboard.html';
  }

  async function openPicker() {
    let data;
    try { data = await AP.api.viewAs.targets(); } catch (e) { alert(e.message); return; }
    const roles = data.roles;
    const m = AP.tui.openModal({
      title: '👁 ' + t('va.title'), static: true,
      html: '<div class="au-note">' + esc(t('va.hint')) + '</div>' +
        '<div class="form-group"><div class="form-label">' + esc(t('va.pick_role')) + '</div><select class="input" id="va-role">' + roles.map((r) => '<option value="' + r.role + '">' + esc(t('va.role.' + r.role, r.role)) + '</option>').join('') + '</select></div>' +
        '<div class="form-group"><div class="form-label">' + esc(t('va.pick_user')) + '</div><select class="input" id="va-user"></select></div><div class="au-err" id="va-err"></div>',
      buttons: [{ label: t('common.cancel') }, { label: t('va.start'), cls: 'btn-primary', onClick: async (h) => {
        const role = h.$('#va-role').value, id = h.$('#va-user').value;
        const u = roles.find((r) => r.role === role).users.find((x) => x.id === id);
        if (!u) { h.$('#va-err').textContent = t('va.no_user'); return false; }
        try {
          const r = await AP.api.viewAs.start({ id: u.id, loginId: u.loginId, fullName: u.fullName, role });
          if (!r || !r.ok) { h.$('#va-err').textContent = t('common.error'); return false; }
          location.href = home(role);
        } catch (e) { h.$('#va-err').textContent = e.message; return false; }
      } }],
    });
    const fill = () => {
      const r = roles.find((x) => x.role === m.$('#va-role').value);
      m.$('#va-user').innerHTML = r.users.map((u) => '<option value="' + esc(u.id) + '">' + esc(u.fullName + ' · ' + u.loginId) + '</option>').join('');
    };
    m.$('#va-role').addEventListener('change', fill); fill();
  }

  AP.viewAs = { banner, openPicker, exit };
})(window);