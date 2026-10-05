# Odlar Yurdu University — Academic Management Portal

Academic management portal: students, teachers, groups, subjects, Academic Journal, attendance, timetable and generator,
requests, payments, roles & permissions, security dashboard and audit log.

> This is a presentation environment. All users, groups, subjects, rooms, grades and other records are generated test
> data — no real personal data. Test accounts use the `.demo` login suffix.
## Quick start

Requires Docker Desktop.

```bash
cp .env.example .env        # then set your own secrets (start-demo.bat does this automatically on Windows)
docker compose up -d --build
```

Open <http://localhost:3000> and sign in with one of the test accounts below. The first start fills the database with the test dataset.

## Demo accounts

All demo accounts share the password `Demo@Portal2026` (it is public by design — the data is fictional).

| Role | Login ID |
|---|---|
| Super admin (incl. security dashboard, anomalies, audit log) | `superadmin.demo` |
| Rector / Vice-Rector (whole university) | `rector.demo`, `prorector.demo` |
| Deans (own faculty) | `dean.demo` (Təbiət və Texnologiyalar), `dean2.demo` (İqtisadiyyat və İdarəetmə), `dean3.demo` (Humanitar, təhsil və dillər) |
| Head of department (own department) | `kafedra.demo` (Riyaziyyat və informatika) |
| Tutor (assigned groups) | `tutor.demo` (KM-21, İT-11) |
| Invigilator (exam room B101 / B102) | `proctor.demo`, `proctor2.demo` (B102) |
| Teacher | `teacher1.demo` … `teacher20.demo` |
| Student | `student1.demo` … `student120.demo` |

## Dataset (bachelor)

Real organisational structure of the bachelor programme from oyu.edu.az: 3 faculties, 8 departments, 23 specialties (with codes).
12 academic groups across the faculties (courses 1–4), 120 students (`Student 1…120`), 20 teachers (`Teacher 1…20`), illustrative
8-semester / 240-credit curricula for the specialties that have groups, a conflict-free timetable, journal grades with past semesters,
attendance, assignments, payments, requests, announcements and audit activity. People are anonymised test accounts.
Master's programmes are supported by the code (levels, time slots) and will be added to the data later.

## Exam Management System

Final exams, computer and paper exams, question banks with approval and versions, 25% resits with demo payment, retakes and summer
retakes. Architecture, state machines and the rule → where-enforced table: [docs/exam-system/ARCHITECTURE.md](docs/exam-system/ARCHITECTURE.md).

- **Student** → *Exams* tab (Upcoming / Available / Completed / Resits / Results / Retakes). Students never start an exam themselves.
- **Teacher** → *My Exams*: question bank editor, CSV/XLSX import, versions, approval status, results after publication.
- **Management** → *Exams* group in the admin panel: windows, question review, workstations & proctors, paper exams, resits & payments, retakes, results, analytics, audit.
- **Invigilator** (Наблюдатель / Nəzarətçi) → `/proctor.html`: find student → verify ID + passport → subject (eligibility) → workstation → START EXAM.
- **Exam computer** → `/exam.html` (kiosk). Enter the workstation key once; the demo keys are `wk_demo_<ROOM>_<PC>`, e.g. `wk_demo_B101_PC-01`
  (rooms B101 — 30 PCs, B102 — 12 PCs). Keep the kiosk page open: a PC counts as *online* only while it polls the server.

Try it (works from home — no network restriction in the demo): open `/exam.html` and pick a computer from the demo list (or enter key `wk_demo_B101_PC-01`), sign in as `proctor.demo` (invigilator) in another, authorize `student1.demo` for a subject on PC-01,
then press *START EXAM* in the kiosk tab. Demo question banks are arithmetic questions (the same for every subject). The demo final window is open all day
(Mon–Sat, 00:00–23:59) so the flow can be tried at any time; real windows use the allowed days/time set by Management.

Exam rules live in the backend only (`oyu-backend/src/modules/exams`): window/day/time check, max 3 finals per week, one attempt per exam,
one-time launch token bound to student + exam + workstation, server-side timer, random 25 questions with shuffled options, scoring (+2 / −1 / 0),
pass = Total ≥ 51 **and** Exam ≥ 17, 25% resit (credits × 15 AZN × 0.25, max 2 per semester cycle), retake separate from resit.
Tests (need the stack running and fresh demo data):

```bash
node oyu-backend/test/exam-e2e.js          # student / proctor / kiosk / limits / payments
node oyu-backend/test/exam-e2e-bank.js     # question banks, approval, versions, deadlines, windows
node oyu-backend/test/exam-e2e-resit.js    # resit exam, retake, window closing  (run after a demo reset)
cd oyu-backend && npx ts-node --transpile-only test/exam-e2e-paper.ts   # paper exams + OMR
```

**Exam appeals** are regular requests (`Request.type = APPEAL`) with exam details: after a result is published the student opens *Review exam*
(questions, own answers, points; the answer key stays hidden), selects disputed questions, picks a reason and writes an explanation for each, and submits one appeal.
The teacher of the subject reviews it per question (or escalates to the dean / head of department); the decision recalculates only the FINAL component
through GradeHistory, and the student is notified. Demo: `student2.demo` (pending appeal), `student4.demo` (under review), `student3.demo` (can appeal).
Details: [docs/exam-system/APPEALS.md](docs/exam-system/APPEALS.md). Test: `node oyu-backend/test/appeal-e2e.js` (fresh demo data).

Optional `EXAM_ALLOWED_NETWORKS` (CIDR list) restricts the exam kiosks to the university network, in addition to the workstation key.

## Restoring the demo database (owner only)

Visitors cannot reset the demo. The owner of the infrastructure can:

```bash
# CLI (inside the running stack)
docker compose exec portal-api node dist/demo/reset.cli.js

# HTTP (requires SUPER_ADMIN access token AND the owner secret from .env)
curl -X POST http://localhost:3001/api/v1/demo/reset \
  -H "Authorization: Bearer <super admin token>" -H "X-Demo-Reset-Token: <DEMO_RESET_TOKEN>"
```

Both work only when `DEMO_MODE=true`; the HTTP endpoint is disabled unless `DEMO_RESET_TOKEN` is set. A reset wipes all
data (including changes made by visitors) and recreates the dataset, roles & permissions and timetable settings.

## Security notes

- No production credentials, API keys or real personal data are stored in the repository. Secrets come from `.env`
  (git-ignored); `docker-compose.yml` has **no default secrets** and refuses to start without them.
- The AI assistant works in stub mode unless `ANTHROPIC_API_KEY` is provided.
- Payments are a demo simulation; there is no bank integration.
- See `backend/SECURITY.md` for the security model.

## Project layout

- `backend/` — NestJS 10 + Prisma 5 + PostgreSQL API (`/api/v1`), RBAC, audit log, timetable engine
- `frontend/` — static HTML/CSS/vanilla JS served by Express
- `docker-compose.yml` — database, API and web

## Development

```bash
cd backend && npm install && npx prisma migrate deploy && npm run seed && npm run start:dev
npm run typecheck && npm test          # backend checks
```

## Languages

The interface is available in Azerbaijani, Russian and English.
