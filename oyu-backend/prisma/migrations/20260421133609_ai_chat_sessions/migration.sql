-- CreateEnum
CREATE TYPE "AIFeature" AS ENUM ('TUTOR_CHAT', 'GPA_WHATIF', 'REQUEST_DRAFTER', 'MATERIAL_SEARCH', 'QUESTION_GEN', 'DROPOUT_ANALYSIS', 'AUDIT_ANALYSIS', 'TRANSLATE');

-- CreateTable
CREATE TABLE "AIChatSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "feature" "AIFeature" NOT NULL,
    "title" TEXT,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsdMilli" INTEGER NOT NULL DEFAULT 0,
    "ip" TEXT,
    "userAgent" TEXT,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "flagReason" TEXT,
    "flaggedAt" TIMESTAMP(3),
    "flaggedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AIChatSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIChatMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "model" TEXT,
    "stub" BOOLEAN NOT NULL DEFAULT false,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AIChatSession_userId_createdAt_idx" ON "AIChatSession"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AIChatSession_feature_createdAt_idx" ON "AIChatSession"("feature", "createdAt");

-- CreateIndex
CREATE INDEX "AIChatSession_flagged_createdAt_idx" ON "AIChatSession"("flagged", "createdAt");

-- CreateIndex
CREATE INDEX "AIChatSession_createdAt_idx" ON "AIChatSession"("createdAt");

-- CreateIndex
CREATE INDEX "AIChatMessage_sessionId_createdAt_idx" ON "AIChatMessage"("sessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "AIChatSession" ADD CONSTRAINT "AIChatSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIChatMessage" ADD CONSTRAINT "AIChatMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AIChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
