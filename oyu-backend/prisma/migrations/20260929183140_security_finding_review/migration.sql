-- CreateEnum
CREATE TYPE "FindingStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'FALSE_POSITIVE');

-- CreateTable
CREATE TABLE "SecurityFindingReview" (
    "key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "FindingStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityFindingReview_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "SecurityFindingReview_status_idx" ON "SecurityFindingReview"("status");
