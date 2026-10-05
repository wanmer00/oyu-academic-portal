-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CLOSED');

-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "status" "AssignmentStatus" NOT NULL DEFAULT 'PUBLISHED',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Material" ADD COLUMN     "assignmentId" TEXT;

-- CreateIndex
CREATE INDEX "Material_assignmentId_idx" ON "Material"("assignmentId");

-- AddForeignKey
ALTER TABLE "Material" ADD CONSTRAINT "Material_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
