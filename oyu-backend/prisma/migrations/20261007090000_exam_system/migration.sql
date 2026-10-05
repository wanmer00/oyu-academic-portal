-- CreateEnum
CREATE TYPE "ExamKind" AS ENUM ('FINAL', 'RESIT');

-- CreateEnum
CREATE TYPE "ExamDelivery" AS ENUM ('COMPUTER', 'PAPER');

-- CreateEnum
CREATE TYPE "ExamWindowStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "QuestionBankStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ExamAttemptStatus" AS ENUM ('AUTHORIZED', 'IN_PROGRESS', 'SUBMITTED', 'AUTO_SUBMITTED', 'TERMINATED', 'VOID');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('ENROLLED', 'COMPLETED', 'RESIT_ELIGIBLE', 'RESIT_PAYMENT_PENDING', 'RESIT_PAID', 'RESIT_FORFEITED', 'RETAKE_REQUIRED', 'RETAKE_REGISTERED');

-- CreateEnum
CREATE TYPE "ResitStatus" AS ENUM ('ELIGIBLE', 'PAYMENT_PENDING', 'PAID', 'USED', 'FORFEITED');

-- CreateEnum
CREATE TYPE "RetakeMode" AS ENUM ('SUMMER', 'NEXT_OFFERING');

