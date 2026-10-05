# Academic Portal — Security Overview

Документ для IT-аудитора / ИБ-департамента заказчика. Описывает, как платформа защищает данные студентов, преподавателей и администрации.

---

## 1. Threat model — что защищаем и от кого

| Актив | Угроза | Митигация |
|---|---|---|
| Пароли пользователей | Утечка БД → компрометация аккаунтов | Argon2id (memory 64MB, t=3, p=4) + rand salt per-user |
| Сессия (JWT) | Угон access-токена | Короткий TTL (15m), передача только по HTTPS, не хранится в localStorage |
| Сессия (refresh) | XSS-эксфильтрация | HttpOnly + Secure + SameSite=Strict cookie, path ограничен `/auth` |
| Refresh reuse | Атакующий переиспользует старый токен | Reuse detection → revoke всей token family + audit запись |
| Учебные данные (оценки) | Подделка преподавателем/студентом | RBAC + ownership guard + immutable `GradeHistory` + audit log |
| Персональные данные | Утечка через IDOR | Ownership guard на всех `:id`-ресурсах |
| API | Перебор паролей | Lockout после 5 неудач + rate-limit 10/min на `/auth/login` |
| API | DDoS / флуд | Глобальный rate limit + Railway CDN + Helmet body-limit |

---

## 2. OWASP Top 10 (2021) — статус

| # | Риск | Как закрыт |
|---|---|---|
| A01 Broken Access Control | RBAC через `RolesGuard`, ownership через service-level проверки, `Zod .strict()` блокирует mass-assignment |
| A02 Cryptographic Failures | Argon2id для паролей, TLS 1.2+ (Railway), HSTS в проде, HttpOnly+Secure+SameSite cookies |
| A03 Injection | Prisma параметризует все запросы; Zod валидирует все DTO; CSP блокирует XSS |
| A04 Insecure Design | Defense-in-depth: rate-limit + lockout + audit + reuse-detection одновременно |
| A05 Security Misconfiguration | Helmet с строгим CSP, dev-значения в `.env.example` явно помечены `CHANGE_ME`, валидация env через Zod на старте |
| A06 Vulnerable Components | `npm audit --production` в CI, Dependabot, минимальный набор зависимостей |
| A07 Authentication Failures | Argon2id, lockout, constant-time verify при отсутствии юзера (2FA не реализована) |
| A08 Data Integrity Failures | JWT подпись, lockfile в git, `gitleaks` pre-commit, S3-объекты с ETag |
| A09 Security Logging/Monitoring | `LoginLog` + `AuditLog` + Pino JSON + Sentry в проде, PII redact rules |
| A10 SSRF | Все внешние вызовы (если появятся) — через allow-list URL |

---

## 3. Аутентификация

### Пароли
- Алгоритм: **Argon2id** (`argon2` npm, библиотека на libsodium)
- Параметры: memory=64 MB, iterations=3, parallelism=4
- Соль: случайная 16 байт для каждого пользователя (встроено в argon2)
- Политика: мин. 10 символов (валидация на клиенте + Zod), рекомендуется HIBP-проверка в будущем
- Reset: токен в БД, одноразовый, истекает за 30 минут

### JWT
- **Access token**: HS256 (в демо), TTL 15 мин, содержит `sub`, `role`, `loginId`
- **Refresh token**: opaque 64-байтовый случайный, SHA-256 хеш в БД, TTL 7 дней
- **Rotation**: при каждом `/auth/refresh` старый токен помечается `revokedAt`, выдаётся новый в той же `family`
- **Reuse detection**: если использован уже отозванный токен — **вся family** revoked, создаётся audit-запись

### Защита от brute force
- `failedLogins` счётчик на `User`
- После 5 неудач → `lockedUntil = now + 15 min`
- При успешном входе счётчик сбрасывается
- Rate limit `/auth/login`: 10 запросов / мин с IP
- Constant-time verify: если Login ID не найден, всё равно вызывается `argon2.verify` против dummy hash — чтобы не было timing-oracle

### 2FA — НЕ реализовано
- Поля `User.totpSecret` / `User.totpEnabled` зарезервированы в схеме, но flow (enrolment, проверка при входе, recovery codes) отсутствует.
- UI не показывает статус 2FA, чтобы не создавать ложного ощущения защиты. Внедрение — отдельная задача (roadmap).

---

## 4. Авторизация

