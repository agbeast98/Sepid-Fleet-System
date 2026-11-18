ALTER TABLE sms_messages
  ADD COLUMN IF NOT EXISTS retry_of uuid REFERENCES sms_messages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS sms_messages_retry_of ON sms_messages(retry_of);
