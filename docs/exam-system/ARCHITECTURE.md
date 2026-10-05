# Exam Management System — архитектура (черновик на утверждение)

Документ описывает встраивание системы экзаменов в существующий портал Odlar Yurdu.
Код ещё не писался. После утверждения — реализация по фазам из раздела 19.

---

## 0. Анализ существующего проекта

| Область | Что есть сейчас | Как используется в Exam System |
|---|---|---|
| Backend | NestJS 10, Prisma 5, PostgreSQL 16, префикс `/api/v1`, Docker | Новый модуль `src/modules/exams/*` в том же приложении, та же БД, новые миграции Prisma |
| Auth | JWT + refresh-токены, блокировка после неудачных входов | Без изменений. Студент/преподаватель/проктор входят как сейчас |
| Guards | Throttler → JwtAuthGuard → ViewAsGuard → PermissionsGuard (глобально) | Новые права `exams.*` в каталоге `rbac/permissions.ts`; View-as остаётся read-only |
| Роли | enum `Role`: STUDENT, TEACHER, ADMIN, SUPER_ADMIN; должности руководства (`User.position`: RECTOR, VICE_RECTOR, DEAN, HEAD_OF_DEPARTMENT, TUTOR) с областью данных через `OrgScopeService` | MANAGEMENT = ADMIN/SUPER_ADMIN + руководство (по своей области). Добавляется роль **PROCTOR** |
| Оргструктура | Faculty → Department → Specialty → AcademicGroup; `Student.groupName`, `course`, `semester` | Окна экзаменов назначаются на факультеты/специальности/группы |
| Учебный план | `CurriculumItem` (специальность × семестр × предмет × кредиты × EXAM/CREDIT, выборные) | Основа для SubjectOffering и для определения «кто обязан сдавать» |
| Предметы | `Subject` (code, name, credits, semester, departmentId) | Кредиты для расчёта стоимости resit |
| Оценки | Academic Journal: TOTAL = FINAL 0..50 + MIDTERM 0..30 + SEMINAR 0..20, Decimal-арифметика, `AcademicPeriod` (OPEN/CLOSED), `GradeHistory`, публикация | **Entry Score = MIDTERM + SEMINAR (0..50)**, Exam Score занимает место FINAL. Результат экзамена записывается в Journal как FINAL |
| Периоды | `Term`: FALL / SPRING / SUMMER, `academicYear` вида `2026-2027` | «Зимний» цикл = FALL, «весенний» = SPRING, летние занятия = SUMMER |
| Расписание | `ScheduleSlot` (живое), версии, `Room` (type `computer_lab`) | Доступ преподавателя к предметам — из `TeacherAccessService` (пары предмет × группа). Летний retake получает собственное расписание |
| Платежи | `Payment` (PENDING/PROCESSING/PAID/FAILED/REFUNDED, type `RETAKE`), `payMock` | Переиспользуем `Payment`, добавляем провайдер-абстракцию и связь с ResitEligibility |
| Аудит | `AuditLog` + `AuditTrailService.record/recordTx` (actor, action, target, diff, ip, UA, result) | Все события экзаменов пишутся через него внутри транзакций |
| Настройки | `SystemSetting` + `SettingsService` (типизированные ключи) | `exam.creditPrice=15`, `exam.resitFeeRatio=0.25`, `exam.durationMinutes=120` и т. д. |
| Уведомления | `NotificationsService.notify` (az/ru/en) | Допуск, отклонение вопросов, результат, оплата |
| Frontend | Статичный HTML + vanilla JS, namespace `AP`, `AP.api`, i18n ru/en/az, `portal.html` (студент/преподаватель), `admin-dashboard.html` (NAV-дерево), `theme.css`, `admin-ui.css` | Новые разделы в существующих страницах + 2 отдельные страницы: `proctor.html`, `exam.html` (киоск) |
| Библиотеки | `exceljs`, `fast-csv` уже установлены | Импорт вопросов CSV/Excel |

### Конфликты с существующим проектом (нужно решение)

1. **Шкала оценок.** В Journal сейчас `A ≥90, B ≥80, C ≥70, D ≥60, F` и проходной балл `journal.passMark = 60`.
   Требование экзаменов: `A 91–100, B 81–90, C 71–80, D 61–70, E 51–60, F ≤50`, проход `Total ≥ 51 И Exam ≥ 17`.
   **Предложение:** перевести Journal на университетскую шкалу (одна функция `toLetter` и `passMark = 51`), чтобы прогресс студента, задолженности и экзамены не противоречили друг другу.
2. **FINAL в Journal сейчас 0..50 и вводится вручную.** Exam Score бывает отрицательным (−25..50).
   **Предложение:** для предметов с экзаменом через Exam System FINAL пишется только системой (источник `EXAM_RESULT`). Отрицательный Exam Score хранится в `ExamResult`; в Journal пишется Exam Score. Ручной ввод FINAL преподавателем для таких предметов блокируется.
3. **Роль проктора.** Сейчас ролей 4, и они в enum.
   **Предложение:** добавить `PROCTOR` в enum `Role` (миграция), без `admin.access`, со своим набором прав. Альтернатива (флаг у ADMIN) хуже, потому что проктор не должен видеть админ-панель.
4. **Задолженности сейчас вычисляются** из Journal (`AcademicService.progress`). После внедрения статус предмета берётся из `SubjectEnrollment.status`, а для старых данных без enrollment остаётся текущий расчёт.

---

## 1. Architecture overview