### RBAC
Четыре роли:
- `STUDENT` — только свои данные (`/me/*`)
- `TEACHER` — свои предметы/оценки + чтение групп (`/teacher/*`)
- `LEADERSHIP` — статистика ВУЗа, управление заявками (`/leadership/*`)
- `IT_AUDITOR` — только security dashboard (`/security/*`)

Реализация:
```typescript
@Controller('leadership')
@UseGuards(RolesGuard)
@Roles(Role.LEADERSHIP)
export class LeadershipController { ... }
```

### Ownership
- Студент может запросить свои оценки через `/me/grades` — сервис делает `where: { studentId: ctx.user.id }`
- Преподаватель может изменять только свои оценки (`teacherId === ctx.user.id`)
- IDOR невозможен: нет endpoint `/grades/:id` где можно передать чужой ID

### Mass assignment
Все DTO через Zod с `.strict()` — лишние поля **отклоняются**:
```typescript
export const UpdateMeSchema = z.object({
  phone: z.string().max(50).optional(),
  preferredLang: z.enum(['az','ru','en']).optional(),
}).strict();
```

---

## 5. Транспорт и заголовки

### HTTPS / TLS
- Enforced на уровне Railway (Let's Encrypt)
- HSTS в prod: `max-age=31536000; includeSubDomains; preload`
- TLS 1.2+ (Railway дефолт)

### Security headers (Helmet)
| Header | Значение |
|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; frame-ancestors 'none'` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` (prod) |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |

Проверка: `curl -I https://api.demo.example/api/v1/health/live`

### CORS
- Whitelist: `FRONTEND_ORIGIN` env (comma-separated)
- `credentials: true` (для cookie)
- Методы: только нужные GET/POST/PATCH/PUT/DELETE/OPTIONS
- Заголовки: Content-Type, Authorization, X-Lang

### Cookies
- Refresh cookie: `HttpOnly`, `Secure` (prod), `SameSite=Strict`, path `/api/v1/auth`
- Невозможно прочитать из JavaScript
- Ограничен только auth-роутами → не отправляется при каждом запросе

---

## 6. Защита от конкретных атак

| Атака | Митигация |
|---|---|
| SQL injection | Prisma параметризует 100% запросов; `$queryRaw` не используется в user-facing коде |
| XSS (stored) | React/чистый DOM + `textContent`, никогда `innerHTML` из user input; CSP без `unsafe-inline` |
| XSS (reflected) | CSP + все ответы `Content-Type: application/json` |
| CSRF | SameSite=Strict cookie + Origin check (через CORS whitelist) |
| Clickjacking | `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` |
| MIME sniffing | `X-Content-Type-Options: nosniff` |
| Open redirect | Нет endpoint с redirect из user input |
| Prototype pollution | Zod `.strict()` + строгий JSON-parser; никогда `Object.assign(x, userInput)` |
| Regex DoS | Нет regex на user input, кроме валидации фиксированной длины |
| Path traversal | Нет file-serving из user-controlled путей |
| Timing attack on login | Constant-time через dummy argon2 verify |
| Request smuggling | Express + встроенный парсер; только Railway edge (trusted) |

---

## 7. Логирование и аудит

### LoginLog
Каждая попытка входа:
- `userId`, `loginId`, `success`, `reason` (not_found / bad_password / locked / inactive)
- `ip`, `userAgent`, `createdAt`
- Хранится бессрочно (retention policy — TBD)

### AuditLog
Security-чувствительные действия:
- `auth.refresh_reuse_detected`
- `grade.create`, `grade.update`
- `user.suspend` (leadership)
- `request.status_change`

Поля: `actorId`, `action`, `targetType`, `targetId`, `diff` (JSONB), `ip`, `userAgent`.

### GradeHistory
**Immutable append-only** таблица для каждого изменения оценки:
- `oldValue`, `newValue`, `changedBy`, `reason`, `changedAt`
- Невозможно редактировать через API (нет PATCH/DELETE endpoint)

### Pino JSON logs
Все serverside-логи структурированы. Redact rules:
```typescript
redact: {
  paths: ['password', 'passwordHash', 'token', 'refreshToken', 'authorization', 'cookie'],
  censor: '[REDACTED]',
}
```

### IT_AUDITOR access
Отдельная роль имеет endpoints для просмотра:
- `GET /api/v1/security/audit-logs` — пагинация, фильтры
- `GET /api/v1/security/login-logs`
- `GET /api/v1/security/failed-logins-24h`
- `GET /api/v1/security/locked-accounts`
- `GET /api/v1/security/config` — текущая security-конфигурация
- `GET /api/v1/security/dependencies` — критические зависимости и их версии

UI: `/security.html` — отдельный dashboard.

---

## 8. Управление данными

### Данные в покое
- PostgreSQL шифрование tablespace (Railway managed)
- Автобэкапы ежедневно (Railway retention)
- Пароли не хранятся в plaintext **нигде**
- TOTP secrets — при будущем внедрении 2FA хранить зашифрованными

### Данные в движении
- Клиент ↔ API: HTTPS only (HSTS preload в prod)
- API ↔ Postgres: TLS (Railway internal)
- Секреты: только в Railway Variables, не в git

### PII exposure control
- `User.passwordHash` и `User.totpSecret` **никогда** не возвращаются в JSON (отбрасываются в `toPublicUser`)
- Валидация Zod `.strict()` режет лишние поля в обе стороны
- Email не раскрывается наружу для чужих пользователей

### Retention
- `LoginLog`: 1 год (оператор ВУЗа может удалить по запросу закона)
- `AuditLog`: 5 лет
- Soft-delete пользователей: 30 дней → hard-delete

---

## 9. Secrets management

- `.env.example` в репо — с плейсхолдерами `CHANGE_ME_*`
- `.env` в `.gitignore`
- Prod-секреты только в Railway Variables
- JWT ключи ≥ 32 символа (валидация Zod на старте — сервер не поднимется с короткими)
- Рекомендация: ротация JWT-секретов раз в 90 дней

---

## 10. Dependency management

- `package-lock.json` committed
- `npm audit --production` блокирует деплой при **HIGH/CRITICAL** уязвимостях
- Dependabot включён для auto-PR на уязвимые пакеты
- Минимальный набор runtime-зависимостей (19 dep) — easier audit surface

Критические пакеты и их назначение:
| Пакет | Что делает |
|---|---|
| `argon2` | Хеширование паролей |
| `@nestjs/jwt` + `passport-jwt` | JWT подпись/проверка |
| `helmet` | Security headers |
| `zod` | Валидация входных данных |
| `cookie-parser` | Парсинг HttpOnly cookies |
| `@prisma/client` | Параметризованные запросы к PG |
| `@nestjs/throttler` | Rate limiting |

---

## 11. Инциденты и ответственное раскрытие

### Security contact
📧 `security@demo.example` (стабильный контакт, GPG-ключ опционально)

### SLA
- Первичный ответ: 72 часа
- Оценка критичности: 7 дней
- Патч: 30 дней (для CVSS 9+ — 7 дней)
- Публичное раскрытие: после патча + координация

### Scope
- Все endpoints `api.demo.example`
- Frontend `portal.demo.example`, `admin.demo.example`

### Out of scope
- Social engineering сотрудников
- Физические атаки
- Атаки на инфраструктуру Railway/Cloudflare (это их зона)

---

## 12. Compliance roadmap

| Стандарт | Статус |
|---|---|
| OWASP ASVS L1 | ✅ Соответствует |
| OWASP ASVS L2 | 🟡 Не достигнут: нет 2FA и шифрования PII |
| ISO 27001 | 🔵 Планируется на этапе боевого запуска |
| Закон АР «О персональных данных» | ✅ Учтён (retention, право на удаление/экспорт) |
| GDPR (в рамках европейских партнёрств) | 🟡 Design-level готово; operational процессы — TBD |

---

## 13. Как IT-аудитор заказчика может проверить безопасность

1. **Вход**: логин через `/security.html` с аккаунтом `IT_AUDITOR` (см. README)
2. **Dashboard**: живая статистика по всем security-метрикам
3. **Конфигурация**: полный вывод `GET /api/v1/security/config` — видны все настройки
4. **Внешние тесты**:
   - [securityheaders.com](https://securityheaders.com) → цель A+ в проде
   - [ssllabs.com/ssltest](https://www.ssllabs.com/ssltest/) → цель A (Railway TLS)
   - [Mozilla Observatory](https://observatory.mozilla.org) → цель B+
5. **Попытка IDOR** (студент запрашивает чужие оценки) → ожидается 403
6. **Попытка brute force** (6 неудачных входов) → ожидается lockout
7. **Проверка rate limit** (20 запросов `/auth/login` за минуту) → ожидается 429
8. **Аудит лог** — виден каждый их собственный запрос с IP и временем

---

## 14. Контакты

- **Продуктовый owner**: (TBD)
- **Dev lead**: (TBD)
- **Security contact**: `security@demo.example`

---

_Этот документ живой. При любых изменениях в security-контроле — обновляется вместе с кодом._
