BEGIN;
SELECT pg_advisory_xact_lock(514012);

ALTER TABLE repairs ADD COLUMN IF NOT EXISTS report_date date;
ALTER TABLE repairs ADD COLUMN IF NOT EXISTS diagnoser text NOT NULL DEFAULT '';
ALTER TABLE repairs ADD COLUMN IF NOT EXISTS expected_date date;
ALTER TABLE repairs ADD COLUMN IF NOT EXISTS refer_date date;
ALTER TABLE repairs ADD COLUMN IF NOT EXISTS repairer_note text NOT NULL DEFAULT '';
ALTER TABLE repairs ADD COLUMN IF NOT EXISTS return_date date;
ALTER TABLE repairs ADD COLUMN IF NOT EXISTS delay_reason text NOT NULL DEFAULT '';

UPDATE repairs
SET report_date = (created_at AT TIME ZONE 'Asia/Tehran')::date
WHERE report_date IS NULL;

ALTER TABLE repairs ALTER COLUMN report_date SET DEFAULT ((now() AT TIME ZONE 'Asia/Tehran')::date);
ALTER TABLE repairs ALTER COLUMN report_date SET NOT NULL;
CREATE INDEX IF NOT EXISTS repairs_report_date ON repairs (report_date DESC);

COMMIT;