```
 Браузер студента (portal.html → вкладка EXAMS)        Проктор (proctor.html)          Киоск PC-xx (exam.html)
          │ JWT                                           │ JWT (role PROCTOR)               │ Workstation key + launch token → Attempt token
          ▼                                               ▼                                  ▼
 ┌────────────────────────────── NestJS /api/v1 (существующее приложение) ──────────────────────────────┐
 │ Guards: Throttler → JWT → ViewAs → Permissions (+ WorkstationGuard для /exam-runtime/*)              │
 │                                                                                                      │
 │ modules/exams/                                                                                       │
 │   windows/        ExamWindow, назначения, правила дней/времени                                       │
 │   eligibility/    EligibilityService — единственная точка решения «можно ли сдавать»                 │
 │   question-bank/  банки, версии, вопросы, импорт CSV/XLSX, review                                    │
 │   proctor/        поиск студента, авторизация, launch token, мониторинг                              │
 │   workstations/   регистрация ПК, ключи устройств, разрешённые сети                                   │
 │   runtime/        старт попытки, снапшот, автосейв, таймер, сдача, автосдача                         │
 │   scoring/        ScoringEngine (чистые функции): +2/−1/0, Entry+Exam, min 17, буква                 │
 │   results/        результаты, публикация в Journal, аналитика                                        │
 │   resits/         ResitEligibility, лимит 2, оплата                                                  │
 │   retakes/        SubjectOffering, RetakeEnrollment, SummerRetakePeriod                              │
 │   paper/          бумажные экзамены, бланки (PDF), сканы, OMR, ручная проверка                       │
 │   payments/       PaymentProvider (DemoProvider сейчас, реальный позже)                              │
 │   scheduler/      фоновый тик: автосдача истёкших попыток, OVERDUE банков, истечение токенов         │
 │                                                                                                      │
 │ Переиспользуются: AuditTrailService, SettingsService, NotificationsService, OrgScopeService,         │
 │ TeacherAccessService, PeriodService, journal.calc                                                    │
 └──────────────────────────────────────────────┬───────────────────────────────────────────────────────┘
                                                ▼
                                   PostgreSQL 16 (та же БД, новые таблицы)
```

Принципы:
- Все решения (допуск, время, лимиты, оплата, баллы) принимает backend. Frontend только показывает.
- Критические переходы — внутри одной транзакции `SERIALIZABLE` (или `SELECT … FOR UPDATE`) + уникальные индексы в БД как последняя линия защиты.
- Исторические данные (попытки, снапшоты, результаты) не изменяются: исправления только новыми записями с аудитом.

---

## 2. Database schema (Prisma, новые модели)

Имена приведены к стилю проекта (cuid id, `createdAt`, индексы).

```prisma
enum Role { STUDENT TEACHER ADMIN SUPER_ADMIN PROCTOR }   // + PROCTOR

enum ExamKind        { FINAL RESIT }
enum DeliveryType    { COMPUTER PAPER }
enum ExamWindowStatus{ DRAFT PUBLISHED CLOSED CANCELLED }
enum BankStatus      { DRAFT SUBMITTED UNDER_REVIEW APPROVED REJECTED SUPERSEDED }
enum AttemptStatus   { AUTHORIZED IN_PROGRESS SUBMITTED AUTO_SUBMITTED TERMINATED VOID }
enum EnrollmentStatus {
  ENROLLED            // изучает предмет
  FINAL_ELIGIBLE      // допущен к финалу (в окне)
  FINAL_PASSED  FINAL_FAILED
  RESIT_ELIGIBLE      // имеет право на 25%, ещё не оплатил
  RESIT_PAYMENT_PENDING
  RESIT_PAID          // оплачено, ждёт resit-окна
  RESIT_PASSED  RESIT_FAILED
  RESIT_FORFEITED     // не воспользовался resit в своём цикле
  RETAKE_REQUIRED
  COMPLETED
}
enum RetakeMode      { SUMMER NEXT_OFFERING }
enum RetakeStatus    { PENDING REGISTERED IN_PROGRESS COMPLETED FAILED CANCELLED }
enum SheetStatus     { GENERATED SCANNED OMR_DONE MANUAL_REVIEW_REQUIRED VERIFIED }
enum WorkstationStatus { AVAILABLE RESERVED IN_USE OFFLINE DISABLED }

// ── Academic cycle ──
model SubjectOffering {                 // где и когда предмет преподаётся
  id, subjectId, specialtyId?, academicYear, term (Term), course Int, semester Int,
  parity  String?          // ODD | EVEN | null (каждый год)
  isAvailable Boolean, enrollmentOpensAt?, enrollmentClosesAt?,
  prerequisites  OfferingPrerequisite[]
  @@unique([subjectId, specialtyId, academicYear, term])
}
model OfferingPrerequisite { offeringId, requiredSubjectId  @@id([offeringId, requiredSubjectId]) }

model SubjectEnrollment {               // «студент × предмет × цикл» — источник статуса предмета
  id, studentId, subjectId, offeringId?, academicYear, term, semester Int,
  attemptNo Int @default(1)            // 1 — обычный, 2+ — повторное прохождение (retake)
  source   String                       // CURRICULUM | RETAKE_SUMMER | RETAKE_OFFERING
  status   EnrollmentStatus
  entryScore Decimal(5,2)?              // снимок MIDTERM+SEMINAR на момент допуска
  finalResultId?, resitResultId?, retakeOfId?   // ссылка на предыдущий enrollment
  @@unique([studentId, subjectId, academicYear, term, attemptNo])
  @@index([studentId, status])
}

// ── Окна ──
model ExamWindow {
  id, title, kind ExamKind, academicYear, term,
  startDate Date, endDate Date,
  allowedWeekdays Int[]                 // 1=Пн … 7=Вс
  startTime String, endTime String      // "10:00" — последний допустимый старт < endTime
  timezone String @default("Asia/Baku")
  maxFinalsPerWeek Int @default(3)
  questionDeadline DateTime
  status ExamWindowStatus, finalWindowId?   // для RESIT — ссылка на финальное окно цикла
  version Int @default(1)               // меняется при редактировании; попытка хранит версию
  scopes ExamWindowScope[]  exams Exam[]
}
model ExamWindowScope { windowId, facultyId?, specialtyId?, groupId? }   // кому окно назначено

model Exam {                            // предмет внутри окна
  id, windowId, subjectId, delivery DeliveryType,
  questionCount Int @default(25), durationMin Int @default(120),
  rulesVersion Int                      // версия правил оценивания
  bankVersionId?                        // утверждённая версия, зафиксированная для экзамена
  @@unique([windowId, subjectId])
}

// ── Вопросы ──
model QuestionBank        { id, subjectId, ownerTeacherId, title  @@unique([subjectId]) }
model QuestionBankVersion {
  id, bankId, version Int, status BankStatus, submittedAt?, reviewedAt?, reviewerId?,
  rejectionReason?, approvedAt?, basedOnVersionId?, questionCount Int, contentHash String
  @@unique([bankId, version])
}
model Question       { id, versionId, ordinal Int, bodyHtml (санитизированный, формулы KaTeX), imageAssetId?, contentHash
                       @@unique([versionId, contentHash]) }   // дубликаты внутри версии запрещены
model QuestionOption { id, questionId, label String /*A..E исходная*/, bodyHtml, isCorrect Boolean }
                     // CHECK: ровно 5 вариантов, ровно 1 isCorrect — проверка при submit + частичный уникальный индекс
                     // CREATE UNIQUE INDEX ON "QuestionOption"("questionId") WHERE "isCorrect"
model ReviewComment  { id, versionId, questionId?, authorId, body, createdAt }

// ── Рабочие места ──
model ExamWorkstation { id, code "PC-01", roomId (Room), building, status WorkstationStatus,
                        deviceKeyHash, allowedCidr String?, lastSeenAt?, isActive
                        @@unique([roomId, code]) }

// ── Допуск и попытки ──
model ExamEligibility { id, examId, studentId, enrollmentId, eligible Boolean, reasons Json, computedAt, computedBy
                        @@index([examId, studentId]) }      // журнал проверок (история решений)

model ProctorAuthorization {
  id, examId, studentId, proctorId, workstationId,
  idCheckedAt, passportCheckedAt, tokenHash, expiresAt, usedAt?, revokedAt?, ip
}
model ExamAttempt {
  id, examId, studentId, enrollmentId, kind ExamKind, authorizationId @unique, workstationId,
  bankVersionId, rulesVersion, windowVersion,
  status AttemptStatus, startedAt?, expiresAt?, submittedAt?, submittedBy String?  // STUDENT | SYSTEM | PROCTOR
  seed String, sessionTokenHash
  @@unique([examId, studentId])        // одна попытка на экзамен (VOID попытки исключаются частичным индексом)
}
model ExamAttemptQuestion { id, attemptId, questionId, position Int, optionOrder String[] /*optionIds*/
                            @@unique([attemptId, position]) @@unique([attemptId, questionId]) }
model ExamAttemptAnswer   { attemptQuestionId @id, optionId String? /*null = SKIP*/, savedAt, seq Int }
model ExamResult {
  id, attemptId? @unique, paperSheetId? @unique, studentId, examId, enrollmentId,
  correct Int, wrong Int, skipped Int, examScore Decimal(5,2), entryScore Decimal(5,2), total Decimal(5,2),
  letter String, passed Boolean, failReason String?, rulesVersion, computedAt, publishedAt?
}

// ── Бумага ──
model PaperAnswerSheet { id, examId, studentId, sheetCode @unique /*QR*/, bankVersionId, questionOrder Json,
                         status SheetStatus }
model PaperScan        { id, sheetId, fileAssetId, uploadedBy, quality Decimal?, createdAt }
model PaperAnswer      { id, sheetId, position Int, detected String? /*optionId|null*/, confidence Decimal,
                         flags String[] /*DOUBLE|EMPTY|LOW_CONTRAST*/, finalOptionId?, correctedBy?, correctedAt?
                         @@unique([sheetId, position]) }

// ── Resit, оплата, retake ──
model ResitEligibility {
  id, enrollmentId @unique, studentId, subjectId, cycleKey String /* "2026-2027:FALL" */,
  feeAmount Decimal(10,2), creditPrice Decimal(10,2), credits Int, paymentId? @unique,
  status String /* ELIGIBLE | PAYMENT_PENDING | PAID | USED | FORFEITED */, usedAttemptId?
  @@index([studentId, cycleKey])
}
model Payment { … существующая модель … + resitEligibilityId?  provider String @default("DEMO") idempotencyKey @unique }

model SummerRetakePeriod { id, academicYear, startDate, endDate, registrationClosesAt, status }
model SummerRetakeCourse { id, periodId, subjectId, teacherId, maxStudents, attendanceMinPercent, assessment String }
model RetakeEnrollment {
  id, studentId, subjectId, failedEnrollmentId @unique, mode RetakeMode,
  summerCourseId?, offeringId?, newEnrollmentId?, status RetakeStatus, createdAt
}
```

