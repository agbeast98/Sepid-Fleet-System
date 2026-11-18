BEGIN;
SELECT pg_advisory_xact_lock(514003);

CREATE TABLE IF NOT EXISTS model_parts (
    id uuid PRIMARY KEY,
    model_id text NOT NULL REFERENCES machine_models(id),
    name text NOT NULL CHECK (length(btrim(name)) > 0),
    system text NOT NULL DEFAULT '',
    interval_km integer NOT NULL DEFAULT 0 CHECK (interval_km BETWEEN 0 AND 10000000),
    interval_hours integer NOT NULL DEFAULT 0 CHECK (interval_hours BETWEEN 0 AND 10000000),
    interval_months integer NOT NULL DEFAULT 0 CHECK (interval_months BETWEEN 0 AND 120)
);

CREATE INDEX IF NOT EXISTS model_parts_model ON model_parts (model_id);

CREATE TABLE IF NOT EXISTS part_logs (
    id uuid PRIMARY KEY,
    machine_id text NOT NULL REFERENCES machines(id),
    part_id uuid NOT NULL REFERENCES model_parts(id),
    recorded_on date NOT NULL,
    reading numeric CHECK (reading >= 0),
    unit text NOT NULL CHECK (unit IN ('km', 'hour')),
    kind text NOT NULL CHECK (kind IN ('service', 'replacement')),
    recorded_by text NOT NULL REFERENCES users(id),
    note text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS part_logs_machine_part ON part_logs (machine_id, part_id, reading DESC NULLS LAST, recorded_on DESC);

CREATE TABLE IF NOT EXISTS part_alternatives (
    id uuid PRIMARY KEY,
    part_id uuid NOT NULL REFERENCES model_parts(id),
    name text NOT NULL CHECK (length(btrim(name)) > 0),
    source text NOT NULL DEFAULT '',
    note text NOT NULL DEFAULT '',
    approved boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS part_alternatives_part ON part_alternatives (part_id);
COMMIT;
