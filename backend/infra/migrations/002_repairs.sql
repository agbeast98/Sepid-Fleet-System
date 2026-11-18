BEGIN;
SELECT pg_advisory_xact_lock(514002);

CREATE TABLE IF NOT EXISTS repairs (
    id uuid PRIMARY KEY,
    number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    machine_id text NOT NULL REFERENCES machines(id),
    title text NOT NULL CHECK (length(btrim(title)) > 0),
    urgency text NOT NULL CHECK (urgency IN ('urgent', 'd13', 'd47', 'none')),
    shop text NOT NULL DEFAULT '',
    note text NOT NULL DEFAULT '',
    stage text NOT NULL DEFAULT 'report' CHECK (stage IN ('report', 'wait', 'done', 'test')),
    result text CHECK (result IN ('pass', 'fail')),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((stage = 'test') = (result IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS repair_events (
    id uuid PRIMARY KEY,
    repair_id uuid NOT NULL REFERENCES repairs(id),
    revision integer NOT NULL CHECK (revision > 0),
    stage text NOT NULL CHECK (stage IN ('report', 'wait', 'done', 'test')),
    result text CHECK (result IN ('pass', 'fail')),
    note text NOT NULL DEFAULT '',
    actor_id text NOT NULL REFERENCES users(id),
    recorded_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (repair_id, revision),
    CHECK ((stage = 'test') = (result IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS user_stage_permissions (
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stage text NOT NULL CHECK (stage IN ('report', 'wait', 'done', 'test')),
    PRIMARY KEY (user_id, stage)
);

CREATE INDEX IF NOT EXISTS repairs_machine_created ON repairs (machine_id, created_at DESC);
COMMIT;