`AuditLog` не меняется: используется существующая модель + запрет UPDATE/DELETE на уровне БД (триггер, см. 13).

---

## 3. Entity relationships

```
Faculty 1─* Department 1─* Specialty 1─* AcademicGroup 1─* Student(groupName)
Specialty 1─* CurriculumItem *─1 Subject 1─* SubjectOffering *─* (prereq) Subject
Student 1─* SubjectEnrollment *─1 Subject ;  SubjectEnrollment ─(retakeOf)→ SubjectEnrollment
ExamWindow 1─* ExamWindowScope ;  ExamWindow 1─* Exam *─1 Subject ;  RESIT window ─finalWindowId→ FINAL window
Subject 1─1 QuestionBank 1─* QuestionBankVersion 1─* Question 1─5 QuestionOption
Exam *─1 QuestionBankVersion (APPROVED, зафиксирована)
ExamWorkstation *─1 Room
ProctorAuthorization 1─1 ExamAttempt 1─25 ExamAttemptQuestion 1─0..1 ExamAttemptAnswer
ExamAttempt 1─1 ExamResult *─1 SubjectEnrollment
PaperAnswerSheet 1─* PaperScan ; PaperAnswerSheet 1─25 PaperAnswer ; PaperAnswerSheet 1─1 ExamResult
SubjectEnrollment 1─0..1 ResitEligibility 1─0..1 Payment
SubjectEnrollment(RETAKE_REQUIRED) 1─0..1 RetakeEnrollment ─→ SummerRetakeCourse | SubjectOffering ─→ новый SubjectEnrollment
```

---

## 4. Exam lifecycle (ExamWindow / Exam)

```
DRAFT ──publish──▶ PUBLISHED ──endDate прошёл──▶ CLOSED
  │                    │
  └──cancel──▶ CANCELLED ◀── (только если ни одной попытки)
```
- При публикации: проверка, что у каждого `Exam` есть утверждённая версия банка ≥ 25 вопросов, или пометка «не готов» (экзамен нельзя стартовать).
- Изменение опубликованного окна создаёт `version+1`; уже начатые попытки хранят свою `windowVersion`, сокращение окна не прерывает идущие попытки.

## 5. Student lifecycle (по одному предмету)

```
ENROLLED ─(окно открыто, entry score есть, предмет не закрыт)─▶ FINAL_ELIGIBLE
FINAL_ELIGIBLE ─попытка, PASS─▶ FINAL_PASSED ─▶ COMPLETED
FINAL_ELIGIBLE ─попытка, FAIL / неявка после закрытия окна─▶ FINAL_FAILED
FINAL_FAILED ─(resit-лимит цикла < 2)─▶ RESIT_ELIGIBLE
FINAL_FAILED ─(лимит исчерпан)─▶ RETAKE_REQUIRED
```

## 6. Question approval lifecycle

