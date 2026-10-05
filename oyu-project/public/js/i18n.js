// ============================================================
// Academic Portal — i18n
// Загружает /i18n/{lang}.json, даёт t('path.to.key'), обновляет
// все элементы с data-i18n при смене языка.
// ============================================================
(function (global) {
  'use strict';

  const SUPPORTED = ['az', 'ru', 'en'];
  const STORAGE_KEY = 'ap_lang';

  let dict = {};
  let currentLang = (localStorage.getItem(STORAGE_KEY) || detectBrowser() || 'az');
  if (!SUPPORTED.includes(currentLang)) currentLang = 'az';

  function detectBrowser() {
    const l = (navigator.language || '').slice(0, 2).toLowerCase();
    return SUPPORTED.includes(l) ? l : null;
  }

  function t(key, fallback) {
    const parts = key.split('.');
    let node = dict;
    for (const p of parts) {
      if (node && typeof node === 'object' && p in node) node = node[p];
      else return fallback !== undefined ? fallback : key;
    }
    return typeof node === 'string' ? node : (fallback !== undefined ? fallback : key);
  }

  async function load(lang) {
    const target = SUPPORTED.includes(lang) ? lang : 'az';
    try {
      const res = await fetch('/i18n/' + target + '.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('i18n fetch failed');
      dict = await res.json();
      currentLang = target;
      localStorage.setItem(STORAGE_KEY, target);
      document.documentElement.lang = target;
      applyToDom();
      document.dispatchEvent(new CustomEvent('ap:lang-changed', { detail: { lang: target } }));
    } catch (e) {
      console.error('[i18n] failed to load', target, e);
    }
  }

  function applyToDom() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      el.textContent = t(key);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const key = el.getAttribute('data-i18n-placeholder');
      el.setAttribute('placeholder', t(key));
    });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const key = el.getAttribute('data-i18n-title');
      el.setAttribute('title', t(key));
    });
  }

  function getLang() { return currentLang; }

  global.AP = global.AP || {};
  global.AP.i18n = { t, load, getLang, applyToDom, SUPPORTED };
})(window);
