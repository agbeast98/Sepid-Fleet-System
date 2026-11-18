BEGIN;
CREATE TABLE IF NOT EXISTS analyses (
    id uuid PRIMARY KEY,
    machine_id text NOT NULL REFERENCES machines(id),
    analysis_date date NOT NULL,
    topic text NOT NULL,
    cause text NOT NULL DEFAULT '',
    severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    responses jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(responses) = 'object'),
    goldratt jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(goldratt) = 'object'),
    note text NOT NULL DEFAULT '',
    created_by text NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analyses_machine_date ON analyses(machine_id, analysis_date DESC);
COMMIT;
