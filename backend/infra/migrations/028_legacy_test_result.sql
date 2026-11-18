BEGIN;
SELECT pg_advisory_xact_lock(514028);

ALTER TABLE repairs DROP CONSTRAINT IF EXISTS repairs_result_check;
ALTER TABLE repairs ADD CONSTRAINT repairs_result_check CHECK (result IN ('pass', 'fail', 'old'));

ALTER TABLE repair_events DROP CONSTRAINT IF EXISTS repair_events_result_check;
ALTER TABLE repair_events ADD CONSTRAINT repair_events_result_check CHECK (result IN ('pass', 'fail', 'old'));

COMMIT;
