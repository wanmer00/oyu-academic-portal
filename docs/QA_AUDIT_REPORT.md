# QA AUDIT REPORT — Academic Portal

Date: 2026-10-05 · Environment: local docker (`NODE_ENV=production`, `DEMO_MODE=true`), demo seed · Build: current `main` working tree (after refactor phase P0)

Method: code review of every backend module + live API probes (direct calls, bypassing the UI) + browser checks (375px, RU locale) + the existing automated suites. Every finding is marked **CONFIRMED** (reproduced live or proven by code path with no alternative), **SUSPICION** or **UNVERIFIED**. Nothing was fixed during the audit; demo data was reseeded afterwards.

---

## Executive summary

The academic core is in good shape: GPA/Transcript are consistent (single backend source), exam lifecycle and appeals are covered by 223 E2E assertions, authentication is solid (Argon2id, rotation + reuse detection, HttpOnly cookie, DB re-check of the user on every request), and most direct-API RBAC checks hold (students/teachers cannot reach admin APIs, View-as is SUPER_ADMIN-only, IDOR on requests/notifications/materials is blocked).

The release blockers are elsewhere: **money can be marked as paid by the student without any payment provider**, **faculty-scoped administrators can read/modify students and decide requests of other faculties by ID**, and two **user-visible features are fake** (assignment "file" submission, PDF/DOC materials without files). Request handling has ownership and state-machine gaps. i18n is incomplete in RU/EN.

**Verdict: not production-ready** (see the final section).

## Quality score

| Area | Score |
|---|---|
| Business Logic | 6/10 |
| Functional | 7/10 |
| Security | 5/10 |
| Data Integrity | 6/10 |
| UX | 6/10 |
| UI | 7/10 |
| Performance | 7/10 |
| Accessibility | 5/10 (not deeply tested) |
| i18n | 5/10 |
| Architecture QA | 7/10 |
| **Overall** | **6/10** |

## Modules tested

| Module | Representative role | Tested | Bugs | Max severity |
|---|---|---|---|---|
| Auth / sessions | all | E2E 33/33 + probes | 0 open (fixed in P0) | — |
| Payments | Student, Super Admin | probes | 4 | BLOCKER |
| Exams + resits | Student, Admin | E2E 165/165 + code | 1 (resit pay) | BLOCKER |
| Appeals | Student, Teacher | E2E 58/58 | 0 | — |
| Requests | Student, Teacher, Dean | probes | 6 | CRITICAL |
| Admin directory (students) | Dean (ADMIN, faculty scope) | probes | 1 | CRITICAL |
| Assignments | Student, Teacher | probes + code | 4 | MAJOR |
| Materials | Teacher, Student | probes + code | 1 | MAJOR |
| Journal / attendance / grades | Teacher, Student | unit 42 + scope probe | 0 new | — |
| GPA / transcript / progress | Student | E2E + browser | 0 (fixed in P0) | — |
| Notifications / announcements | Student | probes | 0 | — |
| RBAC / View-as / roles | Student, Teacher, Admin | probes | 0 | — |
| AI assistant | Student | code | 1 | MAJOR |
| Security headers / CORS / demo endpoints | anon | probes | 1 (info) | MINOR |
| Admin UI (45 pages) | Super Admin | browser 375px | 3 | MINOR |
| Student UI (14 pages) | Student, RU | browser 375px | 4 | MINOR |
| Timetable | Admin | **not re-tested** (engine unit tests only) | — | UNVERIFIED |

---

## Critical findings

### QA-001 — Student can mark tuition as PAID without paying
- **Status:** CONFIRMED · **Severity:** BLOCKER · **Priority:** P0
- Module: Payments · Role: Student · API: `POST /me/payments/:id/pay` · Backend: `payments.service.ts payMock` · DB: `Payment`
- Precondition: student with a PENDING/PROCESSING payment (demo: student3).
- Steps: 1) log in as the student; 2) `POST /api/v1/me/payments/<id>/pay`.
- Expected: real provider flow (or 404 outside demo).
- Actual: `201`, status → `PAID`, `providerRef=DEMO-…`, notification "Payment received". **Not gated by `DEMO_MODE`** — the same happens in production.
- Business impact: free tuition; financial records falsified; debts screen and analytics show paid.
- Notes: also allows paying `FAILED` payments (only `PAID` is rejected). Regression risk: low (endpoint isolated).

