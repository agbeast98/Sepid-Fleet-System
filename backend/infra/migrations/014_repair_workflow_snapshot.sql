BEGIN;
SELECT pg_advisory_xact_lock(514014);

ALTER TABLE repairs
  ADD COLUMN IF NOT EXISTS workflow text[] NOT NULL DEFAULT ARRAY['report','wait','done','test']::text[];

ALTER TABLE repairs DROP CONSTRAINT IF EXISTS repairs_workflow_shape_check;
ALTER TABLE repairs ADD CONSTRAINT repairs_workflow_shape_check CHECK (
  cardinality(workflow) BETWEEN 2 AND 12
  AND workflow[1] = 'report'
  AND workflow[cardinality(workflow)] = 'test'
);

COMMIT;
