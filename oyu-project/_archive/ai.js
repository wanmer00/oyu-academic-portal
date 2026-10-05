/* OYU Portal — AI assistant UI.
 * Floating FAB button + role-aware modal with 7 features.
 * Works on any portal page that includes /js/api.js first.
 */
(function (global) {
  'use strict';

  const api = global.OYU && global.OYU.api;
  if (!api) return;

  // ─── helpers ─────────────────────────────────────────────────
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    }
    if (children) (Array.isArray(children) ? children : [children]).forEach((c) => {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function md(text) {
    // minimal markdown: bold/italic/paragraphs/newlines/lists
    if (!text) return '';
    let s = esc(text);
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    s = s.replace(/`([^`]+?)`/g, '<code>$1</code>');
    s = s.replace(/^#{1,3} (.+)$/gm, '<h4>$1</h4>');
    s = s.replace(/\n{2,}/g, '</p><p>');
    s = s.replace(/\n/g, '<br>');
    return '<p>' + s + '</p>';
  }

  // ─── role discovery ──────────────────────────────────────────
  let me = null;
  async function ensureMe() {
    if (me) return me;
    try { me = await api.me(); } catch (_) { me = null; }
    return me;
  }

  // ─── Feature registry ────────────────────────────────────────
  const FEATURES = {
    STUDENT: [
      { id: 'gpa', icon: '📊', title: 'GPA "nə olsa" kalkulyatoru', desc: 'Faktiki balların əsasında proqnoz GPA və təqaüd təsiri' },
      { id: 'request', icon: '📝', title: 'Ərizə draft', desc: 'Rəsmi ərizə mətnini sənin kontekstinə əsasən yaz' },
      { id: 'search', icon: '🔍', title: 'Material axtarışı', desc: 'Bütün kurs materiallarında semantik axtarış' },
      { id: 'my', icon: '📜', title: 'AI tarixçəsi', desc: 'Bütün əvvəlki AI dialoqların' },
    ],
    TEACHER: [
      { id: 'questions', icon: '✏️', title: 'Sual generatoru', desc: 'İmtahan / contrôle üçün avtomatik suallar' },
      { id: 'translate', icon: '🌐', title: 'Tərcümə AZ / EN / RU', desc: 'Elanı bir dildə yaz — üç dildə çıxsın' },
      { id: 'my', icon: '📜', title: 'AI tarixçəsi', desc: 'Sənin bütün AI sorğuların' },
    ],
    LEADERSHIP: [
      { id: 'dropout', icon: '⚠️', title: 'Risk analizi', desc: 'Kim tərk riskindədir: GPA + davamiyyət + ödəniş' },
      { id: 'translate', icon: '🌐', title: 'Tərcümə AZ / EN / RU', desc: 'Elanı üç dilə tərcümə et' },
      { id: 'questions', icon: '✏️', title: 'Sual generatoru', desc: 'İxtisas imtahanları üçün' },
      { id: 'my', icon: '📜', title: 'AI tarixçəsi', desc: 'Sənin sorğuların' },
    ],
    IT_AUDITOR: [
      { id: 'anomaly', icon: '🛡', title: 'Audit anomaliya skaneri', desc: 'Son saat ərzində şübhəli fəallıq' },
      { id: 'chats', icon: '💬', title: 'Bütün AI dialoqlar', desc: 'KİMİN NƏ soruşduğunu gör (IT-aud)' },
      { id: 'translate', icon: '🌐', title: 'Tərcümə', desc: 'AZ / EN / RU' },
    ],
  };

  // ─── UI — floating button + modal shell ──────────────────────
  let injected = false;
  function injectUI() {
    if (injected) return;
    injected = true;

    const fab = el('button', { id: 'ai-fab', class: 'ai-fab', title: 'OYU AI Assistant' }, [
      el('span', { class: 'ai-fab-icon' }, '✦'),
      el('span', { class: 'ai-fab-label' }, 'AI'),
    ]);
    fab.addEventListener('click', openMenu);
    document.body.appendChild(fab);

    const modal = el('div', { id: 'ai-modal', class: 'ai-modal', 'aria-hidden': 'true' }, [
      el('div', { class: 'ai-modal-backdrop', onclick: closeModal }),
      el('div', { class: 'ai-modal-card' }, [
        el('header', { class: 'ai-modal-head' }, [
          el('div', { id: 'ai-modal-title', class: 'ai-modal-title' }, 'AI Assistant'),
          el('button', { class: 'ai-modal-close', onclick: closeModal, 'aria-label': 'Bağla' }, '✕'),
        ]),
        el('div', { id: 'ai-modal-body', class: 'ai-modal-body' }),
      ]),
    ]);
    document.body.appendChild(modal);

    // Escape to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('open')) closeModal();
    });
  }

  function openModal(title, bodyNode) {
    const m = document.getElementById('ai-modal');
    if (!m) return;
    document.getElementById('ai-modal-title').textContent = title;
    const body = document.getElementById('ai-modal-body');
    body.innerHTML = '';
    body.appendChild(bodyNode);
    m.classList.add('open');
    m.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }
  function closeModal() {
    const m = document.getElementById('ai-modal');
    if (!m) return;
    m.classList.remove('open');
    m.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  async function openMenu() {
    await ensureMe();
    if (!me) {
      alert('AI Assistant yalnız giriş etmiş istifadəçilər üçün əlçatandır.');
      return;
    }
    const list = (FEATURES[me.role] || []).map((f) =>
      el('button', { class: 'ai-feature', onclick: () => pickFeature(f.id) }, [
        el('div', { class: 'ai-feature-icon' }, f.icon),
        el('div', { class: 'ai-feature-body' }, [
          el('div', { class: 'ai-feature-title' }, f.title),
          el('div', { class: 'ai-feature-desc' }, f.desc),
        ]),
        el('div', { class: 'ai-feature-arrow' }, '→'),
      ])
    );
    const menu = el('div', { class: 'ai-menu' }, [
      el('div', { class: 'ai-menu-hint' }, `Xoş gəldin, ${me.fullName}. Rol: ${me.role}. Bütün dialoqlar IT-auditoru üçün qeyd olunur.`),
      el('div', { class: 'ai-feature-list' }, list),
    ]);
    openModal('AI Assistant — Funksiyalar', menu);
  }

  function pickFeature(id) {
    switch (id) {
      case 'gpa': return renderGpa();
      case 'request': return renderRequestDraft();
      case 'search': return renderSearch();
      case 'my': return renderMySessions();
      case 'questions': return renderQuestions();
      case 'translate': return renderTranslate();
      case 'dropout': return renderDropout();
      case 'anomaly': return renderAnomaly();
      case 'chats': return renderAuditChats();
    }
  }

  // ─── shared helpers for panels ──────────────────────────────
  function loadingBlock(msg) {
    return el('div', { class: 'ai-loading' }, [
      el('div', { class: 'ai-spinner' }),
      el('div', null, msg || 'AI düşünür…'),
    ]);
  }
  function stubBadge(stub) {
    return stub
      ? el('span', { class: 'ai-stub-badge', title: 'ANTHROPIC_API_KEY qoşulmadığı üçün demo cavab' }, 'DEMO')
      : el('span', { class: 'ai-live-badge' }, 'LIVE');
  }

  async function runAI(thinkingMsg, fn, renderResult) {
    const body = document.getElementById('ai-modal-body');
    body.innerHTML = '';
    body.appendChild(loadingBlock(thinkingMsg));
    try {
      const res = await fn();
      body.innerHTML = '';
      body.appendChild(renderResult(res));
    } catch (err) {
      body.innerHTML = '';
      body.appendChild(el('div', { class: 'ai-error' }, `Xəta: ${err.message || err}`));
    }
  }

  // ─── PANEL: GPA what-if ─────────────────────────────────────
  function renderGpa() {
    const form = el('form', { class: 'ai-form', onsubmit: (e) => { e.preventDefault(); submit(); } }, [
      el('div', { class: 'ai-hint' }, 'Prognoz balları daxil et (fənn kodu → 0–100). Biri bir sətirdə: məsələn, `CS301:85`'),
      el('textarea', { id: 'ai-gpa-forecast', rows: 6, placeholder: 'MATH201:78\nCS301:92\nENG101:85' }),
      el('input', { id: 'ai-gpa-note', placeholder: 'Qeyd (istəyə bağlı)' }),
      el('button', { class: 'ai-submit', type: 'submit' }, 'Hesabla →'),
    ]);
    openModal('GPA — nə olsa kalkulyatoru', form);

    async function submit() {
      const txt = document.getElementById('ai-gpa-forecast').value;
      const note = document.getElementById('ai-gpa-note').value.trim();
      const forecast = {};
      txt.split('\n').forEach((line) => {
        const m = line.match(/^([A-Za-z0-9_-]+)\s*[:=]\s*(\d+(?:\.\d+)?)/);
        if (m) forecast[m[1]] = Number(m[2]);
      });
      if (!Object.keys(forecast).length) return alert('Ən azı bir prognoz qiyməti daxil et.');

      await runAI('GPA hesablanır…', () => api.ai.gpaWhatIf(forecast, note || undefined), (r) =>
        el('div', { class: 'ai-result' }, [
          stubBadge(r.stub),
          el('div', { class: 'ai-metrics' }, [
            el('div', { class: 'ai-metric' }, [el('div', { class: 'ai-metric-label' }, 'Cari GPA'), el('div', { class: 'ai-metric-val' }, String(r.currentGpa.toFixed(2)))]),
            el('div', { class: 'ai-metric' }, [el('div', { class: 'ai-metric-label' }, 'Proqnoz'), el('div', { class: 'ai-metric-val' }, String(r.forecastGpa.toFixed(2)))]),
            el('div', { class: 'ai-metric', style: 'color:' + (r.delta >= 0 ? 'var(--green, #059669)' : 'var(--red, #dc2626)') },
              [el('div', { class: 'ai-metric-label' }, 'Dəyişmə'), el('div', { class: 'ai-metric-val' }, (r.delta >= 0 ? '+' : '') + r.delta.toFixed(2))]),
          ]),
          el('div', { class: 'ai-answer', html: md(r.text) }),
        ])
      );
    }
  }

  // ─── PANEL: Request Draft ───────────────────────────────────
  function renderRequestDraft() {
    const sel = el('select', { id: 'ai-req-type' }, [
      el('option', { value: 'CERTIFICATE' }, 'Arayış sorğusu'),
      el('option', { value: 'APPEAL' }, 'Apelyasiya'),
      el('option', { value: 'TRANSFER' }, 'İxtisas / qrup dəyişmək'),
      el('option', { value: 'OTHER' }, 'Digər'),
    ]);
    const form = el('form', { class: 'ai-form', onsubmit: (e) => { e.preventDefault(); submit(); } }, [
      el('label', null, 'Ərizə növü:'),
      sel,
      el('input', { id: 'ai-req-subject', placeholder: 'Fənn kodu (istəyə bağlı): CS301' }),
      el('textarea', { id: 'ai-req-note', rows: 4, placeholder: 'Qısa izah: nə baş vermişdir, nə istəyirsən (istəyə bağlı)' }),
      el('button', { class: 'ai-submit', type: 'submit' }, 'Draft yarat →'),
    ]);
    openModal('AI Ərizə Drafter', form);

    async function submit() {
      const type = document.getElementById('ai-req-type').value;
      const subj = document.getElementById('ai-req-subject').value.trim();
      const note = document.getElementById('ai-req-note').value.trim();
      await runAI('Ərizə mətni hazırlanır…', () => api.ai.draftRequest(type, note || undefined, subj || undefined), (r) => {
        const copy = el('button', { class: 'ai-copy', onclick: () => { navigator.clipboard.writeText(r.text); copy.textContent = '✓ Kopyalandı'; } }, 'Mətnı kopyala');
        return el('div', { class: 'ai-result' }, [
          stubBadge(r.stub),
          el('div', { class: 'ai-answer', html: md(r.text) }),
          copy,
        ]);
      });
    }
  }

  // ─── PANEL: Material Search ─────────────────────────────────
  function renderSearch() {
    const form = el('form', { class: 'ai-form', onsubmit: (e) => { e.preventDefault(); submit(); } }, [
      el('input', { id: 'ai-search-q', placeholder: 'Nə axtarırsan? Məs. "TCP handshake prosesi"' }),
      el('input', { id: 'ai-search-subj', placeholder: 'Fənn kodu (istəyə bağlı): CS301' }),
      el('button', { class: 'ai-submit', type: 'submit' }, 'Axtar →'),
    ]);
    openModal('AI — Material axtarışı', form);

    async function submit() {
      const q = document.getElementById('ai-search-q').value.trim();
      const subj = document.getElementById('ai-search-subj').value.trim();
      if (q.length < 2) return alert('Ən azı 2 simvol.');
      await runAI('Materiallar skan olunur…', () => api.ai.searchMaterials(q, subj || undefined), (r) => {
        const hits = (r.matches || []).map((m) =>
          el('div', { class: 'ai-hit' }, [
            el('div', { class: 'ai-hit-title' }, `${m.subjectCode} · ${m.title}`),
            el('div', { class: 'ai-hit-why' }, m.why || ''),
            m.url ? el('a', { class: 'ai-hit-link', href: m.url, target: '_blank', rel: 'noopener' }, 'Materialı aç ↗') : null,
          ])
        );
        return el('div', { class: 'ai-result' }, [
          stubBadge(r.stub),
          r.note ? el('div', { class: 'ai-note' }, r.note) : null,
          hits.length ? el('div', { class: 'ai-hits' }, hits) : el('div', { class: 'ai-empty' }, 'Heç nə tapılmadı.'),
        ]);
      });
    }
  }

  // ─── PANEL: My sessions ─────────────────────────────────────
  async function renderMySessions() {
    openModal('Mənim AI tarixçəm', loadingBlock());
    try {
      const { items } = await api.ai.mySessions();
      const body = document.getElementById('ai-modal-body');
      body.innerHTML = '';
      if (!items.length) {
        body.appendChild(el('div', { class: 'ai-empty' }, 'Hələlik dialoq yoxdur.'));
        return;
      }
      const list = el('div', { class: 'ai-sessions' }, items.map((s) =>
        el('button', { class: 'ai-session-item' + (s.flagged ? ' flagged' : ''), onclick: () => openSession(s.id) }, [
          el('div', { class: 'ai-session-head' }, [
            el('span', { class: 'ai-session-feature' }, s.feature),
            el('span', { class: 'ai-session-time' }, new Date(s.createdAt).toLocaleString('az')),
          ]),
          el('div', { class: 'ai-session-title' }, s.title || '(başlıqsız)'),
          el('div', { class: 'ai-session-meta' }, `${s.totalTokens} tokens${s.flagged ? ' · ⚑ flagged' : ''}`),
        ])
      ));
      body.appendChild(list);
    } catch (e) {
      document.getElementById('ai-modal-body').innerHTML = `<div class="ai-error">${esc(e.message)}</div>`;
    }
  }
  async function openSession(id) {
    openModal('Dialoq', loadingBlock());
    try {
      const { item } = await api.ai.mySession(id);
      const body = document.getElementById('ai-modal-body');
      body.innerHTML = '';
      if (!item) {
        body.appendChild(el('div', { class: 'ai-empty' }, 'Tapılmadı.'));
        return;
      }
      const msgs = item.messages.map((m) =>
        el('div', { class: 'ai-msg ai-msg-' + m.role }, [
          el('div', { class: 'ai-msg-role' }, m.role),
          el('div', { class: 'ai-msg-body', html: md(m.content) }),
        ])
      );
      body.appendChild(el('div', { class: 'ai-dialog' }, msgs));
    } catch (e) {
      document.getElementById('ai-modal-body').innerHTML = `<div class="ai-error">${esc(e.message)}</div>`;
    }
  }

  // ─── PANEL: Questions (teacher/leadership) ──────────────────
  function renderQuestions() {
    const form = el('form', { class: 'ai-form', onsubmit: (e) => { e.preventDefault(); submit(); } }, [
      el('input', { id: 'ai-q-subj', placeholder: 'Fənn kodu: CS301', required: 'required' }),
      el('input', { id: 'ai-q-topic', placeholder: 'Mövzu (istəyə bağlı): "Sync/Async"' }),
      el('div', { class: 'ai-row' }, [
        el('input', { id: 'ai-q-count', type: 'number', min: 5, max: 50, value: 15, placeholder: 'Say' }),
        el('select', { id: 'ai-q-diff' }, [
          el('option', { value: 'mixed' }, 'Qarışıq'),
          el('option', { value: 'easy' }, 'Asan'),
          el('option', { value: 'medium' }, 'Orta'),
          el('option', { value: 'hard' }, 'Çətin'),
        ]),
      ]),
      el('button', { class: 'ai-submit', type: 'submit' }, 'Suallar yarat →'),
    ]);
    openModal('AI Sual generatoru', form);

    async function submit() {
      const dto = {
        subjectCode: document.getElementById('ai-q-subj').value.trim(),
        topic: document.getElementById('ai-q-topic').value.trim() || undefined,
        count: Number(document.getElementById('ai-q-count').value) || 15,
        difficulty: document.getElementById('ai-q-diff').value,
      };
      if (!dto.subjectCode) return alert('Fənn kodu lazımdır.');
      await runAI('Suallar hazırlanır…', () => api.ai.generateQuestions(dto), (r) => {
        const qs = (r.questions || []).map((q, i) =>
          el('div', { class: 'ai-question' }, [
            el('div', { class: 'ai-question-head' }, `${i + 1}. [${q.type || '?'} · ${q.difficulty || '?'}]`),
            el('div', { class: 'ai-question-body' }, q.question || ''),
            q.choices ? el('ul', { class: 'ai-question-choices' }, q.choices.map((c) => el('li', null, String(c)))) : null,
            q.answer ? el('div', { class: 'ai-question-answer' }, 'Cavab: ' + q.answer) : null,
            q.explanation ? el('div', { class: 'ai-question-expl' }, q.explanation) : null,
          ])
        );
        return el('div', { class: 'ai-result' }, [
          stubBadge(r.stub),
          qs.length ? el('div', { class: 'ai-questions' }, qs) : el('div', { class: 'ai-answer', html: md(r.text) }),
        ]);
      });
    }
  }

  // ─── PANEL: Translate ───────────────────────────────────────
  function renderTranslate() {
    const form = el('form', { class: 'ai-form', onsubmit: (e) => { e.preventDefault(); submit(); } }, [
      el('label', null, 'Mənbə dili:'),
      el('select', { id: 'ai-tr-src' }, [
        el('option', { value: 'az' }, 'AZ'),
        el('option', { value: 'en' }, 'EN'),
        el('option', { value: 'ru' }, 'RU'),
      ]),
      el('textarea', { id: 'ai-tr-text', rows: 6, placeholder: 'Tərcümə ediləcək mətn…', required: 'required' }),
      el('button', { class: 'ai-submit', type: 'submit' }, 'Tərcümə et →'),
    ]);
    openModal('AI Tərcümə AZ / EN / RU', form);

    async function submit() {
      const text = document.getElementById('ai-tr-text').value.trim();
      const src = document.getElementById('ai-tr-src').value;
      if (!text) return;
      await runAI('Tərcümə…', () => api.ai.translate(text, src), (r) => {
        const t = r.translations || { az: '', en: '', ru: '' };
        return el('div', { class: 'ai-result' }, [
          stubBadge(r.stub),
          el('div', { class: 'ai-translations' }, [
            ['az', 'Azərbaycan'], ['en', 'English'], ['ru', 'Русский'],
          ].map(([k, label]) => el('div', { class: 'ai-tr-block' }, [
            el('div', { class: 'ai-tr-label' }, label),
            el('textarea', { readonly: 'readonly', rows: 5, class: 'ai-tr-output' }, t[k] || ''),
          ]))),
        ]);
      });
    }
  }

  // ─── PANEL: Dropout Risk ────────────────────────────────────
  function renderDropout() {
    const form = el('form', { class: 'ai-form', onsubmit: (e) => { e.preventDefault(); submit(); } }, [
      el('div', { class: 'ai-hint' }, 'Risk xalı tələbələrin qiymət ortalaması, davamiyyət, ödəniş statusuna əsaslanır.'),
      el('div', { class: 'ai-row' }, [
        el('input', { id: 'ai-d-min', type: 'number', min: 0, max: 100, value: 30, placeholder: 'Min risk' }),
        el('input', { id: 'ai-d-course', type: 'number', min: 1, max: 6, placeholder: 'Yalnız kurs (bos = hamı)' }),
      ]),
      el('button', { class: 'ai-submit', type: 'submit' }, 'Analiz et →'),
    ]);
    openModal('AI Tərk riski analizi', form);

    async function submit() {
      const dto = {
        minRiskScore: Number(document.getElementById('ai-d-min').value) || 30,
        focusCourse: Number(document.getElementById('ai-d-course').value) || undefined,
      };
      await runAI('Tələbələr analiz olunur…', () => api.ai.dropoutRisk(dto), (r) => {
        const rows = (r.atRisk || []).map((s) =>
          el('tr', null, [
            el('td', null, s.oyuId),
            el('td', null, s.fullName),
            el('td', { style: 'text-align:right;font-weight:700;color:' + (s.score >= 60 ? 'var(--red,#dc2626)' : 'var(--amber,#D97706)') }, String(s.score)),
            el('td', null, s.reasons.join('; ')),
          ])
        );
        return el('div', { class: 'ai-result' }, [
          stubBadge(r.stub),
          el('div', { class: 'ai-metrics' }, [
            el('div', { class: 'ai-metric' }, [el('div', { class: 'ai-metric-label' }, 'Analiz edildi'), el('div', { class: 'ai-metric-val' }, String(r.summary.totalAnalyzed))]),
            el('div', { class: 'ai-metric' }, [el('div', { class: 'ai-metric-label' }, 'Yüksək risk'), el('div', { class: 'ai-metric-val' }, String(r.summary.highRisk))]),
            el('div', { class: 'ai-metric' }, [el('div', { class: 'ai-metric-label' }, 'Orta risk'), el('div', { class: 'ai-metric-val' }, String(r.summary.mediumRisk))]),
          ]),
          el('table', { class: 'ai-table' }, [
            el('thead', null, el('tr', null, [el('th', null, 'OYU ID'), el('th', null, 'Ad'), el('th', null, 'Risk'), el('th', null, 'Səbəblər')])),
            el('tbody', null, rows),
          ]),
          el('div', { class: 'ai-answer', html: md(r.text) }),
        ]);
      });
    }
  }

  // ─── PANEL: Audit Anomaly (IT auditor) ──────────────────────
  function renderAnomaly() {
    const form = el('form', { class: 'ai-form', onsubmit: (e) => { e.preventDefault(); submit(); } }, [
      el('label', null, 'Nə qədər vaxt geriyə baxılsın (saat):'),
      el('input', { id: 'ai-an-h', type: 'number', min: 1, max: 720, value: 24 }),
      el('button', { class: 'ai-submit', type: 'submit' }, 'Anomaliyaları skan et →'),
    ]);
    openModal('AI Audit anomaliya skaneri', form);

    async function submit() {
      const h = Number(document.getElementById('ai-an-h').value) || 24;
      await runAI('Auditorun logları skan olunur…', () => api.ai.auditAnomaly(h), (r) => {
        return el('div', { class: 'ai-result' }, [
          stubBadge(r.stub),
          el('div', { class: 'ai-metrics' }, [
            el('div', { class: 'ai-metric' }, [el('div', { class: 'ai-metric-label' }, 'Uğurlu giriş'), el('div', { class: 'ai-metric-val' }, String(r.stats.loginSuccess))]),
            el('div', { class: 'ai-metric' }, [el('div', { class: 'ai-metric-label' }, 'Uğursuz'), el('div', { class: 'ai-metric-val', style: 'color:var(--red,#dc2626)' }, String(r.stats.loginFailures))]),
            el('div', { class: 'ai-metric' }, [el('div', { class: 'ai-metric-label' }, 'Saat aralığı'), el('div', { class: 'ai-metric-val' }, String(r.stats.hours))]),
          ]),
          el('div', { class: 'ai-answer', html: md(r.text) }),
        ]);
      });
    }
  }

  // ─── PANEL: IT AUDITOR — browse all AI chats ─────────────────
  async function renderAuditChats() {
    openModal('Bütün AI dialoqlar (IT-aud)', loadingBlock());
    try {
      const [stats, { items }] = await Promise.all([
        api.security.aiChatsStats(),
        api.security.aiChats({ take: 30 }),
      ]);
      const body = document.getElementById('ai-modal-body');
      body.innerHTML = '';

      body.appendChild(el('div', { class: 'ai-metrics' }, [
        el('div', { class: 'ai-metric' }, [el('div', { class: 'ai-metric-label' }, 'Cəmi'), el('div', { class: 'ai-metric-val' }, String(stats.total))]),
        el('div', { class: 'ai-metric' }, [el('div', { class: 'ai-metric-label' }, 'Son 24h'), el('div', { class: 'ai-metric-val' }, String(stats.last24h))]),
        el('div', { class: 'ai-metric' }, [el('div', { class: 'ai-metric-label' }, 'Flag-edilmiş'), el('div', { class: 'ai-metric-val', style: 'color:var(--red,#dc2626)' }, String(stats.flagged))]),
        el('div', { class: 'ai-metric' }, [el('div', { class: 'ai-metric-label' }, 'Token'), el('div', { class: 'ai-metric-val' }, String(stats.totalTokens))]),
        el('div', { class: 'ai-metric' }, [el('div', { class: 'ai-metric-label' }, 'Cost $'), el('div', { class: 'ai-metric-val' }, stats.totalCostUsd)]),
      ]));

      body.appendChild(el('h4', { class: 'ai-subtitle' }, 'Fəaliyyət — funksiya üzrə'));
      body.appendChild(el('table', { class: 'ai-table' }, [
        el('thead', null, el('tr', null, [el('th', null, 'Funksiya'), el('th', null, 'Sessiya'), el('th', null, 'Token'), el('th', null, '$')])),
        el('tbody', null, stats.byFeature.map((f) => el('tr', null, [el('td', null, f.feature), el('td', null, String(f.sessions)), el('td', null, String(f.tokens)), el('td', null, f.costUsd)]))),
      ]));

      body.appendChild(el('h4', { class: 'ai-subtitle' }, 'Son dialoqlar'));
      const rows = items.map((s) => el('tr', { class: s.flagged ? 'flagged' : '', onclick: () => openAuditChat(s.id) }, [
        el('td', null, new Date(s.createdAt).toLocaleString('az', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })),
        el('td', null, (s.user?.oyuId || '?') + ' (' + (s.user?.role || '') + ')'),
        el('td', null, s.feature),
        el('td', null, (s.title || '').slice(0, 60)),
        el('td', { style: 'text-align:right' }, String(s.messageCount)),
        el('td', null, s.flagged ? '⚑ ' + (s.flagReason || '') : ''),
      ]));
      body.appendChild(el('table', { class: 'ai-table ai-table-clickable' }, [
        el('thead', null, el('tr', null, [el('th', null, 'Vaxt'), el('th', null, 'İstifadəçi'), el('th', null, 'Funksiya'), el('th', null, 'Başlıq'), el('th', null, 'Msg'), el('th', null, 'Flag')])),
        el('tbody', null, rows),
      ]));
    } catch (e) {
      document.getElementById('ai-modal-body').innerHTML = `<div class="ai-error">${esc(e.message)}</div>`;
    }
  }

  async function openAuditChat(id) {
    openModal('Dialoq (IT-aud)', loadingBlock());
    try {
      const { item } = await api.security.aiChat(id);
      const body = document.getElementById('ai-modal-body');
      body.innerHTML = '';
      if (!item) { body.appendChild(el('div', { class: 'ai-empty' }, 'Tapılmadı.')); return; }

      body.appendChild(el('div', { class: 'ai-chat-meta' }, [
        el('div', null, `${item.user.oyuId} · ${item.user.role} · ${item.user.fullName}`),
        el('div', null, `${item.feature} — ${new Date(item.createdAt).toLocaleString('az')}`),
        el('div', null, `IP: ${item.ip || '—'} · Tokens: ${item.totalTokens}`),
        item.flagged ? el('div', { class: 'ai-chat-flag' }, '⚑ ' + (item.flagReason || 'flagged')) : null,
      ]));

      const flagBtn = el('button', { class: 'ai-flag-btn', onclick: async () => {
        const reason = prompt('Flag səbəbini daxil et:', item.flagReason || '');
        if (reason === null) return;
        await api.security.flagAiChat(id, !item.flagged, reason);
        openAuditChat(id);
      } }, item.flagged ? 'Flag-ı sil' : 'Flag et');
      body.appendChild(flagBtn);

      const msgs = item.messages.map((m) => el('div', { class: 'ai-msg ai-msg-' + m.role }, [
        el('div', { class: 'ai-msg-role' }, `${m.role} ${m.stub ? '[stub]' : ''} ${m.latencyMs ? ' · ' + m.latencyMs + 'ms' : ''}`),
        el('div', { class: 'ai-msg-body', html: md(m.content) }),
      ]));
      body.appendChild(el('div', { class: 'ai-dialog' }, msgs));
    } catch (e) {
      document.getElementById('ai-modal-body').innerHTML = `<div class="ai-error">${esc(e.message)}</div>`;
    }
  }

  // ─── Boot ───────────────────────────────────────────────────
  function boot() {
    // Only inject AI UI when an access token is present or /me succeeds.
    // api.me() relies on access token which flow acquires automatically after login.
    ensureMe().then((u) => {
      if (u) injectUI();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // public
  global.OYU = global.OYU || {};
  global.OYU.ai = { openMenu };
})(window);
