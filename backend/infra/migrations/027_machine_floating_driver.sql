BEGIN;

ALTER TABLE machines ADD COLUMN IF NOT EXISTS floating_driver boolean NOT NULL DEFAULT false;

-- The starter fleet marks machines without a permanently assigned driver in its note.
UPDATE machines SET floating_driver = true
WHERE driver_id IS NULL AND note = 'راننده ثابت ندارد';

UPDATE machines SET driver_id = NULL WHERE floating_driver AND driver_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'machines_floating_driver_unassigned' AND conrelid = 'machines'::regclass) THEN
    ALTER TABLE machines ADD CONSTRAINT machines_floating_driver_unassigned
      CHECK (NOT floating_driver OR driver_id IS NULL);
  END IF;
END $$;

COMMIT;
