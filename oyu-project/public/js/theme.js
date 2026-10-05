// ============================================================
// Academic Portal — Theme toggle (light / dark)
// Usage: include this script, add data-theme-toggle attribute to any element,
// or call AP.theme.toggle() manually.
// ============================================================
(function (global) {
  'use strict';
  const KEY = 'ap-theme';

  function apply(th) {
    document.documentElement.setAttribute('data-theme', th);
    try { localStorage.setItem(KEY, th); } catch {}
    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
      btn.classList.toggle('dark', th === 'dark');
      btn.classList.toggle('light', th !== 'dark');
      btn.setAttribute('aria-pressed', th === 'dark' ? 'true' : 'false');
      const ic = btn.querySelector('[data-theme-icon]');
      if (ic) ic.textContent = th === 'dark' ? '🌙' : '☀️';
    });
    document.dispatchEvent(new CustomEvent('ap:theme-changed', { detail: { theme: th } }));
  }

  function toggle() {
    const cur = document.documentElement.getAttribute('data-theme') || 'light';
    apply(cur === 'dark' ? 'light' : 'dark');
  }

  function get() {
    return document.documentElement.getAttribute('data-theme') || 'light';
  }

  function init() {
    let saved = 'light';
    try { saved = localStorage.getItem(KEY) || 'light'; } catch {}
    apply(saved);
    // Auto-attach toggle behaviour to any [data-theme-toggle] element
    document.addEventListener('click', (e) => {
      const t = e.target.closest && e.target.closest('[data-theme-toggle]');
      if (t) { e.preventDefault(); toggle(); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.AP = global.AP || {};
  global.AP.theme = { apply, toggle, get };
})(window);
