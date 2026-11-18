ALTER TABLE repair_events
  ADD COLUMN IF NOT EXISTS before_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by text REFERENCES users(id) ON DELETE SET NULL;