### QA-002 — Resit fee is "paid" instantly by a demo provider in every environment
- **Status:** CONFIRMED (code) · **Severity:** BLOCKER · **Priority:** P0
- API: `POST /me/resits/:id/pay` · Backend: `resit.service.ts` (`DemoPaymentProvider` hard-wired; only the `simulate=FAIL` switch checks `DEMO_MODE`).
- Actual: resit becomes `RESIT_PAID` without payment in production → student gets a paid resit attempt.
- Fix direction: provider selected by config; demo provider allowed only when `DEMO_MODE`; otherwise 501/"payment provider not configured".

### QA-003 — Faculty-scoped admin reads and edits students of other faculties (BOLA)
- **Status:** CONFIRMED · **Severity:** CRITICAL · **Priority:** P0
- Role: ADMIN with position DEAN (`dean.demo`, faculty "Təbiət və Texnologiyalar") · API: `GET/PATCH /admin/students/:id` · Backend: `admin-directory.service.ts`
- Steps: 1) log in as dean.demo; 2) take a student of group `BİZ-11` (other faculty); 3) `GET /admin/students/<id>` → **200** with profile; 4) `PATCH … {phone}` → **200**, data changed.
- Expected: 403 `ORG_SCOPE_DENIED`, as `GET /admin/students/:id/progress` and `GET /admin/groups/BİZ-11` already return.
- Business impact: privacy breach (PII of the whole university) and unauthorised changes; inconsistent scope model.
- Notes: list endpoint is scoped, detail/mutations are not; check `archive/unarchive` too (SUSPICION, same service).

### QA-004 — Dean decides requests of other faculties by ID (BOLA)
- **Status:** CONFIRMED · **Severity:** CRITICAL · **Priority:** P0
- API: `PATCH /admin/requests/:id` · Backend: `admin.service.ts updateRequestStatus` (no `groups` check; `listRequests` is scoped).
- Steps: dean.demo approves a PENDING CERTIFICATE request of a `BİZ-11` student → **200 APPROVED**, student notified.
- Expected: 403.

### QA-005 — Assignment "submission" uploads no file
- **Status:** CONFIRMED · **Severity:** CRITICAL (false feature in a core academic workflow) · **Priority:** P1
- Frontend: `portal.html #submit-form` — field "Имя файла" is a free text input (placeholder `report.pdf`). API stores `fileName` string only. Teacher sees the typed name, cannot open any work.
- Same for materials of type PDF/DOC without URL (`fileName` badge, nothing to download).
- Fix options: (a) real upload storage (S3/local volume, MIME/size validation, AV scan, signed download) or (b) honest "link to your work (Google Drive/OneDrive URL)" with http(s) validation. Decision needed (architecture change).

---

## Business logic bugs

| ID | Title | Status | Sev | Pri |
|---|---|---|---|---|
| QA-006 | Resubmitting a GRADED assignment resets status to SUBMITTED/LATE while keeping the grade (observed: `status=LATE grade=89`) — graded work reappears in teacher's queue, student can replace work after grading | CONFIRMED | MAJOR | P1 |
| QA-007 | Teacher can flip request decisions without a state machine: APPROVED → REJECTED → PENDING all `200`, a notification each time (`teachers.service replyRequest`) | CONFIRMED | MAJOR | P1 |
| QA-008 | `OTHER` requests are owned by both the admin queue and **every** teacher of the student's group (5 teachers for KM-21) — two parties can decide the same request; personal requests are visible to all group teachers | CONFIRMED | MAJOR | P1 |
| QA-009 | Student can change a PENDING CERTIFICATE request to type `APPEAL` via PATCH → it leaves the admin queue and appears to teachers as an "appeal" without exam data | CONFIRMED | MAJOR | P1 |
| QA-010 | Request description of only spaces accepted (`"       "`, min(5) counts spaces) | CONFIRMED | MINOR | P2 |
| QA-011 | Daily request quota: day boundary is server time (UTC container ⇒ resets 04:00 Baku); check-then-insert race allows exceeding the limit with parallel requests | CONFIRMED (code) | MINOR | P3 |
| QA-012 | Teacher can create an assignment with due date in the past (no validation) | SUSPICION (probe hit subject-not-found first) | MINOR | P3 |
| QA-013 | Grade-point scale vs letter scale misaligned: 90 → 4.0 points but letter B (91 = A) | CONFIRMED | MINOR | P2 (business decision) |
| QA-014 | Payment summaries add amounts of different currencies; admin totals are computed only over the first 200 rows (`take`) | CONFIRMED (code) | MINOR | P2 |

