BEGIN;
CREATE TABLE IF NOT EXISTS app_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_settings(singleton, payload) VALUES (true, '{"companyName":"شرکت دام و طیور سپید بستک","warnPercent":10,"countWindow":"all","backupRemindDays":7}'::jsonb)
ON CONFLICT (singleton) DO NOTHING;
UPDATE app_settings
SET payload = jsonb_set(jsonb_set(payload, '{countWindow}', '"all"'::jsonb), '{warnPercent}', '10'::jsonb)
WHERE singleton AND payload->>'companyName' = 'شرکت دام و طیور سپید بستک' AND jsonb_typeof(payload->'countWindow') = 'number';
COMMIT;
