# Odlar Yurdu University — Academic Management Portal

Портал академического управления: студенты, преподаватели, группы, предметы, Academic Journal, посещаемость, расписание, заявки, платежи, роли и права, безопасность и журнал аудита.

> Презентационная среда: все пользователи и данные — сгенерированные тестовые, реальных персональных данных нет.

## Быстрый старт

Нужен Docker Desktop.

```bash
cp .env.example .env     # задайте свои секреты (на Windows start-demo.bat делает это сам)
docker compose up -d --build
```

Откройте <http://localhost:3000> и войдите тестовым аккаунтом. При первом запуске база заполняется тестовыми данными.

## Демо-аккаунты

Пароль у всех демо-аккаунтов один и публичный: `Demo@Portal2026`.

`superadmin.demo` (включая раздел «Безопасность»: аномалии, журналы входов и аудита) · `rector.demo` · `prorector.demo` · `dean.demo` · `tutor.demo` · `teacher1.demo … teacher10.demo` · `student1.demo … student50.demo`

## Сброс демо-базы (только владелец)

```bash
docker compose exec portal-api node dist/demo/reset.cli.js
```

HTTP-вариант: `POST /api/v1/demo/reset` — нужен токен SUPER_ADMIN **и** секрет `DEMO_RESET_TOKEN` из `.env`
в заголовке `X-Demo-Reset-Token`. Работает только при `DEMO_MODE=true`. Посетитель демо сбросить базу не может.

Подробности — в `README.md`.