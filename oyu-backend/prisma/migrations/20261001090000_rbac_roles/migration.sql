-- RBAC, шаг 1/2: роли и статусы. Значения переименовываются "на месте" — все существующие
-- пользователи и ссылки сохраняются: LEADERSHIP -> ADMIN, IT_AUDITOR -> OBSERVER.
-- Новые значения добавляются здесь и используются только в следующей миграции/сидах
-- (Postgres не позволяет использовать новое значение enum в той же транзакции).
ALTER TYPE "Role" RENAME VALUE 'LEADERSHIP' TO 'ADMIN';
ALTER TYPE "Role" RENAME VALUE 'IT_AUDITOR' TO 'OBSERVER';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'PARENT';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SUPER_ADMIN';

ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'ARCHIVED';

ALTER TYPE "AnnouncementAudience" RENAME VALUE 'LEADERSHIP' TO 'ADMINS';
ALTER TYPE "AnnouncementAudience" ADD VALUE IF NOT EXISTS 'PARENTS';
