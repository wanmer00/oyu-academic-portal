-- Academic Journal: перевод существующих данных на шкалу Final 50 / Midterm 30 / Seminar 20
-- (отдельная миграция: новое значение enum SEMINAR нельзя использовать в той же транзакции, где оно добавлено)

-- 1) До Journal оценки были видны студентам сразу: считаем все существующие опубликованными
UPDATE "Grade" SET "publishedAt" = "createdAt" WHERE "publishedAt" IS NULL;

-- 2) История: фиксируем пересчёт шкал (старое значение по 100-балльной шкале -> новое)
INSERT INTO "GradeHistory" ("id", "gradeId", "oldValue", "newValue", "changedBy", "reason", "changedAt")
SELECT 'jm_' || g."id", g."id", g."value",
       CASE g."type"
         WHEN 'MIDTERM' THEN ROUND(g."value" * 30 / g."maxValue", 2)
         WHEN 'FINAL'   THEN ROUND(g."value" * 50 / g."maxValue", 2)
         WHEN 'QUIZ'    THEN ROUND(g."value" * 10 / g."maxValue", 2)
       END,
       'system:journal-migration',
       'Rescaled to Academic Journal scale (Final 50, Midterm 30, Seminar answer 10)',
       now()
FROM "Grade" g
WHERE g."type" IN ('MIDTERM', 'FINAL', 'QUIZ') AND g."maxValue" = 100;

-- 3) Пересчёт шкал (пропорционально, процент сохраняется)
UPDATE "Grade" SET "value" = ROUND("value" * 30 / "maxValue", 2), "maxValue" = 30 WHERE "type" = 'MIDTERM' AND "maxValue" = 100;
UPDATE "Grade" SET "value" = ROUND("value" * 50 / "maxValue", 2), "maxValue" = 50 WHERE "type" = 'FINAL'   AND "maxValue" = 100;
-- Старые QUIZ трактуем как семинарские ответы (0-10). HOMEWORK/PROJECT остаются как есть и в формулу не входят.
UPDATE "Grade" SET "value" = ROUND("value" * 10 / "maxValue", 2), "maxValue" = 10, "type" = 'SEMINAR' WHERE "type" = 'QUIZ' AND "maxValue" = 100;

-- 4) Академические периоды: прошедшие закрыты, текущий (2025-2026 SPRING) открыт
INSERT INTO "AcademicPeriod" ("id", "academicYear", "term", "status", "closedAt", "updatedAt")
SELECT 'ap_' || md5(p."academicYear" || p."term"::text), p."academicYear", p."term",
       CASE WHEN p."academicYear" = '2025-2026' AND p."term" = 'SPRING' THEN 'OPEN'::"PeriodStatus" ELSE 'CLOSED'::"PeriodStatus" END,
       CASE WHEN p."academicYear" = '2025-2026' AND p."term" = 'SPRING' THEN NULL ELSE now() END,
       now()
FROM (
  SELECT "academicYear", "term" FROM "Grade"
  UNION SELECT "academicYear", "term" FROM "Attendance"
  UNION SELECT '2025-2026', 'SPRING'::"Term"
) p
ON CONFLICT ("academicYear", "term") DO NOTHING;