```
DRAFT ─submit (≥25 вопросов, 5 вариантов, 1 правильный, без дублей, до дедлайна)─▶ SUBMITTED
SUBMITTED ─reviewer открыл─▶ UNDER_REVIEW ─approve─▶ APPROVED (прежняя APPROVED → SUPERSEDED)
                                           └─reject (reason обязателен)─▶ REJECTED
REJECTED ─teacher «исправить»─▶ новая версия DRAFT (копия, basedOnVersionId)
APPROVED ─teacher «изменить»─▶ новая версия DRAFT; APPROVED остаётся активной до утверждения новой
```
- Reviewer ≠ автор (проверка `reviewerId !== ownerTeacherId`, даже для SUPER_ADMIN, у которого есть привязка к Teacher).
- После `questionDeadline`: teacher не может submit/править; статус банка для окна вычисляется как **OVERDUE**, если нет APPROVED/SUBMITTED версии.
- Утверждённая версия фиксируется в `Exam.bankVersionId` в момент публикации/старта; содержимое APPROVED версии неизменяемо (триггер запрещает UPDATE `Question`/`QuestionOption` с APPROVED версией).

## 7. Final exam lifecycle (попытка)

```
Проктор: authorize ─▶ ProctorAuthorization(token, TTL 5 мин) ─▶ ExamAttempt(AUTHORIZED)
Киоск: redeem token ─▶ снапшот 25 вопросов ─▶ IN_PROGRESS (startedAt, expiresAt = startedAt + 120 мин)
IN_PROGRESS ─finish─▶ SUBMITTED ─▶ ExamResult
IN_PROGRESS ─expiresAt─▶ AUTO_SUBMITTED ─▶ ExamResult
IN_PROGRESS ─проктор (с причиной)─▶ TERMINATED ─▶ ExamResult по сохранённым ответам
AUTHORIZED ─токен истёк/отозван─▶ VOID (не считается попыткой)
```

## 8. 25% resit lifecycle

```
RESIT_ELIGIBLE ─студент «оплатить»─▶ RESIT_PAYMENT_PENDING (Payment PENDING, сумма с backend)
RESIT_PAYMENT_PENDING ─провайдер: PAID─▶ RESIT_PAID
RESIT_PAYMENT_PENDING ─FAILED─▶ RESIT_ELIGIBLE (можно повторить оплату)
RESIT_PAID ─попытка в resit-окне своего цикла─▶ RESIT_PASSED ─▶ COMPLETED
                                            └─▶ RESIT_FAILED ─▶ RETAKE_REQUIRED (никакого второго resit)
RESIT_ELIGIBLE / RESIT_PAID ─resit-окно цикла закрылось без попытки─▶ RESIT_FORFEITED
RESIT_FORFEITED ─следующее resit-окно ТОГО ЖЕ term (FALL→FALL)─▶ RESIT_ELIGIBLE (если лимит позволяет)
```
- Цикл (`cycleKey`) = `academicYear:term`. FALL-предмет → FALL final → FALL resit (зима). SPRING-предмет → SPRING final → SUMMER resit-окно, но `cycleKey` остаётся `…:SPRING`.
- Лимит: `count(ResitEligibility where studentId, cycleKey, status in (PAYMENT_PENDING, PAID, USED)) < 2` — проверка в транзакции с блокировкой строки студента.
- Оплаченный, но не использованный resit при FORFEITED: деньги не возвращаются автоматически (политика настраивается: `exam.resitRefundOnForfeit`).

## 9. Retake subject lifecycle

```
RETAKE_REQUIRED ─▶ RetakeEnrollment(PENDING) с вариантами:
   • SUMMER — если есть SummerRetakeCourse по предмету в открытом SummerRetakePeriod
   • NEXT_OFFERING — ближайший SubjectOffering (см. алгоритм)
студент выбирает ─▶ REGISTERED ─▶ новый SubjectEnrollment(attemptNo+1, source RETAKE_*) ─▶ ENROLLED …
```
Алгоритм «следующего предложения» (без `year + 1`):
1. Кандидаты: `SubjectOffering where subjectId, isAvailable, (specialtyId = специальность студента или null), начало > сегодня`.
2. Фильтр по чётности курса (`parity`) и по тому, что `course` предложения ≥ текущему курсу студента или предмет разрешён к повторению на старшем курсе.
3. Фильтр по пререквизитам: все `requiredSubjectId` должны иметь `COMPLETED`; иначе предложение показывается с пометкой «заблокировано: нужен X».
4. Сортировка по дате начала; первое — `NEXT AVAILABLE OFFERING`.
5. Если кандидатов нет — `NO_OFFERING_SCHEDULED` (управление видит в отчёте Retakes).

## 10. Payment lifecycle

```
create(resitEligibilityId) ─ сумма = credits × creditPrice × ratio (backend, Decimal), idempotencyKey
PENDING ─provider.charge()─▶ PROCESSING ─callback/результат─▶ PAID | FAILED
PAID ─(только управление, с причиной)─▶ REFUNDED
```
- `PaymentProvider` интерфейс: `createIntent`, `confirm`, `verifyWebhook`. Сейчас `DemoPaymentProvider` (мгновенно PAID, есть кнопка «симулировать отказ» в DEMO_MODE). Реальный провайдер подключается реализацией интерфейса и webhook-эндпоинтом.
- Сумма с клиента не принимается. Повторная оплата уже оплаченного/использованного resit → 409.

## 11. Paper exam lifecycle

```
Exam(delivery=PAPER) ─▶ генерация бланков (PDF: QR sheetCode, Student ID, Exam ID, предмет, 25×(A–E) пузырьки, 4 маркера по углам)
   + буклет вопросов с индивидуальным порядком (снапшот как у компьютерной попытки)
GENERATED ─скан загружен─▶ SCANNED ─OMR─▶ OMR_DONE | MANUAL_REVIEW_REQUIRED
MANUAL_REVIEW_REQUIRED ─сотрудник исправил (аудит каждого изменения)─▶ VERIFIED ─▶ ScoringEngine ─▶ ExamResult
```
OMR: изображение выравнивается по 4 угловым маркерам (аффинное преобразование), по известной геометрии бланка измеряется заполненность каждого пузырька. Правила: максимум > порога и отрыв от второго ≥ дельты → ответ; два выше порога → `DOUBLE`; ни одного → SKIP (флаг `EMPTY` только если весь бланк пуст); низкий контраст/маркеры не найдены → ручная проверка. Рукописный текст не распознаётся.

## 12. Computer exam lifecycle (полный путь)