-- CreateEnum
CREATE TYPE "RetakeStatus" AS ENUM ('PENDING', 'REGISTERED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaperSheetStatus" AS ENUM ('GENERATED', 'SCANNED', 'MANUAL_REVIEW_REQUIRED', 'VERIFIED', 'SCORED');

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'PROCTOR';

-- CreateTable
CREATE TABLE "SubjectOffering" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "specialtyId" TEXT,
    "academicYear" TEXT NOT NULL,
    "term" "Term" NOT NULL,
    "course" INTEGER NOT NULL,
    "semester" INTEGER NOT NULL,
    "cycle" TEXT NOT NULL DEFAULT 'EVERY_YEAR',
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "enrollmentOpensAt" TIMESTAMP(3),
    "enrollmentClosesAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubjectOffering_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferingPrerequisite" (
    "offeringId" TEXT NOT NULL,
    "requiredSubjectId" TEXT NOT NULL,

    CONSTRAINT "OfferingPrerequisite_pkey" PRIMARY KEY ("offeringId","requiredSubjectId")
);

-- CreateTable
CREATE TABLE "SubjectEnrollment" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "offeringId" TEXT,
    "academicYear" TEXT NOT NULL,
    "term" "Term" NOT NULL,
    "semester" INTEGER NOT NULL,
    "attemptNo" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL DEFAULT 'CURRICULUM',
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'ENROLLED',
    "entryScore" DECIMAL(5,2),
    "retakeOfId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubjectEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamWindow" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "ExamKind" NOT NULL,
    "academicYear" TEXT NOT NULL,
    "term" "Term" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "allowedWeekdays" INTEGER[],
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "maxPerWeek" INTEGER NOT NULL DEFAULT 3,
    "questionDeadline" TIMESTAMP(3) NOT NULL,
    "status" "ExamWindowStatus" NOT NULL DEFAULT 'DRAFT',
    "finalWindowId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExamWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamWindowScope" (
    "id" TEXT NOT NULL,
    "windowId" TEXT NOT NULL,
    "facultyId" TEXT,
    "specialtyId" TEXT,
    "groupName" TEXT,

    CONSTRAINT "ExamWindowScope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Exam" (
    "id" TEXT NOT NULL,
    "windowId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "delivery" "ExamDelivery" NOT NULL DEFAULT 'COMPUTER',
    "questionCount" INTEGER NOT NULL DEFAULT 25,
    "durationMin" INTEGER NOT NULL DEFAULT 120,
    "rulesVersion" INTEGER NOT NULL DEFAULT 1,
    "bankVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Exam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionBank" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionBank_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionBankVersion" (
    "id" TEXT NOT NULL,
    "bankId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "QuestionBankStatus" NOT NULL DEFAULT 'DRAFT',
    "authorId" TEXT NOT NULL,
    "basedOnId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewStartedAt" TIMESTAMP(3),
    "reviewerId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionBankVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "image" TEXT,
    "contentHash" TEXT NOT NULL,

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionOption" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isCorrect" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "QuestionOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamWorkstation" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "keyHash" TEXT,
    "keyIssuedAt" TIMESTAMP(3),
    "allowedCidr" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "lastSeenIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamWorkstation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProctorAssignment" (
    "id" TEXT NOT NULL,
    "proctorId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProctorAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamEligibilityCheck" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "eligible" BOOLEAN NOT NULL,
    "reasons" TEXT[],
    "checkedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamEligibilityCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProctorAuthorization" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "proctorId" TEXT NOT NULL,
    "workstationId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "idChecked" BOOLEAN NOT NULL,
    "passportChecked" BOOLEAN NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProctorAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamAttempt" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "kind" "ExamKind" NOT NULL,
    "authorizationId" TEXT NOT NULL,
    "workstationId" TEXT NOT NULL,
    "bankVersionId" TEXT,
    "rulesVersion" INTEGER NOT NULL,
    "windowVersion" INTEGER NOT NULL,
    "status" "ExamAttemptStatus" NOT NULL DEFAULT 'AUTHORIZED',
    "startedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "submittedBy" TEXT,
    "terminateReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamAttemptQuestion" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "optionOrder" TEXT[],
    "selectedOptionId" TEXT,
    "answeredAt" TIMESTAMP(3),
    "seq" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ExamAttemptQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamResult" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT,
    "sheetId" TEXT,
    "examId" TEXT,
    "studentId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "kind" "ExamKind" NOT NULL,
    "source" TEXT NOT NULL,
    "correct" INTEGER NOT NULL,
    "wrong" INTEGER NOT NULL,
    "skipped" INTEGER NOT NULL,
    "examScore" DECIMAL(5,2) NOT NULL,
    "entryScore" DECIMAL(5,2) NOT NULL,
    "total" DECIMAL(5,2) NOT NULL,
    "letter" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "failReason" TEXT,
    "rulesVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "ExamResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperAnswerSheet" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "sheetCode" TEXT NOT NULL,
    "bankVersionId" TEXT NOT NULL,
    "status" "PaperSheetStatus" NOT NULL DEFAULT 'GENERATED',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaperAnswerSheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperSheetQuestion" (
    "id" TEXT NOT NULL,
    "sheetId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "optionOrder" TEXT[],
    "detectedIndex" INTEGER,
    "confidence" DECIMAL(5,3),
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reviewed" BOOLEAN NOT NULL DEFAULT false,
    "finalOptionId" TEXT,
    "correctedBy" TEXT,
    "correctedAt" TIMESTAMP(3),

    CONSTRAINT "PaperSheetQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperScan" (
    "id" TEXT NOT NULL,
    "sheetId" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "quality" DECIMAL(5,3),
    "note" TEXT,
    "uploadedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaperScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResitEligibility" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "cycleKey" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "creditPrice" DECIMAL(10,2) NOT NULL,
    "feeAmount" DECIMAL(10,2) NOT NULL,
    "status" "ResitStatus" NOT NULL DEFAULT 'ELIGIBLE',
    "paymentId" TEXT,
    "usedAttemptId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResitEligibility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SummerRetakePeriod" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "academicYear" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "registrationClosesAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SummerRetakePeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SummerRetakeCourse" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "teacherId" TEXT,
    "schedule" TEXT,
    "maxStudents" INTEGER NOT NULL DEFAULT 30,
    "minAttendance" INTEGER NOT NULL DEFAULT 75,
    "assessment" TEXT NOT NULL DEFAULT 'FINAL_EXAM',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SummerRetakeCourse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetakeEnrollment" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "failedEnrollmentId" TEXT NOT NULL,
    "mode" "RetakeMode",
    "summerCourseId" TEXT,
    "offeringId" TEXT,
    "newEnrollmentId" TEXT,
    "status" "RetakeStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RetakeEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubjectOffering_subjectId_startsAt_idx" ON "SubjectOffering"("subjectId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "SubjectOffering_subjectId_specialtyId_academicYear_term_key" ON "SubjectOffering"("subjectId", "specialtyId", "academicYear", "term");

-- CreateIndex
CREATE UNIQUE INDEX "SubjectEnrollment_retakeOfId_key" ON "SubjectEnrollment"("retakeOfId");

-- CreateIndex
CREATE INDEX "SubjectEnrollment_studentId_status_idx" ON "SubjectEnrollment"("studentId", "status");

-- CreateIndex
CREATE INDEX "SubjectEnrollment_subjectId_academicYear_term_idx" ON "SubjectEnrollment"("subjectId", "academicYear", "term");

-- CreateIndex
CREATE UNIQUE INDEX "SubjectEnrollment_studentId_subjectId_academicYear_term_att_key" ON "SubjectEnrollment"("studentId", "subjectId", "academicYear", "term", "attemptNo");

-- CreateIndex
CREATE INDEX "ExamWindow_status_startDate_idx" ON "ExamWindow"("status", "startDate");

-- CreateIndex
CREATE INDEX "ExamWindow_academicYear_term_idx" ON "ExamWindow"("academicYear", "term");

-- CreateIndex
CREATE INDEX "ExamWindowScope_windowId_idx" ON "ExamWindowScope"("windowId");

-- CreateIndex
CREATE INDEX "Exam_subjectId_idx" ON "Exam"("subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "Exam_windowId_subjectId_key" ON "Exam"("windowId", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "QuestionBank_subjectId_key" ON "QuestionBank"("subjectId");

-- CreateIndex
CREATE INDEX "QuestionBankVersion_status_idx" ON "QuestionBankVersion"("status");

-- CreateIndex
CREATE UNIQUE INDEX "QuestionBankVersion_bankId_version_key" ON "QuestionBankVersion"("bankId", "version");

-- CreateIndex
CREATE INDEX "Question_versionId_ordinal_idx" ON "Question"("versionId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "Question_versionId_contentHash_key" ON "Question"("versionId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "QuestionOption_questionId_label_key" ON "QuestionOption"("questionId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "ExamWorkstation_keyHash_key" ON "ExamWorkstation"("keyHash");

-- CreateIndex
CREATE UNIQUE INDEX "ExamWorkstation_roomId_code_key" ON "ExamWorkstation"("roomId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ProctorAssignment_proctorId_roomId_key" ON "ProctorAssignment"("proctorId", "roomId");

-- CreateIndex
CREATE INDEX "ExamEligibilityCheck_examId_studentId_idx" ON "ExamEligibilityCheck"("examId", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "ProctorAuthorization_tokenHash_key" ON "ProctorAuthorization"("tokenHash");

-- CreateIndex
CREATE INDEX "ProctorAuthorization_workstationId_usedAt_idx" ON "ProctorAuthorization"("workstationId", "usedAt");

-- CreateIndex
CREATE INDEX "ProctorAuthorization_studentId_idx" ON "ProctorAuthorization"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "ExamAttempt_authorizationId_key" ON "ExamAttempt"("authorizationId");

-- CreateIndex
CREATE INDEX "ExamAttempt_studentId_kind_createdAt_idx" ON "ExamAttempt"("studentId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "ExamAttempt_status_expiresAt_idx" ON "ExamAttempt"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "ExamAttempt_workstationId_status_idx" ON "ExamAttempt"("workstationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ExamAttemptQuestion_attemptId_position_key" ON "ExamAttemptQuestion"("attemptId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ExamAttemptQuestion_attemptId_questionId_key" ON "ExamAttemptQuestion"("attemptId", "questionId");

-- CreateIndex
CREATE UNIQUE INDEX "ExamResult_attemptId_key" ON "ExamResult"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "ExamResult_sheetId_key" ON "ExamResult"("sheetId");

-- CreateIndex
CREATE INDEX "ExamResult_studentId_createdAt_idx" ON "ExamResult"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX "ExamResult_examId_idx" ON "ExamResult"("examId");

-- CreateIndex
CREATE INDEX "ExamResult_enrollmentId_idx" ON "ExamResult"("enrollmentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaperAnswerSheet_sheetCode_key" ON "PaperAnswerSheet"("sheetCode");

-- CreateIndex
CREATE UNIQUE INDEX "PaperAnswerSheet_examId_studentId_key" ON "PaperAnswerSheet"("examId", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaperSheetQuestion_sheetId_position_key" ON "PaperSheetQuestion"("sheetId", "position");

-- CreateIndex
CREATE INDEX "PaperScan_sheetId_idx" ON "PaperScan"("sheetId");

-- CreateIndex
CREATE UNIQUE INDEX "ResitEligibility_paymentId_key" ON "ResitEligibility"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "ResitEligibility_usedAttemptId_key" ON "ResitEligibility"("usedAttemptId");

-- CreateIndex
CREATE INDEX "ResitEligibility_studentId_cycleKey_status_idx" ON "ResitEligibility"("studentId", "cycleKey", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ResitEligibility_enrollmentId_cycleKey_key" ON "ResitEligibility"("enrollmentId", "cycleKey");

-- CreateIndex
CREATE UNIQUE INDEX "SummerRetakeCourse_periodId_subjectId_key" ON "SummerRetakeCourse"("periodId", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "RetakeEnrollment_failedEnrollmentId_key" ON "RetakeEnrollment"("failedEnrollmentId");

-- CreateIndex
CREATE UNIQUE INDEX "RetakeEnrollment_newEnrollmentId_key" ON "RetakeEnrollment"("newEnrollmentId");

-- CreateIndex
CREATE INDEX "RetakeEnrollment_studentId_status_idx" ON "RetakeEnrollment"("studentId", "status");

-- AddForeignKey
ALTER TABLE "SubjectOffering" ADD CONSTRAINT "SubjectOffering_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubjectOffering" ADD CONSTRAINT "SubjectOffering_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "Specialty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferingPrerequisite" ADD CONSTRAINT "OfferingPrerequisite_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "SubjectOffering"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferingPrerequisite" ADD CONSTRAINT "OfferingPrerequisite_requiredSubjectId_fkey" FOREIGN KEY ("requiredSubjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubjectEnrollment" ADD CONSTRAINT "SubjectEnrollment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubjectEnrollment" ADD CONSTRAINT "SubjectEnrollment_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubjectEnrollment" ADD CONSTRAINT "SubjectEnrollment_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "SubjectOffering"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubjectEnrollment" ADD CONSTRAINT "SubjectEnrollment_retakeOfId_fkey" FOREIGN KEY ("retakeOfId") REFERENCES "SubjectEnrollment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamWindow" ADD CONSTRAINT "ExamWindow_finalWindowId_fkey" FOREIGN KEY ("finalWindowId") REFERENCES "ExamWindow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamWindowScope" ADD CONSTRAINT "ExamWindowScope_windowId_fkey" FOREIGN KEY ("windowId") REFERENCES "ExamWindow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamWindowScope" ADD CONSTRAINT "ExamWindowScope_facultyId_fkey" FOREIGN KEY ("facultyId") REFERENCES "Faculty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamWindowScope" ADD CONSTRAINT "ExamWindowScope_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "Specialty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamWindowScope" ADD CONSTRAINT "ExamWindowScope_groupName_fkey" FOREIGN KEY ("groupName") REFERENCES "AcademicGroup"("name") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_windowId_fkey" FOREIGN KEY ("windowId") REFERENCES "ExamWindow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_bankVersionId_fkey" FOREIGN KEY ("bankVersionId") REFERENCES "QuestionBankVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionBank" ADD CONSTRAINT "QuestionBank_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionBank" ADD CONSTRAINT "QuestionBank_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Teacher"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionBankVersion" ADD CONSTRAINT "QuestionBankVersion_bankId_fkey" FOREIGN KEY ("bankId") REFERENCES "QuestionBank"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionBankVersion" ADD CONSTRAINT "QuestionBankVersion_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionBankVersion" ADD CONSTRAINT "QuestionBankVersion_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "QuestionBankVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionOption" ADD CONSTRAINT "QuestionOption_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamWorkstation" ADD CONSTRAINT "ExamWorkstation_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProctorAssignment" ADD CONSTRAINT "ProctorAssignment_proctorId_fkey" FOREIGN KEY ("proctorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProctorAssignment" ADD CONSTRAINT "ProctorAssignment_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamEligibilityCheck" ADD CONSTRAINT "ExamEligibilityCheck_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProctorAuthorization" ADD CONSTRAINT "ProctorAuthorization_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProctorAuthorization" ADD CONSTRAINT "ProctorAuthorization_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProctorAuthorization" ADD CONSTRAINT "ProctorAuthorization_proctorId_fkey" FOREIGN KEY ("proctorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProctorAuthorization" ADD CONSTRAINT "ProctorAuthorization_workstationId_fkey" FOREIGN KEY ("workstationId") REFERENCES "ExamWorkstation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "SubjectEnrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "ProctorAuthorization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_workstationId_fkey" FOREIGN KEY ("workstationId") REFERENCES "ExamWorkstation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_bankVersionId_fkey" FOREIGN KEY ("bankVersionId") REFERENCES "QuestionBankVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamAttemptQuestion" ADD CONSTRAINT "ExamAttemptQuestion_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamAttemptQuestion" ADD CONSTRAINT "ExamAttemptQuestion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamResult" ADD CONSTRAINT "ExamResult_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamResult" ADD CONSTRAINT "ExamResult_sheetId_fkey" FOREIGN KEY ("sheetId") REFERENCES "PaperAnswerSheet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamResult" ADD CONSTRAINT "ExamResult_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamResult" ADD CONSTRAINT "ExamResult_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamResult" ADD CONSTRAINT "ExamResult_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "SubjectEnrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperAnswerSheet" ADD CONSTRAINT "PaperAnswerSheet_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperAnswerSheet" ADD CONSTRAINT "PaperAnswerSheet_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperAnswerSheet" ADD CONSTRAINT "PaperAnswerSheet_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "SubjectEnrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperAnswerSheet" ADD CONSTRAINT "PaperAnswerSheet_bankVersionId_fkey" FOREIGN KEY ("bankVersionId") REFERENCES "QuestionBankVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperSheetQuestion" ADD CONSTRAINT "PaperSheetQuestion_sheetId_fkey" FOREIGN KEY ("sheetId") REFERENCES "PaperAnswerSheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperSheetQuestion" ADD CONSTRAINT "PaperSheetQuestion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperScan" ADD CONSTRAINT "PaperScan_sheetId_fkey" FOREIGN KEY ("sheetId") REFERENCES "PaperAnswerSheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResitEligibility" ADD CONSTRAINT "ResitEligibility_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "SubjectEnrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResitEligibility" ADD CONSTRAINT "ResitEligibility_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResitEligibility" ADD CONSTRAINT "ResitEligibility_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResitEligibility" ADD CONSTRAINT "ResitEligibility_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SummerRetakeCourse" ADD CONSTRAINT "SummerRetakeCourse_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "SummerRetakePeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SummerRetakeCourse" ADD CONSTRAINT "SummerRetakeCourse_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SummerRetakeCourse" ADD CONSTRAINT "SummerRetakeCourse_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetakeEnrollment" ADD CONSTRAINT "RetakeEnrollment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetakeEnrollment" ADD CONSTRAINT "RetakeEnrollment_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetakeEnrollment" ADD CONSTRAINT "RetakeEnrollment_failedEnrollmentId_fkey" FOREIGN KEY ("failedEnrollmentId") REFERENCES "SubjectEnrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetakeEnrollment" ADD CONSTRAINT "RetakeEnrollment_summerCourseId_fkey" FOREIGN KEY ("summerCourseId") REFERENCES "SummerRetakeCourse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetakeEnrollment" ADD CONSTRAINT "RetakeEnrollment_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "SubjectOffering"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ═════════ Целостность Exam System на уровне БД ═════════

-- Ровно один правильный вариант на вопрос
CREATE UNIQUE INDEX "QuestionOption_one_correct" ON "QuestionOption"("questionId") WHERE "isCorrect";

-- Одна «живая» попытка на студента и экзамен (VOID не считается)
CREATE UNIQUE INDEX "ExamAttempt_exam_student_live" ON "ExamAttempt"("examId", "studentId") WHERE "status" <> 'VOID';

-- Одна утверждённая версия на банк
CREATE UNIQUE INDEX "QuestionBankVersion_one_approved" ON "QuestionBankVersion"("bankId") WHERE "status" = 'APPROVED';

-- Не более 2 активных resit на студента в цикле
-- (проверяется сервисом в транзакции; индекс ускоряет подсчёт)
CREATE INDEX "ResitEligibility_active" ON "ResitEligibility"("studentId", "cycleKey") WHERE "status" IN ('PAYMENT_PENDING', 'PAID', 'USED');

-- Содержимое утверждённой/использованной версии банка неизменяемо
CREATE OR REPLACE FUNCTION exam_guard_question_content() RETURNS trigger AS $$
DECLARE vid text; st text;
BEGIN
  IF TG_TABLE_NAME = 'Question' THEN
    vid := COALESCE(NEW."versionId", OLD."versionId");
  ELSE
    SELECT q."versionId" INTO vid FROM "Question" q WHERE q."id" = COALESCE(NEW."questionId", OLD."questionId");
  END IF;
  IF vid IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT "status"::text INTO st FROM "QuestionBankVersion" WHERE "id" = vid;
  IF st IN ('SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'Question bank version content is locked (status %)', st USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "Question_locked" BEFORE INSERT OR UPDATE OR DELETE ON "Question" FOR EACH ROW EXECUTE FUNCTION exam_guard_question_content();
CREATE TRIGGER "QuestionOption_locked" BEFORE INSERT OR UPDATE OR DELETE ON "QuestionOption" FOR EACH ROW EXECUTE FUNCTION exam_guard_question_content();

-- Снапшот попытки: можно менять только выбранный ответ (selectedOptionId, answeredAt, seq)
CREATE OR REPLACE FUNCTION exam_guard_attempt_question() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Exam attempt snapshot is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."attemptId" <> OLD."attemptId" OR NEW."questionId" <> OLD."questionId" OR NEW."position" <> OLD."position" OR NEW."optionOrder" <> OLD."optionOrder" THEN
    RAISE EXCEPTION 'Exam attempt snapshot is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "ExamAttemptQuestion_immutable" BEFORE UPDATE OR DELETE ON "ExamAttemptQuestion" FOR EACH ROW EXECUTE FUNCTION exam_guard_attempt_question();

-- Результаты не изменяются задним числом (допустима только публикация: publishedAt null → значение)
CREATE OR REPLACE FUNCTION exam_guard_result() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Exam results are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - 'publishedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'publishedAt') OR OLD."publishedAt" IS NOT NULL AND NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt" THEN
    RAISE EXCEPTION 'Exam results are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "ExamResult_immutable" BEFORE UPDATE OR DELETE ON "ExamResult" FOR EACH ROW EXECUTE FUNCTION exam_guard_result();

-- Журнал аудита нельзя изменять и удалять (TRUNCATE демо-сброса триггером не блокируется)
CREATE OR REPLACE FUNCTION audit_guard_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only' USING ERRCODE = 'check_violation';
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "AuditLog_append_only" BEFORE UPDATE OR DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION audit_guard_immutable();
