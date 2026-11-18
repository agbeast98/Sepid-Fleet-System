BEGIN;
SELECT pg_advisory_xact_lock(514014);

UPDATE app_settings
SET payload = jsonb_set(
  payload,
  '{stages}',
  (
    SELECT jsonb_agg(
      CASE WHEN stage->>'id' IN ('report','wait','done','test') THEN
        stage || jsonb_build_object(
          'label', CASE
            WHEN stage->>'id'='report' AND stage->>'label'='اعلام خرابی' THEN 'اعلام خرابی (ماشین در کارخانه)'
            WHEN stage->>'id'='test' AND stage->>'label'='تست سلامت' THEN 'تست سلامت (ماشین در کارخانه)'
            ELSE stage->>'label'
          END,
          'mode', COALESCE(NULLIF(stage->>'mode',''), CASE stage->>'id' WHEN 'report' THEN 'report' WHEN 'wait' THEN 'wait' WHEN 'done' THEN 'done' ELSE 'test' END),
          'loc', COALESCE(NULLIF(stage->>'loc',''), CASE stage->>'id' WHEN 'report' THEN 'factory' WHEN 'wait' THEN 'part' WHEN 'done' THEN 'shop' ELSE 'done' END),
          'who', COALESCE(NULLIF(stage->>'who',''), CASE WHEN stage->>'id' IN ('report','test') THEN 'سرپرست' ELSE 'تعمیرات' END),
          'desc', COALESCE(NULLIF(stage->>'desc',''), CASE stage->>'id'
            WHEN 'report' THEN 'خرابی ثبت شده و ماشین هنوز در کارخانه است'
            WHEN 'wait' THEN 'ماشین برای تعمیر رفته و در انتظار تأمین قطعه یا انجام خدمات تعمیر است'
            WHEN 'done' THEN 'تعمیر تمام شده و ماشین باید در کارخانه تست سلامت شود'
            ELSE 'ماشین در کارخانه آزمایش می‌شود؛ اگر قبول شود پرونده بایگانی می‌شود و اگر رد شود خرابی جدید ثبت می‌شود'
          END),
          'limit', CASE WHEN stage ? 'limit' THEN stage->'limit' ELSE to_jsonb(CASE stage->>'id' WHEN 'wait' THEN 7 WHEN 'done' THEN 2 ELSE NULL END) END
        )
      ELSE stage END ORDER BY ordinal
    )
    FROM jsonb_array_elements(payload->'stages') WITH ORDINALITY AS item(stage,ordinal)
  ),
  true
)
WHERE singleton AND jsonb_typeof(payload->'stages')='array';

COMMIT;
