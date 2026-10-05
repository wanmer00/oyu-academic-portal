// ============================================================
// Мини-графики на чистом HTML/CSS (без внешних библиотек).
// Вызывающий код рисует график ТОЛЬКО если у бэкенда есть данные.
// ============================================================
(function (global) {
  'use strict';
  const AP = (global.AP = global.AP || {});
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * Столбцы; series: [{ key, color, label }], rows: [{ label, [key]: number }].
   * Несколько series складываются в стек. valueFmt — подпись над столбцом (итог).
   */
  function columns(rows, series, opts) {
    opts = opts || {};
    const totals = rows.map((r) => series.reduce((a, s) => a + (Number(r[s.key]) || 0), 0));
    const max = opts.max || Math.max(1, ...totals);
    const cols = rows.map((r, i) => {
      const h = Math.round((totals[i] / max) * 100);
      const segs = series.map((s) => {
        const v = Number(r[s.key]) || 0;
        const sh = totals[i] ? (v / totals[i]) * 100 : 0;
        return v ? '<div class="seg" style="height:' + sh + '%;background:' + s.color + '" title="' + esc(s.label + ': ' + v) + '"></div>' : '';
      }).join('');
      const val = opts.valueFmt ? opts.valueFmt(r, totals[i]) : totals[i];
      return '<div class="col" title="' + esc(r.label + ' — ' + val) + '"><div class="val">' + esc(val) + '</div>' +
        '<div class="stack" style="height:' + h + '%">' + segs + '</div><div class="lbl">' + esc(r.label) + '</div></div>';
    }).join('');
    const legend = series.length > 1
      ? '<div class="legend">' + series.map((s) => '<span><i style="background:' + s.color + '"></i>' + esc(s.label) + '</span>').join('') + '</div>'
      : '';
    return '<div class="chart" role="img" aria-label="' + esc(opts.aria || '') + '">' + cols + '</div>' + legend;
  }

  /** Горизонтальные полосы: items [{ label, value, color? }] */
  function hbars(items, opts) {
    opts = opts || {};
    const max = opts.max || Math.max(1, ...items.map((i) => Number(i.value) || 0));
    return items.map((i) =>
      '<div class="hbar"><span title="' + esc(i.label) + '" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(i.label) + '</span>' +
      '<div class="track"><div class="fill" style="width:' + Math.round(((Number(i.value) || 0) / max) * 100) + '%;background:' + (i.color || '#2563eb') + '"></div></div>' +
      '<b style="text-align:right">' + esc(opts.fmt ? opts.fmt(i) : i.value) + '</b></div>').join('');
  }

  const shortWeek = (iso, lang) => {
    try { return new Date(iso + 'T00:00:00Z').toLocaleDateString(lang === 'en' ? 'en-GB' : lang === 'ru' ? 'ru-RU' : 'az-AZ', { day: '2-digit', month: '2-digit' }); } catch { return iso; }
  };

  AP.charts = { columns, hbars, shortWeek };
})(window);
