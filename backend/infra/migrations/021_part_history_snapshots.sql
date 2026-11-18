BEGIN;
ALTER TABLE part_logs ADD COLUMN IF NOT EXISTS part_name_snapshot text NOT NULL DEFAULT '';
ALTER TABLE part_logs ADD COLUMN IF NOT EXISTS part_system_snapshot text NOT NULL DEFAULT '';
UPDATE part_logs l SET part_name_snapshot=p.name,part_system_snapshot=p.system
FROM model_parts p WHERE p.id=l.part_id AND (l.part_name_snapshot='' OR l.part_system_snapshot='');
ALTER TABLE part_logs ALTER COLUMN part_id DROP NOT NULL;
ALTER TABLE part_logs DROP CONSTRAINT IF EXISTS part_logs_part_id_fkey;
ALTER TABLE part_logs ADD CONSTRAINT part_logs_part_id_fkey
  FOREIGN KEY(part_id) REFERENCES model_parts(id) ON DELETE SET NULL;
COMMIT;