## Security bugs

| ID | Title | Status | Sev | Pri |
|---|---|---|---|---|
| QA-001/002 | Unpaid → PAID by student (tuition, resit) | CONFIRMED | BLOCKER | P0 |
| QA-003/004 | Cross-faculty BOLA (students, requests) | CONFIRMED | CRITICAL | P0 |
| QA-015 | AI chat transcripts are stored and readable by auditors (`/admin/audit/ai-chats`) — the chat UI has no privacy notice | CONFIRMED | MAJOR | P1 |
| QA-016 | Profile `phone` accepts `<script>😀</script>` (no format validation). Output is escaped in checked screens → stored-XSS not reproduced | CONFIRMED (input) / not exploitable where checked | MINOR | P2 |
| QA-017 | Access token stays valid up to 15 min after admin password reset (blocked/deleted users are cut immediately) | CONFIRMED (code) | MINOR | P3 |
| info | Demo workstation keys are public (`/exam-runtime-demo/workstations`) — by design, 404 when `DEMO_MODE=false` | expected | — | — |

Passed security checks: student/teacher → admin APIs 403; X-View-As by non-SUPER_ADMIN 403; ADMIN cannot edit permission matrix, cannot touch SUPER_ADMIN, cannot change own role; IDOR on requests/notifications/materials blocked; `javascript:` URLs rejected; CORS rejects foreign origin; CSP/HSTS/X-Frame-Options present; 200 KB payload → 413; malformed JSON → 400; refresh token never in JSON; identical login error for unknown user / wrong password.

## Data integrity bugs

- QA-006 (grade kept on resubmitted work), QA-009 (request type inconsistent with workflow), QA-014 (mixed currencies).
- QA-018 — `Payment` statuses `FAILED`/`PROCESSING` can be overwritten to PAID by the student (part of QA-001). CONFIRMED.

## Functional bugs

- QA-005 (no file upload).
- QA-019 — admin request PATCH with an unknown field returns `"Validation failed", issues: {}` — no hint what is wrong (strict schema, empty issues). CONFIRMED · MINOR · P2.

## UI/UX bugs (browser, 375px)

| ID | Screen | Finding | Status | Sev |
|---|---|---|---|---|
| QA-020 | Admin → Security → Logins | card content overflows viewport at 375px (`.card`, `.card-title`) | CONFIRMED | MINOR |
| QA-021 | Admin → Roles | raw permission keys (`users.view`, …) shown as labels | CONFIRMED | TRIVIAL |
| QA-022 | Admin → Security overview / audit | raw action codes (`payment.pay_mock`, `request.reply`) | CONFIRMED | TRIVIAL (technical audience) |
| — | All 45 admin pages, 14 student pages | no page-level horizontal scroll at 375px | PASS | — |

## i18n bugs (RU locale)

| ID | Where | Text | Status |
|---|---|---|---|
| QA-023 | Student → Payments | status `PAID` raw; heading "Qəbul olunan ödəniş üsullar" in Azerbaijani | CONFIRMED |
| QA-024 | Student → Schedule | toggle "Həftə" (AZ), week parity `UPPER` raw | CONFIRMED |
| QA-025 | Student → Exams; Admin → Resits, KPI | `2026-2027 FALL` / `SPRING` raw | CONFIRMED |
| QA-026 | Student → Materials / Library | type `LINK`/`PDF`/`DOC` raw | CONFIRMED |
| QA-027 | Admin → Exam analytics | `PAID`, `PENDING` raw | CONFIRMED |
| QA-028 | Backend errors (requests, many services) | hard-coded Azerbaijani messages regardless of `X-Lang` (e.g. "Gündəlik limit (5 müraciət) tükənib…" with `X-Lang: en`) | CONFIRMED |
| QA-029 | portal.html | hard-coded AZ fallbacks/labels (`'qiymət'`, `'Gözləyir'`, `'→ detallar'` — the last two removed in P0 as dead code) | CONFIRMED (code) |