1. Проктор находит студента (по loginId / ФИО / группе), отмечает «ID проверен» и «паспорт проверен».
2. Выбирает предмет из списка **допустимых сейчас** экзаменов студента (backend вызывает `EligibilityService`).
3. Выбирает свободный ПК своей аудитории.
4. `POST /proctor/authorizations` → в транзакции: повторная проверка допуска + лимита 3/неделю + окна + времени; создаётся `ProctorAuthorization` (одноразовый токен, TTL 5 мин) и `ExamAttempt(AUTHORIZED)`; ПК → `RESERVED`.
5. Киоск ПК-xx (зарегистрирован, хранит device key) опрашивает `GET /exam-runtime/workstation/pending` и получает «ожидает студента: ФИО, предмет».
6. Студент нажимает START EXAM → `POST /exam-runtime/start` (device key + launch token): токен погашается, создаётся снапшот, `startedAt/expiresAt`, выдаётся attempt-сессия (httpOnly cookie, привязана к ПК).
7. Ответы — `PUT /exam-runtime/answers/:position` (автосейв, монотонный `seq` против гонок).
8. Finish → подтверждение (Answered / Skipped / Unanswered) → `POST /exam-runtime/submit` → оценка → экран результата (если публикация мгновенная разрешена настройкой) или «результат будет опубликован».

---

## 13. Security model

Уровни проверки при старте компьютерного экзамена (все на backend, по порядку):

| # | Проверка | Как |
|---|---|---|
| 1 | Окно экзамена | дата в [startDate, endDate], день недели в `allowedWeekdays`, время старта в `[startTime, endTime)` по `Asia/Baku`, серверные часы |
| 2 | Допуск студента | `EligibilityService` (enrollment, entry score, не сдан, нет активной/завершённой попытки, лимит 3/неделю, для resit — PAID и свой цикл) |
| 3 | Сеть | IP запроса (`trust proxy` уже включён) ∈ `allowedCidr` ПК или глобальный список `exam.allowedNetworks`. Не единственная защита |
| 4 | Зарегистрированный ПК | заголовок `X-Workstation-Key` → сравнение с `deviceKeyHash` (argon2/sha256 + pepper), ПК `isActive`, не `DISABLED` |
| 5 | Авторизация проктора | `ProctorAuthorization` существует, проктор активен, назначен на эту аудиторию/окно |
| 6 | Одноразовый токен | 256 бит случайности, в БД только hash, TTL 5 мин, `usedAt` ставится атомарно (`UPDATE … WHERE usedAt IS NULL`), привязан к studentId + examId + workstationId + windowId |
| 7 | Блокировка попытки | `@@unique([examId, studentId])`, attempt-сессия привязана к ПК; запрос с другого ПК → 403 |

Прочее:
- Студент из дома: нет device key, нет launch token, IP не из сети → 403 на каждом шаге; URL экзамена бесполезен.
- Ответы на вопросы до сдачи: API runtime возвращает только `{position, bodyHtml, options:[{id, bodyHtml}]}` без `isCorrect`. Сериализация через явный DTO, а не через Prisma-объект.
- Проктор: эндпоинты проктора никогда не включают текст вопросов и правильные ответы.
- Преподаватель: видит ответы студентов только после публикации результатов окна; правильные ответы своего банка — да.
- Таймер: `expiresAt` в БД; фронт получает `serverNow` и `expiresAt`; все записи ответов после `expiresAt` → 409; фоновый тик раз в 30 с автосдаёт истёкшие попытки; при любом запросе к истёкшей попытке она автосдаётся немедленно (не зависит от тика).
- AuditLog неизменяем: триггер PostgreSQL `BEFORE UPDATE OR DELETE ON "AuditLog"` → исключение (кроме demo reset, который делает TRUNCATE под отдельной ролью/флагом).
- Результаты: `ExamResult` не обновляется; пересчёт (например, после исправления OMR до публикации) = новая строка + `supersededById`, аудит.
- Rate limit на runtime/proctor эндпоинтах, CSRF не нужен (Bearer/cookie SameSite=Strict для attempt-сессии).
- Изображения вопросов: загрузка в существующее хранилище материалов, проверка MIME/размера; HTML вопросов санитизируется на сервере (allowlist тегов), формулы — KaTeX-разметка.

---

## 14. API endpoints

Все под `/api/v1`. В скобках — право.

**Студент** (`exams.view: OWN`)
- `GET /me/exams?tab=upcoming|available|completed|resits|results|retakes`
- `GET /me/exams/:examId` — правила, окно, допуск с причинами
- `GET /me/resits` · `POST /me/resits/:id/pay` (`exams.pay: OWN`) · `GET /me/resits/:id/payment`
- `GET /me/retakes` · `POST /me/retakes/:id/choose` (SUMMER | NEXT_OFFERING)
- `GET /me/exam-results/:resultId` (только опубликованные)

**Преподаватель** (`exams.questions: ASSIGNED`)
- `GET /teacher/exams` — мои предметы × окна, статус банка, дедлайн, OVERDUE
- `GET/POST /teacher/question-banks/:subjectId/versions` · `GET /teacher/question-banks/versions/:id`
- `POST/PUT/DELETE /teacher/question-banks/versions/:id/questions[/:qid]`
- `POST /teacher/question-banks/versions/:id/import` (CSV/XLSX, предпросмотр ошибок по строкам) · `GET …/import-template`
- `POST /teacher/question-banks/versions/:id/submit`
- `POST /teacher/question-banks/versions/:id/revise` — новая версия из REJECTED/APPROVED
- `GET /teacher/exams/:examId/results` (после публикации)

**Управление** (`exams.manage`, `exams.review`, `exams.results`, `exams.payments`, `exams.retakes`; ALL или область должности)
- `GET/POST/PUT /admin/exam-windows` · `POST /admin/exam-windows/:id/publish|close|cancel` · `POST /admin/exam-windows/:id/resit-window` (создать по правилу «+1 неделя»)
- `GET/POST/PUT/DELETE /admin/exam-windows/:id/exams`
- `GET /admin/question-reviews?status=` · `POST /admin/question-reviews/:versionId/claim|approve|reject`
- `GET/POST/PUT /admin/workstations` · `POST /admin/workstations/:id/rotate-key|disable`
- `GET/POST /admin/proctors` (назначение на аудитории/окна)
- `GET /admin/exam-results?faculty&specialty&group&subject&term&window&kind&from&to&status` · `POST /admin/exam-results/publish` · `GET …/export`
- `GET /admin/resits` · `GET /admin/exam-payments` · `POST /admin/exam-payments/:id/refund`
- `GET/POST/PUT /admin/subject-offerings` · `GET/POST /admin/summer-retakes` · `GET /admin/retakes`
- `GET /admin/paper/:examId/sheets.pdf` · `POST /admin/paper/sheets/:id/scan` · `GET /admin/paper/review` · `PUT /admin/paper/sheets/:id/answers/:position`
- `GET /admin/exam-analytics` · `GET /admin/exam-audit?entity&from&to`

