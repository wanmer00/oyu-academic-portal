# Odlar Yurdu University — Academic Management Portal (Backend)

Backend of the Odlar Yurdu University academic portal. Stack: **NestJS + TypeScript + Prisma + PostgreSQL**. All data is fictional.

## Quick start (local)

```bash
cp .env.example .env            # set your own values
npm install
docker compose up -d postgres   # from the repository root: only the database
npm run prisma:generate
npm run prisma:deploy           # apply migrations
npm run seed                    # fills an EMPTY database with the demo dataset
npm run start:dev
```

The API listens on **http://localhost:3001**, prefix `/api/v1`.

Useful scripts: `npm run typecheck`, `npm test`, `npm run build`, `npm run demo:reset` (owner only, needs `DEMO_MODE=true`).

## Demo accounts

Password for every demo account: `Demo@Portal2026`.

| Role | Login ID |
|---|---|
| SUPER_ADMIN | `superadmin.demo` |
| ADMIN (leadership) | `rector.demo`, `prorector.demo`, `dean.demo`, `tutor.demo` |
| TEACHER | `teacher1.demo` … `teacher10.demo` |
| STUDENT | `student1.demo` … `student50.demo` |

Dataset: 50 students in 5 groups, 10 teachers, 28 subjects, 14 rooms, a conflict-free weekly timetable, journal grades
(Final 50 / Midterm 30 / Seminar 20), attendance, assignments, payments, announcements, login history and audit activity.

## Demo reset (owner only)

`npm run demo:reset` (or `docker compose exec portal-api node dist/demo/reset.cli.js`) wipes all data and recreates the
demo dataset. `POST /api/v1/demo/reset` does the same but requires a SUPER_ADMIN token **and** the secret
`DEMO_RESET_TOKEN` in the `X-Demo-Reset-Token` header; it is disabled when `DEMO_RESET_TOKEN` is empty or
`DEMO_MODE` is not `true`. Public visitors do not know the secret.

---
## Endpoints (v1 — текущая итерация)

### Публичные
- `POST /api/v1/auth/login` — `{loginId, password}` → access token + refresh cookie
- `POST /api/v1/auth/refresh` — использует refresh cookie
- `GET  /api/v1/health/live` · `GET /api/v1/health/ready`

