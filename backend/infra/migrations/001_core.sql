BEGIN;

CREATE TABLE people (
    id text PRIMARY KEY,
    name text NOT NULL CHECK (length(btrim(name)) > 0),
    role text NOT NULL,
    phone text NOT NULL DEFAULT '',
    note text NOT NULL DEFAULT '',
    active boolean NOT NULL DEFAULT true,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TABLE machine_models (
    id text PRIMARY KEY,
    name text NOT NULL CHECK (length(btrim(name)) > 0),
    brand text NOT NULL DEFAULT '',
    version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TABLE machines (
    id text PRIMARY KEY,
    code text NOT NULL CHECK (length(btrim(code)) > 0),
    plate text NOT NULL DEFAULT '',
    type text NOT NULL DEFAULT '',
    model_id text REFERENCES machine_models(id),
    driver_id text REFERENCES people(id),
    supervisor_id text REFERENCES people(id),
    pm_id text REFERENCES people(id),
    unit text NOT NULL CHECK (unit IN ('km', 'hour')),
    note text NOT NULL DEFAULT '',
    active boolean NOT NULL DEFAULT true,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TABLE users (
    id text PRIMARY KEY,
    username text NOT NULL CHECK (length(btrim(username)) > 0),
    name text NOT NULL,
    password_hash text,
    active boolean NOT NULL DEFAULT true,
    is_super_admin boolean NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX users_username_ci ON users (lower(username));

CREATE TABLE sessions (
    token_digest bytea PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);

CREATE INDEX sessions_user_id ON sessions (user_id);

CREATE TABLE user_section_permissions (
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    section text NOT NULL,
    level smallint NOT NULL CHECK (level BETWEEN 0 AND 3),
    PRIMARY KEY (user_id, section)
);

CREATE TABLE odometer_logs (
    id text PRIMARY KEY,
    machine_id text NOT NULL REFERENCES machines(id),
    recorded_on date NOT NULL,
    reading numeric NOT NULL CHECK (reading >= 0),
    unit text NOT NULL CHECK (unit IN ('km', 'hour')),
    recorded_by text REFERENCES users(id),
    note text NOT NULL DEFAULT ''
);

CREATE INDEX odometer_logs_machine_date ON odometer_logs (machine_id, recorded_on DESC);

COMMIT;