**Проктор** (`exams.proctor`)
- `GET /proctor/rooms` · `GET /proctor/rooms/:roomId/status` (ПК + активные попытки, без вопросов)
- `GET /proctor/students?q=` · `GET /proctor/students/:id/eligible-exams`
- `POST /proctor/authorizations` · `DELETE /proctor/authorizations/:id` (отозвать до старта)
- `POST /proctor/attempts/:id/terminate` (причина обязательна)

**Киоск / runtime** (без JWT пользователя; WorkstationGuard + launch token / attempt-сессия)
- `GET /exam-runtime/workstation/pending`
- `POST /exam-runtime/start` · `GET /exam-runtime/attempt` (вопросы, ответы, `serverNow`, `expiresAt`)
- `PUT /exam-runtime/answers/:position` · `POST /exam-runtime/submit` · `GET /exam-runtime/result`

## 15. Frontend routes

| Страница | Раздел | Роль |
|---|---|---|
| `portal.html` → `s-exams` (вкладки Upcoming / Available / Completed / Resits / Results / Retakes) + модалка оплаты | новый `js/student-exams.js` | STUDENT |
| `portal.html` → `t-exams` («My Exams», редактор банка, импорт, статусы) | новый `js/teacher-exams.js` | TEACHER |
| `admin-dashboard.html` → группа NAV «Экзамены»: `ex-windows`, `ex-exams`, `ex-review`, `ex-workstations`, `ex-proctors`, `ex-paper`, `ex-resits`, `ex-retakes`, `ex-payments`, `ex-results`, `ex-analytics`, `ex-audit` | новый `js/exams-admin.js` | ADMIN / SUPER_ADMIN / руководство по области |
| `proctor.html` (отдельно, операционный интерфейс) | `js/proctor.js` | PROCTOR |
| `exam.html` (киоск, без навигации портала) | `js/exam-runtime.js` | ПК-киоск |

Разделы Subjects и Students управления уже есть в админке — переиспользуются (без дублей), из экзаменов на них ссылки с фильтром.

## 16. Role permissions

Новые права в каталоге: `exams.view` (OWN/ASSIGNED/ALL), `exams.pay` (OWN), `exams.questions` (ASSIGNED), `exams.review` (ASSIGNED/ALL), `exams.manage` (ALL), `exams.results` (ASSIGNED/ALL), `exams.payments` (ALL), `exams.retakes` (ASSIGNED/ALL), `exams.proctor` (ASSIGNED/ALL), `exams.paper` (ALL), `exams.audit` (ALL).

| Действие | STUDENT | TEACHER | PROCTOR | ADMIN | Руководство (декан/зав.) | SUPER_ADMIN |
|---|---|---|---|---|---|---|
| Свои экзамены, результаты, оплата resit | ✔ OWN | — | — | — | — | view-as |
| Банк вопросов своего предмета | — | ✔ | — | — | — | — |
| Утверждение вопросов | — | ✖ свои | — | ✔ | ✔ кафедра/факультет | ✔ (кроме своих) |
| Окна экзаменов | — | — | — | ✔ | просмотр по области | ✔ |
| Рабочие места | — | — | статус | ✔ | — | ✔ |
| Авторизация старта | — | — | ✔ (своя аудитория) | ✔ | — | ✔ |
| Правильные ответы | — | ✔ свои | ✖ | ✔ при review | ✔ при review | ✔ |
| Результаты | своё | свои предметы после публикации | ✖ | ✔ | по области | ✔ |
| Ручная правка OMR | — | — | — | ✔ (`exams.paper`) | — | ✔ |
| Прямое изменение баллов | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ (только пересчёт с аудитом) |
| Audit log | — | — | — | ✔ чтение | — | ✔ чтение |

---

## 17. Edge cases → ожидаемое поведение

| Ситуация | Поведение |
|---|---|
| Студент пришёл в 11:59 (окно 10:00–12:00) | Авторизация разрешена; экзамен длится полные 120 мин до 13:59 |
| Пришёл в 12:00 | 409 `OUTSIDE_ALLOWED_TIME`: время старта должно быть < 12:00. Проверяется время **погашения токена**, а авторизация в 11:59 с погашением в 12:01 тоже отклоняется (токен проверяет окно повторно) |
| Предмет уже сдан | 409 `ALREADY_PASSED` |
| Вторая попытка | 409 `ATTEMPT_EXISTS` (уникальный индекс в БД) |
| Пропал интернет | Ответы копятся в очереди на клиенте и досылаются; таймер идёт по серверу; после восстановления — синхронизация `serverNow` |
| Refresh / закрытие браузера / перезагрузка ПК | Киоск снова открывает ту же попытку по attempt-сессии (или проктор «переоткрывает» на том же/другом ПК, с аудитом); снапшот и ответы те же; таймер не останавливается |
| Таймер истёк | Автосдача по сохранённым ответам; неотвеченные = SKIP |
| Проктор выбрал не тот предмет | До старта — отзыв авторизации (`VOID`, не считается попыткой). После старта — `TERMINATED` + решение управления об аннулировании (`VOID` с причиной, аудит), только до публикации результата |
| Банк не утверждён / < 25 утверждённых вопросов | Экзамен в статусе «не готов», авторизация 409 `BANK_NOT_READY`; управление видит в dashboard |
| Дубликаты вопросов | Отклоняются при импорте/сохранении (`contentHash` по нормализованному тексту) |
| Несколько правильных ответов | Невозможно в редакторе (radio), импорт отклоняет строку, частичный уникальный индекс в БД |
| Оплата не прошла / в ожидании | Статус `RESIT_ELIGIBLE` / `RESIT_PAYMENT_PENDING`; к resit не допускается |
| Не допущен | Проктор видит список причин (`NO_ENTRY_SCORE`, `NOT_IN_WINDOW_SCOPE`, `WEEKLY_LIMIT` …) |
| Уже 2 resit в цикле | Третий предмет → `RETAKE_REQUIRED` сразу, кнопка оплаты не показывается, API 409 `RESIT_LIMIT` |
| Доступ из дома | 403 на всех уровнях (нет ключа ПК, нет токена, IP вне сети) |
| Окно закончилось / не началось | 409 `WINDOW_CLOSED` / `WINDOW_NOT_STARTED` |
| Окно изменили | Новая версия окна; идущие попытки не прерываются; допуск пересчитывается для новых авторизаций |
| Банк изменили после начала попытки | Попытка работает со своей `bankVersionId` и снапшотом; APPROVED-версия неизменяема |
| Плохой скан | `MANUAL_REVIEW_REQUIRED`, сотрудник видит скан и отмечает ответы |
| Два пузырька | Флаг `DOUBLE` → ручная проверка; если не решено — считается неверным (−1) — **требует подтверждения политики**, альтернатива: SKIP |
| Ни одного пузырька | SKIP (0) |
| Провал 25% resit | `RETAKE_REQUIRED`, никаких предложений оплатить снова |
| Нужен летний retake | Если есть курс в SummerRetakePeriod — регистрация; иначе показывается NEXT OFFERING |
| Предмета нет в этом году / чередование чётных-нечётных | Алгоритм раздела 9 находит ближайшее предложение по `SubjectOffering.parity` и датам |
| Пререквизит не закрыт | Предложение показано как заблокированное с указанием пререквизита; регистрация 409 `PREREQUISITE_MISSING` |
| Взять предмет раньше разрешённого | Регистрация в offering с `course` выше текущего курса студента → 409 `COURSE_TOO_EARLY` |
| Неявка на финал | После закрытия окна → `FINAL_FAILED` (absent), участвует в resit-логике как провал |
| 4-й экзамен за неделю | 409 `WEEKLY_LIMIT`; неделя = ISO-неделя по `Asia/Baku`; считаются попытки FINAL в статусах ≠ VOID |
| Две авторизации одновременно (два проктора) | Транзакция с блокировкой строки студента: одна проходит, вторая 409 |

