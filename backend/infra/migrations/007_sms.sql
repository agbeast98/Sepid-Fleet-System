BEGIN;
CREATE TABLE IF NOT EXISTS sms_messages (
  id uuid PRIMARY KEY,
  recipient text NOT NULL,
  message text NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted','failed','unconfirmed')),
  provider text NOT NULL,
  provider_message_id text NOT NULL DEFAULT '',
  response_code integer,
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sms_messages_created ON sms_messages(created_at DESC);
COMMIT;
