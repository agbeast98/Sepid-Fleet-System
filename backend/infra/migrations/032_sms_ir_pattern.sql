ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS smsir_pattern jsonb;
ALTER TABLE sms_ir_settings ALTER COLUMN line_number DROP NOT NULL;
ALTER TABLE sms_ir_settings ADD COLUMN IF NOT EXISTS login_template_id integer;
CREATE TABLE IF NOT EXISTS sms_login_challenges (
  phone text PRIMARY KEY CHECK (phone ~ '^09[0-9]{9}$'),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_digest text NOT NULL,
  salt text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  last_sent_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);
