BEGIN;
CREATE TABLE IF NOT EXISTS legacy_import_batches (
  fingerprint text PRIMARY KEY CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  source_revision integer NOT NULL,
  counts jsonb NOT NULL CHECK (jsonb_typeof(counts) = 'object'),
  imported_by text NOT NULL REFERENCES users(id),
  imported_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
