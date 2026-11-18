BEGIN;
SELECT pg_advisory_xact_lock(514015);

ALTER TABLE users ADD COLUMN IF NOT EXISTS scope_shop boolean NOT NULL DEFAULT false;

COMMIT;
