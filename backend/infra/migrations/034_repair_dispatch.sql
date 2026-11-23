BEGIN;
SELECT pg_advisory_xact_lock(514034);

UPDATE app_settings
SET payload = jsonb_set(payload, '{stages}', jsonb_insert(
  payload->'stages', '{1}',
  '{"id":"dispatch","label":"اعزام به تعمیرگاه","kind":"step","mode":"step","loc":"road","limit":null,"who":"تعمیرات","desc":"ماشین به تعمیرگاه اعزام شده است"}'
))
WHERE singleton
  AND NOT (payload ? '_repairDispatchMigrated')
  AND jsonb_array_length(payload->'stages') < 12
  AND NOT (payload->'stages' @> '[{"id":"dispatch"}]');

ALTER TABLE repairs ALTER COLUMN workflow SET DEFAULT ARRAY['report','dispatch','wait','done','test']::text[];

UPDATE repairs
SET workflow = workflow[1:1] || ARRAY['dispatch'] || workflow[2:cardinality(workflow)]
WHERE stage = 'report' AND result IS NULL AND NOT ('dispatch' = ANY(workflow))
  AND cardinality(workflow) < 12
  AND EXISTS (SELECT 1 FROM app_settings WHERE singleton AND NOT (payload ? '_repairDispatchMigrated')
    AND payload->'stages' @> '[{"id":"dispatch"}]');

INSERT INTO user_stage_permissions(user_id, stage)
SELECT user_id, 'dispatch' FROM user_stage_permissions WHERE stage = 'wait'
  AND EXISTS (SELECT 1 FROM app_settings WHERE singleton AND NOT (payload ? '_repairDispatchMigrated')
    AND payload->'stages' @> '[{"id":"dispatch"}]')
ON CONFLICT (user_id, stage) DO NOTHING;

UPDATE app_settings
SET payload = payload || '{"_repairDispatchMigrated":true}'
WHERE singleton AND NOT (payload ? '_repairDispatchMigrated')
  AND payload->'stages' @> '[{"id":"dispatch"}]';

COMMIT;
