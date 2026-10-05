// ============================================================
// Timetable settings: нагрузка (requirements), временная сетка, рабочие дни,
// приоритеты мягких ограничений, типы занятий, правила (доступность, предпочтения,
// лимиты групп, корпуса), аудитории. Данные — /timetable/* и /admin/rooms.
// ============================================================
(function (global) {
  'use strict';
  const AP = (global.AP = global.AP || {});

  function create(H) {
    const { S, api, t, esc, $, errMsg, skel, empty, errBox, retry, sel, fsel, dayName, toast, openModal, confirmDialog, periodQ, canDo } = H;
    const refsOrLoad = async () => { if (!S.refs) S.refs = await api().refs(periodQ()); return S.refs; };
    const chk = (id, label, on) => '<label class="tt-chk"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '> ' + esc(label) + '</label>';
    const inp = (id, label, val, extra) => '<div class="form-group"><div class="form-label">' + esc(label) + '</div><input class="input" id="' + id + '" value="' + esc(val == null ? '' : val) + '" ' + (extra || '') + '></div>';
    const multi = (name, opts, cur) => '<div class="tt-checks" data-multi="' + name + '">' + opts.map(([v, l]) => '<label class="tt-chk"><input type="checkbox" value="' + esc(v) + '"' + ((cur || []).map(String).includes(String(v)) ? ' checked' : '') + '> ' + esc(l) + '</label>').join('') + '</div>';
    const picked = (root, name) => Array.from(root.querySelectorAll('[data-multi="' + name + '"] input:checked')).map((c) => c.value);

    // ═════════════════════════ REQUIREMENTS ═════════════════════════
    const R = { page: 1, search: '', group: '', type: '' };
    async function requirements(box) {
      const r = await refsOrLoad();
      const d = await api().requirements({ academicYear: S.year, term: S.term, page: R.page, pageSize: 50, search: R.search, group: R.group, type: R.type, versionId: S.vid || undefined });
      const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
      box.innerHTML =
        '<div class="au-note">' + esc(t('tt.req.hint')) + '</div>' +
        '<div class="au-bar"><label class="fld grow"><span>' + esc(t('common.search')) + '</span><input class="input" id="rq-search" value="' + esc(R.search) + '"></label>' +
          sel('rq-group', t('tt.group'), [['', t('common.all')]].concat(r.groups.map((g) => [g.name, g.name])), R.group) +
          sel('rq-type', t('tt.type'), [['', t('common.all')]].concat(r.lessonTypes.map((x) => [x.code, x.name])), R.type) +
          '<div style="flex:1"></div>' + (canDo('schedule.settings') ? '<button class="btn btn-outline" id="rq-build">⚙ ' + esc(t('tt.req.build')) + '</button><button class="btn btn-outline" id="rq-import">⇪ ' + esc(t('tt.import')) + '</button><button class="btn btn-success" id="rq-add">+ ' + esc(t('tt.req.add')) + '</button>' : '') + '</div>' +
        '<div class="card" style="overflow:hidden">' + (d.items.length ? '<div class="au-table"><table><thead><tr><th>' + esc(t('tt.subject')) + '</th><th>' + esc(t('tt.group')) + '</th><th>' + esc(t('tt.teacher')) + '</th><th>' + esc(t('tt.type')) + '</th><th>' + esc(t('tt.req.per_week')) + '</th><th>' + esc(t('tt.req.placed')) + '</th><th></th></tr></thead><tbody>' +
          d.items.map((x) => {
            const lt = r.lessonTypes.find((y) => y.code === x.lessonTypeCode);
            const ok = x.placed == null ? '' : x.placed >= x.sessionsPerWeek ? 'badge-success' : 'badge-danger';
            return '<tr><td><b>' + esc(x.subject.code) + '</b> · ' + esc(x.subject.name) + '</td><td>' + esc(x.groupNames.join(', ')) + '<div class="au-muted">' + x.students + ' ' + esc(t('ld.students_short')) + '</div></td>' +
              '<td>' + (x.teacher ? esc(x.teacher.name) : '<span class="badge badge-warning">' + esc(t('ld.no_teacher')) + '</span>') + '</td>' +
              '<td>' + esc(lt ? lt.name : x.lessonTypeCode) + (x.weekParity !== 'BOTH' ? '<div class="au-muted">' + esc(t('ld.parity.' + x.weekParity)) + '</div>' : '') + (x.durationSlots > 1 ? '<div class="au-muted">×' + x.durationSlots + '</div>' : '') + '</td>' +
              '<td>' + x.sessionsPerWeek + '</td><td>' + (x.placed == null ? '—' : '<span class="badge ' + ok + '">' + x.placed + '/' + x.sessionsPerWeek + '</span>') + '</td>' +
              '<td style="white-space:nowrap">' + (canDo('schedule.settings') ? '<button class="btn btn-outline btn-sm" data-edit="' + esc(x.id) + '">' + esc(t('common.edit')) + '</button> <button class="btn btn-danger btn-sm" data-del="' + esc(x.id) + '" aria-label="' + esc(t('common.delete')) + '">✕</button>' : '') + '</td></tr>';
          }).join('') + '</tbody></table></div>' : empty(t('tt.req.none'))) + '</div>' +
        '<div class="au-bar" style="margin-top:10px"><span class="au-muted">' + esc(t('tt.total')) + ': ' + d.total + '</span><div style="flex:1"></div><button class="btn btn-outline btn-sm" id="rq-prev"' + (R.page <= 1 ? ' disabled' : '') + '>‹</button><span class="au-muted"> ' + R.page + ' / ' + pages + ' </span><button class="btn btn-outline btn-sm" id="rq-next"' + (R.page >= pages ? ' disabled' : '') + '>›</button></div>';
      const again = () => requirements(box);
      let tm; $('rq-search').addEventListener('input', (e) => { clearTimeout(tm); tm = setTimeout(() => { R.search = e.target.value.trim(); R.page = 1; again(); }, 400); });
      $('rq-group').addEventListener('change', (e) => { R.group = e.target.value; R.page = 1; again(); });
      $('rq-type').addEventListener('change', (e) => { R.type = e.target.value; R.page = 1; again(); });
      $('rq-prev').addEventListener('click', () => { R.page--; again(); }); $('rq-next').addEventListener('click', () => { R.page++; again(); });
      if ($('rq-build')) { $('rq-build').addEventListener('click', () => buildDialog(again)); $('rq-import').addEventListener('click', () => importDialog(again)); $('rq-add').addEventListener('click', () => reqDialog(null, again)); }
      box.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => reqDialog(d.items.find((x) => x.id === b.dataset.edit), again)));
      box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        if (!(await confirmDialog({ danger: true, confirmLabel: t('common.delete'), message: t('tt.req.confirm_delete') }))) return;
        try { await api().deleteRequirement(b.dataset.del); toast(t('ld.deleted')); again(); } catch (e) { toast(errMsg(e), true); }
      }));
    }

    function reqDialog(x, again) {
      const r = S.refs;
      const gs = new Set(x ? x.groupNames : []);
      const m = openModal({
        title: x ? t('tt.req.edit') : t('tt.req.add'), wide: true, static: true,
        html: '<div class="form-grid">' + fsel('q-subj', t('tt.subject'), r.subjects.map((s) => [s.id, s.code + ' · ' + s.name]), x ? x.subject.id : (r.subjects[0] || {}).id) +
          fsel('q-teacher', t('tt.teacher'), [['', '— ' + t('ld.no_teacher')]].concat(r.teachers.map((y) => [y.id, y.name])), x && x.teacher ? x.teacher.id : '') +
          fsel('q-type', t('tt.type'), r.lessonTypes.map((y) => [y.code, y.name]), x ? x.lessonTypeCode : 'lecture') +
          inp('q-n', t('tt.req.per_week'), x ? x.sessionsPerWeek : 1, 'type="number" min="1" max="14"') +
          fsel('q-dur', t('tt.req.duration'), [1, 2, 3].map((n) => [String(n), String(n)]), x ? String(x.durationSlots) : '1') +
          fsel('q-par', t('tt.parity'), ['BOTH', 'UPPER', 'LOWER'].map((p) => [p, t('ld.parity.' + p)]), x ? x.weekParity : 'BOTH') +
          fsel('q-rt', t('tt.room_type'), [['', t('tt.any')]].concat(r.roomTypes.map((y) => [y, t('tt.rt.' + y, y)])), x ? x.roomType || '' : '') + '</div>' +
          '<div class="form-group"><div class="form-label">' + esc(t('tt.groups')) + '</div><input class="input" id="q-gf" placeholder="' + esc(t('common.search')) + '"><div class="tt-checks" id="q-groups"></div></div><div class="au-err" id="q-err"></div>',
        buttons: [{ label: t('common.cancel') }, { label: t('common.save'), cls: 'btn-primary', onClick: async (h) => {
          const dto = { subjectId: h.$('#q-subj').value, teacherId: h.$('#q-teacher').value || null, lessonTypeCode: h.$('#q-type').value, sessionsPerWeek: Number(h.$('#q-n').value) || 1, durationSlots: Number(h.$('#q-dur').value), weekParity: h.$('#q-par').value, roomType: h.$('#q-rt').value || null, groupNames: Array.from(gs) };
          if (!dto.groupNames.length) { h.$('#q-err').textContent = t('tt.err_groups'); return false; }
          try { if (x) await api().patchRequirement(x.id, dto); else await api().createRequirement(Object.assign({ academicYear: S.year, term: S.term }, dto)); toast(t('ld.saved')); again(); }
          catch (e) { h.$('#q-err').textContent = errMsg(e); return false; }
        } }],
      });
      const draw = () => {
        const q = m.$('#q-gf').value.trim().toLowerCase();
        m.$('#q-groups').innerHTML = r.groups.filter((g) => gs.has(g.name) || !q || g.name.toLowerCase().includes(q)).slice(0, 80).map((g) => '<label class="tt-chk"><input type="checkbox" data-g="' + esc(g.name) + '"' + (gs.has(g.name) ? ' checked' : '') + '> ' + esc(g.name) + '</label>').join('');
        m.$('#q-groups').querySelectorAll('[data-g]').forEach((c) => c.addEventListener('change', () => { c.checked ? gs.add(c.dataset.g) : gs.delete(c.dataset.g); }));
      };
      m.$('#q-gf').addEventListener('input', draw); draw();
    }

    function buildDialog(again) {
      const r = S.refs;
      openModal({
        title: t('tt.req.build'), static: true,
        html: '<div class="au-note">' + esc(t('tt.req.build_hint')) + '</div><div class="form-grid">' +
          fsel('b-fac', t('tt.faculty'), [['', t('common.all')]].concat(r.faculties.map((f) => [f, f])), '') +
          fsel('b-lvl', t('tt.level'), [['', t('common.all')]].concat(r.levels.map((f) => [f, t('ld.level.' + f, f)])), '') +
          fsel('b-lec', t('tt.req.lecture_n'), [1, 2, 3].map((n) => [String(n), String(n)]), '1') +
          fsel('b-sem', t('tt.req.seminar_n'), [0, 1, 2, 3].map((n) => [String(n), String(n)]), '1') +
          fsel('b-stream', t('tt.req.stream'), [1, 2, 3, 4].map((n) => [String(n), n === 1 ? t('tt.req.no_stream') : t('tt.req.stream_n').replace('{n}', n)]), '1') + '</div>' +
          chk('b-rep', t('tt.req.replace'), false) + '<div class="au-err" id="b-err"></div>',
        buttons: [{ label: t('common.cancel') }, { label: t('tt.req.build'), cls: 'btn-primary', onClick: async (h) => {
          const pattern = [{ lessonTypeCode: 'lecture', sessionsPerWeek: Number(h.$('#b-lec').value), durationSlots: 1 }];
          if (Number(h.$('#b-sem').value)) pattern.push({ lessonTypeCode: 'seminar', sessionsPerWeek: Number(h.$('#b-sem').value), durationSlots: 1 });
          const dto = { academicYear: S.year, term: S.term, pattern, replace: h.$('#b-rep').checked, streamLectures: Number(h.$('#b-stream').value) };
          if (h.$('#b-fac').value) dto.faculty = h.$('#b-fac').value;
          if (h.$('#b-lvl').value) dto.level = h.$('#b-lvl').value;
          if (dto.replace && !(await confirmDialog({ danger: true, message: t('tt.req.replace_confirm') }))) return false;
          try { const res = await api().buildRequirements(dto); toast(t('tt.req.built').replace('{n}', res.created).replace('{g}', res.groups)); again(); }
          catch (e) { h.$('#b-err').textContent = errMsg(e); return false; }
        } }],
      });
    }

    // CSV: subjectCode;groups;teacherLoginId;lessonType;sessionsPerWeek;durationSlots;parity;roomType
    function importDialog(again) {
      const COLS = ['subjectCode', 'groups', 'teacherLoginId', 'lessonType', 'sessionsPerWeek', 'durationSlots', 'parity', 'roomType'];
      let rows = null;
      const m = openModal({
        title: '⇪ ' + t('tt.import'), wide: true, static: true,
        html: '<div class="au-note">' + esc(t('tt.imp.hint')) + '<br><code>' + COLS.join(';') + '</code></div>' +
          '<div class="au-bar"><button class="btn btn-outline btn-sm" id="im-tpl">⇩ ' + esc(t('tt.imp.template')) + '</button><input type="file" id="im-file" accept=".csv,text/csv"></div><div id="im-out"></div>',
        buttons: [{ label: t('common.cancel') }, { id: 'apply', label: t('tt.imp.apply'), cls: 'btn-primary', hidden: true, onClick: async () => {
          try { const res = await api().importRequirements({ academicYear: S.year, term: S.term, dryRun: false, rows }); toast(t('tt.imp.done').replace('{c}', res.created).replace('{u}', res.updated)); if (again) again(); }
          catch (e) { toast(errMsg(e), true); return false; }
        } }],
      });
      m.$('#im-tpl').addEventListener('click', () => H.saveBlob(new Blob(['﻿' + COLS.join(';') + '\r\nCS201;Group 1,Group 2;teacher2.demo;lecture;1;1;BOTH;lecture_hall\r\n'], { type: 'text/csv' }), 'timetable-requirements-template.csv'));
      m.$('#im-file').addEventListener('change', async (e) => {
        const f = e.target.files[0]; if (!f) return;
        const out = m.$('#im-out');
        try {
          const table = AP.tui.parseCsv(await f.text());
          const head = table[0].map((x) => x.trim());
          const idx = (k) => head.findIndex((x) => x.toLowerCase() === k.toLowerCase());
          if (idx('subjectCode') < 0 || idx('groups') < 0 || idx('lessonType') < 0) throw new Error(t('tt.imp.bad_header'));
          rows = table.slice(1).map((c) => {
            const o = {}; COLS.forEach((k) => { const v = (c[idx(k)] || '').trim(); if (v !== '' && idx(k) >= 0) o[k] = v; }); return o;
          }).filter((o) => o.subjectCode);
          const res = await api().importRequirements({ academicYear: S.year, term: S.term, dryRun: true, rows });
          out.innerHTML = '<div class="au-note">' + esc(t('tt.imp.preview').replace('{n}', res.total).replace('{e}', res.errors)) + '</div>' +
            (res.rows.length ? '<ul class="tt-ul">' + res.rows.map((x) => '<li>#' + (x.index + 2) + ': ' + esc(x.errors.join('; ')) + '</li>').join('') + '</ul>' : '');
          m.show('apply', res.errors === 0);
        } catch (err) { out.innerHTML = '<div class="au-err">' + esc(errMsg(err)) + '</div>'; m.show('apply', false); }
      });
    }

    // ═════════════════════════ SETTINGS (подвкладки) ═════════════════════════
    const ST = { sub: H.S.sub || 'general' };
    async function settings(box) {
      await refsOrLoad();
      const subs = ['general', 'slots', 'types', 'rules', 'rooms'];
      box.innerHTML = '<div class="tt-tabs">' + subs.map((k) => '<button class="chip-btn' + (ST.sub === k ? ' active' : '') + '" data-sub="' + k + '">' + esc(t('tt.set.' + k)) + '</button>').join('') + '</div><div id="st-body">' + skel(3) + '</div>';
      box.querySelectorAll('[data-sub]').forEach((b) => b.addEventListener('click', () => { ST.sub = b.dataset.sub; H.S.sub = ST.sub; settings(box); }));
      const body = $('st-body');
      try {
        if (ST.sub === 'general') await general(body);
        else if (ST.sub === 'slots') await slots(body);
        else if (ST.sub === 'types') await types(body);
        else if (ST.sub === 'rules') await rules(body);
        else await rooms(body);
      } catch (e) { body.innerHTML = errBox(e); }
    }
    const refresh = async () => { S.refs = await api().refs(periodQ()); };

    // ── общие: рабочие дни, лимиты, приоритеты ──
    async function general(body) {
      const r = S.refs, c = r.config, w = Object.assign({}, r.defaultWeights, c.softWeights || {});
      body.innerHTML = '<div class="card"><div class="card-pad"><div class="card-title">' + esc(t('tt.set.general')) + ' · ' + esc(S.year + ' ' + t('tt.term.' + S.term)) + '</div>' +
        '<div class="form-group"><div class="form-label">' + esc(t('tt.set.working_days')) + '</div>' + multi('days', [1, 2, 3, 4, 5, 6, 7].map((d) => [d, dayName(d)]), c.workingDays) + '</div>' +
        '<div class="form-grid">' + inp('g-cons', t('tt.set.max_consecutive'), c.maxConsecutive, 'type="number" min="1" max="10"') + inp('g-daily', t('tt.set.max_daily'), c.maxDailyLessons, 'type="number" min="1" max="12"') + inp('g-time', t('tt.set.time_limit'), c.timeLimitSec, 'type="number" min="5" max="1800"') + '</div>' +
        '<div class="card-title" style="margin-top:14px">' + esc(t('tt.set.weights')) + '</div><div class="au-muted">' + esc(t('tt.set.weights_hint')) + '</div>' +
        '<div class="form-grid tt-weights">' + Object.keys(r.defaultWeights).map((k) => '<div class="form-group"><div class="form-label">' + esc(t('tt.w.' + k, k)) + '</div><input class="input" type="number" min="0" max="100" step="0.5" data-w="' + esc(k) + '" value="' + esc(w[k]) + '"></div>').join('') + '</div>' +
        '<div class="au-err" id="g-err"></div><div style="margin-top:12px"><button class="btn btn-primary" id="g-save">' + esc(t('common.save')) + '</button> <button class="btn btn-outline" id="g-reset">' + esc(t('tt.set.reset_weights')) + '</button></div></div></div>';
      $('g-reset').addEventListener('click', () => body.querySelectorAll('[data-w]').forEach((i) => { i.value = r.defaultWeights[i.dataset.w]; }));
      $('g-save').addEventListener('click', async () => {
        const softWeights = {}; body.querySelectorAll('[data-w]').forEach((i) => { softWeights[i.dataset.w] = Number(i.value); });
        const dto = { workingDays: picked(body, 'days').map(Number), maxConsecutive: Number($('g-cons').value), maxDailyLessons: Number($('g-daily').value), timeLimitSec: Number($('g-time').value), softWeights };
        try { await api().patchConfig(periodQ(), dto); await refresh(); toast(t('ld.saved')); } catch (e) { $('g-err').textContent = errMsg(e); }
      });
    }

    // ── временная сетка ──
    async function slots(body) {
      const list = await api().timeSlots();
      body.innerHTML = '<div class="au-bar"><span class="au-muted">' + esc(t('tt.set.slots_hint')) + '</span><div style="flex:1"></div><button class="btn btn-success" id="sl-add">+ ' + esc(t('tt.set.add_slot')) + '</button></div>' +
        '<div class="card" style="overflow:hidden"><div class="au-table"><table><thead><tr><th>' + esc(t('tt.set.code')) + '</th><th>' + esc(t('tt.name')) + '</th><th>' + esc(t('tt.time')) + '</th><th>' + esc(t('tt.level')) + '</th><th>' + esc(t('tt.set.shift')) + '</th><th>' + esc(t('common.status')) + '</th><th></th></tr></thead><tbody>' +
        list.map((s) => '<tr><td><code>' + esc(s.code) + '</code></td><td>' + esc(s.label) + '</td><td>' + esc(s.startTime + '–' + s.endTime) + '</td><td>' + (s.level ? esc(t('ld.level.' + s.level, s.level)) : '—') + '</td><td>' + esc(s.shift || '—') + '</td><td>' + (s.isActive ? '<span class="badge badge-success">' + esc(t('tt.active')) + '</span>' : '<span class="badge badge-gray">' + esc(t('tt.inactive')) + '</span>') + '</td>' +
          '<td style="white-space:nowrap"><button class="btn btn-outline btn-sm" data-e="' + esc(s.id) + '">' + esc(t('common.edit')) + '</button> <button class="btn btn-danger btn-sm" data-d="' + esc(s.id) + '">✕</button></td></tr>').join('') + '</tbody></table></div></div>';
      const again = async () => { await refresh(); await slots(body); };
      $('sl-add').addEventListener('click', () => slotDialog(null, again));
      body.querySelectorAll('[data-e]').forEach((b) => b.addEventListener('click', () => slotDialog(list.find((x) => x.id === b.dataset.e), again)));
      body.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', async () => {
        if (!(await confirmDialog({ danger: true, confirmLabel: t('common.delete'), message: t('tt.set.confirm_delete_slot') }))) return;
        try { await api().deleteTimeSlot(b.dataset.d); toast(t('ld.deleted')); again(); } catch (e) { toast(errMsg(e), true); }
      }));
    }
    function slotDialog(s, again) {
      openModal({
        title: s ? t('common.edit') : t('tt.set.add_slot'), static: true,
        html: '<div class="form-grid">' + (s ? '' : inp('s-code', t('tt.set.code'), '', 'maxlength="30"')) + inp('s-label', t('tt.name'), s ? s.label : '', 'maxlength="30"') +
          '<div class="form-group"><div class="form-label">' + esc(t('ld.start')) + '</div><input class="input" type="time" id="s-start" value="' + esc(s ? s.startTime : '08:00') + '"></div>' +
          '<div class="form-group"><div class="form-label">' + esc(t('ld.end')) + '</div><input class="input" type="time" id="s-end" value="' + esc(s ? s.endTime : '09:20') + '"></div>' +
          fsel('s-level', t('tt.level'), [['', t('tt.any')], ['BACHELOR', t('ld.level.BACHELOR')], ['MASTER', t('ld.level.MASTER')], ['PHD', t('ld.level.PHD')]], s ? s.level || '' : '') +
          inp('s-shift', t('tt.set.shift'), s ? s.shift || '' : '', 'maxlength="20"') + inp('s-sort', t('tt.set.sort'), s ? s.sortOrder : 0, 'type="number" min="0" max="999"') + '</div>' +
          chk('s-act', t('tt.active'), s ? s.isActive : true) + '<div class="au-err" id="s-err"></div>',
        buttons: [{ label: t('common.cancel') }, { label: t('common.save'), cls: 'btn-primary', onClick: async (h) => {
          const dto = { label: h.$('#s-label').value.trim(), startTime: h.$('#s-start').value, endTime: h.$('#s-end').value, level: h.$('#s-level').value || null, shift: h.$('#s-shift').value.trim() || null, sortOrder: Number(h.$('#s-sort').value) || 0, isActive: h.$('#s-act').checked };
          try { if (s) await api().patchTimeSlot(s.id, dto); else await api().createTimeSlot(Object.assign({ code: h.$('#s-code').value.trim() }, dto)); toast(t('ld.saved')); again(); }
          catch (e) { h.$('#s-err').textContent = errMsg(e); return false; }
        } }],
      });
    }

    // ── типы занятий ──
    async function types(body) {
      const list = await api().lessonTypes();
      body.innerHTML = '<div class="au-bar"><span class="au-muted">' + esc(t('tt.set.types_hint')) + '</span><div style="flex:1"></div><button class="btn btn-success" id="ty-add">+ ' + esc(t('tt.set.add_type')) + '</button></div>' +
        '<div class="card" style="overflow:hidden"><div class="au-table"><table><thead><tr><th>' + esc(t('tt.set.code')) + '</th><th>' + esc(t('tt.name')) + '</th><th>' + esc(t('tt.room_type')) + '</th><th>' + esc(t('tt.set.needs_room')) + '</th><th>' + esc(t('common.status')) + '</th><th></th></tr></thead><tbody>' +
        list.map((x) => '<tr><td><span class="tt-dot" style="background:' + esc(x.color || '#94a3b8') + '"></span><code>' + esc(x.code) + '</code></td><td>' + esc(x.name) + '</td><td>' + (x.roomTypes.length ? esc(x.roomTypes.map((y) => t('tt.rt.' + y, y)).join(', ')) : esc(t('tt.any'))) + '</td><td>' + (x.needsRoom ? '✓' : '—') + '</td><td>' + (x.isActive ? '<span class="badge badge-success">' + esc(t('tt.active')) + '</span>' : '<span class="badge badge-gray">' + esc(t('tt.inactive')) + '</span>') + '</td>' +
          '<td style="white-space:nowrap"><button class="btn btn-outline btn-sm" data-e="' + esc(x.id) + '">' + esc(t('common.edit')) + '</button> <button class="btn btn-danger btn-sm" data-d="' + esc(x.id) + '">✕</button></td></tr>').join('') + '</tbody></table></div></div>';
      const again = async () => { await refresh(); await types(body); };
      $('ty-add').addEventListener('click', () => typeDialog(null, again));
      body.querySelectorAll('[data-e]').forEach((b) => b.addEventListener('click', () => typeDialog(list.find((x) => x.id === b.dataset.e), again)));
      body.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', async () => {
        if (!(await confirmDialog({ danger: true, confirmLabel: t('common.delete'), message: t('tt.set.confirm_delete_type') }))) return;
        try { await api().deleteLessonType(b.dataset.d); toast(t('ld.deleted')); again(); } catch (e) { toast(errMsg(e), true); }
      }));
    }
    function typeDialog(x, again) {
      const r = S.refs;
      openModal({
        title: x ? t('common.edit') : t('tt.set.add_type'), static: true,
        html: '<div class="form-grid">' + (x ? '' : inp('y-code', t('tt.set.code'), '', 'maxlength="30"')) + inp('y-name', t('tt.name'), x ? x.name : '', 'maxlength="60"') +
          '<div class="form-group"><div class="form-label">' + esc(t('tt.set.color')) + '</div><input class="input" type="color" id="y-color" value="' + esc(x && x.color ? x.color : '#2563eb') + '"></div></div>' +
          '<div class="form-group"><div class="form-label">' + esc(t('tt.set.allowed_rooms')) + '</div>' + multi('rt', r.roomTypes.map((y) => [y, t('tt.rt.' + y, y)]), x ? x.roomTypes : []) + '</div>' +
          chk('y-nr', t('tt.set.needs_room'), x ? x.needsRoom : true) + chk('y-act', t('tt.active'), x ? x.isActive : true) + '<div class="au-err" id="y-err"></div>',
        buttons: [{ label: t('common.cancel') }, { label: t('common.save'), cls: 'btn-primary', onClick: async (h) => {
          const dto = { name: h.$('#y-name').value.trim(), color: h.$('#y-color').value, roomTypes: picked(h.el, 'rt'), needsRoom: h.$('#y-nr').checked, isActive: h.$('#y-act').checked };
          try { if (x) await api().patchLessonType(x.id, dto); else await api().createLessonType(Object.assign({ code: h.$('#y-code').value.trim() }, dto)); toast(t('ld.saved')); again(); }
          catch (e) { h.$('#y-err').textContent = errMsg(e); return false; }
        } }],
      });
    }

    // ── правила: доступность, предпочтения, лимиты, корпуса ──
    const RS = { scope: '' };
    async function rules(body) {
      const d = await api().rules({ scope: RS.scope, take: 200 });
      const items = d.items || d;
      const r = S.refs;
      const nameOf = (x) => x.scope === 'GLOBAL' ? t('tt.rule.global') : x.scope === 'TEACHER' ? (r.teachers.find((y) => y.id === x.targetId) || {}).name || x.targetId : x.scope === 'ROOM' ? (r.rooms.find((y) => y.id === x.targetId) || {}).code || x.targetId : x.scope === 'SUBJECT' ? ((r.subjects.find((y) => y.id === x.targetId) || {}).code || x.targetId) : x.targetId;
      const slotName = (id) => (r.timeSlots.find((s) => s.id === id) || {}).label || id;
      const detail = (x) => [x.days.length ? x.days.map((dd) => dayName(dd)).join(', ') : '', x.timeSlotIds.length ? x.timeSlotIds.map(slotName).join(', ') : '', x.value ? Object.entries(x.value).map(([k, v]) => k + '=' + (Array.isArray(v) ? v.join('/') : v)).join(' ') : ''].filter(Boolean).join(' · ');
      body.innerHTML = '<div class="au-bar">' + sel('ru-scope', t('tt.rule.scope_l'), [['', t('common.all')]].concat(['GLOBAL', 'TEACHER', 'GROUP', 'ROOM', 'BUILDING', 'SUBJECT'].map((x) => [x, t('tt.rule.scope.' + x)])), RS.scope) + '<div style="flex:1"></div><button class="btn btn-success" id="ru-add">+ ' + esc(t('tt.rule.add')) + '</button></div>' +
        '<div class="card" style="overflow:hidden">' + (items.length ? '<div class="au-table"><table><thead><tr><th>' + esc(t('tt.rule.scope_l')) + '</th><th>' + esc(t('tt.rule.kind_l')) + '</th><th>' + esc(t('tt.rule.params')) + '</th><th>' + esc(t('tt.rule.strength')) + '</th><th></th></tr></thead><tbody>' +
          items.map((x) => '<tr><td>' + esc(t('tt.rule.scope.' + x.scope)) + '<div class="au-muted">' + esc(nameOf(x)) + '</div></td><td>' + esc(t('tt.rule.kind.' + x.kind)) + '</td><td class="au-muted">' + esc(detail(x)) + (x.note ? '<div>' + esc(x.note) + '</div>' : '') + '</td><td>' + (x.hard ? '<span class="badge badge-danger">' + esc(t('tt.rule.hard')) + '</span>' : '<span class="badge badge-info">' + esc(t('tt.rule.soft')) + ' ×' + x.weight + '</span>') + '</td>' +
            '<td style="white-space:nowrap"><button class="btn btn-outline btn-sm" data-e="' + esc(x.id) + '">' + esc(t('common.edit')) + '</button> <button class="btn btn-danger btn-sm" data-d="' + esc(x.id) + '">✕</button></td></tr>').join('') + '</tbody></table></div>' : empty(t('tt.rule.none'))) + '</div>';
      $('ru-scope').addEventListener('change', (e) => { RS.scope = e.target.value; rules(body); });
      $('ru-add').addEventListener('click', () => ruleDialog(null, () => rules(body)));
      body.querySelectorAll('[data-e]').forEach((b) => b.addEventListener('click', () => ruleDialog(items.find((x) => x.id === b.dataset.e), () => rules(body))));
      body.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', async () => {
        if (!(await confirmDialog({ danger: true, confirmLabel: t('common.delete'), message: t('tt.rule.confirm_delete') }))) return;
        try { await api().deleteRule(b.dataset.d); toast(t('ld.deleted')); rules(body); } catch (e) { toast(errMsg(e), true); }
      }));
    }
    function ruleDialog(x, again) {
      const r = S.refs;
      const targets = (scope) => scope === 'TEACHER' ? r.teachers.map((y) => [y.id, y.name]) : scope === 'GROUP' ? r.groups.map((g) => [g.name, g.name]) : scope === 'ROOM' ? r.rooms.map((y) => [y.id, y.code]) : scope === 'BUILDING' ? r.buildings.map((b) => [b, b]) : scope === 'SUBJECT' ? r.subjects.map((s) => [s.id, s.code + ' · ' + s.name]) : [];
      const v = (x && x.value) || {};
      const m = openModal({
        title: x ? t('common.edit') : t('tt.rule.add'), wide: true, static: true,
        html: '<div class="form-grid">' + fsel('r-scope', t('tt.rule.scope_l'), ['GLOBAL', 'TEACHER', 'GROUP', 'ROOM', 'BUILDING', 'SUBJECT'].map((s) => [s, t('tt.rule.scope.' + s)]), x ? x.scope : 'TEACHER') +
          '<div id="r-target-box"></div>' +
          fsel('r-kind', t('tt.rule.kind_l'), ['UNAVAILABLE', 'PREFERRED', 'NO_LATE', 'MAX_PER_DAY', 'ALLOWED_BUILDINGS'].map((k) => [k, t('tt.rule.kind.' + k)]), x ? x.kind : 'UNAVAILABLE') +
          inp('r-weight', t('tt.rule.weight'), x ? x.weight : 3, 'type="number" min="1" max="20"') + '</div>' +
          chk('r-hard', t('tt.rule.hard_label'), x ? x.hard : false) +
          '<div class="form-group"><div class="form-label">' + esc(t('tt.day')) + ' (' + esc(t('tt.rule.empty_all')) + ')</div>' + multi('days', [1, 2, 3, 4, 5, 6, 7].map((d) => [d, dayName(d)]), x ? x.days : []) + '</div>' +
          '<div class="form-group"><div class="form-label">' + esc(t('tt.slot')) + ' (' + esc(t('tt.rule.empty_all')) + ')</div>' + multi('slots', r.timeSlots.filter((s) => s.isActive).map((s) => [s.id, s.label + ' ' + s.startTime]), x ? x.timeSlotIds : []) + '</div>' +
          '<div id="r-val"></div>' + inp('r-note', t('tt.rule.note'), x ? x.note || '' : '', 'maxlength="300"') + '<div class="au-err" id="r-err"></div>',
        buttons: [{ label: t('common.cancel') }, { label: t('common.save'), cls: 'btn-primary', onClick: async (h) => {
          const kind = h.$('#r-kind').value, scope = h.$('#r-scope').value;
          const dto = { scope, kind, targetId: scope === 'GLOBAL' ? null : (h.$('#r-target') || {}).value || null, hard: h.$('#r-hard').checked && kind !== 'PREFERRED', weight: Number(h.$('#r-weight').value) || 1, days: picked(h.el, 'days').map(Number), timeSlotIds: picked(h.el, 'slots'), note: h.$('#r-note').value.trim() || null };
          if (kind === 'MAX_PER_DAY') dto.value = { max: Number(h.$('#r-max').value) };
          if (kind === 'NO_LATE') dto.value = { fromOrder: Number(h.$('#r-from').value) };
          if (kind === 'ALLOWED_BUILDINGS') dto.value = { buildings: picked(h.el, 'bld') };
          try { if (x) await api().patchRule(x.id, dto); else await api().createRule(dto); toast(t('ld.saved')); again(); }
          catch (e) { h.$('#r-err').textContent = errMsg(e); return false; }
        } }],
      });
      const drawTarget = () => {
        const sc = m.$('#r-scope').value, opts = targets(sc);
        m.$('#r-target-box').innerHTML = sc === 'GLOBAL' ? '' : fsel('r-target', t('tt.rule.target'), opts, x && x.scope === sc ? x.targetId : (opts[0] || [''])[0]);
      };
      const drawVal = () => {
        const k = m.$('#r-kind').value;
        m.$('#r-val').innerHTML = k === 'MAX_PER_DAY' ? inp('r-max', t('tt.rule.max'), v.max || 4, 'type="number" min="1" max="12"')
          : k === 'NO_LATE' ? inp('r-from', t('tt.rule.from_order'), v.fromOrder != null ? v.fromOrder : 3, 'type="number" min="0" max="20"') + '<div class="au-muted">' + esc(t('tt.rule.from_order_hint')) + '</div>'
          : k === 'ALLOWED_BUILDINGS' ? '<div class="form-label">' + esc(t('tt.building')) + '</div>' + multi('bld', r.buildings.map((b) => [b, b]), v.buildings || []) : '';
      };
      m.$('#r-scope').addEventListener('change', drawTarget); m.$('#r-kind').addEventListener('change', drawVal); drawTarget(); drawVal();
    }

    // ── аудитории: вместимость, тип, оборудование ──
    async function rooms(body) {
      const list = await AP.api.leadership.rooms();
      body.innerHTML = '<div class="au-bar"><label class="fld grow"><span>' + esc(t('common.search')) + '</span><input class="input" id="rm-s"></label><div style="flex:1"></div><button class="btn btn-success" id="rm-add">+ ' + esc(t('ld.add_room')) + '</button></div><div id="rm-box"></div>';
      const draw = () => {
        const q = $('rm-s').value.trim().toLowerCase();
        const items = list.filter((x) => !q || (x.code + ' ' + (x.building || '') + ' ' + x.type).toLowerCase().includes(q));
        $('rm-box').innerHTML = '<div class="card" style="overflow:hidden">' + (items.length ? '<div class="au-table"><table><thead><tr><th>' + esc(t('tt.room')) + '</th><th>' + esc(t('tt.building')) + '</th><th>' + esc(t('tt.rt.title')) + '</th><th>' + esc(t('ld.capacity')) + '</th><th>' + esc(t('tt.rm.features')) + '</th><th>' + esc(t('common.status')) + '</th><th></th></tr></thead><tbody>' +
          items.map((x) => '<tr><td><b>' + esc(x.code) + '</b>' + (x.name ? '<div class="au-muted">' + esc(x.name) + '</div>' : '') + '</td><td>' + esc(x.building || '—') + (x.floor != null ? ' · ' + esc(t('tt.rm.floor')) + ' ' + x.floor : '') + '</td><td>' + esc(t('tt.rt.' + x.type, x.type)) + '</td><td>' + x.capacity + '</td><td class="au-muted">' + esc((x.features || []).map((f) => t('tt.ft.' + f, f)).join(', ')) + '</td><td>' + (x.isActive === false ? '<span class="badge badge-gray">' + esc(t('tt.inactive')) + '</span>' : '<span class="badge badge-success">' + esc(t('tt.active')) + '</span>') + '</td>' +
            '<td style="white-space:nowrap"><button class="btn btn-outline btn-sm" data-e="' + esc(x.id) + '">' + esc(t('common.edit')) + '</button> <button class="btn btn-danger btn-sm" data-d="' + esc(x.id) + '">✕</button></td></tr>').join('') + '</tbody></table></div>' : empty(t('ld.no_rooms'))) + '</div>';
        $('rm-box').querySelectorAll('[data-e]').forEach((b) => b.addEventListener('click', () => roomDialog(list.find((x) => x.id === b.dataset.e), again)));
        $('rm-box').querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', async () => {
          if (!(await confirmDialog({ danger: true, confirmLabel: t('common.delete'), message: t('ld.confirm_delete_room') }))) return;
          try { await AP.api.leadership.deleteRoom(b.dataset.d); toast(t('ld.deleted')); again(); } catch (e) { toast(errMsg(e), true); }
        }));
      };
      const again = async () => { S.refs = null; await rooms(body); };
      $('rm-s').addEventListener('input', draw); $('rm-add').addEventListener('click', () => roomDialog(null, again)); draw();
    }
    const FEATURES = ['projector', 'computers', 'lab_equipment', 'whiteboard', 'microphone', 'accessible'];
    const ROOM_TYPES = ['classroom', 'lecture_hall', 'lab', 'computer_lab', 'seminar_room', 'gym', 'other'];
    function roomDialog(x, again) {
      openModal({
        title: x ? t('common.edit') : t('ld.add_room'), wide: true, static: true,
        html: '<div class="form-grid">' + (x ? '' : inp('m-code', t('tt.room'), '', 'maxlength="20"')) + inp('m-name', t('tt.name'), x ? x.name || '' : '', 'maxlength="100"') + inp('m-bld', t('tt.building'), x ? x.building || '' : '', 'maxlength="100"') +
          inp('m-floor', t('tt.rm.floor'), x && x.floor != null ? x.floor : '', 'type="number" min="-3" max="60"') + inp('m-cap', t('ld.capacity'), x ? x.capacity : 30, 'type="number" min="1" max="2000"') +
          fsel('m-type', t('tt.rt.title'), ROOM_TYPES.map((y) => [y, t('tt.rt.' + y, y)]), x ? x.type : 'classroom') + '</div>' +
          '<div class="form-group"><div class="form-label">' + esc(t('tt.rm.features')) + '</div>' + multi('ft', FEATURES.map((f) => [f, t('tt.ft.' + f, f)]), x ? x.features : []) + '</div>' +
          inp('m-note', t('tt.rule.note'), x ? x.note || '' : '', 'maxlength="300"') + chk('m-act', t('tt.active'), x ? x.isActive !== false : true) + '<div class="au-err" id="m-err"></div>',
        buttons: [{ label: t('common.cancel') }, { label: t('common.save'), cls: 'btn-primary', onClick: async (h) => {
          const dto = { name: h.$('#m-name').value.trim() || undefined, building: h.$('#m-bld').value.trim() || undefined, floor: h.$('#m-floor').value === '' ? null : Number(h.$('#m-floor').value), capacity: Number(h.$('#m-cap').value), type: h.$('#m-type').value, features: picked(h.el, 'ft'), isActive: h.$('#m-act').checked, note: h.$('#m-note').value.trim() || null };
          try { if (x) await AP.api.leadership.updateRoom(x.id, dto); else await AP.api.leadership.createRoom(Object.assign({ code: h.$('#m-code').value.trim() }, dto)); toast(t('ld.saved')); again(); }
          catch (e) { h.$('#m-err').textContent = errMsg(e); return false; }
        } }],
      });
    }

    return { requirements, settings, rooms, importDialog: () => importDialog(() => { const b = $('tt-body'); if (b) requirements(b); }) };
  }

  AP.timetableSettings = { create };
})(window);
