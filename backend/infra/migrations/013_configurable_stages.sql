BEGIN;
SELECT pg_advisory_xact_lock(514013);

ALTER TABLE repairs DROP CONSTRAINT IF EXISTS repairs_stage_check;
ALTER TABLE repair_events DROP CONSTRAINT IF EXISTS repair_events_stage_check;
ALTER TABLE user_stage_permissions DROP CONSTRAINT IF EXISTS user_stage_permissions_stage_check;

UPDATE app_settings
SET payload = payload || '{"stages":[{"id":"report","label":"اعلام خرابی","kind":"report"},{"id":"wait","label":"در انتظار قطعه یا خدمات","kind":"step"},{"id":"done","label":"پایان تعمیر","kind":"step"},{"id":"test","label":"تست سلامت","kind":"test"}]}'::jsonb
WHERE singleton AND NOT (payload ? 'stages');

COMMIT;
