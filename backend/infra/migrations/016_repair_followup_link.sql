BEGIN;
SELECT pg_advisory_xact_lock(514016);

ALTER TABLE repairs ADD COLUMN IF NOT EXISTS previous_repair_id uuid REFERENCES repairs(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS repairs_one_followup_per_rejection
  ON repairs(previous_repair_id) WHERE previous_repair_id IS NOT NULL;

COMMIT;
