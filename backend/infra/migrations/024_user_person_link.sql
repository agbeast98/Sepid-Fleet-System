BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS person_id text REFERENCES people(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS users_person_id ON users(person_id);

COMMIT;