---

## 18. RULE → WHERE ENFORCED

| Правило | Где | Слой | Почему |
|---|---|---|---|
| Время старта в [start, end) | `ExamWindowPolicy.assertStartAllowed` при авторизации и при погашении токена | Backend | Время клиента недостоверно; погашение может быть позже авторизации |
| Только разрешённые дни недели и даты окна | `ExamWindowPolicy` | Backend | То же |
| Максимум 3 финала в неделю | `EligibilityService.weeklyLimit` в транзакции авторизации | Backend + БД-блокировка (`SELECT … FOR UPDATE` строки Student) | Защита от параллельных запросов с разных ПК/браузеров |
| Одна попытка на экзамен | `@@unique([examId, studentId])` + проверка в сервисе | Backend + **Database** | Индекс — последняя линия против гонок |
| Студент не стартует сам | Старт требует launch token, выпускаемый только `exams.proctor` | Backend | Токен невозможно получить без проктора |
| Только зарегистрированный ПК | `WorkstationGuard` (device key hash) + IP | Backend | URL сам по себе ничего не даёт |
| Токен одноразовый, короткий, привязанный | атомарный `UPDATE … WHERE usedAt IS NULL AND expiresAt > now()` | Backend + Database | Атомарность исключает двойное погашение |
| 25 случайных утверждённых вопросов, порядок вопросов и вариантов | `SnapshotService` (crypto RNG) | Backend | Клиент не должен влиять на выборку |
| Правильный ответ = optionId | Модель `QuestionOption.isCorrect`, ответ хранит `optionId` | Database + Backend | Перемешивание букв не ломает проверку |
| Снапшот неизменяем | нет UPDATE-эндпоинтов + триггер на `ExamAttemptQuestion` | Backend + Database | Историческая целостность |
| APPROVED-версия неизменяема | сервис + триггер на `Question/QuestionOption` | Backend + Database | Попытки ссылаются на версию |
| Автор не утверждает свои вопросы | `QuestionReviewService.assertNotAuthor` | Backend | Независимо от роли |
| Reject требует причину | DTO (zod) + сервис | Backend (+ Frontend подсказка) | Обязательное поле |
| ≥25 вопросов, 5 вариантов, 1 правильный, без дублей | валидация submit + частичный уникальный индекс | Backend + Database | Импорт/редактор могут быть обойдены |
| Дедлайн загрузки | `QuestionBankService.assertBeforeDeadline` | Backend | Frontend только блокирует кнопки |
| Таймер 120 мин | `expiresAt` в БД, проверка на каждом запросе, фоновая автосдача | Backend + Database | Клиентский таймер — только отображение |
| Автосейв | `PUT answers` с `seq` | Backend | Ответ сохранён, даже если клиент упал |
| Начисление +2/−1/0 | `ScoringEngine` (чистые функции + unit-тесты) | Backend | Единая формула для компьютера и бумаги |
| Pass: Total ≥ 51 И Exam ≥ 17 | `ScoringEngine.evaluate` | Backend | Два независимых условия |
| Буква отдельно от PASS/FAIL | `ScoringEngine.letter` | Backend | E может быть FAIL |
| Entry Score | снимок Journal (MIDTERM+SEMINAR) в `SubjectEnrollment.entryScore` при допуске | Backend | Нельзя изменить после начала экзамена |
| Стоимость resit = credits × price × 0.25 | `ResitFeeCalculator` (Decimal), `exam.creditPrice` в настройках | Backend | Сумма с клиента игнорируется |
| Максимум 2 resit на цикл | `ResitService.grant` в транзакции + count по `cycleKey` | Backend + блокировка | Гонки при параллельной оплате |
| Resit только в своём цикле (FALL→FALL, SPRING→SUMMER) | `ResitService` сопоставляет `cycleKey` предмета и `finalWindowId` resit-окна | Backend | Нельзя пересдать зимний предмет летом |
| Допуск к resit только при PAID | `EligibilityService` читает `Payment.status` из БД | Backend | Отображаемый статус не источник истины |
| Провал resit → RETAKE, без второго resit | `EnrollmentStateMachine` (запрещённые переходы) | Backend (+ CHECK на допустимые статусы) | Конечный автомат вместо флагов |
| Retake ≠ resit | разные таблицы `ResitEligibility` / `RetakeEnrollment` | Database | Разные процессы и данные |
| Следующее предложение | `OfferingResolver` по `SubjectOffering` | Backend + Database | Без формулы «год + 1» |
| Пререквизиты | `OfferingResolver` + регистрация | Backend | — |
| Студент видит только свои данные | `exams.view: OWN` + фильтр по `user.id` | Backend | Стандарт проекта |
| Проктор не видит вопросы/ответы | DTO проктора без этих полей | Backend | Разделение обязанностей |
| Результаты не меняются задним числом | нет UPDATE, пересчёт новой строкой | Backend + Database | Аудируемость |
| Ручная правка OMR → аудит | `PaperReviewService` пишет `AuditLog` в той же транзакции | Backend + Database | Нельзя изменить без следа |
| AuditLog неизменяем | триггер `BEFORE UPDATE OR DELETE` | Database | Даже при ошибке в коде |
| Скрытие кнопок / подсказки | UI | Frontend | Только удобство, не защита |

