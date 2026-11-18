BEGIN;
ALTER TABLE sms_messages DROP CONSTRAINT IF EXISTS sms_messages_status_check;
ALTER TABLE sms_messages ADD CONSTRAINT sms_messages_status_check CHECK (status IN ('queued','sending','accepted','failed','unconfirmed'));
ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0);
ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS started_at timestamptz;
COMMIT;
