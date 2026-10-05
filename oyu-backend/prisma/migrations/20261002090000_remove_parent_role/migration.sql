-- Удаление роли PARENT и всего, что с ней связано: связь родитель-ребёнок, scope CHILDREN, аудитория объявлений PARENTS.
-- Данные родителей удаляются (учётные записи роли PARENT, их заявки, права роли); остальные данные не затрагиваются.

-- 1) данные
UPDATE "AuditLog" SET "actorId" = NULL WHERE "actorId" IN (SELECT id FROM "User" WHERE role = 'PARENT');
UPDATE "LoginLog" SET "userId" = NULL WHERE "userId" IN (SELECT id FROM "User" WHERE role = 'PARENT');
DELETE FROM "Request" WHERE "userId" IN (SELECT id FROM "User" WHERE role = 'PARENT');
DELETE FROM "AnnouncementRead" WHERE "userId" IN (SELECT id FROM "User" WHERE role = 'PARENT');
DELETE FROM "User" WHERE role = 'PARENT';            -- каскадом: RefreshToken, Notification, AIChatSession, ParentStudent
DELETE FROM "Announcement" WHERE audience = 'PARENTS';
DELETE FROM "RolePermission" WHERE role = 'PARENT' OR scope = 'CHILDREN';

-- 2) таблица связей
DROP TABLE "ParentStudent";

-- 3) enum Role без PARENT
ALTER TYPE "Role" RENAME TO "Role_old";
CREATE TYPE "Role" AS ENUM ('STUDENT', 'TEACHER', 'ADMIN', 'SUPER_ADMIN', 'OBSERVER');
ALTER TABLE "User" ALTER COLUMN "role" TYPE "Role" USING ("role"::text::"Role");
ALTER TABLE "RolePermission" ALTER COLUMN "role" TYPE "Role" USING ("role"::text::"Role");
DROP TYPE "Role_old";

-- 4) enum PermissionScope без CHILDREN
ALTER TYPE "PermissionScope" RENAME TO "PermissionScope_old";
CREATE TYPE "PermissionScope" AS ENUM ('OWN', 'ASSIGNED', 'ALL');
ALTER TABLE "RolePermission" ALTER COLUMN "scope" TYPE "PermissionScope" USING ("scope"::text::"PermissionScope");
DROP TYPE "PermissionScope_old";

-- 5) enum AnnouncementAudience без PARENTS
ALTER TYPE "AnnouncementAudience" RENAME TO "AnnouncementAudience_old";
CREATE TYPE "AnnouncementAudience" AS ENUM ('ALL', 'STUDENTS', 'TEACHERS', 'ADMINS', 'GROUP');
ALTER TABLE "Announcement" ALTER COLUMN "audience" DROP DEFAULT;
ALTER TABLE "Announcement" ALTER COLUMN "audience" TYPE "AnnouncementAudience" USING ("audience"::text::"AnnouncementAudience");
ALTER TABLE "Announcement" ALTER COLUMN "audience" SET DEFAULT 'ALL';
DROP TYPE "AnnouncementAudience_old";
