// ============================================================
// Academic Portal — API client
// Работает с бэком NestJS (/api/v1). Access-токен в памяти,
// refresh — в HttpOnly cookie (неуправляемо из JS).
// ============================================================
(function (global) {
  'use strict';

  const API_BASE =
    (global.AP_API_BASE || '').replace(/\/$/, '') ||
    (location.hostname === 'localhost' ? 'http://localhost:3001' : '');

  let accessToken = null;
  let refreshInFlight = null;

  function setAccessToken(tok) { accessToken = tok; }
  function getAccessToken()     { return accessToken; }
  function clearAccessToken()   { accessToken = null; }

  // «Просмотреть как роль» (только SUPER_ADMIN): выбранный пользователь хранится в sessionStorage вкладки
  const VA_KEY = 'ap_view_as';
  function getViewAs() { try { return JSON.parse(sessionStorage.getItem(VA_KEY) || 'null'); } catch { return null; } }
  function setViewAs(v) { try { v ? sessionStorage.setItem(VA_KEY, JSON.stringify(v)) : sessionStorage.removeItem(VA_KEY); } catch { /* ignore */ } }
  const viewAsHeader = (path, headers) => { const va = getViewAs(); if (va && !String(path).startsWith('/admin/view-as')) headers['X-View-As'] = va.id; };

  function getLang() { return localStorage.getItem('ap_lang') || 'az'; }

  // query-string из объекта (пустые значения пропускаются)
  function qs(o) {
    const p = new URLSearchParams();
    Object.entries(o || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, v); });
    const s = p.toString();
    return s ? '?' + s : '';
  }

  async function request(path, opts) {
    opts = opts || {};
    const url = API_BASE + '/api/v1' + path;
    const headers = Object.assign(
      { 'Content-Type': 'application/json', 'X-Lang': getLang() },
      opts.headers || {}
    );
    if (accessToken) headers['Authorization'] = 'Bearer ' + accessToken;
    viewAsHeader(path, headers);

    const init = {
      method: opts.method || 'GET',
      headers,
      credentials: 'include',
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      const err = new Error('network_error');
      err.networkError = true;
      throw err;
    }

    if (res.status === 401 && !opts._retried && path !== '/auth/login' && path !== '/auth/refresh') {
      const ok = await tryRefresh();
      if (ok) return request(path, Object.assign({}, opts, { _retried: true }));
    }

    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try { data = await res.json(); } catch { /* ignore */ }
    }
    if (!res.ok) {
      const err = new Error((data && (data.message || data.error)) || ('HTTP ' + res.status));
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  // Скачивание файла (CSV) с авторизацией; возвращает Blob
  async function download(path) {
    const once = () => {
      const headers = { 'X-Lang': getLang() };
      if (accessToken) headers['Authorization'] = 'Bearer ' + accessToken;
      viewAsHeader(path, headers);
      return fetch(API_BASE + '/api/v1' + path, { headers, credentials: 'include' });
    };
    let res;
    try { res = await once(); } catch { const e = new Error('network_error'); e.networkError = true; throw e; }
    if (res.status === 401 && (await tryRefresh())) res = await once();
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const j = await res.json(); msg = j.message || msg; } catch { /* not json */ }
      const err = new Error(msg); err.status = res.status; throw err;
    }
    return res.blob();
  }

  async function tryRefresh() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      try {
        const data = await request('/auth/refresh', { method: 'POST', _retried: true });
        if (data && data.accessToken) { setAccessToken(data.accessToken); return true; }
        return false;
      } catch {
        clearAccessToken();
        return false;
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  }

  const api = {
    baseUrl: API_BASE,
    request,
    setAccessToken, getAccessToken, clearAccessToken,

    // Auth
    async login(loginId, password) {
      const data = await request('/auth/login', { method: 'POST', body: { loginId, password } });
      setAccessToken(data.accessToken);
      return data.user;
    },
    async refresh() {
      const ok = await tryRefresh();
      if (!ok) return null;
      try { return await api.me(); } catch { return null; }
    },
    async logout() {
      setViewAs(null);
      try { await request('/auth/logout', { method: 'POST' }); } catch {}
      clearAccessToken();
    },
    viewAs: {
      get: getViewAs,
      targets()      { return request('/admin/view-as/targets'); },
      async start(target) { const r = await request('/admin/view-as/start', { method: 'POST', body: { userId: target.id } }); if (r && r.ok) setViewAs(target); return r; },
      async end()    { const va = getViewAs(); try { await request('/admin/view-as/end', { method: 'POST', body: va ? { userId: va.id } : {} }); } finally { setViewAs(null); } },
    },

    // Self
    me()           { return request('/me'); },
    updateMe(dto)  { return request('/me', { method: 'PATCH', body: dto }); },

    // Student
    myInfo()       { return request('/me/info'); },
    myGrades(filters) {
      const q = new URLSearchParams();
      if (filters && filters.academicYear) q.set('academicYear', filters.academicYear);
      if (filters && filters.term) q.set('term', filters.term);
      const qs = q.toString();
      return request('/me/grades' + (qs ? '?' + qs : ''));
    },
    mySchedule()   { return request('/me/schedule'); },
    myTranscript() { return request('/me/transcript'); },
    // Официальный GPA / кредиты / академический статус — единственный источник для student UI
    myAcademicSummary() { return request('/me/academic-summary'); },
    mySubjectsOverview(filters) {
      const q = new URLSearchParams();
      if (filters && filters.academicYear) q.set('academicYear', filters.academicYear);
      if (filters && filters.term) q.set('term', filters.term);
      const qs = q.toString();
      return request('/me/subjects-overview' + (qs ? '?' + qs : ''));
    },
    mySubjectDays(code, filters) {
      const q = new URLSearchParams();
      if (filters && filters.academicYear) q.set('academicYear', filters.academicYear);
      if (filters && filters.term) q.set('term', filters.term);
      const qs = q.toString();
      return request('/me/subjects/' + encodeURIComponent(code) + '/days' + (qs ? '?' + qs : ''));
    },
    myCalendar(params) {
      const q = new URLSearchParams();
      if (params) Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') q.set(k, v); });
      const qs = q.toString();
      return request('/me/calendar' + (qs ? '?' + qs : ''));
    },
    myAssignments()            { return request('/me/assignments'); },
    myAssignment(id)           { return request('/me/assignments/' + encodeURIComponent(id)); },
    submitAssignment(id, dto)  { return request('/me/assignments/' + encodeURIComponent(id) + '/submit', { method: 'POST', body: dto }); },
    myMaterials(subjectCode) {
      const q = subjectCode ? '?subjectCode=' + encodeURIComponent(subjectCode) : '';
      return request('/me/materials' + q);
    },
    myRequests()               { return request('/me/requests'); },
    myRequestQuota()           { return request('/me/requests/quota'); },
    createRequest(dto)         { return request('/me/requests', { method: 'POST', body: dto }); },
    updateMyRequest(id, dto)   { return request('/me/requests/' + encodeURIComponent(id), { method: 'PATCH', body: dto }); },
    deleteMyRequest(id)        { return request('/me/requests/' + encodeURIComponent(id), { method: 'DELETE' }); },
    // Апелляция по экзамену — часть Requests (type = APPEAL)
    myRequest(id)              { return request('/me/requests/' + encodeURIComponent(id)); },
    withdrawMyRequest(id)      { return request('/me/requests/' + encodeURIComponent(id) + '/withdraw', { method: 'POST', body: {} }); },
    editMyAppeal(id, dto)      { return request('/me/requests/' + encodeURIComponent(id) + '/appeal', { method: 'PUT', body: dto }); },
    examReview(resultId)       { return request('/me/exam-results/' + encodeURIComponent(resultId) + '/review'); },
    examAppealSummary()        { return request('/me/exam-appeals/summary'); },
    staffAppeals(base, q)      { return request('/' + base + '/requests/appeals' + qs(q)); },
    staffAppeal(base, id)      { return request('/' + base + '/requests/appeals/' + encodeURIComponent(id)); },
    appealAction(base, id, action, body, method) { return request('/' + base + '/requests/appeals/' + encodeURIComponent(id) + '/' + action, { method: method || 'POST', body: body || {} }); },

    // Announcements (все роли)
    myAnnouncements()          { return request('/me/announcements'); },
    unreadAnnouncements()      { return request('/me/announcements/unread'); },
    markAnnouncementRead(id)   { return request('/me/announcements/' + encodeURIComponent(id) + '/read', { method: 'POST' }); },

    // Notifications (все роли, только свои)
    notifications: {
      list(params) {
        const q = new URLSearchParams();
        if (params) Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '' && v !== false) q.set(k, v); });
        const qs = q.toString();
        return request('/me/notifications' + (qs ? '?' + qs : ''));
      },
      unreadCount()  { return request('/me/notifications/unread-count'); },
      markRead(id)   { return request('/me/notifications/' + encodeURIComponent(id) + '/read', { method: 'POST' }); },
      markAllRead()  { return request('/me/notifications/read-all', { method: 'POST' }); },
    },

    // Payments (STUDENT)
    myPayments()               { return request('/me/payments'); },
    payMock(id)                { return request('/me/payments/' + encodeURIComponent(id) + '/pay', { method: 'POST' }); },

    // (AI chat is fully local now — see /js/ai-chat.js. No backend AI endpoints used.)


    // Academic Journal — единый модуль для всех ролей (доступ определяет backend по JWT)
    journal: {
      meta()                 { return request('/journal/meta'); },
      me(p)                  { return request('/journal/me' + qs(p)); },
      meSubject(subjectId, p) { return request('/journal/me/subjects/' + encodeURIComponent(subjectId) + qs(p)); },
      records(p)             { return request('/journal/records' + qs(p)); },
      detail(studentId, subjectId, p) { return request('/journal/records/' + encodeURIComponent(studentId) + '/' + encodeURIComponent(subjectId) + qs(p)); },
      analytics(p)           { return request('/journal/analytics' + qs(p)); },
      compare(p)             { return request('/journal/compare' + qs(p)); },
      exportCsv(p)           { return download('/journal/export' + qs(p)); },
      addSeminar(dto)        { return request('/journal/seminar-answers', { method: 'POST', body: dto }); },
      setComponent(dto)      { return request('/journal/components', { method: 'PUT', body: dto }); },
      updateGrade(id, dto)   { return request('/journal/grades/' + encodeURIComponent(id), { method: 'PATCH', body: dto }); },
      deleteGrade(id, reason) { return request('/journal/grades/' + encodeURIComponent(id) + qs({ reason }), { method: 'DELETE' }); },
      cells(dto)             { return request('/journal/cells', { method: 'POST', body: dto }); },
      publish(dto)           { return request('/journal/publish', { method: 'POST', body: dto }); },
      unpublish(dto)         { return request('/journal/unpublish', { method: 'POST', body: dto }); },
      bulkPreview(dto)       { return request('/journal/bulk/preview', { method: 'POST', body: dto }); },
      bulk(dto)              { return request('/journal/bulk', { method: 'POST', body: dto }); },
      importPreview(dto)     { return request('/journal/import/preview', { method: 'POST', body: dto }); },
      importApply(dto)       { return request('/journal/import', { method: 'POST', body: dto }); },
      setPeriod(id, dto)     { return request('/journal/periods/' + encodeURIComponent(id), { method: 'PATCH', body: dto }); },
      audit(p)               { return request('/journal/audit' + qs(p)); },
      auditStats()           { return request('/journal/audit/stats'); },
      // Academic Journal → Attendance (единственный API посещаемости)
      attendance: {
        day(p)        { return request('/journal/attendance/day' + qs(p)); },
        mark(dto)     { return request('/journal/attendance', { method: 'POST', body: dto }); },
        clear(dto)    { return request('/journal/attendance', { method: 'DELETE', body: dto }); },
        stats(p)      { return request('/journal/attendance/stats' + qs(p)); },
        student(p)    { return request('/journal/attendance/student' + qs(p)); },
        report(p)     { return request('/journal/attendance/report' + qs(p)); },
        exportCsv(p)  { return download('/journal/attendance/export.csv' + qs(p)); },
      },
    },
    // Teacher
    teacher: {
      me()              { return request('/teacher/me'); },
      subjects()        { return request('/teacher/subjects'); },
      groups()          { return request('/teacher/groups'); },
      schedule()        { return request('/teacher/schedule'); },

      // Workspace
      dashboard()       { return request('/teacher/dashboard'); },
      classes()         { return request('/teacher/classes'); },
      analytics(params) {
        const q = new URLSearchParams();
        if (params) Object.entries(params).forEach(([k, v]) => { if (v) q.set(k, v); });
        const qs = q.toString();
        return request('/teacher/analytics' + (qs ? '?' + qs : ''));
      },
      updateAssignment(id, dto)    { return request('/teacher/assignments/' + encodeURIComponent(id), { method: 'PATCH', body: dto }); },
      setAssignmentStatus(id, status) {
        return request('/teacher/assignments/' + encodeURIComponent(id) + '/status', { method: 'POST', body: { status } });
      },
      updateMaterial(id, dto)      { return request('/teacher/materials/' + encodeURIComponent(id), { method: 'PATCH', body: dto }); },

      // Assignments
      assignments()                    { return request('/teacher/assignments'); },
      createAssignment(dto)            { return request('/teacher/assignments', { method: 'POST', body: dto }); },
      assignmentSubmissions(id)        { return request('/teacher/assignments/' + encodeURIComponent(id) + '/submissions'); },
      gradeSubmission(id, dto)         { return request('/teacher/submissions/' + encodeURIComponent(id), { method: 'PATCH', body: dto }); },

      // Materials
      materials()                      { return request('/teacher/materials'); },
      createMaterial(dto)              { return request('/teacher/materials', { method: 'POST', body: dto }); },
      deleteMaterial(id)               { return request('/teacher/materials/' + encodeURIComponent(id), { method: 'DELETE' }); },

      // Requests (read + reply)
      requests(status) {
        const qs = status ? ('?status=' + encodeURIComponent(status)) : '';
        return request('/teacher/requests' + qs);
      },
      replyRequest(id, dto) {
        return request('/teacher/requests/' + encodeURIComponent(id), { method: 'PATCH', body: dto });
      },
    },

    // Leadership
    leadership: {
      dashboard()       { return request('/admin/dashboard'); },
      kpi(weeks)        { return request('/admin/kpi' + (weeks ? '?weeks=' + encodeURIComponent(weeks) : '')); },
      users(params) {
        const q = new URLSearchParams();
        if (params) Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') q.set(k, v); });
        const qs = q.toString(); return request('/admin/users' + (qs ? '?' + qs : ''));
      },
      user(id)          { return request('/admin/users/' + encodeURIComponent(id)); },
      requests(params) {
        const q = new URLSearchParams();
        if (typeof params === 'string') q.set('status', params);
        else if (params) Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') q.set(k, v); });
        const qs = q.toString(); return request('/admin/requests' + (qs ? '?' + qs : ''));
      },
      checkEvent(dto)   { return request('/admin/calendar/check', { method: 'POST', body: dto }); },
      updateRequest(id, dto) { return request('/admin/requests/' + id, { method: 'PATCH', body: dto }); },

      // Schedule management
      rooms()                  { return request('/admin/rooms'); },
      createRoom(dto)          { return request('/admin/rooms', { method: 'POST', body: dto }); },
      updateRoom(id, dto)      { return request('/admin/rooms/' + id, { method: 'PATCH', body: dto }); },
      deleteRoom(id)           { return request('/admin/rooms/' + id, { method: 'DELETE' }); },
      groups()                 { return request('/admin/groups'); },
      teachers()               { return request('/admin/teachers'); },
      subjects()               { return request('/admin/subjects'); },
      schedule(params) {
        const q = new URLSearchParams();
        if (params) Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') q.set(k, v); });
        const qs = q.toString();
        return request('/admin/schedule' + (qs ? '?' + qs : ''));
      },
      createSlot(dto)          { return request('/admin/schedule', { method: 'POST', body: dto }); },
      updateSlot(id, dto)      { return request('/admin/schedule/' + id, { method: 'PATCH', body: dto }); },
      deleteSlot(id)           { return request('/admin/schedule/' + id, { method: 'DELETE' }); },

      // Calendar events (admin)
      calendar(params) {
        const q = new URLSearchParams();
        if (params) Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') q.set(k, v); });
        const qs = q.toString();
        return request('/admin/calendar' + (qs ? '?' + qs : ''));
      },
      createEvent(dto)         { return request('/admin/calendar', { method: 'POST', body: dto }); },
      updateEvent(id, dto)     { return request('/admin/calendar/' + id, { method: 'PATCH', body: dto }); },
      deleteEvent(id)          { return request('/admin/calendar/' + id, { method: 'DELETE' }); },

      // Announcements
      announcements()             { return request('/admin/announcements'); },
      createAnnouncement(dto)     { return request('/admin/announcements', { method: 'POST', body: dto }); },
      updateAnnouncement(id, dto) { return request('/admin/announcements/' + id, { method: 'PATCH', body: dto }); },
      deleteAnnouncement(id)      { return request('/admin/announcements/' + id, { method: 'DELETE' }); },

      // Payments (admin view)
      payments(params) {
        const q = new URLSearchParams();
        if (params) Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') q.set(k, v); });
        const qs = q.toString(); return request('/admin/payments' + (qs ? '?' + qs : ''));
      },

      // Analytics (AI features)
      heatmap()              { return request('/admin/analytics/heatmap'); },
      dropoutRisk(minScore)  {
        const qs = minScore !== undefined ? ('?minScore=' + encodeURIComponent(minScore)) : '';
        return request('/admin/analytics/dropout-risk' + qs);
      },
      teacherStats()         { return request('/admin/analytics/teacher-stats'); },
      paymentsOverview()     { return request('/admin/analytics/payments-overview'); },
      scheduleConflicts(params) {
        const q = new URLSearchParams();
        if (params) Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') q.set(k, v); });
        const qs = q.toString();
        return request('/admin/analytics/schedule-conflicts' + (qs ? '?' + qs : ''));
      },
      generateSchedule(body) {
        return request('/admin/schedule/generate', { method: 'POST', body: body || {} });
      },
    },

    // Security (IT_AUDITOR)
    security: {
      overview()      { return request('/admin/audit/overview'); },
      anomalies(params) {
        const q = new URLSearchParams();
        if (params) Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') q.set(k, v); });
        const qs = q.toString(); return request('/admin/audit/anomalies' + (qs ? '?' + qs : ''));
      },
      reviewAnomaly(key, status, note) {
        return request('/admin/audit/anomalies/review', { method: 'PATCH', body: { key, status, note: note || undefined } });
      },
      auditLog(id)     { return request('/admin/audit/audit-logs/' + encodeURIComponent(id)); },
      auditFacets()    { return request('/admin/audit/audit-logs/facets'); },
      loginActivity(hours) { return request('/admin/audit/login-activity' + (hours ? '?hours=' + encodeURIComponent(hours) : '')); },
      config()        { return request('/admin/audit/config'); },
      dependencies() { return request('/admin/audit/dependencies'); },
      auditLogs(params) {
        const q = new URLSearchParams();
        if (params) Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') q.set(k, v); });
        const qs = q.toString(); return request('/admin/audit/audit-logs' + (qs ? '?' + qs : ''));
      },
      loginLogs(params) {
        const q = new URLSearchParams();
        if (params) Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') q.set(k, v); });
        const qs = q.toString(); return request('/admin/audit/login-logs' + (qs ? '?' + qs : ''));
      },
      failedLogins24h() { return request('/admin/audit/failed-logins-24h'); },
      lockedAccounts()  { return request('/admin/audit/locked-accounts'); },
      headersSnapshot() { return request('/admin/audit/headers-snapshot'); },
      aiChatsStats()    { return request('/admin/audit/ai-chats/stats'); },
      aiChats(params) {
        const q = new URLSearchParams();
        if (params) Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') q.set(k, v); });
        const qs = q.toString(); return request('/admin/audit/ai-chats' + (qs ? '?' + qs : ''));
      },
      aiChat(id) { return request('/admin/audit/ai-chats/' + encodeURIComponent(id)); },
      flagAiChat(id, flagged, reason) {
        return request('/admin/audit/ai-chats/' + encodeURIComponent(id) + '/flag', {
          method: 'PATCH',
          body: { flagged: !!flagged, reason: reason || undefined },
        });
      },

      // Anomaly detection (AI features)
      anomaliesOverview(hours) {
        const qs = hours !== undefined ? ('?hours=' + encodeURIComponent(hours)) : '';
        return request('/admin/audit/anomalies/overview' + qs);
      },
      loginAnomalies(hours) {
        const qs = hours !== undefined ? ('?hours=' + encodeURIComponent(hours)) : '';
        return request('/admin/audit/anomalies/login' + qs);
      },
      massExport(hours) {
        const qs = hours !== undefined ? ('?hours=' + encodeURIComponent(hours)) : '';
        return request('/admin/audit/anomalies/mass-export' + qs);
      },
      criticalChanges(hours) {
        const qs = hours !== undefined ? ('?hours=' + encodeURIComponent(hours)) : '';
        return request('/admin/audit/anomalies/critical-changes' + qs);
      },
    },

    // AI (все роли — разные endpoints доступны в зависимости от роли)
    ai: {
      gpaWhatIf(forecast, note) {
        return request('/ai/gpa-whatif', { method: 'POST', body: { forecast, note } });
      },
      draftRequest(type, note, subjectCode) {
        return request('/ai/request-draft', { method: 'POST', body: { type, note, subjectCode } });
      },
      searchMaterials(query, subjectCode) {
        return request('/ai/material-search', { method: 'POST', body: { query, subjectCode } });
      },
      generateQuestions(dto) {
        return request('/ai/question-gen', { method: 'POST', body: dto });
      },
      dropoutRisk(dto) {
        return request('/ai/dropout-risk', { method: 'POST', body: dto || {} });
      },
      auditAnomaly(hoursBack) {
        return request('/ai/audit-anomaly', { method: 'POST', body: { hoursBack } });
      },
      translate(text, source) {
        return request('/ai/translate', { method: 'POST', body: { text, source } });
      },
      // Role-aware ассистент: роль и права определяет сервер по JWT
      assistantConfig()            { return request('/ai/assistant/config'); },
      assistantAsk(message, lang, sessionId)   { return request('/ai/assistant/ask', { method: 'POST', body: { message, lang, sessionId: sessionId || undefined } }); },
      assistantAction(topic, lang, sessionId)  { return request('/ai/assistant/action', { method: 'POST', body: { topic, lang, sessionId: sessionId || undefined } }); },
      mySessions()     { return request('/ai/my-sessions'); },
      mySession(id)    { return request('/ai/my-sessions/' + encodeURIComponent(id)); },
    },

    // SUPER_ADMIN / Admin Panel: справочники, роли и права, сессии, состояние системы, поиск
    admin: {
      students(p)             { return request('/admin/students' + qs(p)); },
      createStudent(dto)      { return request('/admin/students', { method: 'POST', body: dto }); },
      updateStudent(id, dto)  { return request('/admin/students/' + id, { method: 'PATCH', body: dto }); },
      archiveStudent(id, on)  { return request('/admin/students/' + id + (on ? '/archive' : '/unarchive'), { method: 'POST', body: {} }); },
      teachers(p)             { return request('/admin/teachers' + qs(p)); },
      createTeacher(dto)      { return request('/admin/teachers', { method: 'POST', body: dto }); },
      updateTeacher(id, dto)  { return request('/admin/teachers/' + id, { method: 'PATCH', body: dto }); },
      groups()                { return request('/admin/groups'); },
      group(name)             { return request('/admin/groups/' + encodeURIComponent(name)); },
      renameGroup(name, newName) { return request('/admin/groups/' + encodeURIComponent(name), { method: 'PATCH', body: { newName } }); },
      subjects(p)             { return request('/admin/subjects' + qs(p)); },
      createSubject(dto)      { return request('/admin/subjects', { method: 'POST', body: dto }); },
      updateSubject(id, dto)  { return request('/admin/subjects/' + id, { method: 'PATCH', body: dto }); },
      deleteSubject(id)       { return request('/admin/subjects/' + id, { method: 'DELETE' }); },
      roles()                 { return request('/admin/roles'); },
      setPermission(role, permission, scope) { return request('/admin/roles/permissions', { method: 'PUT', body: { role, permission, scope } }); },
      sessions()              { return request('/admin/sessions'); },
      revokeSession(id)       { return request('/admin/sessions/' + id + '/revoke', { method: 'POST', body: {} }); },
      health()                { return request('/admin/system/health'); },
      search(q)               { return request('/admin/search' + qs({ q })); },
      userAction(id, action, body) { return request('/admin/users/' + id + '/' + action, { method: 'POST', body: body || {} }); },
    },
    // Timetable (University scheduling system)
    timetable: {
      refs(p)                 { return request('/timetable/refs' + qs(p)); },
      config(p)               { return request('/timetable/config' + qs(p)); },
      patchConfig(p, dto)     { return request('/timetable/config' + qs(p), { method: 'PATCH', body: dto }); },
      timeSlots()             { return request('/timetable/time-slots'); },
      createTimeSlot(dto)     { return request('/timetable/time-slots', { method: 'POST', body: dto }); },
      patchTimeSlot(id, dto)  { return request('/timetable/time-slots/' + id, { method: 'PATCH', body: dto }); },
      deleteTimeSlot(id)      { return request('/timetable/time-slots/' + id, { method: 'DELETE' }); },
      lessonTypes()           { return request('/timetable/lesson-types'); },
      createLessonType(dto)   { return request('/timetable/lesson-types', { method: 'POST', body: dto }); },
      patchLessonType(id, d)  { return request('/timetable/lesson-types/' + id, { method: 'PATCH', body: d }); },
      deleteLessonType(id)    { return request('/timetable/lesson-types/' + id, { method: 'DELETE' }); },
      rules(p)                { return request('/timetable/rules' + qs(p)); },
      createRule(dto)         { return request('/timetable/rules', { method: 'POST', body: dto }); },
      patchRule(id, dto)      { return request('/timetable/rules/' + id, { method: 'PATCH', body: dto }); },
      deleteRule(id)          { return request('/timetable/rules/' + id, { method: 'DELETE' }); },
      myAvailability()        { return request('/timetable/availability/me'); },
      setMyAvailability(dto)  { return request('/timetable/availability/me', { method: 'PUT', body: dto }); },
      requirements(p)         { return request('/timetable/requirements' + qs(p)); },
      createRequirement(dto)  { return request('/timetable/requirements', { method: 'POST', body: dto }); },
      patchRequirement(id, d) { return request('/timetable/requirements/' + id, { method: 'PATCH', body: d }); },
      deleteRequirement(id)   { return request('/timetable/requirements/' + id, { method: 'DELETE' }); },
      buildRequirements(dto)  { return request('/timetable/requirements/build', { method: 'POST', body: dto }); },
      importRequirements(dto) { return request('/timetable/requirements/import', { method: 'POST', body: dto }); },
      versions(p)             { return request('/timetable/versions' + qs(p)); },
      createVersion(dto)      { return request('/timetable/versions', { method: 'POST', body: dto }); },
      version(id)             { return request('/timetable/versions/' + id); },
      overview(id)            { return request('/timetable/versions/' + id + '/overview'); },
      patchVersion(id, dto)   { return request('/timetable/versions/' + id, { method: 'PATCH', body: dto }); },
      versionAction(id, a, b) { return request('/timetable/versions/' + id + '/' + a, { method: 'POST', body: b || {} }); },
      diff(id, against)       { return request('/timetable/versions/' + id + '/diff' + qs({ against })); },
      lessons(id, p)          { return request('/timetable/versions/' + id + '/lessons' + qs(p)); },
      entity(id, by, value)   { return request('/timetable/versions/' + id + '/entity' + qs({ by, value })); },
      calendar(id, p)         { return request('/timetable/versions/' + id + '/calendar' + qs(p)); },
      createLesson(id, dto)   { return request('/timetable/versions/' + id + '/lessons', { method: 'POST', body: dto }); },
      lockLessons(id, ids, locked) { return request('/timetable/versions/' + id + '/lessons/lock', { method: 'POST', body: { ids, locked } }); },
      patchLesson(lid, dto)   { return request('/timetable/lessons/' + lid, { method: 'PATCH', body: dto }); },
      deleteLesson(lid)       { return request('/timetable/lessons/' + lid, { method: 'DELETE' }); },
      conflicts(id, p)        { return request('/timetable/versions/' + id + '/conflicts' + qs(p)); },
      generate(dto)           { return request('/timetable/jobs', { method: 'POST', body: dto }); },
      jobs(p)                 { return request('/timetable/jobs' + qs(p)); },
      job(id)                 { return request('/timetable/jobs/' + id); },
      cancelJob(id)           { return request('/timetable/jobs/' + id + '/cancel', { method: 'POST' }); },
      exportFile(id, p)       { return download('/timetable/versions/' + id + '/export' + qs(p)); },
      myCalendar(p)           { return request('/timetable/me/calendar' + qs(p)); },
    },
    health() { return request('/health/ready'); },
  };

  global.AP = global.AP || {};
  global.AP.api = api;
})(window);
