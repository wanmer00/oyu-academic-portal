-- CreateEnum
CREATE TYPE "TimetableStatus" AS ENUM ('DRAFT', 'REVIEW', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TimetableJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TimetableRuleScope" AS ENUM ('GLOBAL', 'TEACHER', 'GROUP', 'ROOM', 'BUILDING', 'SUBJECT');

-- CreateEnum
CREATE TYPE "TimetableRuleKind" AS ENUM ('UNAVAILABLE', 'PREFERRED', 'NO_LATE', 'MAX_PER_DAY', 'ALLOWED_BUILDINGS');

-- AlterTable
ALTER TABLE "Room" ADD COLUMN     "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "floor" INTEGER,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "note" TEXT;

-- AlterTable
ALTER TABLE "ScheduleSlot" ADD COLUMN     "lessonId" TEXT,
ADD COLUMN     "streamKey" TEXT;

-- CreateTable
CREATE TABLE "LessonType" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "roomTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "color" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LessonType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeSlot" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "level" "StudyLevel",
    "shift" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "TimeSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimetableConfig" (
    "id" TEXT NOT NULL,
    "academicYear" TEXT NOT NULL,
    "term" "Term" NOT NULL,
    "workingDays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5, 6]::INTEGER[],
    "maxConsecutive" INTEGER NOT NULL DEFAULT 4,
    "maxDailyLessons" INTEGER NOT NULL DEFAULT 5,
    "softWeights" JSONB NOT NULL DEFAULT '{}',
    "timeLimitSec" INTEGER NOT NULL DEFAULT 60,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimetableConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimetableRule" (
    "id" TEXT NOT NULL,
    "scope" "TimetableRuleScope" NOT NULL,
    "targetId" TEXT,
    "kind" "TimetableRuleKind" NOT NULL,
    "hard" BOOLEAN NOT NULL DEFAULT false,
    "days" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "timeSlotIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "value" JSONB,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT,
    "academicYear" TEXT,
    "term" "Term",
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimetableRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LessonRequirement" (
    "id" TEXT NOT NULL,
    "academicYear" TEXT NOT NULL,
    "term" "Term" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "groupNames" TEXT[],
    "teacherId" TEXT,
    "lessonTypeCode" TEXT NOT NULL,
    "sessionsPerWeek" INTEGER NOT NULL DEFAULT 1,
    "weekParity" "WeekParity" NOT NULL DEFAULT 'BOTH',
    "level" "StudyLevel" NOT NULL DEFAULT 'BACHELOR',
    "roomType" TEXT,
    "requiredFeatures" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LessonRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleVersion" (
    "id" TEXT NOT NULL,
    "academicYear" TEXT NOT NULL,
    "term" "Term" NOT NULL,
    "number" INTEGER NOT NULL,
    "name" TEXT,
    "status" "TimetableStatus" NOT NULL DEFAULT 'DRAFT',
    "parentId" TEXT,
    "note" TEXT,
    "stats" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "publishedBy" TEXT,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "ScheduleVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleLesson" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "requirementId" TEXT,
    "sessionIndex" INTEGER NOT NULL DEFAULT 0,
    "subjectId" TEXT NOT NULL,
    "teacherId" TEXT,
    "roomId" TEXT,
    "groupNames" TEXT[],
    "lessonTypeCode" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "timeSlotId" TEXT,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "weekParity" "WeekParity" NOT NULL DEFAULT 'BOTH',
    "level" "StudyLevel" NOT NULL DEFAULT 'BACHELOR',
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "override" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleLesson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimetableJob" (
    "id" TEXT NOT NULL,
    "versionId" TEXT,
    "academicYear" TEXT NOT NULL,
    "term" "Term" NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'GENERATE',
    "status" "TimetableJobStatus" NOT NULL DEFAULT 'QUEUED',
    "scope" JSONB,
    "params" JSONB,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "phase" TEXT,
    "result" JSONB,
    "error" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "TimetableJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LessonType_code_key" ON "LessonType"("code");

-- CreateIndex
CREATE UNIQUE INDEX "TimeSlot_code_key" ON "TimeSlot"("code");

-- CreateIndex
CREATE UNIQUE INDEX "TimetableConfig_academicYear_term_key" ON "TimetableConfig"("academicYear", "term");

-- CreateIndex
CREATE INDEX "TimetableRule_scope_targetId_idx" ON "TimetableRule"("scope", "targetId");

-- CreateIndex
CREATE INDEX "TimetableRule_academicYear_term_idx" ON "TimetableRule"("academicYear", "term");

-- CreateIndex
CREATE INDEX "LessonRequirement_academicYear_term_idx" ON "LessonRequirement"("academicYear", "term");

-- CreateIndex
CREATE INDEX "LessonRequirement_teacherId_idx" ON "LessonRequirement"("teacherId");

-- CreateIndex
CREATE INDEX "LessonRequirement_groupNames_idx" ON "LessonRequirement" USING GIN ("groupNames");

-- CreateIndex
CREATE INDEX "ScheduleVersion_academicYear_term_status_idx" ON "ScheduleVersion"("academicYear", "term", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleVersion_academicYear_term_number_key" ON "ScheduleVersion"("academicYear", "term", "number");

-- CreateIndex
CREATE INDEX "ScheduleLesson_versionId_dayOfWeek_idx" ON "ScheduleLesson"("versionId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "ScheduleLesson_versionId_teacherId_idx" ON "ScheduleLesson"("versionId", "teacherId");

-- CreateIndex
CREATE INDEX "ScheduleLesson_versionId_roomId_idx" ON "ScheduleLesson"("versionId", "roomId");

-- CreateIndex
CREATE INDEX "ScheduleLesson_versionId_subjectId_idx" ON "ScheduleLesson"("versionId", "subjectId");

-- CreateIndex
CREATE INDEX "ScheduleLesson_groupNames_idx" ON "ScheduleLesson" USING GIN ("groupNames");

-- CreateIndex
CREATE INDEX "TimetableJob_status_createdAt_idx" ON "TimetableJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "TimetableJob_versionId_idx" ON "TimetableJob"("versionId");

-- CreateIndex
CREATE INDEX "Room_building_idx" ON "Room"("building");

-- CreateIndex
CREATE INDEX "Room_type_capacity_idx" ON "Room"("type", "capacity");

-- AddForeignKey
ALTER TABLE "LessonRequirement" ADD CONSTRAINT "LessonRequirement_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonRequirement" ADD CONSTRAINT "LessonRequirement_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleLesson" ADD CONSTRAINT "ScheduleLesson_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ScheduleVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleLesson" ADD CONSTRAINT "ScheduleLesson_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "LessonRequirement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleLesson" ADD CONSTRAINT "ScheduleLesson_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleLesson" ADD CONSTRAINT "ScheduleLesson_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleLesson" ADD CONSTRAINT "ScheduleLesson_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableJob" ADD CONSTRAINT "TimetableJob_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ScheduleVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Справочники по умолчанию (администратор меняет их в Admin Panel → Расписание → Настройки) ──
INSERT INTO "LessonType" ("id","code","name","roomTypes","color","sortOrder") VALUES
 ('lt_lecture','lecture','Lecture',ARRAY['lecture_hall','classroom'],'#2563eb',1),
 ('lt_seminar','seminar','Seminar',ARRAY['classroom','seminar_room','lecture_hall'],'#7c3aed',2),
 ('lt_practice','practice','Practice',ARRAY['classroom','lab','computer_lab'],'#0891b2',3),
 ('lt_lab','lab','Laboratory',ARRAY['lab','computer_lab'],'#16a34a',4),
 ('lt_consult','consultation','Consultation',ARRAY[]::TEXT[],'#64748b',5),
 ('lt_exam','exam','Exam',ARRAY[]::TEXT[],'#dc2626',6),
 ('lt_other','other','Other',ARRAY[]::TEXT[],'#94a3b8',7)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "TimeSlot" ("id","code","label","startTime","endTime","level","shift","sortOrder") VALUES
 ('ts_b1','B1','1','08:00','09:20','BACHELOR','1',1),
 ('ts_b2','B2','2','09:35','10:55','BACHELOR','1',2),
 ('ts_b3','B3','3','11:10','12:30','BACHELOR','1',3),
 ('ts_b4','B4','4','12:45','14:05','BACHELOR','2',4),
 ('ts_b5','B5','5','14:20','15:40','BACHELOR','2',5),
 ('ts_b6','B6','6','15:55','17:15','BACHELOR','2',6),
 ('ts_m1','M1','M1','17:30','18:50','MASTER','M',7),
 ('ts_m2','M2','M2','19:05','20:25','MASTER','M',8),
 ('ts_m3','M3','M3','20:40','22:00','MASTER','M',9)
ON CONFLICT ("code") DO NOTHING;

-- Существующие слоты: потоки (одно время + аудитория + предмет у нескольких групп) получают общий streamKey
UPDATE "ScheduleSlot" s SET "streamKey" = md5(s."academicYear"||s.term||s."subjectId"||s."dayOfWeek"||s."startTime"||coalesce(s."roomId",s.room)||s."weekParity")
WHERE EXISTS (SELECT 1 FROM "ScheduleSlot" o WHERE o.id <> s.id AND o."academicYear"=s."academicYear" AND o.term=s.term AND o."subjectId"=s."subjectId"
  AND o."dayOfWeek"=s."dayOfWeek" AND o."startTime"=s."startTime" AND coalesce(o."roomId",o.room)=coalesce(s."roomId",s.room) AND o."weekParity"=s."weekParity");