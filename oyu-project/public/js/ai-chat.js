// ============================================================
// Academic Portal — AI Assistant (server-backed, role-aware)
// Клиент НЕ собирает данные и НЕ решает, что показывать: он отправляет вопрос в
// /api/v1/ai/assistant/*, а сервер определяет роль по JWT, применяет обычные права
// и отдаёт ответ только по данным, доступным этой роли.
// ============================================================
(function (global) {
  'use strict';

  if (!document.getElementById('ai-chat-styles')) {
    const link = document.createElement('link');
    link.id = 'ai-chat-styles'; link.rel = 'stylesheet'; link.href = '/css/ai-chat.css';
    document.head.appendChild(link);
  }

  const state = { open: false, loading: false, user: null, cfg: null, sessionId: null, messages: [], last: null };
  const t = (k, fb) => (global.AP && AP.i18n ? AP.i18n.t(k, fb) : (fb || k));
  const lang = () => (global.AP && AP.i18n ? AP.i18n.getLang() : 'az');
  const $ = (id) => document.getElementById(id);
  const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmt = (text) => escHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');
  const sessKey = () => 'ap_ai_session_' + (state.user ? state.user.id : '');

  function loadSession() { try { return sessionStorage.getItem(sessKey()) || null; } catch { return null; } }
  function saveSession(id) { state.sessionId = id || null; try { id ? sessionStorage.setItem(sessKey(), id) : sessionStorage.removeItem(sessKey()); } catch { /* ignore */ } }

  function inject() {
    if ($('ai-fab')) return;
    const fab = document.createElement('button');
    fab.className = 'ai-fab'; fab.id = 'ai-fab'; fab.type = 'button'; fab.style.display = 'none';
    fab.setAttribute('aria-label', 'AI');
    fab.innerHTML =
      '<div class="ai-fab-pulse"></div>' +
      '<svg class="icon-chat" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
      '<svg class="icon-close" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    fab.addEventListener('click', toggle);
    document.body.appendChild(fab);

    const panel = document.createElement('div');
    panel.className = 'ai-panel'; panel.id = 'ai-panel'; panel.setAttribute('role', 'dialog');
    panel.innerHTML =
      '<div class="ai-panel-head">' +
        '<div class="ai-panel-avatar"><svg viewBox="0 0 24 24"><path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1.07A7 7 0 0 1 14 23h-4a7 7 0 0 1-6.93-4H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"/><circle cx="9" cy="15" r="1.5" fill="#fff"/><circle cx="15" cy="15" r="1.5" fill="#fff"/></svg></div>' +
        '<div><div class="ai-panel-title" id="ai-title"></div><div class="ai-panel-sub" id="ai-status"></div></div>' +
        '<button class="ai-panel-clear" id="ai-clear" type="button"></button>' +
      '</div>' +
      '<div class="ai-panel-body" id="ai-body" aria-live="polite"></div>' +
      '<div class="ai-quick-strip" id="ai-strip"></div>' +
      '<div class="ai-panel-input">' +
        '<textarea id="ai-input" rows="1" maxlength="1000"></textarea>' +
        '<button class="ai-send-btn" id="ai-send" type="button"><svg viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>' +
      '</div>';
    document.body.appendChild(panel);

    $('ai-clear').addEventListener('click', clear);
    $('ai-send').addEventListener('click', () => ask());
    const inp = $('ai-input');
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } });
    inp.addEventListener('input', () => { inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 100) + 'px'; });
    applyLabels();
  }

  function applyLabels() {
    if (!$('ai-title')) return;
    $('ai-title').textContent = t('ai.title', 'Odlar Yurdu AI Assistant');
    $('ai-clear').textContent = '🗑 ' + t('ai.clear', 'Clear');
    $('ai-clear').title = t('ai.clear_title', 'Clear chat');
    $('ai-input').placeholder = t('ai.placeholder', 'Ask a question…');
    $('ai-send').setAttribute('aria-label', t('ai.send', 'Send'));
    setStatus(state.loading ? 'thinking' : 'ready');
    renderStrip();
  }
  function setStatus(kind) {
    const el = $('ai-status'); if (!el) return;
    const role = state.user ? t('ai.role.' + state.user.role, state.user.role) : '';
    el.textContent = kind === 'thinking' ? t('ai.thinking', 'Thinking…') : kind === 'error' ? t('ai.error_status', 'Error') : role + ' · ' + t('ai.ready', 'ready');
  }

  function setUser(user) {
    state.user = user || null; state.cfg = null; state.messages = []; state.last = null;
    state.sessionId = user ? loadSession() : null;
    inject();
    const fab = $('ai-fab'); if (!fab) return;
    if (user) {
      fab.style.display = 'flex';
      applyLabels();
      loadConfig().then(() => { applyLabels(); if (state.open && !state.messages.length) renderWelcome(); });
    } else {
      fab.style.display = 'none'; $('ai-panel').classList.remove('open'); fab.classList.remove('open'); state.open = false;
    }
  }
  async function loadConfig() {
    try { state.cfg = await AP.api.ai.assistantConfig(); } catch { state.cfg = null; }
  }

  function toggle() {
    if (!state.user) return;
    state.open = !state.open;
    $('ai-fab').classList.toggle('open', state.open);
    $('ai-panel').classList.toggle('open', state.open);
    if (state.open && !state.messages.length) renderWelcome();
    if (state.open) setTimeout(() => { const i = $('ai-input'); if (i) i.focus(); }, 250);
  }
  function clear() {
    state.messages = []; state.last = null; saveSession(null);
    renderWelcome();
  }

  // ── Быстрые действия: список тем приходит с сервера и уже отфильтрован по роли ──
  function quickList() { return (state.cfg && state.cfg.quickActions) || []; }
  function renderStrip() {
    const strip = $('ai-strip'); if (!strip) return;
    // На экране приветствия кнопки крупные внутри body; в диалоге — компактная лента
    strip.innerHTML = state.messages.length
      ? quickList().map((tp) => '<button class="ai-chip" type="button" data-topic="' + tp + '">' + escHtml(t('ai.quick.' + tp, tp)) + '</button>').join('')
      : '';
    strip.style.display = state.messages.length ? 'flex' : 'none';
    strip.querySelectorAll('[data-topic]').forEach((b) => b.addEventListener('click', () => quick(b.dataset.topic)));
  }

  function renderWelcome() {
    const body = $('ai-body'); if (!body || !state.user) return;
    const name = (state.user.fullName || '').split(' ')[0] || '';
    const hour = new Date().getHours();
    const greet = t(hour < 12 ? 'ai.good_morning' : hour < 18 ? 'ai.good_day' : 'ai.good_evening');
    const list = quickList();
    body.innerHTML =
      '<div class="ai-welcome">' +
        '<div class="ai-welcome-icon">🤖</div>' +
        '<div class="ai-welcome-title">' + escHtml(greet) + ', ' + escHtml(name) + '!</div>' +
        '<div style="margin-bottom:8px"><span class="ai-role-badge">' + escHtml(t('ai.role.' + state.user.role, state.user.role)) + '</span></div>' +
        '<div class="ai-welcome-desc">' + escHtml(t('ai.welcome.' + state.user.role, '')) + '</div>' +
        '<div class="ai-quick-btns">' + list.map((tp) => '<button class="ai-quick-btn" type="button" data-topic="' + tp + '">' + escHtml(t('ai.quick.' + tp, tp)) + '</button>').join('') + '</div>' +
        '<div class="ai-scope-note">🔒 ' + escHtml(t('ai.scope_note', 'I only use data your role can access.')) + '</div>' +
      '</div>';
    body.querySelectorAll('[data-topic]').forEach((b) => b.addEventListener('click', () => quick(b.dataset.topic)));
    renderStrip();
  }

  // ── Messages ──
  function append(role, text, opts) {
    const body = $('ai-body'); if (!body) return null;
    const w = body.querySelector('.ai-welcome'); if (w) w.remove();
    const div = document.createElement('div');
    div.className = 'ai-msg ai-msg-' + (role === 'user' ? 'user' : 'bot') + (opts && opts.error ? ' ai-msg-error' : '');
    div.innerHTML = role === 'user' ? escHtml(text) : fmt(text);
    body.appendChild(div); body.scrollTop = body.scrollHeight;
    return div;
  }
  function showTyping() {
    const body = $('ai-body'); if (!body) return;
    const d = document.createElement('div'); d.className = 'ai-msg-typing'; d.id = 'ai-typing';
    d.innerHTML = '<span></span><span></span><span></span>';
    body.appendChild(d); body.scrollTop = body.scrollHeight;
  }
  const hideTyping = () => { const el = $('ai-typing'); if (el) el.remove(); };

  function errorText(e) {
    if (e && e.networkError) return t('ai.err_network', 'No connection to the server.');
    if (e && e.status === 429) return t('ai.err_rate', 'Too many requests — wait a minute and try again.');
    if (e && e.status === 403) return t('ai.err_forbidden', 'This action is not available for your role.');
    if (e && e.status === 401) return t('ai.err_auth', 'Session expired — please sign in again.');
    return t('ai.err_generic', 'Could not get an answer.');
  }

  async function run(label, call) {
    if (!state.user || state.loading) return;
    state.loading = true; state.last = { label, call };
    $('ai-send').disabled = true; setStatus('thinking');
    append('user', label); state.messages.push({ role: 'user', text: label });
    renderStrip(); showTyping();
    try {
      const res = await call();
      hideTyping();
      if (res.sessionId) saveSession(res.sessionId);
      state.messages.push({ role: 'bot', text: res.text });
      append('bot', res.text);
      state.last = null; setStatus('ready');
    } catch (e) {
      hideTyping(); setStatus('error');
      const div = append('bot', '⚠️ ' + errorText(e), { error: true });
      if (div && !(e && (e.status === 401 || e.status === 403))) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'ai-retry'; b.textContent = '↻ ' + t('ai.retry', 'Retry');
        b.addEventListener('click', () => { div.remove(); state.messages.pop(); retry(); });
        div.appendChild(document.createElement('br')); div.appendChild(b);
      }
    } finally {
      state.loading = false; $('ai-send').disabled = false;
    }
  }
  function retry() {
    const l = state.last; if (!l) return;
    // убираем прошлое пользовательское сообщение из DOM, чтобы не дублировать
    const body = $('ai-body'); const users = body.querySelectorAll('.ai-msg-user'); if (users.length) users[users.length - 1].remove();
    state.messages.pop();
    state.loading = false; state.last = null;
    run(l.label, l.call);
  }

  function ask() {
    const inp = $('ai-input'); const text = (inp.value || '').trim();
    if (!text || state.loading) return;
    inp.value = ''; inp.style.height = 'auto';
    run(text, () => AP.api.ai.assistantAsk(text, lang(), state.sessionId));
  }
  function quick(topic) {
    if (state.loading) return;
    run(t('ai.quick.' + topic, topic), () => AP.api.ai.assistantAction(topic, lang(), state.sessionId));
  }

  document.addEventListener('ap:lang-changed', () => { applyLabels(); if (state.open && !state.messages.length) renderWelcome(); });

  global.AP = global.AP || {};
  global.AP.aiChat = { setUser, show: () => { if (!state.open) toggle(); }, hide: () => { if (state.open) toggle(); }, clear };
  inject();
})(window);
