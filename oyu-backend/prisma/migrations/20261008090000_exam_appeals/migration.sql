-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RequestStatus" ADD VALUE 'UNDER_REVIEW';
ALTER TYPE "RequestStatus" ADD VALUE 'PARTIALLY_APPROVED';
ALTER TYPE "RequestStatus" ADD VALUE 'WITHDRAWN';

-- AlterTable
ALTER TABLE "ExamResult" ADD COLUMN     "revisedAt" TIMESTAMP(3),
ADD COLUMN     "revisedByAppealId" TEXT,
ADD COLUMN     "revisedExamScore" DECIMAL(5,2),
ADD COLUMN     "revisedLetter" TEXT,
ADD COLUMN     "revisedPassed" BOOLEAN,
ADD COLUMN     "revisedTotal" DECIMAL(5,2);

-- CreateTable
CREATE TABLE "ExamAppeal" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "originalExamScore" DECIMAL(5,2) NOT NULL,
    "entryScore" DECIMAL(5,2) NOT NULL,
    "originalTotal" DECIMAL(5,2) NOT NULL,
    "appealOpenAt" TIMESTAMP(3) NOT NULL,
    "appealDeadline" TIMESTAMP(3) NOT NULL,
    "reviewStartedAt" TIMESTAMP(3),
    "reviewerId" TEXT,
    "escalatedAt" TIMESTAMP(3),
    "escalatedById" TEXT,
    "escalationReason" TEXT,
    "outcome" TEXT,
    "revisedExamScore" DECIMAL(5,2),
    "revisedTotal" DECIMAL(5,2),
    "decisionNote" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "withdrawnAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExamAppeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamAppealItem" (
    "id" TEXT NOT NULL,
    "appealId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "questionId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "questionText" TEXT NOT NULL,
    "answerText" TEXT,
    "answerState" TEXT NOT NULL,
    "awardedPoints" INTEGER NOT NULL,
    "maxPoints" INTEGER NOT NULL,
    "newPoints" INTEGER,
    "outcome" TEXT,
    "reviewerComment" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,

    CONSTRAINT "ExamAppealItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExamAppeal_requestId_key" ON "ExamAppeal"("requestId");

-- CreateIndex
CREATE INDEX "ExamAppeal_resultId_idx" ON "ExamAppeal"("resultId");

-- CreateIndex
CREATE INDEX "ExamAppeal_studentId_idx" ON "ExamAppeal"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "ExamAppealItem_appealId_position_key" ON "ExamAppealItem"("appealId", "position");

-- AddForeignKey
ALTER TABLE "ExamAppeal" ADD CONSTRAINT "ExamAppeal_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "Request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamAppeal" ADD CONSTRAINT "ExamAppeal_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "ExamResult"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamAppealItem" ADD CONSTRAINT "ExamAppealItem_appealId_fkey" FOREIGN KEY ("appealId") REFERENCES "ExamAppeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Одна активная (не отозванная) апелляция на результат экзамена — защита от дубликатов на уровне БД
CREATE UNIQUE INDEX "ExamAppeal_one_active_per_result" ON "ExamAppeal"("resultId") WHERE "withdrawnAt" IS NULL;

-- ExamResult: исходные баллы неизменяемы; разрешены публикация (publishedAt) и пересмотр по апелляции (revised*)
CREATE OR REPLACE FUNCTION exam_guard_result() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Exam results are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - 'publishedAt' - 'revisedExamScore' - 'revisedTotal' - 'revisedLetter' - 'revisedPassed' - 'revisedAt' - 'revisedByAppealId')
     IS DISTINCT FROM (to_jsonb(OLD) - 'publishedAt' - 'revisedExamScore' - 'revisedTotal' - 'revisedLetter' - 'revisedPassed' - 'revisedAt' - 'revisedByAppealId')
     OR OLD."publishedAt" IS NOT NULL AND NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt" THEN
    RAISE EXCEPTION 'Exam results are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
