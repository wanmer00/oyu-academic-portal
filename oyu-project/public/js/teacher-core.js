// ============================================================
// Teacher workspace — общие UI-хелперы: модалки, подтверждения, CSV
// ============================================================
(function (global) {
  'use strict';
  const AP = (global.AP = global.AP || {});

  const t = (k, fb) => AP.i18n.t(k, fb);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ── Modal stack ──
  const stack = [];
  function openModal(opts) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay show';
    overlay.innerHTML =
      '<div class="modal' + (opts.wide ? ' tui-modal-wide' : '') + '" role="dialog" aria-modal="true" aria-labelledby="tui-m-title">' +
        '<div class="modal-title" id="tui-m-title">' + esc(opts.title || '') + '</div>' +
        '<div class="tui-m-body">' + (opts.html || '') + '</div>' +
        '<div class="form-row tui-m-actions"></div>' +
      '</div>';
    document.body.appendChild(overlay);
    const body = overlay.querySelector('.tui-m-body');
    const actions = overlay.querySelector('.tui-m-actions');
    const handle = {
      el: overlay, body,
      close() {
        const i = stack.indexOf(handle); if (i >= 0) stack.splice(i, 1);
        overlay.remove();
        if (opts.onClose) opts.onClose();
      },
      btn(id) { return actions.querySelector('[data-mid="' + id + '"]'); },
      show(id, on) { const b = handle.btn(id); if (b) b.style.display = on === false ? 'none' : ''; },
      enable(id, on) { const b = handle.btn(id); if (b) b.disabled = !on; },
      $(sel) { return overlay.querySelector(sel); },
    };
    (opts.buttons || []).forEach((b) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'btn ' + (b.cls || 'btn-outline');
      el.textContent = b.label;
      el.dataset.mid = b.id || b.label;
      if (b.hidden) el.style.display = 'none';
      el.addEventListener('click', async () => {
        if (el.disabled) return;
        el.disabled = true;
        try {
          const r = b.onClick ? await b.onClick(handle) : undefined;
          if (r !== false && !b.keep) handle.close();
        } finally { if (el.isConnected) el.disabled = false; }
      });
      actions.appendChild(el);
    });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && !opts.static) handle.close(); });
    stack.push(handle);
    const first = overlay.querySelector('input:not([type=hidden]),select,textarea');
    if (first) setTimeout(() => first.focus(), 30);
    return handle;
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && stack.length) stack[stack.length - 1].close();
  });

  // Промис-подтверждение вместо window.confirm
  function confirmDialog({ title, message, confirmLabel, danger }) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      openModal({
        title: title || t('tch.confirm'),
        html: '<div style="font-size:14px;line-height:1.55;white-space:pre-wrap">' + esc(message || '') + '</div>',
        onClose: () => finish(false),
        buttons: [
          { label: t('common.cancel'), cls: 'btn-outline', onClick: () => { finish(false); } },
          { label: confirmLabel || t('common.confirm'), cls: danger ? 'btn-danger' : 'btn-purple', onClick: () => { finish(true); } },
        ],
      });
    });
  }

  const skeleton = (n) => Array.from({ length: n || 3 }, () => '<div class="skel" style="height:44px;margin:10px 0"></div>').join('');

  function errorBox(msg, retryId) {
    return '<div class="empty tui-err">' + esc(msg || t('common.error')) +
      (retryId ? '<div style="margin-top:10px"><button class="btn btn-outline btn-sm" id="' + retryId + '">' + esc(t('notif.retry')) + '</button></div>' : '') + '</div>';
  }
  const emptyBox = (msg) => '<div class="empty">' + esc(msg) + '</div>';

  // ── CSV ──
  function parseCsv(text) {
    text = String(text).replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    const counts = { ',': (firstLine.match(/,/g) || []).length, ';': (firstLine.match(/;/g) || []).length, '\t': (firstLine.match(/\t/g) || []).length };
    const delim = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some((x) => x.trim() !== '')) rows.push(row);
        row = [];
      } else cell += c;
    }
    row.push(cell);
    if (row.some((x) => x.trim() !== '')) rows.push(row);
    if (q) throw new Error('unterminated_quote');
    return rows;
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  AP.tui = { t, esc, openModal, confirmDialog, skeleton, errorBox, emptyBox, parseCsv, saveBlob };
})(window);
