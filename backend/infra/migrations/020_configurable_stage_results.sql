BEGIN;
-- Configurable workflow IDs need not literally be named "test". The API
-- validates whether a result belongs to the configured test stage.
ALTER TABLE repairs DROP CONSTRAINT IF EXISTS repairs_check;
ALTER TABLE repair_events DROP CONSTRAINT IF EXISTS repair_events_check;
ALTER TABLE repairs DROP CONSTRAINT IF EXISTS repairs_workflow_shape_check;
COMMIT;
