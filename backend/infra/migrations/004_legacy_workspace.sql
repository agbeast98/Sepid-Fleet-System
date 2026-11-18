BEGIN;
CREATE TABLE IF NOT EXISTS legacy_workspace (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    revision integer NOT NULL DEFAULT 1,
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