---

## 19. Implementation plan

| Фаза | Содержание | Проверка |
|---|---|---|
| 1 | Миграция: enum PROCTOR, все модели раздела 2, триггеры, права `exams.*`, настройки | `prisma migrate`, typecheck |
| 2 | ExamWindow + scopes + resit-окно «+1 неделя», EligibilityService, SubjectEnrollment из учебного плана | unit-тесты политики времени/недели |
| 3 | Банк вопросов: версии, редактор, CSV/XLSX импорт, review, OVERDUE | e2e: submit → reject → revise → approve |
| 4 | Студент: вкладка EXAMS | браузер |
| 5 | Проктор: dashboard, рабочие места, ключи ПК, авторизация | e2e: дом/чужой ПК/повторный токен → 403 |
| 6 | Киоск `exam.html`, runtime, таймер, автосейв, автосдача | e2e: refresh, истечение |
| 7 | Снапшот и рандомизация | тест: два студента — разные наборы, refresh — тот же |
| 8 | ScoringEngine, результаты, запись в Journal | unit-тесты всех примеров из ТЗ |
| 9 | Resit + DemoPaymentProvider | лимит 2, цикл, повторная оплата |
| 10 | SubjectOffering, RetakeEnrollment, SummerRetake | алгоритм следующего предложения, чётность, пререквизиты |
| 11 | Бумажные экзамены: PDF-бланки, загрузка скана, OMR, ручная проверка | тест на синтетических сканах |
| 12 | Аудит всех событий, триггеры, rate limits | проверка списка событий |
| 13 | Аналитика управления | — |
| 14 | UI polish, адаптив, i18n ru/en/az | i18n-аудит, мобильная ширина |

Демо-данные: окно финалов и resit, банки по нескольким предметам (утверждённые и на проверке), 30 ПК в компьютерном классе, аккаунт `proctor.demo`, студенты в разных состояниях (сдал, resit оплачен, retake).

## 20. Решения, которые нужно подтвердить

1. Перевести Journal на шкалу A–F с E и проходной балл 51 (конфликт 1). **Рекомендую: да.**
2. Exam Score пишется в Journal как FINAL системой, ручной ввод FINAL для таких предметов закрыт (конфликт 2). **Рекомендую: да.**
3. Новая роль `PROCTOR` в enum (конфликт 3). **Рекомендую: да.**
4. Два пузырька после ручной проверки без решения: неверно (−1) или SKIP (0)? **Рекомендую: SKIP**, но решение не автоматическое — бланк не публикуется, пока сотрудник не подтвердит.
5. Результат показывается студенту сразу после сдачи или после публикации управлением? **Рекомендую: настройка `exam.instantResult`, по умолчанию сразу.**
6. «Зимний» цикл = FALL (финалы январь), «весенний» = SPRING (финалы июнь), resit весенних — летом. **Рекомендую: так.**

---

## 21. Реализация: что отличается от плана

Решения 1–6 из раздела 20 приняты как рекомендованные. При реализации сделано несколько уточнений:

| Тема | План | Реализовано | Почему |
|---|---|---|---|
| Сессия попытки | cookie, привязанная к ПК | Все запросы киоска подписаны `X-Workstation-Key`; активная попытка определяется **по ПК** | Меньше состояния; студент не получает ни одного секрета |
| Launch token | случайный, в БД только hash | HMAC(секрет сервера, authId · ПК · студент · экзамен · срок); в БД `sha256(token)`, погашение атомарное (`usedAt IS NULL`) | Токен нельзя подделать и привязать к другому ПК/студенту; киоск получает его только по ключу ПК |
| Формулы в вопросах | KaTeX/HTML | Лёгкая разметка: `**жирный**`, `*курсив*`, `` `код` ``, `x^{2}`, `x_{i}` + изображение (до 400 КБ); HTML не допускается | Нет XSS-поверхности, не нужна библиотека санитайзинга |
| Бланк | PDF с QR | HTML-страница для печати (SVG с 4 угловыми маркерами) + код бланка текстом; OMR на `sharp` с гомографией по маркерам | PDF-библиотека не нужна; сканы с наклоном/перспективой распознаются |
| Пустой кружок в OMR | ручная проверка | Пустой вопрос = SKIP (нормальный ответ, 0 баллов); ручная проверка — для двух отметок, слабой отметки, нечитаемого скана | SKIP — штатный ответ по ТЗ |
| Лимит 3/неделя | попытки | попытки **и** сгенерированные бумажные бланки | Бумажные экзамены тоже финальные |
| Resit после «упущенного» окна | следующий цикл того же семестра | `RESIT_FORFEITED` → следующее resit-окно **того же term**; запись `ResitEligibility` создаётся лениво на нужный цикл | Правило зима→зима, весна→лето |
| Платёж | DemoPaymentProvider | Интерфейс `PaymentProvider`; используется существующая таблица `Payment` (тип `RETAKE`); при `DEMO_MODE` можно симулировать отказ | Подключение реального провайдера — реализация интерфейса |
| Окно демо-экзаменов | 10:00–12:00 | Демо-окно открыто весь день (пн–сб) — иначе экзамен нельзя было бы попробовать | Реальные окна задаёт Management |

Что проверено автоматически: `oyu-backend/test/exam-e2e*.js|ts` (≈200 проверок) и `exam.rules.spec.ts` (32 unit-теста: баллы, пороги, буквы, окно 11:59/12:00, неделя, resit через неделю, токен, сеть, стоимость 4/8/12 кредитов).

> Терминология интерфейса: роль PROCTOR отображается как «Наблюдатель» (ru) / Invigilator (en) / Nəzarətçi (az); в коде и API остаётся PROCTOR.
