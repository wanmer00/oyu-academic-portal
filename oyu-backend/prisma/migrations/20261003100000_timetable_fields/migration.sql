ALTER TABLE "LessonType" ADD COLUMN "needsRoom" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "LessonRequirement" ADD COLUMN "durationSlots" INTEGER NOT NULL DEFAULT 1;
UPDATE "LessonType" SET "needsRoom" = false WHERE "code" IN ('consultation', 'other');