Severity for all i18n items: MINOR, priority P1 (product promises three languages).

## Performance issues

- Unbounded lists: `getForStudent` assignments, `listForStudent` payments, teacher assignments (with all submissions) — fine at demo scale, no pagination. SUSPICION for 1000+ students. P2.
- Admin payments summary computed in JS over ≤500 rows instead of SQL aggregate (also wrong, QA-014).

## Accessibility issues (limited check)

- Stat cards on the dashboard are `div role=button tabindex=0` with Enter/Space handlers (OK). Modals: Escape/focus-trap **UNVERIFIED**. Contrast / 200% zoom **UNVERIFIED**.

## Cross-module bugs

- Payment → Debts/analytics: QA-001 makes debts disappear without money.
- Request type change (QA-009) moves a request between admin and teacher modules silently.
- Assignment grade ↔ resubmission (QA-006) breaks teacher dashboard counters (`pendingCount` counts graded work again).
- Verified consistent: Journal → GPA → Transcript → Dashboard (same value, E2E); Exam result → Journal FINAL → GPA (appeal E2E).

## Regression risks

- Fixing QA-003/004 touches `OrgScopeService` usage in admin directory — risk for SUPER_ADMIN (unscoped) and RECTOR views; needs tests for each position.
- Changing request ownership (QA-008) changes teacher/admin queues and notifications.
- E2E suites share demo state (run with reset between suites).

## Missing features (not bugs)

- Real file storage for submissions/materials.
- Real payment provider integration (webhook, idempotency, receipts).
- 2FA/TOTP (removed from UI in P0; schema reserved).
- Password self-service (change/reset by email).
- Pagination for student-facing lists.

## False / misleading features

1. Assignment file submission (QA-005).
2. PDF/DOC materials without a file (QA-005).
3. "Pay" buttons for tuition and resit in production (QA-001/002).
4. ~~2FA status~~ — fixed in P0.

## Technical debt

- Two separate "demo provider" payment paths (payments, resits).
- Error messages hard-coded per language in services instead of i18n keys/codes.
- Admin directory scope logic duplicated per endpoint instead of one guard.
- E2E suites not independent; no Playwright UI tests; no CI.

## Recommended fix order

**P0 (security / money / access)**
1. QA-001, QA-002, QA-018 — gate demo payment providers by `DEMO_MODE`; otherwise "provider not configured"; forbid paying FAILED/CANCELLED.
2. QA-003, QA-004 — enforce org scope on every admin student/request mutation and detail read; tests per position.

**P1 (business logic, false features, i18n)**
3. QA-006 — block resubmission after GRADED (or keep history and require teacher reopening).
4. QA-007, QA-008, QA-009 — single owner per request type, shared transition table for teacher+admin, type immutable after creation.
5. QA-005 — decide: real upload vs. honest link field.
6. QA-015 — AI privacy notice in chat + retention policy.
7. QA-023…QA-029 — translate enums/labels; backend error codes → i18n.

**P2** — QA-010, QA-013 (business decision), QA-014, QA-016, QA-019, QA-020, pagination.

**P3** — QA-011, QA-012, QA-017, QA-021, QA-022.

## Final verdict

**Not production-ready.** Reasons:
1. Students can mark tuition and resit fees as paid without paying, in production configuration (QA-001/002).
2. Faculty-level administrators can read and change data and decide requests outside their faculty (QA-003/004).
3. Assignment submission — a core academic workflow — does not transfer any work (QA-005).

After P0 + items 3–5 of P1 are fixed and re-tested, the system can be considered for a controlled pilot.

### Not covered / UNVERIFIED
Timetable conflict/concurrency (only engine unit tests), browser compatibility (Chromium only), network loss during exams (covered by E2E autosave design but not re-run in a browser), accessibility beyond keyboard on stat cards, payment callback duplication (no callbacks exist).
