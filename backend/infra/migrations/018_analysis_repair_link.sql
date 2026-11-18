BEGIN;
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS repair_id uuid REFERENCES repairs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS analyses_repair_id ON analyses (repair_id) WHERE repair_id IS NOT NULL;
COMMIT;
