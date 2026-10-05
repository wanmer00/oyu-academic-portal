-- RBAC, шаг 2/2: права ролей, связь родитель-ребёнок, системные настройки, результат операции в AuditLog.
CREATE TYPE "PermissionScope" AS ENUM ('OWN', 'CHILDREN', 'ASSIGNED', 'ALL');

CREATE TABLE "ParentStudent" (
    "id" TEXT NOT NULL,
    "parentId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "relation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ParentStudent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ParentStudent_parentId_studentId_key" ON "ParentStudent"("parentId", "studentId");
CREATE INDEX "ParentStudent_studentId_idx" ON "ParentStudent"("studentId");
ALTER TABLE "ParentStudent" ADD CONSTRAINT "ParentStudent_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ParentStudent" ADD CONSTRAINT "ParentStudent_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RolePermission" (
    "id" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "permission" TEXT NOT NULL,
    "scope" "PermissionScope" NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT,
    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RolePermission_role_permission_key" ON "RolePermission"("role", "permission");
CREATE INDEX "RolePermission_role_idx" ON "RolePermission"("role");

CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT,
    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

ALTER TABLE "AuditLog" ADD COLUMN "result" TEXT NOT NULL DEFAULT 'SUCCESS';
ALTER TABLE "Subject" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
