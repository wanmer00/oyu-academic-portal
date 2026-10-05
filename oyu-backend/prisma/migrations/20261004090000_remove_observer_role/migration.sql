-- Удаление роли OBSERVER: её возможности (журнал безопасности, аномалии, Audit Log) переходят к SUPER_ADMIN.
-- Аккаунты OBSERVER становятся SUPER_ADMIN, строки прав роли удаляются.
UPDATE "User" SET role = 'SUPER_ADMIN' WHERE role = 'OBSERVER';
DELETE FROM "RolePermission" WHERE role = 'OBSERVER';

ALTER TYPE "Role" RENAME TO "Role_old";
CREATE TYPE "Role" AS ENUM ('STUDENT', 'TEACHER', 'ADMIN', 'SUPER_ADMIN');
ALTER TABLE "User" ALTER COLUMN "role" TYPE "Role" USING ("role"::text::"Role");
ALTER TABLE "RolePermission" ALTER COLUMN "role" TYPE "Role" USING ("role"::text::"Role");
DROP TYPE "Role_old";