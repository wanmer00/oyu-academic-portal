// ============================================================
// Exam Management System — общие помощники интерфейса (AP.ex): текст/даты/ошибки/разметка вопросов.
// Весь расчёт (баллы, допуск, оплата, таймер) выполняет backend; здесь только отображение.
// ============================================================
(function (global) {
  'use strict';
  const AP = (global.AP = global.AP || {});
  const t = (k, fb) => AP.i18n.t(k, fb);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Простая безопасная разметка вопросов: **жирный**, *курсив*, `код`, x^{2}, x_{i}; остальное экранируется (как на сервере) */
  function rich(s) {
    return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*]+)\*/g, '<i>$1</i>')
      .replace(/\^\{([^}]+)\}/g, '<sup>$1</sup>').replace(/_\{([^}]+)\}/g, '<sub>$1</sub>').replace(/\n/g, '<br>');
  }

  const locale = () => { const l = AP.i18n.getLang(); return l === 'en' ? 'en-GB' : l === 'ru' ? 'ru-RU' : 'az-AZ'; };
  const fmtDate = (d) => { try { return new Date(String(d).length === 10 ? d + 'T12:00:00' : d).toLocaleDateString(locale(), { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return d || '—'; } };
  const fmtDT = (d) => { try { return new Date(d).toLocaleString(locale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return d || '—'; } };
  const num = (v) => (v == null ? '—' : String(Math.round(Number(v) * 100) / 100));

  const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const dayName = (n) => t('ex.day.' + DAY_KEYS[n - 1]);
  const days = (arr) => '<div class="ex-days">' + [1, 2, 3, 4, 5, 6, 7].map((d) => '<span class="ex-day' + (arr.includes(d) ? ' on' : '') + '">' + esc(dayName(d)) + '</span>').join('') + '</div>';

  const chip = (cls, text) => '<span class="ex-chip ' + (cls || '') + '">' + esc(text) + '</span>';
  const reasonText = (code) => t('ex.reason.' + code, code);
  const statusText = (s) => t('ex.st.' + s, s);

  /** Сообщение об ошибке backend по коду (code) + список причин (reasons) */
  function errMsg(e) {
    if (!e) return t('common.error');
    if (e.networkError) return t('journal.err.network');
    const b = e.body || {};
    let m = b.code ? t('ex.err.' + b.code, '') : '';
    if (!m) m = e.message || t('common.error');
    if (Array.isArray(b.reasons) && b.reasons.length) m += ': ' + b.reasons.map(reasonText).join('; ');
    if (b.issues) m += ' (' + Object.keys(b.issues).join(', ') + ')';
    return m;
  }

  function toast(msg, isErr) {
    let el = document.getElementById('ex-toast');
    if (!el) {
      el = document.createElement('div'); el.id = 'ex-toast';
      el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#0f172a;color:#fff;padding:11px 18px;border-radius:10px;font-size:14px;z-index:900;max-width:92vw;box-shadow:0 8px 30px rgba(0,0,0,.3);transition:opacity .2s;opacity:0;pointer-events:none';
      el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); document.body.appendChild(el);
    }
    el.textContent = msg; el.style.background = isErr ? '#b91c1c' : '#0f172a'; el.style.opacity = '1';
    clearTimeout(el._h); el._h = setTimeout(() => { el.style.opacity = '0'; }, isErr ? 5000 : 2600);
  }

  const api = (path, opts) => AP.api.request(path, opts);
  const skel = (n) => Array.from({ length: n || 3 }, () => '<div class="skel" style="height:70px;margin-bottom:12px"></div>').join('');
  const empty = (msg) => '<div class="empty">' + esc(msg) + '</div>';
  const errBox = (e, retryId) => '<div class="empty" style="color:#dc2626">' + esc(errMsg(e)) + (retryId ? '<div style="margin-top:10px"><button class="btn btn-outline btn-sm" id="' + retryId + '">' + esc(t('notif.retry')) + '</button></div>' : '') + '</div>';

  /** Скачивание защищённого ресурса (HTML для печати, изображения) с Bearer-токеном → blob */
  async function fetchBlob(path) {
    const base = (global.AP_API_BASE || '').replace(/\/$/, '') || (location.hostname === 'localhost' ? 'http://localhost:3001' : '');
    const tok = AP.api.getAccessToken();
    const res = await fetch(base + '/api/v1' + path, { headers: tok ? { Authorization: 'Bearer ' + tok } : {}, credentials: 'include' });
    if (!res.ok) { const err = new Error('HTTP ' + res.status); err.status = res.status; throw err; }
    return res.blob();
  }
  async function openPrint(path) {
    const w = window.open('', '_blank');
    try { const b = await fetchBlob(path); const url = URL.createObjectURL(b); if (w) w.location.href = url; else window.open(url, '_blank'); setTimeout(() => URL.revokeObjectURL(url), 60000); }
    catch (e) { if (w) w.close(); toast(errMsg(e), true); }
  }

  const fileToB64 = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('file'));
    r.readAsDataURL(file);
  });
  const fileToDataUrl = (file) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(new Error('file')); r.readAsDataURL(file); });

  AP.ex = { t, esc, rich, fmtDate, fmtDT, num, days, dayName, chip, reasonText, statusText, errMsg, toast, api, skel, empty, errBox, fetchBlob, openPrint, fileToB64, fileToDataUrl };
})(window);
