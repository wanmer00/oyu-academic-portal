-- AlterTable
ALTER TABLE "CurriculumItem" ADD COLUMN     "electiveGroup" TEXT;

-- CreateTable
CREATE TABLE "ElectiveChoice" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "curriculumItemId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ElectiveChoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentProject" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "organization" TEXT,
    "supervisorId" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "grade" DECIMAL(5,2),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentProject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ElectiveChoice_studentId_curriculumItemId_key" ON "ElectiveChoice"("studentId", "curriculumItemId");

-- CreateIndex
CREATE INDEX "StudentProject_studentId_idx" ON "StudentProject"("studentId");

-- CreateIndex
CREATE INDEX "StudentProject_type_status_idx" ON "StudentProject"("type", "status");

-- AddForeignKey
ALTER TABLE "ElectiveChoice" ADD CONSTRAINT "ElectiveChoice_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ElectiveChoice" ADD CONSTRAINT "ElectiveChoice_curriculumItemId_fkey" FOREIGN KEY ("curriculumItemId") REFERENCES "CurriculumItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentProject" ADD CONSTRAINT "StudentProject_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentProject" ADD CONSTRAINT "StudentProject_supervisorId_fkey" FOREIGN KEY ("supervisorId") REFERENCES "Teacher"("userId") ON DELETE SET NULL ON UPDATE CASCADE;
