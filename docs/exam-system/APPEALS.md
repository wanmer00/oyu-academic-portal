# Апелляция по экзамену (Requests → APPEAL)

Апелляция — это **существующая заявка** `Request` с `type = APPEAL`. Отдельного модуля / API / статусов нет:
статус хранится в `Request.status`, а таблица `ExamAppeal` добавляет только экзаменационные детали.

```
Request (type = APPEAL, status)
  └─ ExamAppeal (результат, снимок баллов, окно, эскалация, решение)
       └─ ExamAppealItem × N (вопрос: ссылка + снимок, причина, объяснение, решение)
```

## Данные
- Вопросы, ответы и баллы берутся из уже существующего неизменяемого снапшота экзамена: `ExamAttemptQuestion` (компьютер) или `PaperSheetQuestion` (бумага). Новых моделей экзамена не создавалось.
- Баллы вопроса — правила экзамена: верно +2, неверно −1, пропуск 0 (максимум 2). Частичного балла в исходной оценке нет, поэтому причина `PARTIAL_CREDIT_ERROR` не используется; частичное удовлетворение возможно решением проверяющего (например, −1 → 0 или 1).
- REFERENCE + SNAPSHOT: в `ExamAppealItem` хранится `questionId` и снимок — номер, текст вопроса, ответ студента, начисленные и максимальные баллы. Правильный ответ в снимок не попадает.
- `RequestStatus` расширен: `UNDER_REVIEW`, `PARTIALLY_APPROVED`, `WITHDRAWN` (старые заявки CERTIFICATE / TRANSFER / OTHER работают по прежним переходам).
- `ExamResult`: исходные баллы неизменяемы (триггер БД); пересмотр пишется в `revised*`, действующий результат = пересмотренный.

## Правила (проверяет backend)
| Правило | Где |
|---|---|
| Только свой опубликованный результат | `AppealsService.ownResult` (studentId из JWT) |
| Окно: открыто через `exam.appealDelayHours` после публикации, длится `exam.appealWindowHours` (по умолчанию 0 и 72 ч) | `eligibility()` при показе и при подаче |
| Одна активная апелляция на результат | сервис + частичный уникальный индекс `ExamAppeal(resultId) WHERE withdrawnAt IS NULL` |
| После решения повторная апелляция не допускается; после отзыва — можно до дедлайна | `eligibility()` |
| Причина из списка, объяснение 10–2000 символов для каждого вопроса | zod `AppealItemSchema` |
| Изменение / отзыв — только PENDING, без физического удаления | `update` / `withdraw`; `DELETE /me/requests/:id` для апелляции запрещён |
| Новый балл: от −1 (если был ответ) или 0 (без ответа) до 2 | `decideItem` |
| Итог (APPROVED / PARTIALLY_APPROVED / REJECTED) вычисляется по вопросам | `decide` |
| Меняется только компонент FINAL (≤ 50); Midterm и Seminar не трогаются; total и GPA — существующими расчётами Journal | `writeFinalToJournal` → `GradeHistory` |
| Статус предмета при смене PASS/FAIL (COMPLETED ↔ RESIT_ELIGIBLE / RETAKE_REQUIRED) | `syncEnrollment` |

## Роли (RBAC: `appeals.view`, `appeals.review`, `appeals.decide`, `appeals.adjust_grade`)
- **Студент** — свои результаты и апелляции.
- **Преподаватель** — апелляции по своим парам «предмет × группа»; рассматривает, решает, передаёт руководству.
- **Руководство** — просмотр в своей области; решения — только по эскалированным апелляциям и только ректор / проректор / декан / зав. кафедрой. Тьютор и прочие — только просмотр.
- **SUPER_ADMIN** — всё; аудит в существующем AuditLog (`appeal.submit`, `appeal.update`, `appeal.withdraw`, `appeal.review`, `appeal.item.decision`, `appeal.escalate`, `grade.adjust`, `appeal.decide`, `appeal.close`).

## API (в рамках Requests)
- Студент: `GET /me/exam-results/:id/review`, `POST /me/requests` (`type: APPEAL`, `appeal: { resultId, items }`), `GET /me/requests/:id`, `PUT /me/requests/:id/appeal`, `POST /me/requests/:id/withdraw`, `GET /me/exam-appeals/summary`.
- Преподаватель / руководство: `GET|POST /teacher/requests/appeals…`, `/admin/requests/appeals…` — список, `analytics`, `:id`, `:id/start`, `:id/items/:itemId`, `:id/escalate`, `:id/decide`.

Тест: `node oyu-backend/test/appeal-e2e.js` (на свежих демо-данных).