### Требуют `Authorization: Bearer <accessToken>`
- `POST /auth/logout` (публичный: очищает cookie даже при истёкшем токене) · `GET|PATCH /me`
- **STUDENT** `/me/*`: info, grades, schedule, transcript, subjects-overview, assignments, materials, requests, payments; общие: calendar, announcements
- **TEACHER** `/teacher/*` — доступ строится по расписанию (пара «предмет × группа», где `ScheduleSlot.teacherId` = преподаватель); всё вне этой области → 403:
- `dashboard`, `classes`, `analytics?groupName&subjectCode`, `subjects`, `groups`, `schedule`
- оценки, журнал, публикация, импорт, экспорт — единый модуль **Academic Journal** (/journal/*, см. раздел ниже); старые /teacher/journal, /teacher/grades* удалены
- посещаемость — часть **Academic Journal** (единственная реализация, модуль `attendance`): `GET /journal/attendance/day` (список группы на дату), `POST|DELETE /journal/attendance` (отметка / удаление; период по дате, будущие даты и закрытый период запрещены, правки аудируются с old/new), `GET /journal/attendance/stats`, `GET /journal/attendance/student` (студент — своя, преподаватель/админ — по scope), `GET /journal/attendance/report`, `GET /journal/attendance/export.csv`. Права: `attendance.view|create|update|delete|statistics|override`, scope ASSIGNED/ALL/OWN. Старые `/teacher/attendance*`, `/me/attendance*` удалены
  - задания: `GET|POST assignments`, `PATCH assignments/:id`, `POST assignments/:id/status` (DRAFT/PUBLISHED/CLOSED), `GET assignments/:id/submissions`, `PATCH submissions/:id`
  - материалы: `GET|POST materials`, `PATCH|DELETE materials/:id` (чужие — только просмотр; только http/https)
  - заявки: `GET requests`, `PATCH requests/:id` — только APPEAL/OTHER студентов своих групп
- **LEADERSHIP** `/leadership/*`:
  - `dashboard`, `kpi?weeks=` (тренды только из реальных данных; пустой ряд = нет данных), `stats`, `analytics/*`
  - `users?role&status&search&locked&take&cursor` (+ `total`), `users/:id` (профиль без секретов)
  - `requests?scope=admin|all&status&type`, `PATCH requests/:id` — только CERTIFICATE/TRANSFER/OTHER, переходы PENDING→APPROVED|REJECTED, решение→PENDING; APPEAL — read-only (решает преподаватель)
  - `rooms` (+ загрузка/вместимость), `schedule` (конфликты TEACHER/ROOM/GROUP/CAPACITY → 409), `schedule/generate` (zod)
  - `calendar` (время, аудитория, группа), `POST calendar/check` — конфликты ROOM_EVENT/ROOM_CLASS (блокируют; ROOM_CLASS можно разрешить `allowScheduleOverlap`), GROUP_* — предупреждения
  - `announcements`, `payments`; все изменения пишутся в AuditLog
- **IT_AUDITOR** `/security/*` (только чтение, кроме статуса разбора аномалий; изменения конфигурации через API невозможны):
  - `overview`, `anomalies?hours&type&severity&status`, `PATCH anomalies/review` (OPEN/ACKNOWLEDGED/RESOLVED/FALSE_POSITIVE, audit `security.anomaly_review`)
  - `audit-logs?from&to&user&action&targetType&severity&take&cursor` (+ `total`; без diff/userAgent), `audit-logs/:id` (diff с маскировкой секретов), `audit-logs/facets`
  - `login-logs?success&reason&from&to&search`, `login-activity?hours`, `config`, `dependencies`, `ai-chats/*`
  - severity событий — детерминированные правила по имени действия (`src/modules/security/severity.ts`)
- **Все роли** `/me/notifications`: `GET ?type=&unread=true` · `GET unread-count` · `POST :id/read` · `POST read-all` (только свои)
- **AI-ассистент** `/ai/assistant/*` (все роли): `GET config`, `POST ask {message, lang, sessionId?}`, `POST action {topic, lang, sessionId?}` — см. раздел «AI-ассистент»
- **AI** `/ai/*`: gpa-whatif, request-draft, material-search, question-gen, dropout-risk, translate, audit-anomaly, chat, my-sessions (без `ANTHROPIC_API_KEY` работает заглушка)

Формат ошибок: `{ statusCode, message (строка), details?, path, timestamp }`.

---

## Academic Journal (`/journal`)

Единый модуль для всех ролей: доступ определяет backend по JWT (роль и `userId` из токена, тела запросов строгие).

**Формула (единственный источник — `src/modules/journal/journal.calc.ts`, точная Decimal-арифметика):**

```
TOTAL   = FINAL (0..50) + MIDTERM (0..30) + SEMINAR (0..20)
SEMINAR = AVERAGE(все валидные ответы, каждый 0..10) × 2, только при >= 3 ответах
```

Меньше 3 ответов → `Pending`, итог помечается `provisional` (не выдаётся за окончательный). Округление — только для показа (16.666… → 16.67, точное значение в `scoreExact`). Шкала «буква / GPA» — официальная mapping AP (`toLetter`/`toGradePoints`); транскрипт и GPA считаются из итога Journal (в GPA попадают только завершённые опубликованные предметы), GPA What-If использует ту же mapping.

**Данные:** расширены существующие `Grade` (тип `SEMINAR`, `publishedAt`/`publishedBy`) и `GradeHistory`; новая `AcademicPeriod` (`OPEN|CLOSED`). Миграции `journal_schema` + `journal_data` (старые оценки пересчитаны пропорционально в 50/30, QUIZ → ответы на семинарах /10, история пересчёта записана в `GradeHistory`). Аудит — существующий `AuditLog` (`journal.*`), второй системы нет. Логика: Draft (`publishedAt = null`, студент не видит) → Publish; правка опубликованного требует причину; закрытый период блокируется на backend.

| Роль | Возможности |
|---|---|
| STUDENT | `GET /journal/me`, `GET /journal/me/subjects/:id` — только свои опубликованные данные |
| TEACHER | `GET /journal/records`, `/records/:studentId/:subjectId`, `POST /seminar-answers`, `PUT /components`, `PATCH|DELETE /grades/:id`, `POST /cells` (быстрый ввод), `/publish`, `/unpublish`, `/bulk[/preview]` (нужен `confirm: true`), `/import[/preview]`, `GET /export` — только свои пары «предмет × группа» (расписание); преподаватели одной пары равноправны, автор виден в аудите |
| LEADERSHIP | `GET /records`, `/analytics`, `/compare`, `/export`; `PATCH /periods/:id` (закрыть/открыть с причиной — единственный путь исключения из блокировки); оценки не меняет |
| IT_AUDITOR | `GET /audit`, `/audit/stats` — история изменений (кто, когда, старое/новое, причина), данных оценок не получает |

Пороги предупреждений: `JOURNAL_PASS_MARK` (60), `JOURNAL_LOW_ATTENDANCE` (75). Демо-данные журнала создаёт `npm run seed` / `npm run demo:reset` (оценки Final/Midterm/Seminar по всем студентам, прошлые семестры, часть записей без финала и неопубликованные). Тесты формулы: `npm test` (37 кейсов).
---

## AI-ассистент (`/ai/assistant`)

Роль-зависимый помощник (az/ru/en). Принцип: **ассистент видит не больше, чем сама роль в обычном API.**

- Роль и `userId` берутся только из JWT; тело запроса строгое (`role`/`userId` в нём недопустимы).
- Вопрос → набор «концептов» → темы, разрешённые роли (`assistant/topics.ts`). Чужие концепты (например, студент спрашивает журналы входов) получают отказ и пишутся в аудит как `ai.access_denied` (без текста вопроса).
- Данные собирает `AIContextService` теми же сервисами, что и обычные эндпоинты роли (например, преподаватель — только свои пары «предмет × группа»), в компактном виде: без email/телефонов/UA/паролей/токенов.
- Быстрые действия (`POST action`) принимают только ID темы своей роли, иначе `403`.
- Есть `ANTHROPIC_API_KEY` — ответ формулирует модель по тому же JSON-контексту с жёстким запретом выходить за него; нет ключа — детерминированные ответы по реальным данным (`GET config` → `live`).
- Ассистент только читает: команды «одобрить/удалить/поставить оценку» ничего не меняют.
- Лимит: `RATE_LIMIT_AI_MAX` (по умолчанию 30/мин).

| Роль | Темы |
|---|---|
| STUDENT | расписание сегодня, задания, GPA, оценки, посещаемость, заявки, платежи — только свои |
| TEACHER | мои классы, студенты без оценок, посещаемость, задания с низкой сдачей, активность своих групп, заявки |
| LEADERSHIP | KPI, заявки, учебная активность, посещаемость, платежи (агрегаты), карточка пользователя |
| IT_AUDITOR | события безопасности, входы, аномалии — только данные безопасности |
---
## Расписание (`/timetable`)

Университетская система расписания: нагрузка → генерация (фоновая задача) → черновик → проверка конфликтов → публикация. Использует существующие Student/Teacher/Subject/Room; группа, факультет и корпус — строки, как и во всём проекте.

- **Живое расписание** — таблица `ScheduleSlot`: его читают студенты, преподаватели, журнал и посещаемость. Версии и черновики живут в `ScheduleVersion`/`ScheduleLesson` и не видны студентам и преподавателям до публикации. Публикация атомарно заменяет слоты периода и блокируется при любом критическом конфликте (422 `PUBLISH_BLOCKED`).
- **Состояния версии:** `DRAFT → REVIEW → PUBLISHED → ARCHIVED`; версии нумеруются (v1, v2, …), есть diff и откат (новый черновик из любой версии).
- **Движок** (`src/modules/timetable/engine`): жадное построение с forward checking (битовые маски занятости), ejection-chain, затем simulated annealing по мягкой стоимости; жёсткие ограничения не нарушаются. Работает в `worker_threads`, отмена и прогресс — через SharedArrayBuffer/сообщения. Независимый Conflict Checker (`checker.ts`) используется и для проверки, и как верификатор в тестах.
- **Жёсткие ограничения:** преподаватель/группа/аудитория не заняты дважды, вместимость, тип аудитории и оборудование, доступность, рабочие дни и допустимые часы, слоты своего уровня, дубликаты, лимиты в день, разрешённые корпуса, все обязательные занятия размещены.
- **Мягкие (веса настраиваются):** «окна» групп и преподавателей, пары подряд, перегрузка и длинный день, переходы между корпусами, поздние пары, равномерность недели, повтор предмета в один/соседние дни, желаемое/нежелательное время, подбор аудитории по размеру.

| Метод | Путь | Право |
|---|---|---|
| GET | `/timetable/refs`, `/config`, `/time-slots`, `/lesson-types`, `/rules`, `/requirements`, `/versions`, `/versions/:id/{lessons,entity,calendar,conflicts,overview,diff}`, `/jobs` | `schedule.view` |
| PATCH/POST/DELETE | `/config`, `/time-slots`, `/lesson-types`, `/rules`, `/requirements` (+`/build`, `/import`) | `schedule.settings` |
| POST | `/jobs` (генерация/перегенерация), `/jobs/:id/cancel` | `schedule.generate` |
| POST/PATCH/DELETE | `/versions`, `/versions/:id/lessons`, `/lessons/:id`, `/versions/:id/{review,draft,archive,restore}` | `schedule.create/update/delete` |
| POST | `/versions/:id/publish` | `schedule.publish` |
| GET | `/versions/:id/export?format=csv\|xlsx` | `schedule.export` |
| PUT/GET | `/availability/me` | `schedule.availability` (OWN, преподаватель) |
| GET | `/me/calendar` | любой студент/преподаватель: своё опубликованное расписание |

Сохранение конфликтующего занятия запрещено (409 `SCHEDULE_CONFLICT`); только право `schedule.override` (SUPER_ADMIN) позволяет сохранить его в черновик с причиной — событие пишется в Audit Log, публикация всё равно требует 0 критических конфликтов. Все изменения пишутся в Audit Log (`timetable.*`).

Тесты: `npx vitest run src/modules/timetable` (движок, включая университетский масштаб ~4 900 студентов / 500 аудиторий) и API-набор (13 разделов: роли, настройки, нагрузка, генерация, фильтры, правка, публикация, версии, экспорт, аудит, совместимость).
## Язык ответов (i18n)

3 языка: `az` (дефолт), `ru`, `en`. Клиент выбирает через:
1. Header `X-Lang: ru`
2. Query `?lang=en`
3. `Accept-Language`

---

## Безопасность «из коробки»

- **Argon2id** хеш паролей
- **JWT** access (15m) + **opaque refresh** (7d, HttpOnly + SameSite=Strict cookie)
- **Refresh rotation** с детекцией reuse (атака → revoke всей family)
- **Lockout** после 5 неудачных входов (15 минут)
- **Constant-time** верификация пароля даже при отсутствии юзера
- **Rate limit**: 100 req/min глобально, 10/min на `/auth/login` (`RATE_LIMIT_AUTH_MAX`)
- **Helmet + CSP + HSTS** (в prod)
- **CORS** whitelist
- **Zod strict()** на всех DTO — защита от mass assignment
- **Prisma** параметризует все запросы — защита от SQL injection
- **Login log + Audit log** для каждого входа и security-события
- **Password hash и TOTP secret** никогда не отдаются наружу

---

## Запуск на Railway

1. Создать Postgres-сервис
2. Создать Node-сервис из этого репозитория
3. Переменные окружения (см. `.env.example`), обязательно:
   - `DATABASE_URL` (автоматом от Postgres-сервиса)
   - `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` (≥ 32 символа, сгенерировать `openssl rand -base64 48`)
   - `FRONTEND_ORIGIN` (домен фронта)
   - `COOKIE_SECURE=true`
   - `NODE_ENV=production`
4. Railway сам выполнит `prisma migrate deploy` в Dockerfile CMD

Seed вручную после первого деплоя: `railway run npm run seed`.
